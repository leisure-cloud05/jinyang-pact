/** Usage: calls, attempts, tokens, cost by source (reported / estimated / unknown — never guessed), latency. */
import type { UsageBucket, UsageView, ViewMode } from '../../../src/server/api-types';
import { sessionUrl, viewParam } from '../api';
import { useResource } from '../hooks';
import { fmt, usd } from '../labels';
import { Empty, ErrorNote } from './ui';

function Cards({ b, budget }: { b: UsageBucket; budget: UsageView['budget'] }) {
  const items: Array<[string, string]> = [
    ['Calls', `${fmt(b.calls)} / ${fmt(budget.maxCalls)}`],
    ['Attempts', fmt(b.attempts)],
    ['Input tokens', fmt(b.inputTokens)],
    ['Output tokens', fmt(b.outputTokens)],
    ['Cost reported', usd(b.costReportedUsd)],
    ['Cost estimated', usd(b.costEstimatedUsd)],
    ['Unknown-cost calls', fmt(b.unknownCostCalls)],
    ['Latency median / p95', `${fmt(b.medianLatencyMs)} / ${fmt(b.p95LatencyMs)} ms`],
  ];
  return (
    <dl className="cards">
      {items.map(([k, v]) => (
        <div key={k} className="card">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function UsagePanel({ sessionId, view, tick }: { sessionId: string; view: ViewMode; tick: number }) {
  const r = useResource<UsageView>(sessionUrl(sessionId, 'usage', { view: viewParam(view) }), tick);
  const u = r.data;
  return (
    <section className="panel usage" aria-labelledby="usage-title">
      <div className="panel-head">
        <h2 id="usage-title">Usage</h2>
      </div>
      <ErrorNote error={r.error} />
      {!u ? <p className="hint">Loading…</p> : null}
      {u && !u.detailed ? (
        <>
          <dl className="cards">
            <div className="card">
              <dt>Round · day</dt>
              <dd>
                {u.player.round} · {u.player.day}
              </dd>
            </div>
            <div className="card">
              <dt>Your actions (committed / rejected)</dt>
              <dd>
                {fmt(u.player.actions.total)} ({fmt(u.player.actions.committed)} / {fmt(u.player.actions.rejected)})
              </dd>
            </div>
            <div className="card">
              <dt>Your interpreted commands</dt>
              <dd>{fmt(u.player.mapperCalls)}</dd>
            </div>
            <div className="card">
              <dt>Call budget used (coarse)</dt>
              <dd>{Math.round(u.player.budgetUsed * 100)}%</dd>
            </div>
          </dl>
          <p className="hint">Per-call telemetry (roles, tokens, latency, cost) would reveal what happens offstage, so it is shown once the chapter has ended or the director view is unlocked.</p>
        </>
      ) : null}
      {u && u.detailed && u.totals && u.byRole && u.calls ? (
        <>
          <Cards b={u.totals} budget={u.budget} />
          <p className="hint">Budget per session: {fmt(u.budget.maxCalls)} calls, {usd(u.budget.maxUsd)}. Mock calls cost nothing; costs without a provider report are shown as unknown, never as zero.</p>
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Calls</th>
                <th>Attempts</th>
                <th>Tokens in / out</th>
                <th>Reported</th>
                <th>Estimated</th>
                <th>Unknown</th>
                <th>Median / p95 ms</th>
              </tr>
            </thead>
            <tbody>
              {u.byRole.map((b) => (
                <tr key={b.role}>
                  <td>{b.role}</td>
                  <td>{fmt(b.calls)}</td>
                  <td>{fmt(b.attempts)}</td>
                  <td>
                    {fmt(b.inputTokens)} / {fmt(b.outputTokens)}
                  </td>
                  <td>{usd(b.costReportedUsd)}</td>
                  <td>{usd(b.costEstimatedUsd)}</td>
                  <td>{fmt(b.unknownCostCalls)}</td>
                  <td>
                    {fmt(b.medianLatencyMs)} / {fmt(b.p95LatencyMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details>
            <summary>All calls ({u.calls.length})</summary>
            {u.calls.length === 0 ? (
              <Empty>No calls.</Empty>
            ) : (
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Round</th>
                    <th>Role</th>
                    <th>Actor</th>
                    <th>Model</th>
                    <th>Tokens</th>
                    <th>Cost</th>
                    <th>Latency</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {u.calls.map((c) => (
                    <tr key={c.callId}>
                      <td>{c.round ?? '—'}</td>
                      <td>{c.role}</td>
                      <td>{c.actor ?? '—'}</td>
                      <td>{c.model}</td>
                      <td>
                        {fmt(c.inputTokens)} / {fmt(c.outputTokens)}
                      </td>
                      <td>
                        {c.costSource === 'none' ? 'unknown' : usd(c.costUsd)} <span className="muted">{c.costSource}</span>
                      </td>
                      <td>{fmt(c.latencyMs)} ms</td>
                      <td>
                        {c.status}
                        {c.attempts > 1 ? ` ×${c.attempts}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        </>
      ) : null}
    </section>
  );
}
