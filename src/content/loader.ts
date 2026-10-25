/**
 * Content loader (PLAN §12): reads the YAML directories, validates each file against its schema, checks
 * cross-references, and derives the core rules configuration and the deterministic initial world state.
 *
 * Layout under the content root: `scenario/*.yaml` (exactly one), `characters/<id>.yaml`, `cases/*.yaml`,
 * `dev/*.yaml`, `pilot/*.yaml`, `traces/<case>.trace.yaml`, `sources/*.yaml`. Files are read in sorted order.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { parseAction } from '../core/actions.js';
import { initialCounters, own } from '../core/ids.js';
import { initialNegotiation } from '../core/negotiation.js';
import { FEASIBLE_OPTIONS } from '../core/pauses.js';
import { checkConsentFeasible, deriveObligations } from '../core/obligations.js';
import { checkOfferCap, negotiatingThread } from '../core/negotiation.js';
import { Draft } from '../core/reducer.js';
import { seedPreStart } from '../core/resolve.js';
import { CURRENT_VERSION } from '../core/script.js';
import { knowsClause } from '../core/knowledge.js';
import type { TraceSpec } from '../core/simulate.js';
import { TERM_SEMANTICS, expandTermArgs, pairOf, payerFor, validateTerms } from '../core/terms.js';
import {
  CESSION_VALUES,
  CHAR_IDS,
  FACTION_IDS,
  LOC_IDS,
  PLAYER_FORBIDDEN_ACTIONS,
  PRINCIPAL_ONLY_ACTIONS,
  RESOURCE_KEYS,
  SCALAR_TERM_KEYS,
  type ActorId,
  type CharId,
  type CoreConfig,
  type Document,
  type JsonValue,
  type KnowledgeItem,
  type LocId,
  type PairId,
  type PlayerGoal,
  type ResourceMap,
  type SecretClause,
  type TermSet,
  type TermsCatalog,
  type WorldState,
} from '../core/types.js';
import {
  CaseSchema,
  CharacterSchema,
  DevConfigSchema,
  ScenarioSchema,
  SourceFileSchema,
  TraceSchema,
  resourceAmount,
  type CaseConfig,
  type CharacterConfig,
  type CharacterOverride,
  type DevConfig,
  type InitialOverrides,
  type Scenario,
  type SourceEntry,
  type TermSetSeed,
  type TraceConfig,
} from './schema.js';

export class ContentError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`content validation failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n- ${issues.join('\n- ')}`);
    this.name = 'ContentError';
    this.issues = issues;
  }
}

export interface ContentBundle {
  root: string;
  scenario: Scenario;
  characters: Record<CharId, CharacterConfig>;
  cases: Record<string, CaseConfig>;
  dev: Record<string, DevConfig>;
  pilot: Record<string, CaseConfig>;
  traces: Record<string, TraceConfig>;
  sources: Record<string, SourceEntry>;
}

export interface LoadOptions {
  /** Fail if no source entries are found (default false). */
  requireSources?: boolean;
  /** Run cross-reference validation (default true). */
  crossCheck?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

function yamlFiles(dir: string, suffix = '.yaml'): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix) || (suffix === '.yaml' && f.endsWith('.yml')))
    .sort()
    .map((f) => path.join(dir, f));
}

function formatZodIssues(file: string, error: z.ZodError): string[] {
  return error.issues.map((i) => `${file}: ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`);
}

function readYaml(file: string, root: string, issues: string[]): unknown {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  try {
    return parseYaml(readFileSync(file, 'utf8'), { uniqueKeys: true });
  } catch (err) {
    issues.push(`${rel}: YAML error: ${(err as Error).message}`);
    return undefined;
  }
}

function parseFile<S extends z.ZodType>(schema: S, file: string, root: string, issues: string[]): z.output<S> | null {
  const raw = readYaml(file, root, issues);
  if (raw === undefined) return null;
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const result = schema.safeParse(raw);
  if (!result.success) {
    issues.push(...formatZodIssues(rel, result.error));
    return null;
  }
  return result.data;
}

function readSources(dir: string, root: string, issues: string[]): Record<string, SourceEntry> {
  const sources: Record<string, SourceEntry> = {};
  for (const file of yamlFiles(dir)) {
    const entries = parseFile(SourceFileSchema, file, root, issues);
    for (const entry of entries ?? []) {
      if (sources[entry.id]) issues.push(`sources: duplicate entry id ${entry.id}`);
      sources[entry.id] = entry;
    }
  }
  return sources;
}

/** Loads and validates source files on their own (schema + internal references); throws ContentError. */
export function loadSources(dirOrFile: string): Record<string, SourceEntry> {
  const issues: string[] = [];
  const abs = path.resolve(dirOrFile);
  let sources: Record<string, SourceEntry>;
  if (existsSync(abs) && statSync(abs).isFile()) {
    sources = {};
    for (const entry of parseFile(SourceFileSchema, abs, path.dirname(abs), issues) ?? []) {
      if (sources[entry.id]) issues.push(`sources: duplicate entry id ${entry.id}`);
      sources[entry.id] = entry;
    }
  } else {
    sources = readSources(abs, abs, issues);
  }
  issues.push(...validateSources(sources));
  if (issues.length > 0) throw new ContentError(issues);
  return sources;
}

/** Internal references of source entries: unique holders, derived_from/conflicts_with resolve, conflicts symmetric. */
export function validateSources(sources: Record<string, SourceEntry>): string[] {
  const issues: string[] = [];
  for (const entry of Object.values(sources)) {
    const where = `sources.${entry.id}`;
    const holders = entry.learnable_by.map((l) => l.holder);
    if (new Set(holders).size !== holders.length) issues.push(`${where}: learnable_by lists a holder twice`);
    for (const id of entry.derived_from) if (!sources[id]) issues.push(`${where}: derived_from unknown ${id}`);
    for (const id of entry.conflicts_with) {
      const other = sources[id];
      if (!other) issues.push(`${where}: conflicts_with unknown ${id}`);
      else if (!other.conflicts_with.includes(entry.id)) issues.push(`${where}: conflict with ${id} is not symmetric`);
    }
  }
  return issues;
}

export function loadContent(root: string, opts: LoadOptions = {}): ContentBundle {
  const issues: string[] = [];
  const abs = path.resolve(root);

  const scenarioFiles = yamlFiles(path.join(abs, 'scenario'));
  if (scenarioFiles.length !== 1) issues.push(`scenario/: expected exactly one scenario file, found ${scenarioFiles.length}`);
  const scenario = scenarioFiles[0] ? parseFile(ScenarioSchema, scenarioFiles[0], abs, issues) : null;

  const characters = {} as Record<CharId, CharacterConfig>;
  for (const file of yamlFiles(path.join(abs, 'characters'))) {
    const c = parseFile(CharacterSchema, file, abs, issues);
    if (!c) continue;
    const base = path.basename(file).replace(/\.ya?ml$/, '');
    if (base !== c.id) issues.push(`characters/${path.basename(file)}: file name must be ${c.id}.yaml`);
    if (characters[c.id]) issues.push(`characters: duplicate character ${c.id}`);
    characters[c.id] = c;
  }

  const collect = <T extends { id: string }>(dir: string, schema: z.ZodType<T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const file of yamlFiles(path.join(abs, dir))) {
      const item = parseFile(schema, file, abs, issues);
      if (!item) continue;
      if (out[item.id]) issues.push(`${dir}: duplicate id ${item.id}`);
      out[item.id] = item;
    }
    return out;
  };
  const cases = collect('cases', CaseSchema);
  const dev = collect('dev', DevConfigSchema);
  const pilot = collect('pilot', CaseSchema);

  const traces: Record<string, TraceConfig> = {};
  for (const file of yamlFiles(path.join(abs, 'traces'), '.trace.yaml')) {
    const t = parseFile(TraceSchema, file, abs, issues);
    if (!t) continue;
    const base = path.basename(file).replace(/\.trace\.yaml$/, '');
    if (base !== t.case) issues.push(`traces/${path.basename(file)}: file name must be ${t.case}.trace.yaml`);
    traces[t.case] = t;
  }

  const sources = readSources(path.join(abs, 'sources'), abs, issues);
  if (opts.requireSources && Object.keys(sources).length === 0) issues.push('sources/: no source entries');

  if (issues.length > 0 || !scenario) throw new ContentError(issues.length > 0 ? issues : ['scenario missing']);
  const bundle: ContentBundle = { root: abs, scenario, characters, cases, dev, pilot, traces, sources };
  if (opts.crossCheck !== false) {
    const cross = validateContent(bundle);
    if (cross.length > 0) throw new ContentError(cross);
  }
  return bundle;
}

// ---------------------------------------------------------------------------------------------------------------
// Rules configuration
// ---------------------------------------------------------------------------------------------------------------

/** Anything carrying case overrides (a case, dev or pilot config, or bare `initial_overrides`). */
export interface CaseLike {
  initial_overrides?: InitialOverrides | null;
}

/** Terms catalog of the scenario, with a case's clause library applied (overrides + case-only clauses). */
export function buildCatalog(scenario: Scenario, caseLike: CaseLike | null = null): TermsCatalog {
  const terms = {} as TermsCatalog['terms'];
  for (const entry of scenario.terms_catalog.terms) {
    terms[entry.key] = {
      key: entry.key,
      label: entry.label,
      min: entry.min,
      max: entry.max,
      step: entry.step,
      burden_weight: entry.burden_weight,
      burden_unit: entry.burden_unit,
      burden_by_value: entry.burden_by_value,
      applicable_pairs: [...entry.applicable_pairs],
      source_refs: [...entry.source_refs],
    };
  }
  const secretClauses: TermsCatalog['secretClauses'] = {};
  for (const clause of scenario.terms_catalog.secret_clauses) {
    secretClauses[clause.id] = {
      id: clause.id,
      text: clause.text,
      canary: clause.canary,
      knownBy: [...clause.knownBy],
      applicable_pairs: [...clause.applicable_pairs],
      burden_weight: clause.burden_weight,
      source_refs: [...clause.source_refs],
    };
  }
  for (const c of caseLike?.initial_overrides?.secret_clauses ?? []) {
    const base = own(secretClauses, c.id);
    const text = c.text ?? base?.text;
    const canary = c.canary ?? base?.canary;
    const pairs = c.applicable_pairs ?? base?.applicable_pairs;
    if (!text || !canary || !pairs) continue; // incomplete case-only clause: reported by validateContent
    secretClauses[c.id] = {
      id: c.id,
      text,
      canary,
      knownBy: [...(c.knownBy ?? base?.knownBy ?? [])],
      applicable_pairs: [...pairs],
      burden_weight: c.burden_weight ?? base?.burden_weight ?? 0,
      source_refs: [...(c.source_refs ?? base?.source_refs ?? [])],
    };
  }
  return { terms, secretClauses };
}

/** Character overrides of a case in record form (the older list form carries only status/location). */
export function characterOverrides(caseLike: CaseLike | null): Partial<Record<CharId, CharacterOverride>> {
  const raw = caseLike?.initial_overrides?.characters;
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw;
  const out: Partial<Record<CharId, CharacterOverride>> = {};
  for (const entry of raw) {
    const o: CharacterOverride = { ...(out[entry.id] ?? {}) };
    if (entry.status) o.status = entry.status;
    if (entry.location) o.location = entry.location;
    out[entry.id] = o;
  }
  return out;
}

/** A character's persona for a case: persona fields of `initial_overrides.characters.<id>` replace the file's. */
export function effectiveCharacter(bundle: ContentBundle, caseLike: CaseLike | null, id: CharId): CharacterConfig {
  const base = bundle.characters[id];
  const o = characterOverrides(caseLike)[id];
  if (!o) return structuredClone(base);
  return structuredClone({
    ...base,
    location: o.location ?? base.location,
    goals: o.goals ?? base.goals,
    private_memory: o.private_memory ?? base.private_memory,
    reservation: o.reservation !== undefined ? o.reservation : base.reservation,
    tolerance: o.tolerance !== undefined ? o.tolerance : base.tolerance,
    agendaTriggers: o.agendaTriggers ?? base.agendaTriggers,
  });
}

/** Case/dev/pilot config by id. */
export function findCase(bundle: ContentBundle, id: string): CaseConfig | DevConfig {
  const c = own(bundle.cases, id) ?? own(bundle.dev, id) ?? own(bundle.pilot, id);
  if (!c) throw new ContentError([`no case ${id}`]);
  return c;
}

function buildTravel(scenario: Scenario): CoreConfig['travel'] {
  const travel = {} as CoreConfig['travel'];
  for (const a of LOC_IDS) {
    travel[a] = {} as Record<LocId, number>;
    for (const b of LOC_IDS) travel[a][b] = a === b ? 0 : -1;
  }
  for (const t of scenario.travel) {
    travel[t.from][t.to] = t.days;
    if (travel[t.to][t.from] === -1) travel[t.to][t.from] = t.days;
  }
  return travel;
}

/** Rules configuration; with a case, its clause library (knownBy etc.) is applied. */
export function buildCoreConfig(bundle: ContentBundle, caseLike: CaseLike | null = null): CoreConfig {
  const s = bundle.scenario;
  const factions = {} as CoreConfig['factions'];
  for (const f of s.factions) factions[f.id] = { principal: f.principal };
  const characters = {} as CoreConfig['characters'];
  for (const id of CHAR_IDS) {
    const c = bundle.characters[id];
    characters[id] = {
      id,
      faction: c.faction,
      principal: c.principal,
      permissions: [...c.permissions],
      commitPriority: c.commitPriority,
      name: { zh: c.name.zh, en: c.name.en },
    };
  }
  const correspondence: CoreConfig['correspondence'] = {};
  for (const entry of s.correspondence_access) correspondence[entry.principal] = [...entry.readers];
  return {
    params: { ...s.parameters },
    travel: buildTravel(s),
    catalog: buildCatalog(s, caseLike),
    factions,
    characters,
    player: { faction: s.player.faction, permissions: [...s.player.permissions], name: { zh: s.player.name.zh, en: s.player.name.en } },
    correspondence,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cross-reference validation
// ---------------------------------------------------------------------------------------------------------------

function seedToArgs(seed: TermSetSeed) {
  return { ...seed, secret_clauses: [...seed.secret_clauses] };
}

function catalogClause(catalog: TermsCatalog, id: string): SecretClause | null {
  const def = own(catalog.secretClauses, id);
  return def ? { id: def.id, text: def.text, canary: def.canary, knownBy: [...def.knownBy] } : null;
}

/** For validation only: replaces the `"$current"` version placeholder with a sample version. */
function withPlaceholderSample(action: unknown): unknown {
  if (typeof action !== 'object' || action === null) return action;
  const copy = structuredClone(action) as { args?: Record<string, unknown> };
  if (copy.args && typeof copy.args === 'object') {
    for (const key of ['baseDocVersion', 'docVersion']) if (copy.args[key] === CURRENT_VERSION) copy.args[key] = 1;
  }
  return copy;
}

/** Expands a content term seed (clauses by catalog id). */
export function expandSeedTerms(seed: TermSetSeed, catalog: TermsCatalog): { terms: TermSet } | { unknown: string[] } {
  const expanded = expandTermArgs(seedToArgs(seed), (id) => catalogClause(catalog, id));
  return expanded.ok ? { terms: expanded.terms } : { unknown: expanded.unknownClauseIds };
}

export function validateContent(bundle: ContentBundle): string[] {
  const issues: string[] = [];
  const s = bundle.scenario;
  const sources = bundle.sources;
  const ref = (where: string, ids: readonly string[]) => {
    for (const id of ids) if (!sources[id]) issues.push(`${where}: unknown source ref ${id}`);
  };
  const initialFor = (where: string, holder: ActorId, sourceRef: string | null) => {
    if (sourceRef === null) return;
    const entry = sources[sourceRef];
    if (!entry) {
      issues.push(`${where}: unknown source ref ${sourceRef}`);
      return;
    }
    if (!entry.learnable_by.some((l) => l.holder === holder && l.when === 'initial')) {
      issues.push(`${where}: source ${sourceRef} is not learnable initially by ${holder}`);
    }
  };

  // Characters and factions
  for (const id of CHAR_IDS) if (!bundle.characters[id]) issues.push(`characters: missing ${id}`);
  const factionIds = s.factions.map((f) => f.id);
  for (const f of FACTION_IDS) if (factionIds.filter((x) => x === f).length !== 1) issues.push(`scenario.factions: ${f} must appear exactly once`);
  for (const f of s.factions) {
    const principal = bundle.characters[f.principal];
    if (principal && (principal.faction !== f.id || !principal.principal)) {
      issues.push(`scenario.factions.${f.id}: principal ${f.principal} must be a principal of ${f.id}`);
    }
    ref(`scenario.factions.${f.id}`, f.source_refs);
    for (const [key, seed] of Object.entries(f.resources)) {
      if (seed !== undefined && typeof seed !== 'number') ref(`scenario.factions.${f.id}.resources.${key}`, seed.source_refs);
    }
  }
  const priorities = new Map<number, CharId>();
  for (const c of Object.values(bundle.characters)) {
    const faction = s.factions.find((f) => f.id === c.faction);
    const isPrincipal = faction?.principal === c.id;
    if (c.principal !== isPrincipal) issues.push(`characters/${c.id}: principal flag disagrees with scenario factions`);
    for (const perm of c.permissions) {
      if (PRINCIPAL_ONLY_ACTIONS.includes(perm) && !c.principal) issues.push(`characters/${c.id}: ${perm} is principal-only`);
    }
    const clash = priorities.get(c.commitPriority);
    if (clash) issues.push(`characters/${c.id}: commitPriority ${c.commitPriority} also used by ${clash}`);
    priorities.set(c.commitPriority, c.id);
    ref(`characters/${c.id}.source_refs`, c.source_refs);
    c.history_vs_assumption.forEach((h, i) => ref(`characters/${c.id}.history_vs_assumption[${i}]`, h.source_refs));
    c.initial_knowledge.forEach((k, i) => initialFor(`characters/${c.id}.initial_knowledge[${i}]`, c.id, k.source_ref));
    c.private_memory.forEach((m, i) =>
      m.source_refs.forEach((r) => initialFor(`characters/${c.id}.private_memory[${i}]`, c.id, r)),
    );
  }

  // Locations and travel
  const locIds = s.locations.map((l) => l.id);
  for (const l of LOC_IDS) if (!locIds.includes(l)) issues.push(`scenario.locations: missing ${l}`);
  s.locations.forEach((l) => ref(`scenario.locations.${l.id}`, l.source_refs));
  const travel = buildTravel(s);
  for (const a of LOC_IDS) {
    for (const b of LOC_IDS) {
      if (travel[a][b] < 0) issues.push(`scenario.travel: missing ${a} -> ${b}`);
      if (travel[a][b] !== travel[b][a]) issues.push(`scenario.travel: ${a} <-> ${b} is not symmetric`);
    }
  }
  for (const t of s.travel) if (t.from === t.to && t.days !== 0) issues.push(`scenario.travel: ${t.from} to itself must be 0`);

  // Terms catalog
  const catalog = buildCatalog(s);
  for (const key of SCALAR_TERM_KEYS) {
    const n = s.terms_catalog.terms.filter((t) => t.key === key).length;
    if (n !== 1) issues.push(`scenario.terms_catalog: ${key} must appear exactly once (found ${n})`);
  }
  for (const t of s.terms_catalog.terms) {
    const sem = TERM_SEMANTICS[t.key];
    const where = `scenario.terms_catalog.${t.key}`;
    if (t.type !== sem.type) issues.push(`${where}: type must be ${sem.type}`);
    if (sem.type === 'enum') {
      if (t.values && t.values.join(',') !== CESSION_VALUES.join(',')) issues.push(`${where}: values must be ${CESSION_VALUES.join(', ')}`);
      for (const v of Object.keys(t.burden_by_value ?? {})) {
        if (!(CESSION_VALUES as readonly string[]).includes(v)) issues.push(`${where}: burden_by_value has unknown level ${v}`);
      }
    }
    if (t.min !== null && t.max !== null && t.min > t.max) issues.push(`${where}: min > max`);
    for (const pair of t.applicable_pairs) {
      if (sem.trigger !== 'parameter' && payerFor(t.key, pair) === null) issues.push(`${where}: no payer in ${pair} for this term`);
    }
    ref(where, t.source_refs);
  }
  const clauseIds = new Set<string>();
  const canaries = new Set<string>();
  for (const c of s.terms_catalog.secret_clauses) {
    if (clauseIds.has(c.id)) issues.push(`scenario.terms_catalog.secret_clauses: duplicate id ${c.id}`);
    if (canaries.has(c.canary)) issues.push(`scenario.terms_catalog.secret_clauses: duplicate canary for ${c.id}`);
    clauseIds.add(c.id);
    canaries.add(c.canary);
    ref(`scenario.terms_catalog.secret_clauses.${c.id}`, c.source_refs);
  }

  // Terms cannot be checked against an incomplete catalog: stop here.
  if (!SCALAR_TERM_KEYS.every((key) => catalog.terms[key] !== undefined)) return issues;

  // Initial world
  const docIds = new Set<string>();
  for (const doc of s.initial_world.documents) {
    const where = `scenario.initial_world.documents.${doc.id}`;
    if (docIds.has(doc.id)) issues.push(`${where}: duplicate id`);
    docIds.add(doc.id);
    const holder = bundle.characters[doc.holder];
    const to = bundle.characters[doc.to];
    if (!holder || !to) continue;
    const toFaction = s.factions.find((f) => f.id === to.faction);
    if (toFaction?.principal !== doc.to) issues.push(`${where}: addressee ${doc.to} must be a principal`);
    const pair = pairOf(holder.faction, to.faction);
    if (!pair) {
      issues.push(`${where}: holder and addressee are not a principal pair`);
      continue;
    }
    const expanded = expandSeedTerms(doc.terms, catalog);
    if ('unknown' in expanded) issues.push(`${where}: unknown secret clauses ${expanded.unknown.join(', ')}`);
    else for (const p of validateTerms(expanded.terms, pair, catalog)) issues.push(`${where}: ${p}`);
  }
  s.initial_world.knowledge.forEach((k, i) => initialFor(`scenario.initial_world.knowledge[${i}]`, k.holder, k.source_ref));
  for (const entry of s.correspondence_access) {
    const faction = s.factions.find((f) => f.principal === entry.principal);
    if (!faction) issues.push(`scenario.correspondence_access: ${entry.principal} is not a principal`);
  }

  // Player
  for (const perm of s.player.permissions) {
    if (PLAYER_FORBIDDEN_ACTIONS.includes(perm)) issues.push(`scenario.player.permissions: the player may never ${perm}`);
  }
  s.player.initial_knowledge.forEach((k, i) => initialFor(`scenario.player.initial_knowledge[${i}]`, 'player', k.source_ref));
  ref('scenario.player', s.player.source_refs);

  // Epilogue (never_initial allowed)
  s.epilogue.historical_comparison.forEach((h, i) => ref(`scenario.epilogue.historical_comparison[${i}]`, h.source_refs));

  // Sources
  issues.push(...validateSources(sources));

  // Cases, dev, pilot
  const checkCase = (kind: string, c: CaseConfig) => {
    const where = `${kind}/${c.id}`;
    if (c.max_rounds > s.parameters.max_rounds) issues.push(`${where}: max_rounds exceeds ${s.parameters.max_rounds}`);
    for (const doc of c.initial_overrides.documents ?? []) {
      if (!docIds.has(doc.id)) issues.push(`${where}.initial_overrides: unknown document ${doc.id}`);
    }
    (c.initial_overrides.knowledge ?? []).forEach((k, i) => initialFor(`${where}.initial_overrides.knowledge[${i}]`, k.holder, k.source_ref));
    const seenClauses = new Set<string>();
    const merged = buildCatalog(s, c).secretClauses;
    const byCanary = new Map<string, string>();
    for (const clause of Object.values(merged)) {
      const owner = byCanary.get(clause.canary);
      if (owner !== undefined) issues.push(`${where}: clauses ${owner} and ${clause.id} share the canary ${clause.canary}`);
      else byCanary.set(clause.canary, clause.id);
    }
    for (const clause of c.initial_overrides.secret_clauses ?? []) {
      const at = `${where}.initial_overrides.secret_clauses.${clause.id}`;
      if (seenClauses.has(clause.id)) issues.push(`${at}: listed twice`);
      seenClauses.add(clause.id);
      const base = s.terms_catalog.secret_clauses.find((x) => x.id === clause.id);
      if (!base && (!clause.text || !clause.canary || !clause.applicable_pairs)) {
        issues.push(`${at}: a case-only clause needs text, canary and applicable_pairs`);
      }
      ref(at, clause.source_refs ?? []);
    }
    for (const [charId, o] of Object.entries(characterOverrides(c))) {
      (o?.private_memory ?? []).forEach((m, i) =>
        m.source_refs.forEach((r) => initialFor(`${where}.initial_overrides.characters.${charId}.private_memory[${i}]`, charId as CharId, r)),
      );
    }
    for (const round of c.script) {
      for (const input of round.inputs) {
        const when = input.when;
        if (when && typeof when === 'object' && 'doc_status' in when && !docIds.has(when.doc_status.docId)) {
          issues.push(`${where}.script round ${round.round}: condition refers to unknown document ${when.doc_status.docId}`);
        }
        if (!('action' in input)) continue;
        const parsed = parseAction(withPlaceholderSample(input.action));
        if (!parsed.ok) issues.push(`${where}.script round ${round.round}: invalid action: ${parsed.error}`);
        else if (!s.player.permissions.includes(parsed.value.type)) {
          issues.push(`${where}.script round ${round.round}: the player may not ${parsed.value.type}`);
        }
      }
    }
    c.decision_policy.forEach((rule, i) => {
      if (!FEASIBLE_OPTIONS[rule.match.category].includes(rule.choose)) {
        issues.push(`${where}.decision_policy[${i}]: ${rule.choose} is not a feasible option for ${rule.match.category}`);
      }
      if (rule.choose === 'adjust_goal' && rule.goal_limits === null) issues.push(`${where}.decision_policy[${i}]: adjust_goal needs goal_limits`);
      if (rule.choose === 'amend' && rule.amend === null) issues.push(`${where}.decision_policy[${i}]: amend needs amend`);
      if (rule.amend && typeof rule.amend.baseDocVersion === 'string' && rule.amend.baseDocVersion !== CURRENT_VERSION) {
        issues.push(`${where}.decision_policy[${i}]: amend baseDocVersion must be a number or "${CURRENT_VERSION}"`);
      }
      if (rule.choose === 'counter_draft' && rule.counter_terms === null) {
        issues.push(`${where}.decision_policy[${i}]: counter_draft needs counter_terms`);
      }
    });
    try {
      buildInitialState(bundle, c);
    } catch (err) {
      if (err instanceof ContentError) issues.push(...err.issues.map((m) => `${where}: ${m}`));
      else throw err;
    }
  };
  for (const c of Object.values(bundle.cases)) {
    checkCase('cases', c);
    // Evaluation cases carry no enforcement probes (PLAN §12.4): those belong to dev configs and tests.
    for (const round of c.script) {
      round.inputs.forEach((input, i) => {
        if (input.probe === true) issues.push(`cases/${c.id}.script round ${round.round} input ${i}: probe inputs are not allowed in evaluation cases`);
      });
    }
  }
  for (const c of Object.values(bundle.dev)) checkCase('dev', c);
  for (const c of Object.values(bundle.pilot)) checkCase('pilot', c);

  // Every formal case ships a reference trace (§12.4); coverage is driven from the case catalog.
  for (const id of Object.keys(bundle.cases).sort()) {
    if (!Object.hasOwn(bundle.traces, id)) issues.push(`cases/${id}: missing reference trace traces/${id}.trace.yaml`);
  }

  // Traces
  for (const trace of Object.values(bundle.traces)) {
    const where = `traces/${trace.case}`;
    const owner = bundle.cases[trace.case] ?? bundle.dev[trace.case] ?? bundle.pilot[trace.case];
    if (!owner) issues.push(`${where}: no case/dev/pilot config ${trace.case}`);
    else if (trace.max_rounds > owner.max_rounds) issues.push(`${where}: max_rounds exceeds the case's ${owner.max_rounds}`);
    if (owner && trace.expected.terminal && !owner.valid_terminals.includes(trace.expected.terminal)) {
      issues.push(`${where}: expected terminal ${trace.expected.terminal} is not a valid terminal of the case`);
    }
    const rounds = new Set<number>();
    for (const r of trace.rounds) {
      if (rounds.has(r.round)) issues.push(`${where}: round ${r.round} listed twice`);
      rounds.add(r.round);
      if (r.round > trace.max_rounds) issues.push(`${where}: round ${r.round} beyond max_rounds`);
      r.player.forEach((p, i) => {
        if (p.expect?.rule === 'H01') return;
        const parsed = parseAction(p.action);
        if (!parsed.ok) issues.push(`${where} round ${r.round} player[${i}]: invalid action: ${parsed.error}`);
      });
      for (const [g, gen] of [{ proposals: r.proposals, decisions: r.decisions }, ...r.regenerations].entries()) {
        const refs = new Set<string>();
        gen.proposals.forEach((p, i) => {
          if (p.ref) {
            if (refs.has(p.ref)) issues.push(`${where} round ${r.round} generation ${g}: duplicate ref ${p.ref}`);
            refs.add(p.ref);
          }
          if (p.actor === 'player') issues.push(`${where} round ${r.round}: player inputs belong in \`player\`, not proposals`);
          if (p.expect?.rule === 'H01' || p.actor === 'system') return;
          const parsed = parseAction(p.action);
          if (!parsed.ok) issues.push(`${where} round ${r.round} proposals[${i}]: invalid action: ${parsed.error}`);
        });
        gen.decisions.forEach((d, i) => {
          if (d.ref && !refs.has(d.ref)) issues.push(`${where} round ${r.round} decisions[${i}]: unknown ref ${d.ref}`);
          if (d.category && !FEASIBLE_OPTIONS[d.category].includes(d.choose)) {
            issues.push(`${where} round ${r.round} decisions[${i}]: ${d.choose} is not feasible for ${d.category}`);
          }
          if (!d.ref && d.category !== 'negotiation_deadlock') {
            issues.push(`${where} round ${r.round} decisions[${i}]: needs a proposal ref (or category negotiation_deadlock)`);
          }
        });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------------------------------------------

export interface StateOverrides {
  initial_overrides?: InitialOverrides | null;
  player_goal?: PlayerGoal | null;
}

function fullResources(partial: Partial<Record<(typeof RESOURCE_KEYS)[number], number>> = {}): ResourceMap {
  const out = {} as ResourceMap;
  for (const key of RESOURCE_KEYS) out[key] = partial[key] ?? 0;
  return out;
}

/**
 * The initial world state (version 0, round 1, day 0) for the scenario with optional case overrides.
 * Deterministic: the same content and overrides always give the same state (and hash).
 */
export function buildInitialState(bundle: ContentBundle, overrides: StateOverrides = {}): WorldState {
  const s = bundle.scenario;
  const issues: string[] = [];
  const catalog = buildCatalog(s, overrides);
  const ov = overrides.initial_overrides ?? {};

  const characters = {} as WorldState['characters'];
  for (const id of CHAR_IDS) {
    const c = bundle.characters[id];
    if (!c) throw new ContentError([`missing character ${id}`]);
    characters[id] = { status: 'alive', location: c.location, faction: c.faction };
  }
  const patches: Array<{ id: CharId; status?: CharacterOverride['status']; location?: LocId | undefined }> = [
    ...s.initial_world.characters,
    ...Object.entries(characterOverrides(overrides)).map(([id, o]) => ({ id: id as CharId, status: o?.status, location: o?.location })),
  ];
  for (const patch of patches) {
    const current = characters[patch.id];
    if (patch.status) current.status = patch.status;
    if (patch.location) current.location = patch.location;
  }

  const factions = {} as WorldState['factions'];
  for (const f of FACTION_IDS) {
    const seed = s.factions.find((x) => x.id === f);
    const amounts: Partial<Record<(typeof RESOURCE_KEYS)[number], number>> = {};
    for (const [key, value] of [...Object.entries(seed?.resources ?? {}), ...Object.entries(ov.resources?.[f] ?? {})]) {
      if (value !== undefined) amounts[key as (typeof RESOURCE_KEYS)[number]] = resourceAmount(value);
    }
    factions[f] = { resources: fullResources(amounts), reserved: fullResources() };
  }

  const documents: WorldState['documents'] = {};
  let maxDoc = 0;
  for (const seed of s.initial_world.documents) {
    const patch = (ov.documents ?? []).find((d) => d.id === seed.id);
    const termSeed: TermSetSeed = { ...seed.terms, ...(patch?.terms ?? {}) };
    const expanded = expandSeedTerms(termSeed, catalog);
    const holder = characters[seed.holder];
    const pair = pairOf(holder.faction, characters[seed.to].faction) as PairId | null;
    if ('unknown' in expanded) {
      issues.push(`${seed.id}: unknown secret clauses ${expanded.unknown.join(', ')}`);
      continue;
    }
    if (!pair) {
      issues.push(`${seed.id}: holder and addressee are not a principal pair`);
      continue;
    }
    for (const p of validateTerms(expanded.terms, pair, catalog)) issues.push(`${seed.id}: ${p}`);
    const timing = patch?.timing ?? seed.timing;
    const doc: Document = {
      id: seed.id,
      kind: seed.kind,
      holder: seed.holder,
      to: seed.to,
      accessibleBy: [...(patch?.accessibleBy ?? seed.accessibleBy)],
      version: 1,
      terms: expanded.terms,
      note: patch?.note ?? seed.note,
      status: 'draft',
      approval: null,
      timing: { mode: timing.mode, notBeforeRound: timing.notBeforeRound },
      history: [{ version: 1, by: seed.holder, round: 0 }],
      sentOfferId: null,
    };
    documents[doc.id] = doc;
    maxDoc = Math.max(maxDoc, Number(doc.id.split(':')[1]));
  }
  if (issues.length > 0) throw new ContentError(issues);

  const siege = { ...s.initial_world.siege, ...(ov.siege ?? {}) };
  const counters = initialCounters();
  counters.doc = maxDoc;

  const knowledge: WorldState['knowledge'] = {};
  const add = (item: Omit<KnowledgeItem, 'id' | 'asOfDay'>) => {
    counters.k = (counters.k ?? 0) + 1;
    const id = `k:${counters.k}`;
    knowledge[id] = { id, asOfDay: 0, ...item };
  };
  const seedItem = (
    holder: ActorId,
    k: { subject: string; predicate: KnowledgeItem['predicate']; value: unknown; credibility: number; visibility: KnowledgeItem['visibility']; source_ref: string | null },
  ) =>
    add({
      holder,
      subject: k.subject,
      predicate: k.predicate,
      value: k.value as JsonValue,
      evidence: k.source_ref ? { kind: 'source', ref: k.source_ref } : { kind: 'initial', ref: 'scenario' },
      credibility: k.credibility,
      visibility: k.visibility,
    });
  for (const k of s.initial_world.knowledge) seedItem(k.holder, k);
  for (const k of s.player.initial_knowledge) seedItem('player', k);
  for (const id of CHAR_IDS) for (const k of bundle.characters[id].initial_knowledge) seedItem(id, k);
  for (const k of ov.knowledge ?? []) seedItem(k.holder, k);

  const state: WorldState = {
    version: 0,
    round: 1,
    day: 0,
    counters,
    characters,
    player: {
      location: s.player.location,
      goal: structuredClone(overrides.player_goal ?? s.player.default_goal),
      authorizations: {},
    },
    factions,
    reservations: {},
    siege,
    documents,
    suggestions: {},
    commitments: {},
    offers: {},
    messages: {},
    knowledge,
    negotiation: initialNegotiation(),
    flags: { assistanceAbandoned: false, mutinyOccurred: false, khitanArrivalDay: null },
    terminal: null,
  };

  // Observers of each document start with its content (secret clauses filtered by knownBy).
  const config = buildCoreConfig(bundle, overrides);
  for (const doc of Object.values(documents)) {
    for (const observer of [...CHAR_IDS, 'player'] as const) {
      const at = observer === 'player' ? state.player.location : state.characters[observer].location;
      const alive = observer === 'player' || state.characters[observer].status === 'alive';
      if (!doc.accessibleBy.includes(observer) || !alive || at !== state.characters[doc.holder].location) continue;
      add({
        holder: observer,
        subject: doc.id,
        predicate: 'content',
        value: {
          docId: doc.id,
          version: doc.version,
          status: doc.status,
          terms: {
            ...doc.terms,
            secret_clauses: doc.terms.secret_clauses.filter((c) => own(config.catalog.secretClauses, c.id)?.knownBy.includes(observer)),
          },
          note: doc.note,
          timing: doc.timing,
          approval: doc.approval,
          to: doc.to,
        } as unknown as JsonValue,
        evidence: { kind: 'initial', ref: 'scenario' },
        credibility: 1,
        visibility: 'faction',
      });
    }
  }
  const inTransit = ov.in_transit ?? [];
  if (inTransit.length === 0) return state;
  return withPreStartMessages(state, config, catalog, inTransit);
}

/**
 * Builds `initial_overrides.in_transit` into the initial state (version stays 0), validating each entry like a
 * committed offer: principals of a real pair, valid terms, no second negotiating thread, H13 caps and the
 * sender's reservation feasibility (H07). Entries are applied in file order.
 */
function withPreStartMessages(
  state: WorldState,
  config: CoreConfig,
  catalog: TermsCatalog,
  entries: NonNullable<InitialOverrides['in_transit']>,
): WorldState {
  const issues: string[] = [];
  const d = new Draft(state);
  entries.forEach((e, i) => {
    const at = `in_transit[${i}]`;
    if (e.from === e.to) {
      issues.push(`${at}: sender and recipient are the same`);
      return;
    }
    const fromLoc = d.s.characters[e.from].location;
    const toLoc = d.s.characters[e.to].location;
    const travel = config.travel[fromLoc][toLoc];
    const sentDay = e.sent_day ?? e.arrival_day - travel;
    // G02 holds for pre-start messages too: sent by the chapter start, arriving exactly `travel` days later.
    if (sentDay > 0) {
      issues.push(`${at}: sent_day ${sentDay} is after the chapter start (pre-start messages are sent on or before day 0)`);
      return;
    }
    if (e.arrival_day !== sentDay + travel) {
      issues.push(`${at}: arrival_day ${e.arrival_day} must be sent_day + travel (${sentDay} + ${travel}) under G02`);
      return;
    }
    if (e.kind === 'letter') {
      seedPreStart(d, config, { kind: 'letter', from: e.from, to: e.to, text: e.text, sentDay, arrivalDay: e.arrival_day });
      return;
    }
    const principal = (c: CharId) => config.factions[d.s.characters[c].faction].principal === c;
    if (!principal(e.from) || !principal(e.to)) {
      issues.push(`${at}: offers are sent between principals (${e.from} → ${e.to})`);
      return;
    }
    const pair = pairOf(d.s.characters[e.from].faction, d.s.characters[e.to].faction);
    if (!pair) {
      issues.push(`${at}: ${e.from} and ${e.to} are not a principal pair`);
      return;
    }
    const expanded = expandSeedTerms(e.terms, catalog);
    if ('unknown' in expanded) {
      issues.push(`${at}: unknown secret clauses ${expanded.unknown.join(', ')}`);
      return;
    }
    const problems = validateTerms(expanded.terms, pair, catalog);
    if (problems.length > 0) {
      issues.push(...problems.map((p) => `${at}: ${p}`));
      return;
    }
    const current = d.s as WorldState;
    // H08 as for committed offers: a sender can only include secret clauses it knows.
    const unknown = expanded.terms.secret_clauses.filter((c) => !knowsClause(current, config, e.from, c.id)).map((c) => c.id);
    if (unknown.length > 0) {
      issues.push(`${at}: ${e.from} does not know secret clause(s) ${unknown.join(', ')} (H08)`);
      return;
    }
    if (negotiatingThread(current, pair)) {
      issues.push(`${at}: ${pair} already has a negotiating thread`);
      return;
    }
    const cap = checkOfferCap(current, config, pair);
    if (!cap.ok) {
      issues.push(`${at}: ${cap.reason}`);
      return;
    }
    const feasible = checkConsentFeasible(current, current.characters[e.from].faction, deriveObligations(expanded.terms, pair), null);
    if (!feasible.ok) {
      issues.push(`${at}: ${feasible.reason}`);
      return;
    }
    seedPreStart(d, config, { kind: 'offer', from: e.from, to: e.to, terms: expanded.terms, note: e.note, sentDay, arrivalDay: e.arrival_day });
  });
  if (issues.length > 0) throw new ContentError(issues);
  return structuredClone(d.s as WorldState);
}

/** Initial state for a case/dev/pilot config id. */
export function caseInitialState(bundle: ContentBundle, id: string): WorldState {
  return buildInitialState(bundle, findCase(bundle, id));
}

/** Rules configuration for a case/dev/pilot config id (its clause library applied). */
export function caseCoreConfig(bundle: ContentBundle, id: string): CoreConfig {
  return buildCoreConfig(bundle, findCase(bundle, id));
}

/** Converts a validated trace file into the core runner's spec. */
export function toTraceSpec(trace: TraceConfig): TraceSpec {
  return {
    case: trace.case,
    max_rounds: trace.max_rounds,
    rounds: trace.rounds.map((r) => ({
      round: r.round,
      player: r.player.map((p) => ({ action: p.action, expect: p.expect })),
      proposals: r.proposals.map((p) => ({ ref: p.ref, actor: p.actor, action: p.action, ask_player: p.ask_player, expect: p.expect })),
      decisions: r.decisions,
      regenerations: r.regenerations,
      mutiny: r.mutiny,
    })),
    expected: { terminal: trace.expected.terminal, round: trace.expected.round },
  };
}
