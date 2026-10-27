/**
 * Draft: the request for assistance as the clerk sees it — terms (editable within the catalog ranges), version,
 * Shi Jingtang's approval (his seal is stamped on when it comes), dispatch timing, the negotiation track as far as
 * the clerk knows it, the council's suggestions, the goal and standing authorizations. "Transmit" is the player's
 * own decision (player-initiated: no pause), so it opens the dispatch ceremony for a last review first; the clerk's
 * seal (遣) then stays on the draft beside Shi's.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputResult, Lang, StateView } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl } from '../api';
import { DISPATCH_GLYPH } from '../dispatch';
import { useJustChanged } from '../hooks';
import { displayValue, englishDisplay, t, termValueText } from '../labels';
import { notePresentation, noteToSubmit } from '../note-editor';
import { draftGoalViolations } from '../burden';
import { BurdenMeter } from './BurdenMeter';
import { NegotiationTrack } from './NegotiationTrack';
import { TermsEditor, TermsTable, burdenOf, limitsSummary, toDraft, type TermsDraft } from './terms';
import { Badge, Dialog, Empty, ErrorNote, Section, Stamp } from './ui';

export function DraftPanel({ sessionId, state, lang, onChanged, onTransmit, editRequest }: { sessionId: string; state: StateView; lang: Lang; onChanged: () => void; onTransmit: () => void; editRequest: number }) {
  const doc = state.document;
  const catalog = state.catalog;
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState<TermsDraft | null>(doc ? toDraft(doc.terms) : null);
  const [note, setNote] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [timing, setTiming] = useState<{ mode: string; rounds: number }>({ mode: doc?.timing.mode ?? 'now', rounds: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const yourTurn = state.control.state === 'awaiting_player';
  const closeEditor = useCallback(() => { if (!busy) setEditing(false); }, [busy]);
  // Shi's seal is stamped down when his approval comes to cover the current version.
  const sealFresh = useJustChanged(doc?.approvedCurrent ? `${doc.docId}:${doc.approval?.version ?? doc.version}` : null);
  // The clerk's own seal stays on the draft as the record of a dispatch the player confirmed.
  const sentByYou = doc?.sent?.by === 'player' ? doc.sent : null;
  const dispatchFresh = useJustChanged(sentByYou ? `${doc?.docId}:${sentByYou.version}` : null);

  useEffect(() => {
    if (!editing && doc) {
      setDraft(toDraft(doc.terms));
      setNote(null);
    }
  }, [doc?.version, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const openEditor = (): void => {
    if (!doc) return;
    setDraft(toDraft(doc.terms));
    setEditVersion(doc.version);
    setNote(null);
    setReason('');
    setError(null);
    setResult(null);
    setEditing(true);
  };
  // "Back to edit" in the dispatch confirmation opens the editor on the current version.
  const editSeen = useRef(editRequest);
  useEffect(() => {
    if (editRequest === editSeen.current) return;
    editSeen.current = editRequest;
    openEditor();
  }, [editRequest]); // eslint-disable-line react-hooks/exhaustive-deps

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
    act({ type: 'revise_document', args: { docId: doc.docId, baseDocVersion: editVersion, terms: draft, note: noteToSubmit(note, doc.note) } }, () => setEditing(false));

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
  const draftBurden = burdenOf(draft as unknown as Record<string, unknown>, catalog, doc.terms.secret_clauses);
  const draftViolations = draftGoalViolations(draft as unknown as Record<string, unknown>, state.world.goal.limits, catalog, doc.terms.secret_clauses);
  const noteDisplay = notePresentation(doc.note, doc.terms, catalog, lang);
  const staleEdit = editing && editVersion !== doc.version;

  return (
    <section className="panel draft" aria-labelledby="draft-title">
      <div className="panel-head">
        <h2 id="draft-title" tabIndex={-1}>
          Request for assistance <span className="muted">→ {doc.toName.en}</span>
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
          {doc.approvedCurrent ? <Stamp glyph="印" fresh={sealFresh} /> : null}
          {sentByYou ? (
            <span className="seal-pair">
              <Badge tone="ok" title="You sent this version: your seal records the dispatch, not anyone's consent">
                sent by you · v{sentByYou.version} · day {sentByYou.day}
              </Badge>
              <Stamp glyph={DISPATCH_GLYPH} fresh={dispatchFresh} />
            </span>
          ) : null}
        </div>
      </div>

      {editing ? (
        <Dialog wide tone="parchment" dismissOnBackdrop onEscape={closeEditor} title={<><span className="kicker">{lang === 'zh' ? '议约 · 晋阳' : 'The Jinyang memorial'}</span>{lang === 'zh' ? '修订求援表章' : 'Revise the appeal for relief'}</>}>
          <button type="button" className="btn-ghost character-close" disabled={busy} onClick={closeEditor} aria-label={lang === 'zh' ? '关闭协议编辑' : 'Close treaty editor'}>×</button>
          <p className="parchment-subtitle">{lang === 'zh' ? `呈 ${t(doc.toName, lang)} · 原稿 v${editVersion}` : `To ${t(doc.toName, lang)} · From draft v${editVersion}`}</p>
          <div className="parchment-layout">
            <div className="editing">
              <fieldset className="parchment-fields" disabled={busy || !yourTurn || staleEdit || doc.status === 'sent'}>
                <TermsEditor value={draft} onChange={setDraft} catalog={catalog} lang={lang} knownClauses={doc.terms.secret_clauses} />
                <div className="field">
                  <label htmlFor="doc-note">Note</label>
                  <input id="doc-note" type="text" value={note ?? noteDisplay.text} onChange={(e) => setNote(e.target.value)} aria-describedby={noteDisplay.summarized ? 'doc-note-help' : undefined} />
                  {noteDisplay.summarized ? <p id="doc-note-help" className="hint">English summary of the recorded draft terms, not a translation of the original note. The original note is kept unless you edit this field.</p> : null}
                </div>
                <div className="field">
                  <label htmlFor="sug-reason">Reason (for a suggestion)</label>
                  <input id="sug-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reduce annual tribute to avoid future hardship" />
                </div>
              </fieldset>
              <p className="hint">Revising creates version {(editVersion ?? doc.version) + 1} and voids Shi’s approval; it never creates anyone’s consent. A suggestion is non-binding advice to the council.</p>
              {staleEdit ? <p className="error-note" role="alert">{lang === 'zh' ? '表章已更新。请关闭后重新打开，以最新版本继续修订。' : 'The draft has changed. Close and reopen the editor to work from its latest version.'}</p> : null}
              {!yourTurn ? <p className="hint">{lang === 'zh' ? '请等待你的回合再提交。' : 'Wait for your turn before submitting.'}</p> : null}
              <ErrorNote error={error} />
              {result ? <p className="note" role="status">{result}</p> : null}
              <div className="row">
                <button type="button" className="btn" disabled={busy || !yourTurn || staleEdit || doc.status === 'sent'} onClick={() => void revise()}>
                  {lang === 'zh' ? '修订' : 'Revise'} (v{(editVersion ?? doc.version) + 1})
                </button>
                <button type="button" className="btn-secondary" disabled={busy || !yourTurn || staleEdit || doc.status === 'sent'} onClick={() => void suggest()}>
                  {lang === 'zh' ? '仅向议事提出建议' : 'Suggest instead'}
                </button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={closeEditor}>
                  {lang === 'zh' ? '取消' : 'Cancel'}
                </button>
              </div>
            </div>
            <aside className="parchment-burden"><BurdenMeter preview terms={draft as unknown as Record<string, unknown>} catalog={catalog} goal={goalMax} total={draftBurden} violations={draftViolations} lang={lang} knownClauses={doc.terms.secret_clauses} /></aside>
          </div>
        </Dialog>
      ) : null}
      <TermsTable terms={doc.terms} catalog={catalog} lang={lang} />
      {doc.note ? <p className="doc-note">{noteDisplay.text}{noteDisplay.summarized ? <span className="hint"> (English terms summary; original note preserved.)</span> : null}</p> : null}
      <div className="row">
        <button type="button" className="btn-secondary" disabled={!yourTurn || doc.status === 'sent' || busy} onClick={openEditor}>
          {lang === 'zh' ? '展开表章 · 调整条款' : 'Unroll the treaty · Edit terms'}
        </button>
      </div>
      <BurdenMeter terms={doc.terms as unknown as Record<string, unknown>} catalog={catalog} goal={goalMax} total={doc.burden} violations={doc.withinGoal.violations} lang={lang} />

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

      <Section title="Negotiation as you know it" id="negotiation-title">
        <NegotiationTrack track={state.negotiationTrack} negotiation={state.world.negotiation} catalog={catalog} lang={lang} draft={doc} terminal={state.world.terminal} />
      </Section>

      {doc.suggestions.length > 0 ? (
        <Section title="Suggestions from the council">
          <ul className="plain">
            {doc.suggestions.map((s) => (
              <li key={s.id}>
                <strong>{s.byName.en}</strong> on v{s.targetVersion} (R{s.round}):{' '}
                {Object.entries(s.terms)
                  .filter(([, v]) => v !== null)
                  .map(([k, v]) => {
                    const term = catalog.terms.find((e) => e.key === k);
                    return `${t(term?.label ?? { zh: k, en: k }, lang)} ${termValueText(term, v, lang)}`;
                  })
                  .join('; ') || '—'}
                <span className="hint"> — {englishDisplay(s.reason)}</span>
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
                <Badge tone={a.revoked ? 'muted' : 'ok'}>{a.id}</Badge> {a.granteeName.en} may decide {a.categories.join(', ')} within {limitsSummary(a.limits, catalog, lang)}
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
              v{h.version} by {h.byName.en} (R{h.round})
            </li>
          ))}
        </ul>
        <ul className="plain beliefs">
          {state.world.beliefs.map((b) => (
            <li key={b.id}>
              <span className="muted">
                {b.subject} · {b.predicate} · day {b.asOfDay} · {b.evidence.kind}
              </span>{' '}
              {displayValue(b.value, lang)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
