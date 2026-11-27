# Walkthrough

Read the code in this order. Each step depends only on the ones before it.

## 1. `src/pricing.ts` (129 lines): what a call costs

- A table of USD per 1M tokens, each entry with its source URL.
- `costOf()` splits a request's prompt into three buckets: fresh input, cache reads and cache writes. They're billed differently.
- It applies a long-context tier when the prompt passes the model's threshold.
- Everything that talks about money (the budget check, telemetry, the harness's meter) goes through this one function.

## 2. `src/tools.ts` (167 lines) and `src/shell.ts` (75 lines): what the model can do

- **Schemas.** One zod schema per tool (`schemas`). `toolSet` hands them to the AI SDK *without* `execute`, so the SDK only describes the tools to the model and never runs them.
- **`executeTool()`** is the single entry point:
  1. it validates the input again with `safeParse`, because the model can send anything;
  2. it dispatches;
  3. it wraps everything in `try/catch`.

  It never throws. A failure is `{ ok: false, output: "..." }`, which the loop turns into an `error-text` tool result.
- **`resolveInRoot()`** keeps file tools inside the workspace.
- **`edit_file`** counts occurrences first, so a missing or non-unique `old_string` is an error rather than a silent wrong edit.
- **`runShell()`** has the three details worth knowing:
  - `detached: true`, so a timeout kills the whole process group;
  - head plus rolling-tail buffering, so the end of long output survives;
  - `shellEnv()`, which strips API keys from the commands' environment.

## 3. `src/providers.ts` (107 lines) and `src/mock.ts` (48 lines): which model

- `parseModel("openrouter:anthropic/claude-opus-5.5")` → `createModel()` returns an AI SDK `LanguageModel`. That is the only place provider packages are imported. A `ModelRef` carries both the *provider* (who gets the request) and the *vendor* (who made the model), because they differ through OpenRouter.
- Two provider overlays:
  - `withCacheBreakpoints()`. Anthropic models cache only where you mark them, directly or through OpenRouter, so it marks the pinned prefix and the newest message. OpenAI and Gemini cache implicitly.
  - `openRouterSettings()` pins each vendor to its first-party OpenRouter endpoint with no fallbacks.
- `mock.ts` is a scripted model for zero-cost pipeline runs.

## 4. `src/llm.ts` (172 lines): one model call

- `callModel()` = one `streamText`. It consumes the stream, timing the first token. It rethrows a stream `error` part, since streamed errors arrive as parts rather than exceptions.
- It returns the response messages, the tool calls, and a `model_call` telemetry event with tokens, cost, latency and TTFT.
- **Cost.** Through OpenRouter, the event's `costUsd` is OpenRouter's own billed figure for the call (`usage.cost`). Our price table's figure is logged beside it, for the cross-check.
- **Failed calls.** When a call dies mid-stream, the helpers at the bottom (`generationIdOf`, `lookupOpenRouterBill`) find out what OpenRouter billed for it, so the loop can count it.

## 5. `src/compaction.ts` (96 lines): keeping the context small

- **`ConversationState`** is `{ pinned, summaryBlock, history }`. `toMessages()` renders it as one first user message (pinned + summary) followed by the history. That is the whole trick: pinned content is stored separately, so it can't be lost or summarized.
- **`splitPoint()`** picks where the old part ends. It never orphans a tool result.
- **`renderForSummary()`** turns old messages into clipped plain text for the cheap model.
- **`buildSummaryBlock()`** assembles the summary, the `NOTES.md` read from disk *now*, and the file index.

## 6. `src/loop.ts` (260 lines): the agent

Read `runAgent()` top to bottom:
1. **Setup:** the tool context, the state, the counters, and `contextTokens` (exact after each call, estimated in between).
2. **`nextCallEstimate()` and `checkBudgets()`:** the four stop conditions, evaluated *before* each call.
3. **`compact()`:** splits, summarizes with the compaction model (its cost counts against the budget), rebuilds the summary block, and logs a `compaction` event.
4. **The `while` loop:**
   1. check budgets;
   2. maybe compact;
   3. make the call, with an abort at the remaining wall time. On error: bill the failed call if OpenRouter says what it cost, log it, back off, and stop after 3 errors in a row (6 if they're dropped connections);
   4. append the response;
   5. if there are no tool calls, nudge;
   6. otherwise run each tool call in order;
   7. append the status line, and push the tool message;
   8. stop on `finish`.
5. **The final `result` event.** `total_cost_usd` is the field name replicate-lang's harness already reads.

## 7. `src/config.ts` (93 lines), `src/telemetry.ts` (63 lines), `src/cli.ts` (50 lines): the edges

- Flags → zod `ConfigSchema` with defaults.
- The JSONL event stream.
- The entry point. It loads the system prompt plus an optional provider overlay, and on a crash it writes a `result` event with `stop_reason: "crash"`, so a crash is never silent.

## 8. `test/`: how it's checked

- Every test drives the real loop with `MockLanguageModelV4` (`test/helpers.ts`, `scripted()`).
- `prompts(model)` returns what the model was actually sent, which is how the tests check that tool results, nudges, the status line and pinned content arrive.
- `compaction.test.ts` plants sentinels in the spec, `NOTES.md` and old turns, then asserts that the post-compaction prompt has the spec, the notes, the summary and the file index, and not the old turns.

## 9. `scripts/`: experiments and the report

- **`experiment.ts`** runs a phase of `experiments.json` through the harness, behind the spend guard.
- **`collect.ts`** copies results in, redacting secrets.
- **`report.ts`** generates every table in WRITEUP.md from `result.json`, `grade.json` and `transcript.jsonl`.

---

## Common questions

**1. Why write the loop yourself instead of using the SDK's agent / `stopWhen`?**
The interesting decisions happen *between* steps: checking the budget against the next call's estimated cost, deciding to compact, appending the status line, nudging a model that stopped calling tools. In a hand-written loop they run in an order you can read top to bottom. The SDK handles what it's good at: provider differences, streaming, schema conversion and retries. Tools have no `execute`, so each `streamText` call is exactly one request.

**2. How do you stop a run from overspending?**
Two layers. Before every call, the agent estimates that call's cost, as max(1.5× the last call's cost, the largest output seen at the output price), and stops if spent + estimate would pass its budget. Its budget is set to 97% of the harness cap. Independently, the harness sums each `model_call` event's cost as it streams out and freezes the sandbox the moment the total passes the cap. On top of both, `experiment.ts` won't *start* a run unless actual spend so far, the caps in flight and this run's cap plus a reserve all fit under `MAX_TOTAL_USD`.

**3. What survives compaction, and how do you guarantee it?**
These survive:
- the task and spec, verbatim;
- the agent's `NOTES.md`, re-read from disk at compaction time;
- a file index;
- the last 8 messages;
- a structured summary of everything else.

The guarantee is structural. Pinned text lives in its own field and is re-rendered into the first message every time, so it never passes through the summarizer. A test plants sentinel strings and checks they're in the post-compaction prompt.

**4. Why compact at 96K tokens when the models take 1M?**
Because every step re-sends the context. Even at cache-read prices, a run sitting at 500K tokens spends its fixed budget on re-reading history rather than on new work, and long contexts make latency worse too. The 160K working window is a cost/attention budget, not a capability limit. The ablation tests whether it's the right call.

**5. How do you handle tool errors and malformed tool calls?**
They never throw. Invalid JSON or an unknown tool comes back from the SDK as an invalid call. Bad arguments fail the zod `safeParse`. Missing files and non-unique edits are caught by the tool. All of them become an `error-text` tool result with a message that says how to fix the call, so the model can recover in the next step. Tests cover each case.

**6. How is the comparison across providers kept fair?**
- the same system prompt, with no provider overlays needed;
- the same task prompt as Claude Code and Codex get;
- the same sandbox, the same dollar cap and wall clock, the same grader;
- default reasoning effort for each model, so I'm not tuning one provider more than another.

The main unfairness left is that equal dollars buy different numbers of tokens. That's deliberate, because cost-normalized quality is the question that matters for routing.

**7. Why stream if you consume the whole response anyway?**
For time to first token. It's the latency number users feel in an interactive product. Total latency is dominated by output length.

**8. How do you know the telemetry's cost numbers are right?**
- `costOf()` has unit tests against hand-computed prices.
- Every price has a source URL.
- Through OpenRouter, each call is billed at OpenRouter's own reported cost, and the price table's figure is logged beside it. The report compares the two per run.
- The report also checks the sum of per-call costs against the harness meter per run, and against the key's actual spend over each phase (`GET /api/v1/key`, snapshotted before and after).
- A call that fails mid-stream returns no usage, but OpenRouter still bills it. The loop looks up its cost by generation id and counts it. The smoke tests are where that gap was found: the key-level check caught a 23% undercount.

**9. Where does the agent's isolation come from?**
replicate-lang's sandbox. The agent runs inside a container on an internal Docker network whose only exit is a proxy that allows the model API hosts (for these runs, `openrouter.ai`). `run_shell` is a plain child process in that container, and it can't see the API keys. When the budget ends, the harness pauses and commits the container, so nothing can change before grading.

**10. What would you change next?**
That depends on the failure taxonomy in WRITEUP.md. Two structural candidates:
- A **`run_tests` tool**: the agent rebuilding and re-running its test script is the most common action, and making it first-class would let the loop detect regressions itself.
- **Routing by subtask**: an expensive model for planning and debugging, a cheap one for mechanical edits.
