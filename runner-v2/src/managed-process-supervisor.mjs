import { spawn } from "node:child_process";
// RUNNER_RAW_PROCESS_BOUNDARY: managed-process Windows Job bootstrap host; workload launch remains inside the owned supervisor lifecycle.
import { timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const PROTOCOL = "aiboard-managed-process/v1";
const MAX_STOP_DEADLINE_MS = 60_000;
const bootstrapProcessId = process.argv[2];
const bootstrapStatusPath = process.argv[3];
if (!bootstrapProcessId || !bootstrapStatusPath) {
  process.stderr.write("Managed process supervisor bootstrap arguments are missing.\n");
  process.exit(1);
}
let config;
let abortRequest;
// PX-2c spare state: true only between a spare reservation's backend spawn
// and its single claim. Never set for normal launches.
let spareUnclaimed = false;
let spareIdleTimer;
let backend;
let backendInput;
let childExitResolve;
let stopping = false;
let interactiveTerminationRequested = false;
let settled = false;
let backendFailure;
const retainedOutput = [];
const outputOffsets = { stdout: 0, stderr: 0 };
let interactiveStdoutEnded = false;
let interactiveStderrEnded = false;
let jobEventBytes = 0;
let jobEventTimer;
const childExited = new Promise((resolve) => {
  childExitResolve = resolve;
});

process.on("message", (message) => {
  // PX-2c: a pre-started spare is claimed over this same private IPC channel
  // from the runner (never HTTP: claiming creates the call's Job, which is
  // spawn authority). Any other message type is ignored fail-closed.
  if (message?.type === "claim") {
    void handleSpareClaim(message);
    return;
  }
  if (message?.type !== "abort") return;
  abortRequest = message;
  if (config) void abortStartup(message);
});

// PX-2c: parent death retires an UNCLAIMED spare only. The runner holds the
// IPC channel open for a spare (normal launches disconnect after their stdin
// handoff), so a broken channel means the owning runner is gone: kill the
// waiting Job host and exit, leaving no untracked process. Claimed spares
// and normal launches keep today's survive-for-adoption behavior.
process.on("disconnect", () => {
  if (isSpareConfig() && spareUnclaimed) void retireSpare("parent-dead");
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
  jobEmptyProof: false,
  terminationRequested: false,
  updatedAt: new Date().toISOString(),
};

function persistStatus() {
  status.updatedAt = new Date().toISOString();
  appendFileSync(bootstrapStatusPath, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  settleStatusWaiters();
}

// PX-2b: event-driven settlement waits. Every durable state change persists,
// so resolving parked /wait-status waiters on every persist cannot miss a
// change (a change that already landed reads as terminal immediately at the
// endpoint; a later change resolves the waiter). Spurious wakeups are
// harmless: the host re-polls and re-attests after every wakeup.
const statusWaiters = new Set();
function settleStatusWaiters() {
  if (statusWaiters.size === 0) return;
  const pending = [...statusWaiters];
  statusWaiters.clear();
  for (const finish of pending) finish();
}
function waitForStatusPersist(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      statusWaiters.delete(finish);
      clearTimeout(timer);
      resolve({ ...status });
    };
    const timer = setTimeout(finish, timeoutMs);
    statusWaiters.add(finish);
  });
}
function parseWaitStatusTimeout(url) {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const timeoutMs = Number(new URLSearchParams(query).get("timeoutMs"));
  if (!Number.isSafeInteger(timeoutMs)) return 1_000;
  return Math.min(5_000, Math.max(1, timeoutMs));
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
  // PX-2c: a spare reserves the supervisor plus the Job host with no Job and
  // no child. It always runs the interactive backend (the production path);
  // its call's command arrives later over the private IPC claim, never HTTP.
  if (config.spare === true) config.interactive = true;
  appendFileSync(config.stdoutPath, "", { mode: 0o600 });
  appendFileSync(config.stderrPath, "", { mode: 0o600 });
  status.retainedOutputChunks = 0;
  status.retainedOutputBytes = 0;
  persistStatus();
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

async function readJson(request, maximumBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("Request body is too large.");
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
  if (request.method === "GET" && (request.url === "/wait-status" || request.url.startsWith("/wait-status?"))) {
    // PX-2b: event-driven settlement. Terminal state is final, so a change
    // that already landed returns immediately (no lost wakeup); otherwise the
    // response parks until the next persist or the bounded timeout. Callers
    // re-poll and re-attest after every return, and every existing deadline
    // stays armed as the backstop.
    const timeoutMs = parseWaitStatusTimeout(request.url);
    if (status.status === "stopped" || status.status === "exited_unknown") {
      json(response, 200, status);
      return;
    }
    const next = await waitForStatusPersist(timeoutMs);
    json(response, 200, next);
    return;
  }
  // PX-2c: an unclaimed spare has no call: only status waits may observe it.
  // Anything that would mutate or signal fails closed until the IPC claim.
  if (spareUnclaimed && request.method === "POST") {
    json(response, 409, { error: "spare_unclaimed" });
    return;
  }
  if (request.method === "POST" && request.url === "/write") {
    try {
      const maxInputBytes = Number.isSafeInteger(config.maxInputBytes) && config.maxInputBytes > 0 ? config.maxInputBytes : 1024 * 1024;
      const body = await readJson(request, 4 * Math.ceil(maxInputBytes / 3) + 4096);
      if (!config.interactive || !backendInput || backendInput.destroyed || typeof body.payload !== "string") {
        json(response, 409, { error: "input_unavailable" });
        return;
      }
      assertCurrentRequestFence(body.fence);
      const payload = Buffer.from(body.payload, "base64");
      if (payload.byteLength > maxInputBytes) {
        json(response, 413, { error: "input_too_large" });
        return;
      }
      await new Promise((resolve, reject) => backendInput.write(payload, (error) => error ? reject(error) : resolve()));
      json(response, 200, { acknowledged: true, sequence: body.sequence });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method === "POST" && request.url === "/close-input") {
    try {
      const body = await readJson(request);
      assertCurrentRequestFence(body.fence);
      if (!config.interactive || !backendInput || backendInput.destroyed) {
        json(response, 409, { error: "input_unavailable" });
        return;
      }
      backendInput.end();
      json(response, 200, { acknowledged: true });
    } catch (error) { json(response, 409, { error: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if (request.method === "POST" && request.url === "/ack-output") {
    try {
      const body = await readJson(request);
      assertCurrentRequestFence(body.fence);
      const matching = retainedOutput.filter((entry) => entry.stream === body.stream && entry.endOffset <= body.endOffset);
      const entry = matching.at(-1);
      if (!entry || entry.endOffset !== body.endOffset || matching.some((candidate, index) => index > 0 && candidate.startOffset !== matching[index - 1].endOffset)) {
        json(response, 409, { error: "output_acknowledgement_mismatch", requested: { stream: body.stream, endOffset: body.endOffset }, expected: entry ? { stream: entry.stream, endOffset: entry.endOffset } : null });
        return;
      }
      for (let index = retainedOutput.length - 1; index >= 0; index -= 1) {
        const candidate = retainedOutput[index];
        if (candidate.stream === body.stream && candidate.endOffset <= body.endOffset) retainedOutput.splice(index, 1);
      }
      publishRetainedOutputStatus();
      drainInteractiveOutput("stdout", backend?.stdout);
      drainInteractiveOutput("stderr", backend?.stderr);
      // If this was the final retained chunk, persist exact terminal proof
      // before the acknowledgement lets the host begin re-attestation.
      tryMarkStopped();
      json(response, 200, { acknowledged: true, stream: body.stream, endOffset: body.endOffset, status });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (request.method !== "POST" || request.url !== "/signal") {
    json(response, 404, { error: "not_found" });
    return;
  }
  try {
    const body = await readJson(request);
    assertCurrentRequestFence(body.fence);
    if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(body.signal)) {
      json(response, 400, { error: "invalid_signal" });
      return;
    }
    await stopOwnedTree(body.signal, Number(body.deadlineMs) || config.stopDeadlineMs);
    json(response, 200, status);
    if (status.status === "stopped") server.close(() => process.exit(0));
    else stopping = false;
  } catch (error) {
    stopping = false;
    tryMarkStopped();
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

function isSpareConfig() {
  return Boolean(config) && config.spare === true;
}

// The Job-config object the powershell host consumes on its stdin: byte for
// byte the normal launch shape, so a claimed spare runs exactly like a fresh
// launch from the Job host's point of view.
function currentJobConfiguration() {
  return {
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: config.env,
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    eventPath: config.eventPath,
    helperAssemblyPath: config.helperAssemblyPath,
    helperAssemblySha256: config.helperAssemblySha256,
  };
}

function spareClaimTokenMatches(supplied) {
  if (typeof supplied !== "string" || typeof config?.token !== "string") return false;
  const presented = Buffer.from(supplied);
  const expected = Buffer.from(config.token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

// PX-2c: claim the spare for exactly one call. The runner sends the call over
// the private IPC channel; the supervisor fills its reserved config and hands
// the waiting Job host the call. A second claim is rejected: a spare serves
// exactly one call and is never reused.
async function handleSpareClaim(message) {
  const reply = (ok, error) => {
    try {
      process.send?.({ type: "claim_ack", token: typeof message?.token === "string" ? message.token : null, ok, ...(error ? { error } : {}) });
    } catch {}
  };
  try {
    if (!isSpareConfig() || !spareUnclaimed) {
      reply(false, "not_spare_or_already_claimed");
      return;
    }
    if (!spareClaimTokenMatches(message?.token)) {
      reply(false, "claim_identity_mismatch");
      return;
    }
    const job = message?.job;
    if (!job || typeof job.command !== "string" || job.command.length === 0 ||
        !Array.isArray(job.args) || typeof job.cwd !== "string" || job.cwd.length === 0 ||
        !job.env || typeof job.env !== "object") {
      reply(false, "claim_job_invalid");
      return;
    }
    if (!backend || backend.exitCode !== null || backend.signalCode !== null || !backendInput || backendInput.destroyed) {
      reply(false, "claim_backend_unavailable");
      return;
    }
    clearTimeout(spareIdleTimer);
    spareIdleTimer = undefined;
    config.command = job.command;
    config.args = [...job.args];
    config.cwd = job.cwd;
    config.env = { ...job.env };
    config.interactive = true;
    spareUnclaimed = false;
    status.claimed = true;
    status.spareReady = false;
    persistStatus();
    const line = `${JSON.stringify({ encoding: "base64-utf8-json", payload: Buffer.from(JSON.stringify(currentJobConfiguration())).toString("base64") })}\n`;
    await new Promise((resolvePromise, reject) => backendInput.write(line, (error) => error ? reject(error) : resolvePromise()));
    reply(true);
  } catch (error) {
    reply(false, error instanceof Error ? error.message : String(error));
  }
}

function armSpareIdleTimer() {
  clearTimeout(spareIdleTimer);
  const configured = config?.spareIdleTimeoutMs;
  const idleMs = Number.isSafeInteger(configured) ? Math.min(300_000, Math.max(1_000, configured)) : 60_000;
  spareIdleTimer = setTimeout(() => {
    if (isSpareConfig() && spareUnclaimed) void retireSpare("idle-timeout");
  }, idleMs);
  spareIdleTimer.unref?.();
}

// PX-2c: retire an unclaimed spare without ever launching a call: kill the
// waiting Job host, record why, and exit. Parent death, idle timeout, and
// run-end/abort share this path; crash recovery never relaunches from it.
function retireSpare(reason) {
  if (!isSpareConfig() || !spareUnclaimed) return;
  clearTimeout(spareIdleTimer);
  spareIdleTimer = undefined;
  spareUnclaimed = false;
  try {
    backend?.kill("SIGKILL");
  } catch {}
  if (!settled) {
    status.status = "stopped";
    status.error = `Spare retired without a call (${reason}).`;
    status.ownershipReleased = true;
    status.spareRetired = reason;
    persistStatus();
  }
  try {
    server.close(() => process.exit(0));
  } catch {}
  setTimeout(() => process.exit(0), 250).unref?.();
}

function assertCurrentRequestFence(candidate) {
  if (!config.recordPath && candidate === undefined) return;
  const record = JSON.parse(readFileSync(config.recordPath, "utf8"));
  const current = record.currentFence;
  if (!candidate || !current || candidate.ownerId !== current.ownerId || candidate.fencingToken !== current.fencingToken)
    throw new Error("Windows Job writer fence is stale at the supervisor effect boundary.");
}

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
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...(config.interactive ? ["--aiboard-lsp-pipe"] : [])],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }
  );
  backendInput = backend.stdin;
  // A failed/terminated child emits a stream error in addition to invoking the
  // outstanding write callback. That callback owns the input failure; the
  // event must not crash this supervisor before exact Job/output cleanup is
  // attested. Input failure alone is never no-launch or terminal proof.
  backendInput.on("error", () => {});
  if (config.interactive) {
    backend.stdout.on("readable", () => drainInteractiveOutput("stdout", backend.stdout));
    backend.stderr.on("readable", () => drainInteractiveOutput("stderr", backend.stderr));
    backend.stdout.once("end", () => { interactiveStdoutEnded = true; tryMarkStopped(); });
    backend.stderr.once("end", () => { interactiveStderrEnded = true; tryMarkStopped(); });
    jobEventTimer = setInterval(pollInteractiveJobEvents, 10);
  } else {
    backend.stderr.on("data", (chunk) => appendFileSync(config.stderrPath, chunk));
    const lines = createInterface({ input: backend.stdout });
    lines.on("line", (line) => handleJobEvent(line));
  }
  backend.once("error", (error) => startupFailed(error));
  backend.once("exit", () => {
    // Process exit closes the Job host's kill-on-close handle even if bounded
    // retained output keeps stdio pending. That is the exact empty proof.
    status.jobEmptyProof = true;
  });
  backend.once("close", (exitCode) => {
    if (config.interactive) pollInteractiveJobEvents();
    backendInput = undefined;
    if (settled) return;
    if (backendFailure) {
      startupFailed(backendFailure);
      return;
    }
    if (status.jobEmptyProof) {
      tryMarkStopped();
      return;
    }
    status.exitCode = exitCode;
    markOwnershipUncertain("Windows Job Object host closed before proving the job empty.");
  });
  // PX-2c note: this literal is intentionally inline (not the shared
  // currentJobConfiguration() below): windows-job-supervisor-input.test.ts
  // slices this function body into a VM. Keep the two shapes identical.
  const jobConfiguration = {
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: config.env,
    stdoutPath: config.stdoutPath,
    stderrPath: config.stderrPath,
    eventPath: config.eventPath,
    helperAssemblyPath: config.helperAssemblyPath,
    helperAssemblySha256: config.helperAssemblySha256,
  };
  if (config.spare === true) {
    // PX-2c: the Job host has booted, parsed, and compiled its helper, and now
    // blocks on its stdin with NO Job and NO child until the runner's IPC
    // claim delivers the call. Holding the write keeps spawn authority on the
    // existing private channel; HTTP can only observe until the claim lands.
    spareUnclaimed = true;
    status.spare = true;
    status.claimed = false;
    status.spareReady = true;
    persistStatus();
    armSpareIdleTimer();
  } else {
    backendInput.write(config.interactive
      ? `${JSON.stringify({ encoding: "base64-utf8-json", payload: Buffer.from(JSON.stringify(jobConfiguration)).toString("base64") })}\n`
      : `${JSON.stringify(jobConfiguration)}\n`);
  }
}

function drainInteractiveOutput(stream, readable) {
  if (!config?.interactive || !readable || readable.destroyed) return;
  const maximumChunks = config.maxRetainedOutputChunks ?? 16;
  const maximumBytes = config.maxRetainedOutputBytes ?? 256 * 1024;
  const retainedBytes = retainedOutputByteLength();
  if (retainedOutputChunkCount() >= maximumChunks || retainedBytes >= maximumBytes) return;
  const maximumRead = Math.min(config.maxRetainedOutputChunkBytes ?? 16 * 1024, config.maxPollBytes ?? 256 * 1024, maximumBytes - retainedBytes);
  // Read the bounded bytes that are available now. Readable.read(n) returns
  // null while fewer than n bytes are buffered, which otherwise deadlocks
  // conversational protocols whose small response must arrive before the next
  // request (or before stdin closes).
  const availableRead = Math.min(maximumRead, readable.readableLength);
  if (availableRead < 1) {
    // In paused/readable mode, a backpressure window can drain to zero while
    // libuv still has unread pipe bytes or EOF to surface. read(0) requests
    // another underlying read without consuming data, so exact stream-end
    // proof can arrive instead of leaving Job-empty cleanup latched forever.
    readable.read(0);
    return;
  }
  const chunk = readable.read(availableRead);
  if (!chunk) return;
  retainInteractiveOutput(stream, chunk);
  if (retainedOutputChunkCount() < maximumChunks && retainedOutputByteLength() < maximumBytes)
    queueMicrotask(() => drainInteractiveOutput(stream, readable));
}

function retainInteractiveOutput(stream, chunk) {
  if (chunk.byteLength === 0) return;
  appendFileSync(stream === "stdout" ? config.stdoutPath : config.stderrPath, chunk);
  const startOffset = outputOffsets[stream];
  const endOffset = startOffset + chunk.byteLength;
  outputOffsets[stream] = endOffset;
  retainedOutput.push({ stream, startOffset, endOffset, byteLength: chunk.byteLength });
  publishRetainedOutputStatus();
}

function retainedOutputChunkCount() {
  return retainedOutput.length;
}

function retainedOutputByteLength() {
  return retainedOutput.reduce((total, entry) => total + entry.byteLength, 0);
}

function publishRetainedOutputStatus() {
  status.retainedOutputChunks = retainedOutput.length;
  status.retainedOutputBytes = retainedOutput.reduce((total, entry) => total + entry.byteLength, 0);
  persistStatus();
}

function tryMarkStopped() {
  if (!status.jobEmptyProof) return;
  if (config.interactive && (!interactiveStdoutEnded || !interactiveStderrEnded)) return;
  if (retainedOutput.length > 0) {
    if (status.status !== "exited_unknown" || status.error !== "Windows Job output remains unsettled after the job became empty.") {
      status.status = "exited_unknown";
      status.error = "Windows Job output remains unsettled after the job became empty.";
      status.ownershipReleased = false;
      persistStatus();
    }
    childExitResolve();
    return;
  }
  markStopped();
}

function pollInteractiveJobEvents() {
  if (!config?.eventPath || !existsSync(config.eventPath)) return;
  const bytes = readFileSync(config.eventPath);
  if (bytes.byteLength < jobEventBytes) return markOwnershipUncertain("Windows Job event evidence shrank unexpectedly.");
  if (bytes.byteLength === jobEventBytes) return;
  const suffix = bytes.subarray(jobEventBytes).toString("utf8");
  const lines = suffix.split(/\r?\n/);
  if (lines.at(-1) !== "") return;
  jobEventBytes = bytes.byteLength;
  for (const line of lines.slice(0, -1)) if (line) handleJobEvent(line);
  tryMarkStopped();
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
    status.jobEmptyProof = true;
    return;
  }
  if (event.type === "stopped") {
    status.jobEmptyProof = true;
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
  if (jobEventTimer) clearInterval(jobEventTimer);
  status.status = "stopped";
  // PX-2c: a retired spare already recorded why it never served a call; the
  // backend-exit race after its kill must not clear that reason.
  if (!status.spareRetired) status.error = null;
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
  if (jobEventTimer) clearInterval(jobEventTimer);
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
  const deadlineMs = Math.max(250, Math.min(MAX_STOP_DEADLINE_MS, requestedDeadline || config.stopDeadlineMs || MAX_STOP_DEADLINE_MS));
  if (config.interactive) {
    // The interactive host dedicates its stdin to the child. Its exact process
    // exit closes the kill-on-close Job handle; the exit listener records proof.
    if (!status.jobEmptyProof && !interactiveTerminationRequested) {
      interactiveTerminationRequested = true;
      status.terminationRequested = true;
      persistStatus();
      if (!backend.kill(signal === "SIGKILL" ? "SIGKILL" : "SIGTERM")) {
        interactiveTerminationRequested = false;
        status.terminationRequested = false;
        persistStatus();
        throw new Error("Interactive Windows Job termination request was not accepted.");
      }
    }
    if (!status.jobEmptyProof && retainedOutput.length === 0)
      await waitForExit(Math.min(250, deadlineMs));
    // Do not wait here while holding the host's fence-effect lock: retained
    // output acknowledgements need that lock to drain bounded stdio. Until the
    // exact Job-host exit listener publishes empty proof this remains running.
    return;
  }
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
