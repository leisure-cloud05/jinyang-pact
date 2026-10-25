import { describe, expect, it } from 'vitest';
import { applyPermissive } from '../../src/core/permissive.js';
import { A, DOC_TERMS, LI, SANG, SHI, YELU, batch, config, delivered, initial, outcomeOf, prop } from './helpers.js';

describe('permissive executor (baseline, §4.3)', () => {
  it("applies an on-behalf consent to the named target, attributing it to the actor", () => {
    const s = delivered();
    const onBehalf = prop(SANG, A.confirm('cmt:1', 'offer:1', 1));
    const r = batch(s, [onBehalf], { mode: 'baseline' });
    expect(outcomeOf(r, onBehalf)).toMatchObject({ status: 'committed', gate: 'ungated', category: 'major_commitment' });
    expect(r.state.commitments['cmt:1']?.status).toBe('confirmed');
    expect(r.state.commitments['cmt:1']?.consents[YELU]).toMatchObject({ termsVersion: 1, by: SANG });
    expect(r.events[0]?.actor).toBe(SANG); // the oracle sees who acted
  });

  it('applies an overdraft (balances may go negative)', () => {
    const r = batch(initial(), [prop(SHI, A.allocate('hedong', 'silk', 500000, 'pay_troops'))], { mode: 'baseline' });
    expect(r.state.factions.hedong.resources.silk).toBe(-380000);
    expect(r.state.siege.morale).toBe(100);
  });

  it('commits a critical action without approval or pause', () => {
    const d = prop(SHI, A.dispatch());
    const r = batch(initial(), [d], { mode: 'baseline' });
    expect(outcomeOf(r, d)).toMatchObject({ status: 'committed', gate: 'ungated' });
    expect(r.state.offers['offer:1']?.consentEvidence).toBe(`event:${outcomeOf(r, d).eventVersions[0]}`);
  });

  it('marks inapplicable attempts unapplied (not commits)', () => {
    const s = delivered();
    const missing = prop(YELU, A.confirm('cmt:1', 'offer:99', 1));
    const malformed = prop(YELU, { type: 'confirm_commitment', args: { offerId: 'offer:1' } });
    const selfPair = prop(LI, A.propose(LI, DOC_TERMS));
    const r = batch(s, [missing, malformed, selfPair], { mode: 'baseline' });
    expect(outcomeOf(r, missing)).toMatchObject({ status: 'unapplied' });
    expect(outcomeOf(r, missing).reason).toContain('offer:99');
    expect(outcomeOf(r, malformed).status).toBe('unapplied');
    expect(outcomeOf(r, selfPair).status).toBe('unapplied');
    expect(r.events).toEqual([]);
    expect(r.state).toEqual(s);
  });

  it('resurrects nothing it cannot find but applies natural effects to closed objects (oracle flags them)', () => {
    let s = delivered();
    s = batch(s, [prop(YELU, A.reject('offer:1'))], { mode: 'baseline' }).state;
    const res = applyPermissive(s, config(), YELU, A.confirm('cmt:1', 'offer:1', 1));
    expect(res.status).toBe('applied');
  });
});
