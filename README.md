# spec-agent

A small, model-agnostic coding agent in TypeScript, built on the [Vercel AI SDK](https://ai-sdk.dev) v7. It is benchmarked on [replicate-lang](https://github.com/JulianChastain/replicate-lang), an eval where an agent rebuilds a typed functional language from its spec and is graded on ~2,800 hidden programs.

- **Loop** (`src/loop.ts`): one model call per step. It stops on `finish`, the step limit, the wall clock, the dollar budget, or a full context.
- **Tools** (`src/tools.ts`): `list_dir`, `read_file`, `write_file`, `edit_file`, `run_shell`, `finish`. All are zod-validated, and every error goes back to the model as a tool result.
- **Context compaction** (`src/compaction.ts`): past a fraction of a working window, older turns are replaced by a structured summary. The task, the spec, the agent's `NOTES.md` and a file index are pinned. It can be switched off with `--no-compaction`.
- **Model routing**: one model for the main loop, a cheaper one for compaction (`--compaction-model`; it defaults to the same provider's cheap model).
- **Telemetry** (`src/telemetry.ts`): a JSONL event stream. It has every model call (tokens, cached tokens, cost, latency, TTFT, tool calls), every message, and every compaction.

About 1,250 lines in `src/`. [WALKTHROUGH.md](WALKTHROUGH.md) is the guided tour, [DECISIONS.md](DECISIONS.md) explains every choice, and [WRITEUP.md](WRITEUP.md) has the results.

## Use

```sh
npm ci && npm test && npm run build
export OPENROUTER_API_KEY=...    # or ANTHROPIC_API_KEY with --model anthropic:claude-opus-5-5
node dist/spec-agent.mjs --model openrouter:anthropic/claude-opus-5.5 --workspace ./ws \
  --prompt-file TASK.md --pin spec/SPEC.md --budget-usd 5 --time-budget-s 3600
```

Models are `provider:model-id`, with provider `openai`, `anthropic`, `google`, `openrouter`, or `mock` (`mock:stub`, a scripted zero-cost model for testing the pipeline). OpenRouter models are `openrouter:<vendor>/<model>`, e.g. `openrouter:google/gemini-4-carbon`. Each is pinned to its vendor's first-party endpoint, and billed at the cost OpenRouter reports per call. A model must have a price in `src/pricing.ts` before it can run.

| Flag | Default | |
| --- | --- | --- |
| `--model` | required | main-loop model |
| `--compaction-model` | provider's cheap model | model for compaction summaries |
| `--prompt` / `--prompt-file` | required | the task |
| `--pin FILE` | none | copied verbatim into the pinned prefix (repeatable) |
| `--workspace` | cwd | file tools can't leave it |
| `--budget-usd` | 5 | stops before a call that could pass it |
| `--time-budget-s` | 3600 | wall clock |
| `--max-steps` | 500 | |
| `--no-compaction` | off | |
| `--compact-at`, `--context-window` | 0.6, 160000 | compact past `compact-at × context-window` tokens |
| `--keep-recent` | 8 | messages kept verbatim through a compaction |
| `--max-output-tokens` | 32000 | per call |
| `--log-file` | none | also write the event stream here |

## Experiments

The runs in [WRITEUP.md](WRITEUP.md) all went through OpenRouter (`experiments.json`), with one `OPENROUTER_API_KEY`.

```sh
cp .env.example .env                       # OPENROUTER_API_KEY + MAX_TOTAL_USD
npm run build                              # the harness copies dist/ into the sandbox
npx tsx scripts/openrouter-probe.ts        # optional, ~$0.13: cached tokens + billed cost per model
npx tsx scripts/experiment.ts smoke        # then: main
npx tsx scripts/collect.ts                 # copy results here, redacting secrets
npx tsx scripts/check-secrets.ts           # fails if the key appears anywhere outside .env
npx tsx scripts/report.ts --write          # regenerate every table in WRITEUP.md
```

`experiment.ts` runs each phase through replicate-lang's harness (`runs/run_agent.py`). The harness provides the sandbox, the egress proxy (which allows `openrouter.ai`), the dollar cap, freeze-then-grade, and the grade. Before each start, the script checks that the run can't push total spend past `MAX_TOTAL_USD`. Around each phase it snapshots the key's spend (`results/openrouter-usage/`) and OpenRouter's listed prices (`results/openrouter-prices/`). The report then checks the per-call costs against both. [DECISIONS.md](DECISIONS.md#routing-through-openrouter-2026-11-27) explains what routing through OpenRouter changes.
