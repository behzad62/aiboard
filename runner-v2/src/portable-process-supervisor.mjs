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
const knownPids = new Set();

const child = spawn(config.executable, config.arguments, {
  cwd: config.workingDirectory,
  env: config.environment,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
if (!child.pid) fail("Owned process has no PID.");
knownPids.add(child.pid);
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
    const roots = [...knownPids].filter(isAlive);
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
  const script = "$ErrorActionPreference='SilentlyContinue';Get-CimInstance Win32_Process|ForEach-Object{\"$($_.ProcessId),$($_.ParentProcessId)\"}";
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return;
  const rows = String(result.stdout).split(/\r?\n/).map((line) => line.split(",").map(Number)).filter(([pid, parent]) => pid > 0 && parent >= 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (knownPids.has(parent) && !knownPids.has(pid)) {
        knownPids.add(pid);
        changed = true;
      }
    }
  }
}

function activeOwnedPids() {
  if (config.platform === "posix") {
    const result = spawnSync("ps", ["-o", "pid=", "-g", String(process.pid)], { encoding: "utf8" });
    if (result.status !== 0) return [];
    return String(result.stdout).split(/\s+/).map(Number).filter((pid) => pid > 0 && pid !== process.pid && isAlive(pid));
  }
  return [...knownPids].filter(isAlive);
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
    knownPids: [...knownPids],
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
