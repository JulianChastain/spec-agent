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

  const [usage, finishReason, toolCalls, responseMessages, text] = await Promise.all([
    result.usage, result.finishReason, result.toolCalls, result.responseMessages, result.text,
  ]);
  const tokens = {
    inputTokens: usage.inputTokens ?? 0,
    cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  };
  const event: ModelCallEvent = {
    type: "model_call",
    step: o.step,
    purpose: o.purpose,
    provider: o.ref.provider,
    model: o.ref.id,
    ...tokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    costUsd: costOf(o.ref.key, tokens),
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
