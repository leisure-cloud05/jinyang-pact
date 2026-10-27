/**
 * Ending CG (结局演出): a short, silent sequence when the chapter ends — the map's last move, the illustration under a
 * slow camera, then the ending card with the title, one or two lines and the result summary. Skip shows the card at
 * once; with reduced motion the card shows straight away, without camera or shake. It shows only what the clerk knows
 * and never changes the game.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ENDING_ART, ENDING_TIMELINE, ENDINGS, endingKey, endingLines, endingSummary, type EndingFacts, type EndingKind } from '../ending';
import { EndingMap, EndingScene } from './EndingScenes';
import { useModalFocus } from './ui';

type Phase = 'map' | 'enter' | 'scene' | 'card';
const NEXT: Record<Exclude<Phase, 'card'>, Phase> = { map: 'enter', enter: 'scene', scene: 'card' };

/** Whether this viewer has already seen the ending of this session (browser storage, best effort). */
export function endingPlayed(sessionId: string, kind: string): boolean {
  try {
    return window.localStorage.getItem(endingKey(sessionId, kind)) === '1';
  } catch {
    return false;
  }
}

export function markEndingPlayed(sessionId: string, kind: string): void {
  try {
    window.localStorage.setItem(endingKey(sessionId, kind), '1');
  } catch {
    /* storage unavailable: the ending may play again after a reload */
  }
}

/** Starts loading the generated illustrations, so an ending never waits for its picture. */
export function preloadEndingArt(): void {
  for (const url of Object.values(ENDING_ART)) {
    const img = new Image();
    img.src = url;
  }
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function EndingPlayer({ kind, facts, onClose, onReview }: { kind: EndingKind; facts: EndingFacts; onClose: () => void; onReview: () => void }) {
  const spec = ENDINGS[kind];
  const [still] = useState(reducedMotion);
  const [run, setRun] = useState(0);
  const [phase, setPhase] = useState<Phase>(still ? 'card' : 'map');
  const [skipped, setSkipped] = useState(still);
  const [artFailed, setArtFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  // Escape closes; the handler stays stable while the page re-renders on live updates.
  const close = useRef(onClose);
  close.current = onClose;
  const escape = useCallback(() => close.current(), []);
  useModalFocus(ref, escape);

  useEffect(() => {
    if (phase === 'card') return;
    const timer = window.setTimeout(() => setPhase(NEXT[phase]), ENDING_TIMELINE[phase]);
    return () => window.clearTimeout(timer);
  }, [phase, run]);

  useEffect(() => {
    if (phase === 'card') firstAction.current?.focus();
  }, [phase]);

  const skip = (): void => {
    setSkipped(true);
    setPhase('card');
  };
  const replay = (): void => {
    setSkipped(false);
    setPhase('map');
    setRun((r) => r + 1);
  };
  const art = artFailed ? undefined : ENDING_ART[kind];

  return (
    <div className="cg-backdrop">
      <div
        ref={ref}
        className={`cg cg-${kind} camera-${spec.camera} phase-${phase} ${skipped ? 'is-skipped' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cg-title"
      >
        <div className="cg-frame">
          {/* Keyed by run: a replay restarts every animation from the first frame. */}
          <div key={run} className="cg-stage">
            <div className="cg-art">
              <div className="cg-quake">{art ? <img src={art} alt={spec.alt} onError={() => setArtFailed(true)} /> : <EndingScene kind={kind} />}</div>
              {/* The vector scenes get a painted finish: paper fibres and a colour grade. */}
              {art ? null : <div className="cg-paper" aria-hidden="true" />}
              {art ? null : <div className="cg-grade" aria-hidden="true" />}
              <div className="cg-vignette" aria-hidden="true" />
            </div>
            <EndingMap kind={kind} />
            <div className="cg-grain" aria-hidden="true" />
            <div className="cg-mount" aria-hidden="true" />
            {spec.epilogue ? <p className="cg-epilogue">{spec.epilogue}</p> : null}
          </div>
          {phase !== 'card' ? (
            <button type="button" className="cg-skip" onClick={skip}>
              Skip
            </button>
          ) : null}
          <div className="cg-caption">
            <p className="cg-kicker">Ending · Day {facts.terminal.day}</p>
            <h2 id="cg-title">{spec.title}</h2>
            <p>{endingLines(facts)}</p>
          </div>
        </div>
        <div className="cg-card">
          <dl className="cg-summary">
            {endingSummary(facts).map((r) => (
              <div key={r.label}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
          <div className="cg-actions">
            {still ? null : (
              <button ref={firstAction} type="button" className="btn-secondary" onClick={replay}>
                Replay ending
              </button>
            )}
            <button ref={still ? firstAction : undefined} type="button" className="btn" onClick={onReview}>
              {spec.review}
            </button>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
