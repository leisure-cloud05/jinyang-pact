/**
 * Hourglass and city-defence alerts: the chapter's rounds, what this round's five days do to the siege if nothing
 * else changes (the server applies the engine's own transition: src/server/views/siege-watch.ts), and alerts at the
 * rules' thresholds. Advisory only: nothing here blocks or changes a choice.
 */
import type { ControlView, Lang, SiegeAlertView, SiegeWatchView } from '../../../src/server/api-types';
import { t } from '../labels';

const LEVEL_LABELS: Record<SiegeAlertView['level'], string> = {
  critical: 'City in danger',
  warning: 'Warning',
  notice: 'Note',
};

type Tone = '' | 'warn' | 'bad';

function grainTone(grain: number, w: SiegeWatchView): Tone {
  if (grain <= w.limits.mutinyGrainMax) return 'bad';
  return grain < w.limits.moraleLowGrain ? 'warn' : '';
}

function pressureTone(pressure: number, w: SiegeWatchView): Tone {
  if (pressure >= w.limits.fallPressureMin) return 'bad';
  return pressure > w.limits.moraleHighPressure ? 'warn' : '';
}

function moraleTone(morale: number, w: SiegeWatchView): Tone {
  return morale <= w.limits.mutinyMoraleMax ? 'bad' : '';
}

/** An hourglass whose upper bulb holds the rounds still to come. */
function Hourglass({ left, total }: { left: number; total: number }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  const topY = 19 - 15 * frac;
  const topHalf = 9.4 * frac;
  const bottomY = 35 - 15 * (1 - frac);
  const bottomHalf = (9.4 * (bottomY - 19)) / 16;
  return (
    <svg className="hourglass" viewBox="0 0 26 38" aria-hidden="true">
      <path className="glass" d="M3 2.5h20M3 35.5h20M5 3c0 7 8 9 8 16 0-7 8-9 8-16M5 35c0-7 8-9 8-16 0 7 8 9 8 16" />
      {frac > 0 ? <polygon className="sand" points={`${13 - topHalf},${topY} ${13 + topHalf},${topY} 13,19`} /> : null}
      {frac < 1 ? <polygon className="sand" points={`3.6,35 22.4,35 ${13 + bottomHalf},${bottomY} ${13 - bottomHalf},${bottomY}`} /> : null}
    </svg>
  );
}

export function SiegeWatch({ watch, control, lang }: { watch: SiegeWatchView; control: ControlView; lang: Lang }) {
  const next = watch.next;
  const critical = watch.alerts.some((a) => a.level === 'critical');
  const shownRound = Math.min(watch.round, watch.maxRounds);
  const ended = watch.roundsLeft === 0;
  const steps = Array.from({ length: control.interactionStepLimit }, (_, i) => i < control.interactionStep);
  return (
    <section className={`panel siege-watch ${critical ? 'is-critical' : ''}`} aria-labelledby="watch-title">
      <div className="watch-head">
        <Hourglass left={watch.roundsLeft} total={watch.maxRounds} />
        <div className="watch-title">
          <h2 id="watch-title">Hourglass</h2>
          <p className="watch-day">
            Day {watch.day} · Round {shownRound} of {watch.maxRounds}
          </p>
          <p className="watch-left">
            {ended ? 'The chapter has ended' : `${watch.roundsLeft} ${watch.roundsLeft === 1 ? 'round' : 'rounds'} left`}
          </p>
        </div>
        {!ended && control.interactionStepLimit > 0 ? (
          <span className="exchanges" title="Council exchanges this round">
            <span className="steps-dots" aria-hidden="true">
              {steps.map((on, i) => (
                <i key={i} className={on ? 'on' : ''} />
              ))}
            </span>
            Exchanges {control.interactionStep}/{control.interactionStepLimit}
          </span>
        ) : null}
      </div>
      <ol className="round-track" aria-label={ended ? `The chapter ended after round ${shownRound}` : `Round ${watch.round} of ${watch.maxRounds}`}>
        {Array.from({ length: watch.maxRounds }, (_, i) => i + 1).map((r) => {
          const cls = r < watch.round ? 'spent' : r === watch.round ? (ended ? 'spent' : 'current') : ended ? 'unused' : 'left';
          return <li key={r} className={cls} title={`Round ${r}: day ${(r - 1) * watch.roundDays}–${r * watch.roundDays}`} />;
        })}
      </ol>
      {next ? (
        <>
          <p className="hint forecast-lead">
            When this round ends, {watch.roundDays} days pass (day {next.day}). If nothing else changes:
          </p>
          <ul className="forecast">
            <li className={grainTone(next.grain, watch)}>
              Grain <b>{watch.now.grain} → {next.grain}</b> days
            </li>
            <li className={pressureTone(next.pressure, watch)}>
              Pressure <b>{watch.now.pressure} → {next.pressure}</b> / {watch.limits.pressureCap}
            </li>
            <li className={moraleTone(next.morale, watch)}>
              Morale <b>{watch.now.morale} → {next.morale}</b> / {watch.limits.moraleCap}
            </li>
          </ul>
        </>
      ) : null}
      {watch.alerts.length > 0 ? (
        <ul className="alerts">
          {watch.alerts.map((a) => (
            <li key={a.code} className={`alert alert-${a.level}`} role={a.level === 'critical' ? 'alert' : 'status'}>
              <strong>{LEVEL_LABELS[a.level]}:</strong> {t(a.text, lang)}
            </li>
          ))}
        </ul>
      ) : next ? (
        <p className="hint">No danger this round at the current pace.</p>
      ) : null}
    </section>
  );
}

/** The most serious alert, for the bar under the story (null when there is nothing above a note). */
export function topAlert(watch: SiegeWatchView): SiegeAlertView | null {
  return watch.alerts.find((a) => a.level === 'critical' || a.level === 'warning') ?? null;
}
