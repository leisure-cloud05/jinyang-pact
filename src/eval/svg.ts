/**
 * Hand-rolled SVG figures (no native dependencies). Accessible: `role="img"`, `<title>` + `<desc>`, per-mark
 * `<title>` tooltips, direct value labels with numerators/denominators, legend for ≥ 2 series, identity never by
 * colour alone (legend + labels), light and dark themes via CSS custom properties. Categorical slots 1–3 of the
 * reference palette (validated for all pairs in both modes).
 */

export interface Series {
  name: string;
  values: Array<number | null>;
  labels?: Array<string | null>;
}

const PALETTE_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a'];
const PALETTE_DARK = ['#3987e5', '#d95926', '#199e70'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function style(extra = ''): string {
  const vars = (p: string[], surface: string, t1: string, t2: string, grid: string) =>
    `--surface:${surface};--text-1:${t1};--text-2:${t2};--grid:${grid};${p.map((c, i) => `--s${i + 1}:${c};`).join('')}`;
  return `<style>
svg.viz{${vars(PALETTE_LIGHT, '#fcfcfb', '#0b0b0b', '#52514e', '#e4e3df')}font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
@media (prefers-color-scheme: dark){svg.viz{${vars(PALETTE_DARK, '#1a1a19', '#ffffff', '#c3c2b7', '#3a3a38')}}}
.bg{fill:var(--surface)}.t1{fill:var(--text-1)}.t2{fill:var(--text-2)}.grid{stroke:var(--grid);stroke-width:1}
.axis{stroke:var(--text-2);stroke-width:1}.s1{fill:var(--s1)}.s2{fill:var(--s2)}.s3{fill:var(--s3)}
.title{font-size:15px;font-weight:600}.small{font-size:11px}.label{font-size:10.5px}.banner{font-size:11px;font-weight:600}
${extra}</style>`;
}

export interface BarChartSpec {
  title: string;
  description: string;
  categories: string[];
  series: Series[];
  /** Upper end of the value axis (default: max value, or 1 for rates). */
  yMax?: number;
  yLabel: string;
  format?: (v: number) => string;
  banner?: string | null;
  /** Series indices drawn hatched (e.g. extrapolation). */
  hatchedCategories?: number[];
}

/** Grouped vertical bars (one group per category, one bar per series), rounded data-ends, 2px gaps. */
export function groupedBarChart(spec: BarChartSpec): string {
  const width = 760;
  const height = 380;
  const m = { top: spec.banner ? 78 : 58, right: 20, bottom: 70, left: 64 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const all = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const yMax = spec.yMax ?? (all.length > 0 ? Math.max(...all) * 1.15 || 1 : 1);
  const fmt = spec.format ?? ((v: number) => v.toFixed(2));
  const groupW = plotW / Math.max(1, spec.categories.length);
  const barW = Math.min(46, (groupW - 16) / Math.max(1, spec.series.length) - 2);
  const y = (v: number) => m.top + plotH - (v / yMax) * plotH;
  const parts: string[] = [];
  parts.push(`<svg class="viz" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">`);
  parts.push(`<title id="t">${esc(spec.title)}</title><desc id="d">${esc(spec.description)}</desc>`);
  parts.push(style(`.hatch{fill:url(#hatch)}`));
  parts.push(`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" class="bg"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--s1)" stroke-width="3"/></pattern></defs>`);
  parts.push(`<rect class="bg" width="${width}" height="${height}"/>`);
  parts.push(`<text class="t1 title" x="${m.left}" y="24">${esc(spec.title)}</text>`);
  if (spec.banner) parts.push(`<text class="t2 banner" x="${m.left}" y="44">${esc(spec.banner)}</text>`);
  // Grid and axis
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4;
    parts.push(`<line class="grid" x1="${m.left}" x2="${m.left + plotW}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`);
    parts.push(`<text class="t2 small" x="${m.left - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`);
  }
  parts.push(`<line class="axis" x1="${m.left}" x2="${m.left + plotW}" y1="${m.top + plotH}" y2="${m.top + plotH}"/>`);
  parts.push(`<text class="t2 small" transform="translate(16 ${m.top + plotH / 2}) rotate(-90)" text-anchor="middle">${esc(spec.yLabel)}</text>`);
  // Legend (≥ 2 series)
  if (spec.series.length >= 2) {
    let lx = m.left;
    const ly = spec.banner ? 62 : 44;
    spec.series.forEach((s, i) => {
      parts.push(`<rect class="s${(i % 3) + 1}" x="${lx}" y="${ly - 9}" width="10" height="10" rx="2"/>`);
      parts.push(`<text class="t2 small" x="${lx + 14}" y="${ly}">${esc(s.name)}</text>`);
      lx += 22 + s.name.length * 6.8;
    });
  }
  spec.categories.forEach((cat, ci) => {
    const gx = m.left + ci * groupW + (groupW - spec.series.length * (barW + 2)) / 2;
    spec.series.forEach((s, si) => {
      const v = s.values[ci] ?? null;
      const x = gx + si * (barW + 2);
      const label = s.labels?.[ci] ?? (v === null ? 'n/a' : fmt(v));
      const tip = `${cat} · ${s.name}: ${label}`;
      if (v === null) {
        parts.push(`<g><title>${esc(tip)}</title><text class="t2 label" x="${(x + barW / 2).toFixed(1)}" y="${m.top + plotH - 6}" text-anchor="middle">n/a</text></g>`);
        return;
      }
      const top = y(Math.max(0, v));
      const h = Math.max(0, m.top + plotH - top);
      const r = Math.min(4, h / 2, barW / 2);
      const hatched = spec.hatchedCategories?.includes(ci);
      const cls = hatched ? 'hatch' : `s${(si % 3) + 1}`;
      // Rounded data-end, square baseline.
      const path = `M${x.toFixed(1)},${(m.top + plotH).toFixed(1)} V${(top + r).toFixed(1)} Q${x.toFixed(1)},${top.toFixed(1)} ${(x + r).toFixed(1)},${top.toFixed(1)} H${(x + barW - r).toFixed(1)} Q${(x + barW).toFixed(1)},${top.toFixed(1)} ${(x + barW).toFixed(1)},${(top + r).toFixed(1)} V${(m.top + plotH).toFixed(1)} Z`;
      parts.push(`<g><title>${esc(tip)}</title><path class="${cls}" d="${path}"/>`);
      parts.push(`<text class="t1 label" x="${(x + barW / 2).toFixed(1)}" y="${(top - 5).toFixed(1)}" text-anchor="middle">${esc(label)}</text></g>`);
    });
    parts.push(`<text class="t1 small" x="${(m.left + ci * groupW + groupW / 2).toFixed(1)}" y="${m.top + plotH + 18}" text-anchor="middle">${esc(cat)}</text>`);
  });
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}

export interface MatrixSpec {
  title: string;
  description: string;
  rows: string[];
  columns: string[];
  /** cells[row][col]: text + state (good/bad/neutral) — state is also spelled out in the text. */
  cells: Array<Array<{ text: string; state: 'good' | 'bad' | 'neutral' }>>;
  banner?: string | null;
}

/** A labelled matrix (e.g. per-case pass table). State is shown by symbol + text, colour only reinforces it. */
export function matrixChart(spec: MatrixSpec): string {
  const cellW = 150;
  const cellH = 34;
  const left = 90;
  const top = spec.banner ? 90 : 70;
  const width = left + spec.columns.length * cellW + 20;
  const height = top + spec.rows.length * cellH + 20;
  const parts: string[] = [];
  parts.push(`<svg class="viz" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="t d">`);
  parts.push(`<title id="t">${esc(spec.title)}</title><desc id="d">${esc(spec.description)}</desc>`);
  parts.push(style(`.good{fill:#e7f3ec}.bad{fill:#fbe9e7}.neutral{fill:var(--surface)}.cell{stroke:var(--grid)}
@media (prefers-color-scheme: dark){.good{fill:#1f3a2b}.bad{fill:#46211f}}`));
  parts.push(`<rect class="bg" width="${width}" height="${height}"/>`);
  parts.push(`<text class="t1 title" x="20" y="24">${esc(spec.title)}</text>`);
  if (spec.banner) parts.push(`<text class="t2 banner" x="20" y="44">${esc(spec.banner)}</text>`);
  spec.columns.forEach((col, ci) => parts.push(`<text class="t1 small" x="${left + ci * cellW + cellW / 2}" y="${top - 10}" text-anchor="middle">${esc(col)}</text>`));
  spec.rows.forEach((row, ri) => {
    const yy = top + ri * cellH;
    parts.push(`<text class="t1 small" x="${left - 10}" y="${yy + cellH / 2 + 4}" text-anchor="end">${esc(row)}</text>`);
    spec.columns.forEach((col, ci) => {
      const cell = spec.cells[ri]?.[ci] ?? { text: '–', state: 'neutral' as const };
      const x = left + ci * cellW;
      parts.push(`<g><title>${esc(`${row} · ${col}: ${cell.text}`)}</title><rect class="cell ${cell.state}" x="${x + 1}" y="${yy + 1}" width="${cellW - 2}" height="${cellH - 2}" rx="4"/>`);
      parts.push(`<text class="t1 small" x="${x + cellW / 2}" y="${yy + cellH / 2 + 4}" text-anchor="middle">${esc(cell.text)}</text></g>`);
    });
  });
  parts.push('</svg>');
  return `${parts.join('\n')}\n`;
}
