// PX-2a — launch-speed pins for the Windows Job path (`runner-windows-job-v1`).
//
// Covers the two PX-2a changes on the REAL host: the precompiled,
// digest-pinned Job-host helper assembly (no `csc.exe` per call after the
// first; a tampered file or digest is never loaded and the call still works
// through the in-process Add-Type fallback with the reason recorded) and the
// supervisor keep-alive fix (the supervisor is gone within 1 s of the result).
//
// Skip policy: clean `t.skip` off Windows, or when the Job backend is not
// selected (checked empirically: one git call must leave Job-host records).
// Every fault below is restored byte-exact (sha256 before == after).
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";

const WINDOWS_SKIP = "Windows Job launch-speed pin requires a Windows host.";
const BACKEND_SKIP = "Windows Job launch-speed pin requires the runner-windows-job-v1 backend to be selected.";

interface Px2aHarness {
  readonly host: ExecutionHost;
  readonly binding: ExecutionHostRunBinding;
  readonly root: string;
  readonly project: string;
  readonly stateDir: string;
  readonly jobHostDir: string;
  readonly runId: string;
}

let harness: Px2aHarness | undefined;
let jobBackendSelected = false;
let callSeq = 0;

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`px2a: ${what} did not settle within ${timeoutMs}ms`);
    await sleep(25);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function initGitRepo(directory: string): void {
  execFileSync("git", ["init", "-q", directory]);
  execFileSync("git", ["-C", directory, "config", "user.email", "px2a@example.test"]);
  execFileSync("git", ["-C", directory, "config", "user.name", "px2a"]);
  writeFileSync(join(directory, "f.txt"), "px2a\n");
  execFileSync("git", ["-C", directory, "add", "."]);
  execFileSync("git", ["-C", directory, "commit", "-qm", "px2a"]);
}

interface JobRecordView {
  readonly processId: string;
  readonly supervisorPid: number;
  readonly args: readonly string[];
}

function readJobRecords(jobHostDir: string): JobRecordView[] {
  let entries: string[];
  try {
    entries = readdirSync(jobHostDir).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  const records: JobRecordView[] = [];
  for (const file of entries) {
    try {
      const raw = JSON.parse(readFileSync(join(jobHostDir, file), "utf8")) as {
        processId?: unknown;
        args?: unknown;
        supervisor?: { supervisorPid?: unknown };
      };
      if (typeof raw.processId !== "string") continue;
      records.push({
        processId: raw.processId,
        supervisorPid:
          typeof raw.supervisor?.supervisorPid === "number" ? (raw.supervisor.supervisorPid as number) : 0,
        args: Array.isArray(raw.args) ? raw.args.filter((entry): entry is string => typeof entry === "string") : [],
      });
    } catch {
      continue;
    }
  }
  return records;
}

/** This call's Job record: the one whose argv carries our unique token. */
function findRecordByToken(jobHostDir: string, token: string): JobRecordView | undefined {
  return readJobRecords(jobHostDir).find((record) => record.args.some((arg) => arg.includes(token)));
}

interface HelperEvent {
  readonly mode: string;
  readonly reason: string | null;
}

/** The helper-load event the Job host appends to its per-call event file. */
function readHelperEvent(jobHostDir: string, processId: string): HelperEvent {
  const text = readFileSync(join(jobHostDir, processId, "job-events.jsonl"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as { type?: unknown; mode?: unknown; reason?: unknown };
    if (event.type === "helper") {
      assert.equal(typeof event.mode, "string", "helper event must carry a mode");
      assert.ok(event.reason === null || typeof event.reason === "string", "helper event reason must be null or a string");
      return { mode: event.mode as string, reason: (event.reason ?? null) as string | null };
    }
  }
  throw new Error(`px2a: no helper event in job-events.jsonl for ${processId}`);
}

/** Locate the compiled helper assembly under the Job-host state directory. */
function findHelperAssembly(jobHostDir: string): { dllPath: string; digestPath: string } {
  const assemblies = join(jobHostDir, "job-host-assemblies");
  const digestDirs = readdirSync(assemblies, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.equal(digestDirs.length, 1, "exactly one compiled helper generation must exist");
  const dllPath = join(assemblies, digestDirs[0]!, "ManagedProcessJobHost.dll");
  const digestPath = join(assemblies, digestDirs[0]!, "ManagedProcessJobHost.dll.sha256");
  assert.ok(existsSync(dllPath), "helper assembly must exist");
  assert.ok(existsSync(digestPath), "helper digest record must exist");
  return { dllPath, digestPath };
}

function needsJob(t: TestContext): Px2aHarness | undefined {
  if (process.platform !== "win32") {
    t.skip(WINDOWS_SKIP);
    return undefined;
  }
  if (!jobBackendSelected || !harness) {
    t.skip(BACKEND_SKIP);
    return undefined;
  }
  return harness;
}

/** One production-shaped node call carrying a unique argv token. */
async function runTokenCall(h: Px2aHarness, token: string, timeoutMs = 30_000): Promise<{ stdout: string; processId: string }> {
  callSeq += 1;
  const callId = `px2a-${callSeq}-${randomUUID().slice(0, 8)}`;
  const script = `console.log(${JSON.stringify(`px2a-token:${token}`)});`;
  const result = await h.binding.commandExecution.execute({
    executable: process.execPath,
    arguments: ["-e", script],
    workingDirectory: h.project,
    timeoutMs,
    captureOutputBytes: 1024 * 1024,
    context: {
      runId: h.runId,
      sessionId: `session-${h.runId}`,
      actor: { role: "worker" as const, id: "worker-px2a" },
      callId,
      toolName: "process.run",
      runnerInternal: true as const,
    },
  });
  const record = findRecordByToken(h.jobHostDir, token);
  assert.ok(record, "token call must leave a findable Job record");
  const proc = (result as { process?: { outcome?: unknown; exitCode?: unknown; cleanup?: { state?: unknown } } }).process;
  assert.equal(proc?.outcome, "exited", "token call must exit");
  assert.equal(proc?.exitCode, 0, "token call must exit 0");
  assert.equal(proc?.cleanup?.state, "verified_empty", "token call must verify empty");
  const captured = (result as { capturedOutput?: { stdout?: Uint8Array } }).capturedOutput;
  const stdout = captured?.stdout ? Buffer.from(captured.stdout).toString("utf8") : "";
  return { stdout, processId: record.processId };
}

/** Watch for Add-Type compiler processes (csc.exe / cvtres.exe) while `work` runs. */
async function watchCompilersDuring(work: () => Promise<void>): Promise<string[]> {
  const stopDir = mkdtempSync(join(tmpdir(), "aiboard-px2a-watch-"));
  const stopFile = join(stopDir, "stop");
  const readyFile = join(stopDir, "ready");
  const script =
    `$stop='${stopFile.replace(/'/g, "''")}';` +
    `$ready='${readyFile.replace(/'/g, "''")}';` +
    `$seen=@{};$i=0;$signaled=$false;` +
    `while (($i -lt 3000) -and -not (Test-Path -LiteralPath $stop)) {` +
    // SilentlyContinue (not Stop): with several names, a missing cvtres.exe
    // must not abort the pipeline before a present csc.exe is recorded.
    `$found=@(Get-Process -Name 'csc','cvtres' -ErrorAction SilentlyContinue);` +
    `foreach ($p in $found) { $seen[$p.Id] = $p.ProcessName };` +
    `if (-not $signaled) { Add-Content -LiteralPath $ready -Value "ready" -Encoding ASCII; $signaled=$true };` +
    `Start-Sleep -Milliseconds 20;$i++ };` +
    `$seen.GetEnumerator() | ForEach-Object { "$($_.Value):$($_.Key)" }`;
  const watcher = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  watcher.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("px2a: compiler watcher did not exit")), 30_000);
    watcher.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    watcher.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  // Ready-handshake: the call starts only after the watcher has polled at
  // least once, so a slow watcher boot cannot miss a fast compile.
  const readyDeadline = Date.now() + 30_000;
  while (!existsSync(readyFile)) {
    if (watcher.exitCode !== null) throw new Error("px2a: compiler watcher exited before signaling ready");
    if (Date.now() >= readyDeadline) throw new Error("px2a: compiler watcher did not signal ready");
    await sleep(10);
  }
  try {
    await work();
  } finally {
    writeFileSync(stopFile, "stop");
  }
  await exited;
  rmSync(stopDir, { recursive: true, force: true });
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

before(async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-px2a-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  initGitRepo(project);
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const host = createExecutionHost({
    projectRoot: project,
    stateDirectory: stateDir,
    artifacts: new ArtifactStore(join(stateDir, "artifacts")),
    ambientEnvironment: { ...process.env },
  });
  const runId = `px2a-${randomUUID()}`;
  const binding = await host.bindRun({
    runId,
    permissionProfile: "full",
    capabilityContract: { digest: "b".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  const jobHostDir = join(stateDir, "managed-processes-job-host");
  harness = { host, binding, root, project, stateDir, jobHostDir, runId };
  // Selection probe: one production git call must leave Job-host records,
  // which only the runner-windows-job-v1 backend writes.
  await binding.git.lifecycle("integration").run({ cwd: project, args: ["rev-parse", "HEAD"] });
  jobBackendSelected = readJobRecords(jobHostDir).length > 0;
}, { timeout: 120_000 });

after(async () => {
  if (!harness) return;
  const h = harness;
  harness = undefined;
  try {
    await h.binding.close();
  } catch {
    // Cleanup best-effort; per-test assertions already ran.
  }
  try {
    await h.host.close();
  } catch {
    // Same as above.
  }
  rmSync(h.root, { recursive: true, force: true });
});

// PX-2a.1 — after the first call the Job host loads the precompiled helper:
// no compiler process runs during the call and the helper event records it.
test("launch-speed: Job host loads the precompiled helper after the first call", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  // Warmup: compiles the helper on first use (host-side, unwatched) and
  // proves the call path before the watched calls.
  const warmToken = `warm-${randomUUID().slice(0, 8)}`;
  const warm = await runTokenCall(h, warmToken);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  for (let i = 0; i < 3; i += 1) {
    const token = `precompiled-${i}-${randomUUID().slice(0, 8)}`;
    let stdout = "";
    let processId = "";
    const compilers = await watchCompilersDuring(async () => {
      ({ stdout, processId } = await runTokenCall(h, token));
    });
    assert.match(stdout, /px2a-token:/, `call ${i} must succeed`);
    assert.deepEqual(compilers, [], `no compiler may run during call ${i} (saw ${compilers.join(",")})`);
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "precompiled", `call ${i} must load the precompiled helper`);
    assert.equal(event.reason, null, `call ${i} must record no fallback reason`);
  }
});

// PX-2a.2 — a tampered assembly file is never loaded: the call still works
// through the in-process fallback and the reason is recorded.
test("launch-speed: a tampered assembly file is never loaded", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const warm = await runTokenCall(h, `tamper-warm-${randomUUID().slice(0, 8)}`);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  const { dllPath, digestPath } = findHelperAssembly(h.jobHostDir);
  const dllBefore = sha256File(dllPath);
  const digestBefore = sha256File(digestPath);
  const pristine = readFileSync(dllPath);
  // Flip one byte in the middle: the digest record still pins the original.
  const tampered = Buffer.from(pristine);
  tampered[Math.floor(tampered.byteLength / 2)]! ^= 0xff;
  writeFileSync(dllPath, tampered);
  try {
    assert.notEqual(sha256File(dllPath), dllBefore, "tamper must change the assembly file");
    assert.equal(sha256File(digestPath), digestBefore, "digest record stays pinned to the original");
    const token = `tampered-${randomUUID().slice(0, 8)}`;
    let stdout = "";
    let processId = "";
    const compilers = await watchCompilersDuring(async () => {
      ({ stdout, processId } = await runTokenCall(h, token));
    });
    assert.match(stdout, /px2a-token:/, "tampered call still succeeds through the fallback");
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "fallback", "tampered assembly must not load precompiled");
    assert.equal(event.reason, "digest-mismatch", "tamper reason must be recorded");
    assert.ok(compilers.length > 0, "fallback must compile in-process (a compiler must be observed)");
  } finally {
    writeFileSync(dllPath, pristine);
    assert.equal(sha256File(dllPath), dllBefore, "assembly restored byte-exact");
    assert.equal(sha256File(digestPath), digestBefore, "digest record untouched");
  }
});

// PX-2a.3 — a digest mismatch is never loaded: with the assembly intact but
// the digest record corrupted, the call still works through the fallback.
test("launch-speed: a digest mismatch is never loaded", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const warm = await runTokenCall(h, `digest-warm-${randomUUID().slice(0, 8)}`);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  const { dllPath, digestPath } = findHelperAssembly(h.jobHostDir);
  const dllBefore = sha256File(dllPath);
  const digestBefore = sha256File(digestPath);
  const pristineDigest = readFileSync(digestPath, "utf8");
  // Corrupt the digest record (valid shape, wrong value); the file is intact.
  writeFileSync(digestPath, `${"0".repeat(64)}\n`, "utf8");
  try {
    assert.equal(sha256File(dllPath), dllBefore, "assembly file stays intact");
    assert.notEqual(sha256File(digestPath), digestBefore, "digest record must change");
    const token = `mismatch-${randomUUID().slice(0, 8)}`;
    let stdout = "";
    let processId = "";
    const compilers = await watchCompilersDuring(async () => {
      ({ stdout, processId } = await runTokenCall(h, token));
    });
    assert.match(stdout, /px2a-token:/, "mismatched call still succeeds through the fallback");
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "fallback", "mismatched digest must not load");
    assert.equal(event.reason, "digest-mismatch", "mismatch reason must be recorded");
    assert.ok(compilers.length > 0, "fallback must compile in-process (a compiler must be observed)");
    assert.equal(sha256File(dllPath), dllBefore, "intact assembly still untouched after the call");
  } finally {
    writeFileSync(digestPath, pristineDigest, "utf8");
    assert.equal(sha256File(dllPath), dllBefore, "assembly untouched");
    assert.equal(sha256File(digestPath), digestBefore, "digest record restored byte-exact");
  }
});

// PX-2a.4 (F7) — the host no longer keeps the supervisor connection alive,
// so the supervisor is gone within 1 s after the result.
test("launch-speed: the supervisor is gone within 1 s after the result", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const token = `reap-${randomUUID().slice(0, 8)}`;
  const { stdout } = await runTokenCall(h, token);
  assert.match(stdout, /px2a-token:/, "call must succeed");
  const record = findRecordByToken(h.jobHostDir, token);
  assert.ok(record, "call must leave a findable Job record");
  assert.ok(record.supervisorPid > 0, "record must carry the supervisor PID");
  const started = Date.now();
  await waitFor(() => !processAlive(record.supervisorPid), 1_000, "supervisor to exit after the result");
  const elapsed = Date.now() - started;
  assert.ok(elapsed <= 1_000, `supervisor exited in ${elapsed}ms (bound 1 s)`);
});
