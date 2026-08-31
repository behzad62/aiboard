import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PROTOCOL_VERSION = 1;
const DEFAULT_DEADLINE_MS = 2_000;
const DEFAULT_RETRY_DELAY_MS = 5;
const PROTOCOL_COLUMNS = Object.freeze(["version", "retired", "authority_id"]);
const LEGACY_PROTOCOL_COLUMNS = Object.freeze(["version", "retired"]);
const AUTHORITY_UPDATE_TRIGGER = "owned_fence_authority_immutable";
const AUTHORITY_DELETE_TRIGGER = "owned_fence_authority_delete_immutable";
const waiter = new Int32Array(new SharedArrayBuffer(4));
const asynchronousTails = new Map();
let cachedCurrentBirth;

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

export function withOwnedFenceLockSync(path, effect, options = {}) {
  path = resolve(path);
  const context = acquire(path, options);
  let effectError;
  let retired = false;
  try {
    beginEffect(context);
    let result;
    try { result = effect(); }
    catch (error) { effectError = error; }
    retired = finalizeEffect(context, effectError, options.retireAfterEffect === true);
    if (effectError !== undefined) throw effectError;
    return result;
  } catch (error) {
    rollbackQuietly(context.database);
    if (effectError !== undefined && error !== effectError) {
      throw new AggregateError([effectError, error], "Owned fence effect and finalization both failed.", { cause: effectError });
    }
    throw error;
  } finally {
    context.database.close();
    if (retired) retireProtocol(path, options);
  }
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
    const context = acquire(path, options);
    let effectError;
    let retired = false;
    try {
      beginEffect(context);
      let result;
      try {
        result = effect();
        if (result && typeof result.then === "function") result = await result;
      }
      catch (error) { effectError = error; }
      retired = finalizeEffect(context, effectError, options.retireAfterEffect === true);
      if (effectError !== undefined) throw effectError;
      return result;
    } catch (error) {
      rollbackQuietly(context.database);
      if (effectError !== undefined && error !== effectError) {
        throw new AggregateError([effectError, error], "Owned fence effect and finalization both failed.", { cause: effectError });
      }
      throw error;
    } finally {
      context.database.close();
      if (retired) retireProtocol(path, options);
    }
  } finally {
    finishTurn();
    if (asynchronousTails.get(path) === tail) asynchronousTails.delete(path);
  }
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
    assertCoordinationPath(path, true);
    if (!existsSync(path)) {
      removeRetiredProtocol(path);
      return;
    }
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1)
      throw new OwnedFenceLockUnavailableError("Owned fence revocation bounds are invalid.");
    const deadline = Date.now() + deadlineMs;
    let database;
    let committed = false;
    try {
      database = new DatabaseSync(path);
      assertCoordinationPath(path);
      database.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      for (;;) {
        try { database.exec("BEGIN IMMEDIATE"); break; }
        catch (error) {
          if (!isBusy(error) || Date.now() >= deadline) throw normalizeUnavailable(error);
          Atomics.wait(waiter, 0, 0, retryDelayMs);
        }
      }
      assertRecoverableProtocol(database, authorityId);
      options.assertRevoked();
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
      database.exec("COMMIT");
      committed = true;
    } catch (error) {
      rollbackQuietly(database);
      throw normalizeUnavailable(error);
    } finally { database?.close(); }
    if (!committed) throw new OwnedFenceLockUnavailableError("Owned fence revocation commit is unavailable.");
    removeRetiredProtocol(path);
  } finally {
    finishTurn();
    if (asynchronousTails.get(path) === tail) asynchronousTails.delete(path);
  }
}

export function currentProcessBirthFingerprint() {
  cachedCurrentBirth ??= inspectProcessBirth(process.pid);
  if (cachedCurrentBirth.state !== "same")
    throw new OwnedFenceLockUnavailableError("Current owned fence holder birth identity is unavailable.");
  return cachedCurrentBirth.fingerprint;
}

export async function retryRetiredOwnedFenceCleanup(path, cleanup, options = {}) {
  path = resolve(path);
  const authorityId = coordinationAuthorityId(path);
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1)
    throw new OwnedFenceLockUnavailableError("Owned fence retired-cleanup bounds are invalid.");
  assertCoordinationPath(path);
  if (!existsSync(path)) throw new OwnedFenceLockUnavailableError("Owned fence retired-cleanup evidence is missing.");
  const deadline = Date.now() + deadlineMs;
  let database;
  try {
    database = new DatabaseSync(path);
    assertCoordinationPath(path);
    database.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    for (;;) {
      try { database.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw normalizeUnavailable(error);
        Atomics.wait(waiter, 0, 0, retryDelayMs);
      }
    }
    const objects = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map((row) => row.name));
    for (const required of ["owned_fence_protocol", "owned_fence_acquisition", "owned_fence_holder", "owned_fence_acquisition_immutable", AUTHORITY_UPDATE_TRIGGER, AUTHORITY_DELETE_TRIGGER])
      if (!objects.has(required)) throw new OwnedFenceLockUnavailableError("Owned fence retired-cleanup metadata is incomplete or invalid.");
    assertProtocolColumns(database, PROTOCOL_COLUMNS, "Owned fence retired-cleanup metadata is incomplete or invalid.");
    const protocol = database.prepare("SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol").all();
    const proposals = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()?.count);
    const holders = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count);
    if (protocol.length !== 1 || protocol[0].version !== PROTOCOL_VERSION || protocol[0].retired !== 1 ||
        protocol[0].authorityId !== authorityId || proposals !== 0 || holders !== 0)
      throw new OwnedFenceLockUnavailableError("Owned fence retired-cleanup authority is active, foreign, or incomplete.");
    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    throw normalizeUnavailable(error);
  } finally { database?.close(); }
  cleanup();
}

export function retiredOwnedFenceCleanupAvailable(path) {
  path = resolve(path);
  const authorityId = coordinationAuthorityId(path);
  let database;
  try {
    assertCoordinationPath(path);
    database = new DatabaseSync(path, { readOnly: true });
    assertCoordinationPath(path);
    assertProtocolColumns(database, PROTOCOL_COLUMNS, "Owned fence retired-cleanup metadata is incomplete or invalid.");
    const protocol = database.prepare("SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol").all();
    const proposals = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get()?.count);
    const holders = Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count);
    return protocol.length === 1 && protocol[0].version === PROTOCOL_VERSION && protocol[0].retired === 1 &&
      protocol[0].authorityId === authorityId && proposals === 0 && holders === 0;
  } catch { return false; }
  finally { database?.close(); }
}

function acquire(path, options) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1)
    throw new OwnedFenceLockUnavailableError("Owned fence lock bounds are invalid.");
  const deadline = Date.now() + deadlineMs;
  const holderPid = options.holderPid ?? process.pid;
  const holderBirth = options.holderBirth ?? currentProcessBirthFingerprint();
  if (!Number.isSafeInteger(holderPid) || holderPid < 1 || typeof holderBirth !== "string" || holderBirth.length === 0)
    throw new OwnedFenceLockUnavailableError("Owned fence holder identity is invalid.");
  const acquisitionId = randomUUID();
  const authorityId = coordinationAuthorityId(path);
  const database = openProtocol(path, authorityId, deadline, retryDelayMs, options.assertAuthority);
  const context = {
    database, acquisitionId, holderPid, holderBirth, authorityId, deadline, retryDelayMs,
    inspectHolder: options.inspectHolder ?? defaultInspectHolder,
    afterClaim: options.afterClaim,
  };
  let proposalInserted = false;
  try {
    while (!proposalInserted) {
      try {
        database.prepare("INSERT INTO owned_fence_acquisition(acquisition_id, holder_pid, holder_birth) VALUES (?, ?, ?)")
          .run(acquisitionId, holderPid, holderBirth);
        proposalInserted = true;
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline)
          throw isBusy(error)
            ? new OwnedFenceLockUnavailableError(`Owned fence lock remains held by an exact live holder${describeHolder(database)}.`, { cause: error })
            : error;
        Atomics.wait(waiter, 0, 0, retryDelayMs);
      }
    }
    for (;;) {
      if (tryClaim(context)) { context.afterClaim?.(); return context; }
      if (Date.now() >= deadline)
        throw new OwnedFenceLockUnavailableError("Owned fence lock remains held by an exact live holder.");
      Atomics.wait(waiter, 0, 0, retryDelayMs);
    }
  } catch (error) {
    if (!proposalInserted) {
      database.close();
      throw normalizeUnavailable(error);
    }
    try { database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(acquisitionId); }
    catch (cleanupError) {
      database.close();
      throw new AggregateError([error, cleanupError], "Owned fence acquisition and proposal cleanup both failed.", { cause: error });
    }
    database.close();
    throw normalizeUnavailable(error);
  }
}

function openProtocol(path, authorityId, deadline, retryDelayMs, assertAuthority) {
  const mayInitialize = !existsSync(path);
  for (;;) {
    let database;
    let authorityRefused = false;
    let transactionOpen = false;
    try {
      assertCoordinationPath(path, true);
      database = new DatabaseSync(path);
      assertCoordinationPath(path);
      if (mayInitialize && assertAuthority) {
        try { assertAuthority(); }
        catch (error) { authorityRefused = true; throw error; }
      }
      database.exec("PRAGMA busy_timeout=25; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      database.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      assertCoordinationPath(path);
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
        assertCoordinationPath(path);
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
      const currentObjects = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map((row) => row.name));
      if (![...required, AUTHORITY_UPDATE_TRIGGER, AUTHORITY_DELETE_TRIGGER].every((name) => currentObjects.has(name)))
        throw new OwnedFenceLockUnavailableError("Owned fence lock protocol metadata is incomplete or invalid.");
      const version = database.prepare("SELECT version, authority_id AS authorityId FROM owned_fence_protocol").all();
      if (version.length === 0) database.prepare("INSERT INTO owned_fence_protocol(version, retired, authority_id) VALUES (?, 0, ?)").run(PROTOCOL_VERSION, authorityId);
      else if (version.length !== 1 || version[0].version !== PROTOCOL_VERSION || version[0].authorityId !== authorityId)
        throw new OwnedFenceLockUnavailableError("Owned fence lock protocol metadata is invalid.");
      const protocol = database.prepare("SELECT retired FROM owned_fence_protocol").get();
      if (!protocol || protocol.retired !== 0)
        throw new OwnedFenceLockUnavailableError("Owned fence lock protocol is retired or invalid.");
      assertCoordinationPath(path);
      database.exec("COMMIT");
      transactionOpen = false;
      database.exec("PRAGMA foreign_keys=ON;");
      return database;
    } catch (error) {
      if (transactionOpen) rollbackQuietly(database);
      try { database?.close(); } catch {}
      if (mayInitialize && authorityRefused) {
        try { removeRetiredProtocol(path); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Owned fence authority refusal and coordination cleanup both failed.", { cause: error });
        }
        throw error;
      }
      if (!isBusy(error) || Date.now() >= deadline) throw normalizeUnavailable(error);
      Atomics.wait(waiter, 0, 0, retryDelayMs);
    }
  }
}

function tryClaim(context) {
  const { database, acquisitionId, holderPid, holderBirth, authorityId, inspectHolder } = context;
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
  try {
    assertActiveProtocol(database, authorityId);
    const row = database.prepare(`
      SELECT h.acquisition_id AS acquisitionId, h.holder_pid AS holderPid,
             h.holder_birth AS holderBirth, a.holder_pid AS proposalPid,
             a.holder_birth AS proposalBirth
      FROM owned_fence_holder h
      LEFT JOIN owned_fence_acquisition a ON a.acquisition_id = h.acquisition_id
      WHERE h.lock_key = 'owned'
    `).get();
    if (!row) {
      insertHolder(database, acquisitionId, holderPid, holderBirth);
      database.exec("COMMIT");
      return true;
    }
    if (!validHolderRow(row))
      throw new OwnedFenceLockUnavailableError("Owned fence holder metadata is corrupt or incomplete.");
    if (row.acquisitionId === acquisitionId) { database.exec("COMMIT"); return true; }
    const inspection = inspectHolder(Number(row.holderPid), String(row.holderBirth));
    if (inspection === "same") { database.exec("ROLLBACK"); return false; }
    if (inspection !== "absent" && inspection !== "birth_mismatch")
      throw new OwnedFenceLockUnavailableError("Owned fence holder inspection is unavailable or uncertain.");
    const update = database.prepare(`
      UPDATE owned_fence_holder
      SET acquisition_id = ?, holder_pid = ?, holder_birth = ?
      WHERE lock_key = 'owned' AND acquisition_id = ? AND holder_pid = ? AND holder_birth = ?
    `).run(acquisitionId, holderPid, holderBirth, row.acquisitionId, row.holderPid, row.holderBirth);
    if (Number(update.changes) !== 1)
      throw new OwnedFenceLockUnavailableError("Owned fence stale-holder election changed concurrently.");
    database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(row.acquisitionId);
    database.exec("COMMIT");
    return true;
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function insertHolder(database, acquisitionId, holderPid, holderBirth) {
  database.prepare("INSERT INTO owned_fence_holder(lock_key, acquisition_id, holder_pid, holder_birth) VALUES ('owned', ?, ?, ?)")
    .run(acquisitionId, holderPid, holderBirth);
}

function beginEffect(context) {
  const { database, acquisitionId, holderPid, holderBirth, authorityId, deadline, retryDelayMs } = context;
  for (;;) {
    try { database.exec("BEGIN IMMEDIATE"); break; }
    catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw normalizeUnavailable(error);
      Atomics.wait(waiter, 0, 0, retryDelayMs);
    }
  }
  assertActiveProtocol(database, authorityId);
  const row = database.prepare("SELECT acquisition_id AS acquisitionId, holder_pid AS holderPid, holder_birth AS holderBirth FROM owned_fence_holder WHERE lock_key = 'owned'").get();
  if (!row || row.acquisitionId !== acquisitionId || Number(row.holderPid) !== holderPid || row.holderBirth !== holderBirth) {
    rollbackQuietly(database);
    throw new OwnedFenceLockUnavailableError("Owned fence acquisition identity changed before the effect boundary.");
  }
}

function finalizeEffect(context, primaryError, retireAfterEffect) {
  const { database, acquisitionId } = context;
  try {
    const removed = database.prepare("DELETE FROM owned_fence_holder WHERE lock_key = 'owned' AND acquisition_id = ?").run(acquisitionId);
    if (Number(removed.changes) !== 1)
      throw new OwnedFenceLockUnavailableError("Owned fence holder finalization lost its exact acquisition identity.");
    database.prepare("DELETE FROM owned_fence_acquisition WHERE acquisition_id = ?").run(acquisitionId);
    if (retireAfterEffect && primaryError === undefined) {
      database.prepare("DELETE FROM owned_fence_acquisition").run();
      database.prepare("UPDATE owned_fence_protocol SET retired = 1 WHERE retired = 0").run();
    }
    database.exec("COMMIT");
    return retireAfterEffect && primaryError === undefined;
  } catch (error) {
    rollbackQuietly(database);
    const cleanupError = normalizeUnavailable(error);
    if (primaryError !== undefined)
      throw new AggregateError([primaryError, cleanupError], "Owned fence effect and finalization both failed.", { cause: primaryError });
    throw cleanupError;
  }
}

function assertActiveProtocol(database, authorityId) {
  const protocol = database.prepare("SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol").all();
  if (protocol.length !== 1 || protocol[0].version !== PROTOCOL_VERSION || protocol[0].retired !== 0 || protocol[0].authorityId !== authorityId)
    throw new OwnedFenceLockUnavailableError("Owned fence lock protocol is retired or invalid.");
}

function assertRecoverableProtocol(database, authorityId) {
  const required = new Map([
    ["owned_fence_protocol", PROTOCOL_COLUMNS],
    ["owned_fence_acquisition", ["acquisition_id", "holder_pid", "holder_birth"]],
    ["owned_fence_holder", ["lock_key", "acquisition_id", "holder_pid", "holder_birth"]],
  ]);
  const objects = new Map(database.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'trigger')").all().map((row) => [row.name, row.type]));
  if (objects.get("owned_fence_acquisition_immutable") !== "trigger" ||
      objects.get(AUTHORITY_UPDATE_TRIGGER) !== "trigger" || objects.get(AUTHORITY_DELETE_TRIGGER) !== "trigger")
    throw new OwnedFenceLockUnavailableError("Owned fence revocation metadata is incomplete or invalid.");
  for (const [table, columns] of required) {
    if (objects.get(table) !== "table") throw new OwnedFenceLockUnavailableError("Owned fence revocation metadata is incomplete or invalid.");
    const actual = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
    if (actual.length !== columns.length || actual.some((name, index) => name !== columns[index]))
      throw new OwnedFenceLockUnavailableError("Owned fence revocation schema is corrupt or foreign.");
  }
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

function assertCoordinationPath(path, allowMissing = false) {
  try {
    const status = lstatSync(path);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1)
      throw new OwnedFenceLockUnavailableError("Owned fence coordination path is aliased, linked, or invalid.");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    if (error instanceof OwnedFenceLockUnavailableError) throw error;
    throw new OwnedFenceLockUnavailableError("Owned fence coordination path is unavailable.", { cause: error });
  }
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((row) => row.name);
}

function sameColumns(actual, expected) {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function assertProtocolColumns(database, expected, message) {
  if (!sameColumns(tableColumns(database, "owned_fence_protocol"), expected))
    throw new OwnedFenceLockUnavailableError(message);
}

function quoteIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }

function removeRetiredProtocol(path) {
  const deadline = Date.now() + DEFAULT_DEADLINE_MS;
  for (;;) {
    try {
      for (const candidate of [`${path}-journal`, `${path}-wal`, `${path}-shm`, path]) {
        try { unlinkSync(candidate); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      return;
    }
    catch (error) {
      if (error?.code === "ENOENT") return;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || Date.now() >= deadline)
        throw new OwnedFenceLockUnavailableError("Retired owned fence protocol cleanup is unavailable.", { cause: error });
      Atomics.wait(waiter, 0, 0, DEFAULT_RETRY_DELAY_MS);
    }
  }
}

function retireProtocol(path, options) {
  try {
    if (typeof options.retireAuthority === "function") {
      options.retireAuthority();
      return;
    }
    removeRetiredProtocol(path);
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

function defaultInspectHolder(pid, birth) {
  const inspection = inspectProcessBirth(pid);
  if (inspection.state === "absent") return "absent";
  if (inspection.state !== "same") return "unknown";
  return sameBirth(inspection.fingerprint, birth) ? "same" : "birth_mismatch";
}

function inspectProcessBirth(pid) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null -eq $p){'ABSENT'}else{'PRESENT:'+$p.StartTime.ToUniversalTime().ToString('o')}`,
      ], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim();
      if (output === "ABSENT") return { state: "absent" };
      if (output.startsWith("PRESENT:") && output.length > 8) return { state: "same", fingerprint: normalizeBirth(output.slice(8)) };
      return { state: "unknown" };
    }
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        const start = stat.slice(close + 2).split(" ")[19];
        return start ? { state: "same", fingerprint: `proc-start:${start}` } : { state: "unknown" };
      } catch (error) { return error?.code === "ENOENT" ? { state: "absent" } : { state: "unknown" }; }
    }
    return inspectGenericPosixProcessBirth(pid);
  } catch { return { state: "unknown" }; }
}

export function inspectGenericPosixProcessBirth(pid, operations = genericPosixInspectionOperations) {
  const firstExistence = operations.probeExistence(pid);
  if (firstExistence === "absent") return { state: "absent" };
  if (firstExistence !== "live") return { state: "unknown" };
  const firstBirth = operations.inspectBirth(pid);
  if (firstBirth.outcome !== "ok")
    return operations.probeExistence(pid) === "absent" ? { state: "absent" } : { state: "unknown" };
  if (!firstBirth.fingerprint.trim()) return { state: "unknown" };
  if (operations.probeExistence(pid) !== "live") return { state: "unknown" };
  const secondBirth = operations.inspectBirth(pid);
  if (secondBirth.outcome !== "ok")
    return operations.probeExistence(pid) === "absent" ? { state: "absent" } : { state: "unknown" };
  if (!secondBirth.fingerprint.trim() || !sameBirth(firstBirth.fingerprint, secondBirth.fingerprint))
    return { state: "unknown" };
  const finalExistence = operations.probeExistence(pid);
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
  inspectBirth(pid) {
    try {
      const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim();
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
  return error instanceof OwnedFenceLockUnavailableError
    ? error
    : new OwnedFenceLockUnavailableError("Owned fence lock protocol is unavailable or invalid.", { cause: error });
}
function describeHolder(database) {
  try {
    const row = database.prepare("SELECT acquisition_id AS acquisitionId, holder_pid AS holderPid FROM owned_fence_holder WHERE lock_key = 'owned'").get();
    return row ? ` (PID ${String(row.holderPid)}, acquisition ${String(row.acquisitionId)})` : "";
  } catch { return ""; }
}
