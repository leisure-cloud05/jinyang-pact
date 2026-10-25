/**
 * Price BOUNDS (USD per million input/output tokens) used for three things:
 *  1. OpenRouter routing: each request carries `provider.max_price = { prompt, completion }` (USD per
 *     million tokens, https://openrouter.ai/docs/guides/routing/provider-selection#max-price), so no
 *     endpoint above the bound can serve it;
 *  2. the budget guard's worst-case reservation;
 *  3. the cost estimate when a response reports token counts but no `usage.cost` (an upper bound).
 *
 * Source: OpenRouter endpoint listings (`/api/v1/models/<slug>/endpoints`), checked 2026-09-27.
 * - deepseek/deepseek-v4-flash: lowest listed endpoint 0.0469 / 0.0938 (Baidu). Structured-output
 *   endpoints DigitalOcean 0.098 / 0.196 and AtlasCloud 0.14 / 0.28 are inside the bound 0.15 / 0.30;
 *   Relace (0.03 / 1.28) and Azure (0.21 / 0.56) are excluded by it.
 * - deepseek/deepseek-v4-pro: Baidu 0.34645 / 0.6929 and StreamLake 0.348 / 0.696 (both structured
 *   outputs) are inside the bound 0.40 / 0.80; all other endpoints (≥ 0.957 / 1.914) are excluded.
 * Other models need an explicit bound (`LLM_PRICE_BOUNDS`) before live calls are admitted.
 */

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  note: string;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export const DEFAULT_PRICES: PriceTable = {
  'deepseek/deepseek-v4-flash': {
    inputUsdPerMTok: 0.15,
    outputUsdPerMTok: 0.3,
    note: 'bound enforced via provider.max_price; OpenRouter listing 2026-09-27 (lowest endpoint 0.0469/0.0938)',
  },
  'deepseek/deepseek-v4-pro': {
    inputUsdPerMTok: 0.4,
    outputUsdPerMTok: 0.8,
    note: 'bound enforced via provider.max_price; OpenRouter listing 2026-09-27 (lowest endpoint 0.348/0.696)',
  },
};

/** Exact slug first, then the slug without an OpenRouter variant suffix (`:nitro`, `:floor`, …). */
export function lookupPrice(model: string, table: PriceTable = DEFAULT_PRICES): ModelPrice | undefined {
  const exact = table[model];
  if (exact) return exact;
  const colon = model.indexOf(':');
  return colon > 0 ? table[model.slice(0, colon)] : undefined;
}

/** `provider.max_price` for a bound (USD per million tokens). */
export function maxPriceParam(price: ModelPrice): { prompt: number; completion: number } {
  return { prompt: price.inputUsdPerMTok, completion: price.outputUsdPerMTok };
}

/** Cost at the bound, or `null` when the model has no bound (never a silent 0). */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  table: PriceTable = DEFAULT_PRICES,
): number | null {
  const price = lookupPrice(model, table);
  if (!price) return null;
  return (inputTokens * price.inputUsdPerMTok + outputTokens * price.outputUsdPerMTok) / 1_000_000;
}

/**
 * Parses `LLM_PRICE_BOUNDS`: comma-separated `vendor/model=<input>/<output>` entries in USD per million
 * tokens, e.g. `qwen/qwen3-max=1.2/6,deepseek/deepseek-v4-flash=0.1/0.2`.
 */
export function parsePriceBounds(text: string): { table: Record<string, ModelPrice>; problems: string[] } {
  const table: Record<string, ModelPrice> = {};
  const problems: string[] = [];
  for (const entry of text.split(',').map((e) => e.trim()).filter((e) => e.length > 0)) {
    const eq = entry.lastIndexOf('=');
    const slug = eq > 0 ? entry.slice(0, eq).trim() : '';
    const [input, output, extra] = eq > 0 ? entry.slice(eq + 1).split('/') : [];
    const inputUsd = Number(input);
    const outputUsd = Number(output);
    if (!slug || extra !== undefined || !(inputUsd > 0) || !(outputUsd > 0) || !Number.isFinite(inputUsd) || !Number.isFinite(outputUsd)) {
      problems.push(`LLM_PRICE_BOUNDS entry "${entry.length > 80 ? `${entry.slice(0, 80)}…` : entry}" must look like vendor/model=<input>/<output> with positive USD per million tokens`);
      continue;
    }
    table[slug] = { inputUsdPerMTok: inputUsd, outputUsdPerMTok: outputUsd, note: 'LLM_PRICE_BOUNDS' };
  }
  return { table, problems };
}
