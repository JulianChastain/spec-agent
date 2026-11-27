# Results: spec-agent on replicate-lang (Python), three models through OpenRouter

The question was how three frontier models compare as the engine of one small agent on one task, at an equal dollar cap. The task: rebuild the Mini-Core language from its spec in Python, graded on hidden programs.

**The short answer: on this task they don't separate on score.** Every 2-hour run, on every model, passed every hidden program. The task turns out to be below the ceiling of all three models, so this matrix measures how much each model spent and how long it took to reach full marks, not which model writes the better interpreter. The models do differ there, and that is the result I can support.

**How to read the numbers.** Every number in the tables and in the generated facts list comes from `npx tsx scripts/report.ts --write`, run over the committed files in [`results/`](results/): each run's `result.json`, `grade.json` and `transcript.jsonl`, plus the OpenRouter usage and price snapshots. The prose doesn't restate figures. It points at the tables, and it cites transcripts as *run id, step N*, which `npx tsx scripts/digest.ts results/<run id> --from N --to N` prints. [DECISIONS.md](DECISIONS.md) records every choice and every incident behind these runs, including what broke during the smoke tests and what was re-run.

**Setup in one paragraph.**
- Models: GPT-6.2 Astra, Claude Opus 5.5 and Gemini 4 Carbon, each routed through OpenRouter to its vendor's own first-party endpoint, at default reasoning effort.
- Runs: two 2-hour runs per model, each with the same dollar cap, inside replicate-lang's offline sandbox, then freeze-then-grade.
- Ablation: two more Carbon runs with context compaction switched off.

The matrix and caps are in [`experiments.json`](experiments.json). Compaction triggers past a fraction of a working window (DECISIONS.md, "Why a 160K working window").

<!-- report:facts -->
- 2-hour runs: 8, graded: 8, crashed: 0. Scores range from 100.0% to 100.0%.
- 2-hour stop reasons (agent): finish × 8. Nudges across all 17 runs: 0.
- Largest share of its dollar cap any 2-hour run used: 42.5% (astra-6-2-python-2h-r1, $2.76 of $6.50).
- Largest share of its time budget any 2-hour run used: 30.8% (carbon-4-nocompact-python-2h-r1, 37 min of 120 min).
- Smoke runs: 9 (1 crashed). Smoke scores: 100.0% × 7, 0.0% × 2.
- Spend by harness meters: smoke $2.85, 2-hour $12.05, total $14.91.
- Spend by the key's own counter: before the first smoke window (the cache probe) $0.12, smoke $3.24, 2-hour $12.05; cumulative key usage at the last snapshot $15.42.
<!-- /report:facts -->

## 1. Headline: score by model at an equal dollar cap

<!-- report:headline -->
| Model | Score (r1 / r2) | Mean | Cost (r1 / r2) | Steps (r1 / r2) | Wall (r1 / r2) | Stop, harness / agent (r1; r2) | Mean score per mean $ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| openrouter:openai/gpt-6.2-astra | 100.0% / 100.0% | **100.0%** | $2.76 / $1.31 | 49 / 34 | 17 min / 9 min | agent finished / finish; agent finished / finish | 49.13 pts/$ |
| openrouter:google/gemini-4-carbon | 100.0% / 100.0% | **100.0%** | $1.75 / $1.66 | 41 / 35 | 31 min / 28 min | agent finished / finish; agent finished / finish | 58.50 pts/$ |
| openrouter:anthropic/claude-opus-5.5 | 100.0% / 100.0% | **100.0%** | $0.77 / $0.33 | 18 / 9 | 5 min / 2 min | agent finished / finish; agent finished / finish | 181.72 pts/$ |
<!-- /report:headline -->

- **Score.** All six runs scored full marks, so the mean is the same for every model, and n=2 adds nothing to it. This is a ceiling, not a tie between close competitors. A harder task would be needed to rank these models on quality (§7).
- **Neither budget was binding.** The facts list gives the largest share of the cap and of the time budget any run used. Every run ended because the model called `finish`, so "equal dollar cap" was in practice "no budget pressure at all".
- **The separation is in cost and time to reach full marks.**
  - Opus was cheapest and fastest in both runs: it wrote its interpreter in its second call (step 1 of both runs), tested it, and stopped.
  - Astra wrote its tests first, then the interpreter, then spent its remaining steps on verification and performance work while its interpreter already passed the examples (§5).
  - Carbon took longest in both runs. It made a few long calls up front, with far more output tokens per call than the others (§4), and wrote its first `/work/minicore` only after them.
- **Score per dollar** only re-expresses cost here, since every score is full marks.
  - Opus was cheapest in both runs.
  - Astra and Carbon swapped places between r1 and r2, so two runs don't order them.
  - Each model's two runs differ a lot in cost (the Cost column), so the size of the gaps is not something n=2 establishes either.

## 2. Per-tier scores

<!-- report:tiers -->
| Run | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
| --- | --- | --- | --- | --- |
| astra-6-2-python-2h-r1 | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) |
| astra-6-2-python-2h-r2 | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) |
| **openrouter:openai/gpt-6.2-astra mean** | **100.0%** | **100.0%** | **100.0%** | **100.0%** |
| carbon-4-python-2h-r1 | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) |
| carbon-4-python-2h-r2 | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) |
| **openrouter:google/gemini-4-carbon mean** | **100.0%** | **100.0%** | **100.0%** | **100.0%** |
| opus-5-5-python-2h-r1 | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) |
| opus-5-5-python-2h-r2 | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) |
| **openrouter:anthropic/claude-opus-5.5 mean** | **100.0%** | **100.0%** | **100.0%** | **100.0%** |
<!-- /report:tiers -->

Every tier, every run: full marks. The tier breakdown can't show where a model is weak, because none of them is weak anywhere this grader looks.

## 3. Compaction ablation: Carbon with compaction on vs off

<!-- report:ablation -->
| Run | Compaction | Score | Cost | Steps | Compactions | Peak context | Cache-read share (main) | Stop, harness / agent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| carbon-4-nocompact-python-2h-r1 | off | 100.0% | $1.77 | 34 | 0 | 134K | 93.8% | agent finished / finish |
| carbon-4-nocompact-python-2h-r2 | off | 100.0% | $1.69 | 33 | 0 | 123K | 93.8% | agent finished / finish |
| carbon-4-python-2h-r1 | on | 100.0% | $1.75 | 41 | 1 | 102K | 91.0% | agent finished / finish |
| carbon-4-python-2h-r2 | on | 100.0% | $1.66 | 35 | 1 | 101K | 89.6% | agent finished / finish |
| **compaction on, mean** | | **100.0%** (range 100.0%–100.0%) | $1.71 | 38 | 1.0 | | | |
| **compaction off, mean** | | **100.0%** (range 100.0%–100.0%) | $1.73 | 34 | 0.0 | | | |
<!-- /report:ablation -->

- **What happened.**
  - With compaction on, each Carbon run crossed the threshold once and compacted once, mid-run (carbon-4-python-2h-r1, step 20; carbon-4-python-2h-r2, step 16).
  - With it off, the context kept growing to a higher peak, and nothing stopped either run: neither came near the real context limit.
  - Both arms scored full marks, at nearly the same mean cost.
  - The off arm's cache-read share was higher. A compaction rewrites the start of the prompt, so the next call re-reads it uncached. That is the expected cost of compacting.
  - The off arm used somewhat fewer steps, with slower calls (§4).
- **Is the difference distinguishable from noise? No.**
  - Score can't differ: both arms are at the ceiling.
  - For cost, the gap between the arms' means is smaller than the gap between the two runs within either arm.
  - With n=2 per arm, one compaction per run, and runs that finish long before the context gets large, this ablation doesn't tell compaction-on from compaction-off.
- **What it does show.** Compaction ran on real runs without breaking them. Both compacted runs went on to pass everything after their compaction, and the pinned spec and `NOTES.md` carried over (the compaction tests check this mechanically; these runs confirm it doesn't hurt in practice). A real test of compaction needs runs long enough to compact many times, which needs a task that takes longer than an hour (§7).

## 4. Telemetry

<!-- report:telemetry -->
| Model (both runs pooled) | Main calls | Input tokens | Cache reads (share) | Cache writes | Output | of which reasoning | TTFT p50 / p90 / p95 | Call latency p50 / p90 / p95 | Upstream |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| openrouter:openai/gpt-6.2-astra | 83 | 2.35M | 2.27M (96.4%) | 85K | 58K | 29K | 3.1 s / 32.5 s / 51.3 s | 7.6 s / 44.4 s / 57.3 s | OpenAI |
| openrouter:google/gemini-4-carbon (no compaction) | 67 | 5.54M | 5.20M (93.8%) | 0 | 226K | 139K | 11.8 s / 45.0 s / 49.4 s | 42.8 s / 163.9 s / 210.0 s | Google AI Studio |
| openrouter:google/gemini-4-carbon | 76 | 4.20M | 3.78M (90.0%) | 0 | 224K | 137K | 7.2 s / 24.5 s / 39.0 s | 22.2 s / 112.4 s / 154.3 s | Google AI Studio |
| openrouter:anthropic/claude-opus-5.5 | 27 | 603K | 554K (91.9%) | 49K | 37K | 14K | 2.7 s / 3.5 s / 3.6 s | 8.2 s / 31.9 s / 34.3 s | Anthropic |
<!-- /report:telemetry -->

- **The OpenRouter caveat, first.** Every call went agent → OpenRouter → vendor and back. TTFT and latency here include OpenRouter's hop and queueing, and they are not comparable to numbers measured against the vendors' own APIs. They compare these three models with each other, on the same path, on the dates of the runs. Each model was pinned to one first-party upstream with no fallbacks; the Upstream column confirms every call went there.
- **Caching worked for all three models.**
  - Every model read most of its prompt tokens from cache.
  - OpenAI and Anthropic report cache writes through OpenRouter. OpenRouter bills OpenAI's writes, which OpenAI's own API doesn't (DECISIONS.md).
  - Gemini reports none, as expected for implicit caching. The probe before the runs had seen Gemini's implicit cache hit only part of a short prefix (DECISIONS.md). On these long contexts its share was close to the other models'.
- **Latency follows output length.** Carbon's calls were much slower than the others' at the median and in the tail, and it produced far more output tokens, a large part of it reasoning. Opus had the lowest and steadiest TTFT. Astra's TTFT tail is long: on some calls the first streamed token came late, which is consistent with reasoning that isn't streamed as deltas (an inference, not something the telemetry shows).
- **Cost cross-check.**

<!-- report:costcheck -->
| Run | Priced (src/pricing.ts) | Reported by OpenRouter | Priced vs reported | Calls with no reported cost | Harness meter | Failed calls | of which billed (cost) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| astra-6-2-python-10m-r1 | $0.4741 | $0.4741 | +0.00% | 0 | $0.4741 | 2 | 0 ($0.0000) |
| astra-6-2-python-10m-r2 | $0.4844 | $0.4844 | +0.00% | 0 | $0.4844 | 1 | 0 ($0.0000) |
| astra-6-2-python-10m-r3 | $0.4864 | $0.4864 | +0.00% | 0 | $0.4864 | 0 | 0 ($0.0000) |
| astra-6-2-python-2h-r1 | $2.7599 | $2.7599 | +0.00% | 0 | $2.7599 | 0 | 0 ($0.0000) |
| astra-6-2-python-2h-r2 | $1.3109 | $1.3109 | +0.00% | 0 | $1.3109 | 0 | 0 ($0.0000) |
| carbon-4-nocompact-python-2h-r1 | $1.7725 | $1.7725 | +0.00% | 0 | $1.7725 | 1 | 0 ($0.0000) |
| carbon-4-nocompact-python-2h-r2 | $1.6912 | $1.6912 | +0.00% | 0 | $1.6912 | 1 | 0 ($0.0000) |
| carbon-4-python-10m-r1 | $0.1255 | $0.1255 | -0.00% | 0 | $0.1255 | 0 | 0 ($0.0000) |
| carbon-4-python-10m-r2 | $0.4012 | $0.4012 | +0.00% | 0 | $0.4012 | 0 | 0 ($0.0000) |
| carbon-4-python-10m-r3 | $0.3189 | $0.3189 | +0.00% | 0 | $0.3189 | 0 | 0 ($0.0000) |
| carbon-4-python-2h-r1 | $1.7550 | $1.7550 | +0.00% | 0 | $1.7550 | 2 | 0 ($0.0000) |
| carbon-4-python-2h-r2 | $1.6636 | $1.6636 | +0.00% | 0 | $1.6636 | 0 | 0 ($0.0000) |
| opus-5-5-python-10m-r1 | $0.1530 | $0.1530 | +0.00% | 0 | $0.1530 | 1 | 0 ($0.0000) |
| opus-5-5-python-10m-r2 | $0.1642 | $0.1642 | +0.00% | 0 | $0.1642 | 1 | 0 ($0.0000) |
| opus-5-5-python-10m-r3 | $0.2449 | $0.2449 | +0.00% | 0 | $0.2449 | 0 | 0 ($0.0000) |
| opus-5-5-python-2h-r1 | $0.7738 | $0.7738 | +0.00% | 0 | $0.7738 | 0 | 0 ($0.0000) |
| opus-5-5-python-2h-r2 | $0.3268 | $0.3268 | +0.00% | 0 | $0.3268 | 0 | 0 ($0.0000) |

| Phase | Runs | Sum of harness meters | Key spend over the phase (GET /api/v1/key) | Meters vs key | Snapshot windows |
| --- | --- | --- | --- | --- | --- |
| smoke | 9 | $2.8526 | $3.2389 | -11.93% | 3 |
| main | 8 | $12.0537 | $12.0536 | +0.00% | 1 |
<!-- /report:costcheck -->

- For every run, our price table's figure equals OpenRouter's reported per-call cost, and the harness meter equals the sum of the per-call costs.
- **2-hour runs:** the meters' total equals the key's own spend counter (`GET /api/v1/key`, snapshotted before and after) to the cent. No 2-hour call failed in a way that went unbilled.
- **Smoke runs:** the meters undercount the key. That gap is the smoke-test incidents in DECISIONS.md:
  - dropped streams, which OpenRouter billed but the first bundle didn't count;
  - a harness bug that restarted the shared proxy mid-run.

  Both were fixed before the main matrix.

### What OpenRouter charged on the run dates

<!-- report:prices -->
| Snapshot | Model | Pinned endpoint | Input | Cache read | Cache write | Output |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-27 22:21 UTC (2026-11-27-smoke-before.json) | openrouter:anthropic/claude-haiku-5.5 | anthropic | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 22:21 UTC (2026-11-27-smoke-before.json) | openrouter:anthropic/claude-opus-5.5 | anthropic | 4.00 | 0.20 | 5.00 | 20.00 |
| 2026-11-27 22:21 UTC (2026-11-27-smoke-before.json) | openrouter:google/gemini-3.5-flash-lite | google-ai-studio | 0.30 | 0.03 | 0.08 | 2.50 |
| 2026-11-27 22:21 UTC (2026-11-27-smoke-before.json) | openrouter:google/gemini-4-carbon | google-ai-studio | 2.00 | 0.10 | 0.19 | 10.00 |
| 2026-11-27 22:21 UTC (2026-11-27-smoke-before.json) | openrouter:openai/gpt-6-luna | openai | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 22:21 UTC (2026-11-27-smoke-before.json) | openrouter:openai/gpt-6.2-astra | openai | 8.00 | 0.40 | 10.00 | 40.00 |
| 2026-11-27 22:31 UTC (2026-11-27-smoke-after.json) | openrouter:anthropic/claude-haiku-5.5 | anthropic | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 22:31 UTC (2026-11-27-smoke-after.json) | openrouter:anthropic/claude-opus-5.5 | anthropic | 4.00 | 0.20 | 5.00 | 20.00 |
| 2026-11-27 22:31 UTC (2026-11-27-smoke-after.json) | openrouter:google/gemini-3.5-flash-lite | google-ai-studio | 0.30 | 0.03 | 0.08 | 2.50 |
| 2026-11-27 22:31 UTC (2026-11-27-smoke-after.json) | openrouter:google/gemini-4-carbon | google-ai-studio | 2.00 | 0.10 | 0.19 | 10.00 |
| 2026-11-27 22:31 UTC (2026-11-27-smoke-after.json) | openrouter:openai/gpt-6-luna | openai | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 22:31 UTC (2026-11-27-smoke-after.json) | openrouter:openai/gpt-6.2-astra | openai | 8.00 | 0.40 | 10.00 | 40.00 |
| 2026-11-27 22:53 UTC (2026-11-27-main-before.json) | openrouter:anthropic/claude-haiku-5.5 | anthropic | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 22:53 UTC (2026-11-27-main-before.json) | openrouter:anthropic/claude-opus-5.5 | anthropic | 4.00 | 0.20 | 5.00 | 20.00 |
| 2026-11-27 22:53 UTC (2026-11-27-main-before.json) | openrouter:google/gemini-3.5-flash-lite | google-ai-studio | 0.30 | 0.03 | 0.08 | 2.50 |
| 2026-11-27 22:53 UTC (2026-11-27-main-before.json) | openrouter:google/gemini-4-carbon | google-ai-studio | 2.00 | 0.10 | 0.19 | 10.00 |
| 2026-11-27 22:53 UTC (2026-11-27-main-before.json) | openrouter:openai/gpt-6-luna | openai | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 22:53 UTC (2026-11-27-main-before.json) | openrouter:openai/gpt-6.2-astra | openai | 8.00 | 0.40 | 10.00 | 40.00 |
| 2026-11-27 23:34 UTC (2026-11-27-main-after.json) | openrouter:anthropic/claude-haiku-5.5 | anthropic | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 23:34 UTC (2026-11-27-main-after.json) | openrouter:anthropic/claude-opus-5.5 | anthropic | 4.00 | 0.20 | 5.00 | 20.00 |
| 2026-11-27 23:34 UTC (2026-11-27-main-after.json) | openrouter:google/gemini-3.5-flash-lite | google-ai-studio | 0.30 | 0.03 | 0.08 | 2.50 |
| 2026-11-27 23:34 UTC (2026-11-27-main-after.json) | openrouter:google/gemini-4-carbon | google-ai-studio | 2.00 | 0.10 | 0.19 | 10.00 |
| 2026-11-27 23:34 UTC (2026-11-27-main-after.json) | openrouter:openai/gpt-6-luna | openai | 0.10 | 0.01 | 0.13 | 0.50 |
| 2026-11-27 23:34 UTC (2026-11-27-main-after.json) | openrouter:openai/gpt-6.2-astra | openai | 8.00 | 0.40 | 10.00 | 40.00 |
<!-- /report:prices -->

Prices didn't change across the snapshots taken around the runs. Gemini 4 Carbon was still at its pre-December price; Google's direct price doubles on 2026-12-01 (DECISIONS.md), and every run finished before then.

## 5. Failure taxonomy (qualitative)

*This section is my reading of the transcripts, not a measurement. Each category cites run id and step.* No 2-hour run lost points, so the question here is not "why did it lose points" but "what went wrong along the way, and how did the run recover". The smoke runs, at a much smaller budget, add the only real failures.

**Spec traps: none missed, and every run met all three up front.** These are the traps DECISIONS.md picked Python for:
- the recursion limit for 100,000-deep recursion;
- the 4,300-digit int↔str limit;
- floor division.

Every run handled them before or while writing its first interpreter, never as a fix after a failure. The models split on *how* they handle recursion depth:
- **Opus raised the limits.** In its first interpreter it disables the int↔str limit, raises the recursion limit, and runs the interpreter on a thread with a large stack (opus-5-5-python-2h-r1, step 1; opus-5-5-python-2h-r2, step 1).
- **Carbon r1 avoided Python recursion.** It wrote a compiler to a VM with explicit value and call stacks (`mc/vm.py` in its frozen image), and never touched the recursion limit (carbon-4-python-2h-r1). It disabled the digit limit at step 2.
- **Astra r2 compiled to bytecode with explicit call frames and tail calls.** It also set the limits early (astra-6-2-python-2h-r2, step 3; its finish summary describes the evaluator).

`//` was handled from the start in every run. Python's floor division already matches the spec, and the models said so.

**Self-built tests that had bugs of their own (Carbon).** Every run built its own test runner over the public examples, plus its own edge cases:
- Astra wrote its tests before its interpreter (astra-6-2-python-2h-r1, step 3).
- Opus wrote its tests right after its interpreter (opus-5-5-python-2h-r2, step 1).
- Carbon wrote its tests after its interpreter, and its interpreter came late.

Carbon also built fuzzers, and lost steps to bugs in them rather than in its interpreter:
- carbon-4-python-2h-r1, step 23: its well-typed fuzzer generated ill-typed programs. Fixed at step 24, in the test, not the interpreter.
- carbon-4-python-2h-r1, step 35: its own expected value for 1,000 nested additions was wrong. Fixed at step 36, in the test.
- carbon-4-nocompact-python-2h-r2, step 15: its differential fuzzer crashed in its own type generator. Fixed at step 16.

None of these was a regression in the interpreter.

**Performance work found by the model's own stress tests (Astra).** astra-6-2-python-2h-r2, step 7: a test the model wrote itself (990 nested `let`s around a 500,000-iteration loop) took more than 5 s under its own `timeout 5`. At steps 8–9 it recorded the weakness in `NOTES.md` and rebuilt variable lookup. The grader's resource tier passed afterwards. This is where most of Astra's extra steps went: working ahead of limits the grader would check, after the interpreter already passed every example.

**Tool misuse, always recovered in the next step.**
- astra-6-2-python-2h-r1, step 9: `write_file` to `/tmp/…`, outside the workspace. The tool refused, and the model wrote inside `/work`.
- astra-6-2-python-2h-r1, steps 25–26: two malformed `edit_file` calls, a schema-invalid input and then a missing `path`. Both came back as error results, and the next call was well-formed.
- opus-5-5-python-2h-r2, step 3, and astra-6-2-python-2h-r2, step 4: the sandbox has no `/usr/bin/time` (exit 127). Both switched to the shell's `time`.

None of this cost more than a step. The zod validation and error-as-tool-result design did what it was for.

**Nudges: none.** No run, smoke or main, ever replied without a tool call (facts list). The nudge mechanism never fired.

**Infrastructure errors in the 2-hour runs: rate limits, absorbed by retries.**
- Running four Carbon runs at once on one pinned upstream drew rate limits from Google AI Studio via OpenRouter: carbon-4-python-2h-r1, step 39; carbon-4-nocompact-python-2h-r1, step 8; carbon-4-nocompact-python-2h-r2, step 3.
- There was also one upstream `502` (carbon-4-python-2h-r1, step 30).
- Each failed after the SDK's own retries, and the next attempt succeeded. No run came near the three-consecutive-errors stop, and none was re-run.

**Budget exhaustion and crashes: smoke runs only.** At the 10-minute, $0.60 smoke budget:
- **carbon-4-python-10m-r3 scored zero.** It spent its first long call on a planning `NOTES.md` (step 2) and its second on an interpreter module, `mc.py` (step 3). Its own dollar check then stopped it before it had written `/work/minicore`, the entry point the grader runs. Under the same settings, carbon-4-python-10m-r2 scored full marks.
- **Astra stopped on the dollar budget in all three smoke runs**, after its interpreter already passed everything.
- **carbon-4-python-10m-r1 crashed.** It was an agent bug, a fractional `AbortSignal.timeout` delay, and was fixed before any 2-hour run (DECISIONS.md, attempt 1).

## 6. Threats to validity

- **The ceiling.** This is the threat that matters most. Full marks for every run means the grader can't rank these models, and differences in quality don't show at all.
- **n=2 per cell.** Two runs per model can show an ordering that held twice; they can't put an interval on it. The two runs of one model differed a lot in cost and time (§1), Astra and Carbon swapped cost order between runs, and in the smoke runs the same Carbon settings scored full marks once and zero once.
- **A single language.** Python already handles bignums and floor division, so it is the easier target. TypeScript, the harness's other language, would test the int↔str and floor-division traps for real.
- **OpenRouter routing.**
  - Latency includes OpenRouter's hop.
  - The cache behaviour is OpenRouter's, which differs from the direct APIs; for example, OpenAI cache writes are billed.
  - Each model ran on one pinned upstream, so one host's load and rate limits affected all of that model's runs.
- **Default reasoning effort.** Each model ran at its provider's default, deliberately, to avoid tuning one provider more than another. A different effort could change cost and time a lot, most of all for Carbon, whose output was mostly long, slow calls.
- **Equal dollars buy unequal tokens.** The cap was the same for every model, but it never bound, so it didn't shape the comparison here. Under a binding cap, the cheaper-per-token model gets more steps; that is a feature of cost-normalised comparison, but it is still a bias.
- **One agent.** These are three models inside one agent: one system prompt, one tool set, one loop. A model that does better with a different harness would be under-rated here.

## 7. What I'd change next

The taxonomy points to three changes:

1. **A harder task before any more of this matrix.**
   - This one is solved in minutes, so the next experiment should move the ceiling, not add runs. Options: the TypeScript target, a larger language (the same harness, with the spec extended by records, polymorphism and a module system), or a much tighter cap and time budget, so that budget, not capability, is what binds.
   - Until then, the useful comparison is cost and time to full marks, measured with more runs per model.
2. **Treat rate limits and 5xx as transient, like dropped connections.**
   - The rate limits and the 502 in §5 were all recoverable, but the loop counts them toward the three-error stop, the same as a real API error. A longer back-off and the higher limit already given to dropped connections would make a long run robust to an upstream's bad minute.
   - Alternatively, allow fallback to a second first-party host where prices match, and log which host served each call.

**The two candidates from WALKTHROUGH.md, revisited against the evidence:**

- **A `run_tests` tool: smaller benefit than I expected.**
  - Every run built its own test runner unprompted, as soon as it had an interpreter (or, for Astra, before), and re-ran it after each change.
  - The one thing such a tool could add is a trusted oracle. Carbon's lost steps came from bugs in its own tests and fuzzers (§5), not from not testing, and a `run_tests` tool that runs only the public examples would have avoided none of those.
  - Its value would be on a task the models *don't* already solve, where the loop could detect a regression itself instead of trusting the model's test script. It isn't worth building for this task.
- **Routing by subtask: the evidence points the other way.** The cheapest model per token, Carbon, was not the cheapest per solved task. Opus, priced in the middle, was the cheapest, because it needed the fewest steps and output tokens. Carbon's cost came from long, slow calls on its own main loop, not from an expensive model doing cheap work. Compaction, the one place a cheap model was already routed in, cost little. What these runs show is that the main cost driver is how many steps and output tokens a model needs. That argues for choosing the main model by cost per solved task, not for splitting tasks across models. Routing could still pay off on a task long enough for compaction and planning to be a real share of the bill. This one isn't.

## Appendix

### All 2-hour runs (compaction on)

<!-- report:results -->
| Run | Model | Score | T1 | T2 | T3 | T4 | Passed | Cost | $/passed | Median call | p95 call | Median TTFT | Wall | Compactions | Stop (harness / agent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| astra-6-2-python-2h-r1 | openrouter:openai/gpt-6.2-astra | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $2.76 | $0.0010 | 10.0 s | 57.3 s | 4.1 s | 17 min | 0 | agent finished / finish |
| astra-6-2-python-2h-r2 | openrouter:openai/gpt-6.2-astra | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $1.31 | $0.0005 | 4.0 s | 57.9 s | 2.1 s | 9 min | 0 | agent finished / finish |
| carbon-4-python-2h-r1 | openrouter:google/gemini-4-carbon | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $1.75 | $0.0006 | 17.8 s | 147.3 s | 8.1 s | 31 min | 1 | agent finished / finish |
| carbon-4-python-2h-r2 | openrouter:google/gemini-4-carbon | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $1.66 | $0.0006 | 23.0 s | 183.2 s | 6.7 s | 28 min | 1 | agent finished / finish |
| opus-5-5-python-2h-r1 | openrouter:anthropic/claude-opus-5.5 | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.77 | $0.0003 | 8.9 s | 34.3 s | 3.0 s | 5 min | 0 | agent finished / finish |
| opus-5-5-python-2h-r2 | openrouter:anthropic/claude-opus-5.5 | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.33 | $0.0001 | 5.5 s | 41.3 s | 2.2 s | 2 min | 0 | agent finished / finish |
<!-- /report:results -->

### Activity

<!-- report:activity -->
| Run | Model calls (main + compaction) | Tool calls | Tool errors | Model-call errors | Logged call cost vs harness cost |
| --- | --- | --- | --- | --- | --- |
| astra-6-2-python-2h-r1 | 49 + 0 | 49 | 2 | 0 | $2.76 vs $2.76 |
| astra-6-2-python-2h-r2 | 34 + 0 | 34 | 2 | 0 | $1.31 vs $1.31 |
| carbon-4-nocompact-python-2h-r1 | 34 + 0 | 34 | 1 | 1 | $1.77 vs $1.77 |
| carbon-4-nocompact-python-2h-r2 | 33 + 0 | 33 | 1 | 1 | $1.69 vs $1.69 |
| carbon-4-python-2h-r1 | 41 + 1 | 41 | 2 | 2 | $1.75 vs $1.75 |
| carbon-4-python-2h-r2 | 35 + 1 | 35 | 3 | 0 | $1.66 vs $1.66 |
| opus-5-5-python-2h-r1 | 18 + 0 | 19 | 0 | 0 | $0.77 vs $0.77 |
| opus-5-5-python-2h-r2 | 9 + 0 | 10 | 1 | 0 | $0.33 vs $0.33 |
<!-- /report:activity -->

### Smoke runs

Three attempts per model, at a 10-minute, $0.60 budget. Attempts 1 and 2 failed the gate for infrastructure reasons, which DECISIONS.md records; attempt 3 passed.

<!-- report:smoke -->
| Run | Model | Score | T1 | T2 | T3 | T4 | Passed | Cost | $/passed | Median call | p95 call | Median TTFT | Wall | Compactions | Stop (harness / agent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| astra-6-2-python-10m-r1 | openrouter:openai/gpt-6.2-astra | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.47 | $0.0002 | 4.7 s | 31.8 s | 3.1 s | 3 min | 0 | agent finished / dollar budget |
| astra-6-2-python-10m-r2 | openrouter:openai/gpt-6.2-astra | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.48 | $0.0002 | 15.0 s | 40.9 s | 3.5 s | 4 min | 0 | agent finished / dollar budget |
| astra-6-2-python-10m-r3 | openrouter:openai/gpt-6.2-astra | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.49 | $0.0002 | 11.4 s | 35.2 s | 4.0 s | 3 min | 0 | agent finished / dollar budget |
| carbon-4-python-10m-r1 | openrouter:google/gemini-4-carbon | **CRASH** 0.0% | 0/581 (0.0%) | 0/451 (0.0%) | 0/1107 (0.0%) | 0/622 (0.0%) | 0 | $0.13 | – | 5.7 s | 147.8 s | 3.2 s | 3 min | 0 | agent finished / crash |
| carbon-4-python-10m-r2 | openrouter:google/gemini-4-carbon | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.40 | $0.0001 | 20.2 s | 195.8 s | 7.2 s | 8 min | 0 | agent finished / finish |
| carbon-4-python-10m-r3 | openrouter:google/gemini-4-carbon | 0.0% | 0/581 (0.0%) | 0/451 (0.0%) | 0/1107 (0.0%) | 0/622 (0.0%) | 0 | $0.32 | – | 4.8 s | 195.8 s | 4.5 s | 6 min | 0 | agent finished / dollar budget |
| opus-5-5-python-10m-r1 | openrouter:anthropic/claude-opus-5.5 | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.15 | $0.0001 | 3.2 s | 33.6 s | 1.5 s | 1 min | 0 | agent finished / finish |
| opus-5-5-python-10m-r2 | openrouter:anthropic/claude-opus-5.5 | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.16 | $0.0001 | 3.4 s | 34.0 s | 1.6 s | 2 min | 0 | agent finished / finish |
| opus-5-5-python-10m-r3 | openrouter:anthropic/claude-opus-5.5 | 100.0% | 581/581 (100.0%) | 451/451 (100.0%) | 1107/1107 (100.0%) | 622/622 (100.0%) | 2761 | $0.24 | $0.0001 | 4.8 s | 30.0 s | 2.6 s | 1 min | 0 | agent finished / finish |
<!-- /report:smoke -->

### Spend

<!-- report:spend -->
| Phase | Runs | Spend |
| --- | ---: | ---: |
| smoke (short budget) | 9 | $2.85 |
| 2h runs | 8 | $12.05 |
| **total** | 17 | **$14.91** |
<!-- /report:spend -->
