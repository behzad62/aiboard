import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOST_POLL_MAX_DELAY_MS, nextHostPollDelay } from "./host-timing.mjs";
import { sqliteDatabaseLocation } from "./windows-path-limits.mjs";

// The owned fence lock is SQLite's own file lock and nothing else (docs/plans/2026-11-14-fence-lock-design.md, §6):
// BEGIN IMMEDIATE takes the RESERVED lock (LockFileEx on Windows, fcntl on POSIX), ROLLBACK gives it back, and the
// lock file is never written. The kernel releases a dead holder's lock, so a claim never probes a holder, never
// spawns a process and never needs a durable holder row. Fencing tokens are compared by the callers, under the lock.
//
// POSIX hazard: a record lock belongs to the process, and any close() of ANY descriptor of the lock file in this
// process drops every lock the process holds on it. SQLite keeps its own connections safe (it tracks locks per inode
// and defers their closes). Nothing else may open the file while this process holds it: this module opens it only to
// create it (a new inode, which nobody holds) and to read the header of a non-empty file that no acquisition of this
// module holds; test/owned-fence-close-guard.test.ts keeps every other Runner module from opening lock files. One
// module instance per process: a worker thread or a second copy would not see this one's holdings.

// A claim's default deadline: the longest it waits for another holder's effect, then it fails closed. A claim that
// meets no holder returns in about a millisecond (Windows 1.0 ms, Linux 0.2 ms p50, idle). The slowest waits measured
// were 1.1 s (four contenders on a loaded host) and 203 ms (a killed holder's lock, released by the kernel); the
// Windows Job signal effect holds the lock across a supervisor request of up to 60.25 s, so a claim behind it gives
// up at this ceiling instead (design note FD-3).
export const OWNED_FENCE_DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_DEADLINE_MS = OWNED_FENCE_DEFAULT_DEADLINE_MS;
// First wait before a busy claim tries again; then it grows by half up to HOST_POLL_MAX_DELAY_MS.
const DEFAULT_RETRY_DELAY_MS = 5;
// A file a pre-FL2 Runner created holds a SQLite database (rollback journal) with the old protocol's tables. Since FL5
// it is just a lock file: none of its rows is read. Anything else non-empty is foreign and refused.
const SQLITE_HEADER = "SQLite format 3\0";
const RETRYABLE_REMOVAL_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const CLAIM = Object.freeze({ create: true });
const REVOKED_RECOVERY = Object.freeze({ create: false });

const waiter = new Int32Array(new SharedArrayBuffer(4));
const asynchronousTails = new Map();
// The async turns the current asynchronous context is in, innermost first: { path, active, outer }. A turn waits
// behind every earlier turn on its path without a deadline, so a claim made from inside a still-active turn on the same
// path would wait for itself forever; it fails at once instead, as a nested sync claim does.
const asynchronousTurns = new AsyncLocalStorage();
// The acquisition holding each path now (lock taken to lock given back), by resolved path: { token, identity }.
// The sync driver refuses to wait on a path another live acquisition of this thread holds (performStepSync), since
// nothing on this thread could give it back while the wait blocks.
const liveAcquisitions = new Map();
// Connections whose release failed, by resolved path: { database, identity, failure }. They stay referenced (never
// closed, never collected), so the lock stays held until this process exits, and a later claim here fails at once.
const retainedLocks = new Map();
let nextToken = 1;

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

export function isOwnedFenceLockContention(error) {
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every((entry) => isOwnedFenceLockContention(entry));
  if (error instanceof OwnedFenceContentionError) return true;
  return error instanceof Error && error.cause !== undefined
    ? isOwnedFenceLockContention(error.cause)
    : false;
}

export function withOwnedFenceLockSync(path, effect, options = {}) {
  return runSteps(lockSteps(resolve(path), effect, options));
}

export async function withOwnedFenceLock(path, effect, options = {}) {
  path = resolve(path);
  return await inAsynchronousTurn(path, () => runStepsAsync(lockSteps(path, effect, options)));
}

/**
 * Remove the lock of an authority whose own record already says it is released (the Windows Job host's
 * `backendOwnershipReleasedAt`). The caller's assertion runs before the claim, under the lock and again before the
 * removal, so a stale or foreign tombstone never removes a lock. A missing lock file is already recovered.
 */
export async function recoverRevokedOwnedFenceLock(path, options = {}) {
  path = resolve(path);
  if (typeof options.assertRevoked !== "function")
    throw new OwnedFenceLockUnavailableError("Owned fence revocation authority is unavailable.");
  await inAsynchronousTurn(path, () => runStepsAsync(recoverRevokedSteps(path, options)));
}

async function inAsynchronousTurn(path, body) {
  const outer = asynchronousTurns.getStore();
  for (let turn = outer; turn !== undefined; turn = turn.outer) {
    if (turn.active && turn.path === path)
      throw new OwnedFenceContentionError(
        "Owned fence lock is held or awaited by this same asynchronous context; a nested claim would wait for itself.");
  }
  const record = { path, active: true, outer };
  return await asynchronousTurns.run(record, async () => {
    const previous = asynchronousTails.get(path) ?? Promise.resolve();
    let finishTurn;
    const turn = new Promise((resolvePromise) => { finishTurn = resolvePromise; });
    const tail = previous.then(() => turn);
    asynchronousTails.set(path, tail);
    try {
      await previous;
      return await body();
    } finally {
      // Work this turn started and left running is not inside it any more: it may claim the path once the turn ends.
      record.active = false;
      finishTurn();
      if (asynchronousTails.get(path) === tail) asynchronousTails.delete(path);
    }
  });
}

// One claim-effect-release, shared by both entry points. Every wait is a step its driver performs: the sync driver
// (withOwnedFenceLockSync) blocks the thread, which it already owns; the async driver (withOwnedFenceLock) awaits a
// timer, so a claim that waits for seconds never stops the event loop. The lock is held from the claim's BEGIN
// IMMEDIATE to its ROLLBACK; the effect runs in between.
function* lockSteps(path, effect, options) {
  const held = yield* acquireSteps(path, options, CLAIM);
  let result;
  let effectError;
  let failed = false;
  try {
    // Tests only: runs with the lock held, before the effect (a hard link or a replacement planted here is refused).
    options.afterClaim?.();
    assertHeldIdentity(held);
    result = yield effectStep(effect);
  } catch (error) { effectError = error; failed = true; }
  const releaseError = releaseHeld(held, options);
  if (failed) {
    if (releaseError === undefined) throw effectError;
    throw new AggregateError([effectError, releaseError], "Owned fence effect and lock release both failed.", { cause: effectError });
  }
  if (releaseError !== undefined) throw releaseError;
  if (options.retireAfterEffect === true) yield* retireSteps(path, held.identity, options);
  return result;
}

function* recoverRevokedSteps(path, options) {
  options.assertRevoked();
  const held = yield* acquireSteps(path, options, REVOKED_RECOVERY);
  if (held === undefined) return;
  let failure;
  let failed = false;
  try {
    options.assertRevoked();
    assertHeldIdentity(held);
  } catch (error) { failure = error; failed = true; }
  const releaseError = releaseHeld(held, {});
  if (failed) {
    if (releaseError === undefined) throw failure;
    throw new AggregateError([failure, releaseError], "Owned fence revocation check and lock release both failed.", { cause: failure });
  }
  if (releaseError !== undefined) throw releaseError;
  options.assertRevoked();
  yield* retryBusyRemoval(() => removeLockFile(path, held.identity));
}

/**
 * Takes the lock, waiting while another holder has it, until the claim's deadline (then OwnedFenceContentionError).
 * Returns { path, token, database, identity }, or undefined when the file is missing and `mode.create` is false.
 */
function* acquireSteps(path, options, mode) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1)
    throw new OwnedFenceLockUnavailableError("Owned fence lock bounds are invalid.");
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= 0))
    throw new OwnedFenceLockUnavailableError("Owned fence absolute deadline is invalid.");
  const startedAt = Date.now();
  const deadline = Math.min(startedAt + deadlineMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);
  const retained = retainedLocks.get(path);
  if (retained !== undefined)
    throw new OwnedFenceContentionError("Owned fence lock is kept by this process after its release failed, until the process exits: " +
      `${describeFailure(retained.failure)}`, { cause: retained.failure });
  const token = nextToken++;
  const delays = pollDelays(retryDelayMs);
  let attempts = 0;
  let lastBusy;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new OwnedFenceContentionError(attempts === 0
        ? "Owned fence acquisition deadline is exhausted."
        : `Owned fence lock is held by another holder [${attempts} attempts in ${Date.now() - startedAt} ms]${describeHolder(path)}.`,
        lastBusy === undefined ? undefined : { cause: lastBusy });
    }
    attempts += 1;
    const attempt = tryLockOnce(path, options, mode);
    if (attempt.missing) return undefined;
    if (attempt.held) {
      const held = { path, token, ...attempt.held };
      liveAcquisitions.set(path, { token, identity: held.identity });
      return held;
    }
    lastBusy = attempt.busy;
    if (Date.now() >= deadline) continue;
    yield sleepStep(Math.min(delays(), Math.max(1, deadline - Date.now())), path, token);
  }
}

/** One attempt: { held: { database, identity } }, { busy: error } or { missing: true }; anything else throws. */
function tryLockOnce(path, options, mode) {
  let before = readLockIdentity(path, true);
  if (before === undefined) {
    if (!mode.create) return { missing: true };
    before = createLockFile(path);
    if (before === undefined) return { busy: new OwnedFenceContentionError("Owned fence lock file creation was contested.") };
    if (options.assertAuthority) {
      try { options.assertAuthority(); }
      catch (error) { throw withCreatedLockRemoved(path, before, error); }
    }
  }
  if (before.size !== "0") assertRollbackJournalDatabase(path, before);
  let database;
  // Opened through a URI with mode=rw, so a lock file removed since the lstat is never created again here.
  try { database = new DatabaseSync(sqliteDatabaseLocation(path, process.platform, { mode: "rw" }), { timeout: 0 }); }
  catch (error) { throw new OwnedFenceLockUnavailableError("Owned fence lock file cannot be opened.", { cause: error }); }
  try {
    // An empty lock file: the rollback journal SQLite would create beside it for the claim's empty write transaction
    // stays in memory, so a claim leaves no file behind, not even while it holds the lock or when its holder dies.
    if (before.size === "0") database.exec("PRAGMA journal_mode=MEMORY");
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    try { database.close(); } catch {}
    if (isBusy(error)) return { busy: error };
    throw new OwnedFenceLockUnavailableError("Owned fence lock is unavailable.", { cause: error });
  }
  // The lock is held from here: whatever fails now gives it back (or keeps it, if that fails too).
  try {
    const identity = readLockIdentity(path, false);
    if (!sameLockIdentity(before, identity))
      throw new OwnedFenceLockUnavailableError("Owned fence lock file was replaced or removed while it was claimed.");
    assertLockSchema(database);
    return { held: { database, identity } };
  } catch (error) {
    const released = releaseConnection(path, database, before);
    const failure = error instanceof OwnedFenceLockUnavailableError ? error
      : new OwnedFenceLockUnavailableError("Owned fence lock file is foreign or unreadable.", { cause: error });
    if (released === undefined) throw failure;
    throw new AggregateError([failure, released], "Owned fence claim check and lock release both failed.", { cause: failure });
  }
}

/** Gives the lock back. Returns the failure, if any: that connection is then kept, and the lock held until exit. */
function releaseHeld(held, options) {
  if (liveAcquisitions.get(held.path)?.token === held.token) liveAcquisitions.delete(held.path);
  return releaseConnection(held.path, held.database, held.identity, options.beforeRelease);
}

function releaseConnection(path, database, identity, beforeRelease) {
  let failure;
  try {
    // Tests only: a failure here stands for a failed ROLLBACK.
    beforeRelease?.();
    database.exec("ROLLBACK");
  } catch (error) { failure = error; }
  if (failure === undefined) {
    try { database.close(); return undefined; }
    catch (error) { failure = error; }
  }
  const error = new OwnedFenceLockUnavailableError(
    "Owned fence lock release failed; this process keeps the lock until it exits.", { cause: failure });
  retainedLocks.set(path, { database, identity, failure: error });
  return error;
}

function* retireSteps(path, identity, options) {
  const remove = typeof options.retireAuthority === "function"
    ? () => options.retireAuthority()
    : () => removeLockFile(path, identity);
  try { yield* retryBusyRemoval(remove); }
  catch (error) {
    throw new OwnedFenceAuthorityRetirementError("Owned fence authority retirement failed after its effect.", { cause: error });
  }
}

// A removal that meets an open handle (Windows: another claimant opening the file to try it, antivirus) tries again
// until the default deadline; every try re-checks what it removes.
function* retryBusyRemoval(remove) {
  const deadline = Date.now() + DEFAULT_DEADLINE_MS;
  const delays = pollDelays(DEFAULT_RETRY_DELAY_MS);
  for (;;) {
    try { remove(); return; }
    catch (error) {
      if (!RETRYABLE_REMOVAL_CODES.has(errorCode(error)) || Date.now() >= deadline) throw error;
      yield sleepStep(Math.min(delays(), Math.max(1, deadline - Date.now())));
    }
  }
}

/** Removes the lock file only while it is still the file the caller held; a missing one is already removed. */
function removeLockFile(path, identity) {
  const current = readLockIdentity(path, true);
  if (current === undefined) return;
  if (!sameLockIdentity(current, identity))
    throw new OwnedFenceLockUnavailableError("Owned fence lock file was replaced before its removal.");
  unlinkSync(path);
}

/**
 * The lock file as lstat sees it: a regular file with one link, never a symbolic link. Its identity is the device,
 * inode and birth time; `size` tells an empty lock file from a pre-FL2 database.
 */
function readLockIdentity(path, allowMissing) {
  let status;
  try { status = lstatSync(path, { bigint: true }); }
  catch (error) {
    if (allowMissing && error?.code === "ENOENT") return undefined;
    throw new OwnedFenceLockUnavailableError("Owned fence lock file is unavailable.", { cause: error });
  }
  return lockIdentityOf(status);
}

function lockIdentityOf(status) {
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1n)
    throw new OwnedFenceLockUnavailableError("Owned fence lock file is aliased, linked, or not a regular file.");
  return Object.freeze({
    device: status.dev.toString(),
    inode: status.ino.toString(),
    birthtimeNs: status.birthtimeNs.toString(),
    size: status.size.toString(),
  });
}

function sameLockIdentity(left, right) {
  return left?.device === right?.device && left?.inode === right?.inode && left?.birthtimeNs === right?.birthtimeNs;
}

function assertHeldIdentity(held) {
  if (!sameLockIdentity(readLockIdentity(held.path, false), held.identity))
    throw new OwnedFenceLockUnavailableError("Owned fence lock file was replaced or removed while it was held.");
}

/**
 * Whether this thread holds the lock at `path` through an acquisition other than `token`, or keeps it after a failed
 * release: by path, and by file identity, so another spelling of the same file (a case difference on Windows, a
 * linked parent directory) is seen too.
 */
function heldByAnotherAcquisition(path, token) {
  const live = liveAcquisitions.get(path);
  if (live !== undefined && live.token !== token) return true;
  let identity;
  try { identity = readLockIdentity(path, true); } catch { return false; }
  if (identity === undefined) return false;
  for (const entry of liveAcquisitions.values()) if (entry.token !== token && sameLockIdentity(entry.identity, identity)) return true;
  for (const entry of retainedLocks.values()) if (sameLockIdentity(entry.identity, identity)) return true;
  return false;
}

function heldByThisModule(identity) {
  for (const entry of liveAcquisitions.values()) if (sameLockIdentity(entry.identity, identity)) return true;
  for (const entry of retainedLocks.values()) if (sameLockIdentity(entry.identity, identity)) return true;
  return false;
}

/** Creates the empty lock file (mode 0600). Returns its identity, or undefined when another creator won the race. */
function createLockFile(path) {
  let descriptor;
  try { descriptor = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") return undefined;
    throw new OwnedFenceLockUnavailableError("Owned fence lock file creation is unavailable.", { cause: error });
  }
  let created;
  try { created = lockIdentityOf(fstatSync(descriptor, { bigint: true })); }
  finally { closeSync(descriptor); }
  if (!sameLockIdentity(readLockIdentity(path, false), created))
    throw new OwnedFenceLockUnavailableError("Owned fence lock file changed during its creation.");
  return created;
}

/** The caller's authority refused a lock file this claim just created: remove it, unless it is no longer that file. */
function withCreatedLockRemoved(path, created, error) {
  try {
    const current = readLockIdentity(path, true);
    if (current !== undefined && sameLockIdentity(current, created)) unlinkSync(path);
    return error;
  } catch (cleanupError) {
    return new AggregateError([error, cleanupError], "Owned fence authority refusal and lock file removal both failed.", { cause: error });
  }
}

/**
 * A non-empty lock file must be a rollback-journal SQLite database (a pre-FL2 lock): SQLite would create -wal and -shm
 * files beside a WAL database, and lock it elsewhere. Read before any SQLite open, and only when no acquisition of this
 * module holds that file: on POSIX this read's close would end such a hold. A held file was checked when it was taken.
 */
function assertRollbackJournalDatabase(path, identity) {
  if (heldByThisModule(identity)) return;
  const header = Buffer.alloc(100);
  let read = 0;
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    read = readSync(descriptor, header, 0, header.length, 0);
  } catch (error) {
    throw new OwnedFenceLockUnavailableError("Owned fence lock file is unreadable.", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (read < header.length || header.toString("latin1", 0, 16) !== SQLITE_HEADER || header[18] !== 1 || header[19] !== 1)
    throw new OwnedFenceLockUnavailableError("Owned fence lock file is foreign or a WAL database; it is left unchanged.");
}

/**
 * Under the lock: an empty lock file, or a database a pre-FL2 Runner created; any other database is foreign and
 * refused. Only the table names are read: since FL5 none of the old protocol's rows counts, its `retired` flag included.
 */
function assertLockSchema(database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  if (tables.length > 0 && !tables.includes("owned_fence_protocol"))
    throw new OwnedFenceLockUnavailableError("Owned fence lock file is a foreign database.");
}

/** Diagnostics only. On Linux /proc/locks names the process that holds the lock; elsewhere there is no cheap way. */
function describeHolder(path) {
  if (process.platform !== "linux") return "";
  try {
    const inode = lstatSync(path, { bigint: true }).ino.toString();
    const pids = new Set();
    for (const line of readFileSync("/proc/locks", "utf8").split("\n")) {
      const fields = line.trim().split(/\s+/);
      const id = fields[0] === "->" ? fields.slice(1) : fields;
      if (id[1] === "POSIX" && id[5]?.split(":")[2] === inode) pids.add(id[4]);
    }
    return pids.size === 0 ? "" : `, held by PID ${[...pids].join(", ")}`;
  } catch { return ""; }
}

/**
 * A wait of `ms` before the next try. `path` and `token` name the acquisition that waits, when it is a claim: the sync
 * driver refuses to block on a lock this thread itself holds through another live acquisition.
 */
function sleepStep(ms, path, token) {
  return { kind: "sleep", ms, path, token };
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
    if (step.path !== undefined && heldByAnotherAcquisition(step.path, step.token))
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

function errorCode(error) {
  const seen = new Set();
  for (let node = error; node instanceof Error && !seen.has(node); node = node.cause) {
    seen.add(node);
    if (typeof node.code === "string") return node.code;
  }
  return undefined;
}

function isBusy(error) { return /database is locked|database table is locked|SQLITE_BUSY/i.test(String(error?.message ?? error)); }
