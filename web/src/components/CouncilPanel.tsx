/**
 * Council: who is with you at headquarters, the talk box (speech to present characters, or a free-text command the
 * mapper turns into an action / dialogue / clarification), the dialogue log, and interrupts.
 */
import { useEffect, useRef, useState } from 'react';
import type { DialogueView, InputResult, Lang, StateView, ViewMode } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl, viewParam } from '../api';
import { useResource } from '../hooks';
import { t } from '../labels';
import { Badge, ErrorNote, Section } from './ui';

export function CouncilPanel({
  sessionId,
  state,
  view,
  tick,
  lang,
  onChanged,
  onConfirmTransmit,
}: {
  sessionId: string;
  state: StateView;
  view: ViewMode;
  tick: number;
  lang: Lang;
  onChanged: () => void;
  onConfirmTransmit: (action: { type: string; args: Record<string, unknown> }) => void;
}) {
  const present = state.characters.filter((c) => c.present);
  const away = state.characters.filter((c) => !c.present);
  const [to, setTo] = useState<string[]>(present.map((c) => c.id));
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'speak' | 'command'>('speak');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const dialogue = useResource<DialogueView>(sessionUrl(sessionId, 'dialogue', { view: viewParam(view) }), tick);
  const log = useRef<HTMLOListElement>(null);
  const yourTurn = state.control.state === 'awaiting_player';
  const canInterrupt = state.control.state === 'running' || state.control.state === 'awaiting_decision' || yourTurn;
  const rows = dialogue.data?.rows ?? [];
  useEffect(() => {
    // Scroll the log itself (never the page) to the newest line.
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [rows.length]);

  const send = async (): Promise<void> => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (mode === 'speak') {
        if (to.length === 0) throw new Error('Choose at least one listener.');
        await postJson<InputResult>(sessionUrl(sessionId, 'input'), { kind: 'dialogue', turn: state.control.turn, to, text: text.trim() });
        setText('');
      } else {
        const r = await postJson<InputResult>(sessionUrl(sessionId, 'input'), { kind: 'text', turn: state.control.turn, text: text.trim() });
        const m = r.mapped;
        if (m?.confirmRequired && m.action) {
          onConfirmTransmit(m.action);
          setNote('Understood as: transmit the request. Please confirm.');
        } else if (m?.kind === 'action' && r.outcomes[0]) {
          const o = r.outcomes[0];
          setNote(`Understood as ${o.type}: ${o.status}${o.rule ? ` (${o.rule})` : ''}${o.feedback ? ` — ${o.feedback}` : ''}`);
        } else if (m?.kind === 'dialogue') {
          setNote('Understood as speech to the council.');
        } else if (m?.kind === 'clarify') {
          setNote(`Clarification: ${m.question ?? 'please say more precisely what you want.'}`);
        } else if (m?.kind === 'unsupported') {
          setNote(`Not possible: ${m.reason ?? 'the clerk cannot do that.'}`);
        } else {
          setNote('The command could not be interpreted.');
        }
        if (m?.kind === 'action' || m?.kind === 'dialogue') setText('');
      }
      onChanged();
    } catch (err) {
      setError(errorText(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const interrupt = async (): Promise<void> => {
    if (!instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ accepted: boolean; queued: boolean }>(sessionUrl(sessionId, 'interrupt'), { text: instruction.trim(), wait: 1500 });
      setNote(r.accepted ? 'Interrupted: the round restarts with your instruction.' : 'Queued: your instruction reaches the council at your next turn.');
      setInstruction('');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel council" aria-labelledby="council-title">
      <div className="panel-head">
        <h2 id="council-title">Council</h2>
      </div>
      <ul className="cast" aria-label="Present at headquarters">
        {present.map((c) => (
          <li key={c.id} className="person">
            <span className="person-name">
              {c.name.en}
            </span>
            <span className="person-title">{t(c.title, lang)}</span>
            {c.status !== 'alive' ? <Badge tone="bad">{c.status}</Badge> : null}
          </li>
        ))}
      </ul>
      <p className="away">
        Elsewhere:{' '}
        {away.map((c, i) => (
          <span key={c.id}>
            {i > 0 ? '; ' : ''}
            {c.name.en} ({t(c.locationName, lang)})
          </span>
        ))}
      </p>

      <Section title="Speak">
        <div className="seg" role="group" aria-label="Input mode">
          <button type="button" aria-pressed={mode === 'speak'} onClick={() => setMode('speak')}>
            Speak to…
          </button>
          <button type="button" aria-pressed={mode === 'command'} onClick={() => setMode('command')}>
            Free-text command
          </button>
        </div>
        {mode === 'speak' ? (
          <fieldset className="listeners">
            <legend className="sr-only">Listeners</legend>
            {present.map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" checked={to.includes(c.id)} onChange={(e) => setTo(e.target.checked ? [...to, c.id] : to.filter((x) => x !== c.id))} /> {c.name.en}
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="hint">The mapper turns what you write into an action on the draft, speech, or a clarifying question. You can never consent for anyone.</p>
        )}
        <label htmlFor="talk" className="sr-only">
          Your words
        </label>
        <textarea
          id="talk"
          rows={3}
          value={text}
          disabled={!yourTurn || busy}
          placeholder={yourTurn ? (mode === 'speak' ? 'My lord, the draft is ready for your review…' : 'e.g. Reduce the annual silk tribute / delay the dispatch') : 'You can speak during your turn.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <div className="row">
          <button type="button" className="btn" disabled={!yourTurn || busy || !text.trim()} onClick={() => void send()}>
            {mode === 'speak' ? 'Say' : 'Interpret & apply'}
          </button>
          <span className="hint">Ctrl+Enter</span>
        </div>
        {note ? (
          <p className="note" role="status">
            {note}
          </p>
        ) : null}
        <ErrorNote error={error} />
      </Section>

      {canInterrupt ? (
        <Section title="Interrupt">
          <label htmlFor="instr" className="hint">
            {yourTurn ? 'Queued for this turn.' : 'Stops the current deliberation; the round restarts with your instruction.'}
          </label>
          <div className="row">
            <input id="instr" type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Wait—consider this first…" />
            <button type="button" className="btn-secondary" disabled={busy || !instruction.trim()} onClick={() => void interrupt()}>
              Interrupt
            </button>
          </div>
        </Section>
      ) : null}

      <Section title={view === 'director' ? 'Dialogue (all scenes)' : 'Dialogue you heard'}>
        <ol ref={log} className="dialogue" aria-live="polite">
          {rows.map((r) => (
            <li key={r.seq} className={`line line-${r.kind} ${r.speaker === 'player' ? 'mine' : ''}`}>
              <div className="line-head">
                <span className="speaker">
                  {r.speakerName.en}
                </span>
                {r.kind !== 'speech' ? <Badge tone={r.kind === 'advice' ? 'warn' : 'info'}>{r.kind}</Badge> : null}
                <span className="to">→ {r.listenerNames.map((n) => n.en).join(', ')}</span>
                <span className="round-tag">R{r.round}</span>
              </div>
              <p className="line-text">{r.text}</p>
            </li>
          ))}
        </ol>
      </Section>
    </section>
  );
}
