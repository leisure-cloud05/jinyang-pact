/**
 * The Jinyang Pact — play UI. Player's vantage by default (the clerk at Jinyang headquarters); the director view is
 * locked until the chapter ends or is explicitly unlocked, and clearly labelled when on.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Lang, ServerConfigView, SessionListItem, StateView, ViewMode } from '../../src/server/api-types';
import { errorText, getJson, postJson, sessionUrl } from './api';
import { CouncilPanel } from './components/CouncilPanel';
import { DecisionModal } from './components/DecisionModal';
import { DirectorDialog, NewSessionDialog, TransmitDialog } from './components/dialogs';
import { DraftPanel } from './components/DraftPanel';
import { EndingPlayer, endingPlayed, markEndingPlayed, preloadEndingArt } from './components/EndingPlayer';
import { InspectorPanel } from './components/InspectorPanel';
import { SiegeWatch, topAlert } from './components/SiegeWatch';
import { StoryPanel } from './components/StoryPanel';
import { TimelinePanel } from './components/TimelinePanel';
import { Badge, ErrorNote, Tabs } from './components/ui';
import { UsagePanel } from './components/UsagePanel';
import { endingFacts, isEndingKind } from './ending';
import { useLiveSession, usePref } from './hooks';
import { CATEGORY_LABELS, CONTROL_LABELS, TERMINAL_LABELS, t } from './labels';

type Area = 'play' | 'inspector' | 'timeline' | 'usage';

function sessionFromHash(): string | null {
  const m = /^#\/s\/(.+)$/.exec(window.location.hash);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export function App() {
  const [config, setConfig] = useState<ServerConfigView | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(sessionFromHash());
  const [area, setArea] = useState<Area>('play');
  const [view, setView] = useState<ViewMode>('player');
  const [theme, setTheme] = usePref<'auto' | 'light' | 'dark'>('theme', 'auto');
  const [showNew, setShowNew] = useState(false);
  const [modalHidden, setModalHidden] = useState(false);
  const [transmit, setTransmit] = useState(false);
  const [askDirector, setAskDirector] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showEnding, setShowEnding] = useState(false);
  const [reviewPact, setReviewPact] = useState(false);
  const live = useLiveSession(sessionId, view);
  const s = live.state;
  const lang: Lang = 'en';
  const terminalKind = s?.world.terminal?.kind ?? null;
  const endingKind = terminalKind !== null && isEndingKind(terminalKind) ? terminalKind : null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => preloadEndingArt(), []);

  // The ending CG plays by itself the first time this viewer sees the chapter end; a reload does not replay it.
  useEffect(() => {
    if (!sessionId || !endingKind || s?.session.sessionId !== sessionId || s.control.state !== 'finished') return;
    if (endingPlayed(sessionId, endingKind)) return;
    markEndingPlayed(sessionId, endingKind);
    setShowEnding(true);
  }, [sessionId, endingKind, s?.session.sessionId, s?.control.state]);

  // After the CG has closed (and handed focus back), bring the pact's letters into view.
  useEffect(() => {
    if (!reviewPact || showEnding) return;
    setReviewPact(false);
    document.getElementById('negotiation-title')?.scrollIntoView({ block: 'start' });
  }, [reviewPact, showEnding]);

  const loadSessions = useCallback(async () => {
    try {
      setSessions((await getJson<{ sessions: SessionListItem[] }>('/api/sessions')).sessions);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => {
    getJson<ServerConfigView>('/api/config')
      .then(setConfig)
      .catch((err: unknown) => setError(errorText(err)));
    void loadSessions();
    const onHash = (): void => setSessionId(sessionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [loadSessions]);

  const open = useCallback(
    (id: string) => {
      window.location.hash = `#/s/${encodeURIComponent(id)}`;
      setSessionId(id);
      setView('player');
      setModalHidden(false);
      setShowEnding(false);
      setArea('play');
      void loadSessions();
    },
    [loadSessions],
  );

  // A view the server refuses (locked director view) falls back to the player's view.
  useEffect(() => {
    if (view === 'director' && live.error?.includes('director_locked')) setView('player');
  }, [view, live.error]);

  useEffect(() => {
    if (s?.control.state === 'awaiting_decision') setModalHidden(false);
  }, [s?.control.pauseId, s?.control.state]);

  const advance = async (): Promise<void> => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      // Ending a turn names the turn (a stale click cannot end the next one); resuming needs no token.
      await postJson(sessionUrl(sessionId, 'advance'), { wait: 1500, turn: s?.control.turn ?? null,
        ...(s?.control.state === 'suspended' && s.control.suspendedReason?.toLowerCase().includes('budget')
          ? { extendBudget: { addCalls: 50, addUsd: s.session.llm === 'live' ? 0.25 : 0 } } : {}),
      });
      live.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleDirector = (): void => {
    if (view === 'director') {
      setView('player');
      return;
    }
    if (s?.session.directorAllowed) setView('director');
    else setAskDirector(true);
  };

  const reviewEnding = (): void => {
    setShowEnding(false);
    if (endingKind !== 'pact_concluded') {
      setArea('timeline');
      return;
    }
    setArea('play');
    setReviewPact(true);
  };

  const control = s?.control;
  const pause = s?.pendingPause ?? null;
  const needsNew = config !== null && !sessionId;
  const facts = s ? endingFacts(s) : null;

  return (
    <div className={`app ${view === 'director' ? 'is-director' : ''}`}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="seal" aria-hidden="true">
            JP
          </span>
          <div>
            <div className="brand-en">The Jinyang Pact</div>
          </div>
        </div>
        <div className="session-pick">
          <label htmlFor="session-select" className="sr-only">
            Session
          </label>
          <select id="session-select" value={sessionId ?? ''} onChange={(e) => (e.target.value ? open(e.target.value) : undefined)}>
            <option value="">Choose a session…</option>
            {sessions.map((x) => (
              <option key={x.sessionId} value={x.sessionId}>
                {x.caseId} · {x.mode} · {x.ended ? (x.terminal ?? x.outcome ?? 'ended') : `round ${x.round}`} · {x.sessionId}
              </option>
            ))}
          </select>
          <button type="button" className="btn-secondary" onClick={() => setShowNew(true)}>
            New session
          </button>
        </div>
        <div className="top-status">
          {control ? (
            <Badge tone={control.state === 'awaiting_player' || control.state === 'awaiting_decision' ? 'info' : control.state === 'error' ? 'bad' : control.state === 'finished' ? 'ok' : 'muted'}>
              {CONTROL_LABELS[control.state] ?? control.state}
            </Badge>
          ) : null}
          {s ? (
            <span className="muted">
              {s.session.caseId} · {s.session.mode} · {s.session.llm}
            </span>
          ) : null}
          <span className={`dot ${live.connected ? 'dot-on' : ''}`} title={live.connected ? 'Live updates connected' : 'Live updates disconnected'} aria-label={live.connected ? 'connected' : 'disconnected'} />
        </div>
        <div className="top-actions">
          {s ? (
            <button type="button" className={`btn-small ${view === 'director' ? 'btn-director' : ''}`} aria-pressed={view === 'director'} onClick={toggleDirector} title={s.session.directorAllowed ? 'Toggle the director view' : 'Locked until the chapter ends'}>
              {view === 'director' ? 'Director view: ON' : s.session.directorAllowed ? 'Director view' : 'Director view (locked)'}
            </button>
          ) : null}
          <label htmlFor="theme" className="sr-only">
            Theme
          </label>
          <select id="theme" value={theme} onChange={(e) => setTheme(e.target.value as 'auto' | 'light' | 'dark')}>
            <option value="auto">Auto theme</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>
      </header>

      {view === 'director' ? (
        <div className="director-banner" role="note">
          DIRECTOR VIEW — showing information the clerk cannot know (other courts, secret articles, private reasoning).
          {s?.session.directorUnlockedRound !== null && s?.session.directorUnlockedRound !== undefined ? ` Unlocked at round ${s.session.directorUnlockedRound}.` : ''}
        </div>
      ) : null}

      {s ? (
        <nav className="areas" aria-label="Areas">
          <Tabs
            label="Areas"
            value={area}
            onChange={setArea}
            tabs={[
              { id: 'play', label: 'Play' },
              { id: 'inspector', label: 'Inspector' },
              { id: 'timeline', label: 'Timeline' },
              { id: 'usage', label: 'Usage' },
            ]}
          />
        </nav>
      ) : null}

      <main id="main" className="main">
        <ErrorNote error={error ?? (live.error && !live.error.includes('director_locked') ? live.error : null)} />
        {banner ? (
          <p className="note" role="status">
            {banner}{' '}
            <button type="button" className="link" onClick={() => setBanner(null)}>
              dismiss
            </button>
          </p>
        ) : null}
        {!sessionId && config ? (
          <div className="welcome">
            <h1>{config.scenario.title.en}</h1>
            <p className="start-note">{config.scenario.startNote.en}</p>
          </div>
        ) : null}
        {s && sessionId ? (
          <>
            {area === 'play' ? (
              <>
              <PlayGuide state={s.control.state} />
              {/* Keyed by session: another session starts with fresh panels (no carried-over edits or echoes). */}
              <div className="play-grid" key={sessionId}>
                <div className="play-main">
                  <RoundFocus state={s} />
                  <StoryPanel sessionId={sessionId} state={s} view={view} tick={live.tick} lang={lang} startNote={config?.scenario.startNote ?? null} />
                  <ActionBar
                    state={s}
                    busy={busy}
                    onAdvance={() => void advance()}
                    onOpenDecision={() => setModalHidden(false)}
                    onReview={() => setArea('timeline')}
                    onWatchEnding={endingKind ? () => setShowEnding(true) : null}
                  />
                </div>
                <aside className="play-side" aria-label="Council and draft">
                  <SiegeWatch watch={s.siegeWatch} control={s.control} lang={lang} />
                  <CouncilPanel sessionId={sessionId} state={s} view={view} tick={live.tick} lang={lang} onChanged={live.refresh} onConfirmTransmit={() => setTransmit(true)} />
                  <DraftPanel sessionId={sessionId} state={s} lang={lang} onChanged={live.refresh} onTransmit={() => setTransmit(true)} />
                </aside>
              </div>
              </>
            ) : null}
            {area === 'inspector' ? <InspectorPanel sessionId={sessionId} state={s} view={view} tick={live.tick} lang={lang} /> : null}
            {area === 'timeline' ? <TimelinePanel sessionId={sessionId} view={view} tick={live.tick} lang={lang} sessions={sessions} onOpen={open} /> : null}
            {area === 'usage' ? <UsagePanel sessionId={sessionId} view={view} tick={live.tick} /> : null}
          </>
        ) : sessionId && !s && !live.error ? (
          <p className="hint">Loading the session…</p>
        ) : null}
      </main>

      {showEnding && endingKind && facts ? <EndingPlayer kind={endingKind} facts={facts} onClose={() => setShowEnding(false)} onReview={reviewEnding} /> : null}
      {s && sessionId && pause && control?.state === 'awaiting_decision' && !modalHidden ? (
        <DecisionModal key={pause.id} sessionId={sessionId} state={s} pause={pause} lang={lang} onHide={() => setModalHidden(true)} onDone={live.refresh} />
      ) : null}
      {transmit && s && sessionId ? (
        <TransmitDialog
          sessionId={sessionId}
          state={s}
          lang={lang}
          onCancel={() => setTransmit(false)}
          onDone={(msg) => {
            setTransmit(false);
            setBanner(msg);
            live.refresh();
          }}
        />
      ) : null}
      {askDirector && sessionId ? (
        <DirectorDialog
          sessionId={sessionId}
          onCancel={() => setAskDirector(false)}
          onDone={() => {
            setAskDirector(false);
            setView('director');
            live.refresh();
          }}
        />
      ) : null}
      {config && (showNew || needsNew) ? <NewSessionDialog config={config} onCreated={(id) => { setShowNew(false); open(id); }} onCancel={needsNew && sessions.length === 0 ? null : () => setShowNew(false)} /> : null}
    </div>
  );
}

function PlayGuide({ state }: { state: string }) {
  const active = state === 'awaiting_decision' ? 3 : state === 'awaiting_player' ? 2 : 1;
  return (
    <section className="play-guide" aria-label="How to play">
      <div className="guide-intro">
        <span className="guide-kicker">JINYANG · THE CLERK’S VIEW</span>
        <h1>You write. They decide.</h1>
        <p>Speak to those present, review the draft, then let the council deliberate. You cannot promise on anyone’s behalf.</p>
      </div>
      <ol className="guide-steps">
        <li className={active === 1 ? 'guide-active' : ''}><span>01</span><strong>Read</strong><small>Story at left</small></li>
        <li className={active === 2 ? 'guide-active' : ''}><span>02</span><strong>Speak or edit</strong><small>Council and draft</small></li>
        <li className={active === 3 ? 'guide-active' : ''}><span>03</span><strong>Respond</strong><small>End turn; decide if asked</small></li>
      </ol>
    </section>
  );
}

const ROUND_FOCUS = [
  'Read the siege outlook and your goal. Decide what you want to discuss with the council.',
  'Compare the council’s suggestions with the draft. Which terms support your goal?',
  'Check whether any message has been sent and what remains only a draft.',
  'Check the road for replies and consider the time a new message would take.',
  'Recheck resources, consent and open decisions before time runs short.',
] as const;

function RoundFocus({ state }: { state: StateView }) {
  if (state.control.state !== 'awaiting_player') return null;
  const { round, maxRounds } = state.siegeWatch;
  const focus = round >= maxRounds
    ? 'This is the last round. Prioritize a concrete choice before ending your turn.'
    : ROUND_FOCUS[Math.min(round - 1, ROUND_FOCUS.length - 1)] ?? ROUND_FOCUS[0];
  const latest = state.negotiationTrack.cards.at(-1);
  let next = 'You can speak to the council before changing the draft; only the characters can make their own commitments.';
  if (latest?.stage === 'received' || latest?.stage === 'countered') {
    next = 'A reply is known. Compare it with your goal before deciding whether to respond.';
  } else if (latest?.stage === 'proposed' || latest?.stage === 'awaiting') {
    next = 'A message is still on the road. Check the negotiation track before expecting a reply.';
  } else if (state.document?.transmit.ok) {
    next = 'The current draft can be sent. Check its terms and timing before choosing whether to transmit it.';
  } else if (state.document) {
    next = 'Review the draft and any objections; you can revise it, seek approval or leave it unsent.';
  }
  return (
    <section className="round-focus" aria-label={`Round ${round} guidance`}>
      <h2>Round {round} of {maxRounds} · What to focus on</h2>
      <ul>
        <li>{focus}</li>
        <li>{next}</li>
      </ul>
      <p>Suggestions only — you decide what to do this round.</p>
    </section>
  );
}

function ActionBar({
  state,
  busy,
  onAdvance,
  onOpenDecision,
  onReview,
  onWatchEnding,
}: {
  state: NonNullable<ReturnType<typeof useLiveSession>['state']>;
  busy: boolean;
  onAdvance: () => void;
  onOpenDecision: () => void;
  onReview: () => void;
  onWatchEnding: (() => void) | null;
}) {
  const c = state.control;
  const watch = state.siegeWatch;
  const alert = topAlert(watch);
  let body;
  switch (c.state) {
    case 'awaiting_player':
      body = (
        <>
          <p>
            <strong>Your turn.</strong> Speak to the council, revise the draft or set its timing — then let the council deliberate.
            {watch.next ? (
              <span className="time-cost">
                {' '}
                Ending the turn spends time: after the council has spoken, {watch.roundDays} days pass (day {watch.day} → {watch.next.day}).
              </span>
            ) : null}
          </p>
          <button type="button" className="btn" disabled={busy} onClick={onAdvance}>
            End turn →
          </button>
        </>
      );
      break;
    case 'awaiting_decision':
      body = (
        <>
          <p>
            <strong>A decision is needed:</strong> {state.pendingPause ? (CATEGORY_LABELS[state.pendingPause.category] ?? state.pendingPause.category) : ''}
          </p>
          <button type="button" className="btn" onClick={onOpenDecision}>
            Open the decision
          </button>
        </>
      );
      break;
    case 'running':
    case 'starting':
      body = (
        <p className="working" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> The council deliberates (conversation step {Math.min(c.interactionStep + 1, c.interactionStepLimit)} / {c.interactionStepLimit}){c.lastStep ? ` · ${c.lastStep}` : ''}…
        </p>
      );
      break;
    case 'suspended':
      body = (
        <>
          <p>
            <strong>Suspended:</strong> {c.suspendedReason ?? 'a limit was reached'}. The open batch and pauses are kept.
          </p>
          <button type="button" className="btn" disabled={busy} onClick={onAdvance}>
            {c.suspendedReason?.toLowerCase().includes('budget') ? 'Add 50 calls (up to $0.25) and resume' : 'Resume'}
          </button>
        </>
      );
      break;
    case 'finished':
      body = (
        <>
          <p>
            <strong>{state.world.terminal ? t(TERMINAL_LABELS[state.world.terminal.kind] ?? { zh: state.world.terminal.kind, en: state.world.terminal.kind }, 'en') : 'The chapter has ended.'}</strong> Review the rounds, branch from a round start, or compare branches.
          </p>
          <button type="button" className="btn-secondary" onClick={onReview}>
            Review the timeline
          </button>
          {onWatchEnding ? (
            <button type="button" className="btn-secondary" onClick={onWatchEnding}>
              Watch the ending
            </button>
          ) : null}
        </>
      );
      break;
    default:
      body = (
        <p>
          <strong>{CONTROL_LABELS[c.state] ?? c.state}</strong> {c.error ?? c.outcome ?? ''}
        </p>
      );
  }
  return (
    <div className={`action-bar state-${c.state}`} role="region" aria-label="What happens next">
      {body}
      {alert && c.state !== 'finished' ? (
        <p className={`bar-alert bar-alert-${alert.level}`}>
          <strong>{alert.level === 'critical' ? 'City in danger:' : 'Warning:'}</strong> {alert.text.en}
        </p>
      ) : null}
    </div>
  );
}
