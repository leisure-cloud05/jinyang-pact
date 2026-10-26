/**
 * Decision modal (PLAN §7): the facts visible to the clerk, the question, and only this pause's options, with the
 * inputs each option needs (advice, counter-terms, the amended draft, delegation scope and limits, new goal limits).
 * It can be hidden to re-read the story; the engine keeps waiting.
 */
import { useMemo, useState } from 'react';
import type { Lang, PauseView, StateView, TermLimitsView } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl } from '../api';
import { ACTION_LABELS, CATEGORY_LABELS, OPTION_LABELS, PAUSE_KIND_LABELS, t } from '../labels';
import { LimitsEditor, TermsEditor, TermsTable, toDraft, type TermsDraft } from './terms';
import { Badge, Dialog, ErrorNote } from './ui';

export function DecisionModal({ sessionId, state, pause, lang, onHide, onDone }: { sessionId: string; state: StateView; pause: PauseView; lang: Lang; onHide: () => void; onDone: () => void }) {
  const catalog = state.catalog;
  const doc = state.document;
  const firstTerms = pause.proposals.find((p) => p.terms)?.terms ?? doc?.terms ?? null;
  const [option, setOption] = useState<string>(pause.options.includes('endorse') ? 'endorse' : (pause.options.find((o) => o !== 'ask') ?? pause.options[0] ?? 'endorse'));
  const [advice, setAdvice] = useState('');
  const [counter, setCounter] = useState<TermsDraft | null>(firstTerms ? toDraft(firstTerms) : null);
  const [amend, setAmend] = useState<TermsDraft | null>(doc ? toDraft(doc.terms) : null);
  const [amendNote, setAmendNote] = useState(doc?.note ?? '');
  const grantees = useMemo(() => [...new Set(pause.proposals.map((p) => p.actor).filter((a) => a !== 'player' && a !== 'system'))], [pause.proposals]);
  const [grantee, setGrantee] = useState(grantees[0] ?? '');
  const [categories, setCategories] = useState<string[]>([pause.category]);
  const [limits, setLimits] = useState<TermLimitsView>({ ...state.world.goal.limits });
  const [expires, setExpires] = useState<string>('');
  const [goal, setGoal] = useState<TermLimitsView>({ ...state.world.goal.limits });
  const [askTo, setAskTo] = useState<string>(pause.askable[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await postJson(sessionUrl(sessionId, 'decision'), { pauseId: pause.id, wait: 1500, ...body });
      if (body.option === 'ask') setAdvice('');
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = (): Promise<void> => {
    const body: Record<string, unknown> = { option };
    if (advice.trim()) body.advice = advice.trim();
    if (option === 'ask' && !advice.trim()) {
      setError('Write your question first.');
      return Promise.resolve();
    }
    if (option === 'ask' && askTo) body.to = askTo;
    if (option === 'counter_draft' && counter) body.counterTerms = counter;
    if (option === 'amend') {
      if (!amend || !doc) {
        setError('There is no draft to amend.');
        return Promise.resolve();
      }
      body.amend = { docId: doc.docId, baseDocVersion: '$current', terms: amend, note: amendNote };
    }
    if (option === 'delegate' && grantee) {
      body.authorization = { grantee, categories, limits, expiresRound: expires === '' ? null : Number(expires) };
    }
    if (option === 'adjust_goal') body.goalLimits = goal;
    return submit(body);
  };

  const s = pause.suggestion;
  const useSuggestion = (): Promise<void> => {
    if (!s) return Promise.resolve();
    const body: Record<string, unknown> = { option: s.option };
    if (s.advice !== null) body.advice = s.advice;
    if (s.authorization !== null) body.authorization = s.authorization;
    if (s.goalLimits !== null) body.goalLimits = s.goalLimits;
    if (s.counterTerms !== null) body.counterTerms = s.counterTerms;
    if (s.amend !== null) body.amend = s.amend;
    return submit(body);
  };

  const needsAdvice = ['withhold', 'counter_draft', 'urge_payment', 'urge_accept', 'urge_stop', 'adjust_goal', 'ask', 'delegate'].includes(option);

  return (
    <Dialog
      wide
      tone="decision"
      onEscape={onHide}
      title={
        <>
          <span className="kicker">Decision needed · {PAUSE_KIND_LABELS[pause.kind] ?? pause.kind}</span>
          {CATEGORY_LABELS[pause.category] ?? pause.category}
        </>
      }
    >
      <p className="question" lang={lang}>
        {t(pause.question, lang)}
      </p>
      <div className="decision-body">
        <div>
          <h3 className="small-head">What you can see</h3>
          <ul className="facts-list" lang={lang}>
            {pause.visibleFacts.map((f, i) => (
              <li key={i}>{t(f, lang)}</li>
            ))}
          </ul>
          {pause.proposals.map((p) => (
            <div key={p.proposalId} className="proposal-card">
              <div className="row">
                <strong>{p.actorName.en}</strong>
                <span className="muted">{ACTION_LABELS[p.type] ?? p.type.replaceAll('_', ' ')}</span>
              </div>
              <p lang={lang}>{t(p.summary, lang)}</p>
              {p.terms ? <TermsTable terms={p.terms} catalog={catalog} lang={lang} compact /> : null}
            </div>
          ))}
          <div className="row">
            {pause.withinLimits === true ? <Badge tone="ok">within your goal</Badge> : pause.withinLimits === false ? <Badge tone="bad">beyond your goal (or terms you cannot see)</Badge> : null}
            {pause.asked > 0 ? <Badge tone="info">asked {pause.asked}×</Badge> : null}
          </div>
          {pause.thread.length > 0 ? (
            <div className="ask-thread">
              <h3 className="small-head">Your questions</h3>
              {pause.thread.map((q, i) => (
                <div key={i} className="ask-entry">
                  <p lang={lang}>
                    <span className="muted">You: </span>
                    {q.question}
                  </p>
                  {q.answer !== null ? (
                    <p lang={lang}>
                      <strong>{q.answeredBy ? t(q.answeredBy, lang) : ''}</strong>
                      {q.outcome && q.outcome !== 'answered' ? <Badge tone="info">{q.outcome}</Badge> : null} {q.answer}
                    </p>
                  ) : (
                    <p className="muted">Waiting for an answer…</p>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div>
          <fieldset className="options">
            <legend className="small-head">Your options</legend>
            {pause.options.map((o) => (
              <label key={o} className={`option ${option === o ? 'option-active' : ''}`}>
                <input type="radio" name="option" value={o} checked={option === o} onChange={() => setOption(o)} data-autofocus={option === o ? true : undefined} />
                <span>
                  <strong>{OPTION_LABELS[o]?.label ?? o}</strong>
                  <span className="hint">{OPTION_LABELS[o]?.help ?? ''}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {option === 'ask' && pause.askable.length > 0 ? (
            <div className="field">
              <label htmlFor="ask-to">Ask</label>
              <select id="ask-to" value={askTo} onChange={(e) => setAskTo(e.target.value)}>
                {pause.askable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {t(c.name, lang)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {needsAdvice ? (
            <div className="field">
              <label htmlFor="advice">{option === 'ask' ? 'Your question' : 'Advice (optional)'}</label>
              <textarea id="advice" rows={2} value={advice} onChange={(e) => setAdvice(e.target.value)} />
            </div>
          ) : null}
          {option === 'counter_draft' && counter ? (
            <details open className="subform">
              <summary>Counter-terms (advice to Shi, non-binding)</summary>
              <TermsEditor value={counter} onChange={setCounter} catalog={catalog} lang={lang} />
            </details>
          ) : null}
          {option === 'amend' && amend ? (
            <details open className="subform">
              <summary>Amended draft (next version; approval is voided)</summary>
              <TermsEditor value={amend} onChange={setAmend} catalog={catalog} lang={lang} knownClauses={doc?.terms.secret_clauses ?? []} />
              <div className="field">
                <label htmlFor="amend-note">Note</label>
                <input id="amend-note" type="text" value={amendNote} onChange={(e) => setAmendNote(e.target.value)} />
              </div>
            </details>
          ) : null}
          {option === 'delegate' ? (
            <details open className="subform">
              <summary>Delegation scope and limits</summary>
              <div className="field">
                <label htmlFor="grantee">Grantee</label>
                <select id="grantee" value={grantee} onChange={(e) => setGrantee(e.target.value)}>
                  {grantees.map((g) => (
                    <option key={g} value={g}>
                      {state.characters.find((c) => c.id === g)?.name.en ?? g}
                    </option>
                  ))}
                </select>
              </div>
              <fieldset className="field-group">
                <legend>May decide without pausing</legend>
                {catalog.delegableCategories.map((c) => (
                  <label key={c} className="check">
                    <input type="checkbox" checked={categories.includes(c)} onChange={(e) => setCategories(e.target.checked ? [...categories, c] : categories.filter((x) => x !== c))} /> {CATEGORY_LABELS[c] ?? c}
                  </label>
                ))}
              </fieldset>
              <LimitsEditor value={limits} onChange={setLimits} catalog={catalog} lang={lang} />
              <div className="field">
                <label htmlFor="expires">Expires after round</label>
                <input id="expires" type="number" min={state.world.round} placeholder="never" value={expires} onChange={(e) => setExpires(e.target.value)} />
              </div>
            </details>
          ) : null}
          {option === 'adjust_goal' ? (
            <details open className="subform">
              <summary>New goal limits</summary>
              <LimitsEditor value={goal} onChange={setGoal} catalog={catalog} lang={lang} />
            </details>
          ) : null}
          <ErrorNote error={error} />
          <div className="row dialog-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void decide()}>
              {busy ? 'Deciding…' : `Decide: ${OPTION_LABELS[option]?.label ?? option}`}
            </button>
            {s ? (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void useSuggestion()} title={s.note ?? ''}>
                Use the case policy ({OPTION_LABELS[s.option]?.label ?? s.option})
              </button>
            ) : null}
            <button type="button" className="btn-ghost" onClick={onHide}>
              Hide to read the story
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
