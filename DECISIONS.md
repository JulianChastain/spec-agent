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

## Routing through OpenRouter (2026-11-27)

This supersedes the direct-API setup above for every run in WRITEUP.md. The only key available was an OpenRouter key, so all three vendors' models go through OpenRouter. The agent can still use the direct APIs; nothing above was removed.

- **The provider is `@openrouter/ai-sdk-provider@3.1.0`, OpenRouter's official AI SDK provider.** Its peer dependencies are `ai ^7.0.0` and `zod ^3.25.76 || ^4.1.8`. Both match the installed `ai@7.0.183` and `zod@4.6.7`, so `@ai-sdk/openai-compatible` wasn't needed. The version is pinned exactly, like the rest of `package.json`.
- **Model strings are `openrouter:<vendor>/<model>`.** `parseModel()` keeps the vendor (`anthropic`, `openai`, `google`). Both the cache overlay and the default compaction model depend on the vendor, not on who carries the request.
- **Slugs, from `GET https://openrouter.ai/api/v1/models` on 2026-11-27.** All six models are listed; none needed a substitute. Anthropic's slugs use a dot (`claude-opus-5.5`), not the dash of Anthropic's own ids.

  | Model | OpenRouter slug | Compaction model |
  | --- | --- | --- |
  | GPT-6.2 Astra | `openai/gpt-6.2-astra` | `openai/gpt-6-luna` |
  | Claude Opus 5.5 | `anthropic/claude-opus-5.5` | `anthropic/claude-haiku-5.5` |
  | Gemini 4 Carbon | `google/gemini-4-carbon` | `google/gemini-3.5-flash-lite` |

- **Each vendor is pinned to its own first-party, standard-tier endpoint.** The settings are `provider: { only: [<upstream>], allow_fallbacks: false, require_parameters: true }`, with upstream `openai`, `anthropic` or `google-ai-studio` (`OPENROUTER_UPSTREAM` in `src/providers.ts`). OpenRouter would otherwise load-balance each model across hosts: Astra also runs on Azure, Bedrock and Vertex, and Opus on Bedrock, Vertex, Azure and Claude Platform on AWS. Prices match across those hosts, but latency and cache state don't. Every vendor also has `/fast`, `/flex` or `/priority` endpoints at 0.5× to 3× the standard price. OpenRouter's provider-selection docs say a base slug "does not by itself opt into a service tier endpoint". The probe confirms it: every call was served by the first-party host, and every billed cost matched the standard price exactly. Each call's `model_call` event logs the host that served it (`upstream`), and the report lists the hosts per model.
- **Anthropic caching through OpenRouter: the same two breakpoints, in OpenRouter's namespace.** `withCacheBreakpoints()` now applies when the *vendor* is `anthropic`. Through OpenRouter it sets `providerOptions.openrouter.cacheControl`. The provider sends that as a `cache_control: {type: "ephemeral"}` block on the message, which is the explicit per-block mode in OpenRouter's prompt-caching docs. A test runs the real provider against a stubbed `fetch` and checks that exactly two `cache_control` blocks are in the HTTP body. Gemini and OpenAI models get no breakpoints, as before. They rely on implicit caching.
- **Cost: OpenRouter's own figure is what a run is metered on.** Every OpenRouter response carries `usage.cost`, the amount billed for that call, and the provider exposes it as `providerMetadata.openrouter.usage.cost`. Each `model_call` event records three fields:
  - `costUsdReported`, OpenRouter's figure;
  - `costUsdPriced`, from `src/pricing.ts`;
  - `costUsd`, the reported figure when there is one, else the priced one.

  The harness meter and the agent's own budget both sum `costUsd`, so the hard stops track the actual bill. The price table still drives the pre-call estimate and the cross-check.
- **Prices.** `src/pricing.ts` has an `openrouter:` entry per model, copied from the pinned endpoint's listing, with the URL beside it. `scripts/openrouter-prices.ts` saves the raw listing to `results/openrouter-prices/`. `experiment.ts` runs it before and after each phase, so the prices on each run date are recorded, not assumed. On 2026-11-27, OpenRouter's prices equal the direct prices above for all six models, with two differences:
  - **OpenAI cache writes are billed at 1.25× input** ($10/1M for Astra). OpenAI's own page bills none. OpenRouter reports `cache_write_tokens` for these models, and the probe's first Astra call wrote 5,207 tokens at that rate. So an OpenAI run through OpenRouter costs somewhat more than the same run direct.
  - **Gemini 4 Carbon is $2 / $0.10 / $10** (input / cached / output), the same as Google's direct price through 2026-11-30. The runs start on 2026-11-27. Whether OpenRouter follows Google's 2026-12-01 doubling doesn't affect them as long as they finish before then. The dated snapshots and the per-call billed costs would show it if it did.
- **Cross-checks.** `scripts/report.ts` compares three things:
  - per run: the priced total, the reported total and the harness meter;
  - per phase: the meters' sum against the key's own spend over the phase. `GET /api/v1/key` `usage` is snapshotted before and after by `scripts/openrouter-usage.ts`.

  The account's credit balance (`GET /api/v1/credits`) needs a management key, which I don't have. The key's cumulative usage is the closest figure available.
- **OpenRouter's usage counter lags by a minute or two.** In the probe, one minute after the last call, the key's usage was $0.1016 against $0.1247 of reported per-call cost. The gap was exactly the last six (Gemini) calls. Three minutes later it was $0.124685, matching to the sixth decimal. `experiment.ts` therefore waits 3 minutes after a phase before the "after" snapshot.
- **The probe (`scripts/openrouter-probe.ts`; results in `results/openrouter-probe/`)** sends the agent's own call shape to all six models:
  - the spec as the pinned first message;
  - then three calls that share that prefix;
  - with `withCacheBreakpoints()` applied as the loop applies it.

  On 2026-11-27 it cost $0.125, outside the experiment budget. Cache reads on the second call:

  | Model | Prompt tokens | Read from cache | Written | Priced = reported? |
  | --- | ---: | ---: | ---: | --- |
  | Astra | 5,242 | 5,207 (99%) | 5,207 on call 1 | yes, all 3 calls |
  | Luna | 5,265 | 5,207 (99%) | 5,207 on call 1 | yes |
  | Opus 5.5 | 7,521 | 7,486 (99.5%) | 7,486 on call 1 | yes |
  | Haiku 5.5 | 7,588 | 7,486 (99%) | 7,486 on call 1 | yes |
  | Carbon | 5,208 | 3,128 (60%) | none reported | yes |
  | Flash Lite | 5,217 | 2,030 (39%) | none reported | yes |

  **Every model reports cache reads through OpenRouter.** But Gemini's implicit caching served only part of an identical 5K-token prefix, while OpenAI's and Anthropic's served all of it. I didn't add explicit Gemini breakpoints. OpenRouter's docs contradict themselves on whether Gemini needs them, and explicit Gemini caching has a storage charge the direct design deliberately avoided. Whether the partial hits persist on long contexts is in WRITEUP.md's telemetry table, as the cache-read share per model.
- **Keys.** `run_shell` already dropped `*API_KEY*` variables. It now also drops anything named `*OPENROUTER*`, and any variable whose *value* contains a credential's value (a key copied under an innocent name). `collect.ts` redacts every `.env` credential, as before, and also any string shaped like an OpenRouter key (`sk-or-…`), whether or not it's in `.env`. `scripts/check-secrets.ts` scans both repos and replicate-lang's run results for the key value and the key shape, printing file names only. I ran it before every commit and every phase. The shell's `grep` in my environment skips dotfiles, so I didn't rely on it for this check.
- **Harness** (replicate-lang commit "spec-agent adapter: pass OPENROUTER_API_KEY … (grading untouched)"). `openrouter:*` models get `OPENROUTER_API_KEY`, and `openrouter.ai` joins the proxy allowlist. `cost_source` in `result.json` says the cost is OpenRouter's. No grader or grading file changed. From inside the sandbox network, `openrouter.ai` answered and example.com and pypi.org were still refused.

### What routing through OpenRouter changes

- **TTFT and latency are not comparable to direct-API numbers.** Every call takes an extra hop through OpenRouter, which adds its own queueing and routing time. The telemetry measures agent → OpenRouter → vendor → back, so it is fine for comparing these three models with each other through the same path. It is not a measure of any vendor's own API latency.
- **Routing inside OpenRouter could vary; I pinned it.** Each vendor is pinned to one first-party host with fallbacks off (above), so a run never silently moves to Bedrock or Vertex mid-run. The cost of that choice: if the pinned host is down, the call fails instead of falling back. The loop then retries, and stops after three consecutive errors. Failed calls are counted per run in the report.
- **Caching may behave differently from the direct APIs.** OpenAI writes are billed here and not there. Gemini's implicit hit rate was partial in the probe. OpenRouter's own docs disagree about Gemini. The report gives the measured cache-read share per model rather than assuming the direct APIs' behaviour.
- **Prices are OpenRouter's.** They matched the direct prices on the run dates, except for OpenAI cache writes. Each run is metered on OpenRouter's billed figure, which is what the account actually paid.

## Smoke tests through OpenRouter (2026-11-27)

The gate is `scripts/smoke-check.ts`. Every check must pass for all three smoke runs, and the key's spend over the smoke window must match the runs' meters within 3%. The latest attempt of each run counts. Earlier attempts stay in `results/` and are listed here.

**Before smoke: the pipeline check.** A `mock:stub` run (`spec-agent-mock-python-3m-r2`) went through the rebuilt sandbox, the new proxy, freeze and grade. It scored 4.1246%, the same as r1 and as the cheater zoo's `constant` stub.

**Attempt 1 (r1, 21:52 UTC): failed the gate. Two causes, both infrastructure, both fixed.**

- **Carbon crashed with `RangeError [ERR_OUT_OF_RANGE]`.** It happened at step 3, after writing a 10,023-token interpreter. The loop's per-call `AbortSignal.timeout((timeBudgetS - elapsed) * 1000)` was handed 323943.99999999994. Node only accepts whole milliseconds, and float error produces a fraction for some elapsed times, so the bug depended on timing. That's why no earlier run hit it. The fix floors the delay. A regression test uses a clock value that reproduces it (commit "Fix a crash: AbortSignal.timeout() …").
- **Dropped streams went unbilled. Over the window the key spent $0.9821; the meters summed $0.7526 (−23%).**
  - Three calls failed with `AI_APICallError: Failed to process successful response`: two in Astra's run, one in Opus's. The cause chain, which the log had dropped, was `TypeError: terminated <- UND_ERR_SOCKET: other side closed`. OpenRouter had answered `200 text/event-stream` and was streaming when the connection closed.
  - OpenRouter still billed those calls. `GET /api/v1/generation` shows two of them as `cancelled`: $0.0895 (Astra, 692 completion tokens) and $0.0733 (Opus, 1,173 completion tokens). That's $0.163 of the $0.229 gap. The third (Astra) is "not found" there, so its cost isn't known per call, but the key-level check still counts it.
  - The drops are intermittent, not caused by the proxy. Twelve concurrent 45-second Haiku streams succeeded both on the host and through the sandbox proxy, and replaying Astra's failed step succeeded on both paths too.

  The fix (commit "Bill calls that fail mid-stream …") has three parts:
  1. The model-call error now logs its whole cause chain.
  2. For an OpenRouter call, the loop looks up what the failed generation was billed (by `x-generation-id`, with retries while the stats appear). It logs that as a `model_call` event with `failed: true`, so the agent's budget, the harness meter and the report all count it.
  3. Dropped connections get their own limit of 6 consecutive failures before the run stops with `model error`. Other errors keep the limit of 3, and any success resets both. Without this, Astra's two drops in a row were one away from ending a run for an infrastructure reason.
- Astra and Opus passed every per-run check in attempt 1, but the phase-level cost check is part of the gate, so all three runs were re-run on the fixed bundle as attempt 2 (r2).
- **The scores weren't the problem.** Astra and Opus both scored **100%** (2,761/2,761) inside the 10-minute, $0.60 smoke budget. Opus did it in 4 calls and 71 s: it wrote a 238-line interpreter in one call, checked the 20 examples, and called `finish`. I read the frozen interpreter in full. It reads only the program file, and it handles the documented traps explicitly (`set_int_max_str_digits(0)`, the recursion limit plus a 1 GB thread stack, `//`). Nothing points to a leak; Mini-Core in Python is within one-shot reach of these models.

**Attempt 2 (r2, 22:04 UTC): every per-run check passed, but the phase cost check failed. The cause was a harness bug, now fixed.**

- All three runs passed every per-run check. Astra (stopped on the dollar budget), Opus (`finish`) and Carbon (`finish`) all scored **100%**.
- The key spent $1.2066 over the window, against $1.0498 of meters (−13%). Two calls, one Astra and one Opus, had dropped mid-stream again, and the new billing lookup found nothing for either within its 17-second window. A few minutes later `GET /api/v1/generation` had them: $0.0807 + $0.0762 = $0.1570, which closes the gap to the cent. So the lookup now retries for about 2 minutes.
- **The drops were mine, not OpenRouter's.**
  - In both attempts, the drops in different runs happened at the same moment: the moment another run started.
  - The proxy container had been *created* at 22:05:05, one second after the Carbon run's start.
  - Each run start calls `build_images()`, which rebuilt the unchanged proxy and got a new image id (`20efb52e…` vs `ae740273…`). `ensure_network()` then treated the running proxy as stale and replaced it, cutting every other sandbox's open API stream.
  - That replacement rule came from my earlier adapter commit (the "stale proxy" fix above). It was harmless for one run at a time, and fatal at concurrency 3–4.
- **The fix** (replicate-lang commit "Harness: keep the running proxy unless its allowlist or config changed …", grading untouched):
  - `ensure_network()` compares the allowlist and `tinyproxy.conf` inside the running proxy with the files in `runs/proxy/`, and keeps the proxy if they match.
  - If they differ while other sandboxes are on the network, it refuses to start the run rather than cut them off.
  - Verified: two more rebuild-and-ensure cycles left the proxy container untouched, still enforcing the OpenRouter allowlist.
- This supersedes my reading of attempt 1, where I called the drops "intermittent upstream disconnects": they were this bug. The failed-call billing and the separate transport-error limit stay, because a real upstream drop can still happen. Attempt 3 re-runs all three, since the cost gate failed for the phase as a whole.

**Attempt 3 (r3, 22:21 UTC): passed the gate.**

- Every per-run check passed. The key spent $1.0502 over the window, and the three meters sum to $1.0502, so the cross-check agrees to the cent. No call failed, and the proxy container was never recreated.
- **Scores:** Astra 100% (stopped on the dollar budget) and Opus 100% (`finish`). Carbon scored **0%**: it stopped on its own dollar budget after 4 calls and $0.32. Its next-call estimate is the largest output so far at the output price, up to 32K tokens × $10/1M, and that no longer fit in the $0.58 left. The check counts this as a sensible stop.
- Carbon got 100% in r2 and 0% in r3 under identical settings. Smoke runs aren't part of the results, but this is a fair warning about n=2 in the main matrix.
- **Smoke spend:** $2.85 by the harness meters across the nine runs. The key's own spend was $3.24, because attempt 1's three unbilled drops were never metered and attempt 2's two weren't found in time. The key figure is the true one.
