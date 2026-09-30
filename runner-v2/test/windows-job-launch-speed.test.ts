// PX-2a — launch-speed pins for the Windows Job path (`runner-windows-job-v1`).
//
// Covers the two PX-2a changes on the REAL host: the precompiled,
// digest-pinned Job-host helper assembly (the helper event records the
// deterministic proof; a tampered file, a replaced pair, or a corrupt
// on-disk record is never loaded and the call still works through the
// in-process Add-Type fallback with the reason recorded) and the supervisor
// keep-alive fix (the supervisor is gone within 1 s of the result).
//
// Trust anchor (repair 1): the assembly is compiled once per runner process
// into a fresh per-process directory and its digest lives in memory only.
// There is no on-disk digest record: one written beside the DLL is ignored,
// and replacing both the DLL and a record never loads the replacement.
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
import { fileURLToPath } from "node:url";
import test, { after, before, type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { ensureJobHostHelperAssembly, extractJobHostHelperSource, resetJobHostHelperAssemblyForTests } from "../src/windows-job-process-host.js";

const WINDOWS_SKIP = "Windows Job launch-speed pin requires a Windows host.";
const BACKEND_SKIP = "Windows Job launch-speed pin requires the runner-windows-job-v1 backend to be selected.";

/** Legacy on-disk digest-record name. The runner never writes or reads it;
 * tests write it to prove it is ignored. */
const LEGACY_DIGEST_FILENAME = "ManagedProcessJobHost.dll.sha256";

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

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

/** Locate this runner process's in-memory-pinned helper assembly. */
async function locateHelperAssembly(): Promise<{ dllPath: string; sha256: string }> {
  const helper = await ensureJobHostHelperAssembly();
  assert.ok(helper, "helper must compile on this host");
  assert.ok(existsSync(helper.path), "helper assembly must exist");
  return { dllPath: helper.path, sha256: helper.sha256 };
}

/** Every `aiboard-px2a-evil-*` scratch dir this file creates, removed in `after` (N-r2-4). */
const evilScratchDirs: string[] = [];

/** A valid assembly WITHOUT the expected type (the trust-anchor replacement). */
let evilAssemblyPath: string | undefined;
function evilAssembly(): { path: string; sha256: string } {
  if (evilAssemblyPath && existsSync(evilAssemblyPath)) {
    return { path: evilAssemblyPath, sha256: sha256File(evilAssemblyPath) };
  }
  const directory = mkdtempSync(join(tmpdir(), "aiboard-px2a-evil-"));
  evilScratchDirs.push(directory);
  const dllPath = join(directory, "EvilHelper.dll");
  execFileSync("powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -TypeDefinition 'public static class EvilHelper { public static int Answer() { return 42; } }' -OutputAssembly '${dllPath}' -OutputType Library`],
    { windowsHide: true, stdio: "ignore", timeout: 120_000 });
  assert.ok(existsSync(dllPath), "evil assembly must compile");
  evilAssemblyPath = dllPath;
  return { path: dllPath, sha256: sha256File(dllPath) };
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
    // N9: the stop dir is removed even when the watched work throws.
    try {
      writeFileSync(stopFile, "stop");
    } catch {}
    try {
      await exited;
    } finally {
      rmSync(stopDir, { recursive: true, force: true });
    }
  }
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Run the Job-host script directly with a crafted stdin config (no supervisor). */
async function runDirectJobHost(options: {
  helperAssemblyPath: string;
  helperAssemblySha256: string;
}): Promise<{ exitCode: number; stdout: string; helper: HelperEvent }> {
  const workDir = mkdtempSync(join(tmpdir(), "aiboard-px2a-direct-"));
  try {
    const stdoutPath = join(workDir, "stdout.log");
    const stderrPath = join(workDir, "stderr.log");
    const eventPath = join(workDir, "job-events.jsonl");
    const scriptPath = fileURLToPath(new URL("../src/managed-process-job-host.ps1", import.meta.url));
    const env: Record<string, string> = {};
    for (const key of ["SystemRoot", "TEMP", "TMP", "PATH", "OS"]) {
      const value = process.env[key];
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
    const child = spawn("powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    const config = {
      command: process.execPath,
      args: ["-e", "console.log('px2a-direct-ok');"],
      cwd: workDir,
      env,
      stdoutPath,
      stderrPath,
      eventPath,
      helperAssemblyPath: options.helperAssemblyPath,
      helperAssemblySha256: options.helperAssemblySha256,
    };
    const exitCode: number = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error("px2a: direct Job host did not exit"));
      }, 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); resolve(code ?? -1); });
      child.stdin.write(`${JSON.stringify(config)}\n`, (error) => {
        if (error) { clearTimeout(timer); reject(error); }
        else child.stdin.end();
      });
    });
    const stdout = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
    let helper: HelperEvent | undefined;
    if (existsSync(eventPath)) {
      for (const line of readFileSync(eventPath, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type?: unknown; mode?: unknown; reason?: unknown };
        if (event.type === "helper") helper = { mode: event.mode as string, reason: (event.reason ?? null) as string | null };
      }
    }
    assert.ok(helper, "direct Job host must record a helper event");
    return { exitCode, stdout, helper };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
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
  for (const directory of evilScratchDirs.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
  evilAssemblyPath = undefined;
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

// PX-2a.1 — after the first call the Job host loads the precompiled helper.
// Repair 1 (B2): no machine-wide compiler watch. Watching `csc`/`cvtres`
// machine-wide goes red whenever any other suite compiles at the same time;
// the per-call helper event is the deterministic proof instead (the
// precompiled branch never reaches Add-Type).
test("launch-speed: Job host loads the precompiled helper after the first call", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  // Warmup: compiles the helper on first use (host-side) and proves the call
  // path before the watched calls.
  const warmToken = `warm-${randomUUID().slice(0, 8)}`;
  const warm = await runTokenCall(h, warmToken);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  for (let i = 0; i < 3; i += 1) {
    const token = `precompiled-${i}-${randomUUID().slice(0, 8)}`;
    const { stdout, processId } = await runTokenCall(h, token);
    assert.match(stdout, /px2a-token:/, `call ${i} must succeed`);
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
  const { dllPath, sha256 } = await locateHelperAssembly();
  const dllBefore = sha256File(dllPath);
  assert.equal(dllBefore, sha256, "in-memory digest must pin the file bytes");
  const pristine = readFileSync(dllPath);
  // Flip one byte in the middle: the in-memory digest still pins the original.
  const tampered = Buffer.from(pristine);
  tampered[Math.floor(tampered.byteLength / 2)]! ^= 0xff;
  writeFileSync(dllPath, tampered);
  try {
    assert.notEqual(sha256File(dllPath), dllBefore, "tamper must change the assembly file");
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
  }
});

// PX-2a.3 (repair 1) — an on-disk digest record is never trusted: with the
// assembly intact but a legacy `ManagedProcessJobHost.dll.sha256` record
// beside it, the call still loads precompiled against the in-memory digest.
test("launch-speed: an on-disk digest record is never trusted", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const warm = await runTokenCall(h, `record-warm-${randomUUID().slice(0, 8)}`);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  const { dllPath } = await locateHelperAssembly();
  const dllBefore = sha256File(dllPath);
  const recordPath = join(dllPath, "..", LEGACY_DIGEST_FILENAME);
  assert.ok(!existsSync(recordPath), "no digest record exists before the test");
  // Corrupt-record shape with a wrong value; the assembly file is intact.
  writeFileSync(recordPath, `${"0".repeat(64)}\n`, "utf8");
  try {
    assert.equal(sha256File(dllPath), dllBefore, "assembly file stays intact");
    const token = `record-${randomUUID().slice(0, 8)}`;
    const { stdout, processId } = await runTokenCall(h, token);
    assert.match(stdout, /px2a-token:/, "call succeeds");
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "precompiled", "a stray on-disk record must not divert the call to fallback");
    assert.equal(event.reason, null, "no fallback reason may be recorded");
    assert.equal(sha256File(dllPath), dllBefore, "intact assembly still untouched after the call");
  } finally {
    rmSync(recordPath, { force: true });
    assert.ok(!existsSync(recordPath), "stray record removed");
    assert.equal(sha256File(dllPath), dllBefore, "assembly untouched");
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

// PX-2a.5 (repair 1, trust anchor) — replacing the DLL AND any on-disk digest
// record between calls never loads the replacement: the next call falls back
// against the in-memory digest, and the reason is recorded.
test("launch-speed: replacing the DLL and its on-disk record never loads the replacement", { timeout: 120_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const warm = await runTokenCall(h, `evil-warm-${randomUUID().slice(0, 8)}`);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  const { dllPath } = await locateHelperAssembly();
  const dllBefore = sha256File(dllPath);
  const pristine = readFileSync(dllPath);
  const recordPath = join(dllPath, "..", LEGACY_DIGEST_FILENAME);
  const evil = evilAssembly();
  assert.notEqual(evil.sha256, dllBefore, "replacement must differ from the pinned assembly");
  writeFileSync(dllPath, readFileSync(evil.path));
  writeFileSync(recordPath, `${evil.sha256}\n`, "utf8");
  try {
    assert.equal(sha256File(dllPath), evil.sha256, "replacement DLL in place");
    assert.equal(readFileSync(recordPath, "utf8").trim(), evil.sha256, "replacement record blesses the replacement");
    const token = `evil-${randomUUID().slice(0, 8)}`;
    const { stdout, processId } = await runTokenCall(h, token);
    assert.match(stdout, /px2a-token:/, "replaced call still succeeds through the fallback");
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "fallback", "replacement assembly must not load precompiled");
    assert.equal(event.reason, "digest-mismatch", "replacement reason must be recorded");
  } finally {
    writeFileSync(dllPath, pristine);
    rmSync(recordPath, { force: true });
    assert.equal(sha256File(dllPath), dllBefore, "assembly restored byte-exact");
    assert.ok(!existsSync(recordPath), "replacement record removed");
  }
});

// PX-2a.6 (repair 1, N2) — helper resolution never throws: with an unusable
// TEMP it returns null (no persisted running record, no orphan supervisor);
// the failure is remembered for the runner's lifetime (repair 3, R3-B1), and
// only a new runner process compiles again.
test("launch-speed: helper resolution never throws and falls back cleanly", { timeout: 120_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const recordsBefore = new Set(
    readdirSync(h.jobHostDir).filter((entry) => entry.endsWith(".json")));
  resetJobHostHelperAssemblyForTests();
  // Fresh compile first, so the broken-TEMP window below proves the failure
  // path rather than a warm cache.
  const pre = await ensureJobHostHelperAssembly();
  assert.ok(pre, "helper must compile before the fault window");
  resetJobHostHelperAssemblyForTests();
  const badTemp = join(tmpdir(), `aiboard-px2a-badtemp-${randomUUID()}`);
  writeFileSync(badTemp, "not-a-directory");
  const savedTemp = process.env.TEMP;
  const savedTmp = process.env.TMP;
  const savedTmpdir = process.env.TMPDIR;
  process.env.TEMP = badTemp;
  process.env.TMP = badTemp;
  process.env.TMPDIR = badTemp;
  try {
    // Must return null, never throw (the old code threw ENOENT from mkdtemp).
    const helper = await ensureJobHostHelperAssembly();
    assert.equal(helper, null, "unusable TEMP must resolve to null, never throw");
  } finally {
    if (savedTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = savedTemp;
    if (savedTmp === undefined) delete process.env.TMP;
    else process.env.TMP = savedTmp;
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    rmSync(badTemp, { force: true });
  }
  // No side effects from the failed resolution: no records, no supervisors.
  const recordsAfter = new Set(
    readdirSync(h.jobHostDir).filter((entry) => entry.endsWith(".json")));
  assert.deepEqual(recordsAfter, recordsBefore, "failed helper resolution must persist no records");
  // R3-B1 (repair 3): a failed compile is remembered for the runner's
  // lifetime. With a good TEMP again, the runner still never recompiles into
  // its per-process directory (a contained process alive during such a retry
  // could get its bytes pinned); calls fall back to in-process Add-Type.
  assert.equal(await ensureJobHostHelperAssembly(), null, "a failed compile must never be retried in place");
  assert.equal(await ensureJobHostHelperAssembly(), null, "a failed compile stays failed for the runner's lifetime");
  const fallbackToken = `after-fail-${randomUUID().slice(0, 8)}`;
  const fallback = await runTokenCall(h, fallbackToken);
  assert.match(fallback.stdout, /px2a-token:/, "call after a failed compile must still succeed");
  const fallbackEvent = readHelperEvent(h.jobHostDir, fallback.processId);
  assert.equal(fallbackEvent.mode, "fallback", "call after a failed compile must fall back");
  assert.equal(fallbackEvent.reason, "no-helper-config", "the fallback must say no helper was configured");
  const fallbackRecord = findRecordByToken(h.jobHostDir, fallbackToken);
  assert.ok(fallbackRecord, "fallback call must leave a findable Job record");
  await waitFor(() => !processAlive(fallbackRecord.supervisorPid), 1_000, "fallback call supervisor to exit");
  // A runner restart (simulated by the test-only reset) restores the fast path.
  resetJobHostHelperAssemblyForTests();
  const token = `restart-${randomUUID().slice(0, 8)}`;
  const { stdout, processId } = await runTokenCall(h, token);
  assert.match(stdout, /px2a-token:/, "call after a runner restart must succeed");
  const event = readHelperEvent(h.jobHostDir, processId);
  assert.equal(event.mode, "precompiled", "a new runner process must compile and use the helper again");
  assert.equal(event.reason, null, "no fallback reason may be recorded after a restart");
  const record = findRecordByToken(h.jobHostDir, token);
  assert.ok(record, "restarted call must leave a findable Job record");
  await waitFor(() => !processAlive(record.supervisorPid), 1_000, "restarted call supervisor to exit");
});

// PX-2a.6b (repair 3, N-r2-2) — Windows PowerShell 5.1 Add-Type cannot
// compile to a path holding wildcard characters (unescaped it does not
// resolve; escaped, csc gets the escaped text and fails). So with a bracket
// TEMP the runner does not try at all: it resolves to null at once (no
// compile process), remembers it, and calls fall back to in-process Add-Type.
test("launch-speed: a TEMP path with brackets skips the helper compile and falls back", { timeout: 120_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const bracketTemp = join(tmpdir(), `aiboard-px2a-br[1]-${randomUUID().slice(0, 8)}`);
  mkdirSync(bracketTemp, { recursive: true });
  const savedTemp = process.env.TEMP;
  const savedTmp = process.env.TMP;
  resetJobHostHelperAssemblyForTests();
  process.env.TEMP = bracketTemp;
  process.env.TMP = bracketTemp;
  try {
    const helper = await ensureJobHostHelperAssembly();
    assert.equal(helper, null, "a bracket TEMP path must resolve to the fallback");
    const written = readdirSync(bracketTemp, { recursive: true }).map(String);
    assert.ok(!written.some((entry) => entry.endsWith("compile-helper-wrapper.ps1")),
      `no compile may be attempted for a wildcard path (found: ${written.join(", ")})`);
    assert.equal(await ensureJobHostHelperAssembly(), null, "the skip is remembered for the runner's lifetime");
  } finally {
    if (savedTemp === undefined) delete process.env.TEMP;
    else process.env.TEMP = savedTemp;
    if (savedTmp === undefined) delete process.env.TMP;
    else process.env.TMP = savedTmp;
    resetJobHostHelperAssemblyForTests();
    rmSync(bracketTemp, { recursive: true, force: true });
  }
});

// PX-2a.7 (repair 1, N5 + reason pins) — direct Job-host runs: a valid
// assembly without the expected type, garbage bytes with a matching digest,
// and a missing file all fall back with the reason recorded, never exit 1.
test("launch-speed: direct Job host falls back on missing type, load error, and missing file", { timeout: 120_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip(WINDOWS_SKIP);
    return;
  }
  const evil = evilAssembly();
  const missingType = await runDirectJobHost({ helperAssemblyPath: evil.path, helperAssemblySha256: evil.sha256 });
  assert.equal(missingType.exitCode, 0, "valid assembly without the type must fall back, not exit 1");
  assert.match(missingType.stdout, /px2a-direct-ok/, "missing-type call must run its command");
  assert.equal(missingType.helper.mode, "fallback", "missing type must not load precompiled");
  assert.equal(missingType.helper.reason, "missing-type", "missing-type reason must be recorded");

  const garbageDir = mkdtempSync(join(tmpdir(), "aiboard-px2a-garbage-"));
  try {
    const garbagePath = join(garbageDir, "Garbage.dll");
    const garbage = Buffer.from(randomUUID().repeat(64));
    writeFileSync(garbagePath, garbage);
    const loadError = await runDirectJobHost({ helperAssemblyPath: garbagePath, helperAssemblySha256: sha256Bytes(garbage) });
    assert.equal(loadError.exitCode, 0, "unloadable bytes must fall back, not fail");
    assert.match(loadError.stdout, /px2a-direct-ok/, "load-error call must run its command");
    assert.equal(loadError.helper.mode, "fallback", "unloadable bytes must not load");
    assert.equal(loadError.helper.reason, "load-error", "load-error reason must be recorded");
  } finally {
    rmSync(garbageDir, { recursive: true, force: true });
  }

  const missing = await runDirectJobHost({
    helperAssemblyPath: join(tmpdir(), `aiboard-px2a-absent-${randomUUID()}`, "ManagedProcessJobHost.dll"),
    helperAssemblySha256: "ab".repeat(32),
  });
  assert.equal(missing.exitCode, 0, "missing file must fall back, not fail");
  assert.match(missing.stdout, /px2a-direct-ok/, "missing-file call must run its command");
  assert.equal(missing.helper.mode, "fallback", "missing file must not load");
  assert.equal(missing.helper.reason, "missing-file", "missing-file reason must be recorded");
});

// PX-2a.8 (repair 2, R2-B1) — a deleted assembly file NEVER recompiles in
// place. The old self-heal recompiled at a moment the deleter chose, so a
// contained command that deleted the DLL could overwrite the fresh file
// before the runner hashed it and get its own bytes blessed. Now the call
// falls back with missing-file for the rest of the runner life, the file is
// not recreated, and the call still succeeds through the in-process
// fallback.
test("launch-speed: a deleted assembly file falls back and never recompiles", { timeout: 120_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const warm = await runTokenCall(h, `heal-warm-${randomUUID().slice(0, 8)}`);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  const { dllPath } = await locateHelperAssembly();
  const pristine = readFileSync(dllPath);
  const pristineSha = sha256Bytes(pristine);
  rmSync(dllPath, { force: true });
  try {
    assert.ok(!existsSync(dllPath), "assembly file must be gone");
    const token = `deleted-${randomUUID().slice(0, 8)}`;
    const { stdout, processId } = await runTokenCall(h, token);
    assert.match(stdout, /px2a-token:/, "call with a deleted assembly must succeed");
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "fallback", "deleted assembly must fall back, never recompile in place");
    assert.equal(event.reason, "missing-file", "deleted assembly must record missing-file");
    assert.ok(!existsSync(dllPath), "the runner must not recreate the assembly file");
  } finally {
    // Best-effort restore only, no assertions here: a failure above must
    // report its own message, not a recovery failure (N-r2-1). The pin
    // still matches these bytes, so later tests run precompiled again.
    try {
      if (!existsSync(dllPath)) writeFileSync(dllPath, pristine);
    } catch {}
  }
  assert.equal(sha256File(dllPath), pristineSha, "assembly restored byte-exact");
});

// PX-2a.9 — a truncated assembly file is never loaded: the call still works
// through the in-process fallback and the reason is recorded.
test("launch-speed: a truncated assembly file is never loaded", { timeout: 55_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const warm = await runTokenCall(h, `trunc-warm-${randomUUID().slice(0, 8)}`);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  const { dllPath } = await locateHelperAssembly();
  const dllBefore = sha256File(dllPath);
  const pristine = readFileSync(dllPath);
  writeFileSync(dllPath, pristine.subarray(0, Math.floor(pristine.byteLength / 2)));
  try {
    assert.notEqual(sha256File(dllPath), dllBefore, "truncation must change the assembly file");
    const token = `truncated-${randomUUID().slice(0, 8)}`;
    let stdout = "";
    let processId = "";
    const compilers = await watchCompilersDuring(async () => {
      ({ stdout, processId } = await runTokenCall(h, token));
    });
    assert.match(stdout, /px2a-token:/, "truncated call still succeeds through the fallback");
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "fallback", "truncated assembly must not load precompiled");
    assert.equal(event.reason, "digest-mismatch", "truncation reason must be recorded");
    assert.ok(compilers.length > 0, "fallback must compile in-process (a compiler must be observed)");
  } finally {
    writeFileSync(dllPath, pristine);
    assert.equal(sha256File(dllPath), dllBefore, "assembly restored byte-exact");
  }
});

// PX-2a.10 (repair 2, R2-B1 regression) — replays the delete-and-race shape
// from the round-2 exploit: a contained command deletes the DLL, then
// overwrites the file the moment it reappears, while a second call launches
// meanwhile. With the self-heal removed nothing ever reappears, so the
// attacker's write never lands and never loads: the victim call succeeds
// through the fallback, no evil marker is written, and the attacker reports
// wrote=no.
test("launch-speed: a delete-and-race against the helper never loads attacker bytes", { timeout: 180_000 }, async (t) => {
  const h = needsJob(t);
  if (!h) return;
  const warm = await runTokenCall(h, `race-warm-${randomUUID().slice(0, 8)}`);
  assert.match(warm.stdout, /px2a-token:/, "warmup call must succeed");
  const { dllPath } = await locateHelperAssembly();
  const pristine = readFileSync(dllPath);
  const pristineSha = sha256Bytes(pristine);
  // Evil clone of the real helper: the same type surface plus a static
  // constructor that drops a marker the moment the type is first touched,
  // so loading these bytes in any Job host is directly observable.
  const markerPath = join(h.root, "px2a-evil-marker.txt");
  rmSync(markerPath, { force: true });
  const evilDir = mkdtempSync(join(tmpdir(), "aiboard-px2a-evil-"));
  evilScratchDirs.push(evilDir);
  const evilDllPath = join(evilDir, "Evil.dll");
  const evilCsPath = join(evilDir, "evil.cs");
  const scriptText = readFileSync(fileURLToPath(new URL("../src/managed-process-job-host.ps1", import.meta.url)), "utf8");
  const helperSource = extractJobHostHelperSource(scriptText);
  assert.ok(helperSource, "helper source must extract from the Job-host script");
  const classHeader = /public static class ManagedProcessJobHost\s*\{/;
  assert.ok(classHeader.test(helperSource), "helper class header must be present");
  writeFileSync(evilCsPath,
    helperSource.replace(classHeader, (header) =>
      `${header}\n    static ManagedProcessJobHost() { System.IO.File.AppendAllText(@"${markerPath.replace(/"/g, '""')}", "EVIL-LOADED"); }`),
    "utf8");
  execFileSync("powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -TypeDefinition (Get-Content -LiteralPath '${evilCsPath}' -Raw -Encoding UTF8) -OutputAssembly '${evilDllPath}' -OutputType Library`],
    { windowsHide: true, stdio: "ignore", timeout: 120_000 });
  assert.ok(existsSync(evilDllPath), "evil assembly must compile");
  assert.notEqual(sha256File(evilDllPath), pristineSha, "evil bytes must differ from the pinned assembly");
  try {
    // Contained deleter-plus-racer: removes the DLL, then overwrites it the
    // moment it reappears — the exact shape of the round-2 exploit.
    const attackerScript = [
      `const fs = require('fs');`,
      `const dll = ${JSON.stringify(dllPath)};`,
      `const evil = ${JSON.stringify(evilDllPath)};`,
      `try { fs.rmSync(dll, { force: true }); } catch {}`,
      `console.log('px2a-attacker-deleted');`,
      `let wrote = false;`,
      `const end = Date.now() + 20000;`,
      `while (Date.now() < end && !wrote) {`,
      `  try { if (fs.existsSync(dll)) { fs.writeFileSync(dll, fs.readFileSync(evil)); wrote = true; } } catch {}`,
      `  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch {}`,
      `}`,
      `console.log('px2a-attacker-wrote:' + (wrote ? 'yes' : 'no'));`,
    ].join("\n");
    callSeq += 1;
    const attackerPromise = h.binding.commandExecution.execute({
      executable: process.execPath,
      arguments: ["-e", attackerScript],
      workingDirectory: h.project,
      timeoutMs: 60_000,
      captureOutputBytes: 1024 * 1024,
      context: {
        runId: h.runId,
        sessionId: `session-${h.runId}`,
        actor: { role: "worker" as const, id: "worker-px2a" },
        callId: `px2a-race-attacker-${callSeq}-${randomUUID().slice(0, 8)}`,
        toolName: "process.run",
        runnerInternal: true as const,
      },
    });
    // The victim launches only after the delete is observed, while the
    // racer is still spinning — the exploit's timing, without the flake.
    await waitFor(() => !existsSync(dllPath), 30_000, "contained deleter to remove the assembly");
    const token = `race-${randomUUID().slice(0, 8)}`;
    const { stdout, processId } = await runTokenCall(h, token);
    const attackerResult = await attackerPromise;
    const attackerProc = (attackerResult as { process?: { outcome?: unknown; exitCode?: unknown } }).process;
    assert.equal(attackerProc?.outcome, "exited", "contained attacker must exit");
    assert.equal(attackerProc?.exitCode, 0, "contained attacker must exit 0");
    const attackerCaptured = (attackerResult as { capturedOutput?: { stdout?: Uint8Array } }).capturedOutput;
    const attackerStdout = attackerCaptured?.stdout ? Buffer.from(attackerCaptured.stdout).toString("utf8") : "";
    assert.match(attackerStdout, /px2a-attacker-deleted/, "attacker must have run the delete");
    assert.match(attackerStdout, /px2a-attacker-wrote:no/, "nothing ever reappeared for the attacker to overwrite");
    assert.match(stdout, /px2a-token:/, "victim call must succeed through the fallback");
    const event = readHelperEvent(h.jobHostDir, processId);
    assert.equal(event.mode, "fallback", "victim call must never load precompiled bytes mid-race");
    assert.equal(event.reason, "missing-file", "victim call must record missing-file");
    assert.ok(!existsSync(markerPath), "attacker bytes must never load (no evil marker)");
  } finally {
    // Best-effort restore only (N-r2-1): the pin still matches these bytes.
    try {
      if (!existsSync(dllPath)) writeFileSync(dllPath, pristine);
    } catch {}
    rmSync(markerPath, { force: true });
  }
  assert.equal(sha256File(dllPath), pristineSha, "assembly restored byte-exact");
  assert.ok(!existsSync(markerPath), "evil marker absent after cleanup");
});
