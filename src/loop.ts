// The agent loop. Each iteration: check the budgets, compact if the context
// is too big, make one model call, run the tool calls it asked for, append
// the results. It ends on `finish`, the step limit, the wall-clock budget,
// the dollar budget, or repeated failures.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LanguageModel, ModelMessage, ToolResultPart } from "ai";
import type { Config } from "./config.ts";
import {
  buildSummaryBlock, estimateTokens, readNotes, renderForSummary, splitPoint, toMessages, workspaceIndex,
  type ConversationState,
} from "./compaction.ts";
import { callModel, type CallResult } from "./llm.ts";
import { priceFor } from "./pricing.ts";
import { withCacheBreakpoints, type ModelRef } from "./providers.ts";
import type { Telemetry } from "./telemetry.ts";
import { executeTool, toolSet, type ToolContext } from "./tools.ts";

export type StopReason =
  | "finish" | "step limit" | "time budget" | "dollar budget" | "context full"
  | "model error" | "no tool calls";

export interface RunResult {
  stopReason: StopReason;
  steps: number;
  costUsd: number;
  compactions: number;
  wallS: number;
  finishSummary?: string;
}

export interface AgentDeps {
  main: { ref: ModelRef; model: LanguageModel };
  compactor: { ref: ModelRef; model: LanguageModel };
  systemPrompt: string;
  compactionPrompt: string;
  telemetry: Telemetry;
  now?: () => number; // injectable clock, for the budget tests
  retryDelayMs?: number; // base backoff after a failed call (tests set 0)
}

const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_NUDGES = 3; // consecutive replies without a tool call before we give up
// Output tokens reserved for the next call before any call has been seen.
const DEFAULT_OUTPUT_ESTIMATE = 2_000;

function fmtDuration(s: number): string {
  const m = Math.max(0, Math.floor(s / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export async function buildPinned(cfg: Config): Promise<string> {
  const files = await Promise.all(cfg.pin.map(async (p) =>
    `<file path="${p}">\n${await readFile(path.resolve(cfg.workspace, p), "utf8")}\n</file>`));
  return [cfg.prompt.trim(), ...(files.length ? ["The following files are pinned here for reference; they are also in the workspace.", ...files] : [])].join("\n\n");
}

export async function runAgent(cfg: Config, deps: AgentDeps): Promise<RunResult> {
  const { telemetry: log } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const elapsedS = () => (now() - started) / 1000;
  const toolCtx: ToolContext = {
    root: path.resolve(cfg.workspace),
    shellTimeoutMs: cfg.shellTimeoutS * 1000,
    maxShellTimeoutMs: cfg.maxShellTimeoutS * 1000,
    maxOutputChars: cfg.maxToolOutputChars,
  };

  const state: ConversationState = { pinned: await buildPinned(cfg), summaryBlock: null, history: [] };
  let steps = 0;
  let spent = 0;
  let compactions = 0;
  let errors = 0;
  let nudges = 0;
  let lastCallCost = 0;
  let maxOutputSeen = DEFAULT_OUTPUT_ESTIMATE;
  // Context size, in tokens, of the prompt the next call will send: the last
  // call's exact input + output count, plus an estimate for what was appended
  // since. Starts as an estimate of the pinned prefix.
  let contextTokens = estimateTokens(state.pinned) + estimateTokens(deps.systemPrompt);
  const realWindow = priceFor(deps.main.ref.key).contextWindow;

  const push = (m: ModelMessage) => {
    state.history.push(m);
    contextTokens += estimateTokens(m.content);
    log.emit({ type: "message", step: steps, message: m });
  };

  // What the next main call might cost. The last call's cost is a good guide,
  // since consecutive calls share most of their (cached) prompt; 1.5x leaves a
  // margin. Before the first call, price the whole prompt as uncached input.
  const nextCallEstimate = () => {
    const p = priceFor(deps.main.ref.key);
    const cold = (contextTokens * p.input + maxOutputSeen * p.output) / 1e6;
    return lastCallCost > 0 ? Math.max(lastCallCost * 1.5, (maxOutputSeen * p.output) / 1e6) : cold;
  };

  const checkBudgets = (): StopReason | null => {
    if (steps >= cfg.maxSteps) return "step limit";
    if (elapsedS() >= cfg.timeBudgetS) return "time budget";
    if (spent + nextCallEstimate() > cfg.budgetUsd) return "dollar budget";
    // Without compaction the context only grows; stop before the provider
    // would reject the request.
    if (contextTokens > 0.95 * realWindow) return "context full";
    return null;
  };

  const statusLine = () =>
    `[status: ${fmtDuration(cfg.timeBudgetS - elapsedS())} left, $${Math.max(0, cfg.budgetUsd - spent).toFixed(2)} of $${cfg.budgetUsd.toFixed(2)} left, ${steps}/${cfg.maxSteps} steps used]`;

  async function compact(): Promise<void> {
    const cut = splitPoint(state.history, cfg.keepRecent);
    if (cut === 0) {
      log.emit({ type: "compaction_skipped", step: steps, reason: "nothing old enough to drop", contextTokens });
      return;
    }
    const old = state.history.slice(0, cut);
    const before = contextTokens;
    const transcript = renderForSummary(old, 300_000);
    const previous = state.summaryBlock ? `Summary of even earlier work:\n${state.summaryBlock}\n\n` : "";
    let summary: string;
    try {
      const r = await callModel({
        ...deps.compactor,
        instructions: deps.compactionPrompt,
        messages: [{ role: "user", content: `${previous}Turns to summarize:\n${transcript}` }],
        maxOutputTokens: 8_000,
        step: steps,
        purpose: "compaction",
      });
      spent += r.event.costUsd;
      log.emit(r.event);
      summary = r.text;
    } catch (e) {
      // A failed summary shouldn't kill the run: keep the clipped transcript's
      // tail instead, which is worse but loses nothing recent.
      log.emit({ type: "model_call_error", step: steps, purpose: "compaction", error: String(e) });
      summary = "(The summarizer failed; this is the end of the raw transcript.)\n" + transcript.slice(-20_000);
    }
    compactions++;
    state.summaryBlock = buildSummaryBlock(
      summary, await readNotes(toolCtx.root, cfg.notesFile), await workspaceIndex(toolCtx.root), cfg.notesFile, compactions);
    state.history = state.history.slice(cut);
    contextTokens = estimateTokens(toMessages(state).map((m) => m.content)) + estimateTokens(deps.systemPrompt);
    log.emit({
      type: "compaction", step: steps, n: compactions, beforeTokens: before, afterTokensEstimate: contextTokens,
      droppedMessages: cut, keptMessages: state.history.length, summaryBlock: state.summaryBlock,
    });
  }

  log.emit({ type: "run_start", config: { ...cfg, prompt: undefined }, mainModel: deps.main.ref.key, compactionModel: deps.compactor.ref.key });
  let stop: StopReason | null = null;
  let finishSummary: string | undefined;

  while (!(stop = checkBudgets())) {
    if (cfg.compaction && contextTokens > cfg.compactAt * cfg.contextWindow) {
      await compact();
      if ((stop = checkBudgets())) break; // the summary itself costs money
    }

    // Never let a call outlive the wall-clock budget.
    const abort = AbortSignal.timeout(Math.max(1000, (cfg.timeBudgetS - elapsedS()) * 1000));
    let r: CallResult;
    try {
      r = await callModel({
        ...deps.main,
        instructions: deps.systemPrompt,
        messages: withCacheBreakpoints(deps.main.ref, toMessages(state), 1),
        tools: toolSet,
        maxOutputTokens: cfg.maxOutputTokens,
        abortSignal: abort,
        step: steps,
        purpose: "main",
      });
    } catch (e) {
      if (abort.aborted) { stop = "time budget"; break; }
      // Failed calls are logged but not priced: the SDK gives no usage for
      // them. DECISIONS.md discusses what that can miss.
      log.emit({ type: "model_call_error", step: steps, purpose: "main", error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      if (++errors >= MAX_CONSECUTIVE_ERRORS) { stop = "model error"; break; }
      await new Promise((res) => setTimeout(res, (deps.retryDelayMs ?? 5_000) * errors));
      continue;
    }
    errors = 0;
    spent += r.event.costUsd;
    lastCallCost = r.event.costUsd;
    maxOutputSeen = Math.max(maxOutputSeen, r.event.outputTokens);
    log.emit(r.event);
    // Exact count for everything up to and including this reply.
    contextTokens = r.event.inputTokens + r.event.outputTokens;
    for (const m of r.responseMessages) { state.history.push(m); log.emit({ type: "message", step: steps, message: m }); }

    if (r.toolCalls.length === 0) {
      // Some models end a turn with prose ("I'll now implement..."). Nudge them
      // back to work a few times before concluding they've stopped.
      steps++;
      if (++nudges > MAX_NUDGES) { stop = "no tool calls"; break; }
      push({ role: "user", content: `You replied without calling a tool. Nobody is reading your messages; continue the task using the tools, or call \`finish\` if you are done.\n${statusLine()}` });
      continue;
    }
    nudges = 0;

    const results: ToolResultPart[] = [];
    for (const call of r.toolCalls) {
      const t0 = performance.now();
      const out = await executeTool(call.toolName, call.input, toolCtx);
      log.emit({ type: "tool_call", step: steps, tool: call.toolName, ok: out.ok, ms: Math.round(performance.now() - t0), outputChars: out.output.length });
      results.push({
        type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName,
        output: { type: out.ok ? "text" : "error-text", value: out.output },
      });
      if (out.finished) finishSummary = out.finished.summary;
    }
    steps++;
    // The status line rides on the newest tool result, which is new text
    // anyway, so it doesn't disturb the cached prefix.
    const last = results[results.length - 1]!;
    last.output = { ...last.output, value: `${(last.output as { value: string }).value}\n${statusLine()}` } as ToolResultPart["output"];
    push({ role: "tool", content: results });
    if (finishSummary !== undefined) { stop = "finish"; break; }
  }

  const result: RunResult = { stopReason: stop!, steps, costUsd: spent, compactions, wallS: elapsedS(), finishSummary };
  log.emit({
    type: "result", stop_reason: result.stopReason, total_cost_usd: spent, steps, compactions,
    wall_s: result.wallS, finish_summary: finishSummary ?? null,
  });
  return result;
}
