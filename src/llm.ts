// One model request. We use streamText rather than generateText only so we
// can time the first token (TTFT); the stream is consumed to the end either
// way. Tools have no `execute`, so the SDK makes exactly one request and hands
// the tool calls back to us.
import { streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { costOf } from "./pricing.ts";
import type { ModelRef } from "./providers.ts";
import type { ModelCallEvent } from "./telemetry.ts";

export interface CallResult {
  responseMessages: ModelMessage[];
  toolCalls: { toolCallId: string; toolName: string; input: unknown }[];
  text: string;
  event: ModelCallEvent;
}

export interface CallOptions {
  ref: ModelRef;
  model: LanguageModel;
  instructions: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxOutputTokens: number;
  abortSignal?: AbortSignal;
  step: number;
  purpose: ModelCallEvent["purpose"];
}

/** OpenRouter's billed cost for the call (`usage.cost`, USD), if it sent one. */
export function reportedCost(meta: unknown): number | null {
  const c = (meta as any)?.openrouter?.usage?.cost;
  return typeof c === "number" && Number.isFinite(c) ? c : null;
}

/** Which upstream OpenRouter routed the call to, e.g. "Anthropic". */
export function upstreamOf(meta: unknown): string | null {
  const p = (meta as any)?.openrouter?.provider;
  return typeof p === "string" ? p : null;
}

const FIRST_TOKEN = new Set(["text-delta", "reasoning-delta", "tool-input-start", "tool-call"]);

export async function callModel(o: CallOptions): Promise<CallResult> {
  const started = performance.now();
  let firstTokenAt: number | null = null;
  let streamError: unknown;
  const result = streamText({
    model: o.model,
    instructions: o.instructions,
    messages: o.messages,
    tools: o.tools,
    maxOutputTokens: o.maxOutputTokens,
    abortSignal: o.abortSignal,
    maxRetries: 3, // SDK-level retries with backoff, for 429s and 5xx
  });
  for await (const part of result.stream) {
    if (firstTokenAt === null && FIRST_TOKEN.has(part.type)) firstTokenAt = performance.now();
    // Stream errors arrive as parts rather than exceptions; keep the first.
    if (part.type === "error" && streamError === undefined) streamError = part.error;
  }
  if (streamError !== undefined) throw streamError;

  const [usage, finishReason, toolCalls, responseMessages, text, providerMetadata] = await Promise.all([
    result.usage, result.finishReason, result.toolCalls, result.responseMessages, result.text, result.providerMetadata,
  ]);
  const tokens = {
    inputTokens: usage.inputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  const priced = costOf(o.ref.key, tokens);
  const billed = reportedCost(providerMetadata);
  const event: ModelCallEvent = {
    type: "model_call",
    step: o.step,
    purpose: o.purpose,
    provider: o.ref.provider,
    model: o.ref.id,
    ...tokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    // What the call cost: the provider's own figure when it reports one
    // (OpenRouter does, per call), else our price table. Both are logged so
    // the report can cross-check them.
    costUsd: billed ?? priced,
    costUsdPriced: priced,
    costUsdReported: billed,
    upstream: upstreamOf(providerMetadata),
    latencyMs: Math.round(performance.now() - started),
    ttftMs: firstTokenAt === null ? null : Math.round(firstTokenAt - started),
    finishReason,
    toolCalls: toolCalls.map((c) => c.toolName),
  };
  return {
    responseMessages: responseMessages as ModelMessage[],
    toolCalls: toolCalls.map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })),
    text,
    event,
  };
}

// ---- Failed calls ---------------------------------------------------------
// A call can fail after the provider has started generating: OpenRouter
// answers 200, streams, and then the connection drops ("other side closed").
// The SDK then has no usage for us, but OpenRouter still bills the tokens
// generated before the drop. These helpers find out what such a call cost,
// so it counts against the budget and the meter like any other call.

/** The error and its causes, one line: "AI_APICallError: ... <- TypeError: terminated <- UND_ERR_SOCKET: other side closed". */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  for (let x: any = e, i = 0; x && i < 4; x = x.cause, i++) {
    parts.push(`${x.code ?? x.name ?? "Error"}: ${String(x.message ?? x).slice(0, 300)}`);
  }
  return parts.join(" <- ");
}

/** Connection-level failures worth retrying more patiently than other errors. */
export function isTransportError(e: unknown): boolean {
  return /UND_ERR_SOCKET|UND_ERR_|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|terminated|other side closed|Failed to process successful response/i
    .test(describeError(e));
}

/** The OpenRouter generation id of a failed call, from the response headers the SDK error keeps. */
export function generationIdOf(e: unknown): string | null {
  for (let x: any = e, i = 0; x && i < 4; x = x.cause, i++) {
    const h = x.responseHeaders;
    const id = h?.["x-generation-id"] ?? (typeof h?.get === "function" ? h.get("x-generation-id") : undefined);
    if (typeof id === "string" && /^gen-[0-9A-Za-z-]+$/.test(id)) return id;
  }
  return null;
}

export interface FailedCallBill {
  generationId: string;
  costUsd: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  upstream: string | null;
}

/**
 * What OpenRouter billed for one generation (GET /api/v1/generation). Its
 * stats can take a minute or more to appear, so it retries for ~2 minutes; null if
 * they never do (the key-level cross-check in the report still counts it).
 */
export async function lookupOpenRouterBill(generationId: string, apiKey: string, opts: {
  fetch?: typeof fetch; delaysMs?: number[];
} = {}): Promise<FailedCallBill | null> {
  const f = opts.fetch ?? fetch;
  // Stats for a cancelled generation took minutes to appear in the smoke runs.
  for (const delay of opts.delaysMs ?? [5_000, 15_000, 30_000, 60_000]) {
    await new Promise((res) => setTimeout(res, delay));
    try {
      const res = await f(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`,
        { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const d = ((await res.json()) as any)?.data;
      if (typeof d?.total_cost !== "number") continue;
      return {
        generationId,
        costUsd: d.total_cost,
        inputTokens: d.native_tokens_prompt ?? d.tokens_prompt ?? 0,
        cacheReadTokens: d.native_tokens_cached ?? 0,
        outputTokens: d.native_tokens_completion ?? d.tokens_completion ?? 0,
        upstream: d.provider_name ?? null,
      };
    } catch { /* retry */ }
  }
  return null;
}
