/**
 * Inspector: "agent proposes, harness disposes" made visible — committed events with the rules applied, each state
 * change (before → after) and the originating proposal; every proposal with its status, rule id and reason; the
 * state diff between two versions; patch / rederive replay.
 */
import { useState } from 'react';
import type { DiffView, EventsView, Lang, ProposalsView, ReplayView, StateView, ViewMode } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl, viewParam } from '../api';
import { useResource } from '../hooks';
import { STATUS_TONE, t } from '../labels';
import { Badge, Empty, ErrorNote, Tabs } from './ui';

type Sub = 'events' | 'proposals' | 'diff' | 'replay';

function short(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}…` : v;
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

export function InspectorPanel({ sessionId, state, view, tick, lang }: { sessionId: string; state: StateView; view: ViewMode; tick: number; lang: Lang }) {
  const [sub, setSub] = useState<Sub>('events');
  return (
    <section className="panel inspector" aria-labelledby="inspector-title">
      <div className="panel-head">
        <h2 id="inspector-title">Inspector</h2>
        <Tabs
          label="Inspector views"
          value={sub}
          onChange={setSub}
          tabs={[
            { id: 'events', label: 'Events' },
            { id: 'proposals', label: 'Proposals' },
            { id: 'diff', label: 'State diff' },
            { id: 'replay', label: 'Replay' },
          ]}
        />
      </div>
      {view === 'player' ? <p className="hint">Player view: only what the clerk can witness at headquarters. The director view shows every court.</p> : null}
      {sub === 'events' ? <Events sessionId={sessionId} view={view} tick={tick} lang={lang} /> : null}
      {sub === 'proposals' ? <Proposals sessionId={sessionId} view={view} tick={tick} lang={lang} /> : null}
      {sub === 'diff' ? <Diff sessionId={sessionId} view={view} tick={tick} round={state.world.round} /> : null}
      {sub === 'replay' ? <Replay sessionId={sessionId} /> : null}
    </section>
  );
}

function Events({ sessionId, view, tick, lang }: { sessionId: string; view: ViewMode; tick: number; lang: Lang }) {
  const r = useResource<EventsView>(sessionUrl(sessionId, 'events', { view: viewParam(view), lang }), tick);
  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="hint">Loading…</p>;
  if (r.data.events.length === 0) return <Empty>No events yet.</Empty>;
  return (
    <ol className="event-list">
      {[...r.data.events].reverse().map((e) => (
        <li key={e.index} className={`event ${e.inherited ? 'inherited' : ''}`}>
          <div className="event-head">
            {e.version !== null ? <Badge tone="info">v{e.version}</Badge> : null}
            <strong>{e.kind}</strong>
            <span className="muted">
              R{e.round} · day {e.day} · {e.actorName.en}
            </span>
            {e.rulesApplied.map((rule) => (
              <Badge key={rule} tone="muted">
                {rule}
              </Badge>
            ))}
            {e.inherited ? <Badge tone="muted">inherited</Badge> : null}
          </div>
          {e.lines.length > 0 ? (
            <ul className="facts-list" lang={lang}>
              {e.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          ) : null}
          {e.proposal ? (
            <p className="hint">
              from proposal {e.proposal.proposalId} ({e.proposal.actor}: {e.proposal.type})
            </p>
          ) : e.decisionId ? (
            <p className="hint">from decision {e.decisionId}</p>
          ) : null}
          {e.changes.length > 0 ? (
            <details>
              <summary>
                {e.changes.length} change{e.changes.length === 1 ? '' : 's'}
                {e.hiddenChanges > 0 ? ' (+ changes outside your view)' : ''}
              </summary>
              <table className="table changes">
                <tbody>
                  {e.changes.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <code>{c.op}</code>
                      </td>
                      <td>
                        <code>{c.path}</code>
                      </td>
                      <td className="before">{short(c.before)}</td>
                      <td aria-hidden="true">→</td>
                      <td className="after">{short(c.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ) : e.hiddenChanges > 0 ? (
            <p className="hint">Some changes are outside your view.</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Proposals({ sessionId, view, tick, lang }: { sessionId: string; view: ViewMode; tick: number; lang: Lang }) {
  const r = useResource<ProposalsView>(sessionUrl(sessionId, 'proposals', { view: viewParam(view) }), tick);
  const [filter, setFilter] = useState<'all' | 'not_committed'>('all');
  if (r.error) return <ErrorNote error={r.error} />;
  if (!r.data) return <p className="hint">Loading…</p>;
  const list = r.data.proposals.filter((p) => filter === 'all' || p.status !== 'committed');
  return (
    <>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={filter === 'not_committed'} onChange={(e) => setFilter(e.target.checked ? 'not_committed' : 'all')} /> Only rejected / withheld / stale / obsolete
        </label>
      </div>
      {list.length === 0 ? (
        <Empty>No proposals.</Empty>
      ) : (
        <table className="table proposals">
          <thead>
            <tr>
              <th>Round</th>
              <th>Actor</th>
              <th>Proposal</th>
              <th>Status</th>
              <th>Rule / reason</th>
            </tr>
          </thead>
          <tbody>
            {[...list].reverse().map((p) => (
              <tr key={p.proposalId}>
                <td>
                  R{p.round}
                  <span className="muted">.e{p.epoch}</span>
                </td>
                <td>{p.actorName.en}</td>
                <td>
                  <span lang={lang}>{t(p.summary, lang)}</span>
                  {p.probe ? <Badge tone="warn">probe</Badge> : null}
                  {p.rationale ? <div className="hint">{p.rationale}</div> : null}
                </td>
                <td>
                  <Badge tone={STATUS_TONE[p.status] ?? 'muted'}>{p.status}</Badge>
                  {p.category ? <div className="hint">pause: {p.category}</div> : null}
                  {p.gate ? <div className="hint">gate: {p.gate}</div> : null}
                </td>
                <td>
                  {p.rule ? (
                    <span title={p.ruleTitle ?? ''}>
                      <Badge tone="bad">{p.rule}</Badge> <span className="hint">{p.ruleTitle}</span>
                    </span>
                  ) : null}
                  {p.reason ? <div className="reason">{p.reason}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** Player view: between round starts (world versions are not exposed); director view: between world versions. */
function Diff({ sessionId, view, tick, round }: { sessionId: string; view: ViewMode; tick: number; round: number }) {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const params =
    view === 'player'
      ? { fromRound: from === '' ? undefined : from, toRound: to === '' ? undefined : to }
      : { view: viewParam(view), from: from === '' ? undefined : from, to: to === '' ? undefined : to };
  const r = useResource<DiffView>(sessionUrl(sessionId, 'diff', params), tick);
  const unit = view === 'player' ? 'round' : 'version';
  return (
    <>
      <div className="row">
        <label>
          From {unit} <input type="number" min={view === 'player' ? 1 : 0} max={view === 'player' ? round : undefined} value={from} placeholder={r.data ? String(r.data.from) : ''} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          to {unit} <input type="number" min={view === 'player' ? 1 : 0} max={view === 'player' ? round : undefined} value={to} placeholder={r.data?.to !== null && r.data?.to !== undefined ? String(r.data.to) : 'now'} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <p className="hint">{view === 'player' ? 'What the clerk knew at the start of a round, compared with a later round start (or now).' : 'Differences in the full world state between two versions.'}</p>
      <ErrorNote error={r.error} />
      {r.data && r.data.entries.length === 0 ? <Empty>No difference.</Empty> : null}
      {r.data && r.data.entries.length > 0 ? (
        <table className="table changes">
          <tbody>
            {r.data.entries.map((c, i) => (
              <tr key={i} className={`diff-${c.op}`}>
                <td>
                  <Badge tone={c.op === 'added' ? 'ok' : c.op === 'removed' ? 'bad' : 'info'}>{c.op}</Badge>
                </td>
                <td>
                  <code>{c.path}</code>
                </td>
                <td className="before">{short(c.before)}</td>
                <td aria-hidden="true">→</td>
                <td className="after">{short(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}

function Replay({ sessionId }: { sessionId: string }) {
  const [result, setResult] = useState<ReplayView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (mode: 'patch' | 'rederive'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setResult(await postJson<ReplayView>(sessionUrl(sessionId, 'replay'), { mode }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="hint">Patch replay re-applies the stored changes from the initial snapshot; rederive re-runs validation on the stored proposals and decisions (no model calls) and must reproduce every event, rejection and the final hash.</p>
      <div className="row">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run('patch')}>
          Patch replay
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run('rederive')}>
          Rederive replay
        </button>
      </div>
      <ErrorNote error={error} />
      {result ? (
        <div className={`replay ${result.ok ? 'meter-ok' : 'meter-bad'}`} role="status">
          <p>
            <Badge tone={result.ok ? 'ok' : 'bad'}>{result.ok ? 'consistent' : 'MISMATCH'}</Badge> {result.mode}
            {result.checkedEvents !== null ? `: ${result.checkedEvents} events, ${result.checkedBatches ?? 0} batches checked` : ' (counts and hashes appear once the chapter has ended)'}
          </p>
          {result.finalHash !== null && result.expectedHash !== null ? (
            <p className="hint">
              final hash <code>{result.finalHash.slice(0, 16)}</code> · expected <code>{result.expectedHash.slice(0, 16)}</code>
            </p>
          ) : null}
          {result.mismatches.length > 0 ? (
            <ul className="plain">
              {result.mismatches.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
