/** New session, transmit confirmation and director-view unlock dialogs. */
import { useState } from 'react';
import type { Lang, ServerConfigView, StateView } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl } from '../api';
import { t } from '../labels';
import { TermsTable } from './terms';
import { Dialog, ErrorNote } from './ui';

export function NewSessionDialog({ config, onCreated, onCancel }: { config: ServerConfigView; onCreated: (id: string) => void; onCancel: (() => void) | null }) {
  const [caseId, setCaseId] = useState(config.configs.find((c) => c.id === 'C1')?.id ?? config.configs[0]?.id ?? 'FREE');
  const [mode, setMode] = useState('full');
  const [lang, setLang] = useState<Lang>(config.defaultLang);
  const [llm, setLlm] = useState<'mock' | 'live'>(config.liveAvailable ? 'live' : 'mock');
  const [script, setScript] = useState(false);
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
      const r = await postJson<{ sessionId: string }>('/api/sessions', { caseId, mode, lang, llm, script, director, wait: 5000 }, 'create');
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
              <strong>{lang === 'zh' ? '第一次来？先看一场帅府议事。' : 'New here? Start with a council scene.'}</strong>
              <p>{lang === 'zh' ? 'D1 会安排书记的示范台词；离线模拟角色回应，不花费模型费用。进入后点“结束回合”即可开始。' : 'D1 adds the clerk’s sample lines. Mock characters answer offline at no model cost. Begin, then end your turn.'}</p>
            </div>
            <button type="button" className="btn-secondary" onClick={() => { setCaseId('D1'); setMode('full'); setLang('zh'); setLlm('mock'); setScript(true); }}>
              {lang === 'zh' ? '选用离线示范' : 'Use offline demo'}
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
          <legend>Narrative language</legend>
          <label className="check">
            <input type="radio" name="lang" checked={lang === 'zh'} onChange={() => setLang('zh')} /> 中文
          </label>
          <label className="check">
            <input type="radio" name="lang" checked={lang === 'en'} onChange={() => setLang('en')} /> English
          </label>
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
        {chosen?.hasScript ? (
          <label className="check">
            <input type="checkbox" checked={script} onChange={(e) => setScript(e.target.checked)} /> Add the case’s scripted clerk lines at the end of each of your turns
          </label>
        ) : null}
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

export function TransmitDialog({ sessionId, state, lang, onDone, onCancel }: { sessionId: string; state: StateView; lang: Lang; onDone: (msg: string) => void; onCancel: () => void }) {
  const doc = state.document;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!doc) return null;
  const transmit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ outcomes: Array<{ status: string; rule: string | null; feedback: string | null }> }>(sessionUrl(sessionId, 'input'), {
        kind: 'action',
        turn: state.control.turn,
        action: { type: 'dispatch_document', args: { docId: doc.docId, docVersion: doc.version } },
      });
      const o = r.outcomes[0];
      if (o && o.status !== 'committed') setError(`${o.status}${o.rule ? ` (${o.rule})` : ''}: ${o.feedback ?? ''}`);
      else onDone('The envoy has left with the request.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Transmit the request?" onEscape={onCancel} tone="confirm">
      <p>
        You are about to send version {doc.version}, sealed by Shi Jingtang, to {doc.toName.zh} ({doc.toName.en}). This is your own decision (player-initiated): no pause follows, and a
        dispatched request cannot be recalled by you.
      </p>
      <TermsTable terms={doc.terms} catalog={state.catalog} lang={lang} compact />
      <ErrorNote error={error} />
      <div className="row dialog-actions">
        <button type="button" className="btn btn-transmit" disabled={busy} onClick={() => void transmit()} data-autofocus>
          Transmit now
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
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
