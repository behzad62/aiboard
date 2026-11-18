import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// A fixture cleanup that stays unverified keeps what its owners hold, on purpose. Before this guard that kept the test
// file's process alive until CI cancelled the job: run 44299442959 sat 29 minutes after a 4 s failure in
// managed-never-started-list.test.ts, holding the Windows birth helper of a run whose close had failed. Each case runs
// the child file fixtures/retained-cleanup-exit.test.ts as its own test-runner process and needs it to end by itself.
const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const childFile = fileURLToPath(new URL("./fixtures/retained-cleanup-exit.test.ts", import.meta.url));
/** Far above a child's measured end (3-6.5 s per case in PR CI at 0e4673e2 on Windows, Linux and macOS; up to 10 s on a
 * loaded Windows PC). Only a hang reaches it. */
const CHILD_CEILING_MS = 120_000;

interface ChildResult { readonly code: number | null; readonly output: string; readonly elapsedMs: number; readonly killed: boolean; readonly roots: readonly string[] }

async function runChild(scenario: "hold" | "fail" | "drain" | "host"): Promise<ChildResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, AIBOARD_RETAINED_EXIT_CASE: scenario };
  // This file itself runs as a test-runner child; the nested runner must not take that role.
  delete env.NODE_TEST_CONTEXT;
  const started = performance.now();
  // POSIX: its own process group, so a ceiling kill reaches the tsx CLI's node --test grandchild and the held file
  // child, which share the output pipes; killing tsx alone would leave them holding the pipes.
  const child = spawn(process.execPath, [tsxCli, "--test", "--test-reporter=spec", childFile], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  let killed = false;
  const ceiling = setTimeout(() => {
    killed = true;
    // The test runner is a grandchild under tsx; end the whole tree so a hang here cannot hold this file too.
    if (process.platform === "win32" && child.pid) {
      try { execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }); } catch { /* already gone */ }
    } else if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    // Whatever still holds the pipes, this file's own ends of them must not hold it.
    child.stdout.destroy(); child.stderr.destroy();
  }, CHILD_CEILING_MS);
  const code = await new Promise<number | null>((resolve) => child.once("exit", (exitCode) => resolve(exitCode)));
  // The output after the exit, unless the ceiling already gave up on it.
  if (!killed && !(child.stdout.readableEnded && child.stderr.readableEnded)) await new Promise<void>((resolve) => child.once("close", () => resolve()));
  clearTimeout(ceiling);
  const roots = [...output.matchAll(/RETAINED_ROOT=(.+?)\r?\n/g)].map((match) => match[1]!);
  return { code, output, elapsedMs: Math.round(performance.now() - started), killed, roots };
}

/** Best effort, so a removal error never hides the case's own assertion; a root left behind is reported. */
async function removeRoots(t: TestContext, roots: readonly string[]): Promise<void> {
  for (const root of roots) {
    try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { t.diagnostic(`could not remove ${root}: ${String(error)}`); }
  }
}

/** Windows: the programs still running whose executable lies under `root` (the run's birth helper is one). */
function windowsProcessesUnder(root: string): string[] {
  const script = "$r=$env:AIBOARD_RETAINED_ROOT; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($r, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ExecutablePath }";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, AIBOARD_RETAINED_ROOT: root }, encoding: "utf8", windowsHide: true })
    .split(/\r?\n/).filter(Boolean);
}

test("a file whose failed cleanup keeps a live handle ends after its last test, with the full cleanup error", { timeout: CHILD_CEILING_MS + 30_000 }, async (t) => {
  const result = await runChild("hold");
  try {
    t.diagnostic(`child ended in ${result.elapsedMs} ms`);
    assert.equal(result.killed, false, `the child hung until the ${CHILD_CEILING_MS} ms ceiling:\n${result.output}`);
    assert.equal(result.code, 1, `an unverified cleanup that held the process fails the file:\n${result.output}`);
    assert.match(result.output, /LATER_TEST_RAN/, "every test of the file runs before the exit");
    assert.match(result.output, /FILE_ROOT_AFTER_DONE/, "the file's own root after hook finishes before the exit");
    assert.match(result.output, /pass 2/, result.output);
    assert.match(result.output, /\[certified-fixture\] 1 fixture cleanup\(s\) remain unverified/);
    assert.match(result.output, /retained-deep-cause/, "the dump shows the nested cleanup errors the reporter cuts off");
    assert.match(result.output, /exact evidence retained at/);
  } finally { await removeRoots(t, result.roots); }
});

test("the test whose fixture cleanup failed still fails the file after the exit", { timeout: CHILD_CEILING_MS + 30_000 }, async (t) => {
  const result = await runChild("fail");
  try {
    assert.equal(result.killed, false, `the child hung until the ${CHILD_CEILING_MS} ms ceiling:\n${result.output}`);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /pass 1/, result.output);
    assert.match(result.output, /fail 1/, result.output);
    assert.match(result.output, /cleanup remains unverified/);
    assert.match(result.output, /\[certified-fixture\] 1 fixture cleanup\(s\) remain unverified/);
  } finally { await removeRoots(t, result.roots); }
});

test("a file whose failed cleanup holds nothing exits by itself, quietly", { timeout: CHILD_CEILING_MS + 30_000 }, async (t) => {
  const result = await runChild("drain");
  try {
    assert.equal(result.killed, false, result.output);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /pass 2/, result.output);
    assert.match(result.output, /FILE_ROOT_AFTER_DONE/);
    assert.doesNotMatch(result.output, /\[certified-fixture\]/);
  } finally { await removeRoots(t, result.roots); }
});

test("a real run whose close fails ends its test file, and on Windows leaves no helper running", { timeout: CHILD_CEILING_MS + 60_000 }, async (t) => {
  const result = await runChild("host");
  try {
    t.diagnostic(`child ended in ${result.elapsedMs} ms`);
    assert.equal(result.killed, false, `the child hung until the ${CHILD_CEILING_MS} ms ceiling:\n${result.output}`);
    assert.match(result.output, /pass 2/, result.output);
    assert.equal(result.roots.length, 1, result.output);
    if (process.platform === "win32") {
      // The run's construction owner keeps its birth helper when the close fails: this is the hang the guard ends.
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /\[certified-fixture\] 1 fixture cleanup\(s\) remain unverified/);
      assert.match(result.output, /injected run cleanup fault/);
      // The helper ends on its own when its parent is gone (its control pipe reaches EOF): no orphan is left.
      const deadline = performance.now() + 30_000;
      let running = windowsProcessesUnder(result.roots[0]!);
      while (running.length > 0 && performance.now() < deadline) { await delay(250); running = windowsProcessesUnder(result.roots[0]!); }
      assert.deepEqual(running, [], "a program from the retained run's folder outlived its test file");
    } else {
      // A POSIX run may hold nothing after a failed close: the file then drains by itself, quietly; if it is held, it
      // is ended the same way and fails.
      assert.equal(result.code, /\[certified-fixture\] 1 fixture cleanup/.test(result.output) ? 1 : 0, result.output);
    }
  } finally { await removeRoots(t, result.roots); }
});
