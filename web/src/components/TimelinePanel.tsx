/**
 * Timeline (retrospective review): rounds with their pauses and decisions, branching from a round start, named
 * checkpoints, and a side-by-side comparison of two sessions with the first divergence highlighted.
 */
import { useEffect, useRef, useState } from 'react';
import type { CompareView, Lang, SessionListItem, TimelineView, ViewMode } from '../../../src/server/api-types';
import { errorText, postJson, sessionUrl, viewParam } from '../api';
import { useResource } from '../hooks';
import { CATEGORY_LABELS, OPTION_LABELS, TERMINAL_LABELS, englishDisplay, t } from '../labels';
import { Badge, Empty, ErrorNote, Section } from './ui';

export function TimelinePanel({
  sessionId,
  view,
  tick,
  lang,
  sessions,
  onOpen,
}: {
  sessionId: string;
  view: ViewMode;
  tick: number;
  lang: Lang;
  sessions: SessionListItem[];
  onOpen: (id: string) => void;
}) {
  const tl = useResource<TimelineView>(sessionUrl(sessionId, 'timeline', { view: viewParam(view) }), tick);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [other, setOther] = useState<string>('');
  const [compare, setCompare] = useState<CompareView | null>(null);

  const branch = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ sessionId: string }>(sessionUrl(sessionId, 'branch'), { ...body, wait: 3000 });
      onOpen(r.sessionId);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(sessionUrl(sessionId, 'save'), { name: name.trim() });
      setName('');
      tl.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const runCompare = async (): Promise<void> => {
    if (!other) return;
    setError(null);
    try {
      const q = new URLSearchParams({ a: sessionId, b: other, lang });
      if (view === 'director') q.set('view', 'director');
      const res = await fetch(`/api/compare?${q.toString()}`);
      const body = (await res.json()) as CompareView & { message?: string };
      if (!res.ok) throw new Error(body.message ?? `${res.status}`);
      setCompare(body);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const data = tl.data;
  const candidates = [...new Set([...(data?.lineage.related ?? []), ...sessions.map((s) => s.sessionId)])].filter((id) => id !== sessionId);
  return (
    <section className="panel timeline" aria-labelledby="timeline-title">
      <div className="panel-head">
        <h2 id="timeline-title">Timeline</h2>
        {data ? (
          <div className="badges">
            {data.outcome ? <Badge tone="ok">{data.outcome}</Badge> : <Badge tone="info">in progress</Badge>}
          </div>
        ) : null}
      </div>
      <ErrorNote error={tl.error ?? error} />
      {!data ? <p className="hint">Loading…</p> : null}
      {data ? (
        <>
          {data.lineage.parent ? (
            <p className="hint">
              Branched from{' '}
              <button type="button" className="link" onClick={() => onOpen(data.lineage.parent!.sessionId)}>
                {data.lineage.parent.sessionId}
              </button>{' '}
              at round {data.lineage.parent.round}.
            </p>
          ) : null}
          <ol className="rounds">
            {data.rounds.map((r) => (
              <li key={r.round} className={`round-card ${r.inherited ? 'inherited' : ''}`}>
                <div className="round-head">
                  <strong>
                    Round {r.round} · day {r.day}
                  </strong>
                  <span className="muted">{r.events} event(s)</span>
                  {r.inherited ? <Badge tone="muted">inherited</Badge> : null}
                  {r.terminal ? <Badge tone="ok">{t(TERMINAL_LABELS[r.terminal] ?? { zh: r.terminal, en: r.terminal }, lang)}</Badge> : null}
                  {r.canBranch ? (
                    <button type="button" className="btn-small" disabled={busy} onClick={() => void branch({ round: r.round })} title={`New session from the start of round ${r.round}`}>
                      Branch here
                    </button>
                  ) : null}
                </div>
                {r.pauses.length > 0 ? (
                  <ul className="plain">
                    {r.pauses.map((p) => (
                      <li key={p.id}>
                        <Badge tone={p.status === 'obsolete' ? 'muted' : p.status === 'open' ? 'info' : 'ok'}>{p.status}</Badge> {CATEGORY_LABELS[p.category] ?? p.category}
                        {p.option ? ` → ${OPTION_LABELS[p.option]?.label ?? p.option}` : ''}
                        {p.by === 'policy' ? ' (policy)' : ''}
                        {p.advice ? <span className="hint"> “{englishDisplay(p.advice)}”</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="hint">
                  narration: {r.narrations.ok} ok · {r.narrations.fallback} template · {r.narrations.failed} pending
                  {r.interrupts > 0 ? ` · ${r.interrupts} interrupt(s)` : ''}
                </p>
                {r.activations ? (
                  <p className="hint director-only">
                    active: {r.activations.map((a) => `${a.charId}${a.skipped ? ' (capped)' : ''} [${a.tier}]`).join(', ') || '—'}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>

          {data.lineage.children.length > 0 ? (
            <Section title="Branches from this session">
              <ul className="plain">
                {data.lineage.children.map((c) => (
                  <li key={c.sessionId}>
                    <button type="button" className="link" onClick={() => onOpen(c.sessionId)}>
                      {c.sessionId}
                    </button>{' '}
                    (from round {c.round}) {c.outcome ? <Badge tone="ok">{c.outcome}</Badge> : null}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="Checkpoints">
            <div className="row">
              <label htmlFor="cp-name" className="sr-only">
                Checkpoint name
              </label>
              <input id="cp-name" type="text" value={name} placeholder="checkpoint name" onChange={(e) => setName(e.target.value)} />
              <button type="button" className="btn-secondary" disabled={busy || !name.trim()} onClick={() => void save()}>
                Save at the latest round start
              </button>
            </div>
            {data.checkpoints.length === 0 ? (
              <Empty>No checkpoints.</Empty>
            ) : (
              <ul className="plain">
                {data.checkpoints.map((c) => (
                  <li key={c.name}>
                    <strong>{c.name}</strong> — round {c.round}{c.version !== null ? ` (v${c.version})` : ''}{' '}
                    <button type="button" className="btn-small" disabled={busy} onClick={() => void branch({ checkpoint: c.name })}>
                      Load as new session
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Compare with another session">
            <div className="row">
              <label htmlFor="cmp" className="sr-only">
                Session to compare
              </label>
              <select id="cmp" value={other} onChange={(e) => setOther(e.target.value)}>
                <option value="">Choose a session…</option>
                {candidates.map((id) => (
                  <option key={id} value={id}>
                    {id}
                    {data.lineage.related.includes(id) ? ' (same lineage)' : ''}
                  </option>
                ))}
              </select>
              <button type="button" className="btn-secondary" disabled={!other} onClick={() => void runCompare()}>
                Compare
              </button>
            </div>
            {compare ? <Comparison data={compare} /> : null}
          </Section>
        </>
      ) : null}
    </section>
  );
}

function Comparison({ data }: { data: CompareView }) {
  const mark = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = mark.current;
    const box = el?.closest('ol');
    if (el && box) box.scrollTop = Math.max(0, el.offsetTop - box.offsetTop - 40);
  }, [data]);
  const d = data.divergence;
  const col = (side: 'a' | 'b') => {
    const s = data[side];
    return (
      <div className="compare-col">
        <h4>
          {s.sessionId} {s.outcome ? <Badge tone="ok">{s.outcome}</Badge> : null}
        </h4>
        <table className="table compact">
          <thead>
            <tr>
              <th>R</th>
              <th>Day</th>
              <th>Grain</th>
              <th>Pressure</th>
              <th>Morale</th>
              <th>Draft</th>
              <th>End</th>
            </tr>
          </thead>
          <tbody>
            {s.rounds.map((r, i) => (
              <tr key={i}>
                <td>{r.round}</td>
                <td>{r.day}</td>
                <td>{r.grain}</td>
                <td>{r.pressure}</td>
                <td>{r.morale}</td>
                <td>{r.docVersion !== null ? `v${r.docVersion} ${r.docStatus ?? ''} (${r.timing ?? ''})` : '—'}</td>
                <td>{r.terminal ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ol className="compare-items">
          {s.items.map((it) => (
            <li
              key={it.index}
              ref={d && it.index === d.index && side === 'a' ? mark : undefined}
              className={d && it.index === d.index ? 'diverge' : d && it.index > d.index ? 'after-diverge' : ''}
            >
              <span className="muted">R{it.round}</span> {englishDisplay(it.text)}
            </li>
          ))}
        </ol>
      </div>
    );
  };
  return (
    <div className="compare">
      <p role="status">
        {d ? (
          <>
            <Badge tone="warn">first divergence</Badge> at item {d.index + 1}
            {d.round !== null ? `, round ${d.round}` : ''}
            {d.version !== null ? `, world version ${d.version}` : ''} ({data.sharedPrefix} shared).
          </>
        ) : (
          <>
            <Badge tone="ok">identical</Badge> no divergence in {data.view === 'director' ? 'the world events' : 'what the clerk witnessed'}.
          </>
        )}
      </p>
      <div className="compare-grid">
        {col('a')}
        {col('b')}
      </div>
    </div>
  );
}
