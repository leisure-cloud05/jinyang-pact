import { useId, type ReactNode } from 'react';
import type { Lang } from '../../../src/server/api-types';

/** Two deliberately schematic game regions, not a reconstruction of prefectural boundaries. */
export function TerritoryMap({ cession = 'none', lang = 'en', children }: { cession?: string; lang?: Lang; children?: ReactNode }) {
  const title = useId();
  const west = cession === 'yanmen_north' || cession === 'sixteen_prefectures';
  const east = cession === 'sixteen_prefectures';
  return (
    <svg className="territory-map" viewBox="0 0 640 340" role="img" aria-labelledby={title}>
      <title id={title}>{lang === 'zh' ? '割地与信使路线示意图' : 'Schematic territory and courier map'}</title>
      <path className="map-land" d="M20 230 L42 149 110 125 166 85 218 102 264 40 314 62 350 112 407 84 462 118 516 144 609 135 620 256 560 310 442 296 350 319 268 286 178 315 82 294Z" />
      <path key={`west-${west}`} className={`map-region ${west ? 'is-selected' : ''}`} d="M45 200 L70 155 124 143 172 108 218 125 261 67 284 85 278 143 306 170 274 218 217 226 172 212 120 236 72 223Z" />
      <path key={`east-${east}`} className={`map-region ${east ? 'is-selected' : ''}`} d="M306 170 L278 143 284 85 317 118 358 134 401 112 440 146 489 158 537 184 509 217 459 222 419 252 365 260 316 233 274 218Z" />
      <g className="map-region-label">
        <text x="177" y="163" textAnchor="middle">{lang === 'zh' ? '雁门以北' : 'North of Yanmen'}</text>
        <text x="401" y="205" textAnchor="middle">{lang === 'zh' ? '卢龙' : 'Lulong'}</text>
      </g>
      <path className="map-pass" d="M200 237 l8 -8 8 8 m-2 -8 l8 -8 8 8" />
      <text className="map-small" x="231" y="245">{lang === 'zh' ? '雁门关' : 'Yanmen Pass'}</text>
      {children}
      <text className="map-small" x="320" y="330" textAnchor="middle">{lang === 'zh' ? '游戏区域示意 · 非精确历史边界' : 'Game-region schematic · not historical boundaries'}</text>
    </svg>
  );
}

export function CessionPreview({ value, lang }: { value: string; lang: Lang }) {
  const label = value === 'sixteen_prefectures' ? (lang === 'zh' ? '十六州范围' : 'Sixteen Prefectures') : value === 'yanmen_north' ? (lang === 'zh' ? '仅雁门以北' : 'North of Yanmen only') : (lang === 'zh' ? '不割地' : 'No cession');
  return (
    <figure className="cession-preview">
      <figcaption><strong>{lang === 'zh' ? '拟议割地' : 'Proposed cession'}</strong><span aria-live="polite">{label}</span></figcaption>
      <TerritoryMap cession={value} lang={lang} />
      <p className="hint">{lang === 'zh' ? '金色为拟议范围。条约约定未来履行，尚未移交。' : 'Gold marks the proposed area. A future obligation; no territory has changed hands.'}</p>
    </figure>
  );
}
