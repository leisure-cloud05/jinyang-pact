/**
 * Human-evaluation analysis (PLAN §13.4): reads the raters' CSV sheets (`ratings/<rater>.csv`, columns of
 * `ratings_template.csv`) and the packet key, and reports per-configuration mean/median/SD of the 1–5 ratings,
 * a matched per-case comparison, weighted Cohen's κ (quadratic weights; two raters), Krippendorff's α (ordinal;
 * any number of raters, missing values allowed), the disagreement list (|Δ| ≥ 2), human pause precision (pauses
 * labelled necessary ÷ all labelled pauses) and the other yes/no marks. Raters whose id starts with `llm:` are
 * supplementary (LLM-as-judge): reported separately and excluded from every primary statistic.
 * Small-sample honesty: counts and denominators, no significance tests.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RATING_DIMENSIONS, type PacketKeyEntry, type RatingDimension } from './humaneval.js';

export interface RatingRow {
  rater: string;
  packetId: string;
  itemType: string;
  itemId: string;
  response: string;
  comment: string;
}

/** RFC-4180 CSV parser (quotes, doubled quotes, embedded newlines, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

export function readRatings(dir: string): RatingRow[] {
  const out: RatingRow[] = [];
  for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv')).sort()) {
    const rows = parseCsv(readFileSync(path.join(dir, file), 'utf8'));
    const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const col = (name: string) => header.indexOf(name);
    for (const r of rows.slice(1)) {
      const get = (name: string) => (col(name) >= 0 ? (r[col(name)] ?? '').trim() : '');
      const rater = get('rater_id') || path.basename(file, path.extname(file));
      out.push({ rater, packetId: get('packet_id'), itemType: get('item_type'), itemId: get('item_id'), response: get('response'), comment: get('comment') });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------------------

export interface Summary {
  n: number;
  mean: number | null;
  median: number | null;
  sd: number | null;
}

export function summarize(values: readonly number[]): Summary {
  const n = values.length;
  if (n === 0) return { n, mean: null, median: null, sd: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const s = [...values].sort((a, b) => a - b);
  const median = n % 2 === 1 ? (s[(n - 1) / 2] as number) : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : null;
  return { n, mean, median, sd };
}

/** Weighted Cohen's κ for two raters on an ordinal scale (`quadratic` default, or `linear` weights). */
export function weightedKappa(pairs: ReadonlyArray<readonly [number, number]>, categories: readonly number[] = [1, 2, 3, 4, 5], weights: 'quadratic' | 'linear' = 'quadratic'): number | null {
  const k = categories.length;
  const n = pairs.length;
  if (n === 0 || k < 2) return null;
  const idx = (v: number) => categories.indexOf(v);
  const O = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (const [a, b] of pairs) {
    const i = idx(a);
    const j = idx(b);
    if (i < 0 || j < 0) continue;
    (O[i] as number[])[j] = ((O[i] as number[])[j] as number) + 1 / n;
  }
  const row = O.map((r) => r.reduce((a, b) => a + b, 0));
  const col = categories.map((_, j) => O.reduce((a, r) => a + (r[j] as number), 0));
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const d = Math.abs(i - j) / (k - 1);
      const w = weights === 'quadratic' ? d * d : d;
      num += w * ((O[i] as number[])[j] as number);
      den += w * (row[i] as number) * (col[j] as number);
    }
  }
  return den === 0 ? null : 1 - num / den;
}

/**
 * Krippendorff's α with the ordinal metric. `units` = the values given to each unit by the raters who rated it
 * (missing values simply absent). Units with fewer than two values are not pairable and are ignored.
 */
export function krippendorffAlphaOrdinal(units: ReadonlyArray<readonly number[]>): number | null {
  const pairable = units.filter((u) => u.length >= 2);
  const values = [...new Set(pairable.flat())].sort((a, b) => a - b);
  if (values.length === 0) return null;
  const at = new Map(values.map((v, i) => [v, i]));
  const m = values.length;
  const o = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  for (const u of pairable) {
    for (let i = 0; i < u.length; i++) {
      for (let j = 0; j < u.length; j++) {
        if (i === j) continue;
        const a = at.get(u[i] as number) as number;
        const b = at.get(u[j] as number) as number;
        (o[a] as number[])[b] = ((o[a] as number[])[b] as number) + 1 / (u.length - 1);
      }
    }
  }
  const nc = o.map((r) => r.reduce((a, b) => a + b, 0));
  const n = nc.reduce((a, b) => a + b, 0);
  const delta2 = (c: number, k: number): number => {
    if (c === k) return 0;
    const [lo, hi] = c < k ? [c, k] : [k, c];
    let sum = 0;
    for (let g = lo; g <= hi; g++) sum += nc[g] as number;
    return (sum - ((nc[c] as number) + (nc[k] as number)) / 2) ** 2;
  };
  let observed = 0;
  let expected = 0;
  for (let c = 0; c < m; c++) {
    for (let k = 0; k < m; k++) {
      const d = delta2(c, k);
      observed += ((o[c] as number[])[k] as number) * d;
      expected += (nc[c] as number) * (nc[k] as number) * d;
    }
  }
  if (expected === 0) return null;
  return 1 - ((n - 1) * observed) / expected;
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------

export interface YesNo {
  yes: number;
  total: number;
  value: number | null;
}

function yesNo(list: readonly string[]): YesNo {
  const valid = list.map((x) => x.toLowerCase()).filter((x) => x === 'yes' || x === 'no');
  const yes = valid.filter((x) => x === 'yes').length;
  return { yes, total: valid.length, value: valid.length === 0 ? null : yes / valid.length };
}

/**
 * Human pause precision of one configuration (PLAN §13.2): the denominator is every decision pause listed in the
 * packet key; a pause is necessary iff a strict majority of the primary raters say yes (ties and unlabelled pauses
 * count as not necessary — a conservative lower bound). Coverage and per-rater precision are reported alongside.
 */
export interface PausePrecision {
  necessary: number;
  pauses: number;
  value: number | null;
  coverage: { labelled: number; expected: number };
  perRater: Record<string, { yes: number; labelled: number; pauses: number; precision: number | null }>;
}

export interface AgreementReport {
  raters: string[];
  supplementaryRaters: string[];
  perConfig: Record<string, Record<RatingDimension, Summary>>;
  perCase: Array<{ caseId: string; dimension: RatingDimension; byMode: Record<string, number | null> }>;
  kappa: Record<RatingDimension, { raters: [string, string] | null; n: number; value: number | null }>;
  alpha: Record<RatingDimension, { units: number; value: number | null }>;
  disagreements: Array<{ packetId: string; caseId: string; mode: string; dimension: string; ratings: Record<string, number>; delta: number }>;
  pausePrecision: Record<string, PausePrecision>;
  shouldHaveAsked: Record<string, YesNo>;
  leakage: Record<string, YesNo>;
  contradiction: Record<string, YesNo>;
  supplementary: Record<string, Record<RatingDimension, Summary>>;
  problems: string[];
}

export function analyzeRatings(rows: readonly RatingRow[], key: readonly PacketKeyEntry[]): AgreementReport {
  const byId = new Map(key.map((k) => [k.id, k]));
  const problems: string[] = [];
  const primary = rows.filter((r) => !r.rater.startsWith('llm:'));
  const supplementary = rows.filter((r) => r.rater.startsWith('llm:'));
  for (const r of rows) if (!byId.has(r.packetId)) problems.push(`unknown packet ${r.packetId} (rater ${r.rater})`);
  const raters = [...new Set(primary.map((r) => r.rater))].sort();
  const modes = [...new Set(key.map((k) => k.mode))];
  const cases = [...new Set(key.map((k) => k.caseId))].sort();
  const score = (r: RatingRow): number | null => {
    const v = Number(r.response);
    if (!Number.isInteger(v) || v < 1 || v > 5) {
      if (r.response !== '') problems.push(`${r.rater} ${r.packetId} ${r.itemType}: rating "${r.response}" is not 1–5`);
      return null;
    }
    return v;
  };
  const dimRows = (list: readonly RatingRow[], dim: string) => list.filter((r) => r.itemType === dim);
  const perConfigOf = (list: readonly RatingRow[]) => {
    const out: Record<string, Record<RatingDimension, Summary>> = {};
    for (const m of modes) {
      out[m] = {} as Record<RatingDimension, Summary>;
      for (const d of RATING_DIMENSIONS) {
        const vals = dimRows(list, d)
          .filter((r) => byId.get(r.packetId)?.mode === m)
          .map(score)
          .filter((v): v is number => v !== null);
        (out[m] as Record<RatingDimension, Summary>)[d] = summarize(vals);
      }
    }
    return out;
  };
  const perCase: AgreementReport['perCase'] = [];
  for (const c of cases) {
    for (const d of RATING_DIMENSIONS) {
      const byMode: Record<string, number | null> = {};
      for (const m of modes) {
        const vals = dimRows(primary, d)
          .filter((r) => byId.get(r.packetId)?.caseId === c && byId.get(r.packetId)?.mode === m)
          .map(score)
          .filter((v): v is number => v !== null);
        byMode[m] = summarize(vals).mean;
      }
      perCase.push({ caseId: c, dimension: d, byMode });
    }
  }
  const kappa = {} as AgreementReport['kappa'];
  const alpha = {} as AgreementReport['alpha'];
  const disagreements: AgreementReport['disagreements'] = [];
  for (const d of RATING_DIMENSIONS) {
    const grid = new Map<string, Map<string, number>>();
    for (const r of dimRows(primary, d)) {
      const v = score(r);
      if (v === null) continue;
      const m = grid.get(r.packetId) ?? new Map<string, number>();
      m.set(r.rater, v);
      grid.set(r.packetId, m);
    }
    const pair: [string, string] | null = raters.length >= 2 ? [raters[0] as string, raters[1] as string] : null;
    const pairs: Array<[number, number]> = [];
    if (pair) for (const m of grid.values()) if (m.has(pair[0]) && m.has(pair[1])) pairs.push([m.get(pair[0]) as number, m.get(pair[1]) as number]);
    kappa[d] = { raters: pair, n: pairs.length, value: weightedKappa(pairs) };
    alpha[d] = { units: [...grid.values()].filter((m) => m.size >= 2).length, value: krippendorffAlphaOrdinal([...grid.values()].map((m) => [...m.values()])) };
    for (const [packetId, m] of grid) {
      const vals = [...m.values()];
      const delta = vals.length >= 2 ? Math.max(...vals) - Math.min(...vals) : 0;
      if (delta >= 2) {
        const k = byId.get(packetId);
        disagreements.push({ packetId, caseId: k?.caseId ?? '?', mode: k?.mode ?? '?', dimension: d, ratings: Object.fromEntries(m), delta });
      }
    }
  }
  if (raters.length > 2) problems.push(`κ uses the first two raters (${raters.slice(0, 2).join(', ')}); α uses all ${raters.length}`);
  const marks = (type: string) => {
    const out: Record<string, YesNo> = {};
    for (const m of modes) out[m] = yesNo(primary.filter((r) => r.itemType === type && byId.get(r.packetId)?.mode === m).map((r) => r.response));
    return out;
  };
  const pausePrecision: AgreementReport['pausePrecision'] = {};
  for (const m of modes) {
    const expected = key.filter((k) => k.mode === m).flatMap((k) => Object.keys(k.pauses).map((label) => `${k.id}/${label}`));
    const answer = (rater: string, item: string): string | null => {
      const row = primary.find((r) => r.rater === rater && r.itemType === 'pause_necessary' && `${r.packetId}/${r.itemId}` === item);
      const v = row?.response.toLowerCase() ?? '';
      return v === 'yes' || v === 'no' ? v : null;
    };
    let necessary = 0;
    let labelled = 0;
    for (const item of expected) {
      const votes = raters.map((rater) => answer(rater, item));
      labelled += votes.filter((v) => v !== null).length;
      if (raters.length > 0 && votes.filter((v) => v === 'yes').length > raters.length / 2) necessary += 1;
    }
    const perRater: PausePrecision['perRater'] = {};
    for (const rater of raters) {
      const votes = expected.map((item) => answer(rater, item));
      const yes = votes.filter((v) => v === 'yes').length;
      perRater[rater] = { yes, labelled: votes.filter((v) => v !== null).length, pauses: expected.length, precision: expected.length === 0 ? null : yes / expected.length };
    }
    pausePrecision[m] = { necessary, pauses: expected.length, value: expected.length === 0 ? null : necessary / expected.length, coverage: { labelled, expected: expected.length * raters.length }, perRater };
  }
  return {
    raters,
    supplementaryRaters: [...new Set(supplementary.map((r) => r.rater))].sort(),
    perConfig: perConfigOf(primary),
    perCase,
    kappa,
    alpha,
    disagreements,
    pausePrecision,
    shouldHaveAsked: marks('should_have_asked'),
    leakage: marks('leakage'),
    contradiction: marks('contradiction'),
    supplementary: perConfigOf(supplementary),
    problems,
  };
}

function f(v: number | null, d = 2): string {
  return v === null ? 'n/a' : v.toFixed(d);
}

export function agreementMarkdown(r: AgreementReport): string {
  const L: string[] = ['# Human evaluation — ratings and agreement', ''];
  L.push(`Primary raters: ${r.raters.join(', ') || '(none)'}. Supplementary (LLM-as-judge, excluded from primary statistics): ${r.supplementaryRaters.join(', ') || 'none'}.`, '');
  L.push('Descriptive only: counts and denominators, no significance tests.', '');
  const modes = Object.keys(r.perConfig);
  L.push('## Ratings per configuration (1–5): mean / median / SD (n)', '');
  L.push(`| dimension | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---').join('|')}|`);
  for (const d of RATING_DIMENSIONS) L.push(`| ${d} | ${modes.map((m) => { const s = r.perConfig[m]?.[d]; return s ? `${f(s.mean)} / ${f(s.median, 1)} / ${f(s.sd)} (${s.n})` : 'n/a'; }).join(' | ')} |`);
  L.push('', '## Matched per-case comparison (mean rating)', '');
  L.push(`| case | dimension | ${modes.join(' | ')} |`, `|---|---|${modes.map(() => '---').join('|')}|`);
  for (const row of r.perCase) L.push(`| ${row.caseId} | ${row.dimension} | ${modes.map((m) => f(row.byMode[m] ?? null)).join(' | ')} |`);
  L.push('', '## Inter-rater agreement', '');
  L.push('| dimension | weighted κ (quadratic) | pairs | Krippendorff α (ordinal) | units |', '|---|---|---|---|---|');
  for (const d of RATING_DIMENSIONS) L.push(`| ${d} | ${f(r.kappa[d].value, 3)} | ${r.kappa[d].n} | ${f(r.alpha[d].value, 3)} | ${r.alpha[d].units} |`);
  L.push('', '## Human pause precision', '', 'Necessary iff a strict majority of the primary raters say yes; ties and unlabelled pauses count as not necessary (conservative lower bound). Denominator: every decision pause listed in the packet key.', '');
  L.push('| configuration | precision (necessary / pauses) | label coverage | per rater (yes / pauses) |', '|---|---|---|---|');
  for (const m of modes) {
    const p = r.pausePrecision[m];
    if (p) L.push(`| ${m} | ${f(p.value)} (${p.necessary}/${p.pauses}) | ${p.coverage.labelled}/${p.coverage.expected} | ${Object.entries(p.perRater).map(([k, v]) => `${k} ${f(v.precision)} (${v.yes}/${v.pauses})`).join('; ')} |`);
  }
  L.push('', '## Other marks (share of "yes")', '');
  L.push('| configuration | should have been asked | leakage | contradiction |', '|---|---|---|---|');
  for (const m of modes) L.push(`| ${m} | ${f(r.shouldHaveAsked[m]?.value ?? null)} (${r.shouldHaveAsked[m]?.yes ?? 0}/${r.shouldHaveAsked[m]?.total ?? 0}) | ${f(r.leakage[m]?.value ?? null)} (${r.leakage[m]?.yes ?? 0}/${r.leakage[m]?.total ?? 0}) | ${f(r.contradiction[m]?.value ?? null)} (${r.contradiction[m]?.yes ?? 0}/${r.contradiction[m]?.total ?? 0}) |`);
  L.push('', '## Disagreements (|Δ| ≥ 2)', '');
  if (r.disagreements.length === 0) L.push('None.');
  for (const x of r.disagreements) L.push(`- ${x.packetId} (${x.caseId}, ${x.mode}) ${x.dimension}: ${Object.entries(x.ratings).map(([k, v]) => `${k}=${v}`).join(', ')} (Δ ${x.delta})`);
  if (r.supplementaryRaters.length > 0) {
    L.push('', '## Supplementary: LLM-as-judge ratings (not human; excluded above)', '');
    for (const m of Object.keys(r.supplementary)) L.push(`- ${m}: ${RATING_DIMENSIONS.map((d) => `${d} ${f(r.supplementary[m]?.[d]?.mean ?? null)}`).join(', ')}`);
  }
  if (r.problems.length > 0) L.push('', '## Data problems', '', ...r.problems.map((p) => `- ${p}`));
  L.push('');
  return `${L.join('\n')}\n`;
}

export function runAgreement(opts: { ratingsDir: string; keyFile: string; outDir?: string }): { report: AgreementReport; files: string[] } {
  if (!existsSync(opts.keyFile)) throw new Error(`packet key not found: ${opts.keyFile}`);
  const key = (JSON.parse(readFileSync(opts.keyFile, 'utf8')) as { packets: PacketKeyEntry[] }).packets;
  const report = analyzeRatings(readRatings(opts.ratingsDir), key);
  const outDir = path.resolve(opts.outDir ?? path.join(opts.ratingsDir, 'analysis'));
  mkdirSync(outDir, { recursive: true });
  const files = [path.join(outDir, 'agreement.json'), path.join(outDir, 'agreement.md')];
  writeFileSync(files[0] as string, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(files[1] as string, agreementMarkdown(report), 'utf8');
  return { report, files };
}
