import { useEffect, useRef, useState } from 'react';
import type { DraftView, NegotiationTrackView, WorldView } from '../../../src/server/api-types';
import { COURIER_ROUTE, letterScenes, mapScenes, reliefPlan, routePoint, type MapScene, type MapSnapshot } from '../map-motion';
import { STAGE_LABELS } from '../negotiation';
import { TerritoryMap } from './TerritoryMap';

function restingScene(snapshot: MapSnapshot): MapScene {
  const card = snapshot.cards.at(-1);
  if (snapshot.relief) return { kind: 'relief', card, from: 1, to: 0, title: 'Projected relief route · after the chapter', duration: 0, relief: snapshot.relief };
  const to = card?.direction === 'out' && ['confirmed', 'rejected', 'countered'].includes(card.stage) ? 0 : card?.position ?? 0;
  return { kind: card?.stage === 'confirmed' ? 'confirmation' : card?.stage === 'rejected' || card?.stage === 'withdrawn' ? 'closed' : 'courier', card, from: to, to, title: card ? STAGE_LABELS[card.stage] : 'Ready to dispatch', duration: 0 };
}

export function NegotiationMap({ track, draft, terminal }: { track: NegotiationTrackView; draft?: DraftView | null; terminal: WorldView['terminal'] }) {
  const last = track.cards.at(-1);
  const snapshot: MapSnapshot = { cards: track.cards, draft, relief: reliefPlan(last, terminal) };
  const previous = useRef(snapshot);
  const [shown, setShown] = useState(() => restingScene(snapshot));
  const [progress, setProgress] = useState(1);
  const [queue, setQueue] = useState<MapScene[]>([]);
  const active = queue[0];

  useEffect(() => {
    const next: MapSnapshot = { cards: track.cards, draft, relief: reliefPlan(track.cards.at(-1), terminal) };
    const scenes = mapScenes(previous.current, next);
    previous.current = next;
    if (scenes.length) setQueue((q) => [...q, ...scenes]);
  }, [track.cards, draft, terminal]);

  useEffect(() => {
    if (!active) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setShown(active);
    setProgress(0);
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const fraction = media.matches ? 1 : Math.min(1, (now - start) / active.duration);
      setProgress(fraction * fraction * (3 - 2 * fraction));
      if (fraction < 1) frame = requestAnimationFrame(tick);
      else {
        if (active.kind === 'draft') setShown(restingScene(previous.current));
        setQueue((q) => q.slice(1));
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const scene = active ?? shown;
  const fraction = active && active !== shown ? 0 : progress;
  const position = scene.from + (scene.to - scene.from) * fraction;
  const point = routePoint(position);
  if (scene.departure) point.x -= 38 * (1 - fraction);
  const card = scene.card;
  const returning = scene.from > scene.to || card?.direction === 'in';
  const traversed = returning
    ? [...COURIER_ROUTE].reverse().filter((_, i) => 1 - i / (COURIER_ROUTE.length - 1) >= position)
    : COURIER_ROUTE.filter((_, i) => i / (COURIER_ROUTE.length - 1) <= position);
  const trail = [...traversed.map((p) => p.join(',')), `${point.x},${point.y}`].join(' ');
  const travelling = scene.kind === 'courier' || scene.kind === 'relief';
  const replay = () => {
    const scenes = last ? letterScenes(last) : [];
    if (snapshot.relief) scenes.push({ ...restingScene(snapshot), from: 1, to: 0, duration: 2600 });
    setQueue(scenes);
  };

  return (
    <div className={`journey-map ${active ? 'is-playing' : ''}`} data-scene={scene.kind} data-playing={Boolean(active)}>
      <div className="journey-toolbar">
        <strong aria-live="polite">{scene.title}</strong>
        <div className="journey-controls">
          {active ? <button type="button" onClick={() => { setQueue([]); setShown(restingScene(snapshot)); setProgress(1); }}>Skip</button> : null}
          <button type="button" disabled={!last || Boolean(active)} onClick={replay}>Replay</button>
        </div>
      </div>
      {scene.relief ? <p className="map-projection-note">Projected journey: {scene.relief.cavalry.toLocaleString('en-US')} cavalry · expected day {scene.relief.arrivalDay}. This chapter ends at agreement; arrival has not been observed.</p> : null}
      <TerritoryMap cession={card?.terms?.cession ?? 'none'}>
        <polyline className="map-route" points={COURIER_ROUTE.map((p) => p.join(',')).join(' ')} />
        {card && travelling ? <polyline className={`map-route-progress ${scene.relief ? 'is-projected' : ''}`} points={trail} /> : null}
        <g className="map-location">
          <circle cx="100" cy="265" r="9" /><text x="100" y="291" textAnchor="middle">Jinyang</text>
          <circle cx="310" cy="180" r="6" /><text x="310" y="157" textAnchor="middle">On the road</text>
          <circle cx="530" cy="65" r="9" /><text x="530" y="42" textAnchor="middle">{scene.relief ? 'Relief camp' : 'Khitan court'}</text>
        </g>
        {card && travelling ? <g className="map-traveller" transform={`translate(${point.x} ${point.y})`}>
          <circle className="map-token-halo" r="24" /><circle className="map-token" r="17" />
          {scene.relief ? <path className="map-cavalry" d="M-10 9 L-7 -1 -2 -5 -5 -10 0 -8 4 -11 9 -5 6 0 2 -1 1 8Z M-10 9 H10" /> : <path className="map-envelope" d="M-10 -6 H10 V7 H-10 Z M-10 -6 L0 2 10 -6" />}
        </g> : null}
        {['seal', 'confirmation', 'closed'].includes(scene.kind) ? <g className={`map-seal ${active ? 'map-seal-fresh' : ''}`} key={`${scene.kind}:${card?.offerId}`} transform="translate(466 277)">
          <rect x="-79" y="-18" width="158" height="36" rx="4" /><text textAnchor="middle" y="5">{scene.kind === 'seal' ? 'SEALED' : scene.kind === 'confirmation' ? 'CONFIRMED' : card?.stage === 'rejected' ? 'REJECTED' : 'WITHDRAWN'}</text>
        </g> : null}
        {scene.kind === 'draft' ? <g className="map-draft-update"><circle cx="100" cy="265" r="26" /><text x="180" y="290">Draft revised</text></g> : null}
      </TerritoryMap>
      <p className="hint">{scene.relief ? 'Dashed route: projected relief, not a recorded march.' : !card ? 'Prepare the request to send a courier.' : card.direction === 'out' && ['proposed', 'awaiting'].includes(card.stage) ? 'Estimated courier position · arrival is not yet independently confirmed.' : 'The envelope represents the courier carrying a known reply.'} Gold: proposed cession; territory has not changed hands.</p>
    </div>
  );
}

