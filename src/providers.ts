// Turning a "provider:model" string into an AI SDK model, plus the small
// per-provider differences ("overlays") the rest of the agent shouldn't know
// about. DECISIONS.md explains each overlay.
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel, ModelMessage } from "ai";
import { scriptedMockModel } from "./mock.ts";

export type ProviderName = "openai" | "anthropic" | "google" | "openrouter" | "mock";
const PROVIDERS: ProviderName[] = ["openai", "anthropic", "google", "openrouter", "mock"];

export interface ModelRef {
  key: string; // "anthropic:claude-opus-5-5", the key into PRICES
  provider: ProviderName; // who we send the request to
  vendor: string; // who made the model: the provider, or for openrouter the "<vendor>/" prefix
  id: string;
}

export function parseModel(key: string): ModelRef {
  const [provider, ...rest] = key.split(":");
  const id = rest.join(":");
  if (!id || !PROVIDERS.includes(provider as ProviderName)) {
    throw new Error(`model must look like provider:model-id (${PROVIDERS.join("|")}), got ${JSON.stringify(key)}`);
  }
  if (provider === "openrouter" && !/^[a-z0-9-]+\/[^/]+$/.test(id)) {
    throw new Error(`openrouter models must look like openrouter:<vendor>/<model>, got ${JSON.stringify(key)}`);
  }
  const vendor = provider === "openrouter" ? id.split("/")[0]! : provider!;
  return { key, provider: provider as ProviderName, vendor, id };
}

/** The API key each provider's SDK reads from the environment. */
export const KEY_ENV: Record<ProviderName, string | null> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mock: null,
};

/**
 * OpenRouter overlay: which upstream serves each vendor's models. OpenRouter
 * load-balances across every host of a model (OpenAI, Azure, Bedrock,
 * Vertex, ...) by default. We pin each vendor to its own first-party,
 * standard-tier endpoint with no fallbacks, so every call of a run hits the
 * same API at the same price, and the prompt cache isn't split across hosts.
 * A base slug never opts into the /fast, /flex or /priority tiers.
 */
export const OPENROUTER_UPSTREAM: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google-ai-studio",
};

export function openRouterSettings(ref: ModelRef) {
  const upstream = OPENROUTER_UPSTREAM[ref.vendor];
  if (!upstream) throw new Error(`no pinned OpenRouter upstream for vendor ${ref.vendor}; add it to OPENROUTER_UPSTREAM`);
  return {
    provider: { only: [upstream], allow_fallbacks: false, require_parameters: true },
    // Deprecated upstream (usage is now always returned), harmless, and it
    // keeps `usage.cost` coming back if that default ever changes.
    usage: { include: true },
  };
}

export function createModel(ref: ModelRef): LanguageModel {
  const env = KEY_ENV[ref.provider];
  if (env && !process.env[env]) throw new Error(`${env} is not set; it is needed for ${ref.key}`);
  switch (ref.provider) {
    // `openai(id)` uses the Responses API, which is what reports cached tokens.
    case "openai": return openai(ref.id);
    case "anthropic": return anthropic(ref.id);
    case "google": return google(ref.id);
    case "openrouter": return createOpenRouter({ apiKey: process.env[env!] })(ref.id, openRouterSettings(ref));
    case "mock": return scriptedMockModel(ref.id);
  }
}

/**
 * Cache overlay: which models need explicit cache breakpoints. Anthropic's
 * caching is opt-in, per message, directly or through OpenRouter. Without it
 * every step re-bills the whole history at the full input price, which in a
 * 300-step run is most of the bill. We mark two breakpoints: the end of the
 * pinned prefix (system prompt + spec), which never changes between
 * compactions, and the newest message, so the next step reads everything
 * before it from cache. OpenAI and Gemini cache prefixes implicitly; DECISIONS.md
 * records what was measured for each through OpenRouter.
 */
export function needsCacheBreakpoints(ref: ModelRef): boolean {
  return ref.vendor === "anthropic";
}

export function withCacheBreakpoints(ref: ModelRef, messages: ModelMessage[], pinnedCount: number): ModelMessage[] {
  if (!needsCacheBreakpoints(ref) || messages.length === 0) return messages;
  // Same directive, different option namespace: @ai-sdk/anthropic reads
  // `anthropic`, @openrouter/ai-sdk-provider reads `openrouter` and sends it
  // as a `cache_control` block, OpenRouter's documented mechanism.
  const ns = ref.provider === "openrouter" ? "openrouter" : "anthropic";
  const mark = (m: ModelMessage): ModelMessage => ({
    ...m,
    providerOptions: { ...m.providerOptions, [ns]: { cacheControl: { type: "ephemeral" } } },
  });
  const marks = new Set([Math.min(pinnedCount, messages.length) - 1, messages.length - 1]);
  return messages.map((m, i) => (marks.has(i) ? mark(m) : m));
}
