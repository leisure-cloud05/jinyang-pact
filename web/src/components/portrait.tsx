/**
 * Character portraits (人物头像): a small ink-and-parchment bust for each council member, drawn in the same vector
 * idiom as the ending CG (EndingScenes.tsx). Purely decorative — the name is always shown beside it, so the portrait
 * carries no information of its own (aria-hidden). Each member is told apart by headwear, beard and robe colour:
 *
 *   shi_jingtang  Shi Jingtang   the Hedong governor — black folded headcloth (幞头), short beard, vermilion robe
 *   sang_weihan   Sang Weihan    the secretary — long dangling headcloth, thin brows, goatee, dark-green robe
 *   liu_zhiyuan   Liu Zhiyuan    the general — iron helmet with a red plume, heavy brows, full beard, dark robe
 *   yelu_deguang  Yelü Deguang   the Khitan ruler — felt cap with fur ear-flaps, deep eyes, full beard, ochre robe
 *   li_congke     Li Congke      the Tang emperor — flat crown with bead tassels, long beard, gold robe
 */
import type { ReactNode } from 'react';

const SKIN = '#ecd9bd';
const SKIN_SHADE = '#d9b98c';
const INK = '#241a12';
const IRON = '#3f2f22';
const FUR = '#c9a36a';
const FELT = '#7a5230';

interface Palette {
  bg: string;
  cloth: string;
}

const PALETTE: Record<string, Palette> = {
  shi_jingtang: { bg: '#f1d9cb', cloth: '#a63e2d' },
  sang_weihan: { bg: '#d9e6e1', cloth: '#35544c' },
  liu_zhiyuan: { bg: '#e8dfd1', cloth: '#43301f' },
  yelu_deguang: { bg: '#e9d5bb', cloth: '#8a5a2b' },
  li_congke: { bg: '#f0e3bd', cloth: '#a8862a' },
};

const FALLBACK: Palette = { bg: '#e9e2d4', cloth: '#697269' };

/** The shared body: background disc, robe, neck, head, ears, collar, and the neutral features every face keeps. */
function Bust({ p, children }: { p: Palette; children?: ReactNode }) {
  return (
    <>
      <circle cx="32" cy="32" r="32" fill={p.bg} />
      {/* shoulders / robe */}
      <path d="M4 64 L6.5 50 Q32 40 57.5 50 L60 64 Z" fill={p.cloth} />
      {/* neck */}
      <path d="M26 40 h12 v14 h-12 Z" fill={SKIN_SHADE} />
      {/* head */}
      <path
        d="M32 12 c-8.5 0 -15 7.5 -15 17 c0 9.5 6.5 16 15 16 s15 -6.5 15 -16 c0 -9.5 -6.5 -17 -15 -17 Z"
        fill={SKIN}
      />
      {/* ears */}
      <circle cx="16.5" cy="30" r="3" fill={SKIN} />
      <circle cx="47.5" cy="30" r="3" fill={SKIN} />
      {/* collar V */}
      <path d="M25 47 L32 55 L39 47" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      {/* eyes */}
      <path d="M23.5 28.5 q2 1.7 4 0 M36.5 28.5 q2 1.7 4 0" fill="none" stroke={INK} strokeWidth="1.5" strokeLinecap="round" />
      {/* nose */}
      <path d="M32 30 q0.7 4 0 6.5" fill="none" stroke={INK} strokeWidth="1.2" strokeLinecap="round" />
      {/* mouth */}
      <path d="M29 38 q3 2.2 6 0" fill="none" stroke={INK} strokeWidth="1.4" strokeLinecap="round" />
      {children}
    </>
  );
}

/** A brow line. `heavy` draws a fuller stroke for the blunt generals. */
function Brow({ heavy = false }: { heavy?: boolean }) {
  return (
    <path
      d="M23 24.5 L30 24 M34 24 L41 24.5"
      fill="none"
      stroke={INK}
      strokeWidth={heavy ? 2.1 : 1.4}
      strokeLinecap="round"
    />
  );
}

/** A fine, slightly lifted brow for the scholar. */
function FineBrow() {
  return <path d="M23 24.8 q2.5 -0.5 6 0 M35 24.8 q2.5 -0.5 6 0" fill="none" stroke={INK} strokeWidth="1.1" strokeLinecap="round" />;
}

/** A short chin beard. */
function ShortBeard() {
  return <path d="M26 40 Q32 47 38 40 Q32 43 26 40 Z" fill={INK} />;
}

/** A pointed goatee hanging below the chin. */
function Goatee() {
  return <path d="M29 40 Q32 53 35 40 Q32 44 29 40 Z" fill={INK} />;
}

/** A full beard framing the lower face. */
function FullBeard({ moustache = false }: { moustache?: boolean }) {
  return (
    <>
      <path d="M22 33 Q19 45 32 47 Q45 45 42 33 Q32 40 22 33 Z" fill={INK} />
      {moustache ? <path d="M26 36.5 q3 2 6 0 q-3 1.3 -6 0 Z" fill={INK} /> : null}
    </>
  );
}

/** A long beard falling to the chest, for the emperor. */
function LongBeard() {
  return <path d="M27 40 Q32 57 37 40 Q32 45 27 40 Z" fill={INK} />;
}

/** The folded headcloth (幞头) with two hanging feet, for the governor and the secretary. */
function FoldedCloth({ longFeet = false }: { longFeet?: boolean }) {
  const left = longFeet ? 'M18 23 Q12 36 21 46 L24 45 Q17 35 20 26 Z' : 'M18 23 Q13 33 20 41 L23 40 Q17 33 20 26 Z';
  const right = longFeet ? 'M46 23 Q52 36 43 46 L40 45 Q47 35 44 26 Z' : 'M46 23 Q51 33 44 41 L41 40 Q47 33 44 26 Z';
  return (
    <>
      <path d="M18 23 Q20 9 32 9 Q44 9 46 23 Q32 18 18 23 Z" fill={INK} />
      <path d={left} fill={INK} />
      <path d={right} fill={INK} />
    </>
  );
}

/** An iron helmet with cheek guards and a red plume. */
function Helmet() {
  return (
    <>
      <path d="M18 26 Q20 8 32 8 Q44 8 46 26 Q32 20 18 26 Z" fill={IRON} />
      <path d="M18 22 q-2 6 2 10 l1 -9 Z" fill={IRON} />
      <path d="M46 22 q2 6 -2 10 l-1 -9 Z" fill={IRON} />
      <line x1="32" y1="8" x2="32" y2="3" stroke="#a63e2d" strokeWidth="2" />
      <circle cx="32" cy="2.6" r="2.6" fill="#a63e2d" />
    </>
  );
}

/** A felt cap with fur ear-flaps, for the Khitan ruler. */
function FeltCap() {
  return (
    <>
      <path d="M18 25 Q20 10 32 10 Q44 10 46 25 Q32 19 18 25 Z" fill={FELT} />
      <path d="M16 25 Q16 31 21 32 L19 25 Z" fill={FUR} />
      <path d="M48 25 Q48 31 43 32 L45 25 Z" fill={FUR} />
    </>
  );
}

/** A flat imperial crown with bead tassels hanging before and behind, for the Tang emperor. */
function Crown() {
  return (
    <>
      <path d="M19 22 Q32 13 45 22 L43 20 Q32 14 21 20 Z" fill={INK} />
      <rect x="17" y="12" width="30" height="4" rx="1" fill="#b08a2e" />
      <g fill="#d8b35a">
        <circle cx="19" cy="18.5" r="1.3" />
        <circle cx="19" cy="22.5" r="1.3" />
        <circle cx="19" cy="26.5" r="1.3" />
        <circle cx="45" cy="18.5" r="1.3" />
        <circle cx="45" cy="22.5" r="1.3" />
        <circle cx="45" cy="26.5" r="1.3" />
      </g>
    </>
  );
}

function renderArt(id: string, p: Palette): ReactNode {
  switch (id) {
    case 'shi_jingtang':
      return (
        <Bust p={p}>
          <FoldedCloth />
          <Brow />
          <ShortBeard />
        </Bust>
      );
    case 'sang_weihan':
      return (
        <Bust p={p}>
          <FoldedCloth longFeet />
          <FineBrow />
          <Goatee />
        </Bust>
      );
    case 'liu_zhiyuan':
      return (
        <Bust p={p}>
          <Helmet />
          <Brow heavy />
          <FullBeard />
        </Bust>
      );
    case 'yelu_deguang':
      return (
        <Bust p={p}>
          <FeltCap />
          <Brow heavy />
          <FullBeard moustache />
        </Bust>
      );
    case 'li_congke':
      return (
        <Bust p={p}>
          <Crown />
          <Brow />
          <LongBeard />
        </Bust>
      );
    default:
      // Unknown character: keep the initials token so nothing is ever unidentifiable.
      return null;
  }
}

export function CharacterPortrait({ id, name }: { id: string; name: string }) {
  const p = PALETTE[id] ?? FALLBACK;
  const art = renderArt(id, p);
  if (!art) {
    const initials = name
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join('');
    return (
      <span className="portrait portrait-initials" aria-hidden="true">
        {initials}
      </span>
    );
  }
  return (
    <span className="portrait" aria-hidden="true">
      <svg viewBox="0 0 64 64" role="presentation" focusable="false">
        {art}
      </svg>
    </span>
  );
}
