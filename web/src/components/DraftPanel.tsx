/**
 * Draft: the request for assistance as the clerk sees it — terms (editable within the catalog ranges), version,
 * Shi Jingtang's approval, dispatch timing, the negotiation as far as the clerk knows it, the council's
 * suggestions, the goal and standing authorizations. "Transmit" is the player's own decision (player-initiated:
 * no pause), so it asks for confirmation first.
 */
import { useEffect, useState } from 'react';
import type { InputResult, Lang, StateView } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl } from '../api';
import { fmt, t } from '../labels';
import { TermsEditor, TermsTable, burdenOf, limitsSummary, toDraft, type TermsDraft } from './terms';
import { Badge, Empty, ErrorNote, Section } from './ui';

export function DraftPanel({ sessionId, state, lang, onChanged, onTransmit }: { sessionId: string; state: StateView; lang: Lang; onChanged: () => void; onTransmit: () => void }) {
  const doc = state.document;
  const catalog = state.catalog;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TermsDraft | null>(doc ? toDraft(doc.terms) : null);
  const [note, setNote] = useState(doc?.note ?? '');
  const [reason, setReason] = useState('');
  const [timing, setTiming] = useState<{ mode: string; rounds: number }>({ mode: doc?.timing.mode ?? 'now', rounds: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const yourTurn = state.control.state === 'awaiting_player';

  useEffect(() => {
    if (!editing && doc) {
      setDraft(toDraft(doc.terms));
      setNote(doc.note);
    }
  }, [doc?.version, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc || !draft) {
    return (
      <section className="panel draft">
        <h2>Draft</h2>
        <Empty>No document is accessible to you.</Empty>
      </section>
    );
  }

  const act = async (action: { type: string; args: Record<string, unknown> }, done?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await postJson<InputResult>(sessionUrl(sessionId, 'input'), { kind: 'action', turn: state.control.turn, action });
      const o = r.outcomes[0];
      if (o) setResult(o.status === 'committed' ? `${o.type}: done.` : `${o.type}: ${o.status}${o.rule ? ` (${o.rule})` : ''}${o.feedback ? ` — ${o.feedback}` : ''}`);
      if (o?.status === 'committed') done?.();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revise = (): Promise<void> =>
    act({ type: 'revise_document', args: { docId: doc.docId, baseDocVersion: doc.version, terms: draft, note } }, () => setEditing(false));

  const suggest = (): Promise<void> => {
    const current = toDraft(doc.terms) as unknown as Record<string, unknown>;
    const partial: Record<string, unknown> = {};
    for (const e of catalog.terms) {
      const v = (draft as unknown as Record<string, unknown>)[e.key];
      partial[e.key] = v !== current[e.key] ? v : null;
    }
    partial.secret_clauses = null;
    return act({ type: 'suggest_revision', args: { target: { kind: 'document', id: doc.docId }, terms: partial, reason: reason.trim() || 'The clerk suggests these changes.' } }, () => setEditing(false));
  };

  const setDispatchTiming = (): Promise<void> =>
    act({ type: 'set_dispatch_timing', args: { docId: doc.docId, mode: timing.mode, rounds: timing.mode === 'delay' ? timing.rounds : null } });

  const goalMax = state.world.goal.limits.burden_max;
  const draftBurden = burdenOf(draft as unknown as Record<string, unknown>, catalog);

  return (
    <section className="panel draft" aria-labelledby="draft-title">
      <div className="panel-head">
        <h2 id="draft-title">
          Request for assistance <span className="muted">→ {doc.toName.zh}</span>
        </h2>
        <div className="badges">
          <Badge tone="info">v{doc.version}</Badge>
          <Badge tone={doc.status === 'sent' ? 'ok' : doc.status === 'approved' ? 'ok' : doc.status === 'withdrawn' ? 'bad' : 'muted'}>{doc.status}</Badge>
          {doc.approvedCurrent ? (
            <Badge tone="ok" title="Shi Jingtang's seal covers this version (consent evidence for dispatch)">
              sealed by Shi · v{doc.approval?.version}
            </Badge>
          ) : doc.approval ? (
            <Badge tone="warn" title="The draft changed after approval: the approval is void">
              approval void (was v{doc.approval.version})
            </Badge>
          ) : (
            <Badge tone="muted">not approved</Badge>
          )}
        </div>
      </div>

      {editing ? (
        <div className="editing">
          <TermsEditor value={draft} onChange={setDraft} catalog={catalog} lang={lang} knownClauses={doc.terms.secret_clauses} />
          <div className="field">
            <label htmlFor="doc-note">Note</label>
            <input id="doc-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="sug-reason">Reason (for a suggestion)</label>
            <input id="sug-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="减轻岁输，以免后患" />
          </div>
          <p className="hint">Revising creates version {doc.version + 1} and voids Shi’s approval; it never creates anyone’s consent. A suggestion is non-binding advice to the council.</p>
          <div className="row">
            <button type="button" className="btn" disabled={busy || !yourTurn} onClick={() => void revise()}>
              Revise (v{doc.version + 1})
            </button>
            <button type="button" className="btn-secondary" disabled={busy || !yourTurn} onClick={() => void suggest()}>
              Suggest instead
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <TermsTable terms={doc.terms} catalog={catalog} lang={lang} />
          {doc.note ? <p className="doc-note">{doc.note}</p> : null}
          <div className="row">
            <button type="button" className="btn-secondary" disabled={!yourTurn || doc.status === 'sent'} onClick={() => setEditing(true)}>
              Edit terms
            </button>
          </div>
        </>
      )}

      <div className={`meter ${doc.withinGoal.ok ? 'meter-ok' : 'meter-bad'}`} role="status">
        <span>
          Burden {editing ? draftBurden : doc.burden}
          {typeof goalMax === 'number' ? ` / goal ≤ ${goalMax}` : ''}
        </span>
        {doc.withinGoal.ok ? <Badge tone="ok">within your goal</Badge> : <Badge tone="bad">beyond your goal</Badge>}
        {!doc.withinGoal.ok ? <span className="hint">{doc.withinGoal.violations.join('; ')}</span> : null}
      </div>

      <Section title="Dispatch">
        <fieldset className="timing" disabled={!yourTurn || doc.status === 'sent' || busy}>
          <legend className="sr-only">Dispatch timing</legend>
          {(['now', 'delay', 'hold'] as const).map((m) => (
            <label key={m} className="check">
              <input type="radio" name="timing" value={m} checked={timing.mode === m} onChange={() => setTiming({ ...timing, mode: m })} /> {m === 'now' ? 'Send when approved' : m === 'delay' ? 'Delay' : 'Hold'}
            </label>
          ))}
          {timing.mode === 'delay' ? (
            <label className="check">
              <input type="number" min={1} max={3} value={timing.rounds} onChange={(e) => setTiming({ ...timing, rounds: Math.min(3, Math.max(1, Number(e.target.value))) })} aria-label="Rounds of delay" /> round(s)
            </label>
          ) : null}
          <button type="button" className="btn-secondary" onClick={() => void setDispatchTiming()}>
            Set timing
          </button>
        </fieldset>
        <p className="hint">
          Current: {doc.timing.mode}
          {doc.timing.notBeforeRound !== null ? ` (not before round ${doc.timing.notBeforeRound})` : ''}
        </p>
        <div className="row">
          <button type="button" className="btn btn-transmit" disabled={!yourTurn || !doc.transmit.ok || busy} onClick={onTransmit} title={doc.transmit.reason ?? 'Send the approved request now'}>
            Transmit…
          </button>
          {!doc.transmit.ok ? <span className="hint">{doc.transmit.reason}</span> : null}
        </div>
      </Section>
      {result ? (
        <p className="note" role="status">
          {result}
        </p>
      ) : null}
      <ErrorNote error={error} />

      <Section title="Negotiation as you know it">
        {state.world.negotiation.offers.length === 0 ? (
          <Empty>No offer has been sent or received that you know of.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Offer</th>
                <th>From → to</th>
                <th>Terms v</th>
                <th>You believe</th>
                <th>Segment</th>
              </tr>
            </thead>
            <tbody>
              {state.world.negotiation.offers.map((o) => (
                <tr key={o.offerId}>
                  <td>{o.offerId}</td>
                  <td>
                    {o.fromName.zh} → {o.toName.zh}
                  </td>
                  <td>{o.termsVersion}</td>
                  <td>{o.believedStatus ?? 'unknown'}</td>
                  <td>
                    {o.segment}.{o.segmentRound}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          Segment {state.world.negotiation.segment}: {state.world.negotiation.roundsUsed} of 2 negotiation rounds used.
        </p>
      </Section>

      {doc.suggestions.length > 0 ? (
        <Section title="Suggestions from the council">
          <ul className="plain">
            {doc.suggestions.map((s) => (
              <li key={s.id}>
                <strong lang="zh">{s.byName.zh}</strong> on v{s.targetVersion} (R{s.round}):{' '}
                {Object.entries(s.terms)
                  .filter(([, v]) => v !== null)
                  .map(([k, v]) => `${t(catalog.terms.find((e) => e.key === k)?.label ?? { zh: k, en: k }, lang)} ${termValue(k, v, catalog, lang)}`)
                  .join('; ') || '—'}
                <span className="hint"> — {s.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Your goal">
        <p lang={lang}>{t(state.world.goal.text, lang)}</p>
        <p className="hint">{limitsSummary(state.world.goal.limits, catalog, lang)}</p>
        {state.world.authorizations.length > 0 ? (
          <ul className="plain">
            {state.world.authorizations.map((a) => (
              <li key={a.id}>
                <Badge tone={a.revoked ? 'muted' : 'ok'}>{a.id}</Badge> {a.granteeName.zh} may decide {a.categories.join(', ')} within {limitsSummary(a.limits, catalog, lang)}
                {a.expiresRound !== null ? ` until round ${a.expiresRound}` : ''}{' '}
                {!a.revoked ? (
                  <button type="button" className="btn-small" disabled={!yourTurn || busy} onClick={() => void act({ type: 'revoke_authorization', args: { authId: a.id } })}>
                    Revoke
                  </button>
                ) : (
                  <span className="hint">revoked</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <details className="section">
        <summary>History and what you know</summary>
        <ul className="plain">
          {doc.history.map((h) => (
            <li key={h.version}>
              v{h.version} by {h.byName.zh} (R{h.round})
            </li>
          ))}
        </ul>
        <ul className="plain beliefs">
          {state.world.beliefs.map((b) => (
            <li key={b.id}>
              <span className="muted">
                {b.subject} · {b.predicate} · day {b.asOfDay} · {b.evidence.kind}
              </span>{' '}
              {beliefText(b.value, lang)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function termValue(key: string, v: unknown, catalog: StateView['catalog'], lang: Lang): string {
  if (typeof v === 'boolean') return v ? (lang === 'zh' ? '是' : 'yes') : lang === 'zh' ? '否' : 'no';
  if (typeof v === 'number') return fmt(v);
  const label = catalog.terms.find((e) => e.key === key)?.values.find((o) => o.value === v)?.label;
  return label ? t(label, lang) : String(v);
}

function beliefText(value: unknown, lang: Lang): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.zh === 'string' && typeof v.en === 'string') return lang === 'zh' ? v.zh : v.en;
    if (typeof v.status === 'string') return v.status;
    return JSON.stringify(value).slice(0, 160);
  }
  return String(value);
}
