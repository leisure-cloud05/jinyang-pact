/** Shared helpers of the view builders: names, visibility predicates, term and action summaries. */
import { actorName, locationName, type AgentNames } from '../../agents/names.js';
import { factTerms, renderTerms } from '../../agents/narration/index.js';
import { knowsClause } from '../../core/knowledge.js';
import { own } from '../../core/ids.js';
import { SCALAR_TERM_KEYS, type ActorId, type CoreConfig, type JsonValue, type LocId, type NarrationFact, type WorldState } from '../../core/types.js';
import type { L10n, TermsView } from '../api-types.js';

export function nameOf(names: AgentNames, actor: string): L10n {
  return { zh: actorName(names, actor, 'zh'), en: actorName(names, actor, 'en') };
}

export function placeOf(names: AgentNames, loc: string): L10n {
  return { zh: locationName(names, loc, 'zh'), en: locationName(names, loc, 'en') };
}

export const RULE_TITLES: Record<string, string> = {
  H01: 'closed action set / schema',
  H02: 'permission (no consent on behalf of others)',
  H03: 'actor alive, world not terminal',
  H04: 'referenced objects live and current',
  H05: 'batch epoch and base version',
  H06: 'idempotent request',
  H07: 'resources and reservations',
  H08: 'knowledge and communication',
  H09: 'mutual consent to the same terms',
  H10: 'user control before critical outcomes',
  H11: 'only the approved current version is dispatched',
  H12: 'no duplicate dispatch or answer',
  H13: 'negotiation rounds and offer cap',
  H14: 'time advances only when quiescent',
  H15: 'no model outcome text in world state',
  H16: 'narration consistency',
};

/** A fact the player witnesses: addressed to an audience including the player, or public at the player's scene. */
export function playerSeesFact(fact: NarrationFact, playerLoc: LocId): boolean {
  return fact.audience.includes('player') || (fact.audience.length === 0 && fact.scene === playerLoc);
}

/** Proposals the player can observe: its own, system outcomes, and those of player-side characters present with it. */
export function playerSeesActor(actor: string, state: WorldState, config: CoreConfig, playerLoc: LocId): boolean {
  if (actor === 'player' || actor === 'system') return true;
  const c = own(state.characters as Record<string, { faction: string; location: string }>, actor);
  return c !== undefined && c.faction === config.player.faction && c.location === playerLoc;
}

/** Terms (a TermSet with clause objects, or term args with clause ids) as a viewer may see them. */
export function termsFor(raw: unknown, state: WorldState, config: CoreConfig, viewer: ActorId | 'director'): TermsView | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  if (!SCALAR_TERM_KEYS.some((k) => k in t)) return null;
  const clauses = Array.isArray(t.secret_clauses) ? t.secret_clauses : [];
  const visible: TermsView['secret_clauses'] = [];
  for (const c of clauses) {
    const id = typeof c === 'string' ? c : typeof c === 'object' && c !== null ? (c as { id?: unknown }).id : null;
    if (typeof id !== 'string') continue;
    if (viewer !== 'director' && !knowsClause(state, config, viewer, id)) continue;
    const def = own(config.catalog.secretClauses, id);
    const text = typeof c === 'object' && c !== null && (c as { text?: L10n }).text ? (c as { text: L10n }).text : def?.text;
    visible.push({ id, text: { zh: text?.zh ?? id, en: text?.en ?? id } });
  }
  const num = (k: string): number => (typeof t[k] === 'number' ? (t[k] as number) : 0);
  return {
    vassal: t.vassal === true,
    filial: t.filial === true,
    cession: typeof t.cession === 'string' ? t.cession : 'none',
    annual_silk: num('annual_silk'),
    immediate_silk: num('immediate_silk'),
    aid_cavalry: num('aid_cavalry'),
    aid_arrival_days: num('aid_arrival_days'),
    neutrality: t.neutrality === true,
    marriage_alliance: t.marriage_alliance === true,
    secret_clauses: visible,
  };
}

function termsLine(terms: TermsView | null, names: AgentNames): L10n {
  if (!terms) return { zh: '', en: '' };
  const ft = factTerms({ ...terms, secret_clause_ids: terms.secret_clauses.map((c) => c.id) } as unknown as JsonValue);
  if (!ft) return { zh: '', en: '' };
  return { zh: renderTerms(ft, names, 'zh'), en: renderTerms(ft, names, 'en') };
}

/** Terms carried by an action (document revision, offer, counter), if any. */
export function actionTermsRaw(action: unknown, state: WorldState): unknown {
  if (typeof action !== 'object' || action === null) return null;
  const a = action as { type?: string; args?: Record<string, unknown> };
  const args = a.args ?? {};
  switch (a.type) {
    case 'revise_document':
    case 'propose_terms':
      return args.terms ?? null;
    case 'respond_to_offer':
      return args.counterTerms ?? null;
    case 'suggest_revision':
      return null;
    case 'dispatch_document':
    case 'approve_document': {
      const doc = own(state.documents, String(args.docId));
      return doc ? doc.terms : null;
    }
    case 'confirm_commitment': {
      const offer = own(state.offers, String(args.offerId));
      return offer ? offer.terms : null;
    }
    default:
      return null;
  }
}

/** One-line bilingual summary of an action (terms rendered as the viewer may see them). */
export function describeAction(action: unknown, names: AgentNames, terms: TermsView | null): L10n {
  if (typeof action !== 'object' || action === null) return { zh: '（无法读取的提议）', en: '(unreadable proposal)' };
  const a = action as { type?: string; args?: Record<string, unknown> };
  const args = a.args ?? {};
  const who = (id: unknown): L10n => nameOf(names, String(id ?? '?'));
  const tl = termsLine(terms, names);
  const withTerms = (zh: string, en: string): L10n => ({ zh: tl.zh ? `${zh}：${tl.zh}` : zh, en: tl.en ? `${en}: ${tl.en}` : en });
  switch (a.type) {
    case 'speak': {
      const text = String(args.text ?? '');
      return { zh: `发言：${text}`, en: `speaks: ${text}` };
    }
    case 'send_letter':
      return { zh: `致书${who(args.to).zh}`, en: `writes to ${who(args.to).en}` };
    case 'revise_document':
      return withTerms(`改定${String(args.docId)}（基于第${String(args.baseDocVersion)}版）`, `revises ${String(args.docId)} (from v${String(args.baseDocVersion)})`);
    case 'suggest_revision':
      return { zh: `就${String((args.target as { id?: unknown } | undefined)?.id ?? '?')}提出修改建议`, en: `suggests changes to ${String((args.target as { id?: unknown } | undefined)?.id ?? '?')}` };
    case 'approve_document':
      return withTerms(`用印批准${String(args.docId)}第${String(args.docVersion)}版`, `approves ${String(args.docId)} v${String(args.docVersion)}`);
    case 'set_dispatch_timing':
      return {
        zh: `定${String(args.docId)}发遣之时：${String(args.mode)}${args.rounds ? `（${String(args.rounds)}回合）` : ''}`,
        en: `sets dispatch timing of ${String(args.docId)}: ${String(args.mode)}${args.rounds ? ` (${String(args.rounds)} round(s))` : ''}`,
      };
    case 'dispatch_document':
      return withTerms(`遣使送出${String(args.docId)}第${String(args.docVersion)}版`, `dispatches ${String(args.docId)} v${String(args.docVersion)}`);
    case 'propose_terms':
      return withTerms(`向${who(args.to).zh}提出条件`, `proposes terms to ${who(args.to).en}`);
    case 'respond_to_offer':
      return args.response === 'counter'
        ? withTerms(`就${String(args.offerId)}还价`, `counters ${String(args.offerId)}`)
        : { zh: `拒绝${String(args.offerId)}`, en: `rejects ${String(args.offerId)}` };
    case 'withdraw_offer':
      return { zh: `追回${String(args.offerId)}`, en: `withdraws ${String(args.offerId)}` };
    case 'confirm_commitment':
      return withTerms(`允约${String(args.offerId)}（条款第${String(args.termsVersion)}版）`, `confirms ${String(args.offerId)} (terms v${String(args.termsVersion)})`);
    case 'allocate_resources':
      return { zh: `拨付${String(args.resource)} ${String(args.amount)}（${String(args.purpose)}）`, en: `allocates ${String(args.amount)} ${String(args.resource)} (${String(args.purpose)})` };
    case 'abandon_request':
      return { zh: '罢求援之议', en: 'abandons the request for assistance' };
    case 'revoke_authorization':
      return { zh: `收回授权${String(args.authId)}`, en: `revokes ${String(args.authId)}` };
    case 'wait':
      return { zh: '静候', en: 'waits' };
    case 'mutiny_outbreak':
      return { zh: '兵变', en: 'mutiny breaks out' };
    default:
      return { zh: String(a.type ?? '?'), en: String(a.type ?? '?') };
  }
}

export function actionType(action: unknown): string {
  if (typeof action !== 'object' || action === null) return 'unreadable';
  const t = (action as { type?: unknown }).type;
  return typeof t === 'string' ? t : 'unreadable';
}
