import { execFile, execFileSync } from "node:child_process";
// RUNNER_RAW_PROCESS_BOUNDARY: platform process-identity probe for fencing; probes do not authorize workload launch.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOST_POLL_MAX_DELAY_MS, nextHostPollDelay } from "./host-timing.mjs";
import { sqliteDatabaseLocation } from "./windows-path-limits.mjs";

const PROTOCOL_VERSION = 1;
// A claim's default deadline. It covers the whole claim: on Windows the wait for this process's own birth identity,
// then the SQLite open and every retry, all host-speed work. Measured:
// - whole uncontended claim: Windows 15-23 ms idle, up to 851 ms with 2x as many busy processes as CPUs; a 2-CPU Linux
//   container 45-150 ms idle, up to 263 ms loaded;
// - SQLite open: Windows <= 17 ms idle locally, but 1,750 ms (PR #205, one case in 32 on main) and 2,783 ms (Windows
//   CI, 2026-11-14, "open 2783 ms") on loaded hosts; Linux container up to 715 ms;
// - Windows self-birth (cold powershell.exe): 155-413 ms idle; 5.3-7.4 s on two contended CPUs (T8, PR #205); 4.9-9.1 s
//   with 2x as many busy processes as CPUs here, 9.6-21.3 s with 4x.
// 15 s is over 5x the slowest open and 2x the slowest real self-birth (1.6x the 2x-load one). At 4x load the first
// claim of a process can still fail closed; the background probe (SELF_BIRTH_PROBE_CAP_MS) goes on for later ones.
// A claim returns the moment it holds the lock; the ceiling is reached only by a lock that stays held.
export const OWNED_FENCE_DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_DEADLINE_MS = OWNED_FENCE_DEFAULT_DEADLINE_MS;
// First wait before a claim checks again; then it grows by half up to HOST_POLL_MAX_DELAY_MS. What it waits for is
// another claim's transaction, and the fastest whole claim measured is 15 ms (Windows idle), so 5 ms checks about three
// times within the shortest hold. A check is one BEGIN IMMEDIATE (with SQLite's own 25 ms busy_timeout).
const DEFAULT_RETRY_DELAY_MS = 5;
// The background Windows self-birth probe is one cold powershell.exe start, never killed and restarted while it may
// still answer: it lasts SELF_BIRTH_PROBE_CAP_MS from its own start and returns the moment it answers. 30 s is 1.4x
// the slowest start measured (21.3 s, 4x as many busy processes as CPUs) and twice a default claim, so a probe slower
// than one claim still serves the next.
const SELF_BIRTH_PROBE_CAP_MS = 30_000;
// A probe that ends early without an identity starts again after this, growing by half up to the maximum. No early
// probe failure was ever observed, so there is no data for these; they keep the earlier 25 ms retry delay.
const SELF_BIRTH_RETRY_DELAY_MS = 25;
const SELF_BIRTH_MAX_RETRY_DELAY_MS = 250;
// At most this many probes per call or preparation, as before (4 attempts). Each gets all the time left, so the cap
// matters only when powershell.exe fails at once (missing, or blocked by policy): it stops a spawn every few ms.
// A later claim starts a new preparation.
const SELF_BIRTH_MAX_PROBES = 4;
const PROTOCOL_COLUMNS = Object.freeze(["version", "retired", "authority_id"]);
const LEGACY_PROTOCOL_COLUMNS = Object.freeze(["version", "retired"]);
const AUTHORITY_UPDATE_TRIGGER = "owned_fence_authority_immutable";
const AUTHORITY_DELETE_TRIGGER = "owned_fence_authority_delete_immutable";
const PROTOCOL_SIDECAR_SUFFIXES = Object.freeze(["-journal", "-wal", "-shm"]);
const CANONICAL_ACQUISITION_TABLE_SQL = `
  CREATE TABLE owned_fence_acquisition(
    acquisition_id TEXT PRIMARY KEY NOT NULL,
    holder_pid INTEGER NOT NULL,
    holder_birth TEXT NOT NULL
  )`;
const CANONICAL_HOLDER_TABLE_SQL = `
  CREATE TABLE owned_fence_holder(
    lock_key TEXT PRIMARY KEY NOT NULL CHECK(lock_key = 'owned'),
    acquisition_id TEXT UNIQUE NOT NULL,
    holder_pid INTEGER NOT NULL,
    holder_birth TEXT NOT NULL,
    FOREIGN KEY(acquisition_id) REFERENCES owned_fence_acquisition(acquisition_id)
  )`;
const CANONICAL_LEGACY_PROTOCOL_TABLE_SQL =
  "CREATE TABLE owned_fence_protocol(version INTEGER NOT NULL, retired INTEGER NOT NULL CHECK(retired IN (0, 1)))";
const CANONICAL_CURRENT_PROTOCOL_TABLE_SQL = `
  CREATE TABLE owned_fence_protocol(
    version INTEGER NOT NULL,
    retired INTEGER NOT NULL CHECK(retired IN (0, 1)),
    authority_id TEXT NOT NULL
  )`;
const CANONICAL_MIGRATED_PROTOCOL_TABLE_SQL =
  "CREATE TABLE owned_fence_protocol(version INTEGER NOT NULL, retired INTEGER NOT NULL CHECK(retired IN (0, 1)), authority_id TEXT)";
const CANONICAL_ACQUISITION_TRIGGER_SQL = `
  CREATE TRIGGER owned_fence_acquisition_immutable
  BEFORE UPDATE ON owned_fence_acquisition
  BEGIN SELECT RAISE(ABORT, 'owned fence acquisition identity is immutable'); END`;
const CANONICAL_AUTHORITY_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER owned_fence_authority_immutable
  BEFORE UPDATE OF authority_id ON owned_fence_protocol
  BEGIN SELECT RAISE(ABORT, 'owned fence authority identity is immutable'); END`;
const CANONICAL_AUTHORITY_DELETE_TRIGGER_SQL = `
  CREATE TRIGGER owned_fence_authority_delete_immutable
  BEFORE DELETE ON owned_fence_protocol
  BEGIN SELECT RAISE(ABORT, 'owned fence authority identity cannot be deleted'); END`;
const CANONICAL_AUTOINDEX_TABLES = new Map([
  ["sqlite_autoindex_owned_fence_acquisition_1", "owned_fence_acquisition"],
  ["sqlite_autoindex_owned_fence_holder_1", "owned_fence_holder"],
  ["sqlite_autoindex_owned_fence_holder_2", "owned_fence_holder"],
]);
const waiter = new Int32Array(new SharedArrayBuffer(4));
const asynchronousTails = new Map();
// The acquisition id this module instance currently holds, by resolved path (claim to release). A contention failure
// says whether the blocking holder is this live acquisition, and the sync driver refuses to block on a path another
// live acquisition of this thread holds (performStepSync). Every exit forgets its entry, even when close throws.
const liveAcquisitions = new Map();
const tracedErrors = new WeakSet();
// Holder rows this module instance claimed but could not release, by resolved path. An entry whose
// effect ran (ambiguous finalization) is diagnostic only: that holder is never stolen, but an
// acquisition it blocks names it and the failure that kept it. An entry whose effect never started
// may be replaced by a later acquisition here, by its exact acquisition id; that id is a random UUID
// this instance generated, so no other thread or process can own it.
const retainedHolders = new Map();
let cachedCurrentBirth;
// The background Windows self-birth preparation in flight, if any (prepareCurrentProcessBirthFingerprint).
let preparingCurrentBirth;

export class OwnedFenceLockUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "OwnedFenceLockUnavailableError";
  }
}

export class OwnedFenceAuthorityRetirementError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "OwnedFenceAuthorityRetirementError";
  }
}

export class OwnedFenceContentionError extends OwnedFenceLockUnavailableError {
  constructor(message, options) {
    super(message, options);
    this.name = "OwnedFenceContentionError";
  }
}

class OwnedFenceProtocolObservationChangedError extends OwnedFenceContentionError {
  constructor(message, options) {
    super(message, options);
    this.name = "OwnedFenceProtocolObservationChangedError";
  }
}

class OwnedFenceIdentityInspectionError extends OwnedFenceLockUnavailableError {}

function containsIdentityInspectionFailure(error, seen = new Set()) {
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof OwnedFenceIdentityInspectionError) return true;
  if (error instanceof AggregateError && error.errors.some(entry => containsIdentityInspectionFailure(entry, seen))) return true;
  return containsIdentityInspectionFailure(error.cause, seen);
}

export function isOwnedFenceLockContention(error) {
  if (containsIdentityInspectionFailure(error)) return false;
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every((entry) => isOwnedFenceLockContention(entry));
  if (error instanceof OwnedFenceContentionError) return true;
  return error instanceof Error && error.cause !== undefined
    ? isOwnedFenceLockContention(error.cause)
    : false;
}

export function withOwnedFenceLockSync(path, effect, options = {}) {
  path = resolve(path);
  return runSteps(lockSteps(path, effect, options));
}

export async function withOwnedFenceLock(path, effect, options = {}) {
  path = resolve(path);
  const previous = asynchronousTails.get(path) ?? Promise.resolve();
  let finishTurn;
  const turn = new Promise((resolvePromise) => { finishTurn = resolvePromise; });
  const tail = previous.then(() => turn);
  asynchronousTails.set(path, tail);
  await previous;
  try {
    return await runStepsAsync(lockSteps(path, effect, await awaitPreparedHolderBirth(options)));
  } finally {
    finishTurn();
    if (asynchronousTails.get(path) === tail) asynchronousTails.delete(path);
  }
}

// One claim-effect-release, shared by both entry points. Every wait inside it is a step its driver performs: the sync
// driver (withOwnedFenceLockSync) blocks the thread, which it already owns; the async driver (withOwnedFenceLock)
// awaits a timer, so a claim that polls for seconds on a busy host never stops the Runner's event loop, and on Windows
// it probes another holder's identity without blocking. No step yields while this connection holds a SQLite write
// transaction it has not committed, except the effect itself, whose transaction the protocol holds by design.
function* lockSteps(path, effect, options) {
  const context = yield* acquireSteps(path, options);
  let effectError;
  let retired = false;
  let effectStarted = false;
  try {
    yield* beginEffectSteps(context);
    effectStarted = true;
    let result;
    try { result = yield effectStep(effect); }
    catch (error) { effectError = error; }
    retired = finalizeEffect(context, effectError, options.retireAfterEffect === true);
    if (effectError !== undefined) throw effectError;
    return result;
  } catch (error) {
    rollbackQuietly(context.database);
    if (!effectStarted) throw yield* releaseUnstartedAcquisitionSteps(context, error);
    if (effectError !== undefined && error !== effectError) {
      throw new AggregateError([effectError, error], "Owned fence effect and finalization both failed.", { cause: effectError });
    }
    throw error;
  } finally {
    try { context.database.close(); }
    finally { forgetLiveAcquisition(context); }
    if (retired) yield* retireProtocolSteps(path, options, context.pathIdentity, context.authorityId);
  }
}

/**
 * A wait of `ms` before the next check. `path` and `acquisitionId` name the acquisition that waits, when it is a claim:
 * the sync driver refuses to block on a lock this thread itself holds through another live acquisition (an async
 * effect in progress, or a nested claim), since nothing on this thread could release it while the wait blocks.
 */
function sleepStep(ms, path, acquisitionId) {
  return { kind: "sleep", ms, path, acquisitionId };
}

function effectStep(effect) {
  return {
    kind: "call",
    sync: () => effect(),
    async: async () => {
      const result = effect();
      return result && typeof result.then === "function" ? await result : result;
    },
  };
}

/** Gentle backoff from `firstMs`: each call returns the next wait, growing by half up to `maximumMs`. */
function pollDelays(firstMs, maximumMs = HOST_POLL_MAX_DELAY_MS) {
  let current = firstMs;
  const maximum = Math.max(firstMs, maximumMs);
  return () => {
    const delay = current;
    current = nextHostPollDelay(current, maximum);
    return delay;
  };
}

function runSteps(steps) {
  let next = steps.next();
  for (;;) {
    if (next.done) return next.value;
    let value;
    let failure;
    let failed = false;
    try { value = performStepSync(next.value); }
    catch (error) { failure = error; failed = true; }
    next = failed ? steps.throw(failure) : steps.next(value);
  }
}

async function runStepsAsync(steps) {
  let next = steps.next();
  for (;;) {
    if (next.done) return next.value;
    let value;
    let failure;
    let failed = false;
    try { value = await performStepAsync(next.value); }
    catch (error) { failure = error; failed = true; }
    next = failed ? steps.throw(failure) : steps.next(value);
  }
}

function performStepSync(step) {
  if (step.kind === "sleep") {
    const live = step.path === undefined ? undefined : liveAcquisitions.get(step.path);
    if (live !== undefined && live !== step.acquisitionId)
      throw new OwnedFenceContentionError(
        "Owned fence lock is held by another live acquisition of this thread; a synchronous wait cannot outlast it.");
    if (step.ms > 0) Atomics.wait(waiter, 0, 0, step.ms);
    return undefined;
  }
  return step.sync();
}

async function performStepAsync(step) {
  if (step.kind === "sleep") {
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, Math.max(0, step.ms)); });
    return undefined;
  }
  return await step.async();
}

/**
 * Retire coordination whose external authority has already durably revoked it.
 * The caller's assertion is deliberately repeated inside the SQLite write
 * transaction: a stale or foreign tombstone must never authorize lock removal.
 */
export async function recoverRevokedOwnedFenceLock(path, options = {}) {
  path = resolve(path);
  const authorityId = coordinationAuthorityId(path);
  const previous = asynchronousTails.get(path) ?? Promise.resolve();
  let finishTurn;
  const turn = new Promise((resolvePromise) => { finishTurn = resolvePromise; });
  const tail = previous.then(() => turn);
  asynchronousTails.set(path, tail);
  await previous;
  try {
    if (typeof options.assertRevoked !== "function")
      throw new OwnedFenceLockUnavailableError("Owned fence revocation authority is unavailable.");
    options.assertRevoked();
    const pathIdentity = assertCoordinationPath(path, true);
    if (!pathIdentity) return;
    assertNoProtocolSidecars(path, pathIdentity);
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1)
      throw new OwnedFenceLockUnavailableError("Owned fence revocation bounds are invalid.");
    const deadline = Date.now() + deadlineMs;
    let database;
    let committed = false;
    try {
      database = new DatabaseSync(sqliteDatabaseLocation(path));
      assertCoordinationPathIdentity(path, pathIdentity);
      database.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      await beginImmediateAsync(database, deadline, retryDelayMs);
      assertRecoverableProtocol(database, authorityId, { allowHolderDeleteTriggers: true });
      options.assertRevoked();
      assertCoordinationPathIdentity(path, pathIdentity);
      const triggers = database.prepare("SELECT name, tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'trigger'").all();
      for (const trigger of triggers) {
        if (["owned_fence_acquisition_immutable", AUTHORITY_UPDATE_TRIGGER, AUTHORITY_DELETE_TRIGGER].includes(String(trigger.name))) continue;
        if (trigger.tableName !== "owned_fence_holder" || typeof trigger.sql !== "string" ||
            !/\bBEFORE\s+DELETE\s+ON\s+owned_fence_holder\b/i.test(trigger.sql))
          throw new OwnedFenceLockUnavailableError("Owned fence revocation metadata is corrupt or foreign.");
        database.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
      }
      database.prepare("DELETE FROM owned_fence_holder").run();
      database.prepare("DELETE FROM owned_fence_acquisition").run();
      database.prepare("UPDATE owned_fence_protocol SET retired = 1 WHERE retired = 0").run();
      const protocol = database.prepare("SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol").all();
      const proposals = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()?.count);
      const holders = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count);
      if (protocol.length !== 1 || protocol[0].version !== PROTOCOL_VERSION || protocol[0].retired !== 1 ||
          protocol[0].authorityId !== authorityId || proposals !== 0 || holders !== 0)
        throw new OwnedFenceLockUnavailableError("Owned fence revocation did not retire exact coordination state.");
      assertCoordinationPathIdentity(path, pathIdentity);
      database.exec("COMMIT");
      committed = true;
    } catch (error) {
      rollbackQuietly(database);
      throw normalizeUnavailable(error);
    } finally { database?.close(); }
    if (!committed) throw new OwnedFenceLockUnavailableError("Owned fence revocation commit is unavailable.");
    retainedHolders.delete(path);
    const removalAuthority = captureProtocolRemovalAuthority(path, pathIdentity, authorityId);
    options.assertRevoked();
    revalidateProtocolRemovalAuthority(path, removalAuthority);
    await runStepsAsync(removeProtocolPathSteps(path, removalAuthority));
  } finally {
    finishTurn();
    if (asynchronousTails.get(path) === tail) asynchronousTails.delete(path);
  }
}

export function currentProcessBirthFingerprint(remainingMs = DEFAULT_DEADLINE_MS) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0)
    throw new OwnedFenceLockUnavailableError("Current owned fence holder inspection deadline is exhausted.");
  if (cachedCurrentBirth?.state === "same") return cachedCurrentBirth.fingerprint;
  // On Windows the probe is a cold powershell.exe start: 155-218 ms idle, but 5.3-7.4 s measured on two contended
  // CPUs. One probe gets all of the caller's time and returns the moment it answers: killing a slow probe to start
  // another would only start it cold again. A probe that ends early without an identity starts again after a short,
  // growing delay while time is left. An inspection still unknown when the caller's deadline is spent fails closed,
  // and an unknown result is never cached.
  const deadline = Date.now() + remainingMs;
  const delays = pollDelays(SELF_BIRTH_RETRY_DELAY_MS, SELF_BIRTH_MAX_RETRY_DELAY_MS);
  for (let attempt = 1; attempt <= SELF_BIRTH_MAX_PROBES; attempt += 1) {
    const left = deadline - Date.now();
    if (left < 1) break;
    const inspected = inspectProcessBirth(process.pid, left);
    if (inspected.state === "same") {
      cachedCurrentBirth = inspected;
      return inspected.fingerprint;
    }
    const delay = delays();
    if (inspected.state !== "unknown" || deadline - Date.now() <= delay) break;
    if (attempt < SELF_BIRTH_MAX_PROBES) Atomics.wait(waiter, 0, 0, delay);
  }
  throw new OwnedFenceLockUnavailableError("Current owned fence holder birth identity is unavailable.");
}

/**
 * Windows: learn this process's own birth identity in the background, before the first fence acquisition needs it.
 * The probe is a cold powershell.exe start (155-218 ms idle, seconds on a loaded host). One probe runs until it answers
 * or SELF_BIRTH_PROBE_CAP_MS from its own start, whichever is first; a claim that gives up meanwhile leaves it running
 * for the next one. A probe that ends without an identity (it failed early, or was killed at its cap) starts again
 * after a short, growing delay while the preparation is still inside SELF_BIRTH_PROBE_CAP_MS from its start or a
 * waiting claim still has time; so a hung probe is still killed at its cap and replaced while claims keep arriving.
 * It authorizes nothing: a claim still fails closed when the identity is not known by its own deadline. Only a
 * well-formed read identity is cached; an unknown one never is, and a later call starts again.
 *
 * Nothing here keeps the process alive or outlives it: the probe, its pipes and its timers are unref'd, and a probe
 * still running when the process exits is killed. A waiting claim keeps the loop alive with its own deadline timer.
 * Without `waitUntil` it resolves when the preparation ends, but holds nothing alive meanwhile: a top-level
 * `await prepareCurrentProcessBirthFingerprint()` with nothing else running exits the process (code 13, unsettled
 * top-level await). A caller that awaits it passes `waitUntil`, an absolute time: it resolves then at the latest,
 * keeping the process alive until then. Resolves to the fingerprint, or to undefined when it is not known; never
 * rejects.
 * Elsewhere the sync probe is a /proc read or one `ps`, and this resolves to undefined at once.
 */
export function prepareCurrentProcessBirthFingerprint(waitUntil) {
  if (cachedCurrentBirth?.state === "same") return Promise.resolve(cachedCurrentBirth.fingerprint);
  if (process.platform !== "win32") return Promise.resolve(undefined);
  if (waitUntil === undefined) return startCurrentBirthPreparation().promise;
  if (!Number.isFinite(waitUntil)) return Promise.resolve(undefined);
  return waitForPreparedBirth(waitUntil).then(() => cachedCurrentBirth?.state === "same" ? cachedCurrentBirth.fingerprint : undefined);
}

/** Diagnostics and tests: "known", "preparing" (a background preparation runs) or "idle". */
export function currentProcessBirthPreparation() {
  return cachedCurrentBirth?.state === "same" ? "known" : preparingCurrentBirth ? "preparing" : "idle";
}

function startCurrentBirthPreparation() {
  if (preparingCurrentBirth) return preparingCurrentBirth;
  const preparation = { waiters: new Set(), promise: undefined };
  preparingCurrentBirth = preparation;
  preparation.promise = learnCurrentProcessBirth(preparation)
    .catch(() => undefined)
    .finally(() => { if (preparingCurrentBirth === preparation) preparingCurrentBirth = undefined; });
  return preparation;
}

async function learnCurrentProcessBirth(preparation) {
  const startedAt = Date.now();
  const delays = pollDelays(SELF_BIRTH_RETRY_DELAY_MS, SELF_BIRTH_MAX_RETRY_DELAY_MS);
  for (let attempt = 1; attempt <= SELF_BIRTH_MAX_PROBES; attempt += 1) {
    if (cachedCurrentBirth?.state === "same") return cachedCurrentBirth.fingerprint;
    const inspected = await inspectWindowsProcessBirthAsync(process.pid);
    if (inspected.state === "same") {
      cachedCurrentBirth ??= inspected;
      return cachedCurrentBirth.fingerprint;
    }
    if (inspected.state !== "unknown" || attempt === SELF_BIRTH_MAX_PROBES) return undefined;
    const delay = delays();
    const endAt = Math.max(startedAt + SELF_BIRTH_PROBE_CAP_MS, latestWaitingDeadline(preparation));
    if (Date.now() + delay >= endAt) return undefined;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, delay).unref?.(); });
  }
  return undefined;
}

function latestWaitingDeadline(preparation) {
  let latest = Number.NEGATIVE_INFINITY;
  for (const waiter of preparation.waiters) latest = Math.max(latest, waiter.deadline);
  return latest;
}

/** One cold probe, ended only by its answer or SELF_BIRTH_PROBE_CAP_MS from its start (then killed, "unknown"). */
function inspectWindowsProcessBirthAsync(pid) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let timer;
    let child;
    const kill = () => { try { child?.kill(); } catch {} };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("exit", kill);
      resolvePromise(result);
    };
    try {
      child = execFile("powershell.exe", windowsBirthProbeArguments(pid), { encoding: "utf8", windowsHide: true },
        (error, stdout) => finish(error ? { state: "unknown" } : parseWindowsBirthProbe(String(stdout).trim())));
    } catch {
      finish({ state: "unknown" });
      return;
    }
    child.unref?.();
    child.stdin?.unref?.();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    process.once("exit", kill);
    timer = setTimeout(() => { kill(); finish({ state: "unknown" }); }, SELF_BIRTH_PROBE_CAP_MS);
    timer.unref?.();
  });
}

/** Waits, keeping the process alive, until the identity is known ("known"), the preparation ended without it ("ended"), or the deadline ("expired"). */
function waitForPreparedBirth(deadline) {
  if (cachedCurrentBirth?.state === "same") return Promise.resolve("known");
  const preparation = startCurrentBirthPreparation();
  const waiter = { deadline };
  preparation.waiters.add(waiter);
  return new Promise((resolvePromise) => {
    let timer;
    const done = (outcome) => {
      clearTimeout(timer);
      preparation.waiters.delete(waiter);
      resolvePromise(outcome);
    };
    timer = setTimeout(() => done(cachedCurrentBirth?.state === "same" ? "known" : "expired"), Math.max(0, deadline - Date.now()));
    preparation.promise.then(() => done(cachedCurrentBirth?.state === "same" ? "known" : "ended"));
  });
}

/**
 * withOwnedFenceLock on Windows: when this process's own birth identity is not known yet, wait for the background
 * preparation (starting it if none runs) inside the caller's own deadline, and hand acquire that same deadline, so
 * the wait and the acquisition together never run past it. Still unknown at the deadline: the claim fails closed
 * with the same error as before, and the preparation goes on for the next one. A preparation that ended without the
 * identity leaves acquire its usual sync probe in the time left. Invalid bounds and an already spent deadline go
 * straight to acquire, which refuses them with its own errors.
 */
async function awaitPreparedHolderBirth(options) {
  if (process.platform !== "win32" || options.holderBirth !== undefined || cachedCurrentBirth?.state === "same") return options;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) return options;
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= 0)) return options;
  const deadline = Math.min(Date.now() + deadlineMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);
  if (Date.now() >= deadline) return options;
  const outcome = await waitForPreparedBirth(deadline);
  if (outcome === "expired" && cachedCurrentBirth?.state !== "same")
    throw new OwnedFenceLockUnavailableError("Current owned fence holder birth identity is unavailable.");
  return { ...options, deadlineAt: deadline };
}

export async function retryRetiredOwnedFenceCleanup(path, cleanup, options = {}) {
  path = resolve(path);
  const authorityId = coordinationAuthorityId(path);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1)
    throw new OwnedFenceLockUnavailableError("Owned fence retired-cleanup bounds are invalid.");
  const pathIdentity = assertCoordinationPath(path);
  assertNoProtocolSidecars(path, pathIdentity);
  const deadline = Date.now() + deadlineMs;
  let database;
  try {
    database = new DatabaseSync(sqliteDatabaseLocation(path));
    assertCoordinationPathIdentity(path, pathIdentity);
    database.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    await beginImmediateAsync(database, deadline, retryDelayMs);
    assertCoordinationPathIdentity(path, pathIdentity);
    assertRetiredProtocol(database, authorityId);
    assertCoordinationPathIdentity(path, pathIdentity);
    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    throw normalizeUnavailable(error);
  } finally { database?.close(); }
  const removalAuthority = captureProtocolRemovalAuthority(path, pathIdentity, authorityId);
  revalidateProtocolRemovalAuthority(path, removalAuthority);
  cleanup();
}

export function retiredOwnedFenceCleanupAvailable(path) {
  path = resolve(path);
  const authorityId = coordinationAuthorityId(path);
  let database;
  try {
    const pathIdentity = assertCoordinationPath(path);
    assertNoProtocolSidecars(path, pathIdentity);
    database = new DatabaseSync(sqliteDatabaseLocation(path), { readOnly: true });
    assertCoordinationPathSnapshot(path, pathIdentity);
    assertRetiredProtocol(database, authorityId);
    return true;
  } catch { return false; }
  finally { database?.close(); }
}

function* acquireSteps(path, options) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1)
    throw new OwnedFenceLockUnavailableError("Owned fence lock bounds are invalid.");
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= 0))
    throw new OwnedFenceLockUnavailableError("Owned fence absolute deadline is invalid.");
  const startedAt = Date.now();
  const trace = { startedAt, birthMs: 0, openMs: 0, attempts: 0, busy: 0, inspections: 0, inspectionMs: 0, holder: undefined, holderRead: false };
  const deadline = Math.min(startedAt + deadlineMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);
  if (Date.now() >= deadline)
    throw withAcquisitionTrace(new OwnedFenceContentionError("Owned fence acquisition deadline is exhausted."), path, trace, "starting");
  const holderPid = options.holderPid ?? process.pid;
  const holderBirth = options.holderBirth ?? currentProcessBirthFingerprint(deadline - Date.now());
  trace.birthMs = Date.now() - startedAt;
  if (!Number.isSafeInteger(holderPid) || holderPid < 1 || typeof holderBirth !== "string" || holderBirth.length === 0)
    throw new OwnedFenceLockUnavailableError("Owned fence holder identity is invalid.");
  const acquisitionId = randomUUID();
  if (Date.now() >= deadline)
    throw withAcquisitionTrace(new OwnedFenceContentionError("Owned fence acquisition deadline is exhausted."), path, trace, "starting");
  const authorityId = coordinationAuthorityId(path);
  let opened;
  try { opened = yield* openProtocolSteps(path, authorityId, deadline, retryDelayMs, options.assertAuthority, acquisitionId); }
  catch (error) { trace.openMs = Date.now() - startedAt - trace.birthMs; throw withAcquisitionTrace(error, path, trace, "opening"); }
  const { database, pathIdentity } = opened;
  trace.openMs = Date.now() - startedAt - trace.birthMs;
  const context = {
    path, pathIdentity, database, acquisitionId, holderPid, holderBirth, authorityId, deadline, retryDelayMs,
    inspectHolder: options.inspectHolder ?? defaultInspectHolder,
    // An injected inspector is called as it is by both drivers; only the default one has a non-blocking form.
    inspectHolderAsync: options.inspectHolder ?? defaultInspectHolderAsync,
    afterClaim: options.afterClaim,
    // Tests only (like afterClaim): a shorter release window than the default, so a test can outlast it quickly.
    releaseWindowMs: Number.isSafeInteger(options.releaseWindowMs) && options.releaseWindowMs > 0 ? options.releaseWindowMs : DEFAULT_DEADLINE_MS,
    trace,
  };
  let proposalInserted = false;
  let claimed = false;
  try {
    if (tryProposeAndClaimFree(context)) {
      proposalInserted = true;
      claimed = true;
      retainedHolders.delete(path);
      liveAcquisitions.set(path, acquisitionId);
      context.afterClaim?.();
      return context;
    }
    const proposalDelays = pollDelays(retryDelayMs);
    while (!proposalInserted) {
      try {
        assertCoordinationPathIdentity(path, pathIdentity);
        database.prepare("INSERT INTO owned_fence_acquisition(acquisition_id, holder_pid, holder_birth) VALUES (?, ?, ?)")
          .run(acquisitionId, holderPid, holderBirth);
        proposalInserted = true;
      } catch (error) {
        if (isBusy(error)) trace.busy += 1;
        if (!isBusy(error) || Date.now() >= deadline)
          throw isBusy(error)
            ? new OwnedFenceContentionError(`Owned fence lock remains held by an exact live holder${describeHolder(database)}.`, { cause: error })
            : error;
        yield sleepStep(Math.min(proposalDelays(), Math.max(1, deadline - Date.now())), path, acquisitionId);
      }
    }
    const claimDelays = pollDelays(retryDelayMs);
    for (;;) {
      if (yield* tryClaimSteps(context)) {
        claimed = true;
        retainedHolders.delete(path);
        liveAcquisitions.set(path, acquisitionId);
        context.afterClaim?.();
        return context;
      }
      if (Date.now() >= deadline)
        throw new OwnedFenceContentionError("Owned fence lock remains held by an exact live holder.");
      yield sleepStep(Math.min(claimDelays(), Math.max(1, deadline - Date.now())), path, acquisitionId);
    }
  } catch (error) {
    if (!proposalInserted) {
      const thrown = withRetainedHolderContext(withAcquisitionTrace(normalizeUnavailable(error), path, trace, "proposing"), path, database);
      database.close();
      throw thrown;
    }
    if (claimed) {
      const released = yield* releaseUnstartedAcquisitionSteps(context, error);
      try { database.close(); }
      finally { forgetLiveAcquisition(context); }
      throw released;
    }
    try {
      assertCoordinationPathIdentity(path, pathIdentity);
      database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(acquisitionId);
    }
    catch (cleanupError) {
      database.close();
      throw new AggregateError([error, cleanupError], "Owned fence acquisition and proposal cleanup both failed.", { cause: error });
    }
    const thrown = withRetainedHolderContext(withAcquisitionTrace(normalizeUnavailable(error), path, trace, "claiming"), path, database);
    database.close();
    throw thrown;
  }
}

function* openProtocolSteps(path, authorityId, deadline, retryDelayMs, assertAuthority, acquisitionId) {
  let observedProvisionalContention = false;
  const delays = pollDelays(retryDelayMs);
  const retry = (error) => waitForProtocolRetry(error, deadline, delays(), path, acquisitionId);
  for (;;) {
    let database;
    let pathIdentity;
    let provisionalSnapshot;
    let mayInitialize = false;
    let authorityRefused = false;
    let transactionOpen = false;
    try {
      let beforeOpenIdentity = assertCoordinationPath(path, true);
      try { assertProtocolObservation(path, beforeOpenIdentity, "before existing-path classification"); }
      catch (error) {
        if (beforeOpenIdentity && !coordinationPathCanRetry(path, beforeOpenIdentity)) throw error;
        yield retry(error);
        continue;
      }
      if (!beforeOpenIdentity) {
        provisionalSnapshot = reserveProtocolPath(path);
        if (!provisionalSnapshot) {
          observedProvisionalContention = true;
          yield retry(new OwnedFenceContentionError("Owned fence provisional coordination creation remained contested."));
          continue;
        }
        beforeOpenIdentity = provisionalSnapshot;
        mayInitialize = true;
        if (assertAuthority) {
          try { assertAuthority(); }
          catch (error) { authorityRefused = true; throw error; }
        }
        assertCoordinationPathSnapshot(path, provisionalSnapshot);
      } else {
        if (observedProvisionalContention && beforeOpenIdentity.size === "0") {
          yield retry(new OwnedFenceContentionError("Owned fence provisional coordination winner is not initialized yet."));
          continue;
        }
        try {
          beforeOpenIdentity = preflightExistingProtocol(path, beforeOpenIdentity, authorityId);
        } catch (error) {
          const retryable = observedProvisionalContention || error instanceof OwnedFenceProtocolObservationChangedError || isBusy(error);
          if (!retryable || !coordinationPathCanRetry(path, beforeOpenIdentity, observedProvisionalContention)) throw error;
          yield retry(error);
          continue;
        }
      }
      try { assertProtocolObservation(path, beforeOpenIdentity, "before read-write open"); }
      catch (error) {
        if (!coordinationPathCanRetry(path, beforeOpenIdentity)) throw error;
        yield retry(error);
        continue;
      }
      database = new DatabaseSync(sqliteDatabaseLocation(path));
      try {
        pathIdentity = assertCoordinationPath(path);
        if (!samePathSnapshot(beforeOpenIdentity, pathIdentity)) {
          if (!samePathIdentity(beforeOpenIdentity, pathIdentity))
            throw new OwnedFenceLockUnavailableError("Owned fence coordination path changed while it was opened.");
          throw new OwnedFenceProtocolObservationChangedError("Owned fence protocol bytes changed during read-write open.");
        }
        assertProtocolObservation(path, pathIdentity, "immediately after read-write open");
      } catch (error) {
        try { database.close(); } catch {}
        database = undefined;
        if (!(error instanceof OwnedFenceProtocolObservationChangedError) || !coordinationPathRetainsIdentity(path, beforeOpenIdentity))
          throw error;
        yield retry(error);
        continue;
      }
      database.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      assertCoordinationPathIdentity(path, pathIdentity);
      const objects = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map((row) => row.name));
      const required = ["owned_fence_protocol", "owned_fence_acquisition", "owned_fence_holder", "owned_fence_acquisition_immutable"];
      if (!mayInitialize && required.some((name) => !objects.has(name)))
        throw new OwnedFenceLockUnavailableError("Owned fence lock protocol metadata is incomplete or invalid.");
      if (mayInitialize) database.exec(`
        CREATE TABLE IF NOT EXISTS owned_fence_protocol(
          version INTEGER NOT NULL,
          retired INTEGER NOT NULL CHECK(retired IN (0, 1)),
          authority_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owned_fence_acquisition(
          acquisition_id TEXT PRIMARY KEY NOT NULL,
          holder_pid INTEGER NOT NULL,
          holder_birth TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS owned_fence_holder(
          lock_key TEXT PRIMARY KEY NOT NULL CHECK(lock_key = 'owned'),
          acquisition_id TEXT UNIQUE NOT NULL,
          holder_pid INTEGER NOT NULL,
          holder_birth TEXT NOT NULL,
          FOREIGN KEY(acquisition_id) REFERENCES owned_fence_acquisition(acquisition_id)
        );
        CREATE TRIGGER IF NOT EXISTS owned_fence_acquisition_immutable
        BEFORE UPDATE ON owned_fence_acquisition
        BEGIN SELECT RAISE(ABORT, 'owned fence acquisition identity is immutable'); END;
      `);
      const protocolColumns = tableColumns(database, "owned_fence_protocol");
      const migratingLegacy = sameColumns(protocolColumns, LEGACY_PROTOCOL_COLUMNS);
      if (migratingLegacy) {
        const legacyProposals = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()?.count);
        const legacyHolders = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count);
        if (legacyProposals !== 0 || legacyHolders !== 0)
          throw new OwnedFenceLockUnavailableError("Owned fence legacy coordination has unbound ownership and cannot be migrated.");
        assertCoordinationPathIdentity(path, pathIdentity);
        database.exec("ALTER TABLE owned_fence_protocol ADD COLUMN authority_id TEXT");
        database.prepare("UPDATE owned_fence_protocol SET authority_id = ? WHERE authority_id IS NULL").run(authorityId);
      } else if (!sameColumns(protocolColumns, PROTOCOL_COLUMNS)) {
        throw new OwnedFenceLockUnavailableError("Owned fence lock protocol metadata is invalid.");
      }
      if (mayInitialize || migratingLegacy) database.exec(`
        CREATE TRIGGER IF NOT EXISTS ${AUTHORITY_UPDATE_TRIGGER}
        BEFORE UPDATE OF authority_id ON owned_fence_protocol
        BEGIN SELECT RAISE(ABORT, 'owned fence authority identity is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS ${AUTHORITY_DELETE_TRIGGER}
        BEFORE DELETE ON owned_fence_protocol
        BEGIN SELECT RAISE(ABORT, 'owned fence authority identity cannot be deleted'); END;
      `);
      assertCanonicalProtocolSchema(database, "current");
      const version = database.prepare("SELECT version, authority_id AS authorityId FROM owned_fence_protocol").all();
      if (version.length === 0 && mayInitialize)
        database.prepare("INSERT INTO owned_fence_protocol(version, retired, authority_id) VALUES (?, 0, ?)").run(PROTOCOL_VERSION, authorityId);
      else if (version.length !== 1 || version[0].version !== PROTOCOL_VERSION || version[0].authorityId !== authorityId)
        throw new OwnedFenceLockUnavailableError("Owned fence lock protocol metadata is invalid.");
      const protocol = database.prepare("SELECT retired FROM owned_fence_protocol").get();
      if (!protocol || protocol.retired !== 0)
        throw new OwnedFenceLockUnavailableError("Owned fence lock protocol is retired or invalid.");
      assertCoordinationPathIdentity(path, pathIdentity);
      database.exec("COMMIT");
      transactionOpen = false;
      database.exec("PRAGMA foreign_keys=ON;");
      return { database, pathIdentity };
    } catch (error) {
      if (transactionOpen) rollbackQuietly(database);
      try { database?.close(); } catch {}
      if (mayInitialize && authorityRefused) {
        try {
          const removalAuthority = Object.freeze({ authorityId, mainSnapshot: provisionalSnapshot });
          yield* removeProtocolPathSteps(path, removalAuthority);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Owned fence authority refusal and coordination cleanup both failed.", { cause: error });
        }
        throw error;
      }
      if (!isBusy(error) || Date.now() >= deadline) throw normalizeUnavailable(error);
      yield retry(error);
    }
  }
}

function acquisitionTimeRemaining(context) {
  const remaining = context.deadline - Date.now();
  if (remaining <= 0)
    throw new OwnedFenceContentionError("Owned fence acquisition deadline is exhausted.");
  return remaining;
}
function holderProposal(database) {
  return database.prepare(`
    SELECT h.acquisition_id AS acquisitionId, h.holder_pid AS holderPid,
           h.holder_birth AS holderBirth, a.holder_pid AS proposalPid,
           a.holder_birth AS proposalBirth
    FROM owned_fence_holder h
    LEFT JOIN owned_fence_acquisition a ON a.acquisition_id = h.acquisition_id
    WHERE h.lock_key = 'owned'
  `).get();
}
function sameHolderProposal(left, right) {
  return left && right && ["acquisitionId", "holderPid", "holderBirth", "proposalPid", "proposalBirth"]
    .every(key => left[key] === right[key]);
}
function* tryClaimSteps(context) {
  const { path, pathIdentity, database, acquisitionId, holderPid, holderBirth, authorityId, inspectHolder, inspectHolderAsync, trace } = context;
  let observed, inspection;
  trace.attempts += 1;
  try {
    acquisitionTimeRemaining(context);
    assertCoordinationPathIdentity(path, pathIdentity);
    assertActiveProtocol(database, authorityId);
    observed = holderProposal(database);
  } catch (error) {
    if (isBusy(error)) { trace.busy += 1; return false; }
    throw error;
  }
  trace.holderRead = true;
  trace.holder = observed && observed.acquisitionId !== acquisitionId
    ? { pid: Number(observed.holderPid), self: Number(observed.holderPid) === holderPid && observed.holderBirth === holderBirth, acquisitionId: String(observed.acquisitionId) }
    : undefined;
  if (observed) {
    if (!validHolderRow(observed))
      throw new OwnedFenceLockUnavailableError("Owned fence holder metadata is corrupt or incomplete.");
    if (observed.acquisitionId !== acquisitionId) {
      const retained = retainedHolders.get(path);
      if (retained?.unstarted === true && retained.acquisitionId === observed.acquisitionId &&
          Number(observed.holderPid) === retained.holderPid && observed.holderBirth === retained.holderBirth) {
        // This instance claimed that exact row and never started its effect; nothing else will release it.
        inspection = "unstarted_self";
      } else {
        // Inspector failures are identity uncertainty, never SQLite coordination retries.
        const remaining = acquisitionTimeRemaining(context);
        const inspectedAt = Date.now();
        trace.inspections += 1;
        const seenPid = Number(observed.holderPid);
        const seenBirth = String(observed.holderBirth);
        try {
          inspection = yield {
            kind: "call",
            sync: () => inspectHolder(seenPid, seenBirth, remaining),
            async: () => inspectHolderAsync(seenPid, seenBirth, remaining),
          };
        }
        catch (cause) {
          throw new OwnedFenceIdentityInspectionError("Owned fence holder inspection failed.", { cause });
        }
        finally { trace.inspectionMs += Date.now() - inspectedAt; }
        acquisitionTimeRemaining(context);
        if (inspection === "same") return false;
        if (inspection !== "absent" && inspection !== "birth_mismatch")
          throw new OwnedFenceIdentityInspectionError("Owned fence holder inspection is unavailable or uncertain.");
      }
    }
  }
  acquisitionTimeRemaining(context);
  try { database.exec("BEGIN IMMEDIATE"); }
  catch (error) { if (isBusy(error)) { trace.busy += 1; return false; } throw error; }
  try {
    acquisitionTimeRemaining(context);
    assertCoordinationPathIdentity(path, pathIdentity);
    assertActiveProtocol(database, authorityId);
    const row = holderProposal(database);
    if (!row) {
      acquisitionTimeRemaining(context);
      insertHolder(database, acquisitionId, holderPid, holderBirth);
      assertCoordinationPathIdentity(path, pathIdentity);
      acquisitionTimeRemaining(context);
      database.exec("COMMIT");
      return true;
    }
    if (!validHolderRow(row))
      throw new OwnedFenceLockUnavailableError("Owned fence holder metadata is corrupt or incomplete.");
    if (row.acquisitionId === acquisitionId) {
      assertCoordinationPathIdentity(path, pathIdentity);
      acquisitionTimeRemaining(context);
      database.exec("COMMIT");
      return true;
    }
    if (!sameHolderProposal(observed, row)) { database.exec("ROLLBACK"); return false; }
    if (inspection !== "absent" && inspection !== "birth_mismatch" && inspection !== "unstarted_self")
      throw new OwnedFenceIdentityInspectionError("Owned fence stale-holder observation is unavailable.");
    acquisitionTimeRemaining(context);
    const update = database.prepare(`
      UPDATE owned_fence_holder
      SET acquisition_id = ?, holder_pid = ?, holder_birth = ?
      WHERE lock_key = 'owned' AND acquisition_id = ? AND holder_pid = ? AND holder_birth = ?
    `).run(acquisitionId, holderPid, holderBirth, row.acquisitionId, row.holderPid, row.holderBirth);
    if (Number(update.changes) !== 1)
      throw new OwnedFenceLockUnavailableError("Owned fence stale-holder election changed concurrently.");
    database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(row.acquisitionId);
    assertCoordinationPathIdentity(path, pathIdentity);
    acquisitionTimeRemaining(context);
    database.exec("COMMIT");
    return true;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

// Uncontended fast path. When no holder row exists, the proposal and the claim commit in one
// IMMEDIATE transaction. That leaves exactly the rows the two-step path leaves when no writer
// runs between its proposal and its claim, with one durable commit instead of two. Any holder
// row (live, stale, or this instance's own unstarted one), any busy result, or anything else
// unusual rolls back with nothing committed, and the caller takes the two-step path unchanged.
function tryProposeAndClaimFree(context) {
  const { path, pathIdentity, database, acquisitionId, holderPid, holderBirth, authorityId, trace } = context;
  try { database.exec("BEGIN IMMEDIATE"); }
  catch (error) { if (isBusy(error)) { trace.busy += 1; return false; } throw error; }
  try {
    acquisitionTimeRemaining(context);
    assertCoordinationPathIdentity(path, pathIdentity);
    assertActiveProtocol(database, authorityId);
    if (holderProposal(database)) { database.exec("ROLLBACK"); return false; }
    trace.attempts += 1;
    trace.holderRead = true;
    database.prepare("INSERT INTO owned_fence_acquisition(acquisition_id, holder_pid, holder_birth) VALUES (?, ?, ?)")
      .run(acquisitionId, holderPid, holderBirth);
    insertHolder(database, acquisitionId, holderPid, holderBirth);
    assertCoordinationPathIdentity(path, pathIdentity);
    acquisitionTimeRemaining(context);
    database.exec("COMMIT");
    return true;
  } catch (error) {
    rollbackQuietly(database);
    if (isBusy(error)) { trace.busy += 1; return false; }
    throw error;
  }
}

function insertHolder(database, acquisitionId, holderPid, holderBirth) {
  database.prepare("INSERT INTO owned_fence_holder(lock_key, acquisition_id, holder_pid, holder_birth) VALUES ('owned', ?, ?, ?)")
    .run(acquisitionId, holderPid, holderBirth);
}

function* beginEffectSteps(context) {
  const { path, pathIdentity, database, acquisitionId, holderPid, holderBirth, authorityId, deadline, retryDelayMs } = context;
  const delays = pollDelays(retryDelayMs);
  for (;;) {
    try { database.exec("BEGIN IMMEDIATE"); break; }
    catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw normalizeUnavailable(error);
      yield sleepStep(Math.min(delays(), Math.max(1, deadline - Date.now())), path, acquisitionId);
    }
  }
  assertCoordinationPathIdentity(path, pathIdentity);
  assertActiveProtocol(database, authorityId);
  const row = database.prepare("SELECT acquisition_id AS acquisitionId, holder_pid AS holderPid, holder_birth AS holderBirth FROM owned_fence_holder WHERE lock_key = 'owned'").get();
  if (!row || row.acquisitionId !== acquisitionId || Number(row.holderPid) !== holderPid || row.holderBirth !== holderBirth) {
    rollbackQuietly(database);
    throw new OwnedFenceLockUnavailableError("Owned fence acquisition identity changed before the effect boundary.");
  }
}

function finalizeEffect(context, primaryError, retireAfterEffect) {
  const { path, pathIdentity, database, acquisitionId } = context;
  try {
    assertCoordinationPathIdentity(path, pathIdentity);
    const removed = database.prepare("DELETE FROM owned_fence_holder WHERE lock_key = 'owned' AND acquisition_id = ?").run(acquisitionId);
    if (Number(removed.changes) !== 1)
      throw new OwnedFenceLockUnavailableError("Owned fence holder finalization lost its exact acquisition identity.");
    database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(acquisitionId);
    if (retireAfterEffect && primaryError === undefined) {
      database.prepare("DELETE FROM owned_fence_acquisition").run();
      database.prepare("UPDATE owned_fence_protocol SET retired = 1 WHERE retired = 0").run();
    }
    assertCoordinationPathIdentity(path, pathIdentity);
    database.exec("COMMIT");
    return retireAfterEffect && primaryError === undefined;
  } catch (error) {
    rollbackQuietly(database);
    const cleanupError = normalizeUnavailable(error);
    const failure = primaryError !== undefined
      ? new AggregateError([primaryError, cleanupError], "Owned fence effect and finalization both failed.", { cause: primaryError })
      : cleanupError;
    // The effect ran but its release did not commit, so the exact holder stays (never stolen).
    if (currentHolderId(database) === acquisitionId) retainedHolders.set(path, retainedEntry(context, failure, false));
    throw failure;
  }
}

// The holder row is committed but the effect never started, so releasing that exact row is
// unambiguous. Left in place it would hold this path against this process's own live PID, and every
// later acquisition here would wait out its whole deadline ("Owned fence acquisition deadline is
// exhausted.", the Windows T8 factory wedge). The release re-checks the coordination path identity
// and is bounded; if it cannot commit, the holder is kept, recorded, and both failures are reported.
function* releaseUnstartedAcquisitionSteps(context, error) {
  const { path, pathIdentity, database, acquisitionId, retryDelayMs, releaseWindowMs } = context;
  // A fresh window: the claim's own deadline may be spent already. Its contention is the claim's, so it gets the
  // same measured default (OWNED_FENCE_DEFAULT_DEADLINE_MS).
  const deadline = Date.now() + releaseWindowMs;
  const delays = pollDelays(retryDelayMs);
  try {
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE"); break; }
      catch (busy) {
        if (!isBusy(busy) || Date.now() >= deadline) throw busy;
        yield sleepStep(Math.min(delays(), Math.max(1, deadline - Date.now())), path, acquisitionId);
      }
    }
    try {
      assertCoordinationPathIdentity(path, pathIdentity);
      database.prepare("DELETE FROM owned_fence_holder WHERE lock_key = 'owned' AND acquisition_id = ?").run(acquisitionId);
      database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(acquisitionId);
      for (;;) {
        // Re-check before every attempt: a busy COMMIT can be retried for the whole window, and nothing
        // may be committed through a coordination path that was replaced or gained a link meanwhile.
        // This wait holds an uncommitted write transaction. The async driver may still yield it: other async
        // claims on this path are serialized behind this one, and a same-thread sync claim refuses at its first
        // wait, since this acquisition is still live (performStepSync).
        assertCoordinationPathIdentity(path, pathIdentity);
        try { database.exec("COMMIT"); break; }
        catch (busy) {
          if (!isBusy(busy) || Date.now() >= deadline) throw busy;
          yield sleepStep(Math.min(delays(), Math.max(1, deadline - Date.now())), path, acquisitionId);
        }
      }
    } catch (releaseError) {
      rollbackQuietly(database);
      throw releaseError;
    }
    return error;
  } catch (releaseError) {
    // If even this read fails, nothing is recorded and the holder stays until the process exits (fail closed).
    if (currentHolderId(database) === acquisitionId) retainedHolders.set(path, retainedEntry(context, error, true));
    const message = error instanceof Error ? error.message : String(error);
    return new AggregateError([error, normalizeUnavailable(releaseError)],
      `${message} Its claimed holder could not be released.`, { cause: error });
  }
}

function forgetLiveAcquisition(context) {
  if (liveAcquisitions.get(context.path) === context.acquisitionId) liveAcquisitions.delete(context.path);
}

// A contention failure says where its deadline went and who held the lock, so a hosted failure can
// tell a holder that is live here, a row this module does not know, another process, and a slow
// phase with no holder at all apart. It only appends to the message; the error class is unchanged.
function withAcquisitionTrace(error, path, trace, phase) {
  if (!(error instanceof OwnedFenceContentionError) || tracedErrors.has(error)) return error;
  const holder = trace.holder;
  const known = !holder ? "" : liveAcquisitions.get(path) === holder.acquisitionId ? ", live in this module"
    : retainedHolders.get(path)?.acquisitionId === holder.acquisitionId ? ", retained by this module" : ", not held by this module";
  const holderText = !trace.holderRead ? "holder not read" : !holder ? "no other holder seen"
    : `holder PID ${holder.pid} (${holder.self ? "this process" : "another process"}), acquisition ${holder.acquisitionId}${known}`;
  const Kind = error.constructor;
  const traced = new Kind(`${error.message} [${basename(path)} while ${phase}, after ${Date.now() - trace.startedAt} ms: ` +
    `self-birth ${trace.birthMs} ms, open ${trace.openMs} ms, ${trace.attempts} claim attempts, ${trace.busy} busy, ` +
    `${trace.inspections} holder inspections (${trace.inspectionMs} ms), ${holderText}]`, { cause: error });
  tracedErrors.add(traced);
  return traced;
}

function retainedEntry(context, failure, unstarted) {
  return { acquisitionId: context.acquisitionId, holderPid: context.holderPid, holderBirth: context.holderBirth, failure, unstarted };
}

function currentHolderId(database) {
  try { return database.prepare("SELECT acquisition_id AS acquisitionId FROM owned_fence_holder WHERE lock_key = 'owned'").get()?.acquisitionId; }
  catch { return undefined; }
}

function withRetainedHolderContext(error, path, database) {
  const retained = retainedHolders.get(path);
  const Kind = error?.constructor;
  if (!retained || ![OwnedFenceLockUnavailableError, OwnedFenceContentionError, OwnedFenceIdentityInspectionError].includes(Kind) ||
      currentHolderId(database) !== retained.acquisitionId) return error;
  return new Kind(`${error.message} The holder is retained by this process (PID ${retained.holderPid}), acquisition ` +
    `${retained.acquisitionId}, after: ${describeFailure(retained.failure)}`, { cause: error });
}

function describeFailure(error) {
  const parts = [];
  const seen = new Set();
  for (let node = error; node instanceof Error && !seen.has(node) && parts.length < 6; node = node.cause) {
    seen.add(node);
    parts.push(node instanceof AggregateError
      ? `${node.message} [${node.errors.map((entry) => entry instanceof Error ? entry.message : String(entry)).join("; ")}]`
      : node.message);
  }
  const text = parts.join(" <- ");
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

function assertActiveProtocol(database, authorityId) {
  const protocol = database.prepare("SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol").all();
  if (protocol.length !== 1 || protocol[0].version !== PROTOCOL_VERSION || protocol[0].retired !== 0 || protocol[0].authorityId !== authorityId)
    throw new OwnedFenceLockUnavailableError("Owned fence lock protocol is retired or invalid.");
}

function assertRecoverableProtocol(database, authorityId, options = {}) {
  assertCanonicalProtocolSchema(database, "current", options);
  const protocol = database.prepare("SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol").all();
  if (protocol.length !== 1 || protocol[0].version !== PROTOCOL_VERSION || ![0, 1].includes(protocol[0].retired) || protocol[0].authorityId !== authorityId)
    throw new OwnedFenceLockUnavailableError("Owned fence revocation protocol is corrupt or foreign.");
  const proposals = database.prepare("SELECT acquisition_id AS acquisitionId, holder_pid AS holderPid, holder_birth AS holderBirth FROM owned_fence_acquisition").all();
  if (proposals.some((row) => typeof row.acquisitionId !== "string" || !/^[0-9a-f-]{36}$/i.test(row.acquisitionId) ||
      !Number.isSafeInteger(Number(row.holderPid)) || Number(row.holderPid) < 1 || typeof row.holderBirth !== "string" || row.holderBirth.length === 0))
    throw new OwnedFenceLockUnavailableError("Owned fence revocation proposals are corrupt or foreign.");
  const holders = database.prepare(`
    SELECT h.acquisition_id AS acquisitionId, h.holder_pid AS holderPid, h.holder_birth AS holderBirth,
           a.holder_pid AS proposalPid, a.holder_birth AS proposalBirth
    FROM owned_fence_holder h LEFT JOIN owned_fence_acquisition a ON a.acquisition_id = h.acquisition_id
  `).all();
  if (holders.length > 1 || holders.some((row) => !validHolderRow(row)))
    throw new OwnedFenceLockUnavailableError("Owned fence revocation holder is corrupt or foreign.");
}

function coordinationAuthorityId(path) {
  const normalized = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return createHash("sha256").update(`aiboard-owned-fence-path/v1\0${normalized}`).digest("hex");
}

function regularFileSnapshot(status, subject) {
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1n)
    throw new OwnedFenceLockUnavailableError(`${subject} is aliased, linked, or invalid.`);
  return Object.freeze({
    device: status.dev.toString(),
    inode: status.ino.toString(),
    birthtimeNs: status.birthtimeNs.toString(),
    changeTimeNs: status.ctimeNs.toString(),
    modifiedTimeNs: status.mtimeNs.toString(),
    size: status.size.toString(),
  });
}

function readRegularPathIdentity(path, allowMissing, subject) {
  try {
    const status = lstatSync(path, { bigint: true });
    return regularFileSnapshot(status, subject);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    if (error instanceof OwnedFenceLockUnavailableError) throw error;
    throw new OwnedFenceLockUnavailableError(`${subject} is unavailable.`, { cause: error });
  }
}

function assertCoordinationPath(path, allowMissing = false) {
  return readRegularPathIdentity(path, allowMissing, "Owned fence coordination path");
}

function assertSidecarPath(path, allowMissing = false) {
  return readRegularPathIdentity(path, allowMissing, "Owned fence coordination sidecar");
}

function samePathIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode && left?.birthtimeNs === right?.birthtimeNs;
}

function samePathSnapshot(left, right) {
  return samePathIdentity(left, right) && left?.changeTimeNs === right?.changeTimeNs &&
    left?.modifiedTimeNs === right?.modifiedTimeNs && left?.size === right?.size;
}

function assertCoordinationPathIdentity(path, expected) {
  const current = assertCoordinationPath(path);
  if (!expected || !samePathIdentity(current, expected))
    throw new OwnedFenceLockUnavailableError("Owned fence coordination path identity was replaced or disappeared.");
  return current;
}

function assertCoordinationPathSnapshot(path, expected) {
  const current = assertCoordinationPath(path);
  if (!expected || !samePathSnapshot(current, expected))
    throw new OwnedFenceLockUnavailableError("Owned fence coordination path changed, was replaced, or disappeared.");
  return current;
}

function coordinationPathRetainsIdentity(path, expected) {
  try { return samePathIdentity(assertCoordinationPath(path), expected); }
  catch { return false; }
}

function coordinationPathCanRetry(path, expected, allowMissing = false) {
  try {
    const current = assertCoordinationPath(path, true);
    return current ? samePathIdentity(current, expected) : allowMissing;
  } catch { return false; }
}

function reserveProtocolPath(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
    const handleSnapshot = regularFileSnapshot(fstatSync(descriptor, { bigint: true }), "Owned fence provisional coordination file");
    const pathSnapshot = assertCoordinationPath(path);
    if (!samePathSnapshot(handleSnapshot, pathSnapshot))
      throw new OwnedFenceLockUnavailableError("Owned fence provisional coordination identity changed during exclusive creation.");
    closeSync(descriptor);
    descriptor = undefined;
    return pathSnapshot;
  } catch (error) {
    if (error?.code === "EEXIST") return;
    if (error instanceof OwnedFenceLockUnavailableError) throw error;
    throw new OwnedFenceLockUnavailableError("Owned fence provisional coordination creation is unavailable.", { cause: error });
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor); } catch {}
  }
}

/** The wait before the next open attempt, or the error itself once the deadline is spent. */
function waitForProtocolRetry(error, deadline, delayMs, path, acquisitionId) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw normalizeUnavailable(error);
  return sleepStep(Math.min(delayMs, remainingMs), path, acquisitionId);
}

function assertProtocolObservation(path, mainSnapshot, stage) {
  try {
    if (mainSnapshot) assertCoordinationPathSnapshot(path, mainSnapshot);
    assertNoProtocolSidecars(path, mainSnapshot);
    if (mainSnapshot) return assertCoordinationPathSnapshot(path, mainSnapshot);
  } catch (error) {
    if (mainSnapshot) {
      try { assertCoordinationPathIdentity(path, mainSnapshot); }
      catch (identityError) { throw identityError; }
    }
    throw new OwnedFenceProtocolObservationChangedError(
      `Owned fence protocol changed or gained an uncertain sidecar ${stage}.`,
      { cause: error },
    );
  }
}

function preflightExistingProtocol(path, expectedSnapshot, authorityId) {
  assertProtocolObservation(path, expectedSnapshot, "before read-only preflight open");
  let database;
  let validatedSnapshot;
  try {
    database = new DatabaseSync(sqliteDatabaseLocation(path), { readOnly: true });
    assertProtocolObservation(path, expectedSnapshot, "immediately after read-only preflight open");
    assertExistingProtocolPreflight(database, authorityId);
    validatedSnapshot = assertProtocolObservation(path, expectedSnapshot, "after read-only validation");
  } finally { database?.close(); }
  return validatedSnapshot;
}

function assertExistingProtocolPreflight(database, authorityId) {
  const journal = database.prepare("PRAGMA journal_mode").get();
  if (!journal || String(journal.journal_mode).toLowerCase() !== "delete")
    throw new OwnedFenceLockUnavailableError("Owned fence lock protocol uses an unsupported or foreign journal mode.");

  const protocolColumns = tableColumns(database, "owned_fence_protocol");
  if (sameColumns(protocolColumns, PROTOCOL_COLUMNS)) {
    assertRecoverableProtocol(database, authorityId);
    assertActiveProtocol(database, authorityId);
    return;
  }
  if (!sameColumns(protocolColumns, LEGACY_PROTOCOL_COLUMNS))
    throw new OwnedFenceLockUnavailableError("Owned fence lock protocol metadata is invalid.");
  assertCanonicalProtocolSchema(database, "legacy");
  const protocol = database.prepare("SELECT version, retired FROM owned_fence_protocol").all();
  const proposals = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()?.count);
  const holders = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count);
  if (protocol.length !== 1 || protocol[0].version !== PROTOCOL_VERSION || protocol[0].retired !== 0 || proposals !== 0 || holders !== 0)
    throw new OwnedFenceLockUnavailableError("Owned fence legacy coordination has unbound ownership and cannot be migrated.");
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
}

function sameColumns(actual, expected) {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function assertCanonicalProtocolSchema(database, variant, options = {}) {
  const expected = new Map([
    ["owned_fence_acquisition", canonicalSchemaObject("table", "owned_fence_acquisition", CANONICAL_ACQUISITION_TABLE_SQL)],
    ["owned_fence_holder", canonicalSchemaObject("table", "owned_fence_holder", CANONICAL_HOLDER_TABLE_SQL)],
    ["owned_fence_protocol", canonicalSchemaObject("table", "owned_fence_protocol",
      ...(variant === "legacy"
        ? [CANONICAL_LEGACY_PROTOCOL_TABLE_SQL]
        : [CANONICAL_CURRENT_PROTOCOL_TABLE_SQL, CANONICAL_MIGRATED_PROTOCOL_TABLE_SQL]))],
    ["owned_fence_acquisition_immutable", canonicalSchemaObject("trigger", "owned_fence_acquisition", CANONICAL_ACQUISITION_TRIGGER_SQL)],
  ]);
  if (variant === "current") {
    expected.set(AUTHORITY_UPDATE_TRIGGER, canonicalSchemaObject("trigger", "owned_fence_protocol", CANONICAL_AUTHORITY_UPDATE_TRIGGER_SQL));
    expected.set(AUTHORITY_DELETE_TRIGGER, canonicalSchemaObject("trigger", "owned_fence_protocol", CANONICAL_AUTHORITY_DELETE_TRIGGER_SQL));
  }
  const rows = database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_master
  `).all();
  let protocolSql;
  for (const row of rows) {
    const descriptor = expected.get(row.name);
    if (descriptor) {
      if (row.type !== descriptor.type || row.tableName !== descriptor.tableName ||
          typeof row.sql !== "string" || !descriptor.sql.has(normalizeSchemaSql(row.sql)))
        throw new OwnedFenceLockUnavailableError("Owned fence protocol schema semantics are corrupt or foreign.");
      expected.delete(row.name);
      if (row.name === "owned_fence_protocol") protocolSql = normalizeSchemaSql(row.sql);
      continue;
    }
    if (canonicalAutoindex(row)) continue;
    if (options.allowHolderDeleteTriggers === true && recoverableHolderDeleteTrigger(row)) continue;
    throw new OwnedFenceLockUnavailableError("Owned fence protocol contains an extra or foreign schema object.");
  }
  if (expected.size !== 0)
    throw new OwnedFenceLockUnavailableError("Owned fence protocol canonical schema is incomplete.");
  assertCanonicalProtocolStructure(database, variant, protocolSql);
}

function canonicalSchemaObject(type, tableName, ...sql) {
  return Object.freeze({ type, tableName, sql: new Set(sql.map(normalizeSchemaSql)) });
}

function normalizeSchemaSql(sql) {
  return String(sql).trim().replace(/;+\s*$/, "").replace(/\s+/g, " ")
    .replace(/\s*([(),=])\s*/g, "$1");
}

function recoverableHolderDeleteTrigger(row) {
  return row?.type === "trigger" && row?.tableName === "owned_fence_holder" && typeof row.sql === "string" &&
    /\bbefore\s+delete\s+on\s+owned_fence_holder\b/i.test(row.sql);
}

function canonicalAutoindex(row) {
  return row?.type === "index" && row?.sql === null && CANONICAL_AUTOINDEX_TABLES.get(row.name) === row.tableName;
}

function assertCanonicalProtocolStructure(database, variant, protocolSql) {
  const protocolColumns = [
    canonicalColumn("version", "INTEGER", 1, 0),
    canonicalColumn("retired", "INTEGER", 1, 0),
  ];
  if (variant === "current") {
    const migrated = protocolSql === normalizeSchemaSql(CANONICAL_MIGRATED_PROTOCOL_TABLE_SQL);
    protocolColumns.push(canonicalColumn("authority_id", "TEXT", migrated ? 0 : 1, 0));
  }
  assertCanonicalFacts(tableStructure(database, "owned_fence_protocol"), protocolColumns,
    "Owned fence protocol table structure is corrupt or foreign.");
  assertCanonicalFacts(tableStructure(database, "owned_fence_acquisition"), [
    canonicalColumn("acquisition_id", "TEXT", 1, 1),
    canonicalColumn("holder_pid", "INTEGER", 1, 0),
    canonicalColumn("holder_birth", "TEXT", 1, 0),
  ], "Owned fence acquisition table structure is corrupt or foreign.");
  assertCanonicalFacts(tableStructure(database, "owned_fence_holder"), [
    canonicalColumn("lock_key", "TEXT", 1, 1),
    canonicalColumn("acquisition_id", "TEXT", 1, 0),
    canonicalColumn("holder_pid", "INTEGER", 1, 0),
    canonicalColumn("holder_birth", "TEXT", 1, 0),
  ], "Owned fence holder table structure is corrupt or foreign.");

  assertCanonicalFacts(indexStructure(database, "owned_fence_protocol"), [],
    "Owned fence protocol indexes are corrupt or foreign.");
  assertCanonicalFacts(indexStructure(database, "owned_fence_acquisition"), [{
    name: "sqlite_autoindex_owned_fence_acquisition_1", unique: 1, origin: "pk", partial: 0,
    columns: ["acquisition_id"],
  }], "Owned fence acquisition indexes are corrupt or foreign.");
  assertCanonicalFacts(indexStructure(database, "owned_fence_holder"), [{
    name: "sqlite_autoindex_owned_fence_holder_1", unique: 1, origin: "pk", partial: 0,
    columns: ["lock_key"],
  }, {
    name: "sqlite_autoindex_owned_fence_holder_2", unique: 1, origin: "u", partial: 0,
    columns: ["acquisition_id"],
  }], "Owned fence holder indexes are corrupt or foreign.");

  assertCanonicalFacts(foreignKeyStructure(database, "owned_fence_protocol"), [],
    "Owned fence protocol foreign keys are corrupt or foreign.");
  assertCanonicalFacts(foreignKeyStructure(database, "owned_fence_acquisition"), [],
    "Owned fence acquisition foreign keys are corrupt or foreign.");
  assertCanonicalFacts(foreignKeyStructure(database, "owned_fence_holder"), [{
    id: 0, sequence: 0, table: "owned_fence_acquisition", from: "acquisition_id", to: "acquisition_id",
    onUpdate: "NO ACTION", onDelete: "NO ACTION", match: "NONE",
  }], "Owned fence holder foreign keys are corrupt or foreign.");
}

function canonicalColumn(name, type, notNull, primaryKey) {
  return { name, type, notNull, defaultValue: null, primaryKey, hidden: 0 };
}

function tableStructure(database, table) {
  return database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all().map((row) => ({
    name: row.name,
    type: row.type,
    notNull: Number(row.notnull),
    defaultValue: row.dflt_value,
    primaryKey: Number(row.pk),
    hidden: Number(row.hidden),
  }));
}

function indexStructure(database, table) {
  return database.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all().map((row) => ({
    name: row.name,
    unique: Number(row.unique),
    origin: row.origin,
    partial: Number(row.partial),
    columns: database.prepare(`PRAGMA index_info(${quoteIdentifier(row.name)})`).all().map((column) => column.name),
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function foreignKeyStructure(database, table) {
  return database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all().map((row) => ({
    id: Number(row.id),
    sequence: Number(row.seq),
    table: row.table,
    from: row.from,
    to: row.to,
    onUpdate: row.on_update,
    onDelete: row.on_delete,
    match: row.match,
  }));
}

function assertCanonicalFacts(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new OwnedFenceLockUnavailableError(message);
}

function quoteIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }

function assertRetiredProtocol(database, authorityId) {
  assertRecoverableProtocol(database, authorityId);
  const protocol = database.prepare("SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol").all();
  const proposals = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()?.count);
  const holders = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count);
  if (protocol.length !== 1 || protocol[0].version !== PROTOCOL_VERSION || protocol[0].retired !== 1 ||
      protocol[0].authorityId !== authorityId || proposals !== 0 || holders !== 0)
    throw new OwnedFenceLockUnavailableError("Owned fence physical retirement authority is active, foreign, or incomplete.");
}

function assertNoProtocolSidecars(path, mainSnapshot) {
  for (const suffix of PROTOCOL_SIDECAR_SUFFIXES) {
    if (mainSnapshot) assertCoordinationPathSnapshot(path, mainSnapshot);
    if (assertSidecarPath(`${path}${suffix}`, true))
      throw new OwnedFenceLockUnavailableError("Owned fence coordination sidecar is present and remains uncertain.");
    if (mainSnapshot) assertCoordinationPathSnapshot(path, mainSnapshot);
  }
}

function captureProtocolRemovalAuthority(path, expectedMainIdentity, authorityId) {
  const preValidationSnapshot = assertCoordinationPathIdentity(path, expectedMainIdentity);
  assertNoProtocolSidecars(path, preValidationSnapshot);
  let database;
  try {
    database = new DatabaseSync(sqliteDatabaseLocation(path), { readOnly: true });
    assertCoordinationPathIdentity(path, expectedMainIdentity);
    assertRetiredProtocol(database, authorityId);
    assertCoordinationPathIdentity(path, expectedMainIdentity);
  } catch (error) { throw normalizeUnavailable(error); }
  finally { database?.close(); }
  const mainSnapshot = assertCoordinationPathIdentity(path, expectedMainIdentity);
  assertNoProtocolSidecars(path, mainSnapshot);
  assertCoordinationPathSnapshot(path, mainSnapshot);
  return Object.freeze({
    authorityId,
    mainSnapshot,
  });
}

function revalidateProtocolRemovalAuthority(path, authority) {
  if (!authority || authority.authorityId !== coordinationAuthorityId(path))
    throw new OwnedFenceLockUnavailableError("Owned fence physical retirement authority is missing or foreign.");
  assertCoordinationPathSnapshot(path, authority.mainSnapshot);
  assertNoProtocolSidecars(path, authority.mainSnapshot);
  let database;
  try {
    database = new DatabaseSync(sqliteDatabaseLocation(path), { readOnly: true });
    assertCoordinationPathSnapshot(path, authority.mainSnapshot);
    assertRetiredProtocol(database, authority.authorityId);
    assertCoordinationPathSnapshot(path, authority.mainSnapshot);
  } catch (error) { throw normalizeUnavailable(error); }
  finally { database?.close(); }
  assertCoordinationPathSnapshot(path, authority.mainSnapshot);
  assertNoProtocolSidecars(path, authority.mainSnapshot);
}

function* removeProtocolPathSteps(path, authority) {
  const deadline = Date.now() + DEFAULT_DEADLINE_MS;
  const delays = pollDelays(DEFAULT_RETRY_DELAY_MS);
  for (;;) {
    try {
      if (!authority || authority.authorityId !== coordinationAuthorityId(path))
        throw new OwnedFenceLockUnavailableError("Owned fence physical retirement authority is missing or foreign.");
      assertCoordinationPathSnapshot(path, authority.mainSnapshot);
      assertNoProtocolSidecars(path, authority.mainSnapshot);
      assertCoordinationPathSnapshot(path, authority.mainSnapshot);
      try { unlinkSync(path); }
      catch (error) {
        if (error?.code === "ENOENT")
          throw new OwnedFenceLockUnavailableError("Owned fence coordination path disappeared before physical retirement.", { cause: error });
        throw error;
      }
      return;
    }
    catch (error) {
      const code = error?.code ?? error?.cause?.code;
      if (!["EPERM", "EACCES", "EBUSY"].includes(code) || Date.now() >= deadline)
        throw new OwnedFenceLockUnavailableError("Retired owned fence protocol cleanup is unavailable.", { cause: error });
      yield sleepStep(Math.min(delays(), Math.max(1, deadline - Date.now())));
    }
  }
}

function* retireProtocolSteps(path, options, pathIdentity, authorityId) {
  try {
    const removalAuthority = captureProtocolRemovalAuthority(path, pathIdentity, authorityId);
    revalidateProtocolRemovalAuthority(path, removalAuthority);
    if (typeof options.retireAuthority === "function") {
      options.retireAuthority();
      return;
    }
    yield* removeProtocolPathSteps(path, removalAuthority);
  } catch (error) {
    throw new OwnedFenceAuthorityRetirementError("Owned fence authority retirement failed after its durable commit.", { cause: error });
  }
}

function validHolderRow(row) {
  return typeof row.acquisitionId === "string" && /^[0-9a-f-]{36}$/i.test(row.acquisitionId) &&
    Number.isSafeInteger(Number(row.holderPid)) && Number(row.holderPid) > 0 &&
    typeof row.holderBirth === "string" && row.holderBirth.length > 0 &&
    Number(row.proposalPid) === Number(row.holderPid) && row.proposalBirth === row.holderBirth;
}

function defaultInspectHolder(pid, birth, remainingMs = DEFAULT_DEADLINE_MS) {
  const inspection = inspectProcessBirth(pid, remainingMs);
  if (inspection.state === "absent") return "absent";
  if (inspection.state !== "same") return "unknown";
  return sameBirth(inspection.fingerprint, birth) ? "same" : "birth_mismatch";
}

/**
 * The default holder inspection without blocking the event loop (withOwnedFenceLock): on Windows the probe is an
 * async powershell.exe start bounded only by the claim's time left; elsewhere it is a /proc read or `ps`, run as is.
 */
async function defaultInspectHolderAsync(pid, birth, remainingMs = DEFAULT_DEADLINE_MS) {
  if (process.platform !== "win32") return defaultInspectHolder(pid, birth, remainingMs);
  if (!Number.isFinite(remainingMs) || remainingMs < 1) return "unknown";
  const deadline = Date.now() + remainingMs;
  const inspection = await new Promise((resolvePromise) => {
    try {
      execFile("powershell.exe", windowsBirthProbeArguments(pid), { encoding: "utf8", windowsHide: true, timeout: Math.floor(remainingMs) },
        (error, stdout) => resolvePromise(error ? { state: "unknown" } : parseWindowsBirthProbe(String(stdout).trim())));
    } catch { resolvePromise({ state: "unknown" }); }
  });
  if (inspection.state === "unknown" || Date.now() >= deadline) return "unknown";
  if (inspection.state === "absent") return "absent";
  return sameBirth(inspection.fingerprint, birth) ? "same" : "birth_mismatch";
}

/** BEGIN IMMEDIATE, polled with gentle backoff until `deadline` while it is busy (async callers, no transaction held). */
async function beginImmediateAsync(database, deadline, retryDelayMs) {
  const delays = pollDelays(retryDelayMs);
  for (;;) {
    try { database.exec("BEGIN IMMEDIATE"); return; }
    catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw normalizeUnavailable(error);
      await performStepAsync(sleepStep(Math.min(delays(), Math.max(1, deadline - Date.now()))));
    }
  }
}

/** One probe bounded only by the caller's time left: it returns the moment the process answers. */
function inspectProcessBirth(pid, remainingMs = DEFAULT_DEADLINE_MS) {
  if (!Number.isFinite(remainingMs) || remainingMs < 1) return { state: "unknown" };
  const deadline = Date.now() + remainingMs;
  const timely = result => Date.now() < deadline ? result : { state: "unknown" };
  try {
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", windowsBirthProbeArguments(pid),
        { encoding: "utf8", windowsHide: true, timeout: Math.floor(remainingMs) }).trim();
      const parsed = parseWindowsBirthProbe(output);
      return parsed.state === "unknown" ? parsed : timely(parsed);
    }
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const start = stat.slice(close + 2).split(" ")[19];
        return timely(start ? { state: "same", fingerprint: `proc-start:${start}` } : { state: "unknown" });
      } catch (error) { return timely(error?.code === "ENOENT" ? { state: "absent" } : { state: "unknown" }); }
    }
    return timely(inspectGenericPosixProcessBirth(pid, genericPosixInspectionOperations, deadline - Date.now()));
  } catch { return { state: "unknown" }; }
}

function windowsBirthProbeArguments(pid) {
  return [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){'ABSENT'}else{'PRESENT:'+$p.StartTime.ToUniversalTime().ToString('o')}`,
  ];
}

// Get-Process StartTime as ToUniversalTime().ToString('o'). Anything else, garbled output of a run that exited 0
// included, is unknown and never cached.
const WINDOWS_BIRTH_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

function parseWindowsBirthProbe(output) {
  if (output === "ABSENT") return { state: "absent" };
  if (output.startsWith("PRESENT:") && WINDOWS_BIRTH_PATTERN.test(output.slice(8))) return { state: "same", fingerprint: normalizeBirth(output.slice(8)) };
  return { state: "unknown" };
}

export function inspectGenericPosixProcessBirth(pid, operations = genericPosixInspectionOperations, remainingMs = DEFAULT_DEADLINE_MS) {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { state: "unknown" };
  const deadline = Date.now() + remainingMs, expired = Symbol("expired");
  const invoke = method => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return expired;
    const result = operations[method](pid, remaining);
    return Date.now() < deadline ? result : expired;
  };
  const firstExistence = invoke("probeExistence");
  if (firstExistence === "absent") return { state: "absent" };
  if (firstExistence !== "live") return { state: "unknown" };
  const firstBirth = invoke("inspectBirth");
  if (firstBirth === expired) return { state: "unknown" };
  if (firstBirth.outcome !== "ok")
    return invoke("probeExistence") === "absent" ? { state: "absent" } : { state: "unknown" };
  if (!firstBirth.fingerprint.trim()) return { state: "unknown" };
  if (invoke("probeExistence") !== "live") return { state: "unknown" };
  const secondBirth = invoke("inspectBirth");
  if (secondBirth === expired) return { state: "unknown" };
  if (secondBirth.outcome !== "ok")
    return invoke("probeExistence") === "absent" ? { state: "absent" } : { state: "unknown" };
  if (!secondBirth.fingerprint.trim() || !sameBirth(firstBirth.fingerprint, secondBirth.fingerprint))
    return { state: "unknown" };
  const finalExistence = invoke("probeExistence");
  if (finalExistence === "absent") return { state: "absent" };
  if (finalExistence !== "live") return { state: "unknown" };
  return { state: "same", fingerprint: normalizeBirth(secondBirth.fingerprint) };
}

const genericPosixInspectionOperations = Object.freeze({
  probeExistence(pid) {
    try { process.kill(pid, 0); return "live"; }
    catch (error) {
      if (error?.code === "ESRCH") return "absent";
      if (error?.code === "EPERM") return "permission";
      return "unknown";
    }
  },
  inspectBirth(pid, remainingMs = DEFAULT_DEADLINE_MS) {
    if (!Number.isFinite(remainingMs) || remainingMs < 1) return { outcome: "timeout" };
    try {
      const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: Math.floor(remainingMs) }).trim();
      return output ? { outcome: "ok", fingerprint: output } : { outcome: "malformed" };
    } catch (error) {
      if (error?.code === "ETIMEDOUT" || error?.signal) return { outcome: "timeout" };
      return { outcome: "failure" };
    }
  },
});

function sameBirth(left, right) { return normalizeBirth(left) === normalizeBirth(right); }
function normalizeBirth(value) { return value.replace(/(\.\d{6})\d+(Z)$/, "$1$2"); }
function rollbackQuietly(database) { try { database.exec("ROLLBACK"); } catch {} }
function isBusy(error) { return /database is locked|database table is locked|SQLITE_BUSY/i.test(String(error?.message ?? error)); }
function normalizeUnavailable(error) {
  if (error instanceof OwnedFenceLockUnavailableError) return error;
  return isBusy(error)
    ? new OwnedFenceContentionError("Owned fence lock protocol is temporarily contended.", { cause: error })
    : new OwnedFenceLockUnavailableError("Owned fence lock protocol is unavailable or invalid.", { cause: error });
}
function describeHolder(database) {
  try {
    const row = database.prepare("SELECT acquisition_id AS acquisitionId, holder_pid AS holderPid FROM owned_fence_holder WHERE lock_key = 'owned'").get();
    return row ? ` (PID ${String(row.holderPid)}, acquisition ${String(row.acquisitionId)})` : "";
  } catch { return ""; }
}
