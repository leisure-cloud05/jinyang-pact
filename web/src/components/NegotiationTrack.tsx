/**
 * Negotiation track (谈判拉锯) and its echoes (行动回响): the request's letters on the road between Jinyang and the far
 * court, as the clerk knows them. The last letter's token sets out from its sender and moves by the courier's
 * schedule; a counter-offer arrives at Jinyang once the clerk hears of it; agreement is sealed. Earlier letters are
 * listed with what each counter-offer changed.
 */
import type { CatalogView, DraftView, Lang, NegotiationTrackView, WorldView } from '../../../src/server/api-types';
import { useJustChanged } from '../hooks';
import { STAGE_LABELS, STAGE_TONE, TALK_STEPS, talkStep, termChanges, trackCaption } from '../negotiation';
import { TermsTable } from './terms';
import { Badge, Stamp } from './ui';
import { NegotiationMap } from './NegotiationMap';

export function NegotiationTrack({ track, negotiation, catalog, lang, draft, terminal }: { track: NegotiationTrackView; negotiation: WorldView['negotiation']; catalog: CatalogView; lang: Lang; draft?: DraftView | null; terminal: WorldView['terminal'] }) {
  const last = track.cards.at(-1);
  const step = talkStep(last);
  // One-shot echoes: a new letter sets out (or a reply comes in); a new stage makes the receiving end pulse.
  const arrived = useJustChanged(last ? `${last.offerId}:${last.stage}` : null, 2400);
  return (
    <div className="track">
      <ol className={`talk-steps ${last && step < 0 ? 'is-ended' : ''}`} aria-label="Where the talks stand">
        {TALK_STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'is-current' : ''} aria-current={i === step ? 'step' : undefined}>
            {STAGE_LABELS[s]}
          </li>
        ))}
      </ol>
      <NegotiationMap track={track} draft={draft} terminal={terminal} />
      <p className="track-caption" role="status">
        {last?.stage === 'confirmed' ? <Stamp glyph="盟" fresh={arrived} /> : null}
        {trackCaption(track)}
      </p>
      {track.cards.length > 0 ? (
        <ol className="letters" aria-label="Letters you know of">
          {track.cards.map((c, i) => {
            const changes = i > 0 ? termChanges(track.cards[i - 1]?.terms ?? null, c.terms, catalog, lang) : [];
            return (
              <li key={c.offerId} className="letter">
                <div className="letter-head">
                  <span className="letter-dir" aria-hidden="true">
                    {c.direction === 'out' ? '→' : '←'}
                  </span>
                  <strong>v{c.termsVersion}</strong>
                  <span className="muted">{c.direction === 'out' ? `to ${track.far.name.en}, sent day ${c.sinceDay}` : `from ${track.far.name.en}, received day ${c.sinceDay}`}</span>
                  <Badge tone={STAGE_TONE[c.stage]}>{STAGE_LABELS[c.stage]}</Badge>
                </div>
                {i > 0 ? <p className="letter-changes">{changes.length > 0 ? changes.map((x) => `${x.label}: ${x.from} → ${x.to}`).join('; ') : 'No change you can see.'}</p> : null}
                {c.terms ? (
                  <details>
                    <summary>Terms as you know them</summary>
                    <TermsTable terms={c.terms} catalog={catalog} lang={lang} compact />
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
      <p className="hint">
        {negotiation.segment > 0 ? `Counter-offers in segment ${negotiation.segment}: ${negotiation.roundsUsed} of ${track.roundCap}. ` : ''}
        Letters move by the courier’s schedule; a reply shows once it reaches headquarters.
      </p>
    </div>
  );
}
