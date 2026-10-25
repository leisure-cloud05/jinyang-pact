/**
 * PLAN §9.4 (measured, not guaranteed): a listing of every displayed narration paragraph of a run — fact header
 * and prose as the player saw them, with status (model prose `ok`, template `fallback`, `failed`), the raw model
 * prose when it was replaced, and the checker's hits — for human inspection of implicit contradictions.
 */
import type { AuditBundle } from './oracle/index.js';

export function narrationListing(bundle: AuditBundle, runId: string): string {
  const L: string[] = [`# Displayed narration — ${runId}`, ''];
  const rows = bundle.narrations;
  const displayed = rows.filter((n) => n.status !== 'failed');
  const fallbacks = rows.filter((n) => n.status === 'fallback').length;
  L.push(`${rows.length} narration row(s); ${displayed.length} displayed; ${fallbacks} template fallback(s) (fallback rate ${displayed.length === 0 ? 'n/a' : (fallbacks / displayed.length).toFixed(2)}).`, '');
  const roundOf = (v: number | undefined) => bundle.events.find((e) => e.version === v)?.round ?? null;
  for (const n of rows) {
    const round = roundOf(n.eventVersions[0]);
    L.push(`## N${n.narrationId} · ${n.scene}${round !== null ? ` · round ${round}` : ''} · ${n.status}${n.attempt > 1 ? ` (attempt ${n.attempt})` : ''}`, '');
    L.push(`events: ${n.eventVersions.join(', ') || '–'}`, '');
    for (const para of n.displayed.split(/\r?\n/).filter((x) => x.trim().length > 0)) L.push(`> ${para}`);
    L.push('');
    if (n.status !== 'ok' && n.raw) {
      L.push('Raw model prose (not displayed):', '');
      for (const para of n.raw.split(/\r?\n/).filter((x) => x.trim().length > 0)) L.push(`    ${para}`);
      L.push('');
    }
    const check = n.check as { hits?: Array<{ check?: string; detail?: string }>; checker?: { hits?: Array<{ check?: string; detail?: string }> } } | null;
    const hits = check?.hits ?? check?.checker?.hits ?? [];
    if (hits.length > 0) L.push(`Checker hits: ${hits.map((h) => `${h.check ?? '?'}: ${h.detail ?? ''}`).join('; ')}`, '');
  }
  return `${L.join('\n')}\n`;
}
