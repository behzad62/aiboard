import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withOwnedFenceLockSync } from "./owned-fence-lock.mjs";
import { signalOwnedPosixGroup } from "./portable-process-posix-control.mjs";

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const statePath = join(config.directory, "state.json");
const controlPath = join(config.directory, "control.json");
const stdoutPath = join(config.directory, "stdout.log");
const stderrPath = join(config.directory, "stderr.log");
const childGoPath = join(config.directory, "child-go");
const childStatusPath = join(config.directory, "child-status.json");
const fencePath = join(config.directory, "fence.json");
const lockHolderPath = join(config.directory, "lock-holder.json");
const channelDirectory = join(config.directory, "channel");
const channelOutputDirectory = join(channelDirectory, "output");
const channelInputDirectory = join(channelDirectory, "input");
const channelAckDirectory = join(channelDirectory, "ack");
const outputCheckpointPath = join(channelDirectory, "output-checkpoint.json");
for (const directory of [channelDirectory, channelOutputDirectory, channelInputDirectory, channelAckDirectory]) mkdirSync(directory, { recursive: true });
if (!existsSync(outputCheckpointPath)) writeAtomic(outputCheckpointPath, JSON.stringify({ nonce: config.nonce, stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
const replayCapacityChunks = config.replayCapacityChunks ?? 16;
const replayCapacityBytes = config.replayCapacityBytes ?? 256 * 1024;
const WINDOWS_TREE_FAILURE_LIMIT = 3;
const WINDOWS_TREE_REFRESH_INTERVAL_MS = 250;
const WINDOWS_TREE_INSPECTION_DEADLINE_MS = 2_000;
const outputSequences = { stdout: 0, stderr: 0 };
const outputOffsets = { stdout: 0, stderr: 0 };
const retained = new Map();
let retainedBytes = 0;
let handledInput = 0;
let revision = 0;
let handledControl = 0;
let targetExited = false;
let targetExitCode = null;
let targetSignal = null;
const knownProcesses = new Map();
let ownershipMismatch = false;
let ownershipInspectionUnknown = false;
let ownershipInspectionDetail = "";
let controlInspectionUnknown = false;
let lastWindowsProcesses;
let lastWindowsParents;
let windowsTreeRefreshInFlight = false;
let lastWindowsTreeRefreshFinishedAt = Number.NEGATIVE_INFINITY;
let windowsTreeRefreshCount = 0;
let windowsTreeRefreshMinimumGapMs = null;
let windowsTreeFailures = 0;
let launchEffect = config.platform === "windows" ? "prepared" : "started";
let rootProcess = null;

const childBootstrap = new URL("./portable-process-child.mjs", import.meta.url);
const child = config.platform === "windows"
  ? spawn(process.execPath, [fileURLToPath(childBootstrap), Buffer.from(JSON.stringify({
      executable: config.executable,
      arguments: config.arguments,
      workingDirectory: config.workingDirectory,
      environment: config.environment,
      goPath: childGoPath,
      statusPath: childStatusPath,
    })).toString("base64url")], {
      cwd: config.workingDirectory,
      env: config.environment,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
  : spawn(config.executable, config.arguments, {
  cwd: config.workingDirectory,
  env: config.environment,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
  });
if (!child.pid) {
  launchEffect = "not_started";
  fail("Owned process has no PID.", "stopped");
}
if (config.platform === "windows") {
  const inspection = inspectWindowsBirth(child.pid);
  if (inspection.state === "present") {
    rootProcess = { pid: child.pid, birth: inspection.fingerprint };
    knownProcesses.set(child.pid, inspection.fingerprint);
    publish("preparing");
    writeFileSync(childGoPath, config.nonce);
    const startup = waitForChildStartup(5_000);
    if (startup?.status === "started") launchEffect = "started";
    else if (startup?.status === "error") {
      launchEffect = "started";
      fail(startup.error ?? "Owned process failed to start.", "stopped");
    } else launchEffect = "unknown";
  } else {
    launchEffect = "unknown";
  }
}
installOutput("stdout", child.stdout, stdoutPath);
installOutput("stderr", child.stderr, stderrPath);
child.once("error", (error) => fail(error.message));
child.once("exit", (code, signal) => {
  targetExited = true;
  targetExitCode = code;
  targetSignal = signal;
  publish(launchEffect === "started" ? "running" : "outcome_unknown");
});
publish(launchEffect === "started" ? "running" : "outcome_unknown", launchEffect === "unknown" ? "Initial Windows process birth inspection was unavailable or the PID disappeared before discovery." : null);

const timer = setInterval(tick, Math.max(10, config.pollIntervalMs ?? 25));
process.stdin.resume();
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

function tick() {
  try {
    if (controlInspectionUnknown) {
      publish("outcome_unknown", ownershipInspectionDetail || "Windows destructive control ownership is uncertain.");
      return;
    }
    if (launchEffect === "unknown") {
      publish("outcome_unknown", "Initial Windows process identity was not captured before discovery.");
      return;
    }
    handleChannelAcks();
    handleChannelInput();
    drainOutput("stdout", child.stdout, stdoutPath);
    drainOutput("stderr", child.stderr, stderrPath);
    if (config.platform === "windows" && windowsTreeFailures < WINDOWS_TREE_FAILURE_LIMIT) requestWindowsTreeRefresh();
    if (ownershipInspectionUnknown) {
      if (windowsTreeFailures >= WINDOWS_TREE_FAILURE_LIMIT)
        publish("outcome_unknown", `Owned Windows process inspection is unavailable: ${ownershipInspectionDetail}`);
      return;
    }
    if (ownershipMismatch) {
      publish("outcome_unknown", "Owned Windows descendant birth identity changed.");
      return;
    }
    if (config.platform === "windows" && !lastWindowsProcesses && windowsTreeRefreshInFlight) return;
    handleControl();
    const active = activeOwnedPids();
    if (active === undefined) {
      publish("outcome_unknown", "Owned process membership inspection is unavailable.");
      return;
    }
    if (targetExited && active.length === 0 && retained.size === 0) {
      publish("stopped");
      clearInterval(timer);
      process.exit(0);
    }
    publish("running");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function installOutput(stream, readable, evidencePath) {
  readable.on("readable", () => drainOutput(stream, readable, evidencePath));
}

function drainOutput(stream, readable, evidencePath) {
  while (retained.size < replayCapacityChunks && retainedBytes < replayCapacityBytes) {
    const maximum = Math.min(16 * 1024, replayCapacityBytes - retainedBytes);
    if (maximum < 1) break;
    const bytes = readable.read(maximum);
    if (!bytes) break;
    appendFileSync(evidencePath, bytes);
    const sequence = ++outputSequences[stream];
    const startOffset = outputOffsets[stream];
    const endOffset = startOffset + bytes.byteLength;
    outputOffsets[stream] = endOffset;
    const metadata = {
      stream,
      sequence,
      startOffset,
      endOffset,
      byteLength: bytes.byteLength,
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
    const name = `${stream}-${String(sequence).padStart(12, "0")}`;
    writeAtomic(join(channelOutputDirectory, `${name}.json`), JSON.stringify({ nonce: config.nonce, metadata, bytes: Buffer.from(bytes).toString("base64") }));
    retained.set(name, metadata);
    retainedBytes += bytes.byteLength;
  }
}

function handleChannelAcks() {
  for (const name of readdirSync(channelAckDirectory).filter((entry) => entry.endsWith(".json"))) {
    let ack;
    try { ack = JSON.parse(readFileSync(join(channelAckDirectory, name), "utf8")); } catch { continue; }
    const key = name.slice(0, -5);
    const expected = retained.get(key);
    if (!expected || ack.nonce !== config.nonce || JSON.stringify(ack.metadata) !== JSON.stringify(expected)) continue;
    const fence = readCurrentFence();
    if (!fence || ack.ownerId !== fence.ownerId || ack.fencingToken !== fence.fencingToken) continue;
    withCurrentFenceEffect(ack.ownerId, ack.fencingToken, () => {
      unlinkSync(join(channelOutputDirectory, `${key}.json`));
      if (existsSync(join(channelOutputDirectory, `${key}.json`))) throw new Error("Acknowledged portable output could not be deleted.");
      const checkpoint = JSON.parse(readFileSync(outputCheckpointPath, "utf8"));
      const current = checkpoint[expected.stream];
      if (checkpoint.nonce !== config.nonce || current.sequence + 1 !== expected.sequence || current.endOffset !== expected.startOffset)
        throw new Error("Portable output deletion checkpoint is not contiguous.");
      checkpoint[expected.stream] = { sequence: expected.sequence, endOffset: expected.endOffset };
      writeAtomic(outputCheckpointPath, JSON.stringify(checkpoint));
      try { unlinkSync(join(channelAckDirectory, name)); } catch {}
      retained.delete(key);
      retainedBytes -= expected.byteLength;
    });
  }
}

function handleChannelInput() {
  const expectedName = `input-${String(handledInput + 1).padStart(12, "0")}.json`;
  const path = join(channelInputDirectory, expectedName);
  if (!existsSync(path)) return;
  let command;
  try { command = JSON.parse(readFileSync(path, "utf8")); } catch { return; }
  const fence = readCurrentFence();
  if (!fence) throw new Error("Portable input fence evidence is unavailable.");
  if (command.nonce !== config.nonce || typeof command.ownerId !== "string" || !Number.isSafeInteger(command.fencingToken) || command.fencingToken < 1 || command.sequence !== handledInput + 1)
    throw new Error("Portable input command identity is invalid.");
  let bytes;
  if (command.type === "write") {
    bytes = Buffer.from(command.bytes, "base64");
    if (bytes.byteLength !== command.byteLength || createHash("sha256").update(bytes).digest("hex") !== command.digest)
      throw new Error("Portable input command payload is invalid.");
  } else if (command.type !== "close_input" && command.type !== "graceful_stop") {
    throw new Error("Portable input command type is invalid.");
  }
  if (command.ownerId !== fence.ownerId || command.fencingToken !== fence.fencingToken) {
    withCurrentFenceEffect(fence.ownerId, fence.fencingToken, () => {
      publishChannelInputAck(command, "failed", "stale_fence");
      unlinkSync(path);
      handledInput = command.sequence;
    });
    return;
  }
  if (command.type === "write") {
    withCurrentFenceEffect(command.ownerId, command.fencingToken, () => {
      if (child.stdin.destroyed || !child.stdin.writable) publishChannelInputAck(command, "failed");
      else { child.stdin.write(bytes); publishChannelInputAck(command, "acknowledged"); }
    });
  } else if (command.type === "close_input") {
    withCurrentFenceEffect(command.ownerId, command.fencingToken, () => child.stdin.end(() => {
      try { withCurrentFenceEffect(command.ownerId, command.fencingToken, () => publishChannelInputAck(command, "acknowledged")); } catch {}
    }));
  } else if (command.type === "graceful_stop") {
    withCurrentFenceEffect(command.ownerId, command.fencingToken, () => {
      writeAtomic(controlPath, JSON.stringify({ nonce: config.nonce, ownerId: command.ownerId, fencingToken: command.fencingToken, sequence: handledControl + 1, action: "terminate" }));
      publishChannelInputAck(command, "acknowledged");
    });
  } else return;
  handledInput = command.sequence;
  try { unlinkSync(path); } catch {}
}

function readCurrentFence() {
  try {
    const value = JSON.parse(readFileSync(fencePath, "utf8"));
    return value.nonce === config.nonce && typeof value.ownerId === "string" && Number.isSafeInteger(value.fencingToken)
      ? value : undefined;
  } catch { return undefined; }
}

function publishChannelInputAck(command, status, reason) {
  writeAtomic(join(channelAckDirectory, `input-${String(command.sequence).padStart(12, "0")}.json`), JSON.stringify({ nonce: config.nonce, ownerId: command.ownerId, fencingToken: command.fencingToken, sequence: command.sequence, status, ...(reason ? { reason } : {}) }));
}

function withCurrentFenceEffect(ownerId, fencingToken, effect) {
  const lock = `${config.directory}.fence.lock`;
  try {
    const holder = JSON.parse(readFileSync(lockHolderPath, "utf8"));
    if (holder.nonce !== config.nonce || holder.holderPid !== process.pid || typeof holder.holderBirth !== "string" || !holder.holderBirth)
      throw new Error("Portable fence holder identity is invalid.");
    return withOwnedFenceLockSync(lock, () => {
      const fence = readCurrentFence();
      if (!fence || fence.ownerId !== ownerId || fence.fencingToken !== fencingToken) throw new Error("Portable fence is stale at the effect boundary.");
      return effect();
    }, { holderPid: holder.holderPid, holderBirth: holder.holderBirth });
  } catch (error) { throw new Error(`Portable fence effect boundary is unavailable: ${String(error)}`, { cause: error }); }
}

function writeAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, value);
  replaceState(temporary, destination);
}

function waitForChildStartup(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(childStatusPath, "utf8")); } catch {}
    Atomics.wait(waiter, 0, 0, 10);
  }
  return undefined;
}

function handleControl() {
  if (!existsSync(controlPath)) return;
  const request = JSON.parse(readFileSync(controlPath, "utf8"));
  if (request.nonce !== config.nonce || request.sequence <= handledControl) return;
  const currentFence = readCurrentFence();
  if (!currentFence || request.ownerId !== currentFence.ownerId || request.fencingToken !== currentFence.fencingToken) return;
  handledControl = request.sequence;
  if (config.platform === "windows") {
    refreshWindowsTree();
    if (ownershipMismatch || ownershipInspectionUnknown) {
      controlInspectionUnknown = true;
      publish("outcome_unknown", ownershipInspectionDetail || "Refused to signal a recycled Windows descendant PID.");
      return;
    }
    const roots = [];
    for (const [pid, birth] of knownProcesses) {
      const inspection = inspectWindowsBirth(pid);
      if (inspection.state === "unknown") {
        publish("outcome_unknown", "Refused to signal because Windows process inspection is unavailable.");
        return;
      }
      if (inspection.state === "present" && sameBirth(inspection.fingerprint, birth)) roots.push(pid);
    }
    const live = new Set(roots);
    const treeRoots = roots.filter((pid) => !live.has(lastWindowsParents?.get(pid)));
    const failure = withCurrentFenceEffect(request.ownerId, request.fencingToken, () => {
      const configuredTaskkill = config.windowsTaskkill;
      const command = typeof configuredTaskkill?.command === "string" ? configuredTaskkill.command : "taskkill.exe";
      const prefix = Array.isArray(configuredTaskkill?.arguments) ? configuredTaskkill.arguments.map(String) : [];
      const deadlineMs = configuredDeadline(configuredTaskkill);
      for (const pid of treeRoots) {
        const result = spawnSync(command, [...prefix, "/PID", String(pid), "/T", ...(request.action === "force_terminate" ? ["/F"] : [])], {
          windowsHide: true,
          stdio: "ignore",
          timeout: deadlineMs,
        });
        if (result.status !== 0 || result.error) return result.error?.message ?? `taskkill exited ${result.status}`;
      }
      return undefined;
    });
    if (failure) {
      windowsTreeFailures += 1;
      ownershipInspectionUnknown = true;
      controlInspectionUnknown = true;
      ownershipInspectionDetail = `Windows taskkill control was uncertain: ${failure}`;
      publish("outcome_unknown", ownershipInspectionDetail);
      return;
    }
  } else {
    withCurrentFenceEffect(request.ownerId, request.fencingToken, () => signalOwnedPosixGroup(request.action));
  }
  const active = activeOwnedPids();
  publish(active === undefined ? "outcome_unknown" : active.length === 0 ? "stopped" : "running");
}

const WINDOWS_TREE_SCRIPT = "$ErrorActionPreference='Stop';Get-CimInstance Win32_Process|ForEach-Object{\"$($_.ProcessId),$($_.ParentProcessId),$($_.CreationDate.ToUniversalTime().ToString('o'))\"}";

function requestWindowsTreeRefresh() {
  if (windowsTreeRefreshInFlight) return;
  const now = Date.now();
  const gap = now - lastWindowsTreeRefreshFinishedAt;
  if (gap < WINDOWS_TREE_REFRESH_INTERVAL_MS) return;
  if (Number.isFinite(gap)) windowsTreeRefreshMinimumGapMs = windowsTreeRefreshMinimumGapMs === null ? gap : Math.min(windowsTreeRefreshMinimumGapMs, gap);
  windowsTreeRefreshCount += 1;
  windowsTreeRefreshInFlight = true;
  const configuredInspector = config.windowsTreeInspector;
  const inspectorCommand = typeof configuredInspector?.command === "string" ? configuredInspector.command : "powershell.exe";
  const inspectorArguments = Array.isArray(configuredInspector?.arguments)
    ? configuredInspector.arguments.map(String)
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_SCRIPT];
  const inspectorDeadlineMs = Number.isSafeInteger(configuredInspector?.deadlineMs) && configuredInspector.deadlineMs > 0
    ? configuredInspector.deadlineMs
    : WINDOWS_TREE_INSPECTION_DEADLINE_MS;
  const inspector = spawn(inspectorCommand, inspectorArguments, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  let inspectionError;
  let finished = false;
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    windowsTreeRefreshInFlight = false;
    acceptWindowsTreeResult(code, error ?? inspectionError, Buffer.concat(stdout).toString("utf8"));
    lastWindowsTreeRefreshFinishedAt = Date.now();
  };
  const watchdog = setTimeout(() => {
    const error = new Error(`Windows process inventory watchdog timed out after ${inspectorDeadlineMs}ms.`);
    try { inspector.kill("SIGKILL"); } catch {}
    finish(null, error);
  }, inspectorDeadlineMs);
  watchdog.unref?.();
  inspector.stdout.on("data", (bytes) => stdout.push(Buffer.from(bytes)));
  inspector.once("error", (error) => { inspectionError = error; });
  inspector.once("close", (code) => finish(code, inspectionError));
}

function refreshWindowsTree() {
  const configuredInspector = config.windowsControlInspector ?? config.windowsTreeInspector;
  const inspectorCommand = typeof configuredInspector?.command === "string" ? configuredInspector.command : "powershell.exe";
  const inspectorArguments = Array.isArray(configuredInspector?.arguments)
    ? configuredInspector.arguments.map(String)
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_SCRIPT];
  const result = spawnSync(inspectorCommand, inspectorArguments, {
    encoding: "utf8",
    windowsHide: true,
    timeout: configuredDeadline(configuredInspector),
  });
  acceptWindowsTreeResult(result.status, result.error, String(result.stdout));
}

function configuredDeadline(configuredOperation) {
  return Number.isSafeInteger(configuredOperation?.deadlineMs) && configuredOperation.deadlineMs > 0
    ? configuredOperation.deadlineMs
    : WINDOWS_TREE_INSPECTION_DEADLINE_MS;
}

function acceptWindowsTreeResult(status, error, stdout) {
  if (status !== 0 || error) {
    windowsTreeFailures += 1;
    ownershipInspectionUnknown = true;
    ownershipInspectionDetail = `Windows process inventory inspection failed: ${error?.message ?? `PowerShell exited ${status}`}`;
    return;
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    windowsTreeFailures += 1;
    ownershipInspectionUnknown = true;
    ownershipInspectionDetail = "Windows process inventory was empty.";
    return;
  }
  const rows = lines.map((line) => {
    const [pid, parent, birth] = line.split(",");
    return { pid: Number(pid), parent: Number(parent), birth: normalizeBirth(birth) };
  });
  if (rows.some(({ pid, parent, birth }) => !(pid >= 0 && parent >= 0 && birth))) {
    windowsTreeFailures += 1;
    ownershipInspectionUnknown = true;
    ownershipInspectionDetail = `malformed row: ${lines.find((line) => {
      const [pid, parent, birth] = line.split(",");
      return !(Number(pid) >= 0 && Number(parent) >= 0 && birth);
    }) ?? "unknown"}`;
    return;
  }
  ownershipInspectionUnknown = false;
  ownershipInspectionDetail = "";
  windowsTreeFailures = 0;
  const current = new Map(rows.map(({ pid, birth }) => [pid, birth]));
  lastWindowsProcesses = current;
  lastWindowsParents = new Map(rows.map(({ pid, parent }) => [pid, parent]));
  for (const [pid, birth] of knownProcesses) {
    const observed = current.get(pid);
    if (observed && !sameBirth(observed, birth)) ownershipMismatch = true;
  }
  const owned = new Set(knownProcesses.keys());
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pid, parent } of rows) {
      if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  for (const pid of owned) {
    const birth = current.get(pid);
    if (birth) knownProcesses.set(pid, birth);
  }
}

function activeOwnedPids() {
  if (config.platform === "posix") {
    const result = spawnSync("ps", ["-e", "-o", "pid=,pgid="], { encoding: "utf8", timeout: 2_000 });
    if (result.status !== 0 || result.error) return undefined;
    return String(result.stdout).split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, pgid]) => pgid === process.pid)
      .map(([pid]) => pid)
      .filter((pid) => pid > 0 && pid !== process.pid && isAlive(pid));
  }
  if (!lastWindowsProcesses) return undefined;
  const active = [];
  for (const [pid, birth] of knownProcesses) {
    const observed = lastWindowsProcesses.get(pid);
    if (observed && sameBirth(observed, birth)) active.push(pid);
  }
  return active;
}

function inspectWindowsBirth(pid) {
  const script = `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){'ABSENT'}else{'PRESENT:'+$p.StartTime.ToUniversalTime().ToString('o')}`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 2000 });
  if (result.status !== 0 || result.error) return { state: "unknown" };
  const value = String(result.stdout).trim();
  if (value === "ABSENT") return { state: "absent" };
  if (value.startsWith("PRESENT:") && value.length > "PRESENT:".length)
    return { state: "present", fingerprint: normalizeBirth(value.slice("PRESENT:".length)) };
  return { state: "unknown" };
}

function normalizeBirth(value) {
  return String(value).replace(/(\.\d{6})\d+(Z)$/, "$1$2");
}

function sameBirth(left, right) {
  return normalizeBirth(left) === normalizeBirth(right);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function publish(status, error = null) {
  const state = {
    protocol: "aiboard-portable-process/v1",
    nonce: config.nonce,
    supervisorPid: process.pid,
    launchEffect,
    rootProcess,
    revision: ++revision,
    handledControl,
    status,
    exitCode: targetExitCode,
    signal: targetSignal,
    knownProcesses: [...knownProcesses].map(([pid, birth]) => ({ pid, birth })),
    windowsTreeRefreshCount,
    windowsTreeRefreshMinimumGapMs,
    windowsTreeFailures,
    error,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  replaceState(temporary, statePath);
}

function replaceState(temporary, destination) {
  const deadline = Date.now() + 1_000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      renameSync(temporary, destination);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) throw error;
      Atomics.wait(waiter, 0, 0, 10);
    }
  }
}

function fail(message, status = "outcome_unknown") {
  try { publish(status, message); } finally { process.exit(1); }
}
