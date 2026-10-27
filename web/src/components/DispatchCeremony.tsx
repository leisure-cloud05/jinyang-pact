/**
 * Dispatch ceremony (敲印): the clerk's final confirmation before the request goes out. The filled-in document unrolls
 * for review — the two parties, the version, every term (read only) and the burden it carries. "Confirm and seal"
 * locks the buttons and submits the dispatch; only once the server has committed it does the clerk's seal (遣) go
 * down, with a brief ember glow at its edges, stay a moment and the scroll roll up into the updated draft. A failure
 * keeps the document open with the reason, and a draft that changed must be reviewed again. With reduced motion the
 * seal and the result show at once. Shi Jingtang's approval is shown as his own: the clerk's seal never stands for it.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { InputResult, Lang, StateView } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl } from '../api';
import { DISPATCH_GLYPH, SEAL_TIMELINE, dispatchProblem } from '../dispatch';
import { t } from '../labels';
import { BurdenMeter } from './BurdenMeter';
import { TermsTable } from './terms';
import { ErrorNote, Stamp, useModalFocus } from './ui';

type Phase = 'review' | 'sealing' | 'sealed' | 'rolling';

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function DispatchCeremony({ sessionId, state, lang, onDone, onCancel, onEdit, onChanged }: {
  sessionId: string;
  state: StateView;
  lang: Lang;
  onDone: (msg: string) => void;
  onCancel: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const doc = state.document;
  const zh = lang === 'zh';
  const [still] = useState(reducedMotion);
  const [phase, setPhase] = useState<Phase>('review');
  // The version the player has reviewed; a draft that changes under them (or a stale dispatch) needs a fresh look.
  const [reviewed, setReviewed] = useState(doc?.version ?? 0);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sealed, setSealed] = useState<{ version: number; day: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const finishButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // The handlers stay stable while the page re-renders on live updates.
  const latest = useRef({ phase, sealed, onDone, onCancel });
  latest.current = { phase, sealed, onDone, onCancel };
  const finish = useCallback(() => {
    const v = latest.current.sealed?.version;
    latest.current.onDone(zh ? `使者已带着第 ${v} 版表章出发。` : `The envoy has left with version ${v} of the request.`);
  }, [zh]);
  // Escape closes while reviewing, finishes once sealed, and waits while the dispatch is in flight.
  const escape = useCallback(() => {
    const p = latest.current.phase;
    if (p === 'review') latest.current.onCancel();
    else if (p !== 'sealing') finish();
  }, [finish]);
  useModalFocus(ref, escape);

  useEffect(() => {
    if (phase !== 'sealed' && phase !== 'rolling') return;
    if (phase === 'sealed') {
      // The seal sits at the foot of the document: bring it into view there, leaving the page behind where it is.
      const box = slot.current?.closest<HTMLElement>('.parchment-content');
      if (box) box.scrollTop = box.scrollHeight;
      if (still) {
        finishButton.current?.focus();
        return;
      }
    }
    const timer = window.setTimeout(phase === 'sealed' ? () => setPhase('rolling') : finish, phase === 'sealed' ? SEAL_TIMELINE.stamp + SEAL_TIMELINE.hold : SEAL_TIMELINE.roll);
    return () => window.clearTimeout(timer);
  }, [phase, still, finish]);

  if (!doc) return null;

  const needsReview = phase === 'review' && (stale || doc.version !== reviewed);
  const blocked = phase === 'review' && !needsReview && !doc.transmit.ok;
  const near = state.negotiationTrack.near;
  const far = state.negotiationTrack.far;
  const approver = doc.approval ? state.characters.find((c) => c.id === doc.approval?.by)?.name ?? near.name : null;

  const seal = async (): Promise<void> => {
    setPhase('sealing');
    setError(null);
    try {
      const r = await postJson<InputResult>(sessionUrl(sessionId, 'input'), {
        kind: 'action',
        turn: state.control.turn,
        action: { type: 'dispatch_document', args: { docId: doc.docId, docVersion: reviewed } },
      });
      const o = r.outcomes[0];
      if (o?.status === 'committed') {
        setSealed({ version: reviewed, day: state.world.day });
        setPhase('sealed');
        onChanged();
        return;
      }
      const problem = o ? dispatchProblem(o, lang) : { text: zh ? '未能发出。' : 'It did not go out.', review: false };
      if (problem.review) {
        setStale(true);
        onChanged();
      }
      setError(problem.text);
      setPhase('review');
    } catch (err) {
      setError(errorText(err));
      setPhase('review');
    }
  };

  const reviewAgain = (): void => {
    setReviewed(doc.version);
    setStale(false);
    setError(null);
  };

  return (
    <div className={`backdrop seal-backdrop phase-${phase}`} onClick={(e) => { if (e.target === e.currentTarget && phase === 'review') onCancel(); }}>
      <div className={`parchment-shell seal-scroll phase-${phase}`}>
        <span className="seal-roller seal-roller-top" aria-hidden="true" />
        <div className="seal-sheet">
          <div ref={ref} className="dialog dialog-parchment seal-doc" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={phase === 'sealing'}>
            <div className="parchment-content" tabIndex={-1} data-autofocus>
              {phase === 'review' ? (
                <button type="button" className="btn-ghost character-close" onClick={onCancel} aria-label={zh ? '关闭，不发出' : 'Close without sending'}>
                  ×
                </button>
              ) : null}
              <h2 id={titleId} className="dialog-title">
                <span className="kicker">{zh ? '议约 · 晋阳' : 'The Jinyang memorial'}</span>
                {zh ? '确认发出' : 'Confirm dispatch'}
              </h2>
              <p className="parchment-subtitle">
                {zh
                  ? `自 ${t(near.name, lang)}（${t(near.place, lang)}）致 ${t(far.name, lang)}（${t(far.place, lang)}）· 第 ${doc.version} 版`
                  : `From ${t(near.name, lang)}, ${t(near.place, lang)}, to ${t(far.name, lang)}, ${t(far.place, lang)} · version ${doc.version}`}
              </p>
              <dl className="seal-facts">
                <div>
                  <dt>{zh ? '批准' : 'Approval'}</dt>
                  <dd>
                    {doc.approvedCurrent && approver ? (
                      <>
                        <Stamp glyph="印" /> {zh ? `${t(approver, lang)}已亲自批准第 ${doc.approval?.version} 版并用印。` : `${t(approver, lang)} approved version ${doc.approval?.version} in person and sealed it.`}
                      </>
                    ) : zh ? (
                      '这一版尚未得到批准，不能发出。'
                    ) : (
                      'This version is not approved, so it cannot go out.'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{zh ? '你的印' : 'Your seal'}</dt>
                  <dd>
                    {zh
                      ? '由你以书记之名，即刻发出这一版。此印只记发出，不代表任何人允约；信一出城，你便无法追回。'
                      : 'Sends this version now, in your name as the clerk. It records the dispatch and nobody’s consent, and once the letter leaves you cannot recall it.'}
                  </dd>
                </div>
                <div>
                  <dt>{zh ? '信使' : 'Courier'}</dt>
                  <dd>{zh ? `约 ${state.negotiationTrack.travelDays} 日可抵${t(far.place, lang)}。` : `About ${state.negotiationTrack.travelDays} days on the road to ${t(far.place, lang)}.`}</dd>
                </div>
              </dl>
              <TermsTable terms={doc.terms} catalog={state.catalog} lang={lang} compact />
              <BurdenMeter compact terms={doc.terms as unknown as Record<string, unknown>} catalog={state.catalog} goal={state.world.goal.limits.burden_max} total={doc.burden} violations={doc.withinGoal.violations} lang={lang} knownClauses={doc.terms.secret_clauses} />
              <div className="seal-foot">
                <div className="seal-foot-main">
                  <p className="seal-declaration" role="status">
                    {sealed
                      ? zh
                        ? `已发出 · 第 ${sealed.version} 版 · 第 ${sealed.day} 天`
                        : `Sent · version ${sealed.version} · day ${sealed.day}`
                      : needsReview || blocked
                        ? null
                        : zh
                          ? `落印之后，第 ${reviewed} 版即于今日（第 ${state.world.day} 天）发出。`
                          : `Once sealed, version ${reviewed} leaves Jinyang today (day ${state.world.day}).`}
                  </p>
                  {needsReview ? (
                    <p className="error-note" role="alert">
                      {doc.version !== reviewed
                        ? zh
                          ? `表章已改为第 ${doc.version} 版（你核对的是第 ${reviewed} 版）。请重新核对上面的条款，再行落印。`
                          : `The draft is now version ${doc.version} (you reviewed version ${reviewed}). Review the terms above again before you seal it.`
                        : zh
                          ? '表章已经改动。请重新核对上面的条款，再行落印。'
                          : 'The draft has changed. Review the terms above again before you seal it.'}
                    </p>
                  ) : null}
                  {blocked ? <p className="error-note" role="alert">{zh ? `现在不能发出：${doc.transmit.reason}` : `It cannot go out now: ${doc.transmit.reason}.`}</p> : null}
                  {needsReview ? null : <ErrorNote error={error} />}
                  {phase === 'review' || phase === 'sealing' ? (
                    <div className="row dialog-actions">
                      <button type="button" className="btn-secondary" disabled={phase === 'sealing'} onClick={onEdit}>
                        {zh ? '返回修改' : 'Back to edit'}
                      </button>
                      {needsReview ? (
                        <button type="button" className="btn" onClick={reviewAgain}>
                          {zh ? `已核对第 ${doc.version} 版` : `I have reviewed version ${doc.version}`}
                        </button>
                      ) : (
                        <button type="button" className="btn btn-seal" disabled={phase === 'sealing' || blocked} onClick={() => void seal()}>
                          {phase === 'sealing' ? (zh ? '落印中…' : 'Sealing…') : zh ? '确认落印' : 'Confirm and seal'}
                        </button>
                      )}
                    </div>
                  ) : still ? (
                    <div className="row dialog-actions">
                      <button ref={finishButton} type="button" className="btn" onClick={finish}>
                        {zh ? '完成' : 'Done'}
                      </button>
                    </div>
                  ) : null}
                </div>
                <div ref={slot} className="seal-slot" aria-hidden="true">
                  {sealed ? (
                    <span className="seal-mark">
                      <span className="seal-scorch" />
                      <span className="seal-fire" />
                      <b>{DISPATCH_GLYPH}</b>
                    </span>
                  ) : (
                    <span className="seal-place">{zh ? '落印处' : 'Seal here'}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        <span className="seal-roller seal-roller-bottom" aria-hidden="true" />
      </div>
    </div>
  );
}
