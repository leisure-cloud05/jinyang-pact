/**
 * Offline evaluation pipeline: experiment runner (one DB per run, audit bundle, replay results, displayed-narration
 * listing), report (tables, figures, mock label), blind human-evaluation packets and key, agreement over filled
 * sheets, the exp CLI's freeze and live refusal, and cost reconciliation with an injected fetch (no network).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main as expMain } from '../../src/cli/exp.js';
import { loadConfig } from '../../src/config/env.js';
import { runAgreement } from '../../src/eval/agreement.js';
import { buildFreeze, freezeMismatches, frozenFileHashes, MAIN_SETTINGS } from '../../src/eval/freeze.js';
import { buildPackets } from '../../src/eval/humaneval.js';
import { reconcileDir, type FetchFn } from '../../src/eval/reconcile.js';
import { buildReport } from '../../src/eval/report.js';
import { mockFactory, planRuns, planSpec, ProvenanceError, runExperiment } from '../../src/eval/runner.js';
import { content, tempDir } from './helpers.js';

const mockConfig = () => loadConfig({ env: { LLM_PROVIDER: 'mock' } });

describe('plans', () => {
  it('main = C1–C6 × 3 modes × 2 reps = 36 runs; dev = D1–D3; pilot = D1–D3 + P1–P3', () => {
    expect(planRuns(planSpec('main')).length).toBe(36);
    expect(planRuns(planSpec('main')).slice(0, 2).map((r) => r.runId)).toEqual(['C1-baseline-r1', 'C1-baseline-r2']);
    expect(planSpec('dev').cases).toEqual(['D1', 'D2', 'D3']);
    expect(planSpec('pilot').cases).toEqual(['D1', 'D2', 'D3', 'P1', 'P2', 'P3']);
  });
});

describe('mock pipeline end to end', () => {
  it('runs, reports (labelled pipeline validation), builds blind packets and analyses ratings', async () => {
    const out = path.join(tempDir('jinyang pipeline '), 'exp run');
    const result = await runExperiment({
      plan: planSpec('main', { cases: ['C1', 'C4'], reps: 1 }),
      outDir: out,
      content: content(),
      llm: mockFactory(0.1),
      live: false,
      lang: 'zh',
      misbehaviourRate: 0.1,
    });
    expect(result.runs.length).toBe(6);
    for (const r of result.runs) {
      const dir = path.join(out, r.runId);
      expect(r.error).toBeNull();
      expect(existsSync(path.join(dir, 'run.sqlite'))).toBe(true);
      for (const f of ['session.json', 'events.jsonl', 'proposals.jsonl', 'narrations.jsonl', 'engine.json', 'narrations_displayed.md']) expect(existsSync(path.join(dir, 'audit', f))).toBe(true);
      const replay = JSON.parse(readFileSync(path.join(dir, 'replay.json'), 'utf8')) as { patch: { ok: boolean }; rederive: { ok: boolean } };
      expect(replay.patch.ok && replay.rederive.ok).toBe(true);
    }
    // Resume: complete runs are skipped.
    const again = await runExperiment({ plan: planSpec('main', { cases: ['C1'], modes: ['full'], reps: 1 }), outDir: out, content: content(), llm: mockFactory(0.1), live: false, lang: 'zh', misbehaviourRate: 0.1 });
    expect(again.runs[0]?.runId).toBe('C1-full-r1');

    const report = buildReport({ dir: out, content: content() });
    expect(report.mock).toBe(true);
    const summary = readFileSync(path.join(report.outDir, 'summary.md'), 'utf8');
    expect(summary).toContain('PIPELINE VALIDATION (mock LLM) — not findings');
    expect(summary).toContain('Cost sensitivity');
    expect(summary).toContain('narration fallback rate');
    for (const f of ['metrics.csv', 'metrics.json', 'cases.csv', 'runs.csv']) expect(existsSync(path.join(report.outDir, f))).toBe(true);
    const figures = readdirSync(path.join(report.outDir, 'figures'));
    expect(figures.sort()).toEqual(['case_pass.svg', 'control.svg', 'cost_sensitivity.svg', 'invalid_commit_rate.svg', 'latency.svg', 'outcomes.svg']);
    for (const f of figures) {
      const svg = readFileSync(path.join(report.outDir, 'figures', f), 'utf8');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('role="img"');
      expect(svg).toContain('<title id="t">');
      expect(svg).toContain('PIPELINE VALIDATION');
    }
    expect(readdirSync(path.join(report.outDir, 'narrations')).length).toBe(6);
    const csv = readFileSync(path.join(report.outDir, 'metrics.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('scope,group,measure,numerator,denominator,value');
    expect(csv).toMatch(/mode,baseline,invalid_commit_rate,\d+,\d+,/);
    const baseline = report.byMode.find((g) => g.group === 'baseline');
    expect(baseline?.rejection.value).toBeNull();

    // Blind packets.
    const packets = buildPackets({ dir: out, content: content(), cases: ['C1', 'C4'], seed: 42 });
    expect(packets.packets.length).toBe(6);
    expect(packets.missing).toEqual([]);
    expect(path.dirname(packets.keyFile)).not.toBe(packets.packetDir);
    const ids = new Set(packets.packets.map((p) => p.id));
    expect(ids.size).toBe(6);
    const mdFiles = readdirSync(packets.packetDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    expect(mdFiles.length).toBe(6);
    const headings = new Set<string>();
    for (const p of packets.packets) {
      for (const ext of ['md', 'html']) {
        const text = readFileSync(path.join(packets.packetDir, `${p.id}.${ext}`), 'utf8');
        for (const word of ['baseline', 'no_judge', 'full', 'Judge', 'judge', p.runId, 'mock', 'harness', 'Harness']) expect(text.includes(word), `${p.id}.${ext} mentions ${word}`).toBe(false);
      }
      const md = readFileSync(path.join(packets.packetDir, `${p.id}.md`), 'utf8');
      headings.add(md.split('\n').filter((l) => l.startsWith('## ')).filter((l) => !/第 \d+ 回合/.test(l)).join('|'));
    }
    expect(headings.size).toBe(1); // identical formatting across packets
    const key = JSON.parse(readFileSync(packets.keyFile, 'utf8')) as { packets: Array<{ id: string; caseId: string; mode: string }> };
    expect(key.packets.map((p) => `${p.caseId}/${p.mode}`).sort()).toEqual(['C1/baseline', 'C1/full', 'C1/no_judge', 'C4/baseline', 'C4/full', 'C4/no_judge']);
    const template = readFileSync(packets.sheet, 'utf8');
    expect(template.split('\n')[0]).toBe('rater_id,packet_id,item_type,item_id,prompt,response,comment');
    // Two raters fill the sheet; agreement runs.
    const ratingsDir = path.join(out, 'ratings');
    mkdirSync(ratingsDir);
    const lines = template.trim().split('\n');
    for (const [rater, bump] of [['A', 0], ['B', 1]] as const) {
      const filled = [lines[0], ...lines.slice(1).map((l) => {
        const [, pid, type, item, ...rest] = l.split(',');
        const scale = ['character_consistency', 'causal_plausibility', 'perceived_user_control'].includes(type ?? '');
        void rest;
        return `${rater},${pid},${type},${item},p,${scale ? String(3 + bump) : type === 'comment' ? '' : 'yes'},`;
      })];
      writeFileSync(path.join(ratingsDir, `${rater}.csv`), `${filled.join('\n')}\n`);
    }
    const agreement = runAgreement({ ratingsDir, keyFile: packets.keyFile });
    expect(agreement.report.raters).toEqual(['A', 'B']);
    expect(agreement.report.perConfig.full?.character_consistency.n).toBe(4);
    expect(existsSync(agreement.files[1] as string)).toBe(true);
  }, 120_000);
});

describe('provenance and denominators (review findings 3, 8, 10, 11)', () => {
  it('refuses to resume a directory with different provenance; labels from each run; refuses mixed sets; keeps missing runs', async () => {
    const out = path.join(tempDir('jinyang provenance '), 'exp');
    const plan = planSpec('main', { cases: ['C1'], modes: ['baseline', 'full'], reps: 1 });
    await runExperiment({ plan, outDir: out, content: content(), llm: mockFactory(0), live: false, lang: 'zh', misbehaviourRate: 0 });
    // A live run (or another misbehaviour rate / language) may not reuse the mock directory.
    await expect(runExperiment({ plan, outDir: out, content: content(), llm: mockFactory(0), live: true, lang: 'zh' })).rejects.toThrow(ProvenanceError);
    await expect(runExperiment({ plan, outDir: out, content: content(), llm: mockFactory(0), live: false, lang: 'zh', misbehaviourRate: 0.2 })).rejects.toThrow(/misbehaviourRate/);
    await expect(runExperiment({ plan, outDir: out, content: content(), llm: mockFactory(0), live: false, lang: 'en', misbehaviourRate: 0 })).rejects.toThrow(/lang/);

    // The banner comes from the runs' own provenance, whatever plan.json says.
    const planFile = path.join(out, 'plan.json');
    writeFileSync(planFile, JSON.stringify({ ...JSON.parse(readFileSync(planFile, 'utf8')), mock: false, live: true, label: null }));
    const report = buildReport({ dir: out, content: content() });
    expect(report.mock).toBe(true);
    expect(readFileSync(path.join(report.outDir, 'summary.md'), 'utf8')).toContain('PIPELINE VALIDATION');

    // Rejection rate: all generated proposals in Harness modes, with the status breakdown.
    const full = report.evaluations.find((e) => e.meta.mode === 'full');
    const proposals = readFileSync(path.join(out, 'C1-full-r1', 'audit', 'proposals.jsonl'), 'utf8').trim().split('\n').length;
    expect(full?.metrics.rejection.den).toBe(proposals);
    expect(Object.values(full?.metrics.proposalStatus ?? {}).reduce((a, b) => a + b, 0)).toBe(proposals);

    // A crashed run (no audit) keeps its slot in all-run denominators as failed and not replayed.
    rmSync(path.join(out, 'C1-baseline-r1', 'audit'), { recursive: true, force: true });
    const r2 = buildReport({ dir: out, content: content() });
    expect(r2.evaluations.length).toBe(2);
    const base = r2.byMode.find((g) => g.group === 'baseline');
    expect(base?.completion).toEqual({ num: 0, den: 1, value: 0 });
    expect(base?.replayRederive).toEqual({ num: 0, den: 1, value: 0 });
    expect(readFileSync(path.join(r2.outDir, 'summary.md'), 'utf8')).toContain('Missing or unreadable audits');

    // Mixed providers are refused.
    const runFile = path.join(out, 'C1-full-r1', 'run.json');
    const run = JSON.parse(readFileSync(runFile, 'utf8')) as { provenance: { provider: string } };
    run.provenance.provider = 'openrouter';
    writeFileSync(runFile, JSON.stringify(run));
    writeFileSync(path.join(out, 'C1-baseline-r1', 'run.json'), JSON.stringify({ ...run, runId: 'C1-baseline-r1', mode: 'baseline', provenance: { ...run.provenance, provider: 'mock' } }));
    expect(() => buildReport({ dir: out, content: content() })).toThrow(/mixed/);
  }, 60_000);

  it('an unknown reconciled cost stays unknown (never $0) and coverage is kept', async () => {
    const out = path.join(tempDir('jinyang unknown cost '), 'exp');
    await runExperiment({ plan: planSpec('main', { cases: ['C1'], modes: ['full'], reps: 1 }), outDir: out, content: content(), llm: mockFactory(0), live: false, lang: 'zh' });
    const runDir = path.join(out, 'C1-full-r1');
    writeFileSync(path.join(runDir, 'reconciled_costs.jsonl'), `${JSON.stringify({ callId: 'c', attemptNo: 1, generationId: 'g', costUsd: null, status: 'not_found' })}\n`);
    const r = buildReport({ dir: out, content: content() });
    expect(r.byMode[0]?.costReconciled).toBeNull();
    expect(r.byMode[0]?.reconcileRows).toBe(1);
    expect(readFileSync(path.join(r.outDir, 'summary.md'), 'utf8')).toMatch(/n\/a \(not reconciled\)/);
    writeFileSync(path.join(runDir, 'reconciled_costs.jsonl'), `${JSON.stringify({ costUsd: 0.002, status: 'ok' })}\n${JSON.stringify({ costUsd: null, status: 'error' })}\n`);
    const r3 = buildReport({ dir: out, content: content() });
    expect(r3.byMode[0]?.costReconciled).toBeCloseTo(0.002, 12);
    expect(r3.byMode[0]?.reconciledAttempts).toBe(1);
    expect(readFileSync(path.join(r3.outDir, 'summary.md'), 'utf8')).toMatch(/for 1\/\d+ attempts \(\d+ unknown\)/);
  }, 60_000);
});

describe('freeze scope (review finding 2)', () => {
  it('hashes executed files, not reporting-only code', () => {
    const root = tempDir('jinyang freeze scope ');
    const put = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    };
    put('content/cases/C1.yaml', 'a: 1\n');
    put('src/agents/narration/checker.ts', 'export const v = 1;\n');
    put('src/engine/scheduler.ts', 'export const s = 1;\n');
    put('src/eval/detectors.ts', 'export const d = 1;\n');
    put('src/eval/report.ts', 'export const r = 1;\n');
    put('package-lock.json', '{}\n');
    const h0 = frozenFileHashes(root).files;
    put('src/eval/report.ts', 'export const r = 2;\n');
    expect(frozenFileHashes(root).files).toBe(h0);
    for (const rel of ['src/agents/narration/checker.ts', 'src/engine/scheduler.ts', 'src/eval/detectors.ts', 'content/cases/C1.yaml', 'package-lock.json']) {
      const before = frozenFileHashes(root).files;
      put(rel, `${readFileSync(path.join(root, rel), 'utf8')}// changed\n`);
      expect(frozenFileHashes(root).files, rel).not.toBe(before);
    }
  });

  it('effective settings (language, cases, modes, reps, seeds) are part of the freeze', () => {
    const zh = buildFreeze(mockConfig(), content(), { run: MAIN_SETTINGS('zh') });
    const en = buildFreeze(mockConfig(), content(), { run: MAIN_SETTINGS('en') });
    expect(freezeMismatches(zh, en).some((m) => m.startsWith('settings.lang'))).toBe(true);
    const subset = buildFreeze(mockConfig(), content(), { run: { ...MAIN_SETTINGS('zh'), cases: ['C1'] } });
    expect(freezeMismatches(zh, subset).some((m) => m.startsWith('settings.cases'))).toBe(true);
    expect(Object.keys(zh.settings.seeds).length).toBe(12);
    expect(zh.settings.maxRounds.C1).toBe(6);
  });
});

describe('exp CLI', () => {
  it('passes live models and custom pricing through to the engine budget (HTTP intercepted, no network)', async () => {
    const root = tempDir('jinyang live pricing ');
    const out = path.join(root, 'pilot');
    const model = 'test/priced-model';
    const config = loadConfig({ env: {
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-v1-offline-regression-test',
      MODEL_CHARACTER: model,
      MODEL_JUDGE: model,
      MODEL_NARRATOR: model,
      LLM_PRICE_BOUNDS: `${model}=0.15/0.3`,
      LLM_MAX_TOKENS_CHARACTER: '777',
      LLM_HTTP_RETRIES: '0',
      OPENROUTER_PROVIDER_IGNORE: 'atlas-cloud',
    } });
    const requests: Array<{ model: string; max_tokens: number; provider: unknown; response_format: { json_schema: { name: string } } }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as (typeof requests)[number];
      requests.push(body);
      const outputs: Record<string, unknown> = {
        character_turn: { speech: '稍候。', private_rationale: '', actions: [], ask_player: null },
        judge_verdicts: { items: [] },
        scene_narration: { prose: '风声渐息。', mentioned_facts: [] },
        character_answer: { answer: '稍候。', cites: [] },
      };
      const output = outputs[body.response_format.json_schema.name];
      if (!output) throw new Error(`Unexpected schema: ${body.response_format.json_schema.name}`);
      return new Response(JSON.stringify({
        id: `gen-offline-${requests.length}`,
        choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.00001 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const lines: string[] = [];
      const io = { out: (s: string) => lines.push(s), err: (s: string) => lines.push(s) };
      expect(await expMain(['--plan', 'pilot', '--live', '--cases', 'D1', '--modes', 'full', '--out', out, '--no-env-file'], io, { config })).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.model === model)).toBe(true);
      expect(requests[0]?.max_tokens).toBe(777);
      expect(requests[0]?.provider).toEqual({ require_parameters: true, max_price: { prompt: 0.15, completion: 0.3 }, ignore: ['atlas-cloud'] });
      const planText = readFileSync(path.join(out, 'plan.json'), 'utf8');
      expect(planText).not.toContain('sk-or-v1-offline-regression-test');
      expect(JSON.parse(planText).runtimeSettings).toMatchObject({ reasoning: 'off', providerIgnore: ['atlas-cloud'], maxTokens: { character: 777 } });
      const frozen = buildFreeze(config, content());
      expect(frozen.settings.providerIgnore).toEqual(['atlas-cloud']);
      const changed = buildFreeze({ ...config, providerIgnore: [] }, content());
      expect(freezeMismatches(frozen, changed).some((s) => s.startsWith('settings.providerIgnore'))).toBe(true);
      const runDir = path.join(out, 'D1-full-r1');
      const summary = JSON.parse(readFileSync(path.join(runDir, 'audit/summary.json'), 'utf8'));
      expect(summary.calls).toBeGreaterThan(0);
      expect(summary.refusedCalls).toBe(0);
      expect(summary.costUsd).toBeGreaterThan(0);
      const calls = readFileSync(path.join(runDir, 'audit/llm_calls.jsonl'), 'utf8');
      expect(calls).not.toContain('"status":"config"');
      expect(calls).not.toContain('"model":"unknown"');
      expect(JSON.parse(readFileSync(path.join(runDir, 'replay.json'), 'utf8'))).toMatchObject({ patch: { ok: true }, rederive: { ok: true } });
      const beforeResume = requests.length;
      const args = ['--plan', 'pilot', '--live', '--cases', 'D1', '--modes', 'full', '--out', out, '--no-env-file'];
      expect(await expMain(args, io, { config })).toBe(0);
      expect(requests.length).toBe(beforeResume);
      expect(await expMain(args, io, { config: { ...config, providerIgnore: [] } })).toBe(1);
      expect(lines.at(-1)).toContain('runtime settings changed');
      expect(requests.length).toBe(beforeResume);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('--freeze writes runs/freeze.json; a live main run is refused without the explicit opt-in', async () => {
    const root = tempDir('jinyang freeze ');
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) };
    expect(await expMain(['--freeze', '--runs-root', root, '--no-env-file'], io, { config: mockConfig() })).toBe(0);
    const freeze = JSON.parse(readFileSync(path.join(root, 'freeze.json'), 'utf8')) as ReturnType<typeof buildFreeze>;
    expect(freeze.hashes.prompts).toMatch(/^[0-9a-f]{64}$/);
    expect(freeze.hashes.files).toMatch(/^[0-9a-f]{64}$/);
    expect(freezeMismatches(freeze, buildFreeze(mockConfig(), content()))).toEqual([]);
    const changed = { ...freeze, hashes: { ...freeze.hashes, prompts: 'x' } };
    expect(freezeMismatches(changed, buildFreeze(mockConfig(), content()))[0]).toMatch(/hashes\.prompts/);
    expect(await expMain(['--plan', 'main', '--live', '--runs-root', root, '--no-env-file'], io, { config: mockConfig() })).toBe(1);
    expect(lines.some((l) => l.startsWith('ERR Refusing to make live LLM calls'))).toBe(true);
    expect(await expMain(['--plan', 'nope', '--no-env-file'], io, { config: mockConfig() })).toBe(1);
  });

  it('held-out cases: dev/pilot never accept C1–C6; a live C1–C6 run needs plan main and a matching freeze (no network here)', async () => {
    const root = tempDir('jinyang live gate ');
    const live = loadConfig({ env: { LLM_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'sk-or-v1-testkey0000000000000000000000' } });
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(`ERR ${l}`) };
    const run = (args: string[]) => expMain([...args, '--runs-root', root, '--no-env-file', '--out', path.join(root, 'never')], io, { config: live });
    expect(await run(['--plan', 'pilot', '--cases', 'C1', '--live'])).toBe(1);
    expect(lines.at(-1)).toMatch(/C1 is not part of plan pilot/);
    expect(await run(['--plan', 'dev', '--cases', 'D1,C3'])).toBe(1);
    expect(await run(['--plan', 'main', '--live'])).toBe(1);
    expect(lines.at(-1)).toMatch(/freeze\.json is missing/);
    expect(await run(['--freeze', '--lang', 'zh'])).toBe(0);
    expect(await run(['--plan', 'main', '--live', '--lang', 'en'])).toBe(1);
    expect(lines.at(-1)).toMatch(/settings\.lang/);
    expect(await run(['--plan', 'main', '--live', '--lang', 'zh', '--cases', 'C1'])).toBe(1);
    expect(lines.at(-1)).toMatch(/settings\.cases/);
    expect(existsSync(path.join(root, 'never'))).toBe(false);
  });
});

describe('reconcile (injected fetch; never the network in tests)', () => {
  it('writes reconciled attempt costs that the report picks up', async () => {
    const out = path.join(tempDir('jinyang reconcile '), 'exp');
    await runExperiment({ plan: planSpec('main', { cases: ['C1'], modes: ['full'], reps: 1 }), outDir: out, content: content(), llm: mockFactory(0), live: false, lang: 'zh' });
    const attemptsFile = path.join(out, 'C1-full-r1', 'audit', 'llm_attempts.jsonl');
    const rows = readFileSync(attemptsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    writeFileSync(attemptsFile, `${rows.map((r, i) => JSON.stringify({ ...r, generation_id: `gen-${i}` })).join('\n')}\n`);
    const seen: string[] = [];
    const fetch: FetchFn = async (url, init) => {
      seen.push(url);
      expect(init.headers.Authorization).toBe('Bearer test-key-000000');
      return { ok: true, status: 200, json: async () => ({ data: { total_cost: 0.001 } }) };
    };
    const res = await reconcileDir({ dir: out, apiKey: 'test-key-000000', fetch, sleep: async () => undefined });
    expect(res.ok).toBe(rows.length);
    expect(seen[0]).toBe('https://openrouter.ai/api/v1/generation?id=gen-0');
    const report = buildReport({ dir: out, content: content() });
    expect(report.byMode[0]?.costReconciled).toBeCloseTo(0.001 * rows.length, 10);
  }, 60_000);
});
