# Decisions

Choices made while building and running spec-agent, with the reason for each. Recorded as they were made; later entries may supersede earlier ones, and say so.

## SDK and API

- **AI SDK v7 (`ai@7.0.183`, providers `@ai-sdk/*@4.x`).** I read the API from the installed `.d.ts` files and the v7 docs, not from memory. Several names differ from v4/v5-era examples:
  - `instructions` replaces the deprecated `system`, and system messages inside `messages` are rejected unless `allowSystemInMessages` is set.
  - `result.stream`, `result.responseMessages`.
  - Usage is `inputTokenDetails.{cacheReadTokens, cacheWriteTokens}`.
  - The test mock is `MockLanguageModelV4`.
- **A hand-written loop, not `ToolLoopAgent` / `stopWhen`.** Tools are declared without `execute`, so each `streamText` call makes exactly one model request and returns the tool calls. The loop runs them itself. Budget checks, compaction, per-call telemetry and the status line all live between steps, in ~200 lines I can explain. `stopWhen` + `prepareStep` could express most of this, but it would hide the order of operations, and that order is what matters here (check budget → maybe compact → call → run tools).
- **`streamText`, not `generateText`.** Only for time-to-first-token. The stream is always consumed to the end. TTFT is the first `text-delta`, `reasoning-delta`, `tool-input-start` or `tool-call` part.
- **OpenAI via the Responses API** (`openai(id)`, the provider's default). That's the API that reports cached tokens.

## Models (one per provider, its strongest current coding model)

| Provider | Main loop | Compaction / summaries | Why this main model |
| --- | --- | --- | --- |
| OpenAI | `gpt-6.2-astra` | `gpt-6-luna` | The models page calls Astra "our flagship model for complex reasoning and coding" |
| Anthropic | `claude-opus-5-5` | `claude-haiku-5-5` | The models page: "For long-running agentic coding"; "start with Claude Opus 5.5" |
| Google | `gemini-4-carbon` | `gemini-3.5-flash-lite` | The models page: "Our strongest reasoning model, built for complex software engineering… autonomous multi-step agents" |

- **Not Claude Fable 5.2.** Anthropic positions it above Opus 5.5 "for demanding reasoning and long-horizon agentic work, or when your evals on Claude Opus 5.5 at higher effort still fall short". So it is arguably Anthropic's strongest model. I picked Opus 5.5 because Anthropic names it *the* agentic-coding model. Also, with the same dollar cap for every model, Fable's 2× price would mostly mean half the steps. A Fable run is the obvious next experiment.
- **Reasoning effort is left at each provider's default.** Tuning it per provider would make the comparison about my tuning.
- **Compaction model.** Each provider's cheapest current model, so compaction stays within one provider, one key and one bill. Cross-provider routing is possible (`--compaction-model`) but wasn't used, so a run's cost has one source.

## Prices (`src/pricing.ts`)

- Copied from the providers' pricing pages, with the URL beside each entry. Standard tier only.
- **Gemini 4 Carbon's price doubles on 2026-12-01.** I recorded the price in force through 2026-11-30, which is when the runs happened.
- **Cache writes.** Anthropic bills them at 1.25× input (5-minute TTL). OpenAI and Gemini implicit caching don't bill writes separately, so `cacheWrite = input` there.
- **Long-context tiers.**
  - OpenAI's above 272K prompt tokens is modelled.
  - Haiku 5.5's above 100K is modelled.
  - Opus 5.5 and Gemini 4 Carbon have none.
- **Failed calls are not priced.** The SDK returns no usage for a call that errors. A provider may still bill a stream that failed partway through. The `model_call_error` events count how often this happened. Each run's error count is in the activity table, so the possible undercount is visible.

## Prompts

- **One system prompt for every provider** (`prompts/system.md`). It has no provider-specific wording. `src/cli.ts` appends `prompts/overlays/<provider>.md` if that file exists. **No overlay was needed**: see "Overlays" below once the smoke tests had run.
- **The task prompt is replicate-lang's `runs/TASK.md`**, exactly as Claude Code and Codex get it. The harness passes it with `--prompt`.
- **`SPEC.md` is pinned.** It is copied verbatim into the first user message (`--pin spec/SPEC.md`). That saves a read on every run, and compaction can never summarize it away.
- **The status line.** Each newest tool result ends with `[status: 1h12m left, $3.10 of $6.30 left, 45/500 steps used]`. Without it the model has no idea how much budget is left. It rides on the newest message, so it never disturbs the cached prefix.
- **Nudge.** A reply with no tool call gets a nudge: "Nobody is reading your messages; continue … or call `finish`". After 3 such replies in a row the run stops with `no tool calls`. Some models narrate a plan and end the turn, and this keeps that from ending a run.

## Context management

- **Layout.** The conversation is always `[user: task + pinned spec + summary block] [recent history]`. The pinned text is stored apart from the summary, so every compaction rebuilds the first message from the original pinned text. A second compaction never summarizes the first summary's pinned content. Keeping it all in one first user message also keeps strict user/assistant alternation, which Anthropic and Gemini both require.
- **The summary block.** It has four parts:
  1. a structured summary written by the cheap model (`prompts/compaction.md`: Progress / Verified behaviour / Known problems / Spec details / Next steps);
  2. the agent's `NOTES.md`, *re-read from disk at compaction time*;
  3. a `find` index of the workspace with sizes and line counts;
  4. an instruction to re-read files before editing them.
- **The kept tail.** The last 8 messages stay verbatim (`--keep-recent`). The cut never leaves a tool result whose tool call was dropped, because every provider rejects that.
- **Why a 160K working window.** Every model here accepts ~1M tokens. But cost and latency grow with context on every step, and the dollar cap is fixed. So compaction triggers at `0.6 × 160K = 96K` estimated tokens, not at a fraction of 1M, which no capped run would ever reach. With `--no-compaction` the context grows until the run stops for some other reason, or until 95% of the real window (`context full`). That makes the ablation a real comparison: "summarize at 96K" against "never summarize".
- **Token estimate.** The last call's exact `inputTokens + outputTokens`, plus `chars/4` for what was appended since. It only has to be good enough to decide *when* to compact.
- **A failed summarizer doesn't kill the run.** If the summarizer call fails, the summary falls back to the tail of the clipped raw transcript.

## Budgets and stopping

- **Four stops, checked before every call:** step limit (500), wall clock, dollars, and context full. Plus `finish`, and two failure stops: 3 consecutive model errors, and 3 nudges without a tool call.
- **Dollar check.** It runs before the call, against an estimate of the call's cost: max(1.5 × the last call's cost, the largest output seen so far at the output price). Before the first call it is the whole prompt at uncached prices. So the agent stops when the *next* call might cross the budget, not after it has.
- **Two layers.**
  - The agent stops itself at 97% of the harness's `--cap`, 2 minutes before the time budget.
  - The harness's cost meter (summing each `model_call` event's `costUsd`) and its timer stay the hard stops.
  - If the agent's own check ever failed, the harness would freeze the sandbox anyway.
- **Every model call has an `AbortSignal.timeout`** set to the time remaining, so a slow request can't run past the budget.

## Tools

- **Six tools, zod-validated twice.** The schema goes to the model as JSON Schema, and the loop re-validates what came back. Invalid arguments, unknown tools, missing files, non-unique `edit_file` matches and path escapes all become `error-text` tool results. Nothing throws into the loop.
- **`run_shell`.**
  - It runs `bash -c` in its own process group, so a timeout kills the whole group.
  - The default timeout is 60 s, with a 600 s maximum.
  - Output is capped by keeping the first 12K characters and a rolling last 12K. The tail is where test summaries are. An early version capped by dropping everything after 48K characters, and the truncation test caught it.
- **`run_shell` gets the environment minus anything named `*API_KEY*`, `*TOKEN*` or `*SECRET*`.** The agent process needs its key. The model's commands never do, and a stray `env` would copy the key into the transcript. `scripts/collect.ts` also redacts any `.env` value it finds before results are committed.
- **No sandbox of my own.** The agent runs *inside* replicate-lang's sandbox container (internal network, egress only through the API-allowlist proxy), so a tool call is a plain child process. The container is the isolation boundary.

## Harness integration (replicate-lang commit "Add a spec-agent adapter to the run harness (grading untouched)")

- A `spec-agent` agent type. `--model provider:id` chooses which key the harness passes; `--tag` goes into the run id; `--agent-args` passes flags through (used for `--no-compaction`).
- **The sandbox image** (`runs/spec-agent/Dockerfile`) is the harness's base sandbox image plus the spec, the examples and the agent bundle. It has the same contents as the Claude/Codex sandbox, minus those CLIs.
- **`NODE_USE_ENV_PROXY=1`.** Node's built-in `fetch`, which the AI SDK uses, ignores `HTTPS_PROXY` without it. I checked from inside the sandbox: without the flag every API call failed (`EAI_AGAIN`). With it, the three model APIs answered and example.com and pypi.org were still refused.
- **A stale proxy.** The harness reused a proxy container left running from an earlier build, which enforced the old allowlist (no Gemini). `ensure_network` now replaces a running proxy whose image isn't current. This was a harness bug, not a grader bug, so it's fixed in the adapter commit.
- **Grades take a lock.** Runs go in parallel, but grades go one at a time. The grader's 5 s per-program limit and the 10× benchmark limit are wall-clock limits, so concurrent grades on 6 CPUs could fail programs that would pass alone. The grade itself is unchanged.
- **Validation.** A zero-cost run with the scripted `mock:stub` model went through the whole pipeline (sandbox → freeze → grade). It scored 4.12%, which matches the cheater zoo's `constant` stub (4.1%), the program it writes.

## Experiment design (`experiments.json`)

- **Language: Python.** It has the spec's best-documented traps: the recursion limit for 100,000-deep recursion, the 4,300-digit int↔str limit, and floor division, which Python gets right and JavaScript doesn't. One language keeps the matrix inside the budget.
- **Money.** `MAX_TOTAL_USD = 60`. The plan is 3 smoke runs (10 min, $0.60 cap) and 8 two-hour runs at a **$6.50 cap**:
  - 3 models × 2 runs;
  - 2 extra compaction-off runs.

  The worst case is 3 × ($0.60 + $0.50 reserve) + 8 × ($6.50 + $0.50 reserve) = $59.30. `scripts/experiment.ts` checks this before every start. It adds actual spend from every finished `result.json`, the cap and reserve of each run in flight, and the new run's cap and reserve. If the total could pass `MAX_TOTAL_USD`, the run is not started.
- **The cap binds before the clock.** $6.50 is a small budget for a 2-hour run on a frontier model. I expect at least the OpenAI and Anthropic runs to stop on the dollar cap well before 2 hours. That is a property of the budget, and the results report stop reasons for that reason.
- **Ablation model: Gemini 4 Carbon.** It is the cheapest per token of the three, so it gets the most steps under the cap. That makes its runs the most likely to cross the compaction threshold, more than once, which the ablation needs. The "compaction on" arm is the two main-matrix Carbon runs, with identical settings, so no runs are duplicated.
- **Concurrency 4.** The four runs of each batch start 20 s apart, because the harness creates its network and proxy on first use.
