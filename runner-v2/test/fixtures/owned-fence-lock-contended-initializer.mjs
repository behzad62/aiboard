import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [requestedPath, delayText, gatePath] = process.argv.slice(2);
const lockPath = resolve(requestedPath);
const delayMs = Number(delayText);
const waiter = new Int32Array(new SharedArrayBuffer(4));

try {
  if (gatePath) {
    process.stdout.write(`${JSON.stringify({ state: "armed", pid: process.pid })}\n`);
    const gateDeadline = Date.now() + 5_000;
    while (!existsSync(gatePath) && Date.now() < gateDeadline) Atomics.wait(waiter, 0, 0, 2);
    if (!existsSync(gatePath)) throw new Error("contended initializer gate timed out");
  }
  const descriptor = openSync(lockPath, "wx", 0o600);
  closeSync(descriptor);
  process.stdout.write(`${JSON.stringify({ state: "reserved", pid: process.pid })}\n`);
  Atomics.wait(waiter, 0, 0, delayMs);

  const normalized = process.platform === "win32" ? lockPath.toLowerCase() : lockPath;
  const authorityId = createHash("sha256").update(`aiboard-owned-fence-path/v1\0${normalized}`).digest("hex");
  const database = new DatabaseSync(lockPath);
  try {
    database.exec(`
      PRAGMA busy_timeout=25;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      BEGIN IMMEDIATE;
      CREATE TABLE owned_fence_protocol(
        version INTEGER NOT NULL,
        retired INTEGER NOT NULL CHECK(retired IN (0, 1)),
        authority_id TEXT NOT NULL
      );
      CREATE TABLE owned_fence_acquisition(
        acquisition_id TEXT PRIMARY KEY NOT NULL,
        holder_pid INTEGER NOT NULL,
        holder_birth TEXT NOT NULL
      );
      CREATE TABLE owned_fence_holder(
        lock_key TEXT PRIMARY KEY NOT NULL CHECK(lock_key = 'owned'),
        acquisition_id TEXT UNIQUE NOT NULL,
        holder_pid INTEGER NOT NULL,
        holder_birth TEXT NOT NULL,
        FOREIGN KEY(acquisition_id) REFERENCES owned_fence_acquisition(acquisition_id)
      );
      CREATE TRIGGER owned_fence_acquisition_immutable
      BEFORE UPDATE ON owned_fence_acquisition
      BEGIN SELECT RAISE(ABORT, 'owned fence acquisition identity is immutable'); END;
      CREATE TRIGGER owned_fence_authority_immutable
      BEFORE UPDATE OF authority_id ON owned_fence_protocol
      BEGIN SELECT RAISE(ABORT, 'owned fence authority identity is immutable'); END;
      CREATE TRIGGER owned_fence_authority_delete_immutable
      BEFORE DELETE ON owned_fence_protocol
      BEGIN SELECT RAISE(ABORT, 'owned fence authority identity cannot be deleted'); END;
    `);
    database.prepare("INSERT INTO owned_fence_protocol(version, retired, authority_id) VALUES (1, 0, ?)").run(authorityId);
    database.exec("COMMIT");
  } finally { database.close(); }
  process.stdout.write(`${JSON.stringify({ state: "ready", pid: process.pid })}\n`);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
