import type { CSSProperties } from 'react';
import type { CatalogView, Lang, TermsView } from '../../../src/server/api-types';
import { burdenBreakdown, burdenScale } from '../burden';
import { t } from '../labels';
import { Badge } from './ui';

const SHORT_LABELS: Record<string, { zh: string; en: string }> = {
  vassal: { zh: '称臣', en: 'Vassalage' }, filial: { zh: '父礼', en: 'Filial rites' },
  cession: { zh: '割地', en: 'Territory' }, annual_silk: { zh: '岁帛', en: 'Annual silk' },
  immediate_silk: { zh: '即付帛', en: 'Immediate silk' }, neutrality: { zh: '中立', en: 'Neutrality' },
  marriage_alliance: { zh: '和亲', en: 'Marriage' },
};
const COLORS: Record<string, string> = { vassal: '#6885b5', filial: '#a078ad', cession: '#bb754a', annual_silk: '#bd9b45', immediate_silk: '#4c9693', neutrality: '#888db4', marriage_alliance: '#ba748b' };
const number = (value: number): string => value.toLocaleString('en', { maximumFractionDigits: 2 });

/** `compact` keeps the total, the verdict and the stacked bar (for a document under review), without the breakdown. */
export function BurdenMeter({ terms, catalog, goal, total, violations = [], lang, knownClauses = [], preview = false, compact = false }: {
  terms: Record<string, unknown>; catalog: CatalogView; goal: unknown; total: number;
  violations?: string[]; lang: Lang; knownClauses?: TermsView['secret_clauses']; preview?: boolean; compact?: boolean;
}) {
  const zh = lang === 'zh';
  const parts = burdenBreakdown(terms, catalog, knownClauses);
  const scale = burdenScale(total, goal);
  const over = scale.excess > 0;
  const biggest = Math.max(0, ...parts.map((p) => p.amount));
  return (
    <div className={`meter burden-meter ${over ? 'meter-bad' : 'meter-ok'} ${compact ? 'burden-compact' : ''}`}>
      <div className="burden-heading">
        <span className="small-head">{preview ? zh ? '调整后的负担' : 'Burden preview' : zh ? '协议负担' : 'Treaty burden'}</span>
        <span className="burden-total">{number(total)}{scale.limit !== null ? <small> / {number(scale.limit)}</small> : null}</span>
      </div>
      <div className="burden-verdict" role="status" aria-live="polite">
        {over ? <strong className="burden-excess">⚠ {zh ? `超出目标 ${number(scale.excess)}` : `${number(scale.excess)} over your goal`}</strong>
          : <Badge tone="ok">{scale.limit === null ? zh ? '未设负担上限' : 'No burden cap' : zh ? `距负担上限还余 ${number(scale.limit - total)}` : `${number(scale.limit - total)} below burden cap`}</Badge>}
      </div>
      <div className="burden-plot" role="meter" aria-label={zh ? '当前协议负担' : 'Current treaty burden'} aria-valuemin={0} aria-valuemax={scale.max} aria-valuenow={total} aria-valuetext={`${number(total)}${scale.limit !== null ? ` / ${number(scale.limit)}` : ''}`}>
        <div className="burden-zones" aria-hidden="true">
          <span className="burden-safe" style={{ width: `${scale.safe}%` }} />
          <span className="burden-caution" style={{ width: `${scale.caution}%` }} />
          {scale.limit !== null ? <span className="burden-danger" /> : null}
        </div>
        <div className="burden-stack" aria-hidden="true">
          {parts.map((part) => <span key={part.key} style={{ width: `${part.amount / scale.max * 100}%`, background: COLORS[part.key] ?? '#8f7a68' }} title={`${t(SHORT_LABELS[part.key] ?? part.label, lang)}: ${number(part.amount)}`} />)}
        </div>
        {scale.limit !== null ? <span className="burden-goal-line" style={{ left: `${scale.safe}%` }} aria-hidden="true" /> : null}
        <span className={`burden-marker ${over ? 'burden-marker-over' : ''}`} style={{ '--marker-position': `${scale.marker}%` } as CSSProperties} aria-hidden="true"><b>{number(total)}</b></span>
      </div>
      <div className="burden-scale" aria-hidden="true">
        <span>{scale.limit === 0 ? zh ? '目标 0' : 'Goal 0' : '0'}</span>
        {scale.limit !== null && scale.limit > 0 ? <span className="burden-goal-label" style={{ left: `${scale.safe}%` }}>{zh ? '目标' : 'Goal'} {number(scale.limit)}</span> : null}
        <span className="burden-range-label">{zh ? '刻度' : 'Scale'} {number(scale.max)}</span>
      </div>
      {scale.limit !== null && !compact ? <p className="burden-zone-key"><span>● {zh ? '目标内' : 'Within cap'} ≤ {number(scale.limit)}</span><span>● {zh ? '越界' : 'Over'} ≤ {number(scale.limit * 1.25)}</span><span>● {zh ? '严重超限' : 'High'} &gt; {number(scale.limit * 1.25)}</span></p> : null}
      {compact ? null : parts.length > 0 ? <ul className="burden-parts">
        {parts.map((part) => {
          const after = Math.max(0, Math.round((total - part.amount) * 1e6) / 1e6);
          return <li key={part.key}>
            <span className="burden-swatch" style={{ background: COLORS[part.key] ?? '#8f7a68' }} aria-hidden="true" />
            <span><span>{t(SHORT_LABELS[part.key] ?? part.label, lang)} {part.amount === biggest ? <small className="burden-largest">{zh ? '最大项' : 'Largest'}</small> : null}</span>
              {over ? <small className="hint">{zh ? `移除此项，负担降至 ${number(after)}` : `Without this: ${number(after)}`}{scale.limit !== null && after <= scale.limit ? zh ? '（负担达标）' : ' (within burden cap)' : ''}</small> : null}
            </span>
            <strong>{number(part.amount)}</strong>
          </li>;
        })}
      </ul> : <p className="hint">{zh ? '当前无负担条款。' : 'No burden-bearing terms.'}</p>}
      {violations.length > 0 ? <div className="burden-violations"><Badge tone="bad">{zh ? '目标条件未满足' : 'Goal conditions not met'}</Badge><p className="hint">{violations.join('; ')}</p></div> : null}
      {compact ? null : <p className="burden-footnote hint">{zh ? '负担分衡量条款代价；实际财帛与割地义务见条款。' : 'Burden points measure concessions. See the terms for actual payments and territorial obligations.'}</p>}
    </div>
  );
}
