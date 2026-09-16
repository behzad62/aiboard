import { spawn, spawnSync } from "node:child_process";
// RUNNER_RAW_PROCESS_BOUNDARY: portable lifecycle supervisor launches, inspects, and terminates owned child trees.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectPosixProcessIdentity,
  isExactPosixAnchorRelease,
  listOwnedPosixGroupMembers,
  parsePosixBootstrapPrepared,
  reattestOwnedPosixAnchor,
  signalOwnedPosixGroup,
} from "./portable-process-posix-control.mjs";
import {
  PortableAuthorityUnavailableError,
  resumePortableOutputRetirement,
  retirePortableOutputAcknowledgement,
  runPortableFenceEffectSync,
  settlePortableSupervisorCommand,
} from "./portable-process-protocol.mjs";

const config = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8"));
const statePath = join(config.directory, "state.json");
const controlPath = join(config.directory, "control.json");
const stdoutPath = join(config.directory, "stdout.log");
const stderrPath = join(config.directory, "stderr.log");
const childGoPath = join(config.directory, "child-go");
const childStatusPath = join(config.directory, "child-status.json");
const childPreparedPath = join(config.directory, "child-prepared.json");
const anchorReleasePath = join(config.directory, "anchor-release.json");
const fencePath = join(config.directory, "fence.json");
const lockHolderPath = join(config.directory, "lock-holder.json");
const channelDirectory = join(config.directory, "channel");
const channelOutputDirectory = join(channelDirectory, "output");
const channelInputDirectory = join(channelDirectory, "input");
const channelAckDirectory = join(channelDirectory, "ack");
const outputCheckpointPath = join(channelDirectory, "output-checkpoint.json");
const posixBarrierWaiter = new Int32Array(new SharedArrayBuffer(4));
const ATOMIC_REPLACEMENT_INITIAL_RETRY_MS = 1_000;
const ATOMIC_WRITE_MAX_RETRY_MS = 1_000;
const STATE_PUBLICATION_MAX_RETRY_MS = 15_000;
for (const directory of [channelDirectory, channelOutputDirectory, channelInputDirectory, channelAckDirectory]) mkdirSync(directory, { recursive: true });
if (!existsSync(outputCheckpointPath)) writeAtomic(outputCheckpointPath, JSON.stringify({ nonce: config.nonce, stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
const replayCapacityChunks = config.replayCapacityChunks ?? 16;
const replayCapacityBytes = config.replayCapacityBytes ?? 256 * 1024;
const WINDOWS_TREE_FAILURE_LIMIT = 3;
const WINDOWS_TREE_REFRESH_INTERVAL_MS = 250;
const WINDOWS_TREE_INSPECTION_MIN_DEADLINE_MS = 2_000;
const WINDOWS_TREE_INSPECTION_MAX_DEADLINE_MS = 15_000;
const WINDOWS_BIRTH_INSPECTION_MIN_DEADLINE_MS = 2_000;
const WINDOWS_BIRTH_INSPECTION_MAX_DEADLINE_MS = 15_000;
const WINDOWS_BIRTH_INSPECTION_MAX_ATTEMPTS = 3;
const POSIX_GROUP_INSPECTION_DEADLINE_MS = 15_000;
const outputSequences = { stdout: 0, stderr: 0 };
const outputOffsets = { stdout: 0, stderr: 0 };
const retained = new Map();
let retainedBytes = 0;
let handledInput = 0;
let pendingChannelInput;
let revision = 0;
let lastPublishedSignature;
let handledControl = 0;
let targetExited = false;
let targetExitCode = null;
let targetSignal = null;
const knownProcesses = new Map();
let ownershipInspectionUnknown = false;
let ownershipInspectionDetail = "";
let controlInspectionUnknown = false;
let lastWindowsProcesses;
let lastWindowsParents;
let windowsTreeRefreshInFlight = false;
let windowsTreeSnapshotReady = false;
let lastWindowsTreeRefreshFinishedAt = Number.NEGATIVE_INFINITY;
let windowsTreeRefreshCount = 0;
let windowsTreeRefreshMinimumGapMs = null;
let windowsTreeFailures = 0;
let windowsTreeInspectionDeadlineMs = WINDOWS_TREE_INSPECTION_MIN_DEADLINE_MS;
let windowsBirthInspectionAttempts = 0;
let windowsBirthInspectionDeadlineMs = WINDOWS_BIRTH_INSPECTION_MIN_DEADLINE_MS;
let launchEffect = config.platform === "windows" ? "prepared" : "prepared";
let rootProcess = null;
let posixSupervisorBirth = null;
let posixWorkloadGroup = null;
let posixWorkloadRetirement = { state: "active" };
let posixAnchorExited = false;
let posixAnchorExitCode = null;
let posixAnchorExitSignal = null;
let posixAnchorReleaseRequested = false;
let posixAnchorReleaseAuthority = null;
let posixChildReleasedAnchorRelease = null;
let posixForceControlApplied = false;
let posixChildStatusSignature;
let posixStdoutClosed = false;
let posixStderrClosed = false;
let posixTerminalError = null;

const childBootstrap = new URL("./portable-process-child.mjs", import.meta.url);
const posixBootstrapSupervisor = config.platform === "posix" ? inspectPosixProcessIdentity(process.pid) : undefined;
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
  : spawn(process.execPath, [fileURLToPath(childBootstrap), Buffer.from(JSON.stringify({
      platform: "posix",
      nonce: config.nonce,
      executable: config.executable,
      arguments: config.arguments,
      workingDirectory: config.workingDirectory,
      environment: config.environment,
      goPath: childGoPath,
      preparedPath: childPreparedPath,
      anchorReleasePath,
      fenceLockPath: join(config.directory, ".fence.lock"),
      fencePath,
      lockHolderPath,
      posixSupervisor: posixBootstrapSupervisor?.state === "present"
        ? { pid: posixBootstrapSupervisor.value.pid, birth: posixBootstrapSupervisor.value.birth }
        : undefined,
      statusPath: childStatusPath,
    })).toString("base64url")], {
      detached: true,
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
  const inspection = inspectWindowsBirthWithRetry(child.pid);
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
} else initializePosixBootstrap();
installOutput("stdout", child.stdout, stdoutPath);
installOutput("stderr", child.stderr, stderrPath);
if (config.platform === "posix") {
  installPosixOutputLifecycle("stdout", child.stdout);
  installPosixOutputLifecycle("stderr", child.stderr);
}
// A pipe error belongs to its retained input callback, not process ownership.
child.stdin.on("error", () => {});
child.once("error", (error) => fail(error.message));
child.once("exit", (code, signal) => {
  if (config.platform === "posix") {
    handlePosixAnchorExit(code, signal);
    return;
  }
  targetExited = true;
  targetExitCode = code;
  targetSignal = signal;
  publish(launchEffect === "started" ? "running" : "outcome_unknown");
});
if (config.platform === "windows")
  publish(launchEffect === "started" ? "running" : "outcome_unknown", launchEffect === "unknown" ? "Initial Windows process birth inspection was unavailable or the PID disappeared before discovery." : null);

const timer = setInterval(tick, Math.max(10, config.pollIntervalMs ?? 25));
process.stdin.resume();
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});

function tick() {
  try {
    if (config.platform === "posix") {
      tickPosix();
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
    if (controlInspectionUnknown) {
      if (!hasNewControlRequest()) {
        publish("outcome_unknown", ownershipInspectionDetail || "Windows destructive control ownership is uncertain.");
        return;
      }
      if (!windowsTreeSnapshotReady && !windowsTreeRefreshInFlight && windowsTreeFailures < WINDOWS_TREE_FAILURE_LIMIT)
        requestWindowsTreeRefresh();
      if (windowsTreeRefreshInFlight) return;
      if (ownershipInspectionUnknown || !windowsTreeSnapshotReady) {
        publish("outcome_unknown", ownershipInspectionDetail || "Windows destructive control ownership is uncertain.");
        return;
      }
      controlInspectionUnknown = false;
    }
    if (config.platform === "windows" && !windowsTreeSnapshotReady && windowsTreeFailures < WINDOWS_TREE_FAILURE_LIMIT) requestWindowsTreeRefresh();
    if (ownershipInspectionUnknown) {
      if (windowsTreeFailures >= WINDOWS_TREE_FAILURE_LIMIT)
        publish("outcome_unknown", `Owned Windows process inspection is unavailable: ${ownershipInspectionDetail}`);
      return;
    }
    if (config.platform === "windows" && windowsTreeRefreshInFlight) return;
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
    if (config.platform === "windows") windowsTreeSnapshotReady = false;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function installPosixOutputLifecycle(stream, readable) {
  // `end` is the exact readable-side EOF proof: all bytes before EOF were
  // consumed and no writer can append more to this pipe. Some runtimes delay
  // the later resource `close` notification, so either event may retire the
  // same idempotent pipe obligation.
  readable.once("end", () => markPosixPipeClosed(stream));
  readable.once("close", () => markPosixPipeClosed(stream));
}
function markPosixPipeClosed(stream) {
  if (stream === "stdout") {
    posixStdoutClosed = true;
    return;
  }
  if (stream === "stderr") {
    posixStderrClosed = true;
    return;
  }
  throw new Error("POSIX supervisor received an unknown output pipe closure.");
}

function handlePosixAnchorExit(code, signal) {
  posixAnchorExited = true;
  posixAnchorExitCode = code;
  posixAnchorExitSignal = signal;
  publish("running");
}

function tickPosix() {
  handleChannelAcks();
  handleChannelInput();
  drainOutput("stdout", child.stdout, stdoutPath);
  drainOutput("stderr", child.stderr, stderrPath);
  if (!posixWorkloadGroup || !posixSupervisorBirth) {
    publish("outcome_unknown", "POSIX workload identity was not captured before executable release.");
    return;
  }
  refreshPosixChildStatus();
  handleControl();
  if (posixWorkloadRetirement.state === "retired") {
    const outputPipesDrained = posixOutputPipesDrained();
    publish(outputPipesDrained ? "stopped" : "running");
    if (outputPipesDrained && posixOutputSettled()) {
      clearInterval(timer);
      process.exit(0);
    }
    return;
  }
  if (posixAnchorExited) {
    const members = listOwnedPosixGroupMembers(posixWorkloadGroup.groupId);
    if (members === undefined) {
      publish("outcome_unknown", "POSIX workload group could not be enumerated after anchor exit.");
      return;
    }
    if (members.length === 0 && hasCausalPosixAnchorRelease()) {
      retirePosixWorkload("anchor_release");
      return;
    }
    if (members.length === 0 && posixForceControlApplied) {
      retirePosixWorkload("force_terminate");
      return;
    }
    publish("outcome_unknown", "POSIX anchor exited before an authenticated released-child record and clean causal exit were observed.");
    return;
  }
  const anchor = reattestOwnedPosixAnchor(posixWorkloadGroup);
  if (anchor.state === "identity_mismatch") {
    publish("outcome_unknown", "POSIX workload anchor birth or group identity changed.");
    return;
  }
  if (anchor.state !== "ready") {
    publish("outcome_unknown", "POSIX workload anchor identity or group membership is unavailable.");
    return;
  }
  if (posixAnchorReleaseRequested && !hasCurrentPosixAnchorReleaseAuthority()) {
    posixAnchorReleaseRequested = false;
    posixAnchorReleaseAuthority = null;
  }
  if (posixAnchorReleaseRequested) {
    publish("running");
    return;
  }
  if (targetExited && anchor.members.length === 1 && anchor.members[0] === posixWorkloadGroup.leaderPid) {
    if (!requestPosixAnchorRelease()) {
      publish("outcome_unknown", "POSIX anchor release could not be committed under the current fence.");
      return;
    }
  }
  publish(launchEffect === "unknown" ? "outcome_unknown" : "running");
}

function installOutput(stream, readable, evidencePath) {
  readable.on("readable", () => drainOutput(stream, readable, evidencePath));
}

function drainOutput(stream, readable, evidencePath) {
  while (retained.size < replayCapacityChunks && retainedBytes < replayCapacityBytes) {
    const maximum = Math.min(16 * 1024, replayCapacityBytes - retainedBytes);
    if (maximum < 1) break;
    // read(size) waits for that many bytes while a live pipe remains open. A
    // persistent process may produce only short frames, so consume the exact
    // bytes currently buffered while preserving the configured upper bound.
    const available = Math.min(maximum, readable.readableLength);
    if (available < 1) {
      // In readable mode Node can defer the EOF/end transition until a read is
      // attempted after the final buffered byte. A zero-byte read advances that
      // state without consuming data or widening the bounded frame size.
      readable.read(0);
      break;
    }
    const bytes = readable.read(available);
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
  const current = readCurrentFence();
  if (!current) throw new PortableAuthorityUnavailableError("Portable output retirement authority is unavailable.");
  const resumed = withCurrentFenceEffect(current.ownerId, current.fencingToken, () => resumePortableOutputRetirement({
    channelDirectory,
    nonce: config.nonce,
    fence: { ownerId: current.ownerId, fencingToken: current.fencingToken },
    atomicWrite: writeAtomic,
  }));
  if (resumed.status === "applied" && resumed.value) forgetRetiredOutput(resumed.value.name, resumed.value.metadata);
  else if ((resumed.status === "unavailable" && resumed.cause === "authority") || resumed.status === "outcome_unknown")
    throw resumed.error;
  else if (resumed.status === "stale" || (resumed.status === "unavailable" && resumed.cause === "coordination")) return;
  for (const name of readdirSync(channelAckDirectory).filter((entry) => entry.endsWith(".json"))) {
    let ack;
    try { ack = JSON.parse(readFileSync(join(channelAckDirectory, name), "utf8")); } catch { continue; }
    const key = name.slice(0, -5);
    const expected = retained.get(key);
    if (!expected || ack.nonce !== config.nonce || JSON.stringify(ack.metadata) !== JSON.stringify(expected)) continue;
    const fence = readCurrentFence();
    if (!fence || ack.ownerId !== fence.ownerId || ack.fencingToken !== fence.fencingToken) continue;
    const outcome = withCurrentFenceEffect(ack.ownerId, ack.fencingToken, () => retirePortableOutputAcknowledgement({
      channelDirectory,
      nonce: config.nonce,
      fence: { ownerId: ack.ownerId, fencingToken: ack.fencingToken },
      name,
      metadata: expected,
      atomicWrite: writeAtomic,
    }));
    if (outcome.status === "applied") forgetRetiredOutput(name, expected);
    else if ((outcome.status === "unavailable" && outcome.cause === "authority") || outcome.status === "outcome_unknown")
      throw outcome.error;
    else return;
  }
}

function forgetRetiredOutput(name, metadata) {
  retained.delete(name.slice(0, -5));
  retainedBytes -= metadata.byteLength;
}

function handleChannelInput() {
  if (pendingChannelInput) {
    const pending = pendingChannelInput;
    if (!pending.settled) return;
    const outcome = settlePortableSupervisorCommand({
      expectedFence: { ownerId: pending.command.ownerId, fencingToken: pending.command.fencingToken },
      readCurrentFence: readCurrentFenceStrict,
      commit: (candidate, effect) => withCurrentFenceEffect(candidate.ownerId, candidate.fencingToken, effect),
      apply: () => {
        publishChannelInputAck(pending.command, pending.status);
        retireChannelInput(pending.path, pending.command.sequence);
        pendingChannelInput = undefined;
      },
      retireStale: () => {
        retireChannelInput(pending.path, pending.command.sequence);
        pendingChannelInput = undefined;
      },
    });
    if ((outcome.status === "unavailable" && outcome.cause === "authority") || outcome.status === "outcome_unknown") throw outcome.error;
    return;
  }
  const expectedName = `input-${String(handledInput + 1).padStart(12, "0")}.json`;
  const path = join(channelInputDirectory, expectedName);
  if (!existsSync(path)) return;
  let command;
  try { command = JSON.parse(readFileSync(path, "utf8")); } catch { return; }
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
  const outcome = settlePortableSupervisorCommand({
    expectedFence: { ownerId: command.ownerId, fencingToken: command.fencingToken },
    readCurrentFence: readCurrentFenceStrict,
    commit: (candidate, effect) => withCurrentFenceEffect(candidate.ownerId, candidate.fencingToken, effect),
    apply: () => {
      if (command.type === "write") {
        // Admission is fenced, but waiting for the callback cannot hold that
        // fence: cleanup must remain able to stop a backpressured child. Keep
        // the exact command until settlement; never issue its payload twice.
        const pending = { command, path, settled: false, status: "failed" };
        pendingChannelInput = pending;
        if (child.stdin.destroyed || !child.stdin.writable) pending.settled = true;
        else {
          try { child.stdin.write(bytes, (error) => { pending.status = error ? "failed" : "acknowledged"; pending.settled = true; }); }
          catch { pending.settled = true; }
        }
        return;
      } else if (command.type === "close_input") {
        child.stdin.end();
        publishChannelInputAck(command, "acknowledged");
      } else {
        writeAtomic(controlPath, JSON.stringify({ nonce: config.nonce, ownerId: command.ownerId, fencingToken: command.fencingToken, sequence: handledControl + 1, action: "terminate" }));
        publishChannelInputAck(command, "acknowledged");
      }
      retireChannelInput(path, command.sequence);
    },
    retireStale: () => retireChannelInput(path, command.sequence),
  });
  if ((outcome.status === "unavailable" && outcome.cause === "authority") || outcome.status === "outcome_unknown") throw outcome.error;
}

function retireChannelInput(path, sequence) {
  unlinkSync(path);
  if (existsSync(path)) throw new Error("Portable input command could not be retired.");
  handledInput = sequence;
}

function readCurrentFenceStrict() {
  const current = readCurrentFence();
  if (!current) throw new PortableAuthorityUnavailableError("Portable fence evidence is missing or corrupt.");
  return current;
}

function completeControl(request, apply) {
  const exactRequestStillPublished = () => {
    let current;
    try { current = JSON.parse(readFileSync(controlPath, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    return current.nonce === request.nonce && current.ownerId === request.ownerId && current.fencingToken === request.fencingToken &&
      current.sequence === request.sequence && current.action === request.action;
  };
  const outcome = settlePortableSupervisorCommand({
    expectedFence: { ownerId: request.ownerId, fencingToken: request.fencingToken },
    readCurrentFence: readCurrentFenceStrict,
    commit: (candidate, effect) => withCurrentFenceEffect(candidate.ownerId, candidate.fencingToken, effect),
    apply: () => {
      if (!exactRequestStillPublished()) return { disposition: "deferred" };
      const value = apply();
      handledControl = request.sequence;
      return { disposition: "applied", value };
    },
    retireStale: () => {
      if (!exactRequestStillPublished()) return false;
      unlinkSync(controlPath);
      if (existsSync(controlPath)) throw new Error("Portable stale control command could not be retired.");
      handledControl = request.sequence;
      return true;
    },
  });
  if ((outcome.status === "unavailable" && outcome.cause === "authority") || outcome.status === "outcome_unknown") throw outcome.error;
  return outcome.status === "applied" && outcome.value.disposition === "applied" ? outcome.value.value : undefined;
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
  const lock = join(config.directory, ".fence.lock");
  try {
    const holder = JSON.parse(readFileSync(lockHolderPath, "utf8"));
    if (holder.nonce !== config.nonce || holder.holderPid !== process.pid || typeof holder.holderBirth !== "string" || !holder.holderBirth)
      throw new Error("Portable fence holder identity is invalid.");
    return runPortableFenceEffectSync({
      lockPath: lock,
      expectedFence: { ownerId, fencingToken },
      readCurrentFence: readCurrentFenceStrict,
      effect,
      lockOptions: { holderPid: holder.holderPid, holderBirth: holder.holderBirth },
    });
  } catch (error) {
    return { status: "unavailable", cause: "authority", error: new PortableAuthorityUnavailableError("Portable fence holder identity is unavailable.", { cause: error }) };
  }
}

function writeAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, value);
  replaceAtomic(temporary, destination, ATOMIC_WRITE_MAX_RETRY_MS);
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

function initializePosixBootstrap() {
  const supervisor = inspectPosixProcessIdentity(process.pid);
  if (supervisor.state !== "present") {
    launchEffect = "unknown";
    publish("outcome_unknown", "POSIX supervisor birth identity was unavailable before bootstrap release.");
    return;
  }
  posixSupervisorBirth = supervisor.value.birth;
  const prepared = waitForPosixPrepared(5_000);
  const workloadGroup = prepared && parsePosixBootstrapPrepared(prepared, config.nonce, child.pid);
  if (!workloadGroup) {
    launchEffect = "unknown";
    publish("outcome_unknown", "POSIX detached bootstrap did not publish an exact prepared workload identity.");
    return;
  }
  const exactAnchor = reattestOwnedPosixAnchor(workloadGroup);
  if (exactAnchor.state !== "ready") {
    launchEffect = "unknown";
    publish("outcome_unknown", "POSIX detached bootstrap identity could not be independently re-attested before go.");
    return;
  }
  posixWorkloadGroup = workloadGroup;
  if (!waitForExactPosixLockHolder(5_000)) {
    launchEffect = "unknown";
    publish("outcome_unknown", "POSIX supervisor fence-holder birth identity is unavailable before go.");
    return;
  }
  publish("preparing");
  const current = readCurrentFence();
  if (!current) {
    launchEffect = "unknown";
    publish("outcome_unknown", "POSIX go barrier cannot be bound because the current fence is unavailable.");
    return;
  }
  const outcome = withCurrentFenceEffect(current.ownerId, current.fencingToken, () => {
    const currentAnchor = reattestOwnedPosixAnchor(posixWorkloadGroup);
    if (currentAnchor.state !== "ready") throw new Error("POSIX detached bootstrap identity changed before go.");
    writeAtomic(childGoPath, JSON.stringify({
      protocol: "aiboard-portable-process/v2-posix-go",
      nonce: config.nonce,
      supervisorPid: process.pid,
      supervisorBirth: posixSupervisorBirth,
      ownerId: current.ownerId,
      fencingToken: current.fencingToken,
      workloadGroup: posixWorkloadGroup,
    }));
  });
  if (outcome.status !== "applied") {
    launchEffect = "unknown";
    publish("outcome_unknown", "POSIX go barrier could not be committed under the current fence.");
    return;
  }
  const startup = waitForPosixChildStartup(5_000);
  if (startup?.status === "started") {
    launchEffect = "started";
    publish("running");
  } else if (startup?.status === "exited") {
    launchEffect = "started";
    targetExited = true;
    targetExitCode = startup.exitCode;
    targetSignal = startup.signal;
    publish("running");
  } else if (startup?.status === "error") {
    launchEffect = "started";
    targetExited = true;
    posixTerminalError = startup.error;
    publish("outcome_unknown", posixTerminalError);
  } else {
    launchEffect = "unknown";
    publish("outcome_unknown", "POSIX child did not prove executable startup after go.");
  }
}

function waitForPosixPrepared(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readJson(childPreparedPath);
    if (value !== undefined) return value;
    Atomics.wait(posixBarrierWaiter, 0, 0, 10);
  }
  return undefined;
}

function waitForPosixChildStartup(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readPosixChildStatus();
    if (value?.status === "started" || value?.status === "exited" || value?.status === "error") return value;
    Atomics.wait(posixBarrierWaiter, 0, 0, 10);
  }
  return undefined;
}

function readPosixChildStatus() {
  const value = readJson(childStatusPath);
  if (!value || value.protocol !== "aiboard-portable-process/v2-posix-child" || value.nonce !== config.nonce ||
      !samePosixWorkloadGroup(value.workloadGroup, posixWorkloadGroup)) return undefined;
  if (value.status === "prepared") return value;
  if (value.status === "released") return value.anchorRelease && typeof value.anchorRelease === "object" ? value : undefined;
  if (value.status === "started") return Number.isSafeInteger(value.pid) && value.pid > 0 ? value : undefined;
  if (value.status === "exited")
    return (value.exitCode === null || Number.isSafeInteger(value.exitCode)) && (value.signal === null || typeof value.signal === "string") ? value : undefined;
  return value.status === "error" && typeof value.error === "string" && value.error.length > 0 ? value : undefined;
}

function refreshPosixChildStatus() {
  const value = readPosixChildStatus();
  if (!value) return;
  const signature = JSON.stringify(value);
  if (signature === posixChildStatusSignature) return;
  posixChildStatusSignature = signature;
  if (value.status === "started") {
    launchEffect = "started";
    return;
  }
  if (value.status === "exited") {
    launchEffect = "started";
    targetExited = true;
    targetExitCode = value.exitCode;
    targetSignal = value.signal;
    return;
  }
  if (value.status === "released") {
    recordCausalPosixAnchorRelease(value.anchorRelease);
    return;
  }
  if (value.status === "error") {
    launchEffect = "started";
    targetExited = true;
    posixTerminalError = value.error;
  }
}

function recordCausalPosixAnchorRelease(release) {
  if (!posixAnchorReleaseRequested || !posixAnchorReleaseAuthority || !posixSupervisorBirth) return false;
  const expectedSupervisor = { supervisorPid: process.pid, supervisorBirth: posixSupervisorBirth };
  // This is observation of a previously fenced, consumed release, not a new
  // release effect. A higher-fence cleanup owner may join its exact receipt.
  const current = readCurrentFence();
  if (!current || current.fencingToken < posixAnchorReleaseAuthority.fencingToken ||
      (current.fencingToken === posixAnchorReleaseAuthority.fencingToken && current.ownerId !== posixAnchorReleaseAuthority.ownerId)) return false;
  const outcome = withCurrentFenceEffect(current.ownerId, current.fencingToken, () => {
    const latestRelease = readJson(anchorReleasePath);
    if (!isExactPosixAnchorRelease(release, config.nonce, posixWorkloadGroup, expectedSupervisor, posixAnchorReleaseAuthority) ||
        !isExactPosixAnchorRelease(latestRelease, config.nonce, posixWorkloadGroup, expectedSupervisor, posixAnchorReleaseAuthority)) return false;
    posixChildReleasedAnchorRelease = release;
    return true;
  });
  return outcome.status === "applied" && outcome.value === true;
}

function hasCausalPosixAnchorRelease() {
  return posixChildReleasedAnchorRelease !== null && posixAnchorExitCode === 0 && posixAnchorExitSignal === null;
}

function requestPosixAnchorRelease() {
  const current = readCurrentFence();
  if (!current || !Number.isSafeInteger(current.fencingToken) || current.fencingToken < 1) return false;
  if (samePosixFenceAuthority(posixAnchorReleaseAuthority, current)) return true;
  const outcome = withCurrentFenceEffect(current.ownerId, current.fencingToken, () => {
    const anchor = reattestOwnedPosixAnchor(posixWorkloadGroup);
    if (anchor.state !== "ready" || anchor.members.length !== 1 || anchor.members[0] !== posixWorkloadGroup.leaderPid)
      throw new Error("POSIX workload no longer consists of its exact anchor alone.");
    writeAtomic(anchorReleasePath, JSON.stringify({
      protocol: "aiboard-portable-process/v2-posix-anchor-release",
      nonce: config.nonce,
      supervisorPid: process.pid,
      supervisorBirth: posixSupervisorBirth,
      ownerId: current.ownerId,
      fencingToken: current.fencingToken,
      workloadGroup: posixWorkloadGroup,
    }));
  });
  if (outcome.status !== "applied") return false;
  posixAnchorReleaseRequested = true;
  posixAnchorReleaseAuthority = { ownerId: current.ownerId, fencingToken: current.fencingToken };
  return true;
}

function hasCurrentPosixAnchorReleaseAuthority() {
  return samePosixFenceAuthority(posixAnchorReleaseAuthority, readCurrentFence());
}

function retirePosixWorkload(cause) {
  if (posixWorkloadRetirement.state === "retired") return;
  posixWorkloadRetirement = { state: "retired", cause, at: new Date().toISOString() };
  publish("running");
}

function posixOutputPipesDrained() {
  return posixStdoutClosed === true && posixStderrClosed === true &&
    Number.isSafeInteger(child.stdout?.readableLength) && child.stdout.readableLength === 0 &&
    Number.isSafeInteger(child.stderr?.readableLength) && child.stderr.readableLength === 0;
}

function posixOutputSettled() {
  try {
    if (retained.size !== 0 || existsSync(join(channelDirectory, "output-retirement.json")) || readdirSync(channelOutputDirectory).length !== 0) return false;
    return !readdirSync(channelAckDirectory).some((name) => /^(stdout|stderr)-/.test(name));
  } catch {
    return false;
  }
}

function hasExactPosixLockHolder() {
  const holder = readJson(lockHolderPath);
  return !!holder && holder.nonce === config.nonce && holder.holderPid === process.pid && holder.holderBirth === posixSupervisorBirth;
}

function waitForExactPosixLockHolder(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasExactPosixLockHolder()) return true;
    Atomics.wait(posixBarrierWaiter, 0, 0, 10);
  }
  return false;
}

function samePosixWorkloadGroup(left, right) {
  return !!left && !!right && left.groupId === right.groupId && left.leaderPid === right.leaderPid &&
    left.leaderBirth === right.leaderBirth;
}

function samePosixFenceAuthority(left, right) {
  return !!left && !!right && typeof left.ownerId === "string" && left.ownerId.length > 0 &&
    Number.isSafeInteger(left.fencingToken) && left.fencingToken >= 1 && left.ownerId === right.ownerId &&
    left.fencingToken === right.fencingToken;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function handleControl() {
  if (!existsSync(controlPath)) return;
  let request;
  try { request = JSON.parse(readFileSync(controlPath, "utf8")); }
  catch (error) {
    if (["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) return;
    throw error;
  }
  if (request.nonce !== config.nonce || request.sequence <= handledControl) return;
  if (!Number.isSafeInteger(request.sequence) || request.sequence !== handledControl + 1 || typeof request.ownerId !== "string" || !Number.isSafeInteger(request.fencingToken) || request.fencingToken < 1 ||
      !["interrupt", "terminate", "force_terminate"].includes(request.action))
    throw new Error("Portable control command identity is invalid.");
  // Graceful controls that arrive after the exact target exit are stale. A
  // force request is different: the launcher may have exited while detached
  // descendants remain, and cleanup must still control those exact members.
  // Release cannot retire the fence while those members are non-empty because
  // the backend's empty proof is a prerequisite for release.
  if (config.platform === "windows" && targetExited && request.action !== "force_terminate") {
    completeControl(request, () => undefined);
    return;
  }
  if (config.platform === "windows") {
    if (config.windowsControlInspector) refreshWindowsTree();
    if (ownershipInspectionUnknown) {
      controlInspectionUnknown = true;
      publish("outcome_unknown", ownershipInspectionDetail || "Refused to signal a recycled Windows descendant PID.");
      return;
    }
    const members = [];
    for (const [pid, birth] of knownProcesses) {
      const inspection = inspectWindowsBirth(pid);
      if (inspection.state === "unknown") {
        publish("outcome_unknown", "Refused to signal because Windows process inspection is unavailable.");
        return;
      }
      if (inspection.state === "present" && sameBirth(inspection.fingerprint, birth)) members.push({ pid, birth });
    }
    const signalOrder = windowsLeafFirstSignalOrder(members);
    const failure = completeControl(request, () => {
      const configuredTaskkill = config.windowsTaskkill;
      const command = typeof configuredTaskkill?.command === "string"
        ? configuredTaskkill.command
        : injectedWindowsHelper("taskkill.exe");
      const prefix = Array.isArray(configuredTaskkill?.arguments) ? configuredTaskkill.arguments.map(String) : [];
      const deadlineMs = configuredDeadline(configuredTaskkill);
      for (const { pid, birth } of signalOrder) {
        const inspection = inspectWindowsBirth(pid);
        if (inspection.state === "unknown") return `exact birth inspection was unavailable for PID ${pid}`;
        if (inspection.state === "absent" || !sameBirth(inspection.fingerprint, birth)) continue;
        const result = spawnSync(command, [...prefix, "/PID", String(pid), ...(request.action === "force_terminate" ? ["/F"] : [])], {
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
      windowsTreeSnapshotReady = false;
      ownershipInspectionDetail = `Windows taskkill control was uncertain: ${failure}`;
      publish("outcome_unknown", ownershipInspectionDetail);
      return;
    }
  } else {
    const observedAnchor = reattestOwnedPosixAnchor(posixWorkloadGroup);
    if (observedAnchor.state !== "ready") {
      publish("outcome_unknown", "POSIX workload anchor is unavailable at the control boundary; refusing numeric-only group control.");
      return;
    }
    const applied = completeControl(request, () => {
      const anchor = reattestOwnedPosixAnchor(posixWorkloadGroup);
      if (anchor.state !== "ready") return { state: "anchor_unavailable" };
      signalOwnedPosixGroup(request.action, process.kill, posixWorkloadGroup.groupId);
      if (request.action === "force_terminate") posixForceControlApplied = true;
      return { state: "signalled" };
    });
    if (applied?.state === "anchor_unavailable")
      publish("outcome_unknown", "POSIX workload anchor is unavailable at the control boundary; refusing numeric-only group control.");
    return;
  }
  const active = activeOwnedPids();
  publish(active === undefined ? "outcome_unknown" : active.length === 0 ? "stopped" : "running");
}

function hasNewControlRequest() {
  try {
    const request = JSON.parse(readFileSync(controlPath, "utf8"));
    return request.nonce === config.nonce && Number.isSafeInteger(request.sequence) && request.sequence > handledControl;
  } catch { return false; }
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
  const inspectorCommand = typeof configuredInspector?.command === "string"
    ? configuredInspector.command
    : injectedWindowsHelper("WindowsPowerShell", "v1.0", "powershell.exe");
  const inspectorArguments = Array.isArray(configuredInspector?.arguments)
    ? configuredInspector.arguments.map(String)
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_SCRIPT];
  const hasConfiguredDeadline = Number.isSafeInteger(configuredInspector?.deadlineMs) && configuredInspector.deadlineMs > 0;
  const inspectorDeadlineMs = hasConfiguredDeadline ? configuredInspector.deadlineMs : windowsTreeInspectionDeadlineMs;
  const startedAt = Date.now();
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
    const finalError = error ?? inspectionError;
    if (!hasConfiguredDeadline) {
      const elapsed = Math.max(1, Date.now() - startedAt);
      windowsTreeInspectionDeadlineMs = code === 0 && !finalError
        ? Math.min(WINDOWS_TREE_INSPECTION_MAX_DEADLINE_MS, Math.max(WINDOWS_TREE_INSPECTION_MIN_DEADLINE_MS, elapsed * 4))
        : Math.min(WINDOWS_TREE_INSPECTION_MAX_DEADLINE_MS, windowsTreeInspectionDeadlineMs * 2);
    }
    acceptWindowsTreeResult(code, finalError, Buffer.concat(stdout).toString("utf8"), inspector.pid);
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
  const inspectorCommand = typeof configuredInspector?.command === "string"
    ? configuredInspector.command
    : injectedWindowsHelper("WindowsPowerShell", "v1.0", "powershell.exe");
  const inspectorArguments = Array.isArray(configuredInspector?.arguments)
    ? configuredInspector.arguments.map(String)
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TREE_SCRIPT];
  const result = spawnSync(inspectorCommand, inspectorArguments, {
    encoding: "utf8",
    windowsHide: true,
    timeout: configuredDeadline(configuredInspector),
  });
  acceptWindowsTreeResult(result.status, result.error, String(result.stdout), result.pid);
}

function configuredDeadline(configuredOperation) {
  return Number.isSafeInteger(configuredOperation?.deadlineMs) && configuredOperation.deadlineMs > 0
    ? configuredOperation.deadlineMs
    : windowsTreeInspectionDeadlineMs;
}

function injectedWindowsHelper(...segments) {
  const environment = config.environment && typeof config.environment === "object" ? config.environment : {};
  const value = (name) => {
    const matches = Object.entries(environment)
      .filter(([key, candidate]) => key.toLowerCase() === name.toLowerCase() && typeof candidate === "string")
      .map(([, candidate]) => candidate);
    return new Set(matches).size === 1 ? matches[0] : undefined;
  };
  const systemRoot = value("SystemRoot") ?? value("windir");
  const command = systemRoot ? join(systemRoot, "System32", ...segments) : "";
  if (!command || !existsSync(command)) throw new Error("Portable Windows helper identity is unavailable from the injected environment.");
  return command;
}

function acceptWindowsTreeResult(status, error, stdout, inspectorPid) {
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
  let rows = lines.map((line) => {
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
  if (!Number.isSafeInteger(inspectorPid) || inspectorPid < 1) {
    windowsTreeFailures += 1;
    ownershipInspectionUnknown = true;
    ownershipInspectionDetail = "Windows process inventory inspector identity is unavailable.";
    return;
  }
  const birthsByPid = new Map(rows.map(({ pid, birth }) => [pid, birth]));
  const inspectorTree = new Set([inspectorPid]);
  let discovered = true;
  while (discovered) {
    discovered = false;
    for (const { pid, parent, birth } of rows) {
      if (inspectorTree.has(parent) && !inspectorTree.has(pid) &&
          isPlausibleWindowsParentEdge(birthsByPid.get(parent), birth)) {
        inspectorTree.add(pid);
        discovered = true;
      }
    }
  }
  rows = rows.filter(({ pid }) => !inspectorTree.has(pid));
  if (rows.length === 0) {
    windowsTreeFailures += 1;
    ownershipInspectionUnknown = true;
    ownershipInspectionDetail = "Windows process inventory contained only its inspector tree.";
    return;
  }
  ownershipInspectionUnknown = false;
  ownershipInspectionDetail = "";
  windowsTreeFailures = 0;
  windowsTreeSnapshotReady = true;
  const current = new Map(rows.map(({ pid, birth }) => [pid, birth]));
  lastWindowsProcesses = current;
  lastWindowsParents = new Map(rows.map(({ pid, parent }) => [pid, parent]));
  const owned = new Set([...knownProcesses].filter(([pid, birth]) => {
    const observed = current.get(pid);
    return observed !== undefined && sameBirth(observed, birth);
  }).map(([pid]) => pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pid, parent, birth } of rows) {
      if (owned.has(parent) && !owned.has(pid) &&
          isPlausibleWindowsParentEdge(current.get(parent), birth)) {
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
    const result = spawnSync("ps", ["-e", "-o", "pid=,pgid="], {
      encoding: "utf8",
      timeout: POSIX_GROUP_INSPECTION_DEADLINE_MS,
    });
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

function inspectWindowsBirthWithRetry(pid) {
  const configuredInspector = config.windowsBirthInspector;
  const hasConfiguredDeadline = Number.isSafeInteger(configuredInspector?.deadlineMs) && configuredInspector.deadlineMs > 0;
  const absoluteDeadline = Date.now() + WINDOWS_BIRTH_INSPECTION_MAX_DEADLINE_MS;
  const maximumAttempts = hasConfiguredDeadline ? 1 : WINDOWS_BIRTH_INSPECTION_MAX_ATTEMPTS;
  let attemptDeadlineMs = hasConfiguredDeadline ? configuredInspector.deadlineMs : WINDOWS_BIRTH_INSPECTION_MIN_DEADLINE_MS;
  let inspection = { state: "unknown" };
  for (let attempt = 0; attempt < maximumAttempts && Date.now() < absoluteDeadline; attempt += 1) {
    attemptDeadlineMs = Math.max(1, Math.min(attemptDeadlineMs, absoluteDeadline - Date.now()));
    windowsBirthInspectionAttempts += 1;
    windowsBirthInspectionDeadlineMs = attemptDeadlineMs;
    inspection = inspectWindowsBirth(pid, attemptDeadlineMs);
    if (inspection.state !== "unknown") return inspection;
    attemptDeadlineMs = Math.min(WINDOWS_BIRTH_INSPECTION_MAX_DEADLINE_MS, attemptDeadlineMs * 2);
  }
  return inspection;
}

function inspectWindowsBirth(pid, deadlineMs = WINDOWS_BIRTH_INSPECTION_MIN_DEADLINE_MS) {
  const configuredInspector = config.windowsBirthInspector;
  const script = `$ErrorActionPreference='Stop';try{$p=Get-Process -Id ${pid} -ErrorAction Stop;$start=$p.StartTime;if($null-eq$start){throw 'PROCESS_BIRTH_UNAVAILABLE'};'PRESENT:'+$start.ToUniversalTime().ToString('o')}catch{$current=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null-eq$current){'ABSENT'}else{throw}}`;
  const command = typeof configuredInspector?.command === "string"
    ? configuredInspector.command
    : injectedWindowsHelper("WindowsPowerShell", "v1.0", "powershell.exe");
  const args = Array.isArray(configuredInspector?.arguments)
    ? [...configuredInspector.arguments.map(String), String(pid)]
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: Math.max(1, Math.min(WINDOWS_BIRTH_INSPECTION_MAX_DEADLINE_MS, deadlineMs)),
  });
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

function isPlausibleWindowsParentEdge(parentBirth, childBirth) {
  const parent = comparableWindowsBirth(parentBirth);
  const child = comparableWindowsBirth(childBirth);
  return parent !== undefined && child !== undefined && child >= parent;
}

function comparableWindowsBirth(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?Z$/.exec(String(value));
  if (!match) return undefined;
  const fraction = (match[7] ?? "").slice(0, 6).padEnd(6, "0");
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${fraction}Z`;
  return Number.isFinite(Date.parse(canonical)) ? canonical : undefined;
}

function windowsLeafFirstSignalOrder(members) {
  const live = new Set(members.map(({ pid }) => pid));
  const depth = (pid) => {
    let cursor = pid;
    let value = 0;
    const seen = new Set();
    while (live.has(lastWindowsParents?.get(cursor)) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = lastWindowsParents.get(cursor);
      value += 1;
    }
    return value;
  };
  return [...members].sort((left, right) => depth(right.pid) - depth(left.pid) || right.pid - left.pid);
}

function sameBirth(left, right) {
  return normalizeBirth(left) === normalizeBirth(right);
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; }
}

function publish(status, error = config.platform === "posix" ? posixTerminalError : null) {
  const semanticState = config.platform === "posix"
    ? {
        protocol: "aiboard-portable-process/v2",
        nonce: config.nonce,
        supervisorPid: process.pid,
        supervisorBirth: posixSupervisorBirth,
        workloadGroup: posixWorkloadGroup,
        workloadGroupRetirement: posixWorkloadRetirement,
        launchEffect,
        rootProcess: null,
        handledControl,
        status,
        exitCode: targetExitCode,
        signal: targetSignal,
        knownProcesses: [],
        error,
      }
    : {
        protocol: "aiboard-portable-process/v1",
        nonce: config.nonce,
        supervisorPid: process.pid,
        launchEffect,
        rootProcess,
        handledControl,
        status,
        exitCode: targetExitCode,
        signal: targetSignal,
        knownProcesses: [...knownProcesses].map(([pid, birth]) => ({ pid, birth })),
        windowsTreeRefreshCount,
        windowsTreeRefreshMinimumGapMs,
        windowsTreeFailures,
        windowsTreeInspectionDeadlineMs,
        windowsBirthInspectionAttempts,
        windowsBirthInspectionDeadlineMs,
        error,
      };
  const signature = JSON.stringify(semanticState);
  if (signature === lastPublishedSignature) return;
  const nextRevision = revision + 1;
  const state = { ...semanticState, revision: nextRevision, updatedAt: new Date().toISOString() };
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  replaceAtomic(temporary, statePath, STATE_PUBLICATION_MAX_RETRY_MS);
  revision = nextRevision;
  lastPublishedSignature = signature;
}

function replaceAtomic(temporary, destination, maximumRetryMs) {
  const startedAt = Date.now();
  let retryWindowMs = Math.min(ATOMIC_REPLACEMENT_INITIAL_RETRY_MS, maximumRetryMs);
  let deadline = startedAt + retryWindowMs;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      renameSync(temporary, destination);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      const now = Date.now();
      if (now >= deadline) {
        if (retryWindowMs >= maximumRetryMs) throw error;
        retryWindowMs = Math.min(maximumRetryMs, retryWindowMs * 2);
        deadline = startedAt + retryWindowMs;
        if (now >= deadline && retryWindowMs >= maximumRetryMs) throw error;
      }
      Atomics.wait(waiter, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}

function fail(message, status = "outcome_unknown") {
  try { publish(status, message); } finally { process.exit(1); }
}
