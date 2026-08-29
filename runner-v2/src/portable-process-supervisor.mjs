import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const statePath = join(config.directory, "state.json");
const controlPath = join(config.directory, "control.json");
const stdoutPath = join(config.directory, "stdout.log");
const stderrPath = join(config.directory, "stderr.log");
let revision = 0;
let handledControl = 0;
let targetExited = false;
let targetExitCode = null;
let targetSignal = null;
const knownProcesses = new Map();
let ownershipMismatch = false;

const child = spawn(config.executable, config.arguments, {
  cwd: config.workingDirectory,
  env: config.environment,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
if (!child.pid) fail("Owned process has no PID.");
child.stdout.on("data", (chunk) => appendFileSync(stdoutPath, chunk));
child.stderr.on("data", (chunk) => appendFileSync(stderrPath, chunk));
child.once("error", (error) => fail(error.message));
child.once("exit", (code, signal) => {
  targetExited = true;
  targetExitCode = code;
  targetSignal = signal;
  publish("running");
});
publish("running");

const timer = setInterval(tick, Math.max(10, config.pollIntervalMs ?? 25));
process.stdin.resume();
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

function tick() {
  try {
    if (config.platform === "windows") refreshWindowsTree();
    if (ownershipMismatch) {
      publish("outcome_unknown", "Owned Windows descendant birth identity changed.");
      return;
    }
    handleControl();
    const active = activeOwnedPids();
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
    const roots = [...knownProcesses].filter(([pid, birth]) => currentWindowsBirth(pid) === birth).map(([pid]) => pid);
    for (const pid of roots) {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", ...(request.action === "force_terminate" ? ["/F"] : [])], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
  }
  publish(activeOwnedPids().length === 0 ? "stopped" : "running");
}

function refreshWindowsTree() {
  const script = "$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process|ForEach-Object{\"$($_.ProcessId),$($_.ParentProcessId),$($_.CreationDate.ToUniversalTime().ToString('o'))\"}";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return;
  const rows = String(result.stdout).split(/\r?\n/).map((line) => {
    const [pid, parent, birth] = line.split(",");
    return { pid: Number(pid), parent: Number(parent), birth };
  }).filter(({ pid, parent, birth }) => pid > 0 && parent >= 0 && birth);
  const current = new Map(rows.map(({ pid, birth }) => [pid, birth]));
  for (const [pid, birth] of knownProcesses) {
    const observed = current.get(pid);
    if (observed && observed !== birth) ownershipMismatch = true;
  }
  const owned = new Set([child.pid, ...knownProcesses.keys()]);
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
    if (result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([, pgid]) => pgid === process.pid)
      .map(([pid]) => pid)
      .filter((pid) => pid > 0 && pid !== process.pid && isAlive(pid));
  }
  return [...knownProcesses].filter(([pid, birth]) => currentWindowsBirth(pid) === birth).map(([pid]) => pid);
}

function currentWindowsBirth(pid) {
  const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue;if($p){$p.CreationDate.ToUniversalTime().ToString('o')}`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout).trim() || undefined : undefined;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function publish(status, error = null) {
  const state = {
    protocol: "aiboard-portable-process/v1",
    nonce: config.nonce,
    supervisorPid: process.pid,
    childPid: child.pid,
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

function fail(message) {
  try { publish("outcome_unknown", message); } finally { process.exit(1); }
}
