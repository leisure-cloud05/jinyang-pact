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

export function StoryPanel({ sessionId, state, view, tick, lang, onLang, startNote }: { sessionId: string; state: StateView; view: ViewMode; tick: number; lang: Lang; onLang: (l: Lang) => void; startNote: { zh: string; en: string } | null }) {
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
            <span lang="zh">{w.locationName.zh}</span>
            <span className="scene-meta">
              {w.locationName.en} · day {w.day} · round {w.round}
            </span>
          </h2>
        </div>
        <div className="seg" role="group" aria-label="Narrative language">
          <button type="button" aria-pressed={lang === 'zh'} onClick={() => onLang('zh')}>
            中文
          </button>
          <button type="button" aria-pressed={lang === 'en'} onClick={() => onLang('en')}>
            English
          </button>
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
            <p className="ending-kicker">{lang === 'zh' ? '本章终' : 'End of the chapter'}</p>
            <p className="ending-title" lang={lang}>
              {t(TERMINAL_LABELS[w.terminal.kind] ?? { zh: w.terminal.kind, en: w.terminal.kind }, lang)}
            </p>
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
          {lang === 'zh' ? `第${item.round}回合 · 第${item.day}日` : `Round ${item.round} · day ${item.day}`}
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
          <span>{item.batchKind === 'player' ? (lang === 'zh' ? '你的行动' : 'Your actions') : item.batchKind === 'system_prepare' ? (lang === 'zh' ? '驿报' : 'Couriers') : item.batchKind === 'system_advance' ? (lang === 'zh' ? '时日' : 'Time passes') : lang === 'zh' ? '纪事' : 'Record'}</span>
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
          <span>{lang === 'zh' ? '实录' : 'What happened'}</span>
          {item.status !== 'ok' ? (
            <Badge tone="muted" title={`The model's prose was not shown (${item.fallbackReason ?? item.status}); a template narration is shown instead.`}>
              {item.status === 'failed' ? 'narration pending' : 'template narration'}
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
      {item.proseLang !== lang ? <p className="hint">Prose shown in the session language ({item.proseLang === 'zh' ? '中文' : 'English'}).</p> : null}
      {item.status === 'failed' ? (
        <button type="button" className="btn-small" disabled={busy === item.batchId} onClick={() => onRegenerate(item)}>
          {busy === item.batchId ? 'Regenerating…' : 'Regenerate narration'}
        </button>
      ) : null}
    </article>
  );
}
