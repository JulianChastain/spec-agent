// One JSONL event stream per run. Every line has `type` and `t` (ms since
// the run started). The stream goes to stdout, which replicate-lang's harness
// saves verbatim as transcript.jsonl, and optionally to a file as well.
//
// Event types:
//   run_start    the resolved config
//   message      every message added to the history (assistant turns, tool
//                results, nudges): together, the full transcript
//   model_call   one per model request: tokens, cost, latency, TTFT, tool calls
//   tool_call    name, ok, duration, size of the result
//   compaction   before/after sizes and the summary that replaced old turns
//   result       why the run stopped, totals. `total_cost_usd` is the field
//                the harness's cost meter already understands.
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type Event = { type: string } & Record<string, unknown>;

// A type alias rather than an interface, so it is assignable to Event's
// index signature.
export type ModelCallEvent = {
  type: "model_call";
  step: number;
  purpose: "main" | "compaction";
  provider: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number; // costUsdReported when there is one, else costUsdPriced
  costUsdPriced: number; // from src/pricing.ts
  costUsdReported: number | null; // the provider's own figure (OpenRouter usage.cost)
  upstream: string | null; // the host OpenRouter routed to; null for direct APIs
  latencyMs: number;
  ttftMs: number | null; // null when no token arrived (e.g. the call failed)
  finishReason: string;
  toolCalls: string[];
  error?: string;
  failed?: boolean; // the call failed mid-stream but was billed; tokens and cost are OpenRouter's
  generationId?: string;
};

export class Telemetry {
  private start = Date.now();
  readonly events: Event[] = []; // kept in memory too, for tests and the final summary

  constructor(private opts: { stdout: boolean; file?: string; keepInMemory?: boolean }) {
    if (opts.file) mkdirSync(path.dirname(opts.file), { recursive: true });
  }

  emit(e: Event): void {
    const line = JSON.stringify({ ...e, t: Date.now() - this.start });
    if (this.opts.stdout) process.stdout.write(line + "\n");
    if (this.opts.file) appendFileSync(this.opts.file, line + "\n");
    if (this.opts.keepInMemory !== false) this.events.push(e);
  }

  calls(): ModelCallEvent[] {
    return this.events.filter((e): e is ModelCallEvent & Event => e.type === "model_call");
  }
}
