import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const PROTOCOL = "aiboard-managed-process/v1";
const bootstrapProcessId = process.argv[2];
const bootstrapStatusPath = process.argv[3];
if (!bootstrapProcessId || !bootstrapStatusPath) {
  process.stderr.write("Managed process supervisor bootstrap arguments are missing.\n");
  process.exit(1);
}
let config;
let abortRequest;
let backend;
let backendInput;
let childExitResolve;
let stopping = false;
let settled = false;
let jobEmptyProof = false;
let backendFailure;
const childExited = new Promise((resolve) => {
  childExitResolve = resolve;
});

process.on("message", (message) => {
  if (message?.type !== "abort") return;
  abortRequest = message;
  if (config) void abortStartup(message);
});

const status = {
  protocol: PROTOCOL,
  processId: bootstrapProcessId,
  supervisorPid: process.pid,
  childPid: 0,
  port: 0,
  status: "starting",
  exitCode: null,
  signal: null,
  error: null,
  ownershipReleased: false,
  updatedAt: new Date().toISOString(),
};

function persistStatus() {
  status.updatedAt = new Date().toISOString();
  appendFileSync(bootstrapStatusPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
}

// Persist identity before reading configuration. If the Runner dies after it
// records this supervisor but before it can finish the stdin handoff, the
// supervisor can prove that no backend was launched and retire itself durably.
persistStatus();
try {
  const serialized = await readAllStdin();
  if (!serialized) throw new Error("Supervisor configuration pipe closed before delivery.");
  config = JSON.parse(serialized);
  if (
    config.processId !== bootstrapProcessId ||
    config.statusPath !== bootstrapStatusPath
  ) {
    throw new Error("Supervisor bootstrap identity did not match its configuration.");
  }
} catch (error) {
  status.status = "stopped";
  status.error = error instanceof Error ? error.message : String(error);
  status.ownershipReleased = true;
  persistStatus();
  process.exit(1);
}

function authorized(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(response, code, value) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (!authorized(request.headers.authorization)) {
    json(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method === "GET" && request.url === "/status") {
    json(response, 200, status);
    return;
  }
  if (request.method !== "POST" || request.url !== "/signal") {
    json(response, 404, { error: "not_found" });
    return;
  }
  try {
    const body = await readJson(request);
    if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(body.signal)) {
      json(response, 400, { error: "invalid_signal" });
      return;
    }
    await stopOwnedTree(body.signal, Number(body.deadlineMs) || config.stopDeadlineMs);
    json(response, 200, status);
    server.close(() => process.exit(0));
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.on("error", (error) => {
  status.status = "exited_unknown";
  status.error = error instanceof Error ? error.message : String(error);
  persistStatus();
  process.exitCode = 1;
});

persistStatus();
if (abortRequest) {
  await abortStartup(abortRequest);
} else {
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Supervisor did not bind TCP.");
    status.port = address.port;
    persistStatus();
    if (abortRequest) void abortStartup(abortRequest);
    else launchBackend();
  });
}

function launchBackend() {
  if (process.platform !== "win32") {
    startupFailed(new Error(
      "Background process containment is unavailable: Windows Job Objects are required."
    ));
    return;
  }
  launchWindowsJob();
}

function launchWindowsJob() {
  const script = join(dirname(fileURLToPath(import.meta.url)), "managed-process-job-host.ps1");
  backend = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }
  );
  backendInput = backend.stdin;
  backend.stderr.on("data", (chunk) => appendFileSync(config.stderrPath, chunk));
  const lines = createInterface({ input: backend.stdout });
  lines.on("line", (line) => handleJobEvent(line));
  backend.once("error", (error) => startupFailed(error));
  backend.once("close", (exitCode) => {
    backendInput = undefined;
    if (settled) return;
    if (jobEmptyProof) {
      markStopped();
      return;
    }
    if (backendFailure) {
      startupFailed(backendFailure);
      return;
    }
    status.exitCode = exitCode;
    markOwnershipUncertain("Windows Job Object host closed before proving the job empty.");
  });
  backendInput.write(`${JSON.stringify({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: config.env,
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
  })}\n`);
}

function handleJobEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    appendFileSync(config.stderrPath, `Invalid Job host event: ${line}\n`);
    return;
  }
  if (event.type === "started") {
    markRunning(event.pid);
    return;
  }
  if (event.type === "root_exited") {
    status.exitCode = event.exitCode;
    status.status = "exited_unknown";
    status.error = "Launcher exited while Windows Job Object descendants remain active.";
    persistStatus();
    return;
  }
  if (event.type === "natural_stopped") {
    status.exitCode = event.exitCode;
    jobEmptyProof = true;
    return;
  }
  if (event.type === "stopped") {
    jobEmptyProof = true;
    return;
  }
  if (event.type === "error") {
    backendFailure = new Error(event.error ?? "Windows Job host failed.");
  }
}

function markRunning(pid) {
  status.childPid = pid ?? 0;
  status.status = "running";
  status.error = null;
  persistStatus();
}

function markStopped() {
  settled = true;
  status.status = "stopped";
  status.error = null;
  status.ownershipReleased = true;
  persistStatus();
  childExitResolve();
  if (!stopping) server.close(() => process.exit(0));
}

function markOwnershipUncertain(message) {
  status.status = "exited_unknown";
  status.error = message;
  persistStatus();
  childExitResolve();
}

function startupFailed(error) {
  if (settled) return;
  settled = true;
  status.status = "stopped";
  status.error = error instanceof Error ? error.message : String(error);
  status.ownershipReleased = true;
  persistStatus();
  childExitResolve();
  server.close(() => process.exit(1));
}

async function stopOwnedTree(signal, requestedDeadline) {
  if (status.status === "stopped") return;
  stopping = true;
  const deadlineMs = Math.max(250, Math.min(30_000, requestedDeadline || 5_000));
  if (!backendInput || backendInput.destroyed) {
    throw new Error("Windows Job Object control pipe is unavailable.");
  }
  backendInput.write(`${JSON.stringify({ signal, deadlineMs })}\n`);
  if (!(await waitForExit(deadlineMs))) {
    if (!(await waitForExit(Math.min(1_000, deadlineMs)))) {
      throw new Error("Managed process tree did not terminate before the deadline.");
    }
  }
  if (status.status !== "stopped") {
    throw new Error("Supervisor did not prove the managed process tree empty.");
  }
}

async function abortStartup(message) {
  if (!message || message.token !== config.token) return;
  try {
    if (status.port > 0 && backend) {
      await stopOwnedTree("SIGKILL", config.stopDeadlineMs);
    } else {
      stopping = true;
      settled = true;
      status.status = "stopped";
      status.error = "Supervisor startup aborted by its authenticated launcher.";
      status.ownershipReleased = true;
      persistStatus();
    }
    process.send?.({ type: "abort_ack", token: config.token, status: status.status });
  } finally {
    server.close(() => process.exit(0));
  }
}

async function waitForExit(timeoutMs) {
  if (status.status === "stopped") return true;
  return await Promise.race([
    childExited.then(() => status.status === "stopped"),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
