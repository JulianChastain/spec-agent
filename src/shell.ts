// Running a shell command for the agent. The agent itself runs inside
// replicate-lang's sandbox container (offline except for the model API), so
// this is a plain child process: the container is the isolation boundary.
import { spawn } from "node:child_process";

export interface ShellResult {
  exitCode: number | null; // null when killed
  timedOut: boolean;
  output: string; // stdout and stderr interleaved, truncated
}

/**
 * Keep the head and the tail of long output. Compiler errors and test
 * summaries tend to be at one end or the other; the middle is what gets cut.
 */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n[... ${s.length - 2 * half} characters truncated ...]\n\n${s.slice(-half)}`;
}

/**
 * The environment for the model's commands: ours minus credentials. The
 * agent process needs its API key; the code the model runs never does, and
 * a stray `env` would otherwise copy the key into the transcript.
 */
export function shellEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/(API_KEY|TOKEN|SECRET)/i.test(k)));
}

export function runShell(command: string, cwd: string, timeoutMs: number, maxChars: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    // detached: the child leads its own process group, so on timeout we can
    // kill everything it started (e.g. a runaway interpreter under a loop).
    const child = spawn("bash", ["-c", command], { cwd, env: shellEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    // Cap what we buffer, not only what we return: a program printing in an
    // infinite loop must not exhaust the agent's memory. Keep the first
    // maxChars and a rolling window of the last maxChars, so the end of the
    // output (often the test summary) survives.
    let head = "";
    let tail = "";
    let dropped = 0;
    const append = (b: Buffer) => {
      const s = b.toString("utf8");
      if (head.length < maxChars) {
        const room = maxChars - head.length;
        head += s.slice(0, room);
        tail += s.slice(room);
      } else tail += s;
      if (tail.length > maxChars) { dropped += tail.length - maxChars; tail = tail.slice(-maxChars); }
    };
    const collected = () => (dropped ? `${head}\n[... ${dropped} characters dropped ...]\n${tail}` : head + tail);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, output: truncateMiddle(collected(), maxChars) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, output: `failed to start bash: ${e.message}` });
    });
  });
}
