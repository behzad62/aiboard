import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const statePath = join(config.directory, "state.json");
const controlPath = join(config.directory, "control.json");
const stdoutPath = join(config.directory, "stdout.log");
const stderrPath = join(config.directory, "stderr.log");
const childGoPath = join(config.directory, "child-go");
const childStatusPath = join(config.directory, "child-status.json");
let revision = 0;
let handledControl = 0;
let targetExited = false;
let targetExitCode = null;
let targetSignal = null;
const knownProcesses = new Map();
let ownershipMismatch = false;
let ownershipInspectionUnknown = false;
let ownershipInspectionDetail = "";
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
      stdio: ["ignore", "pipe", "pipe"],
    })
  : spawn(config.executable, config.arguments, {
  cwd: config.workingDirectory,
  env: config.environment,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
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
child.stdout.on("data", (chunk) => appendFileSync(stdoutPath, chunk));
child.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk));
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
    if (launchEffect === "unknown") {
      publish("outcome_unknown", "Initial Windows process identity was not captured before discovery.");
      return;
    }
    if (config.platform === "windows") refreshWindowsTree();
    if (ownershipInspectionUnknown) {
      publish("outcome_unknown", `Owned Windows process inspection is unavailable: ${ownershipInspectionDetail}`);
      return;
    }
    if (ownershipMismatch) {
      publish("outcome_unknown", "Owned Windows descendant birth identity changed.");
      return;
    }
    handleControl();
    const active = activeOwnedPids();
    if (active === undefined) {
      publish("outcome_unknown", "Owned process membership inspection is unavailable.");
      return;
    }
    if (targetExited && active.length === 0) {
      publish("stopped");
      clearInterval(timer);
      process.exit(0);
    }
    publish("running");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
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
  handledControl = request.sequence;
  if (config.platform === "windows") {
    refreshWindowsTree();
    if (ownershipMismatch) {
      publish("outcome_unknown", "Refused to signal a recycled Windows descendant PID.");
      return;
    }
    const roots = [];
    for (const [pid, birth] of knownProcesses) {
      const inspection = inspectWindowsBirth(pid);
      if (inspection.state === "unknown") {
        publish("outcome_unknown", "Refused to signal because Windows process inspection is unavailable.");
        return;
      }
      if (inspection.state === "present" && inspection.fingerprint === birth) roots.push(pid);
    }
    for (const pid of roots) {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", ...(request.action === "force_terminate" ? ["/F"] : [])], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
  }
  const active = activeOwnedPids();
  publish(active === undefined ? "outcome_unknown" : active.length === 0 ? "stopped" : "running");
}

function refreshWindowsTree() {
  const script = "$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process|ForEach-Object{\"$($_.ProcessId),$($_.ParentProcessId),$($_.CreationDate.ToUniversalTime().ToString('o'))\"}";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    ownershipInspectionUnknown = true;
    ownershipInspectionDetail = result.error?.message ?? `PowerShell exited ${result.status}`;
    return;
  }
  const lines = String(result.stdout).split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows = lines.map((line) => {
    const [pid, parent, birth] = line.split(",");
    return { pid: Number(pid), parent: Number(parent), birth };
  });
  if (rows.some(({ pid, parent, birth }) => !(pid >= 0 && parent >= 0 && birth))) {
    ownershipInspectionUnknown = true;
    ownershipInspectionDetail = `malformed row: ${lines.find((line) => {
      const [pid, parent, birth] = line.split(",");
      return !(Number(pid) >= 0 && Number(parent) >= 0 && birth);
    }) ?? "unknown"}`;
    return;
  }
  ownershipInspectionUnknown = false;
  ownershipInspectionDetail = "";
  const current = new Map(rows.map(({ pid, birth }) => [pid, birth]));
  for (const [pid, birth] of knownProcesses) {
    const observed = current.get(pid);
    if (observed && observed !== birth) ownershipMismatch = true;
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
    const result = spawnSync("ps", ["-e", "-o", "pid=,pgid="], { encoding: "utf8" });
    if (result.status !== 0 || result.error) return undefined;
    return String(result.stdout).split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, pgid]) => pgid === process.pid)
      .map(([pid]) => pid)
      .filter((pid) => pid > 0 && pid !== process.pid && isAlive(pid));
  }
  const active = [];
  for (const [pid, birth] of knownProcesses) {
    const inspection = inspectWindowsBirth(pid);
    if (inspection.state === "unknown") return undefined;
    if (inspection.state === "present" && inspection.fingerprint === birth) active.push(pid);
  }
  return active;
}

function inspectWindowsBirth(pid) {
  const script = `$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";if($null -eq $p){'ABSENT'}else{'PRESENT:'+$p.CreationDate.ToUniversalTime().ToString('o')}`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 2000 });
  if (result.status !== 0 || result.error) return { state: "unknown" };
  const value = String(result.stdout).trim();
  if (value === "ABSENT") return { state: "absent" };
  if (value.startsWith("PRESENT:") && value.length > "PRESENT:".length)
    return { state: "present", fingerprint: value.slice("PRESENT:".length) };
  return { state: "unknown" };
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
    error,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, statePath);
}

function fail(message, status = "outcome_unknown") {
  try { publish(status, message); } finally { process.exit(1); }
}
