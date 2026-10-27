/** New session and director-view unlock dialogs (the transmit confirmation is the dispatch ceremony). */
import { useState } from 'react';
import type { Lang, ServerConfigView } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl } from '../api';
import { t } from '../labels';
import { Dialog, ErrorNote } from './ui';

export function NewSessionDialog({ config, onCreated, onCancel }: { config: ServerConfigView; onCreated: (id: string) => void; onCancel: (() => void) | null }) {
  const [caseId, setCaseId] = useState(config.configs.find((c) => c.id === 'C1')?.id ?? config.configs[0]?.id ?? 'FREE');
  const [mode, setMode] = useState('full');
  const lang: Lang = 'en';
  const [llm, setLlm] = useState<'mock' | 'live'>(config.liveAvailable ? 'live' : 'mock');
  const [director, setDirector] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = config.configs.find((c) => c.id === caseId);
  const groups: Array<[string, string]> = [
    ['free', 'Free play'],
    ['case', 'Evaluation cases'],
    ['dev', 'Development configs'],
    ['pilot', 'Pilot variants'],
  ];
  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ sessionId: string }>('/api/sessions', { caseId, mode, lang, llm, script: false, director, wait: 5000 }, 'create');
      onCreated(r.sessionId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="New session" onEscape={onCancel ?? undefined}>
      <div className="form">
        {config.configs.some((c) => c.id === 'D1') ? (
          <div className="demo-callout">
            <div>
              <strong>New here? Start with a council scene.</strong>
              <p>Meet the council with offline mock characters at no model cost. Begin, then end your turn to hear them deliberate.</p>
            </div>
            <button type="button" className="btn-secondary" onClick={() => { setCaseId('D1'); setMode('full'); setLlm('mock'); }}>
              Use offline demo
            </button>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="ns-case">Configuration</label>
          <select id="ns-case" value={caseId} onChange={(e) => setCaseId(e.target.value)} data-autofocus>
            {groups.map(([kind, label]) => (
              <optgroup key={kind} label={label}>
                {config.configs
                  .filter((c) => c.kind === kind)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} — {c.title.en}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        {chosen ? (
          <p className="hint" lang={lang}>
            {t(chosen.description, lang)}
          </p>
        ) : null}
        <fieldset className="field-group">
          <legend>Mode</legend>
          {[
            ['full', 'Full (Harness + Judge)'],
            ['no_judge', 'No Judge (ablation)'],
            ['baseline', 'Baseline (prompt-only commit, separate database)'],
          ].map(([v, label]) => (
            <label key={v} className="check">
              <input type="radio" name="mode" value={v} checked={mode === v} onChange={() => setMode(v as string)} /> {label}
            </label>
          ))}
        </fieldset>
        <fieldset className="field-group">
          <legend>Model</legend>
          <label className="check">
            <input type="radio" name="llm" checked={llm === 'mock'} onChange={() => setLlm('mock')} /> Offline mock personas (no network)
          </label>
          <label className="check">
            <input type="radio" name="llm" checked={llm === 'live'} disabled={!config.liveAvailable} onChange={() => setLlm('live')} /> Live model (OpenRouter)
          </label>
          {!config.liveAvailable ? <p className="hint">{config.liveProblem}</p> : null}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={director} onChange={(e) => setDirector(e.target.checked)} /> Unlock the director view from the start (the session is labelled accordingly)
        </label>
        <ErrorNote error={error} />
        <div className="row dialog-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Begin'}
          </button>
          {onCancel ? (
            <button type="button" className="btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

export function DirectorDialog({ sessionId, onDone, onCancel }: { sessionId: string; onDone: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unlock = async (): Promise<void> => {
    setBusy(true);
    try {
      await postJson(sessionUrl(sessionId, 'director'), {});
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Unlock the director view?" onEscape={onCancel} tone="confirm">
      <p>
        The director view shows what your clerk cannot know: the other courts, secret articles, every character’s private reasoning and the full world state. It opens by itself when the
        chapter ends. Unlocking it now is recorded with this session (from this round on).
      </p>
      <ErrorNote error={error} />
      <div className="row dialog-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void unlock()}>
          Unlock and show
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel} data-autofocus>
          Keep the player’s view
        </button>
      </div>
    </Dialog>
  );
}
