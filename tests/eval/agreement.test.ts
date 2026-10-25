/**
 * Human-evaluation statistics against hand-computed values (PLAN §13.4): weighted Cohen's κ (quadratic and linear),
 * Krippendorff's α (ordinal), summaries, CSV parsing, and the analysis of rating sheets (per-config summaries,
 * disagreements, human pause precision, supplementary LLM raters excluded).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeRatings, krippendorffAlphaOrdinal, parseCsv, readRatings, runAgreement, summarize, weightedKappa } from '../../src/eval/agreement.js';
import type { PacketKeyEntry } from '../../src/eval/humaneval.js';
import { tempDir } from './helpers.js';

describe('weighted Cohen κ (hand-computed)', () => {
  // Pairs (1,1) (2,2) (3,3) (4,5) (5,4), n = 5, categories 1–5, uniform marginals 0.2 ⇒ E_ij = 0.04.
  // Quadratic: ΣwO = 2·0.2·(1/4)² = 0.025; Σ_ij (i−j)² = 100 ⇒ ΣwE = 0.04·100/16 = 0.25 ⇒ κ = 1 − 0.1 = 0.9.
  // Linear:    ΣwO = 2·0.2·(1/4) = 0.1;    Σ_ij |i−j| = 40  ⇒ ΣwE = 0.04·40/4 = 0.4   ⇒ κ = 1 − 0.25 = 0.75.
  const pairs: Array<[number, number]> = [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 5],
    [5, 4],
  ];
  it('quadratic weights', () => expect(weightedKappa(pairs)).toBeCloseTo(0.9, 12));
  it('linear weights', () => expect(weightedKappa(pairs, [1, 2, 3, 4, 5], 'linear')).toBeCloseTo(0.75, 12));
  it('perfect agreement is 1; no data is n/a', () => {
    expect(weightedKappa([[2, 2], [4, 4]])).toBeCloseTo(1, 12);
    expect(weightedKappa([])).toBeNull();
  });
});

describe("Krippendorff's α, ordinal (hand-computed)", () => {
  it('binary example: units (1,1) (1,2) (2,2) ⇒ α = 4/9', () => {
    // o = [[2,1],[1,2]], n1 = n2 = 3, n = 6, δ²(1,2) = (6 − 3)² = 9 ⇒ α = 1 − 5·18/162 = 4/9.
    expect(krippendorffAlphaOrdinal([[1, 1], [1, 2], [2, 2]])).toBeCloseTo(4 / 9, 12);
  });
  it('three categories: units (1,1) (1,3) (2,2) (3,3) ⇒ α = 5/12', () => {
    // n1 = 3, n2 = 2, n3 = 3, n = 8; δ²(1,2) = δ²(2,3) = 2.5² = 6.25, δ²(1,3) = (8 − 3)² = 25;
    // D_o = 2·25 = 50; Σ n_c n_k δ² = 2·(6·6.25 + 6·6.25 + 9·25) = 600 ⇒ α = 1 − 7·50/600 = 5/12.
    expect(krippendorffAlphaOrdinal([[1, 1], [1, 3], [2, 2], [3, 3]])).toBeCloseTo(5 / 12, 12);
  });
  it('missing values and unpairable units are ignored; perfect agreement is 1', () => {
    expect(krippendorffAlphaOrdinal([[1, 1], [2], [], [3, 3, 3]])).toBeCloseTo(1, 12);
    expect(krippendorffAlphaOrdinal([[4]])).toBeNull();
  });
});

describe('summaries and CSV', () => {
  it('mean / median / sample SD', () => {
    const s = summarize([1, 2, 3, 4]);
    expect(s.mean).toBe(2.5);
    expect(s.median).toBe(2.5);
    expect(s.sd).toBeCloseTo(Math.sqrt(5 / 3), 12);
    expect(summarize([])).toEqual({ n: 0, mean: null, median: null, sd: null });
  });
  it('parses quotes, doubled quotes, commas and newlines', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi""\nthen"\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"\nthen'],
    ]);
  });
});

describe('rating analysis', () => {
  const key: PacketKeyEntry[] = [
    { id: 'JP-A', runId: 'C1-baseline-r1', caseId: 'C1', mode: 'baseline', pauses: {}, outcomes: { O1: 'dispatch_request|doc:1@v1' }, paragraphs: {} },
    { id: 'JP-B', runId: 'C1-full-r1', caseId: 'C1', mode: 'full', pauses: { P1: 'pause1', P2: 'pause2' }, outcomes: {}, paragraphs: { N1: 'narration:1#1' } },
  ];
  const header = 'rater_id,packet_id,item_type,item_id,prompt,response,comment';
  const sheet = (rater: string, a: number[], b: number[], pauses: string[]) =>
    [
      header,
      `${rater},JP-A,character_consistency,-,p,${a[0]},`,
      `${rater},JP-A,causal_plausibility,-,p,${a[1]},`,
      `${rater},JP-A,perceived_user_control,-,p,${a[2]},`,
      `${rater},JP-A,should_have_asked,O1,p,yes,`,
      `${rater},JP-B,character_consistency,-,p,${b[0]},`,
      `${rater},JP-B,causal_plausibility,-,p,${b[1]},`,
      `${rater},JP-B,perceived_user_control,-,p,${b[2]},`,
      `${rater},JP-B,pause_necessary,P1,p,${pauses[0]},`,
      `${rater},JP-B,pause_necessary,P2,p,${pauses[1]},`,
      `${rater},JP-B,contradiction,N1,p,no,`,
      '',
    ].join('\n');

  it('per-config summaries, κ/α, disagreements and pause precision; LLM raters are supplementary', () => {
    const dir = tempDir('jinyang ratings ');
    const ratings = path.join(dir, 'ratings');
    mkdirSync(ratings);
    writeFileSync(path.join(ratings, 'r1.csv'), sheet('r1', [2, 3, 1], [4, 4, 5], ['yes', 'yes']));
    writeFileSync(path.join(ratings, 'r2.csv'), sheet('r2', [4, 3, 2], [4, 5, 5], ['yes', 'no']));
    writeFileSync(path.join(ratings, 'llm.csv'), sheet('llm:judge', [5, 5, 5], [5, 5, 5], ['yes', 'yes']));
    const report = analyzeRatings(readRatings(ratings), key);
    expect(report.raters).toEqual(['r1', 'r2']);
    expect(report.supplementaryRaters).toEqual(['llm:judge']);
    expect(report.perConfig.baseline?.character_consistency).toMatchObject({ n: 2, mean: 3, median: 3 });
    expect(report.perConfig.full?.perceived_user_control).toMatchObject({ n: 2, mean: 5, sd: 0 });
    // Disagreement |Δ| ≥ 2: JP-A character_consistency 2 vs 4.
    expect(report.disagreements.map((d) => [d.packetId, d.dimension, d.delta])).toEqual([['JP-A', 'character_consistency', 2]]);
    // Pause precision (full): P1 yes/yes ⇒ necessary; P2 yes/no is a tie ⇒ not necessary ⇒ 1/2 (key denominator).
    expect(report.pausePrecision.full).toMatchObject({ necessary: 1, pauses: 2, value: 0.5, coverage: { labelled: 4, expected: 4 } });
    expect(report.pausePrecision.full?.perRater).toEqual({ r1: { yes: 2, labelled: 2, pauses: 2, precision: 1 }, r2: { yes: 1, labelled: 2, pauses: 2, precision: 0.5 } });
    // Baseline has no pauses in the key ⇒ n/a.
    expect(report.pausePrecision.baseline).toMatchObject({ pauses: 0, value: null });
    expect(report.shouldHaveAsked.baseline).toMatchObject({ yes: 2, total: 2 });
    expect(report.contradiction.full).toMatchObject({ yes: 0, total: 2 });
    // κ on character_consistency pairs (2,4) and (4,4): computed, finite.
    expect(report.kappa.character_consistency.n).toBe(2);
    expect(report.alpha.character_consistency.units).toBe(2);
    const files = runAgreement({ ratingsDir: ratings, keyFile: writeKey(dir, key) }).files;
    expect(files.map((f) => path.basename(f))).toEqual(['agreement.json', 'agreement.md']);
  });
});

describe('human pause precision is enumerated from the packet key (review finding 9)', () => {
  it('two expected pauses, both raters say yes only for P1 ⇒ 1/2 with coverage 2/4 (not 100 %)', () => {
    const key: PacketKeyEntry[] = [{ id: 'JP-B', runId: 'C1-full-r1', caseId: 'C1', mode: 'full', pauses: { P1: 'a', P2: 'b' }, outcomes: {}, paragraphs: {} }];
    const rows = ['r1', 'r2'].map((rater) => ({ rater, packetId: 'JP-B', itemType: 'pause_necessary', itemId: 'P1', response: 'yes', comment: '' }));
    const p = analyzeRatings(rows, key).pausePrecision.full;
    expect(p).toMatchObject({ necessary: 1, pauses: 2, value: 0.5, coverage: { labelled: 2, expected: 4 } });
  });

  it('a single "yes" among three raters is not a strict majority', () => {
    const key: PacketKeyEntry[] = [{ id: 'JP-C', runId: 'C2-full-r1', caseId: 'C2', mode: 'full', pauses: { P1: 'a' }, outcomes: {}, paragraphs: {} }];
    const rows = [
      { rater: 'a', packetId: 'JP-C', itemType: 'pause_necessary', itemId: 'P1', response: 'yes', comment: '' },
      { rater: 'b', packetId: 'JP-C', itemType: 'pause_necessary', itemId: 'P1', response: 'no', comment: '' },
      { rater: 'c', packetId: 'JP-C', itemType: 'character_consistency', itemId: '-', response: '3', comment: '' },
    ];
    expect(analyzeRatings(rows, key).pausePrecision.full).toMatchObject({ necessary: 0, pauses: 1, value: 0 });
  });
});

function writeKey(dir: string, key: PacketKeyEntry[]): string {
  const file = path.join(dir, 'key.json');
  writeFileSync(file, JSON.stringify({ packets: key }));
  return file;
}
