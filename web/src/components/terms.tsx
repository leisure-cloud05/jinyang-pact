/**
 * Terms: a read-only table, an editor for every TermSet field within the catalog ranges, a goal/authorization
 * limits editor, and a client-side burden estimate (same formula as the catalog: the payer's weighted burden).
 */
import { useId } from 'react';
import type { CatalogView, Lang, TermLimitsView, TermsView } from '../../../src/server/api-types';
import { fmt, t, termValueText } from '../labels';
import { CessionPreview } from './TerritoryMap';

export type TermsDraft = Omit<TermsView, 'secret_clauses'> & { secret_clauses: string[] };

export function toDraft(terms: TermsView): TermsDraft {
  return { ...terms, secret_clauses: terms.secret_clauses.map((c) => c.id) };
}

export function burdenOf(terms: Record<string, unknown>, catalog: CatalogView): number {
  let total = 0;
  for (const e of catalog.terms) {
    if (!e.applicable) continue;
    if (catalog.burdenPayer !== null && e.payer !== catalog.burdenPayer) continue;
    const v = terms[e.key];
    if (e.type === 'boolean' && v === true) total += e.burdenWeight;
    if (e.type === 'integer' && typeof v === 'number') total += (e.burdenWeight * v) / (e.burdenUnit ?? 1);
    if (e.type === 'enum' && typeof v === 'string') total += e.burdenByValue?.[v] ?? 0;
  }
  return Math.round(total * 100) / 100;
}

export function TermsTable({ terms, catalog, lang, compact = false }: { terms: TermsView; catalog: CatalogView; lang: Lang; compact?: boolean }) {
  const rows = catalog.terms.filter((e) => e.applicable || (terms as unknown as Record<string, unknown>)[e.key] !== (e.type === 'boolean' ? false : e.type === 'enum' ? 'none' : 0));
  return (
    <table className={`terms-table ${compact ? 'compact' : ''}`}>
      <tbody>
        {rows.map((e) => (
          <tr key={e.key}>
            <th scope="row">{t(e.label, lang)}</th>
            <td>{termValueText(e, (terms as unknown as Record<string, unknown>)[e.key], lang)}</td>
          </tr>
        ))}
        {terms.secret_clauses.map((c) => (
          <tr key={c.id}>
            <th scope="row">{lang === 'zh' ? '密约' : 'Secret article'}</th>
            <td>{t(c.text, lang)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TermsEditor({
  value,
  onChange,
  catalog,
  lang,
  knownClauses = [],
}: {
  value: TermsDraft;
  onChange: (v: TermsDraft) => void;
  catalog: CatalogView;
  lang: Lang;
  knownClauses?: Array<{ id: string; text: { zh: string; en: string } }>;
}) {
  const base = useId();
  const set = (key: string, v: unknown): void => onChange({ ...value, [key]: v } as TermsDraft);
  const rec = value as unknown as Record<string, unknown>;
  return (
    <div className="terms-editor">
      {catalog.terms.map((e) => {
        const id = `${base}-${e.key}`;
        const disabled = !e.applicable;
        const hasSlider = e.type === 'integer' && e.max !== null && Number.isFinite(e.max) && e.max > (e.min ?? 0);
        const hint = disabled ? (lang === 'zh' ? '不适用于此双方' : `not applicable to ${catalog.pair}`) : e.type === 'integer' ? `${fmt(e.min)}–${fmt(e.max)}${e.step ? `, step ${fmt(e.step)}` : ''}` : '';
        return (
          <div key={e.key} className={`field ${e.type === 'enum' ? 'term-enum-field' : ''} ${hasSlider ? 'term-slider-field' : ''} ${disabled ? 'field-disabled' : ''}`}>
            <label htmlFor={id}>{t(e.label, lang)}</label>
            {e.type === 'boolean' ? (
              <input id={id} type="checkbox" checked={rec[e.key] === true} disabled={disabled} onChange={(ev) => set(e.key, ev.target.checked)} />
            ) : e.type === 'enum' ? (
              <select id={id} value={String(rec[e.key] ?? 'none')} disabled={disabled} onChange={(ev) => set(e.key, ev.target.value)}>
                {e.values.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.label, lang)}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={e.min ?? 0}
                max={e.max ?? undefined}
                step={e.step ?? 1}
                value={typeof rec[e.key] === 'number' ? (rec[e.key] as number) : 0}
                disabled={disabled}
                aria-describedby={hint ? `${id}-hint` : undefined}
                onChange={(ev) => set(e.key, ev.target.value === '' ? 0 : Math.max(0, Math.round(Number(ev.target.value))))}
              />
            )}
            {e.key === 'cession' && !disabled ? <CessionPreview value={String(rec[e.key] ?? 'none')} lang={lang} /> : null}
            {hasSlider ? (
              <div className="term-slider-control">
                <input
                  id={`${id}-slider`}
                  type="range"
                  aria-label={`${t(e.label, lang)} (${lang === 'zh' ? '滑块' : 'slider'})`}
                  aria-describedby={`${id}-hint`}
                  min={e.min ?? 0}
                  max={e.max!}
                  step={e.step ?? 1}
                  value={typeof rec[e.key] === 'number' ? (rec[e.key] as number) : 0}
                  disabled={disabled}
                  onChange={(ev) => set(e.key, Number(ev.target.value))}
                />
                <div className="term-slider-scale" aria-hidden="true">
                  <span>{fmt(e.min ?? 0)}</span>
                  <span>{lang === 'zh' ? '拖动滑块或输入数值' : 'Drag or enter a value'}</span>
                  <span>{fmt(e.max)}</span>
                </div>
              </div>
            ) : null}
            {hint ? (
              <span id={`${id}-hint`} className="hint">
                {hint}
              </span>
            ) : null}
          </div>
        );
      })}
      {knownClauses.length > 0 ? (
        <fieldset className="field-group">
          <legend>{lang === 'zh' ? '你所知之密约' : 'Secret articles you know'}</legend>
          {knownClauses.map((c) => (
            <label key={c.id} className="check">
              <input
                type="checkbox"
                checked={value.secret_clauses.includes(c.id)}
                onChange={(ev) => onChange({ ...value, secret_clauses: ev.target.checked ? [...value.secret_clauses, c.id] : value.secret_clauses.filter((x) => x !== c.id) })}
              />{' '}
              {t(c.text, lang)}
            </label>
          ))}
        </fieldset>
      ) : null}
      <p className="hint">
        {lang === 'zh' ? '估计负担' : 'Estimated burden'}: <strong>{burdenOf(rec, catalog)}</strong>
      </p>
    </div>
  );
}

const TRI = [
  { v: '', label: 'any' },
  { v: 'true', label: 'required' },
  { v: 'false', label: 'excluded' },
];

const LIMIT_LABELS: Record<string, string> = {
  vassal: 'Vassalage',
  filial: 'Filial rites',
  neutrality: 'Khitan neutrality',
  marriage_alliance: 'Marriage alliance',
  cession_min: 'Cession at least',
  cession_max: 'Cession at most',
  annual_silk_min: 'Annual silk ≥',
  annual_silk_max: 'Annual silk ≤',
  immediate_silk_min: 'Immediate silk ≥',
  immediate_silk_max: 'Immediate silk ≤',
  aid_cavalry_min: 'Relief cavalry ≥',
  aid_cavalry_max: 'Relief cavalry ≤',
  aid_arrival_days_min: 'Arrival days ≥',
  aid_arrival_days_max: 'Arrival days ≤',
  burden_min: 'Burden ≥',
  burden_max: 'Burden ≤',
  secret_clauses_allowed: 'Secret articles',
};

const MAIN_LIMITS = ['cession_max', 'annual_silk_max', 'immediate_silk_max', 'aid_cavalry_min', 'aid_arrival_days_max', 'burden_max', 'vassal', 'filial'];

export function LimitsEditor({ value, onChange, catalog, lang }: { value: TermLimitsView; onChange: (v: TermLimitsView) => void; catalog: CatalogView; lang: Lang }) {
  const base = useId();
  const cession = catalog.terms.find((e) => e.key === 'cession');
  const field = (key: string) => {
    const id = `${base}-${key}`;
    const v = value[key] ?? null;
    let control;
    if (['vassal', 'filial', 'neutrality', 'marriage_alliance', 'secret_clauses_allowed'].includes(key)) {
      control = (
        <select id={id} value={v === null ? '' : String(v)} onChange={(e) => onChange({ ...value, [key]: e.target.value === '' ? null : e.target.value === 'true' })}>
          {TRI.map((o) => (
            <option key={o.v} value={o.v}>
              {key === 'secret_clauses_allowed' ? (o.v === 'true' ? 'allowed' : o.v === 'false' ? 'not allowed' : 'any') : o.label}
            </option>
          ))}
        </select>
      );
    } else if (key.startsWith('cession')) {
      control = (
        <select id={id} value={v === null ? '' : String(v)} onChange={(e) => onChange({ ...value, [key]: e.target.value === '' ? null : e.target.value })}>
          <option value="">any</option>
          {cession?.values.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.label, lang)}
            </option>
          ))}
        </select>
      );
    } else {
      control = (
        <input
          id={id}
          type="number"
          min={0}
          placeholder="any"
          value={typeof v === 'number' ? v : ''}
          onChange={(e) => onChange({ ...value, [key]: e.target.value === '' ? null : Number(e.target.value) })}
        />
      );
    }
    return (
      <div key={key} className="field">
        <label htmlFor={id}>{LIMIT_LABELS[key] ?? key}</label>
        {control}
      </div>
    );
  };
  const rest = catalog.limitKeys.filter((k) => !MAIN_LIMITS.includes(k));
  return (
    <div className="limits-editor">
      <div className="terms-editor">{MAIN_LIMITS.filter((k) => catalog.limitKeys.includes(k)).map(field)}</div>
      <details>
        <summary>More limits</summary>
        <div className="terms-editor">{rest.map(field)}</div>
      </details>
    </div>
  );
}

export function limitsSummary(limits: TermLimitsView, catalog: CatalogView, lang: Lang): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(limits)) {
    if (v === null) continue;
    let text = String(v);
    if (typeof v === 'string') {
      const label = catalog.terms.find((e) => e.key === 'cession')?.values.find((o) => o.value === v)?.label;
      if (label) text = t(label, lang);
    } else if (typeof v === 'number') text = fmt(v);
    parts.push(`${LIMIT_LABELS[k] ?? k} ${typeof v === 'boolean' ? (v ? 'required' : 'excluded') : text}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no limits';
}
