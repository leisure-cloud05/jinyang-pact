/**
 * Story: the chapter round by round. Deterministic fact headers (always correct, re-rendered in the chosen
 * language) are set apart from the narrator's prose; template/fallback prose is marked subtly; a narration still
 * pending can be regenerated from the committed events (never re-executing anything).
 */
import { useEffect, useRef, useState } from 'react';
import type { Lang, StateView, StoryItem, StoryView, ViewMode } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl, viewParam } from '../api';
import { useResource } from '../hooks';
import { TERMINAL_LABELS, t } from '../labels';
import { Badge, Empty, ErrorNote } from './ui';

export function StoryPanel({ sessionId, state, view, tick, lang, startNote }: { sessionId: string; state: StateView; view: ViewMode; tick: number; lang: Lang; startNote: { zh: string; en: string } | null }) {
  const story = useResource<StoryView>(sessionUrl(sessionId, 'narration', { view: viewParam(view), lang }), tick);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const count = story.data?.items.length ?? 0;
  useEffect(() => {
    // Follow the newest entry inside the story column (never scroll the page).
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [count]);

  const regenerate = async (item: Extract<StoryItem, { kind: 'narration' }>): Promise<void> => {
    setBusy(item.batchId);
    setError(null);
    try {
      await postJson(sessionUrl(sessionId, 'regenerate-narration'), { batchId: item.batchId, scene: item.scene });
      story.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const w = state.world;
  return (
    <section className="panel story" aria-labelledby="story-title">
      <div className="panel-head">
        <div>
          <h2 id="story-title" className="scene-title">
            <span>{w.locationName.en}</span>
            <span className="scene-meta">
              Day {w.day} · round {w.round}
            </span>
          </h2>
        </div>
      </div>
      <div ref={box} className="story-scroll" aria-live="polite">
        {startNote ? (
          <p className="start-note" lang={lang}>
            {t(startNote, lang)}
          </p>
        ) : null}
        <ErrorNote error={story.error ?? error} />
        {story.data && story.data.items.length === 0 ? <Empty>Nothing has happened yet.</Empty> : null}
        {story.data?.items.map((item, i) => <Item key={i} item={item} lang={lang} view={view} onRegenerate={regenerate} busy={busy} />)}
        {w.terminal ? (
          <div className="ending" role="status">
            <p className="ending-kicker">End of the chapter</p>
            <p className="ending-title" lang={lang}>
              {w.terminal.detail.cause === 'missed_opportunity'
                ? t({ zh: '错过时机 · 全面战争 · 晋阳城破', en: 'Opportunity missed · All-out war · Jinyang falls' }, lang)
                : t(TERMINAL_LABELS[w.terminal.kind] ?? { zh: w.terminal.kind, en: w.terminal.kind }, lang)}
            </p>
            {w.terminal.detail.cause === 'missed_opportunity' ? <p lang={lang}>{t({
              zh: '求援期限已尽，仍未达成有效盟约。后唐围城军发动全面攻城，晋阳失守。这是错过求援时机的结局，无须等到粮尽或围城压力达到 100。',
              en: 'The deadline passed without an effective pact securing relief. The Later Tang besiegers launched a full assault and took Jinyang. Missing the diplomatic window triggers this ending before grain runs out or siege pressure reaches 100.',
            }, lang)}</p> : null}
            <p className="ending-meta">
              Day {w.terminal.day}, round {w.terminal.round} · outcome {state.control.outcome ?? '—'}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Item({ item, lang, view, onRegenerate, busy }: { item: StoryItem; lang: Lang; view: ViewMode; onRegenerate: (i: Extract<StoryItem, { kind: 'narration' }>) => void; busy: string | null }) {
  if (item.kind === 'round') {
    return (
      <h3 className="round-divider">
        <span>
          Round {item.round} · day {item.day}
        </span>
      </h3>
    );
  }
  const where = view === 'director' ? <span className="where">{t(item.sceneName, lang)}</span> : null;
  if (item.kind === 'facts') {
    return (
      <div className={`facts ${item.inherited ? 'inherited' : ''}`}>
        <div className="facts-label">
          {where}
          <span>{item.batchKind === 'player' ? 'Your actions' : item.batchKind === 'system_prepare' ? 'Couriers' : item.batchKind === 'system_advance' ? 'Time passes' : 'Record'}</span>
        </div>
        <ul lang={lang}>
          {item.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <article className={`narration ${item.inherited ? 'inherited' : ''}`}>
      <div className="fact-header" aria-label="Fact header (deterministic)">
        <div className="facts-label">
          {where}
          <span>What happened</span>
          {item.status !== 'ok' ? (
            <Badge tone="muted" title={item.fallbackReason === 'language_mismatch' ? 'The recorded prose uses a different language. A template is shown in the selected language; the original record is preserved.' : `The model's prose was not shown (${item.fallbackReason ?? item.status}); a template narration is shown instead.`}>
              {item.status === 'failed' ? 'narration pending' : item.fallbackReason === 'language_mismatch' ? 'language fallback' : 'template narration'}
            </Badge>
          ) : null}
        </div>
        <ul lang={lang}>
          {item.headerLines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
      <p className="prose" lang={item.proseLang}>
        {item.prose}
      </p>
      {item.proseLang !== lang ? <p className="hint">This narration was recorded in {item.proseLang === 'zh' ? 'Chinese' : 'English'}.</p> : null}
      {item.status === 'failed' ? (
        <button type="button" className="btn-small" disabled={busy === item.batchId} onClick={() => onRegenerate(item)}>
          {busy === item.batchId ? 'Regenerating…' : 'Regenerate narration'}
        </button>
      ) : null}
    </article>
  );
}
