/**
 * Art of the ending CG: a schematic map for its opening move, and one vector scene per ending, painted in layers
 * (sky, brush-edged ridges, mist, architecture lit along its edges) in the page's parchment, vermilion, ochre and ink.
 * Layers carry `fx-*` classes that styles.css animates; each layer's resting state is its final frame, so skipping or
 * reaching the ending card always shows a clean still. A generated illustration listed in `ENDING_ART`
 * (web/src/ending.ts) replaces the scene.
 */
import type { CSSProperties, ReactNode } from 'react';
import { ENDINGS, type EndingKind } from '../ending';

const VIEW = '0 0 1600 900';

type Point = readonly [number, number];
/** x, y and a size. */
type Spot = readonly [number, number, number];

/** Mountain clusters on the map (foot x, y and scale): the Taihang to the east, the Lüliang to the west, hills toward the pass. */
const PEAKS: Spot[] = [
  [900, 560, 0.9],
  [985, 640, 1.05],
  [1045, 500, 0.8],
  [1115, 680, 0.9],
  [965, 430, 0.7],
  [500, 420, 0.85],
  [430, 500, 0.95],
  [560, 350, 0.7],
  [1070, 320, 0.65],
  [1130, 400, 0.6],
  [790, 300, 0.6],
];
/** Corner blocks of the map's border. */
const MAP_CORNERS: Point[] = [
  [26, 26],
  [1574, 26],
  [26, 874],
  [1574, 874],
];
/** Tang siege camps around Jinyang on the map (offsets from the city). */
const CAMPS: Point[] = [
  [150, -38],
  [92, 92],
  [-50, 112],
  [-152, 30],
  [-112, -84],
  [24, -116],
];
/** Cloud banks over the dawn (x, y, width), lit gold from below. */
const PACT_CLOUDS: Spot[] = [
  [420, 300, 320],
  [770, 238, 230],
  [1390, 322, 280],
  [990, 392, 360],
];
/** The fall: smoke columns over the city (x, scale), drifting embers, banners on the wall (x, tilt), the assault at the ladders. */
const SMOKE_COLUMNS: Point[] = [
  [430, 1],
  [720, 1.35],
  [1010, 1.1],
  [1260, 0.9],
];
const EMBERS: Spot[] = Array.from({ length: 26 }, (_, i) => [(i * 137 + 61) % 1600, 170 + ((i * 263) % 470), 1.6 + (i % 3) * 0.9] as const);
const FALL_BANNERS: Point[] = [
  [260, -8],
  [480, 6],
  [940, -14],
  [1300, 10],
  [1480, -4],
];
const LADDERS = [380, 880, 1330];
const SOLDIERS: Point[] = [
  [360, 700],
  [372, 700],
  [404, 700],
  [418, 700],
  [394, 664],
  [860, 700],
  [872, 700],
  [902, 700],
  [898, 640],
  [1312, 700],
  [1350, 700],
  [1364, 700],
  [1344, 622],
];
/** Dusk: stars (x, y, radius) and lamps along the wall and under the tower's eaves. */
const STARS: Spot[] = Array.from({ length: 18 }, (_, i) => [(i * 211 + 37) % 1600, 28 + ((i * 97) % 250), 1 + (i % 3) * 0.6] as const);
const WALL_LAMPS: Point[] = [
  [240, 552],
  [380, 552],
  [860, 552],
  [1040, 552],
  [1210, 552],
  [477, 462],
  [723, 462],
];
/** Dusk: the brightest stars, and poplars along the foot of the wall (x, height). */
const BRIGHT_STARS: Point[] = [
  [212, 70],
  [560, 182],
  [982, 118],
  [1462, 238],
];
const DUSK_TREES: Point[] = [
  [70, 70],
  [118, 92],
  [168, 64],
  [1340, 84],
  [1398, 62],
  [1452, 96],
  [1520, 74],
];
/**
 * The closed road: motes of dust in the light from the doorway (x, y, radius), and the bamboo whose shadow falls on the
 * window paper: its leaves (x, y, angle) and the nodes on its two stems.
 */
const MOTES: Spot[] = Array.from({ length: 16 }, (_, i) => [820 + ((i * 97) % 420), 580 + ((i * 53) % 280), 1.2 + (i % 3) * 0.6] as const);
const BAMBOO_LEAVES: Spot[] = [
  [324, 330, 12],
  [324, 330, 38],
  [324, 330, 64],
  [324, 330, -16],
  [314, 430, 160],
  [314, 430, 186],
  [314, 430, 136],
  [505, 300, 118],
  [505, 300, 146],
  [505, 300, 94],
  [505, 300, 172],
  [452, 268, 22],
  [452, 268, 50],
  [452, 268, 78],
];
const BAMBOO_NODES: Point[] = [
  [306, 500],
  [315, 420],
  [323, 340],
  [516, 470],
  [510, 390],
  [505, 310],
];

/** A deterministic ridge (a sum of sines) filled down to the bottom edge: natural hills, the same on every run. */
function ridge(base: number, amp: number, seed: number): string {
  const pts: string[] = [];
  for (let x = 0; x <= 1600; x += 16) {
    const y = base - amp * (0.55 * Math.sin(x / 230 + seed) + 0.3 * Math.sin(x / 101 + seed * 2.3) + 0.15 * Math.sin(x / 43 + seed * 5.1));
    pts.push(`${x} ${y.toFixed(1)}`);
  }
  return `M0 900 L${pts.join(' L')} L1600 900 Z`;
}

/** A narrow wedge of light from the sun at (cx, cy), `angle` degrees from straight up. */
function sunRay(cx: number, cy: number, angle: number): string {
  const at = (deg: number): string => `${(cx + 1400 * Math.sin((deg * Math.PI) / 180)).toFixed(1)} ${(cy - 1400 * Math.cos((deg * Math.PI) / 180)).toFixed(1)}`;
  return `M${cx} ${cy} L${at(angle - 2.2)} L${at(angle + 2.2)} Z`;
}

/** A hip roof with upturned corners: `y` is the eave line, `half` half its width, `rise` its height. */
function roof(cx: number, y: number, half: number, rise: number): string {
  const tip = half * 0.3;
  const lift = rise * 0.4;
  return (
    `M${cx - half - tip} ${y - lift} Q${cx - half - tip * 0.1} ${y + 4} ${cx - half * 0.7} ${y + 3} L${cx + half * 0.7} ${y + 3} ` +
    `Q${cx + half + tip * 0.1} ${y + 4} ${cx + half + tip} ${y - lift} Q${cx + half * 0.74} ${y - rise * 0.38} ${cx + half * 0.46} ${y - rise} ` +
    `L${cx - half * 0.46} ${y - rise} Q${cx - half * 0.74} ${y - rise * 0.38} ${cx - half - tip} ${y - lift} Z`
  );
}

/** The upper edge of the same roof (slopes and ridge), for a rim of light. */
function roofEdge(cx: number, y: number, half: number, rise: number): string {
  const tip = half * 0.3;
  const lift = rise * 0.4;
  return (
    `M${cx - half - tip} ${y - lift} Q${cx - half * 0.74} ${y - rise * 0.38} ${cx - half * 0.46} ${y - rise} ` +
    `L${cx + half * 0.46} ${y - rise} Q${cx + half * 0.74} ${y - rise * 0.38} ${cx + half + tip} ${y - lift}`
  );
}

/** The same roof with its right half torn away. */
function brokenRoof(cx: number, y: number, half: number, rise: number): string {
  const tip = half * 0.3;
  const lift = rise * 0.4;
  return (
    `M${cx - half - tip} ${y - lift} Q${cx - half - tip * 0.1} ${y + 4} ${cx - half * 0.7} ${y + 3} L${cx + half * 0.55} ${y + 3} ` +
    `L${cx + half * 0.44} ${y - rise * 0.28} L${cx + half * 0.3} ${y - rise * 0.14} L${cx + half * 0.18} ${y - rise * 0.6} L${cx + half * 0.04} ${y - rise * 0.46} ` +
    `L${cx - half * 0.1} ${y - rise} L${cx - half * 0.46} ${y - rise} Q${cx - half * 0.74} ${y - rise * 0.38} ${cx - half - tip} ${y - lift} Z`
  );
}

/** The lit edge of what is left of a broken roof. */
function brokenEdge(cx: number, y: number, half: number, rise: number): string {
  const tip = half * 0.3;
  return `M${cx - half - tip} ${y - rise * 0.4} Q${cx - half * 0.74} ${y - rise * 0.38} ${cx - half * 0.46} ${y - rise} L${cx - half * 0.1} ${y - rise}`;
}

/**
 * Jinyang's gate tower standing on the wall at `base`: two storeys under double eaves, lit along its edges by `rim`.
 * `s` scales it for a distant view; a `broken` tower has lost its upper storey and half its roof; `lit` glows in its
 * windows.
 */
function GateTower({
  cx,
  base,
  fill,
  detail,
  rim,
  s = 1,
  broken = false,
  lit,
}: {
  cx: number;
  base: number;
  fill: string;
  detail: string;
  rim: string;
  s?: number;
  broken?: boolean;
  lit?: string;
}) {
  const lower = base - 104;
  const upper = base - 212;
  return (
    <g transform={s === 1 ? undefined : `translate(${cx} ${base}) scale(${s}) translate(${-cx} ${-base})`}>
      <g fill={fill}>
        <rect x={cx - 150} y={lower} width={300} height={104} />
        <path d={broken ? brokenRoof(cx, lower, 186, 58) : roof(cx, lower, 186, 58)} />
        {broken ? null : (
          <>
            <rect x={cx - 96} y={upper} width={192} height={64} />
            <path d={roof(cx, upper, 128, 56)} />
            {[-1, 1].map((d) => (
              <path key={d} d={`M${cx + d * 59} ${upper - 56} q${d * 2} -18 ${d * 15} -21 q${-d * 5} 6 ${-d * 2} 15 Z`} />
            ))}
          </>
        )}
      </g>
      {lit ? (
        <>
          <g fill={lit} opacity="0.85">
            {[0, 1, 2, 3, 4].map((i) => (
              <rect key={`wl${i}`} x={cx - 120 + i * 52} y={lower + 30} width={36} height={46} />
            ))}
            {broken ? null : [0, 1, 2].map((i) => <rect key={`wu${i}`} x={cx - 70 + i * 52} y={upper + 18} width={30} height={34} />)}
          </g>
          {/* Lattice bars across each lit window. */}
          <g stroke={fill} strokeWidth="2.5" opacity="0.7">
            {[0, 1, 2, 3, 4].map((i) => (
              <path key={`ml${i}`} d={`M${cx - 108 + i * 52} ${lower + 30} v46 M${cx - 96 + i * 52} ${lower + 30} v46 M${cx - 120 + i * 52} ${lower + 53} h36`} />
            ))}
            {broken ? null : [0, 1, 2].map((i) => <path key={`mu${i}`} d={`M${cx - 60 + i * 52} ${upper + 18} v34 M${cx - 50 + i * 52} ${upper + 18} v34 M${cx - 70 + i * 52} ${upper + 35} h30`} />)}
          </g>
        </>
      ) : null}
      <g fill={detail}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <rect key={`l${i}`} x={cx - 132 + i * 52} y={lower + 8} width={8} height={96} />
        ))}
        {broken ? null : (
          <>
            {[0, 1, 2, 3].map((i) => (
              <rect key={`u${i}`} x={cx - 81 + i * 52} y={upper + 8} width={7} height={56} />
            ))}
            <rect x={cx - 108} y={upper + 58} width={216} height={6} />
          </>
        )}
      </g>
      {broken ? (
        <g stroke={fill} strokeWidth="7" strokeLinecap="round">
          <path d={`M${cx + 40} ${lower - 30} l52 -38`} />
          <path d={`M${cx + 70} ${lower - 10} l30 -52`} />
          <path d={`M${cx + 18} ${lower - 44} l-10 -40`} />
        </g>
      ) : null}
      <g fill="none" stroke={rim} strokeWidth="2.5" strokeLinecap="round" opacity="0.75">
        <path d={broken ? brokenEdge(cx, lower, 186, 58) : roofEdge(cx, lower, 186, 58)} />
        {broken ? null : <path d={roofEdge(cx, upper, 128, 56)} />}
      </g>
    </g>
  );
}

/**
 * A crenellated wall from `top` down: merlons (`merlon`: width, height, spacing) with arrow slits over brick courses,
 * its top edges lit by `rim`. `gap` leaves a breach between two x positions.
 */
function Parapet({
  top,
  fill,
  rim,
  bricks,
  merlon = [54, 42, 80],
  gap,
  slits = true,
}: {
  top: number;
  fill: string;
  rim: string;
  bricks?: string;
  merlon?: readonly [number, number, number];
  gap?: Point;
  slits?: boolean;
}) {
  const [w, h, step] = merlon;
  const merlons: number[] = [];
  for (let x = -20; x < 1620; x += step) if (!gap || x + w < gap[0] || x > gap[1]) merlons.push(x);
  const spans: Point[] = gap ? [[0, gap[0]], [gap[1], 1600]] : [[0, 1600]];
  const shapes = (paint: string, opacity?: number) => (
    <g fill={paint} opacity={opacity}>
      {spans.map(([a, b]) => (
        <rect key={a} x={a} y={top} width={b - a} height={900 - top} />
      ))}
      {merlons.map((x) => (
        <rect key={x} x={x} y={top - h} width={w} height={h + 1} />
      ))}
    </g>
  );
  return (
    <g>
      {shapes(fill)}
      {bricks ? shapes(bricks, 0.55) : null}
      {slits ? (
        <g fill="#120c08">
          {merlons.map((x) => (
            <rect key={x} x={x + w / 2 - 3} y={top - h + 11} width={6} height={18} rx={2} />
          ))}
        </g>
      ) : null}
      <path d={merlons.map((x) => `M${x} ${top} V${top - h} H${x + w} V${top}`).join(' ')} fill="none" stroke={rim} strokeWidth="2.5" opacity="0.6" />
    </g>
  );
}

/**
 * Tongues of flame standing on `y` between two x positions; `k` scales their height, from the outer flames to the cores.
 * They burn highest under the `blazes` (x and strength) and lean with the wind that carries the smoke east.
 */
function flameTongues(from: number, to: number, y: number, k: number, blazes: Point[]): string {
  let d = '';
  for (let x = from; x <= to; x += 24 + 16 * Math.abs(Math.sin(x / 41))) {
    const heat = Math.max(0, ...blazes.map(([bx, s]) => s * Math.exp(-(((x - bx) / 120) ** 2))));
    const h = k * (18 + 30 * Math.abs(Math.sin(x / 53)) + 16 * Math.abs(Math.sin(x / 17)) + 80 * heat);
    const w = 12 + 7 * Math.abs(Math.sin(x / 29)) + 6 * heat;
    const lean = 0.2 * h;
    const n = (v: number): string => v.toFixed(1);
    d += `M${n(x - w)} ${y} C${n(x - w * 1.1)} ${n(y - h * 0.4)} ${n(x - w * 0.1 + lean * 0.4)} ${n(y - h * 0.62)} ${n(x + lean)} ${n(y - h)} C${n(x + w * 0.45 + lean * 0.5)} ${n(y - h * 0.6)} ${n(x + w * 1.05)} ${n(y - h * 0.36)} ${n(x + w)} ${y} Z `;
  }
  return d.trim();
}

/** A bare tree in winter: trunk and forked branches as tapering strokes. */
function BareTree({ x, y, s, fill }: { x: number; y: number; s: number; fill: string }) {
  const branches: Array<readonly [string, number]> = [
    ['M0 0 C -4 -40 6 -80 0 -130', 10],
    ['M0 -70 C 20 -90 40 -100 70 -140', 5],
    ['M2 -100 C -20 -120 -40 -126 -66 -170', 5],
    ['M0 -130 C 6 -150 0 -170 10 -200', 4],
    ['M44 -110 C 54 -118 62 -116 80 -120', 2.5],
    ['M-36 -132 C -48 -136 -58 -132 -74 -140', 2.5],
    ['M8 -180 C 20 -190 26 -200 40 -206', 2],
    ['M58 -128 C 66 -150 70 -160 86 -172', 2],
    ['M-50 -150 C -54 -164 -50 -176 -60 -190', 2],
  ];
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill="none" stroke={fill} strokeLinecap="round">
      {branches.map(([d, w]) => (
        <path key={d} d={d} strokeWidth={w} />
      ))}
    </g>
  );
}

/** A horse seen from behind, walking away beside the envoy: hindquarters, tail, a red saddle cloth. */
function HorseFromBehind({ x, foot, fill }: { x: number; foot: number; fill: string }) {
  return (
    <g fill={fill}>
      <ellipse cx={x} cy={foot} rx="20" ry="4" opacity="0.3" />
      <rect x={x - 10} y={foot - 26} width="6" height="26" rx="2" />
      <rect x={x + 4} y={foot - 26} width="6" height="26" rx="2" />
      <ellipse cx={x} cy={foot - 36} rx="14" ry="17" />
      <ellipse cx={x - 4} cy={foot - 60} rx="5" ry="10" />
      <path d={`M${x - 8} ${foot - 70} l-2 -7 l4 3 Z M${x} ${foot - 70} l2 -7 l-4 3 Z`} />
      <path d={`M${x} ${foot - 44} C${x + 3} ${foot - 34} ${x - 2} ${foot - 26} ${x + 2} ${foot - 16}`} stroke={fill} strokeWidth="4" fill="none" strokeLinecap="round" />
      <path d={`M${x - 13} ${foot - 46} Q${x} ${foot - 54} ${x + 13} ${foot - 46} L${x + 11} ${foot - 38} Q${x} ${foot - 44} ${x - 11} ${foot - 38} Z`} fill="#6e2a1f" />
    </g>
  );
}

/** An envoy seen from behind, walking away with the staff of his office (its three tufts). */
function Envoy({ x, foot, s, fill }: { x: number; foot: number; s: number; fill: string }) {
  return (
    <g transform={`translate(${x} ${foot}) scale(${s})`} fill={fill}>
      <ellipse cx="0" cy="0" rx="22" ry="4" opacity="0.3" />
      <path d="M-15 0 C-15 -30 -13 -52 -9 -60 Q0 -66 9 -60 C13 -52 15 -30 15 0 Z" />
      <circle cx="0" cy="-68" r="7" />
      <path d="M-6 -73 h12 v-6 h-12 Z" />
      <path d="M12 -2 L18 -96" stroke={fill} strokeWidth="2.2" />
      {[0, 1, 2].map((i) => (
        <ellipse key={i} cx="18.5" cy={-90 + i * 9} rx="3.2" ry="4.5" />
      ))}
    </g>
  );
}

/** An official seen from behind, standing at the parapet (court hat with long wings), outlined by the light ahead. */
function Watcher({ x, foot, fill, rim }: { x: number; foot: number; fill: string; rim: string }) {
  const robe = `M${x - 30} ${foot} C${x - 30} ${foot - 70} ${x - 27} ${foot - 118} ${x - 20} ${foot - 132} Q${x} ${foot - 142} ${x + 20} ${foot - 132} C${x + 27} ${foot - 118} ${x + 30} ${foot - 70} ${x + 30} ${foot} Z`;
  return (
    <g>
      <g fill={fill}>
        <path d={robe} />
        <circle cx={x} cy={foot - 150} r={13} />
        <rect x={x - 12} y={foot - 172} width={24} height={14} rx={3} />
      </g>
      <path d={`M${x - 42} ${foot - 165} H${x + 42}`} stroke={fill} strokeWidth="3" strokeLinecap="round" />
      <g fill="none" stroke={rim} opacity="0.55">
        <path d={robe} strokeWidth="2" />
        <circle cx={x} cy={foot - 150} r={13} strokeWidth="1.6" />
      </g>
    </g>
  );
}

type Rider = { x: number; s: number; banner?: boolean };
const BACK_RIDERS: Rider[] = Array.from({ length: 15 }, (_, i) => ({ x: 800 + i * 44 + ((i * 13) % 9), s: 0.4 + ((i * 5) % 4) / 50 }));
const FRONT_RIDERS: Rider[] = Array.from({ length: 12 }, (_, i) => ({ x: 760 + i * 55 + ((i * 29) % 11), s: 0.58 + ((i * 7) % 5) / 40, banner: i % 4 === 1 }));
const BIRDS: Array<readonly [number, number, number]> = [
  [1180, 220, 1],
  [1222, 238, 0.8],
  [1146, 252, 0.7],
  [1264, 206, 0.9],
  [1304, 246, 0.6],
];

/** A row of riders on the plain (`ground` is where the hooves stand); some carry tall banners. */
function RiderRow({ riders, ground, fill, rim }: { riders: Rider[]; ground: number; fill: string; rim?: string }) {
  return (
    <g fill={fill} color={fill} stroke={rim} strokeWidth={rim ? 2.4 : undefined} strokeOpacity={rim ? 0.6 : undefined}>
      {riders.map((r) => {
        const top = ground - 100 * r.s;
        return (
          <g key={r.x}>
            <use href="#end-pact-rider" x={r.x} y={top} width={100 * r.s} height={100 * r.s} />
            {r.banner ? (
              <>
                <path d={`M${r.x + 63 * r.s} ${top + 60 * r.s} L${r.x + 68 * r.s} ${top - 46 * r.s}`} stroke={fill} strokeWidth={2.4 * r.s} />
                <path d={`M${r.x + 68 * r.s} ${top - 46 * r.s} l${40 * r.s} ${4 * r.s} l${-8 * r.s} ${10 * r.s} l${8 * r.s} ${10 * r.s} l${-40 * r.s} ${-2 * r.s} Z`} fill="#a63e2d" />
              </>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function PactScene() {
  return (
    <>
      <defs>
        <linearGradient id="end-pact-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b5b6e" />
          <stop offset="0.3" stopColor="#b88a86" />
          <stop offset="0.55" stopColor="#e9b07c" />
          <stop offset="0.7" stopColor="#f8cf8c" />
          <stop offset="1" stopColor="#f4c37a" />
        </linearGradient>
        <radialGradient id="end-pact-bloom">
          <stop offset="0" stopColor="#fff6dc" stopOpacity="0.95" />
          <stop offset="0.18" stopColor="#ffe6ae" stopOpacity="0.75" />
          <stop offset="0.55" stopColor="#ffcf86" stopOpacity="0.22" />
          <stop offset="1" stopColor="#ffcf86" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="end-pact-mist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffe9c6" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffe9c6" stopOpacity="0.6" />
          <stop offset="1" stopColor="#ffe9c6" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="end-pact-plain" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ecbb7c" />
          <stop offset="0.3" stopColor="#c58753" />
          <stop offset="1" stopColor="#6e4428" />
        </linearGradient>
        <linearGradient id="end-pact-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#402d21" />
          <stop offset="1" stopColor="#1d130d" />
        </linearGradient>
        <linearGradient id="end-pact-flag" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8e2f22" />
          <stop offset="0.5" stopColor="#bd4a33" />
          <stop offset="1" stopColor="#9a3426" />
        </linearGradient>
        <linearGradient id="end-pact-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0b0705" stopOpacity="0" />
          <stop offset="1" stopColor="#0b0705" stopOpacity="0.6" />
        </linearGradient>
        <radialGradient id="end-pact-lamp">
          <stop offset="0" stopColor="#ffd88a" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffd88a" stopOpacity="0" />
        </radialGradient>
        <pattern id="end-pact-bricks" width="64" height="24" patternUnits="userSpaceOnUse">
          <path d="M0 0.5 H64 M0 12.5 H64 M16 0 V12 M48 12 V24" stroke="#57402f" strokeWidth="1.3" fill="none" />
        </pattern>
        <filter id="end-pact-wisp" x="-20%" y="-60%" width="140%" height="220%">
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.035" numOctaves="3" seed="3" />
          <feDisplacementMap in="SourceGraphic" scale="46" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id="end-pact-brush" x="0" y="-20%" width="100%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018 0.07" numOctaves="2" seed="7" />
          <feDisplacementMap in="SourceGraphic" scale="12" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
        <filter id="end-pact-dust" x="-20%" y="-80%" width="140%" height="260%">
          <feTurbulence type="fractalNoise" baseFrequency="0.01 0.05" numOctaves="3" seed="11" />
          <feDisplacementMap in="SourceGraphic" scale="40" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="12" />
        </filter>
        <filter id="end-pact-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <symbol id="end-pact-rider" viewBox="0 0 100 100">
          <path d="M8 57 C6 52 10 48 16 47 L22 42 L24 47 C30 48 34 52 38 56 C50 56 64 55 76 58 C84 60 88 66 87 74 L89 80 C86 80 84 82 82 84 L84 99 L80 99 L77 86 L72 84 L70 99 L66 99 L66 82 C56 84 46 84 40 82 L38 99 L34 99 L33 84 L29 99 L25 99 L28 80 C27 74 24 68 22 64 C18 63 13 62 8 60 Z" />
          <path d="M87 62 C95 66 97 78 92 90" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
          <path d="M21 44 C26 41 31 43 35 47 C38 50 40 52 43 54" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <path d="M46 57 L48 34 C49 30 55 30 57 34 L58 57 Z" />
          <circle cx="52.5" cy="27" r="5" />
          <path d="M48 24 L57 24 L52.5 16 Z" />
          <path d="M62 60 L66 2" stroke="currentColor" strokeWidth="2" />
          <path d="M66 3 L80 7 L66 12 Z" fill="#a63e2d" />
        </symbol>
      </defs>
      <rect width="1600" height="900" fill="url(#end-pact-sky)" />
      <circle cx="1080" cy="480" r="520" fill="url(#end-pact-bloom)" />
      <g className="fx-wisp" filter="url(#end-pact-wisp)">
        {PACT_CLOUDS.map(([x, y, w]) => (
          <g key={x}>
            <ellipse cx={x} cy={y} rx={w} ry={w * 0.085} fill="#b98a8a" opacity="0.5" />
            <ellipse cx={x - w * 0.1} cy={y - w * 0.045} rx={w * 0.8} ry={w * 0.065} fill="#f9d6ac" opacity="0.75" />
            <ellipse cx={x + w * 0.15} cy={y - w * 0.075} rx={w * 0.5} ry={w * 0.045} fill="#fff0d2" opacity="0.65" />
          </g>
        ))}
      </g>
      <g className="fx-birds" fill="none" stroke="#4a3b3a" strokeWidth="2.4" strokeLinecap="round">
        {BIRDS.map(([x, y, s]) => (
          <path key={x} d={`M${x} ${y} q${8 * s} ${-8 * s} ${16 * s} 0 q${8 * s} ${-8 * s} ${16 * s} 0`} />
        ))}
      </g>
      <defs>
        <radialGradient id="end-pact-rayfade" cx="1080" cy="480" r="760" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        <mask id="end-pact-raymask">
          <rect width="1600" height="900" fill="url(#end-pact-rayfade)" />
        </mask>
      </defs>
      <g className="fx-rays" filter="url(#end-pact-glow)" fill="#fff1cf" mask="url(#end-pact-raymask)">
        {[-46, -24, -6, 16, 40].map((a) => (
          <path key={a} d={sunRay(1080, 480, a)} />
        ))}
      </g>
      <circle cx="1080" cy="480" r="44" fill="#fff8e4" filter="url(#end-pact-glow)" />
      <path d={ridge(476, 46, 0.6)} fill="#b38886" opacity="0.62" filter="url(#end-pact-brush)" />
      <rect y="440" width="1600" height="100" fill="url(#end-pact-mist)" />
      <path d={ridge(510, 26, 2.2)} fill="#94695a" opacity="0.85" filter="url(#end-pact-brush)" />
      <rect y="492" width="1600" height="70" fill="url(#end-pact-mist)" opacity="0.8" />
      <path d="M0 538 C 300 526, 700 546, 1000 532 S 1400 542, 1600 528 L1600 900 L0 900 Z" fill="url(#end-pact-plain)" />
      <g className="fx-drift" filter="url(#end-pact-dust)" fill="#f2d3a0" opacity="0.85">
        <ellipse cx="1050" cy="524" rx="380" ry="36" />
        <ellipse cx="1350" cy="516" rx="240" ry="28" />
        <ellipse cx="830" cy="532" rx="170" ry="22" />
      </g>
      <RiderRow riders={BACK_RIDERS} ground={532} fill="#8b6a52" />
      <RiderRow riders={FRONT_RIDERS} ground={550} fill="#3a281e" rim="#ffd58f" />
      <g className="fx-drift-slow" filter="url(#end-pact-dust)" fill="#f4dcae" opacity="0.6">
        <ellipse cx="1000" cy="554" rx="430" ry="20" />
      </g>
      <rect y="480" width="1600" height="110" fill="url(#end-pact-mist)" opacity="0.3" />
      <Watcher x={650} foot={704} fill="#22160f" rim="#ffd79a" />
      <path d="M1480 700 L1480 390" stroke="#22160f" strokeWidth="7" />
      <g className="fx-flag">
        <path d="M1483 394 C1520 382 1560 406 1610 390 L1610 472 C1560 488 1520 464 1483 476 Z" fill="url(#end-pact-flag)" />
        <path d="M1483 435 C1520 423 1560 447 1610 431" fill="none" stroke="#7a271c" strokeWidth="3" opacity="0.6" />
      </g>
      <GateTower cx={260} base={598} fill="#2a1c14" detail="#4a3628" rim="#ffcf8c" />
      {[110, 410].map((x) => (
        <g key={x}>
          <circle cx={x} cy={510} r={30} fill="url(#end-pact-lamp)" />
          <rect x={x - 6} y={502} width={12} height={17} rx={3} fill="#f6c46c" />
        </g>
      ))}
      <Parapet top={640} fill="url(#end-pact-wall)" bricks="url(#end-pact-bricks)" rim="#ffcf8c" />
      <rect y="660" width="1600" height="240" fill="url(#end-pact-shade)" />
      {/* Light bleeding over the riders. */}
      <circle cx="1080" cy="480" r="320" fill="url(#end-pact-bloom)" opacity="0.35" style={{ mixBlendMode: 'screen' }} />
    </>
  );
}

/** Jinyang falls, seen from a distance: fires behind the wall, smoke over the city, a breach, ladders and torn banners. */
function FallScene() {
  return (
    <>
      <defs>
        <linearGradient id="end-fall-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b1716" />
          <stop offset="0.42" stopColor="#3a302c" />
          <stop offset="0.68" stopColor="#6e4a36" />
          <stop offset="1" stopColor="#97582f" />
        </linearGradient>
        <radialGradient id="end-fall-fire" cx="780" cy="530" r="760" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffb25e" stopOpacity="0.8" />
          <stop offset="0.35" stopColor="#e0662f" stopOpacity="0.42" />
          <stop offset="1" stopColor="#e0662f" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="end-fall-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c2019" />
          <stop offset="1" stopColor="#140e0b" />
        </linearGradient>
        <linearGradient id="end-fall-ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a271d" />
          <stop offset="0.4" stopColor="#1e1510" />
          <stop offset="1" stopColor="#0b0807" />
        </linearGradient>
        <linearGradient id="end-fall-haze" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#161211" stopOpacity="0.55" />
          <stop offset="1" stopColor="#161211" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="end-fall-ember">
          <stop offset="0" stopColor="#ffe2a0" />
          <stop offset="0.4" stopColor="#ff9f4f" stopOpacity="0.8" />
          <stop offset="1" stopColor="#ff9f4f" stopOpacity="0" />
        </radialGradient>
        <pattern id="end-fall-bricks" width="40" height="14" patternUnits="userSpaceOnUse">
          <path d="M0 0.5 H40 M0 7.5 H40 M10 0 V7 M30 7 V14" stroke="#3b2a20" strokeWidth="1" fill="none" />
        </pattern>
        <filter id="end-fall-billow" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="4" seed="21" />
          <feDisplacementMap in="SourceGraphic" scale="70" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="12" />
        </filter>
        <filter id="end-fall-brush" x="0" y="-20%" width="100%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.08" numOctaves="2" seed="13" />
          <feDisplacementMap in="SourceGraphic" scale="12" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="end-fall-glow" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter id="end-fall-bloom" x="-20%" y="-100%" width="140%" height="300%">
          <feGaussianBlur stdDeviation="24" />
        </filter>
      </defs>
      <rect width="1600" height="900" fill="url(#end-fall-sky)" />
      <rect width="1600" height="900" fill="url(#end-fall-fire)" />
      <g className="fx-wisp" filter="url(#end-fall-billow)" fill="#141110" opacity="0.78">
        <ellipse cx="280" cy="130" rx="400" ry="96" />
        <ellipse cx="900" cy="80" rx="480" ry="110" />
        <ellipse cx="1420" cy="160" rx="360" ry="92" />
      </g>
      <g className="fx-wisp" filter="url(#end-fall-billow)" fill="#8a3f22" opacity="0.45" style={{ mixBlendMode: 'screen' }}>
        <ellipse cx="300" cy="206" rx="360" ry="40" />
        <ellipse cx="900" cy="170" rx="420" ry="46" />
        <ellipse cx="1420" cy="232" rx="320" ry="38" />
      </g>
      {/* The city sits high in the frame, above the band the ending's title is laid over. */}
      <g transform="translate(0 -90)">
        <path d={ridge(500, 34, 1.4)} fill="#2a211e" opacity="0.9" filter="url(#end-fall-brush)" />
        <g className="fx-smoke" filter="url(#end-fall-billow)">
          {SMOKE_COLUMNS.flatMap(([x, s]) =>
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => (
              <ellipse key={`${x}-${k}`} cx={x + k * k * 4 * s} cy={590 - k * 60 * s} rx={(44 + k * 20) * s} ry={(40 + k * 16) * s} fill={k < 2 ? '#6a3f2a' : k < 5 ? '#2a2220' : '#1d1817'} opacity={0.9 - k * 0.06} />
            )),
          )}
        </g>
        <g filter="url(#end-fall-billow)" style={{ mixBlendMode: 'screen' }}>
          {SMOKE_COLUMNS.flatMap(([x, s]) =>
            [0, 1, 2, 3].map((k) => (
              <ellipse key={`${x}-lit-${k}`} cx={x + k * k * 4 * s} cy={608 - k * 60 * s} rx={(38 + k * 17) * s} ry={(22 + k * 8) * s} fill="#c4622f" opacity={0.5 - k * 0.1} />
            )),
          )}
        </g>
        <rect x="150" y="500" width="1300" height="110" fill="#ff8a3d" opacity="0.4" filter="url(#end-fall-bloom)" style={{ mixBlendMode: 'screen' }} />
        <path d={flameTongues(190, 1410, 604, 1, SMOKE_COLUMNS)} fill="#d4471c" opacity="0.9" filter="url(#end-fall-glow)" />
        <path d={flameTongues(190, 1410, 604, 0.72, SMOKE_COLUMNS)} fill="#f28a35" />
        <path d={flameTongues(190, 1410, 604, 0.45, SMOKE_COLUMNS)} fill="#ffcd6a" />
        <path d={flameTongues(190, 1410, 604, 0.22, SMOKE_COLUMNS)} fill="#fff1c2" />
        <Parapet top={600} fill="url(#end-fall-wall)" bricks="url(#end-fall-bricks)" rim="#ff9c55" merlon={[30, 22, 48]} gap={[1060, 1170]} slits={false} />
        <path d="M1060 600 L1060 700 L1086 700 L1074 676 L1088 650 L1070 628 Z M1170 600 L1170 700 L1146 700 L1158 670 L1142 646 L1160 622 Z" fill="url(#end-fall-wall)" />
        <path d="M1084 700 Q1115 636 1146 700 Z" fill="#ff9f4f" opacity="0.5" filter="url(#end-fall-glow)" />
        <path d="M1048 700 L1076 666 L1098 680 L1118 658 L1140 676 L1160 662 L1184 700 Z" fill="#1d1511" />
        <GateTower cx={700} base={578} s={0.86} broken fill="#1d1511" detail="#3a2a20" rim="#ff9c55" />
        <path d="M666 700 V662 Q700 628 734 662 V700 Z" fill="#ffb25e" opacity="0.85" filter="url(#end-fall-glow)" />
        <path d="M672 700 V664 Q700 636 728 664 V700 Z" fill="#ffd38c" opacity="0.9" />
        {FALL_BANNERS.map(([x, tilt]) => (
          <g key={x} transform={`rotate(${tilt} ${x} 578)`}>
            <path d={`M${x} 578 V452`} stroke="#140e0b" strokeWidth="5" />
            <path className="fx-sway" d={`M${x + 2} 456 c22 -6 40 8 64 2 v40 c-24 6 -42 -8 -64 -2 Z`} fill="#7e271c" />
          </g>
        ))}
        <path d="M1186 578 V532" stroke="#140e0b" strokeWidth="5" />
        <path d="M1188 536 l16 3 l-5 36 l-11 -6 Z" fill="#6a2219" />
        <g stroke="#0f0a08" strokeWidth="4" strokeLinecap="round">
          {LADDERS.map((x) => (
            <g key={x}>
              <path d={`M${x} 700 L${x + 30} 586 M${x + 22} 700 L${x + 52} 586`} />
              {[1, 2, 3, 4, 5].map((i) => (
                <path key={i} d={`M${x + 5 * i} ${700 - 19 * i} H${x + 22 + 5 * i}`} />
              ))}
            </g>
          ))}
        </g>
        <g fill="#0f0a08">
          {SOLDIERS.map(([x, y]) => (
            <g key={`${x}-${y}`}>
              <circle cx={x} cy={y - 21} r={3.4} />
              <path d={`M${x - 4} ${y} L${x - 3} ${y - 17} H${x + 3} L${x + 4} ${y} Z`} />
            </g>
          ))}
        </g>
        <rect y="700" width="1600" height="300" fill="url(#end-fall-ground)" />
      </g>
      {/* What the battle left in front of the walls, edged by the firelight behind. */}
      <g>
        <circle cx="200" cy="826" r="78" fill="none" stroke="#0a0706" strokeWidth="13" />
        <circle cx="200" cy="826" r="13" fill="#0a0706" />
        <g stroke="#0a0706" strokeWidth="6" strokeLinecap="round">
          {[0, 45, 90, 180, 225, 315].map((a) => (
            <path key={a} d={`M200 826 l${(70 * Math.cos((a * Math.PI) / 180)).toFixed(1)} ${(70 * Math.sin((a * Math.PI) / 180)).toFixed(1)}`} />
          ))}
        </g>
        <path d="M131 790 A78 78 0 0 1 238 758" fill="none" stroke="#ff9a50" strokeWidth="2" opacity="0.45" />
      </g>
      <path d="M0 900 L0 806 C 200 776, 420 826, 640 796 S 1100 806, 1300 776 S 1520 796, 1600 786 L1600 900 Z" fill="#0b0807" />
      <g stroke="#0b0807" strokeWidth="4" strokeLinecap="round">
        <path d="M640 796 L612 704" />
        <path d="M688 800 L706 718" />
        <path d="M1084 790 L1052 702" />
      </g>
      <path d="M30 900 L420 676" stroke="#0a0706" strokeWidth="9" strokeLinecap="round" />
      <path d="M420 676 c26 6 52 -4 80 6 l-10 30 l14 26 c-30 -8 -54 2 -80 -6 Z" fill="#5e1d16" />
      <path d="M420 676 c26 6 52 -4 80 6" fill="none" stroke="#ff9a50" strokeWidth="2" opacity="0.5" />
      <g stroke="#0a0706" strokeWidth="8" strokeLinecap="round">
        <path d="M1290 812 H1600" />
        {[1320, 1390, 1460, 1530].map((x) => (
          <path key={x} d={`M${x - 34} ${852} L${x + 34} ${762} M${x - 34} ${762} L${x + 34} ${852}`} />
        ))}
      </g>
      <g stroke="#ff9a50" strokeWidth="2" opacity="0.4" strokeLinecap="round">
        {[1320, 1390, 1460, 1530].map((x) => (
          <path key={x} d={`M${x - 34} ${762} l12 16 M${x + 34} ${762} l-12 16`} />
        ))}
      </g>
      <g className="fx-embers">
        {EMBERS.map(([x, y, r], i) => (
          <g key={`${x}-${y}`}>
            <circle cx={x} cy={y} r={r * 3} fill="url(#end-fall-ember)" opacity="0.6" />
            <circle cx={x} cy={y} r={r * 0.7} fill="#ffe6b0" />
            {i % 3 === 0 ? <path d={`M${x} ${y} l${-4 - r} ${-12 - r * 3}`} stroke="#ffd08a" strokeWidth="1.6" opacity="0.7" strokeLinecap="round" /> : null}
          </g>
        ))}
      </g>
      <rect width="1600" height="420" fill="url(#end-fall-haze)" />
    </>
  );
}

/** Standing alone at dusk: the gate of Jinyang with its lamps lit, an empty road, a bare tree and a new moon. */
function AloneScene() {
  return (
    <>
      <defs>
        <linearGradient id="end-alone-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#121a29" />
          <stop offset="0.4" stopColor="#283652" />
          <stop offset="0.68" stopColor="#56607b" />
          <stop offset="0.84" stopColor="#9c8b99" />
          <stop offset="1" stopColor="#b8a097" />
        </linearGradient>
        <radialGradient id="end-alone-moonglow">
          <stop offset="0" stopColor="#f4ecd6" stopOpacity="0.45" />
          <stop offset="1" stopColor="#f4ecd6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="end-alone-afterglow">
          <stop offset="0" stopColor="#e9ad86" stopOpacity="0.62" />
          <stop offset="0.5" stopColor="#c08c9b" stopOpacity="0.22" />
          <stop offset="1" stopColor="#c08c9b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="end-alone-mist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b9bdd2" stopOpacity="0" />
          <stop offset="0.5" stopColor="#b9bdd2" stopOpacity="0.42" />
          <stop offset="1" stopColor="#b9bdd2" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="end-alone-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1b2434" />
          <stop offset="1" stopColor="#0d131c" />
        </linearGradient>
        <linearGradient id="end-alone-ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#262f40" />
          <stop offset="1" stopColor="#0e131b" />
        </linearGradient>
        <linearGradient id="end-alone-road" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6a7184" />
          <stop offset="1" stopColor="#3c4354" />
        </linearGradient>
        <radialGradient id="end-alone-lamp">
          <stop offset="0" stopColor="#ffd98a" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffd98a" stopOpacity="0" />
        </radialGradient>
        <pattern id="end-alone-bricks" width="44" height="16" patternUnits="userSpaceOnUse">
          <path d="M0 0.5 H44 M0 8.5 H44 M11 0 V8 M33 8 V16" stroke="#243047" strokeWidth="1" fill="none" />
        </pattern>
        <filter id="end-alone-brush" x="0" y="-20%" width="100%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018 0.07" numOctaves="2" seed="17" />
          <feDisplacementMap in="SourceGraphic" scale="12" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
        <filter id="end-alone-wisp" x="-20%" y="-60%" width="140%" height="220%">
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.035" numOctaves="3" seed="5" />
          <feDisplacementMap in="SourceGraphic" scale="40" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id="end-alone-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter id="end-alone-bloom" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
        <linearGradient id="end-alone-pool" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffcf7a" stopOpacity="0.5" />
          <stop offset="0.55" stopColor="#ffcf7a" stopOpacity="0.12" />
          <stop offset="1" stopColor="#ffcf7a" stopOpacity="0" />
        </linearGradient>
        <mask id="end-alone-crescent">
          <circle cx="1250" cy="150" r="30" fill="#fff" />
          <circle cx="1263" cy="141" r="27" fill="#000" />
        </mask>
      </defs>
      <rect width="1600" height="900" fill="url(#end-alone-sky)" />
      <g fill="#eef2fa">
        {STARS.map(([x, y, r]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={r} opacity={0.35 + (r - 1) * 0.3} />
        ))}
      </g>
      <g fill="#f4f7ff" opacity="0.85">
        {BRIGHT_STARS.map(([x, y]) => (
          <path key={x} d={`M${x} ${y - 7} L${x + 1.3} ${y - 1.3} L${x + 7} ${y} L${x + 1.3} ${y + 1.3} L${x} ${y + 7} L${x - 1.3} ${y + 1.3} L${x - 7} ${y} L${x - 1.3} ${y - 1.3} Z`} />
        ))}
      </g>
      {/* The last of the daylight low in the west, against the cold moon in the east. */}
      <ellipse cx="320" cy="370" rx="820" ry="170" fill="url(#end-alone-afterglow)" />
      <circle cx="1250" cy="150" r="110" fill="url(#end-alone-moonglow)" />
      <circle cx="1250" cy="150" r="64" fill="none" stroke="#e8e0c8" strokeWidth="1.5" opacity="0.14" />
      <circle cx="1250" cy="150" r="30" fill="#f4ecd6" mask="url(#end-alone-crescent)" />
      <g className="fx-wisp" filter="url(#end-alone-wisp)">
        <ellipse cx="380" cy="360" rx="320" ry="18" fill="#3c4864" opacity="0.6" />
        <ellipse cx="1100" cy="300" rx="260" ry="14" fill="#3c4864" opacity="0.5" />
        <ellipse cx="760" cy="430" rx="420" ry="16" fill="#c7a3a8" opacity="0.45" />
        <ellipse cx="1380" cy="420" rx="240" ry="12" fill="#c7a3a8" opacity="0.4" />
      </g>
      <g className="fx-birds" fill="none" stroke="#141a26" strokeWidth="2.2" strokeLinecap="round">
        {BIRDS.map(([x, y, s]) => (
          <path key={x} d={`M${x + 60} ${y + 40} q${7 * s} ${-7 * s} ${14 * s} 0 q${7 * s} ${-7 * s} ${14 * s} 0`} />
        ))}
      </g>
      {/* The wall and its gate sit high in the frame, above the band the ending's title is laid over. */}
      <g transform="translate(0 -50)">
        <path d={ridge(452, 54, 3.1)} fill="#3d4963" opacity="0.9" filter="url(#end-alone-brush)" />
        <rect y="420" width="1600" height="110" fill="url(#end-alone-mist)" />
        <path d={ridge(500, 28, 4.2)} fill="#2a3348" filter="url(#end-alone-brush)" />
        <rect y="480" width="1600" height="90" fill="url(#end-alone-mist)" opacity="0.6" />
        <Parapet top={560} fill="url(#end-alone-wall)" bricks="url(#end-alone-bricks)" rim="#9fb0d0" merlon={[40, 28, 64]} slits={false} />
        <GateTower cx={600} base={532} s={0.82} fill="#131a26" detail="#26324a" rim="#a9b8d6" lit="#f3c56b" />
        <g className="fx-flicker">
          {WALL_LAMPS.map(([x, y]) => (
            <g key={x}>
              <circle cx={x} cy={y} r="26" fill="url(#end-alone-lamp)" />
              <rect x={x - 5} y={y - 8} width="10" height="15" rx="3" fill="#f5c870" />
            </g>
          ))}
        </g>
        <path d="M560 700 V650 Q600 610 640 650 V700 Z" fill="#e9b05c" opacity="0.92" filter="url(#end-alone-glow)" />
        <path d="M566 700 V652 Q600 618 634 652 V700 Z" fill="#ffd894" />
        <g filter="url(#end-alone-bloom)" fill="#ffcf7a" opacity="0.5" style={{ mixBlendMode: 'screen' }}>
          {WALL_LAMPS.map(([x, y]) => (
            <circle key={x} cx={x} cy={y} r="16" />
          ))}
          <ellipse cx="600" cy="668" rx="52" ry="40" />
          <rect x="500" y="468" width="204" height="44" />
          <rect x="542" y="372" width="110" height="30" />
        </g>
      </g>
      <rect y="650" width="1600" height="250" fill="url(#end-alone-ground)" />
      <g fill="#0f1520">
        {DUSK_TREES.map(([x, h]) => (
          <g key={x}>
            <path d={`M${x} 652 V${652 - h * 0.45}`} stroke="#0f1520" strokeWidth="3" />
            <ellipse cx={x} cy={652 - h * 0.62} rx={h * 0.22} ry={h * 0.42} />
          </g>
        ))}
      </g>
      <path d="M572 650 L628 650 L1080 900 L300 900 Z" fill="url(#end-alone-road)" />
      <path d="M566 652 L634 652 L880 900 L320 900 Z" fill="url(#end-alone-pool)" style={{ mixBlendMode: 'screen' }} />
      <path d="M590 652 L470 900 M610 652 L860 900" stroke="#2f3646" strokeWidth="4" opacity="0.7" />
      <g stroke="#0e131b" strokeWidth="2.5" strokeLinecap="round">
        {[0, 1, 2, 3, 4, 5].map((i) => {
          // Tufts of grass just outside both edges of the road.
          const y = 700 + i * 30;
          const left = 560 - (y - 650) * 1.088;
          const right = 638 + (y - 650) * 1.808;
          return (
            <g key={i}>
              <path d={`M${left} ${y} l-6 -14 M${left + 4} ${y} l4 -16`} />
              <path d={`M${right} ${y} l-5 -14 M${right + 4} ${y} l6 -15`} />
            </g>
          );
        })}
      </g>
      <BareTree x={1290} y={772} s={1.15} fill="#0c1119" />
      <path d="M948 812 V772 Q962 752 976 772 V812 Z" fill="#232c3d" />
      <path d="M948 790 V772 Q962 752 976 772" fill="none" stroke="#8d9bb8" strokeWidth="2" opacity="0.4" />
      <g className="fx-wisp" filter="url(#end-alone-wisp)" fill="#9aa6c4">
        <ellipse cx="300" cy="716" rx="420" ry="14" opacity="0.26" />
        <ellipse cx="1120" cy="748" rx="520" ry="16" opacity="0.22" />
        <ellipse cx="700" cy="810" rx="640" ry="18" opacity="0.16" />
      </g>
      <rect className="fx-dusk" width="1600" height="900" fill="#0a1020" />
    </>
  );
}

/** The road closes: the returned letter lands on the desk; through the open door the envoy walks away into the mist. */
function ClosedScene() {
  return (
    <>
      <defs>
        <linearGradient id="end-closed-wall" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#171d23" />
          <stop offset="1" stopColor="#252e37" />
        </linearGradient>
        <linearGradient id="end-closed-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e9eeec" />
          <stop offset="1" stopColor="#bcc9cc" />
        </linearGradient>
        <linearGradient id="end-closed-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a2026" />
          <stop offset="1" stopColor="#0a0d10" />
        </linearGradient>
        <linearGradient id="end-closed-desk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a2a20" />
          <stop offset="1" stopColor="#140e0a" />
        </linearGradient>
        <linearGradient id="end-closed-shaft" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dfe7ea" stopOpacity="0.3" />
          <stop offset="1" stopColor="#dfe7ea" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="end-closed-mist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2f5f4" stopOpacity="0" />
          <stop offset="0.5" stopColor="#f2f5f4" stopOpacity="0.75" />
          <stop offset="1" stopColor="#f2f5f4" stopOpacity="0" />
        </linearGradient>
        <pattern id="end-closed-lattice" width="30" height="30" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 15 H30 M15 0 V30" stroke="#18120e" strokeWidth="4" fill="none" />
        </pattern>
        <linearGradient id="end-closed-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d6ddd9" />
          <stop offset="1" stopColor="#9aa7a8" />
        </linearGradient>
        <clipPath id="end-closed-pane">
          <rect x="250" y="250" width="310" height="290" />
        </clipPath>
        <filter id="end-closed-shade" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
        <clipPath id="end-closed-door">
          <rect x="780" y="180" width="320" height="540" />
        </clipPath>
        <filter id="end-closed-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <filter id="end-closed-brush" x="0" y="-20%" width="100%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.08" numOctaves="2" seed="23" />
          <feDisplacementMap in="SourceGraphic" scale="10" xChannelSelector="R" yChannelSelector="G" />
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>
      <rect width="1600" height="900" fill="url(#end-closed-wall)" />
      <defs>
        <radialGradient id="end-closed-doorglow" cx="940" cy="460" r="560" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#cfd8dc" stopOpacity="0.2" />
          <stop offset="1" stopColor="#cfd8dc" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1600" height="900" fill="url(#end-closed-doorglow)" />
      <g stroke="#1e262e" strokeWidth="2">
        {[260, 330, 400, 470, 540, 610, 680, 1180, 1250, 1320].map((x) => (
          <path key={x} d={`M${x} 160 V720`} />
        ))}
      </g>
      <g>
        <path d="M1285 180 L1250 214 M1285 180 L1320 214" stroke="#3a2b21" strokeWidth="2" fill="none" />
        <circle cx="1285" cy="178" r="4" fill="#3a2b21" />
        <rect x="1236" y="214" width="98" height="320" fill="#4a3a2c" />
        <rect x="1246" y="236" width="78" height="270" fill="#d8cdb2" />
        <path d="M1246 470 L1270 420 L1284 440 L1300 392 L1324 452 V506 H1246 Z" fill="#8e8778" opacity="0.8" />
        <path d="M1252 446 L1266 412 L1278 428" fill="none" stroke="#5f594d" strokeWidth="2" />
        <path d="M1246 432 Q1285 422 1324 430" fill="none" stroke="#e4dcc6" strokeWidth="7" opacity="0.6" />
        <rect x="1306" y="484" width="10" height="12" fill="#a63e2d" />
        <rect x="1228" y="208" width="114" height="8" rx="3" fill="#2a1f19" />
        <rect x="1226" y="532" width="118" height="10" rx="4" fill="#2a1f19" />
      </g>
      {/* A paper window in a diamond lattice; bamboo outside throws its shadow on the paper. */}
      <rect x="250" y="250" width="310" height="290" fill="url(#end-closed-paper)" opacity="0.75" />
      <g clipPath="url(#end-closed-pane)">
        <g fill="#33424a" opacity="0.45" filter="url(#end-closed-shade)">
          <g fill="none" stroke="#33424a" strokeLinecap="round">
            <path d="M300 560 L334 240" strokeWidth="9" />
            <path d="M522 560 L500 240" strokeWidth="7" />
            <path d="M503 290 Q480 272 452 268" strokeWidth="3" />
          </g>
          {BAMBOO_NODES.map(([x, y]) => (
            <ellipse key={`${x}-${y}`} cx={x} cy={y} rx="8" ry="2.5" />
          ))}
          {BAMBOO_LEAVES.map(([x, y, a], i) => (
            <path key={`${x}-${y}-${a}`} d="M0 0 C18 -7 46 -6 74 4 C46 4 18 5 0 0 Z" transform={`translate(${x} ${y}) rotate(${a}) scale(${0.8 + (i % 3) * 0.12})`} />
          ))}
        </g>
      </g>
      <rect x="250" y="250" width="310" height="290" fill="url(#end-closed-lattice)" />
      <rect x="268" y="268" width="274" height="254" fill="none" stroke="#18120e" strokeWidth="6" />
      <rect x="250" y="250" width="310" height="290" fill="none" stroke="#120e0b" strokeWidth="14" />
      <path d="M250 540 L560 540 L720 880 L300 880 Z" fill="url(#end-closed-shaft)" opacity="0.5" filter="url(#end-closed-soft)" />
      <g clipPath="url(#end-closed-door)">
        <rect x="780" y="180" width="320" height="540" fill="url(#end-closed-sky)" />
        <circle cx="1010" cy="330" r="36" fill="#fffaf0" opacity="0.6" filter="url(#end-closed-soft)" />
        <circle cx="1010" cy="330" r="14" fill="#fffdf6" opacity="0.8" />
        <path d={ridge(560, 30, 5.3)} fill="#b7c3c6" opacity="0.8" filter="url(#end-closed-brush)" />
        <path d={ridge(600, 18, 6.1)} fill="#a3b0b4" filter="url(#end-closed-brush)" />
        <g fill="#9fadb1" opacity="0.75">
          {[822, 848, 1062, 1084].map((x, i) => (
            <ellipse key={x} cx={x} cy={584 - (i % 2) * 6} rx="9" ry={22 + (i % 2) * 6} />
          ))}
        </g>
        <rect x="780" y="590" width="320" height="130" fill="#93a2a6" />
        <path d="M925 600 L955 600 L1060 720 L820 720 Z" fill="#cfd7d7" />
        <rect x="780" y="540" width="320" height="90" fill="url(#end-closed-mist)" />
        <g className="fx-walk">
          <HorseFromBehind x={904} foot={652} fill="#20262b" />
          <Envoy x={942} foot={652} s={1} fill="#20262b" />
        </g>
      </g>
      <path d="M700 150 L780 180 L780 720 L700 760 Z" fill="#241a14" />
      <path d="M1180 150 L1100 180 L1100 720 L1180 760 Z" fill="#241a14" />
      <path d="M716 260 L766 276 V420 L716 410 Z M716 470 L766 474 V640 L716 650 Z M1164 260 L1114 276 V420 L1164 410 Z M1164 470 L1114 474 V640 L1164 650 Z" fill="none" stroke="#3a2b21" strokeWidth="3" />
      <rect x="766" y="166" width="348" height="568" fill="none" stroke="#120e0b" strokeWidth="22" />
      <g fill="#e6eef0" opacity="0.07" filter="url(#end-closed-soft)" style={{ mixBlendMode: 'screen' }}>
        <path d="M800 230 L840 230 L720 900 L620 900 Z" />
        <path d="M900 200 L960 200 L960 900 L840 900 Z" />
        <path d="M1040 230 L1080 230 L1300 900 L1180 900 Z" />
      </g>
      <rect y="720" width="1600" height="180" fill="url(#end-closed-floor)" />
      <rect x="760" y="712" width="360" height="16" fill="#1c1510" />
      <path d="M780 728 L1100 728 L1440 900 L460 900 Z" fill="url(#end-closed-shaft)" filter="url(#end-closed-soft)" />
      <g className="fx-motes" fill="#eef3f4">
        {MOTES.map(([x, y, r]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r={r} opacity="0.55" />
        ))}
      </g>
      <rect x="120" width="72" height="900" fill="#110d0a" />
      <rect x="1410" width="72" height="900" fill="#110d0a" />
      <rect y="96" width="1600" height="54" fill="#110d0a" />
      <path d="M0 772 L1600 772 L1600 900 L0 900 Z" fill="url(#end-closed-desk)" />
      <path d="M0 772 H1600" stroke="#5a4332" strokeWidth="5" />
      <g stroke="#4a372b" strokeWidth="2" opacity="0.45" fill="none">
        <path d="M0 800 C 300 794, 700 806, 1100 798 S 1500 802, 1600 798" />
        <path d="M0 836 C 260 830, 640 842, 1020 834 S 1460 838, 1600 834" />
        <path d="M0 870 C 320 864, 720 876, 1120 868 S 1500 872, 1600 868" />
      </g>
      <g transform="translate(1010 768) rotate(4)">
        <g className="fx-drop">
          <rect x="8" y="10" width="374" height="128" fill="#000" opacity="0.35" filter="url(#end-closed-soft)" />
          <path d="M0 0 H372 Q384 6 380 18 V128 H0 Z" fill="#e6dcc3" />
          <path d="M372 0 Q384 6 380 18 Q370 12 372 0 Z" fill="#c9bc9c" />
          <g stroke="#8d8370" strokeWidth="3" strokeLinecap="round">
            {Array.from({ length: 11 }, (_, i) => (
              <path key={i} d={`M${336 - i * 26} 16 V${i % 3 === 2 ? 70 : 104}`} />
            ))}
          </g>
          <rect x="26" y="72" width="36" height="36" fill="#a63e2d" />
          <rect x="36" y="82" width="16" height="16" fill="#e6dcc3" opacity="0.5" />
        </g>
      </g>
      <rect x="300" y="804" width="150" height="54" rx="10" fill="#121212" />
      <ellipse cx="352" cy="826" rx="34" ry="12" fill="#1d2328" />
      <path d="M470 840 q12 -14 24 0 q12 -14 24 0" fill="none" stroke="#2b221b" strokeWidth="6" />
      <path d="M456 830 L550 812" stroke="#5a4330" strokeWidth="7" strokeLinecap="round" />
      <path d="M546 813 L560 810" stroke="#1a1a1a" strokeWidth="7" strokeLinecap="round" />
      <ellipse cx="640" cy="834" rx="34" ry="10" fill="#5e4a2e" />
      <rect x="630" y="770" width="20" height="62" rx="2" fill="#e8dfc8" />
      <path d="M640 770 V760" stroke="#1a1a1a" strokeWidth="2" />
      <circle cx="640" cy="759" r="8" fill="#ff9a4a" opacity="0.35" filter="url(#end-closed-soft)" />
      <circle cx="640" cy="759" r="2.5" fill="#ffb066" />
      <path className="fx-thread" d="M640 758 C632 736 650 720 640 698 S 628 664 644 640" fill="none" stroke="#aab4b8" strokeWidth="2" opacity="0.5" />
    </>
  );
}

const SCENES: Record<EndingKind, () => ReactNode> = {
  pact_concluded: PactScene,
  jinyang_falls: FallScene,
  no_assistance: AloneScene,
  talks_failed: ClosedScene,
};

export function EndingScene({ kind }: { kind: EndingKind }) {
  const Scene = SCENES[kind];
  return (
    <svg viewBox={VIEW} preserveAspectRatio="xMidYMid slice" role="img" aria-label={ENDINGS[kind].alt}>
      <Scene />
    </svg>
  );
}

const NORTH_ROUTE = 'M720 470 C 860 400, 1040 270, 1220 170';

/** Ink mountains in the old map manner: a few peaks shaded from the top. */
function Peaks({ x, y, s }: { x: number; y: number; s: number }) {
  const outline = `M${x - 62 * s} ${y} L${x - 30 * s} ${y - 46 * s} L${x - 12 * s} ${y - 24 * s} L${x + 12 * s} ${y - 66 * s} L${x + 44 * s} ${y - 20 * s} L${x + 62 * s} ${y}`;
  return (
    <g>
      <path d={`${outline} Z`} fill="url(#end-map-peak)" />
      <path d={outline} fill="none" stroke="#6b5440" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      <path d={`M${x + 12 * s} ${y - 66 * s} L${x + 2 * s} ${y - 28 * s} M${x - 30 * s} ${y - 46 * s} L${x - 37 * s} ${y - 18 * s}`} stroke="#6b5440" strokeWidth="1.4" opacity="0.55" />
    </g>
  );
}

/** A walled city: square wall, merlons and a gate. */
function City({ x, y, size, className, label }: { x: number; y: number; size: number; className: string; label: string }) {
  const h = size / 2;
  return (
    <g className={`cg-place ${className}`}>
      <rect x={x - h} y={y - h} width={size} height={size} rx="3" />
      {[-h, -5, h - 10].map((dx) => (
        <rect key={dx} x={x + dx} y={y - h - 7} width="10" height="8" />
      ))}
      <path className="cg-gate" d={`M${x - 6} ${y + h} v-11 a6 6 0 0 1 12 0 v11 Z`} />
      <text className="cg-label" x={x} y={y + h + 42}>
        {label}
      </text>
    </g>
  );
}

/** The map's last move before the illustration: a reply rides in, the camps close in, or the road north goes dark. */
export function EndingMap({ kind }: { kind: EndingKind }) {
  const courier = kind === 'pact_concluded' || kind === 'talks_failed';
  return (
    <svg className="cg-map" viewBox={VIEW} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id="end-map-paper" cx="0.5" cy="0.45" r="0.8">
          <stop offset="0" stopColor="#f3e8cf" />
          <stop offset="0.7" stopColor="#e3d0a8" />
          <stop offset="1" stopColor="#b8956a" />
        </radialGradient>
        <linearGradient id="end-map-peak" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7d6448" stopOpacity="0.7" />
          <stop offset="1" stopColor="#7d6448" stopOpacity="0" />
        </linearGradient>
        <filter id="end-map-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.42  0 0 0 0 0.3  0 0 0 0 0.18  0 0 0 0.45 0" />
        </filter>
        <filter id="end-map-stain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.0035" numOctaves="2" seed="9" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.55  0 0 0 0 0.4  0 0 0 0 0.22  0 0 0 0.7 -0.25" />
        </filter>
        <filter id="end-map-brush" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="4" />
          <feDisplacementMap in="SourceGraphic" scale="7" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <path id="end-map-north" d={NORTH_ROUTE} />
      </defs>
      <rect width="1600" height="900" fill="url(#end-map-paper)" />
      <rect width="1600" height="900" filter="url(#end-map-stain)" />
      <rect width="1600" height="900" filter="url(#end-map-grain)" opacity="0.55" />
      <g fill="none" stroke="#6b5440">
        <rect x="26" y="26" width="1548" height="848" strokeWidth="3" />
        <rect x="38" y="38" width="1524" height="824" strokeWidth="1.2" />
        {MAP_CORNERS.map(([cx, cy]) => (
          <rect key={`${cx}-${cy}`} x={cx - 10} y={cy - 10} width="20" height="20" fill="#e3d0a8" strokeWidth="2" />
        ))}
      </g>
      <g filter="url(#end-map-brush)" fill="none" strokeLinecap="round">
        <path d="M250 80 C 300 260, 250 420, 320 600 S 480 730, 640 728 S 1100 760, 1560 730" stroke="#8fa5a7" strokeWidth="13" opacity="0.6" />
        <path d="M712 490 C 660 560, 560 600, 470 660 S 360 700, 330 690" stroke="#8fa5a7" strokeWidth="7" opacity="0.6" />
      </g>
      <g filter="url(#end-map-brush)">
        {PEAKS.map(([x, y, s]) => (
          <Peaks key={`${x}-${y}`} x={x} y={y} s={s} />
        ))}
      </g>
      <g className="cg-pass">
        <path d="M880 318 L954 292" />
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={884 + i * 18} y={304 - i * 6.3} width="8" height="8" transform={`rotate(-19 ${888 + i * 18} ${308 - i * 6.3})`} />
        ))}
        <text className="cg-label cg-label-small" x="912" y="270">
          Yanmen Pass
        </text>
      </g>
      <path className="cg-route cg-route-far" d="M560 770 C 900 640, 1100 400, 1220 170" />
      <path className="cg-route cg-route-south" d="M720 470 C 660 590, 610 690, 560 770" />
      <path className="cg-route cg-route-north" d={NORTH_ROUTE} />
      <g transform="translate(720 470)">
        {CAMPS.map(([dx, dy]) => (
          <g key={`${dx}-${dy}`} className="cg-camp" style={{ '--dx': `${dx}px`, '--dy': `${dy}px` } as CSSProperties}>
            <path d="M-13 0 L0 -18 L13 0 Z M0 -18 V-31" />
            <path d="M0 -31 l13 3 l-13 4 Z" />
          </g>
        ))}
      </g>
      <City x={720} y={470} size={42} className="cg-city-jinyang" label="Jinyang" />
      <City x={560} y={770} size={34} className="cg-city-luoyang" label="Luoyang" />
      <g className="cg-place cg-khitan">
        <path d="M1196 190 L1196 176 Q1220 146 1244 176 L1244 190 Z" />
        <path d="M1220 150 V128 l14 4 l-14 4" />
        <text className="cg-label" x="1220" y="232">
          Khitan court
        </text>
      </g>
      <g className="cg-cartouche">
        <rect x="56" y="52" width="236" height="78" rx="4" />
        <rect x="64" y="60" width="220" height="62" rx="2" />
        <text x="174" y="99">
          Hedong, 936
        </text>
      </g>
      <g className="cg-compass" transform="translate(1486 792)">
        <circle r="34" />
        <path d="M0 -28 L8 0 L0 28 L-8 0 Z" />
        <path d="M0 -28 L8 0 L-8 0 Z" className="cg-compass-north" />
        <text y="-44">N</text>
      </g>
      {courier ? (
        <g className="cg-courier">
          <circle r="18" />
          <path className="cg-envelope" d="M-9 -6 H9 V7 H-9 Z M-9 -6 L0 2 L9 -6" />
          <animateMotion dur="1.2s" fill="freeze" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
            <mpath href="#end-map-north" />
          </animateMotion>
        </g>
      ) : null}
      {kind === 'pact_concluded' ? (
        <g transform="translate(720 470)">
          <g className="cg-seal">
            <rect x="-36" y="-36" width="72" height="72" rx="6" />
            <text y="17">盟</text>
          </g>
        </g>
      ) : null}
    </svg>
  );
}
