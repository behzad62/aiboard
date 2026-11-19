import { spawn } from "node:child_process";
// RUNNER_RAW_PROCESS_BOUNDARY: managed-process Windows Job bootstrap host; workload launch remains inside the owned supervisor lifecycle.
import { timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
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
// The last stdin write admitted over /write: { sequence, state: pending|acknowledged|failed, error, waiters }.
let pendingInput;
let childExitResolve;
let stopping = false;
let interactiveTerminationRequested = false;
let settled = false;
// A stop was requested before the host reported its workload started (the launcher aborted the start, or failed a
// claimed spare's start): the workload's output has no reader.
let startupAborted = false;
// The host reported its workload started (its started line).
let reportedStarted = false;
// The Assign path's suspended root (assign_pending: pid and creation time), until the host reports started. If the
// host dies first, that exact process is ended here (endRoot), never a process by its pid alone.
let pendingRoot = null;
// The Assign path's intent (assign_intent: the host's pid and creation time, and the time it was written), until the
// host reports started. If the host dies before it reported the root's identity, the root is the host's child created
// after that time and before the host's exit, and exactly that process is ended (endRoot).
let assignIntent = null;
let pendingRootEnd;
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
  // T1 CPU evidence is in-memory only: served by /status, never written to the durable status line.
  const { cpuTimeMs: _cpuTimeMs, cpuSampledAt: _cpuSampledAt, ...durable } = status;
  appendFileSync(bootstrapStatusPath, `${JSON.stringify(durable)}\n`, { mode: 0o600 });
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
  const raw = new URLSearchParams(query).get("timeoutMs");
  // PX-2b repair 1 (N6): a missing timeoutMs used to read as Number(null) =
  // 0, so the 1_000 default was dead and the wait parked 1 ms. Absent means
  // the default; a present value is still clamped to 1-5000 ms.
  if (raw === null) return 1_000;
  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs)) return 1_000;
  return Math.min(5_000, Math.max(1, timeoutMs));
}
/** A bounded park for one input settlement: 0-5000 ms, like /wait-status. A fractional wait is rounded down. */
function parseInputWait(raw) {
  const timeoutMs = Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(timeoutMs)) return 0;
  return Math.min(5_000, Math.max(0, Math.floor(timeoutMs)));
}
function settleInput(entry, error) {
  if (entry.state !== "pending") return;
  entry.state = error ? "failed" : "acknowledged";
  if (error) entry.error = error instanceof Error ? error.message : String(error);
  for (const wake of entry.waiters) wake();
  entry.waiters.clear();
}
function waitForInput(entry, timeoutMs) {
  if (entry.state !== "pending" || timeoutMs <= 0) return Promise.resolve(entry.state);
  return new Promise((resolve) => {
    const wake = () => { clearTimeout(timer); entry.waiters.delete(wake); resolve(entry.state); };
    const timer = setTimeout(wake, timeoutMs);
    entry.waiters.add(wake);
  });
}
function parseWaitStatusSince(url) {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const since = new URLSearchParams(query).get("since");
  return typeof since === "string" && since.length > 0 ? since : undefined;
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
    // PX-2b repair 1 (N2/N3): `since=<updatedAt>` returns at once on any
    // change after the caller's last seen state, not only terminal. An
    // already-stopped state returns at once (no lost wakeup: stopped is
    // final), while exited_unknown parks — the outcome there is still
    // unsettled. Otherwise the response parks until the next persist or the
    // bounded timeout. Callers re-poll and re-attest after every return, and
    // every existing deadline stays armed as the backstop.
    const timeoutMs = parseWaitStatusTimeout(request.url);
    const since = parseWaitStatusSince(request.url);
    if (since !== undefined && status.updatedAt !== since) {
      json(response, 200, status);
      return;
    }
    if (status.status === "stopped") {
      json(response, 200, status);
      return;
    }
    const next = await waitForStatusPersist(timeoutMs);
    json(response, 200, next);
    return;
  }
  if (request.method === "GET" && request.url.startsWith("/input-status?")) {
    // Observation only: the outcome of the one write this supervisor admitted under the writer
    // fence. It parks until that write settles or the bounded wait passes, and changes nothing.
    const query = new URLSearchParams(request.url.slice(request.url.indexOf("?") + 1));
    const sequence = Number(query.get("sequence"));
    const entry = pendingInput;
    if (!entry || entry.sequence !== sequence) {
      json(response, 409, { error: "input_sequence_unknown" });
      return;
    }
    const state = await waitForInput(entry, parseInputWait(query.get("timeoutMs")));
    json(response, 200, { sequence, state, ...(state === "failed" ? { error: entry.error } : {}) });
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
      if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) {
        json(response, 400, { error: "input_sequence_invalid" });
        return;
      }
      // One write at a time: a later write is never queued behind one still draining.
      if (pendingInput?.state === "pending") {
        json(response, 409, { error: "input_pending" });
        return;
      }
      // Sequences only grow: a sequence already admitted is never admitted again.
      if (pendingInput && body.sequence <= pendingInput.sequence) {
        json(response, 409, { error: "input_sequence_stale" });
        return;
      }
      assertCurrentRequestFence(body.fence);
      const payload = Buffer.from(body.payload, "base64");
      if (payload.byteLength > maxInputBytes) {
        json(response, 413, { error: "input_too_large" });
        return;
      }
      // Admission is fenced (the Runner holds its writer fence for this request); draining is not.
      // A reader that is slow to start holds the bytes in the pipe, and waiting for it under the
      // fence would also hold stop, output reads and output acknowledgements. So the reply comes
      // when the write settles or after a short admission wait, whichever is first; a write still
      // draining replies `pending`, and the Runner waits for it through /input-status, outside
      // its fence. The bytes are handed to the pipe exactly once either way.
      const entry = { sequence: body.sequence, state: "pending", error: undefined, waiters: new Set() };
      pendingInput = entry;
      try { backendInput.write(payload, (error) => settleInput(entry, error)); }
      catch (error) { settleInput(entry, error ?? new Error("Input write threw.")); }
      // A Runner that sends no ackWaitMs waits for the settlement here, within the clamp, as before this protocol.
      const state = await waitForInput(entry, parseInputWait(body.ackWaitMs ?? 5_000));
      // A write that failed after admission (the reader closed its stdin or exited) was handed to the pipe: the
      // sequence is spent, so the reply says it was admitted, never a plain error the Runner could read as a refusal.
      if (state === "failed") {
        json(response, 200, { acknowledged: false, failed: true, sequence: entry.sequence, error: entry.error });
        return;
      }
      json(response, 200, state === "acknowledged" ? { acknowledged: true, sequence: entry.sequence } : { acknowledged: false, pending: true, sequence: entry.sequence });
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
    ...(typeof config.injectedFault === "string" ? { injectedFault: config.injectedFault } : {}),
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

// PX-2c: retire an unclaimed spare without ever launching a call: terminate
// the waiting Job host, record why, and exit. Parent death, idle timeout, and
// run-end/abort share this path; crash recovery never relaunches from it.
async function retireSpare(reason) {
  if (!isSpareConfig() || !spareUnclaimed) return;
  clearTimeout(spareIdleTimer);
  spareIdleTimer = undefined;
  spareUnclaimed = false;
  // PX-2c repair 1 (B2): no direct backend kill here. stopOwnedTree owns the
  // single backend-kill site (allowlisted once); retirement still records its
  // reason and the supervisor still exits when the kill is refused or late.
  try {
    await stopOwnedTree("SIGKILL", config.stopDeadlineMs);
  } catch {}
  // Unconditional: the backend-exit listener may have marked us stopped
  // during the kill above. Either order must leave the retirement reason on
  // the durable status (markStopped preserves a recorded spareRetired).
  status.status = "stopped";
  if (!status.spareRetired) status.error = `Spare retired without a call (${reason}).`;
  status.ownershipReleased = true;
  status.spareRetired = reason;
  persistStatus();
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
    if (config.interactive) {
      pollInteractiveJobEvents();
      // A host that ended before its started line: its launcher stops waiting at once on this terminal, unproven
      // status (the stop recorded later, if proven, replaces it).
      if (!reportedStarted && !settled && !spareUnclaimed) {
        status.status = "exited_unknown";
        status.error = "The Windows Job host exited before it reported that its workload started.";
        persistStatus();
      }
      // The Assign path's root may still live outside the Job: the empty proof waits until that exact process is gone.
      // Its reported identity names it; before that report, the intent does (the host's child created after it).
      if ((pendingRoot || assignIntent) && !reportedStarted) {
        const root = pendingRoot ? { pid: pendingRoot.pid, creationTime: pendingRoot.creationTime }
          : { ...assignIntent, hostExitedAt: fileTimeNow() };
        pendingRootEnd = endRoot(root).then((ended) => {
          if (!ended) return;
          status.jobEmptyProof = true;
          tryMarkStopped();
        });
        return;
      }
    }
    // Process exit closes the Job host's kill-on-close handle even if bounded
    // retained output keeps stdio pending. That is the exact empty proof.
    status.jobEmptyProof = true;
  });
  backend.once("close", (exitCode) => {
    const closed = () => {
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
    };
    // Stricter-only test faults: the host's close reaches this supervisor late, as on a loaded host
    // (slow_start_late_close), or after its exit, as while a handle to its pipes is still held
    // (host_exit_after_create: the exit, not the close, must end the launcher's wait).
    if (config.injectedFault === "slow_start_late_close") setTimeout(closed, 1_000);
    else if (config.injectedFault === "host_exit_after_create") setTimeout(closed, 2_000);
    else closed();
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
    ...(typeof config.injectedFault === "string" ? { injectedFault: config.injectedFault } : {}),
  };
  if (config.spare === true) {
    // PX-2c: the supervisor (node) and the Job host (PowerShell) have booted
    // and now block on stdin with NO Job and NO child until the runner's IPC
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
  // An aborted start's output has no reader: every byte is read and dropped, past the retained bound too, so its
  // streams reach their end and the stop can be recorded.
  if (startupAborted) {
    let dropped = false;
    for (let chunk = readable.read(); chunk !== null; chunk = readable.read()) dropped = true;
    if (dropped && !status.outputDiscarded) { status.outputDiscarded = true; persistStatus(); }
    readable.read(0);
    return;
  }
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
  // An aborted start: its launcher gave up before the workload was reported started, so nobody reads its output. The
  // Job is empty and both streams ended; bytes held for a reader that will never come are dropped, never a reason to
  // leave the stop unrecorded.
  if (startupAborted && retainedOutput.length > 0) {
    retainedOutput.length = 0;
    // The launcher reads these counts (and the discard) to settle the record's own output offsets.
    status.outputDiscarded = true;
    publishRetainedOutputStatus();
  }
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
  // Incremental: the Job host appends periodic accounting events, so never
  // re-read the whole journal on every 10 ms tick. Only complete lines are consumed.
  const descriptor = openSync(config.eventPath, "r");
  let suffix;
  try {
    const size = fstatSync(descriptor).size;
    if (size < jobEventBytes) return markOwnershipUncertain("Windows Job event evidence shrank unexpectedly.");
    if (size === jobEventBytes) return;
    const bytes = Buffer.alloc(size - jobEventBytes);
    let read = 0;
    while (read < bytes.byteLength) {
      const count = readSync(descriptor, bytes, read, bytes.byteLength - read, jobEventBytes + read);
      if (count === 0) break;
      read += count;
    }
    const complete = bytes.subarray(0, read).lastIndexOf(0x0a) + 1;
    if (complete === 0) return;
    jobEventBytes += complete;
    suffix = bytes.subarray(0, complete).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
  for (const line of suffix.split(/\r?\n/)) if (line) handleJobEvent(line);
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
    pendingRoot = null;
    assignIntent = null;
    markRunning(event.pid);
    return;
  }
  if (event.type === "assign_intent") {
    const tick = /^[1-9][0-9]{0,19}$/;
    if (backend && event.hostPid === backend.pid && typeof event.hostCreationTime === "string" && tick.test(event.hostCreationTime) &&
        typeof event.at === "string" && tick.test(event.at))
      assignIntent = { hostPid: event.hostPid, hostCreationTime: event.hostCreationTime, at: event.at };
    return;
  }
  if (event.type === "assign_pending") {
    if (Number.isSafeInteger(event.pid) && event.pid > 0 && typeof event.creationTime === "string" && /^[1-9][0-9]{0,19}$/.test(event.creationTime))
      pendingRoot = { pid: event.pid, creationTime: event.creationTime };
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
  if (event.type === "accounting") {
    // T1 CPU evidence for input-wait detection: in-memory only (served by
    // /status), never persisted, never a lifecycle or ownership fact.
    if (Number.isSafeInteger(event.cpu100ns) && event.cpu100ns >= 0) {
      status.cpuTimeMs = Math.floor(event.cpu100ns / 10_000);
      status.cpuSampledAt = new Date().toISOString();
    }
    return;
  }
  if (event.type === "error") {
    backendFailure = new Error(event.error ?? "Windows Job host failed.");
  }
}

function markRunning(pid) {
  reportedStarted = true;
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
  if (!reportedStarted) markStartupAborted();
  const deadlineMs = Math.max(250, Math.min(MAX_STOP_DEADLINE_MS, requestedDeadline || config.stopDeadlineMs || MAX_STOP_DEADLINE_MS));
  if (config.interactive) {
    // The interactive host dedicates its stdin to the child. Its exact process
    // exit closes the kill-on-close Job handle; the exit listener records proof.
    if (!status.jobEmptyProof && !interactiveTerminationRequested && backend.exitCode === null && backend.signalCode === null) {
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
      markStartupAborted();
      await stopOwnedTree("SIGKILL", config.stopDeadlineMs);
      // The kill ends the host, and its exit (a kill-on-close Job) is the exact empty proof: wait for it and record the
      // stop before acknowledging, so the aborted launch's record ends stopped with proof, never `starting`. Bounded by
      // the stop deadline; a host that outlives it leaves the record unproven, as before.
      if (config.interactive) await waitForExit(Math.max(250, Math.min(MAX_STOP_DEADLINE_MS, config.stopDeadlineMs || MAX_STOP_DEADLINE_MS)));
      // An Assign-path root being ended by its exact identity finishes before this supervisor exits (its own children
      // end with it).
      if (pendingRootEnd) await pendingRootEnd;
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

/**
 * A stop requested before the host reported its workload started: the workload's output has no reader. Its streams are
 * drained and dropped from here on, and a host that already died with output retained gets its stop recorded.
 */
function markStartupAborted() {
  startupAborted = true;
  if (config?.interactive && backend) {
    drainInteractiveOutput("stdout", backend.stdout);
    drainInteractiveOutput("stderr", backend.stderr);
  }
  tryMarkStopped();
}

/** The current time as FILETIME ticks (100 ns since 1601), as a decimal string. */
function fileTimeNow() {
  return String(BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n);
}

/**
 * How long the PowerShell that ends an Assign-path root may take to start: a ceiling for a start that hangs, never the
 * expected time. It is the same cold PowerShell start the Job host makes, measured 2026-11-18 at up to 32.9 s cold under
 * 40 busy loops on a 16-core host (about 1.8 times that on the PR 240 reviewer's host), and the same ceiling as the
 * launcher's start wait (windows-job-process-host.ts DEFAULT_START_CEILING_MS). Once it reports ready, ending the root
 * takes a Kill and a bounded WaitForExit.
 */
const ROOT_ENDER_START_CEILING_MS = 120_000;
const ROOT_ENDER_ACTION_CEILING_MS = 60_000;

/**
 * Ends the Assign path's root after its host died before assigning it, and returns true when it is gone. The root is
 * exactly one process:
 * - with a reported identity: the process with this pid AND this creation time (a reused pid is left alone);
 * - with only the intent: the host's child (ParentProcessId = the host's pid) created at or after the intent and before
 *   the host's exit. If a process now has the host's pid with another creation time, the pid was reused, and the window
 *   ends at that process's creation, so none of its children can match. A host that is somehow still alive (its pid and
 *   creation time) leaves the stop unproven.
 * While it runs, the durable status carries rootEnding, which extends the launcher's bounded waits. The wait follows
 * progress: up to ROOT_ENDER_START_CEILING_MS for the PowerShell to report ready, then ROOT_ENDER_ACTION_CEILING_MS for
 * the result. Any failure leaves the stop unproven.
 */
async function endRoot(root) {
  const exactScript = () => `$p = Get-Process -Id ${root.pid} -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $p) { 'gone'; exit 0 }; ` +
    `if ($p.StartTime.ToFileTimeUtc() -ne [long]'${root.creationTime}') { 'gone'; exit 0 }; ` +
    `$p.Kill(); if ($p.WaitForExit(30000)) { 'gone' } else { 'alive' }`;
  const intentScript = () => `$from = [long]'${root.at}'; $to = [long]'${root.hostExitedAt}'; $hostPid = ${root.hostPid}; ` +
    `$h = Get-Process -Id $hostPid -ErrorAction SilentlyContinue; ` +
    `if ($null -ne $h) { $t = $h.StartTime.ToFileTimeUtc(); if ($t -eq [long]'${root.hostCreationTime}') { 'alive'; exit 0 }; if ($t -lt $to) { $to = $t } }; ` +
    `$alive = $false; ` +
    `foreach ($c in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $hostPid")) { ` +
    `$p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue; if ($null -eq $p) { continue }; ` +
    `try { $t = $p.StartTime.ToFileTimeUtc() } catch { continue }; ` +
    `if ($t -lt $from -or $t -gt $to) { continue }; ` +
    `$p.Kill(); if (-not $p.WaitForExit(30000)) { $alive = $true } }; ` +
    `if ($alive) { 'alive' } else { 'gone' }`;
  const valid = /^[1-9][0-9]{0,19}$/;
  const exact = root.pid !== undefined;
  if (exact ? !(Number.isSafeInteger(root.pid) && root.pid > 0 && valid.test(root.creationTime))
    : !(Number.isSafeInteger(root.hostPid) && root.hostPid > 0 && valid.test(root.at) && valid.test(root.hostExitedAt) && valid.test(root.hostCreationTime))) return false;
  const script = `[Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); ${exact ? exactScript() : intentScript()}`;
  status.rootEnding = true;
  // Which identity named the root: the reported one, or only the intent (evidence for tests and diagnostics).
  status.rootEndedBy = exact ? "identity" : "intent";
  persistStatus();
  try {
    return await new Promise((resolvePromise) => {
      let output = "";
      let child;
      let timer;
      const finish = (value) => { clearTimeout(timer); resolvePromise(value); };
      try {
        child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolvePromise(false);
        return;
      }
      timer = setTimeout(() => { child.kill(); finish(false); }, ROOT_ENDER_START_CEILING_MS);
      let ready = false;
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        if (!ready && /^ready\r?\n/.test(output)) {
          ready = true;
          clearTimeout(timer);
          timer = setTimeout(() => { child.kill(); finish(false); }, ROOT_ENDER_ACTION_CEILING_MS);
        }
      });
      child.once("error", () => finish(false));
      child.once("close", (code) => {
        const gone = code === 0 && output.replace(/^ready\r?\n/, "").trim() === "gone";
        // Diagnostic only: why an Assign-path root was not proven gone.
        if (!gone) try { appendFileSync(config.stderrPath, `Assign-path root end was not proven (exit ${code}): ${output.slice(0, 2000)}\n`); } catch {}
        finish(gone);
      });
    });
  } finally {
    status.rootEnding = false;
    persistStatus();
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
