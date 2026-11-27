// Per-token prices, in USD per 1M tokens, copied from each provider's pricing
// page. Every entry names the page it came from. Standard tier
// only (no batch / flex / priority).
//
// Cost model: input tokens are split into three buckets that providers bill
// differently: fresh (uncached) input, cache reads and cache writes. Providers
// that don't bill cache writes separately (OpenAI, Gemini implicit caching)
// have cacheWrite equal to input.

export interface Price {
  input: number;
  cachedInput: number; // cache read / hit
  cacheWrite: number; // 5-minute cache write; equals `input` where not billed separately
  output: number; // includes reasoning tokens for every provider listed here
  // Above this many prompt tokens, the `long` prices apply to the whole request.
  longContext?: { thresholdTokens: number; input: number; cachedInput: number; cacheWrite: number; output: number };
  contextWindow: number; // tokens, from the provider's models page
  source: string;
  note?: string;
}

const OPENAI = "https://developers.openai.com/api/docs/pricing (models: https://developers.openai.com/api/docs/models)";
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing (models: https://platform.claude.com/docs/en/about-claude/models/overview)";
const GOOGLE = "https://aistudio.google.com/docs/pricing (redirected from https://ai.google.dev/gemini-api/docs/pricing; models: https://aistudio.google.com/docs/models)";

const openrouter = (slug: string, endpoint: string) =>
  `https://openrouter.ai/api/v1/models/${slug}/endpoints (endpoint "${endpoint}"; page: https://openrouter.ai/${slug}), retrieved 2026-11-27`;

export const PRICES: Record<string, Price> = {
  // OpenAI. Long context is ">272K input tokens".
  "openai:gpt-6.2-astra": {
    input: 8.0, cachedInput: 0.4, cacheWrite: 8.0, output: 40.0,
    longContext: { thresholdTokens: 272_000, input: 16.0, cachedInput: 0.8, cacheWrite: 16.0, output: 60.0 },
    contextWindow: 1_050_000, source: OPENAI,
  },
  "openai:gpt-6-luna": {
    input: 0.1, cachedInput: 0.01, cacheWrite: 0.1, output: 0.5,
    longContext: { thresholdTokens: 272_000, input: 0.2, cachedInput: 0.02, cacheWrite: 0.2, output: 0.75 },
    contextWindow: 1_050_000, source: OPENAI,
  },
  // Anthropic. Opus 5.5 has no long-context surcharge; Haiku 5.5 does above 100K.
  "anthropic:claude-opus-5-5": {
    input: 4.0, cachedInput: 0.2, cacheWrite: 5.0, output: 20.0,
    contextWindow: 1_000_000, source: ANTHROPIC,
  },
  "anthropic:claude-haiku-5-5": {
    input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5,
    longContext: { thresholdTokens: 100_000, input: 0.5, cachedInput: 0.05, cacheWrite: 0.625, output: 2.5 },
    contextWindow: 1_000_000, source: ANTHROPIC,
  },
  // Google. Gemini 4 Carbon prices double on 2026-12-01; these are the prices
  // in force "through November 30, 2026", when every run here took place.
  "google:gemini-4-carbon": {
    input: 2.0, cachedInput: 0.1, cacheWrite: 2.0, output: 10.0,
    contextWindow: 1_000_000, source: GOOGLE,
    note: "Through 2026-11-30. From 2026-12-01: input 4.00, cached 0.20, output 20.00.",
  },
  // Cached-input storage ($1.00/1M tokens/hour) is not modelled: we rely on
  // implicit caching, which has no storage charge.
  "google:gemini-3.5-flash-lite": {
    input: 0.3, cachedInput: 0.03, cacheWrite: 0.3, output: 2.5,
    contextWindow: 1_000_000, source: GOOGLE,
    note: "Context window not stated on the pages read; 1M assumed for estimates only (it never affects cost).",
  },
  // OpenRouter, pinned to each vendor's first-party standard endpoint
  // (src/providers.ts, OPENROUTER_UPSTREAM). Prices are that endpoint's, from
  // the models API on 2026-11-27; results/openrouter-prices/ holds the raw
  // snapshots taken on each run date. OpenRouter reports each call's billed
  // cost itself, and that figure is what runs are metered on; these prices
  // are for the pre-call budget estimate and the cross-check. OpenRouter
  // lists cache writes for OpenAI models at 1.25x input, where OpenAI's own
  // page bills none; they only apply if OpenRouter reports cache_write_tokens.
  // OpenRouter's long-context tiers start at min_prompt_tokens (>=); ours at >.
  "openrouter:openai/gpt-6.2-astra": {
    input: 8.0, cachedInput: 0.4, cacheWrite: 10.0, output: 40.0,
    longContext: { thresholdTokens: 272_000, input: 16.0, cachedInput: 0.8, cacheWrite: 20.0, output: 60.0 },
    contextWindow: 1_050_000, source: openrouter("openai/gpt-6.2-astra", "openai"),
  },
  "openrouter:openai/gpt-6-luna": {
    input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5,
    longContext: { thresholdTokens: 272_000, input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 },
    contextWindow: 1_050_000, source: openrouter("openai/gpt-6-luna", "openai"),
  },
  "openrouter:anthropic/claude-opus-5.5": {
    input: 4.0, cachedInput: 0.2, cacheWrite: 5.0, output: 20.0,
    contextWindow: 1_000_000, source: openrouter("anthropic/claude-opus-5.5", "anthropic"),
  },
  "openrouter:anthropic/claude-haiku-5.5": {
    input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5,
    longContext: { thresholdTokens: 100_000, input: 0.5, cachedInput: 0.05, cacheWrite: 0.625, output: 2.5 },
    contextWindow: 1_000_000, source: openrouter("anthropic/claude-haiku-5.5", "anthropic"),
  },
  // Same as Google's direct price through 2026-11-30. Whether OpenRouter
  // follows the 2026-12-01 doubling is recorded by the dated snapshots.
  "openrouter:google/gemini-4-carbon": {
    input: 2.0, cachedInput: 0.1, cacheWrite: 0.1875, output: 10.0,
    contextWindow: 1_048_576, source: openrouter("google/gemini-4-carbon", "google-ai-studio"),
    note: "OpenRouter lists input_cache_write 0.1875/1M for this endpoint.",
  },
  "openrouter:google/gemini-3.5-flash-lite": {
    input: 0.3, cachedInput: 0.03, cacheWrite: 0.0833333, output: 2.5,
    contextWindow: 1_048_576, source: openrouter("google/gemini-3.5-flash-lite", "google-ai-studio"),
  },
  // The zero-cost mock used by tests and the harness dry run.
  "mock:stub": { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, contextWindow: 200_000, source: "n/a" },
};

export interface TokenUsage {
  inputTokens: number; // total prompt tokens, including cached ones
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function priceFor(modelKey: string): Price {
  const p = PRICES[modelKey];
  if (!p) throw new Error(`no price for ${modelKey}; add it to src/pricing.ts (with a source URL) before running it`);
  return p;
}

/** Dollar cost of one model call. */
export function costOf(modelKey: string, u: TokenUsage): number {
  const p = priceFor(modelKey);
  const tier = p.longContext && u.inputTokens > p.longContext.thresholdTokens ? p.longContext : p;
  // Fresh input is whatever wasn't served from or written to the cache.
  const fresh = Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens);
  return (fresh * tier.input + u.cacheReadTokens * tier.cachedInput
    + u.cacheWriteTokens * tier.cacheWrite + u.outputTokens * tier.output) / 1e6;
}
