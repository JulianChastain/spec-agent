// Turning a "provider:model" string into an AI SDK model, plus the small
// per-provider differences ("overlays") the rest of the agent shouldn't know
// about. DECISIONS.md explains each overlay.
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel, ModelMessage } from "ai";
import { scriptedMockModel } from "./mock.ts";

export type ProviderName = "openai" | "anthropic" | "google" | "mock";

export interface ModelRef {
  key: string; // "anthropic:claude-opus-5-5", the key into PRICES
  provider: ProviderName;
  id: string;
}

export function parseModel(key: string): ModelRef {
  const [provider, ...rest] = key.split(":");
  const id = rest.join(":");
  if (!id || !["openai", "anthropic", "google", "mock"].includes(provider ?? "")) {
    throw new Error(`model must look like provider:model-id (openai|anthropic|google|mock), got ${JSON.stringify(key)}`);
  }
  return { key, provider: provider as ProviderName, id };
}

/** The API key each provider's SDK reads from the environment. */
export const KEY_ENV: Record<ProviderName, string | null> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mock: null,
};

export function createModel(ref: ModelRef): LanguageModel {
  const env = KEY_ENV[ref.provider];
  if (env && !process.env[env]) throw new Error(`${env} is not set; it is needed for ${ref.key}`);
  switch (ref.provider) {
    // `openai(id)` uses the Responses API, which is what reports cached tokens.
    case "openai": return openai(ref.id);
    case "anthropic": return anthropic(ref.id);
    case "google": return google(ref.id);
    case "mock": return scriptedMockModel(ref.id);
  }
}

/**
 * Anthropic overlay: prompt caching is opt-in, per message. Without it every
 * step re-bills the whole history at the full input price, which in a 300-step
 * run is most of the bill. We mark two breakpoints: the end of the pinned
 * prefix (system prompt + spec), which never changes between compactions, and
 * the newest message, so the next step reads everything before it from cache.
 * OpenAI and Gemini cache prefixes automatically, so they need nothing.
 */
export function withCacheBreakpoints(ref: ModelRef, messages: ModelMessage[], pinnedCount: number): ModelMessage[] {
  if (ref.provider !== "anthropic" || messages.length === 0) return messages;
  const mark = (m: ModelMessage): ModelMessage => ({
    ...m,
    providerOptions: { ...m.providerOptions, anthropic: { cacheControl: { type: "ephemeral" } } },
  });
  const marks = new Set([Math.min(pinnedCount, messages.length) - 1, messages.length - 1]);
  return messages.map((m, i) => (marks.has(i) ? mark(m) : m));
}
