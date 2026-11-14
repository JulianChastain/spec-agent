// Run one phase of experiments.json through replicate-lang's harness.
//
//   npx tsx scripts/experiment.ts <phase> [--dry-run]
//
// Spend guard: before starting a run, the script adds up what every finished
// spec-agent run has actually cost (result.json) plus the caps of runs still
// in flight, plus this run's cap and an overshoot reserve. If that could pass
// MAX_TOTAL_USD from .env, the run is not started. Keys come only from .env.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

interface RunSpec { model: string; tag: string; run: number; agentArgs?: string }
interface Phase { budget: string; cap: number; concurrency: number; staggerS: number; runs: RunSpec[] }
interface Plan { replicateLang: string; lang: string; overshootReserveUsd: number; phases: Record<string, Phase> }

export function loadEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) throw new Error(`${file} not found; copy .env.example to .env and fill in your keys`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] !== "") out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export const runId = (lang: string, budget: string, r: RunSpec) => `spec-agent-${r.tag}-${lang}-${budget}-r${r.run}`;

/** Actual spend of every finished, non-mock spec-agent run. */
export function spentSoFar(resultsDir: string): { total: number; unfinished: string[] } {
  let total = 0;
  const unfinished: string[] = [];
  if (!existsSync(resultsDir)) return { total, unfinished };
  for (const d of readdirSync(resultsDir)) {
    if (!d.startsWith("spec-agent-") || d.startsWith("spec-agent-mock-")) continue;
    const f = path.join(resultsDir, d, "result.json");
    if (existsSync(f)) total += JSON.parse(readFileSync(f, "utf8")).cost_usd ?? 0;
    else unfinished.push(d);
  }
  return { total, unfinished };
}

async function main() {
  const [phaseName, ...flags] = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const plan: Plan = JSON.parse(readFileSync(path.join(ROOT, "experiments.json"), "utf8"));
  const phase = plan.phases[phaseName ?? ""];
  if (!phase) throw new Error(`phase must be one of ${Object.keys(plan.phases).join(", ")}`);

  const dotenv = loadEnvFile(path.join(ROOT, ".env"));
  const maxTotal = Number(dotenv.MAX_TOTAL_USD ?? 60);
  const rl = path.resolve(ROOT, plan.replicateLang);
  const resultsDir = path.join(rl, "runs", "results");
  // Our environment minus any provider key, plus the keys from .env only.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/API_KEY/.test(k)));
  for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) if (dotenv[k]) env[k] = dotenv[k];
  env.SPEC_AGENT_DIR = ROOT;

  const logDir = path.join(ROOT, "runs", "logs");
  mkdirSync(logDir, { recursive: true });
  const reserved = new Map<string, number>(); // in-flight run id -> its cap + reserve
  const queue = [...phase.runs];
  const running = new Set<Promise<void>>();

  const startable = (r: RunSpec): { ok: boolean; why: string } => {
    const id = runId(plan.lang, phase.budget, r);
    if (existsSync(path.join(resultsDir, id))) return { ok: false, why: `${id} already exists (runs are never overwritten)` };
    const { total, unfinished } = spentSoFar(resultsDir);
    // A run directory without result.json is either in flight (reserved
    // below) or a harness crash whose cost we can't see: assume its full cap.
    const unknown = unfinished.filter((u) => !reserved.has(u)).length * (phase.cap + plan.overshootReserveUsd);
    const inflight = [...reserved.values()].reduce((a, b) => a + b, 0);
    const worst = total + unknown + inflight + phase.cap + plan.overshootReserveUsd;
    const line = `spent $${total.toFixed(4)} + unknown $${unknown.toFixed(2)} + in flight $${inflight.toFixed(2)} + this run $${(phase.cap + plan.overshootReserveUsd).toFixed(2)} = $${worst.toFixed(2)} (cap $${maxTotal})`;
    return worst <= maxTotal ? { ok: true, why: line } : { ok: false, why: `would exceed MAX_TOTAL_USD: ${line}` };
  };

  const launch = (r: RunSpec) => {
    const id = runId(plan.lang, phase.budget, r);
    const args = ["runs/run_agent.py", "spec-agent", plan.lang, phase.budget, String(r.run),
      "--cap", String(phase.cap), "--model", r.model, "--tag", r.tag, ...(r.agentArgs ? ["--agent-args", r.agentArgs] : [])];
    console.log(`[${new Date().toISOString()}] start ${id}: python3 ${args.join(" ")}`);
    if (dryRun) return Promise.resolve();
    reserved.set(id, phase.cap + plan.overshootReserveUsd);
    const log = createWriteStream(path.join(logDir, `${id}.log`));
    const child = spawn("python3", args, { cwd: rl, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    return new Promise<void>((res) => child.on("close", (code) => {
      reserved.delete(id);
      console.log(`[${new Date().toISOString()}] done ${id}: exit ${code}`);
      res();
    }));
  };

  while (queue.length || running.size) {
    while (queue.length && running.size < phase.concurrency) {
      const r = queue.shift()!;
      const s = startable(r);
      console.log(`  check ${runId(plan.lang, phase.budget, r)}: ${s.why}`);
      if (!s.ok) continue;
      const p: Promise<void> = launch(r).then(() => { running.delete(p); });
      running.add(p);
      // Staggered starts: the harness creates its network and proxy on first use.
      if (queue.length && !dryRun) await new Promise((res) => setTimeout(res, phase.staggerS * 1000));
    }
    if (running.size) await Promise.race(running);
  }
  console.log(`phase ${phaseName} complete; total spent: $${spentSoFar(resultsDir).total.toFixed(4)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exitCode = 1; });
