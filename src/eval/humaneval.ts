/**
 * Human-evaluation packets (PLAN §13.4): the first repetition of every case × configuration (failures included),
 * rendered as blind packets with random ids and identical formatting — the player-visible transcript (fact headers
 * and prose of the player's scene, dialogue the player heard, pause prompts with the decision taken, the player's
 * own inputs) plus an offstage appendix (narration of other scenes). Chinese text, Markdown and HTML. No mode
 * label, run id or model name appears in a packet; the key file mapping packet ids to (case, mode) is written to
 * a separate folder. A CSV rating sheet lists every item (1–5 ratings; per pause "necessary?"; per committed
 * critical outcome without a pause "should the player have been asked?"; contradiction and leakage marks per displayed
 * narration paragraph (labelled N1, N2, … in the packet; PLAN §9.4) and for dialogue/actions; comments).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findCase, type ContentBundle } from '../content/loader.js';
import { detectCheckpoints } from './detectors.js';
import { loadBundle, ReplayedBundle, type AuditBundle, type BNarration } from './oracle/index.js';
import { findRunDirs } from './report.js';

export const RATING_DIMENSIONS = ['character_consistency', 'causal_plausibility', 'perceived_user_control'] as const;
export type RatingDimension = (typeof RATING_DIMENSIONS)[number];
export const RATING_HEADER = ['rater_id', 'packet_id', 'item_type', 'item_id', 'prompt', 'response', 'comment'] as const;

const OPTION_ZH: Record<string, string> = {
  endorse: '准行',
  withhold: '驳回',
  amend: '改稿',
  delegate: '授权',
  ask: '询问',
  counter_draft: '拟反提案',
  let_it_happen: '听之',
  urge_payment: '促发饷',
  adjust_goal: '调整目标',
  urge_accept: '促其接受',
  urge_stop: '促其止议',
  resume: '继续',
  retry: '重试',
  skip_actor: '跳过',
  stop: '终止',
  player_initiated: '亲自执行',
};
const TYPE_ZH: Record<string, string> = {
  dispatch_request: '遣使送表',
  major_commitment: '重大承诺',
  strategic_turn: '战略转折',
  mutiny: '兵变',
  negotiation_deadlock: '谈判僵局',
  internal_disagreement: '内部分歧下的决定',
  goal_conflict: '超出目标的条款',
  risky_delay: '危急中的拖延',
  death: '死亡',
  allegiance: '易帜',
};
const TERMINAL_ZH: Record<string, string> = {
  pact_concluded: '盟约成立',
  jinyang_falls: '晋阳陷落',
  no_assistance: '不求外援',
  talks_failed: '和议不成',
};
const DECISION_KINDS = new Set(['mandatory', 'semantic', 'prompt', 'control']);

type Names = Record<string, string>;

function namesOf(content: ContentBundle): Names {
  const out: Names = { player: '书记（你）', system: '（局势）' };
  for (const [id, c] of Object.entries(content.characters)) out[id] = c.name.zh;
  return out;
}

function termsZh(t: Record<string, unknown> | null | undefined): string {
  if (!t) return '（无）';
  const parts: string[] = [];
  if (t.vassal) parts.push('称臣');
  if (t.filial) parts.push('以父礼事之');
  if (t.cession === 'yanmen_north') parts.push('割雁门以北诸州');
  if (t.cession === 'sixteen_prefectures') parts.push('割卢龙及雁门以北十六州');
  if (Number(t.annual_silk) > 0) parts.push(`岁帛${String(t.annual_silk)}匹`);
  if (Number(t.immediate_silk) > 0) parts.push(`即付帛${String(t.immediate_silk)}匹`);
  if (Number(t.aid_cavalry) > 0) parts.push(`援骑${String(t.aid_cavalry)}`);
  if (Number(t.aid_arrival_days) > 0) parts.push(`成约后${String(t.aid_arrival_days)}日援军到`);
  if (t.neutrality) parts.push('契丹中立');
  if (t.marriage_alliance) parts.push('和亲');
  if (Array.isArray(t.secret_clauses) && t.secret_clauses.length > 0) parts.push(`另附密约${t.secret_clauses.length}条`);
  return parts.length > 0 ? parts.join('；') : '（无条件）';
}

function playerActionZh(action: unknown, names: Names): string {
  const a = (typeof action === 'object' && action !== null ? action : {}) as { type?: string; args?: Record<string, unknown> };
  const args = a.args ?? {};
  switch (a.type) {
    case 'speak':
      return `对${((args.to as string[]) ?? []).map((x) => names[x] ?? x).join('、')}说：「${String(args.text ?? '')}」`;
    case 'revise_document':
      return `改定表文（据第${String(args.baseDocVersion)}版）：${termsZh(args.terms as Record<string, unknown>)}`;
    case 'suggest_revision':
      return `提出修改建议：${String(args.reason ?? '')}`;
    case 'set_dispatch_timing':
      return args.mode === 'now' ? '定遣使时机：即发' : args.mode === 'hold' ? '定遣使时机：扣留暂不发' : `定遣使时机：暂缓${String(args.rounds ?? '')}回合`;
    case 'dispatch_document':
      return `遣使送出表文（第${String(args.docVersion)}版）`;
    case 'revoke_authorization':
      return '撤回先前的授权';
    case 'wait':
      return '静候';
    default:
      return `行动：${a.type ?? '未知'}`;
  }
}

export interface PacketBlock {
  kind: 'player' | 'dialogue' | 'pause' | 'narration';
  lines: string[];
}

export interface PacketDoc {
  id: string;
  caseTitle: string;
  casePurpose: string;
  rounds: Array<{ round: number; blocks: PacketBlock[] }>;
  ending: string;
  appendix: Array<{ round: number; scene: string; text: string }>;
  pauseItems: Array<{ label: string; pauseId: string; round: number; summary: string }>;
  /** Displayed prose paragraphs (model prose or template), each rated for contradiction and leakage (PLAN §9.4). */
  paragraphItems: Array<{ label: string; narrationId: number; paragraph: number; round: number; scene: string }>;
  outcomeItems: Array<{ label: string; key: string; round: number; summary: string }>;
}

const SCENE_ZH: Record<string, string> = { jinyang_hq: '晋阳幕府', khitan_court: '契丹牙帐', luoyang_court: '洛阳宫中' };

/** Latest usable narration per (batch, scene). */
function narrationsShown(b: AuditBundle): BNarration[] {
  const last = new Map<string, BNarration>();
  for (const n of b.narrations) {
    const key = `${n.batchId ?? '-'}|${n.scene}|${n.eventVersions.join(',')}`;
    const prev = last.get(key);
    if (!prev || n.status !== 'failed' || prev.status === 'failed') last.set(key, n);
  }
  return [...last.values()].sort((a, c) => a.controlSeq - c.controlSeq);
}

export function buildPacket(id: string, bundle: AuditBundle, content: ContentBundle): PacketDoc {
  const rb = new ReplayedBundle(bundle);
  const names = namesOf(content);
  const caseCfg = findCase(content, bundle.session.caseId ?? '');
  const rounds = new Map<number, PacketBlock[]>();
  const blocks = (r: number) => {
    let list = rounds.get(r);
    if (!list) rounds.set(r, (list = []));
    return list;
  };
  const decisionIds = new Set(bundle.decisions.map((d) => d.decisionId));
  // Chronological order within a round: every block gets a key on the session's control sequence (shared by
  // batches, commits, pauses, decisions and narrations). Dialogue uses the control position recorded when it was
  // written (`controlAt`: speech appears at its batch's commit, an answer after its question); bundles written
  // before that column fall back to the batch's commit or the decision. Pauses open at their sequence and every
  // decision is placed at its own, so "ask → answer → endorse" reads in that order.
  const batchSeq = new Map(bundle.batches.map((b) => [b.batchId, b.commitSeq ?? b.controlSeq]));
  const proposalBatch = new Map(bundle.proposals.map((p) => [p.proposalId, p.batchId]));
  const decisionSeq = new Map(bundle.decisions.map((d) => [d.decisionId, d.controlSeq]));
  const at = new WeakMap<PacketBlock, number>();
  const place = (round: number, block: PacketBlock, key: number): void => {
    blocks(round).push(block);
    at.set(block, key);
  };
  const decisionOf = (d: { decisionId: string | null; payload: unknown }): string | null =>
    d.decisionId ?? ((d.payload ?? null) as { decisionId?: unknown } | null)?.decisionId?.toString() ?? null;
  // Player's own inputs (actions; speech appears with the dialogue).
  for (const p of bundle.proposals) {
    if (p.actor !== 'player' || p.source !== 'player') continue;
    const type = (p.action as { type?: string } | null)?.type;
    if (type === 'speak') continue;
    place(p.round, { kind: 'player', lines: [`【书记之举】${playerActionZh(p.action, names)}${p.status === 'rejected' ? '（未能施行）' : ''}`] }, batchSeq.get(p.batchId) ?? Number.POSITIVE_INFINITY);
  }
  // Dialogue the player heard or spoke (decision advice/questions are shown with their pause).
  let lastDialogueKey = Number.NEGATIVE_INFINITY;
  for (const d of [...bundle.dialogue].sort((a, c) => a.seq - c.seq)) {
    if (d.inherited) continue;
    const decision = decisionOf(d);
    if (decision && decisionIds.has(decision) && d.speaker === 'player') continue;
    if (d.speaker !== 'player' && !d.listeners.includes('player')) continue;
    const viaBatch = d.proposalId ? batchSeq.get(proposalBatch.get(d.proposalId) ?? '') : undefined;
    const viaDecision = decision ? decisionSeq.get(decision) : undefined;
    const key =
      typeof d.controlAt === 'number' ? d.controlAt + 0.5 : viaBatch !== undefined ? viaBatch + 0.5 : viaDecision !== undefined ? viaDecision + 0.5 : lastDialogueKey;
    lastDialogueKey = key;
    const to = d.listeners.map((x) => names[x] ?? x).join('、');
    place(d.round, { kind: 'dialogue', lines: [`${names[d.speaker] ?? d.speaker}${to ? `（对${to}）` : ''}：「${d.text}」`] }, key);
  }
  // Pause prompts with the decision taken.
  const pauseItems: PacketDoc['pauseItems'] = [];
  for (const p of bundle.pauses) {
    if (!DECISION_KINDS.has(p.kind)) continue;
    const label = `P${pauseItems.length + 1}`;
    const decisions = bundle.decisions.filter((d) => d.pauseId === p.pauseId);
    const lines = [`【请示 ${label}】${p.question.zh}`];
    for (const f of p.visibleFacts) lines.push(`· ${f.zh}`);
    lines.push(`可选：${p.options.map((o) => OPTION_ZH[o] ?? o).join('、')}`);
    if (p.status === 'obsolete') lines.push('（此请示因局势变化作废，未作决定）');
    place(p.round, { kind: 'pause', lines }, p.controlSeq);
    for (const d of decisions) {
      place(d.round, { kind: 'pause', lines: [`书记之决（${label}）：${OPTION_ZH[d.option] ?? d.option}${d.advice ? `——「${d.advice}」` : ''}`] }, d.controlSeq);
    }
    pauseItems.push({ label, pauseId: p.pauseId, round: p.round, summary: p.question.zh });
  }
  // Narration: the player's scene in the transcript, other scenes in the appendix.
  const appendix: PacketDoc['appendix'] = [];
  const paragraphItems: PacketDoc['paragraphItems'] = [];
  for (const n of narrationsShown(bundle)) {
    if (n.status === 'failed' || n.displayed.trim().length === 0) continue;
    const top = n.eventVersions.length > 0 ? Math.max(...n.eventVersions.filter((v) => rb.has(v)), rb.baseVersion) : rb.lastVersion;
    const s = rb.stateAt(top);
    const round = bundle.events.find((e) => e.version === (n.eventVersions[0] ?? -1))?.round ?? s.round;
    const header = n.header && n.displayed.startsWith(n.header) ? n.header : '';
    const prose = (header ? n.displayed.slice(header.length) : n.displayed).split(/\r?\n/).filter((x) => x.trim().length > 0);
    const lines = header.split(/\r?\n/).filter((x) => x.trim().length > 0);
    prose.forEach((p, k) => {
      const label = `N${paragraphItems.length + 1}`;
      paragraphItems.push({ label, narrationId: n.narrationId, paragraph: k + 1, round, scene: SCENE_ZH[n.scene] ?? n.scene });
      lines.push(`[${label}] ${p}`);
    });
    if (s.player.location === n.scene) place(round, { kind: 'narration', lines }, n.controlSeq);
    else appendix.push({ round, scene: SCENE_ZH[n.scene] ?? n.scene, text: lines.join('\n') });
  }
  // Committed critical outcomes without a pause (player-initiated ones excluded).
  const outcomeItems: PacketDoc['outcomeItems'] = [];
  for (const inst of detectCheckpoints(bundle, rb).instances) {
    if (!inst.committed || inst.control.pause || inst.control.playerInitiated) continue;
    const label = `O${outcomeItems.length + 1}`;
    outcomeItems.push({ label, key: inst.key, round: inst.round, summary: `第${inst.round}回合：${TYPE_ZH[inst.type] ?? inst.type}（${inst.object}）未经请示即已发生` });
  }
  const final = rb.finalState();
  const ending = final.terminal ? `结局：${TERMINAL_ZH[final.terminal.kind] ?? final.terminal.kind}（第${final.terminal.round}回合）` : '本局未达结局（回合用尽或中止）';
  const order: PacketBlock['kind'][] = ['player', 'dialogue', 'pause', 'narration'];
  return {
    id,
    caseTitle: caseCfg.title.zh,
    casePurpose: caseCfg.purpose.zh,
    rounds: [...rounds.entries()]
      .sort((a, c) => a[0] - c[0])
      .map(([round, list]) => ({
        round,
        blocks: list
          .map((b, i) => ({ b, i, k: at.get(b) ?? Number.POSITIVE_INFINITY }))
          .sort((x, y) => x.k - y.k || order.indexOf(x.b.kind) - order.indexOf(y.b.kind) || x.i - y.i)
          .map((x) => x.b),
      })),
    ending,
    appendix,
    pauseItems,
    paragraphItems,
    outcomeItems,
  };
}

const HEADINGS: Record<PacketBlock['kind'], string> = { player: '书记', dialogue: '言谈', pause: '请示', narration: '叙事' };

export function packetMarkdown(doc: PacketDoc): string {
  const L: string[] = [`# 评审材料 ${doc.id}`, '', `**案例**：${doc.caseTitle}`, '', `> ${doc.casePurpose}`, ''];
  for (const r of doc.rounds) {
    L.push(`## 第 ${r.round} 回合`, '');
    for (const b of r.blocks) {
      L.push(`**${HEADINGS[b.kind]}**`, '');
      for (const line of b.lines) L.push(`${line}  `);
      L.push('');
    }
  }
  L.push('## 结局', '', doc.ending, '');
  L.push('## 附录：幕后（玩家当时不可见）', '');
  if (doc.appendix.length === 0) L.push('（无）', '');
  for (const a of doc.appendix) L.push(`**第 ${a.round} 回合 · ${a.scene}**`, '', ...a.text.split(/\r?\n/).filter((x) => x.trim()).map((x) => `${x}  `), '');
  L.push('## 待评条目', '');
  for (const p of doc.pauseItems) L.push(`- ${p.label}（第${p.round}回合）：${p.summary}`);
  for (const o of doc.outcomeItems) L.push(`- ${o.label}：${o.summary}`);
  if (doc.pauseItems.length + doc.outcomeItems.length === 0) L.push('（无请示或未经请示的关键结果）');
  L.push('');
  return `${L.join('\n')}\n`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function packetHtml(doc: PacketDoc): string {
  const H: string[] = [];
  H.push('<!doctype html>', '<html lang="zh">', '<head>', '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', `<title>评审材料 ${esc(doc.id)}</title>`);
  H.push(`<style>
:root{--bg:#fcfcfb;--text:#0b0b0b;--muted:#52514e;--rule:#e4e3df;--accent:#2a78d6}
@media (prefers-color-scheme: dark){:root{--bg:#1a1a19;--text:#ffffff;--muted:#c3c2b7;--rule:#3a3a38;--accent:#3987e5}}
body{background:var(--bg);color:var(--text);font-family:"Noto Serif SC","Source Han Serif SC","Songti SC",serif;line-height:1.75;max-width:46rem;margin:2rem auto;padding:0 16px}
h1{font-size:1.5rem}h2{font-size:1.2rem;border-bottom:1px solid var(--rule);padding-bottom:.25rem;margin-top:2rem}
.block{margin:.75rem 0;padding-left:.75rem;border-left:3px solid var(--rule)}.block.pause{border-left-color:var(--accent)}
.label{font-weight:600;color:var(--muted);font-size:.9rem}.purpose{color:var(--muted)}p{margin:.2rem 0}
</style>`, '</head>', '<body>', '<main>');
  H.push(`<h1>评审材料 ${esc(doc.id)}</h1>`, `<p><strong>案例</strong>：${esc(doc.caseTitle)}</p>`, `<p class="purpose">${esc(doc.casePurpose)}</p>`);
  for (const r of doc.rounds) {
    H.push(`<h2>第 ${r.round} 回合</h2>`);
    for (const b of r.blocks) {
      H.push(`<section class="block ${b.kind}"><div class="label">${HEADINGS[b.kind]}</div>${b.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</section>`);
    }
  }
  H.push('<h2>结局</h2>', `<p>${esc(doc.ending)}</p>`, '<h2>附录：幕后（玩家当时不可见）</h2>');
  if (doc.appendix.length === 0) H.push('<p>（无）</p>');
  for (const a of doc.appendix) H.push(`<section class="block"><div class="label">第 ${a.round} 回合 · ${esc(a.scene)}</div>${a.text.split(/\r?\n/).filter((x) => x.trim()).map((l) => `<p>${esc(l)}</p>`).join('')}</section>`);
  H.push('<h2>待评条目</h2>', '<ul>');
  for (const p of doc.pauseItems) H.push(`<li>${esc(p.label)}（第${p.round}回合）：${esc(p.summary)}</li>`);
  for (const o of doc.outcomeItems) H.push(`<li>${esc(o.label)}：${esc(o.summary)}</li>`);
  if (doc.pauseItems.length + doc.outcomeItems.length === 0) H.push('<li>（无请示或未经请示的关键结果）</li>');
  H.push('</ul>', '</main>', '</body>', '</html>');
  return `${H.join('\n')}\n`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function ratingRows(doc: PacketDoc): string[][] {
  const rows: string[][] = [];
  const add = (type: string, item: string, prompt: string) => rows.push(['', doc.id, type, item, prompt, '', '']);
  add('character_consistency', '-', '人物言行是否符合其身份与处境？1–5 / Character consistency (1–5)');
  add('causal_plausibility', '-', '事件因果是否合理？1–5 / Causal plausibility (1–5)');
  add('perceived_user_control', '-', '你作为书记是否感到掌控关键决定？1–5 / Perceived user control (1–5)');
  for (const p of doc.pauseItems) add('pause_necessary', p.label, `此请示是否有必要？yes/no / Was this pause necessary? (${p.summary})`);
  for (const o of doc.outcomeItems) add('should_have_asked', o.label, `此事是否应先请示玩家？yes/no / Should the player have been asked? (${o.summary})`);
  for (const n of doc.paragraphItems) {
    add('contradiction', n.label, `此段叙事（第${n.round}回合·${n.scene}）是否与已发生之事矛盾或暗示未发生之事？yes/no / Does paragraph ${n.label} contradict or imply events that did not happen?`);
    add('leakage', n.label, `此段叙事是否透露了该场景中无人应知的信息？yes/no / Does paragraph ${n.label} reveal information nobody in the scene should know?`);
  }
  add('leakage', '-', '人物言谈或行动中是否用到其不应知道的信息？yes/no（请在 comment 中注明位置）/ Leakage in dialogue or actions? (where)');
  add('contradiction', '-', '言谈或行动是否与已发生之事矛盾？yes/no（请注明位置）/ Contradiction in dialogue or actions? (where)');
  add('comment', '-', '其他意见 / Comments');
  return rows;
}

export interface PacketKeyEntry {
  id: string;
  runId: string;
  caseId: string;
  mode: string;
  pauses: Record<string, string>;
  outcomes: Record<string, string>;
  paragraphs: Record<string, string>;
}

export interface PacketsResult {
  packetDir: string;
  keyFile: string;
  sheet: string;
  packets: PacketKeyEntry[];
  missing: string[];
}

/** Deterministic id stream for tests (mulberry32); crypto-random ids otherwise. */
function idStream(seed: number | null): () => string {
  if (seed === null) return () => `JP-${randomBytes(3).toString('hex').toUpperCase()}`;
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return `JP-${(((t ^ (t >>> 14)) >>> 0) & 0xffffff).toString(16).toUpperCase().padStart(6, '0')}`;
  };
}

export function buildPackets(opts: { dir: string; content: ContentBundle; outDir?: string; keyDir?: string; seed?: number | null; cases?: string[]; modes?: string[] }): PacketsResult {
  const dir = path.resolve(opts.dir);
  const packetDir = path.resolve(opts.outDir ?? path.join(dir, 'humaneval'));
  const keyDir = path.resolve(opts.keyDir ?? path.join(dir, 'humaneval-key'));
  const cases = opts.cases ?? ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
  const modes = opts.modes ?? ['baseline', 'no_judge', 'full'];
  const runs = findRunDirs(dir).map((d) => ({ d, bundle: loadBundle(path.join(d, 'audit')) }));
  const nextId = idStream(opts.seed ?? null);
  const used = new Set<string>();
  const selected: Array<{ runId: string; caseId: string; mode: string; bundle: AuditBundle }> = [];
  const missing: string[] = [];
  for (const c of cases) {
    for (const m of modes) {
      const hit = runs.find((r) => r.bundle.session.caseId === c && r.bundle.session.mode === m && /-r1$/.test(path.basename(r.d)));
      if (!hit) missing.push(`${c}/${m}`);
      else selected.push({ runId: path.basename(hit.d), caseId: c, mode: m, bundle: hit.bundle });
    }
  }
  // Random packet order and ids (blind).
  const order = selected.map((s) => ({ s, id: '' }));
  for (const o of order) {
    let id = nextId();
    while (used.has(id)) id = nextId();
    used.add(id);
    o.id = id;
  }
  order.sort((a, b) => (a.id < b.id ? -1 : 1));
  mkdirSync(packetDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });
  const key: PacketKeyEntry[] = [];
  const sheet: string[][] = [[...RATING_HEADER]];
  for (const { s, id } of order) {
    const doc = buildPacket(id, s.bundle, opts.content);
    writeFileSync(path.join(packetDir, `${id}.md`), packetMarkdown(doc), 'utf8');
    writeFileSync(path.join(packetDir, `${id}.html`), packetHtml(doc), 'utf8');
    sheet.push(...ratingRows(doc));
    key.push({
      id,
      runId: s.runId,
      caseId: s.caseId,
      mode: s.mode,
      pauses: Object.fromEntries(doc.pauseItems.map((p) => [p.label, p.pauseId])),
      outcomes: Object.fromEntries(doc.outcomeItems.map((o) => [o.label, o.key])),
      paragraphs: Object.fromEntries(doc.paragraphItems.map((p) => [p.label, `narration:${p.narrationId}#${p.paragraph}`])),
    });
  }
  const sheetFile = path.join(packetDir, 'ratings_template.csv');
  writeFileSync(sheetFile, `${sheet.map((r) => r.map(csvCell).join(',')).join('\n')}\n`, 'utf8');
  writeFileSync(
    path.join(packetDir, 'README.md'),
    [
      '# 评审说明 / Instructions for raters',
      '',
      '每份材料是一局游戏的记录：玩家所见的逐回合记录与幕后附录。请独立评阅，勿与其他评审讨论。',
      'Each packet is one play-through: the player-visible transcript round by round, and an offstage appendix. Rate independently.',
      '',
      '1. 复制 `ratings_template.csv` 为 `ratings/<你的代号>.csv`，在每行填入 `rater_id`（你的代号）与 `response`。',
      '   Copy `ratings_template.csv` to `ratings/<your id>.csv`; fill `rater_id` and `response` on every row.',
      '2. 1–5 分：1 = 很差，3 = 一般，5 = 很好。yes/no 条目请只填 yes 或 no；位置与理由写在 comment。',
      '   1–5 scales: 1 = very poor, 3 = neutral, 5 = very good. Yes/no items take exactly yes or no; explain in comment.',
      '3. 不要猜测系统配置；材料编号是随机的。 Do not guess the system configuration; packet ids are random.',
      '',
    ].join('\n'),
    'utf8',
  );
  const keyFile = path.join(keyDir, 'key.json');
  writeFileSync(keyFile, `${JSON.stringify({ createdAt: new Date().toISOString(), note: 'KEEP SEPARATE FROM THE PACKETS (blind evaluation).', packets: key }, null, 2)}\n`, 'utf8');
  return { packetDir, keyFile, sheet: sheetFile, packets: key, missing };
}
