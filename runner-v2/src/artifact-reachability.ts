import { createReadStream } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ArtifactNotFoundError,
  type ArtifactStore,
} from "./artifact-store.js";

const HASH_PATTERN = /[a-f0-9]{64}/g;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "binary");
const DEFAULT_MAX_FILES = 250_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const EXCLUDED_ROOTS = new Set(["artifacts", "integration", "workspaces"]);
const NON_LIVE_SESSION_TABLES = new Set([
  "agent_artifact_cleanup",
  "agent_compacted_checkpoint_idempotency",
]);

export interface ArtifactReachabilityGuardOptions {
  maxFiles?: number;
  maxBytes?: number;
}

/**
 * Builds a conservative global artifact-reference index only while Runner
 * recovery is quiescent. Live cleanup may enqueue tombstones, but cannot
 * physically remove shared artifacts.
 */
export class ArtifactReachabilityGuard {
  private readonly stateDirectory: string;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private quiescent = false;
  private reachable: Set<string> | undefined;
  private scans = 0;
  private operationQueue = Promise.resolve();

  constructor(
    stateDirectory: string,
    private readonly artifacts: ArtifactStore,
    options: ArtifactReachabilityGuardOptions = {}
  ) {
    this.stateDirectory = resolve(stateDirectory);
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  get scanCount(): number {
    return this.scans;
  }

  async runQuiescent<T>(operation: () => Promise<T>): Promise<T> {
    return await this.serialized(async () => {
      if (this.quiescent) throw new Error("Artifact reachability scan is already quiescent.");
      this.quiescent = true;
      this.reachable = undefined;
      try {
        return await operation();
      } finally {
        this.reachable = undefined;
        this.quiescent = false;
      }
    });
  }

  async prepareReachabilityIndex(): Promise<void> {
    if (!this.quiescent) {
      throw new Error("Artifact reachability can be indexed only during quiescent startup.");
    }
    this.scans += 1;
    try {
      this.reachable = await this.scanReachableArtifacts();
    } catch (error) {
      // An incomplete proof must retain every candidate. A later startup can retry.
      this.reachable = undefined;
      throw new Error("Artifact reachability scan failed; cleanup was retained for retry.", {
        cause: error,
      });
    }
  }

  async removeIfGloballyUnreachable(hash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return false;
    if (!this.quiescent || !this.reachable || this.reachable.has(hash)) return false;
    await this.artifacts.remove(hash);
    return true;
  }

  private async scanReachableArtifacts(): Promise<Set<string>> {
    const roots = new Set<string>();
    const files = await this.durableFiles();
    let totalBytes = 0;
    for (const path of files) {
      const details = await lstat(path);
      totalBytes += details.size;
      if (totalBytes > this.maxBytes) throw new Error("Artifact scan byte limit exceeded.");
      if (
        isCompanionSqliteFile(path) &&
        await pathExists(sqliteMainPath(path))
      ) continue;
      if (await isSqliteDatabase(path)) {
        collectSqliteHashes(path, roots);
      } else {
        await collectFileHashes(path, roots);
      }
    }

    const reachable = new Set<string>();
    const queue = [...roots];
    let artifactBytes = 0;
    while (queue.length > 0) {
      const hash = queue.pop()!;
      if (reachable.has(hash)) continue;
      let bytes: Buffer;
      try {
        bytes = await this.artifacts.get(hash);
      } catch (error) {
        if (error instanceof ArtifactNotFoundError) continue;
        throw error;
      }
      reachable.add(hash);
      artifactBytes += bytes.byteLength;
      if (totalBytes + artifactBytes > this.maxBytes) {
        throw new Error("Artifact graph byte limit exceeded.");
      }
      for (const nested of hashesIn(bytes)) {
        if (!reachable.has(nested)) queue.push(nested);
      }
    }
    return reachable;
  }

  private async durableFiles(): Promise<string[]> {
    const files: string[] = [];
    const visit = async (directory: string, topLevel: boolean): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (topLevel && entry.isDirectory() && EXCLUDED_ROOTS.has(entry.name)) continue;
        const path = join(directory, entry.name);
        const details = await lstat(path);
        if (details.isSymbolicLink()) {
          throw new Error(`Artifact scan refuses symbolic link ${path}.`);
        }
        if (details.isDirectory()) {
          await visit(path, false);
          continue;
        }
        if (!details.isFile()) continue;
        files.push(path);
        if (files.length > this.maxFiles) throw new Error("Artifact scan file limit exceeded.");
      }
    };
    await visit(this.stateDirectory, true);
    return files.sort();
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function isSqliteDatabase(path: string): Promise<boolean> {
  if (isCompanionSqliteFile(path)) return false;
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === bytes.length && bytes.equals(SQLITE_HEADER);
  } finally {
    await handle.close();
  }
}

function isCompanionSqliteFile(path: string): boolean {
  const name = basename(path);
  return name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith("-journal");
}

function sqliteMainPath(path: string): string {
  return path.replace(/-(?:wal|shm|journal)$/, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function collectSqliteHashes(path: string, hashes: Set<string>): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    ).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      if (NON_LIVE_SESSION_TABLES.has(name)) continue;
      const statement = database.prepare(`SELECT * FROM ${quoteIdentifier(name)}`);
      for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
        for (const value of Object.values(row)) collectValueHashes(value, hashes);
      }
    }
  } finally {
    database.close();
  }
}

function collectValueHashes(value: unknown, hashes: Set<string>): void {
  if (typeof value === "string") {
    for (const hash of hashesIn(Buffer.from(value, "utf8"))) hashes.add(hash);
  } else if (value instanceof Uint8Array) {
    for (const hash of hashesIn(Buffer.from(value))) hashes.add(hash);
  }
}

async function collectFileHashes(path: string, hashes: Set<string>): Promise<void> {
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  let carry = Buffer.alloc(0);
  for await (const chunk of stream) {
    const bytes = Buffer.concat([carry, Buffer.from(chunk)]);
    for (const hash of hashesIn(bytes)) hashes.add(hash);
    carry = bytes.subarray(Math.max(0, bytes.length - 63));
  }
}

function hashesIn(bytes: Buffer): string[] {
  return bytes.toString("latin1").match(HASH_PATTERN) ?? [];
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
