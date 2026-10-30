import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openEncryptedJson, writeEncryptedJson } from "./encrypted-provider-config-store.js";
import { validateProviderConfigs, type RunnerProviderConfig } from "./provider-config-store.js";
import { deriveCredentialStoreKey, FileStorageKeyProvider, type StorageKeyProvider } from "./storage-key.js";

type StoreName = "provider" | "extension";
type LegacyHashes = Record<StoreName, string | null>;

interface Pointer {
  version: 2;
  generation: string;
  legacy: LegacyHashes;
}

interface Journal {
  version: 1;
  generation: string;
  legacy: LegacyHashes;
  phase: "staging" | "verified";
  staged?: Record<StoreName, string>;
}

interface LegacySnapshot {
  legacy: LegacyHashes;
  values: Record<StoreName, unknown[]>;
}

export const CREDENTIAL_MIGRATION_STEPS = [
  "journal-created",
  "storage-key-ready",
  "provider-staged",
  "extension-staged",
  "staging-verified",
  "pointer-committed",
  "commit-verified",
  "journal-removed",
] as const;

export interface PreparedCredentialStores {
  providerPath: string;
  extensionPath: string;
  providerKey: Buffer;
  extensionKey: Buffer;
  assertLegacyUnchanged(): void;
}

export function prepareCredentialStores(options: {
  stateDirectory: string;
  legacyToken?: string;
  keyProvider?: StorageKeyProvider;
  onStep?: (step: typeof CREDENTIAL_MIGRATION_STEPS[number]) => void;
}): PreparedCredentialStores {
  const { stateDirectory, legacyToken, onStep } = options;
  const pointerPath = join(stateDirectory, "credential-stores.json");
  const journalPath = join(stateDirectory, "credential-migration.json");
  const provider = options.keyProvider ?? new FileStorageKeyProvider(stateDirectory);

  // Do not create even the lock or the storage key until every legacy envelope authenticates.
  if (!existsSync(pointerPath)) readLegacySnapshot(stateDirectory, legacyToken);
  const lock = new DatabaseSync(join(stateDirectory, "credential-migration-lock.sqlite"), { timeout: 0 });
  let locked = false;
  try {
    try {
      lock.exec("BEGIN EXCLUSIVE");
      locked = true;
    } catch (error) {
      throw new Error("Credential storage is being prepared by another Runner; stop it and retry.", { cause: error });
    }

    if (existsSync(pointerPath)) {
      const pointer = readPointer(pointerPath);
      const journal = existsSync(journalPath) ? readJournal(journalPath) : undefined;
      return finishCommitted(stateDirectory, provider, pointer, journal, journalPath, onStep);
    }

    const snapshot = readLegacySnapshot(stateDirectory, legacyToken);
    let journal: Journal;
    if (existsSync(journalPath)) {
      journal = readJournal(journalPath);
      assertHashesEqual(snapshot.legacy, journal.legacy);
    } else {
      // A missing pointer and journal after a prior commit must never revive stale rollback data.
      if (existsSync(join(stateDirectory, "credential-stores-v2")) ||
          (!options.keyProvider && existsSync((provider as FileStorageKeyProvider).path))) {
        throw new Error("Credential storage metadata is missing; restore it before starting the Runner.");
      }
      journal = {
        version: 1,
        generation: randomBytes(16).toString("hex"),
        legacy: snapshot.legacy,
        phase: "staging",
      };
      writeAtomicJson(journalPath, journal);
      onStep?.("journal-created");
    }

    const storageKey = provider.getKey({ createIfMissing: true });
    let providerKey: Buffer | undefined;
    let extensionKey: Buffer | undefined;
    try {
      providerKey = deriveCredentialStoreKey(storageKey, "provider");
      extensionKey = deriveCredentialStoreKey(storageKey, "extension");
      onStep?.("storage-key-ready");
      const paths = generationPaths(stateDirectory, journal.generation, true);
      writeEncryptedJson(paths.provider, providerKey, snapshot.values.provider);
      syncDirectory(dirname(paths.provider));
      onStep?.("provider-staged");
      writeEncryptedJson(paths.extension, extensionKey, snapshot.values.extension);
      syncDirectory(dirname(paths.extension));
      onStep?.("extension-staged");

      verifyStaged(paths, { provider: providerKey, extension: extensionKey }, snapshot.values);
      assertHashesEqual(readLegacyHashes(stateDirectory), snapshot.legacy);
      journal = {
        ...journal,
        phase: "verified",
        staged: { provider: fileDigest(paths.provider), extension: fileDigest(paths.extension) },
      };
      writeAtomicJson(journalPath, journal);
      onStep?.("staging-verified");

      const pointer: Pointer = { version: 2, generation: journal.generation, legacy: journal.legacy };
      writeAtomicJson(pointerPath, pointer);
      onStep?.("pointer-committed");
      // Re-read committed metadata and envelopes before retiring the journal.
      const committed = readPointer(pointerPath);
      const verifiedJournal = readJournal(journalPath);
      const journalInfo = lstatSync(journalPath);
      verifyCommitted(stateDirectory, committed, verifiedJournal, { provider: providerKey, extension: extensionKey });
      onStep?.("commit-verified");
      removeVerifiedJournal(journalPath, verifiedJournal, journalInfo);
      syncDirectory(stateDirectory);
      onStep?.("journal-removed");
      return preparedStores(stateDirectory, committed, paths, providerKey, extensionKey);
    } catch (error) {
      providerKey?.fill(0);
      extensionKey?.fill(0);
      throw error;
    } finally {
      storageKey.fill(0);
    }
  } finally {
    if (locked) lock.exec("ROLLBACK");
    lock.close();
  }
}

function finishCommitted(
  stateDirectory: string,
  provider: StorageKeyProvider,
  pointer: Pointer,
  journal: Journal | undefined,
  journalPath: string,
  onStep?: (step: typeof CREDENTIAL_MIGRATION_STEPS[number]) => void,
): PreparedCredentialStores {
  const storageKey = provider.getKey({ createIfMissing: false });
  let providerKey: Buffer | undefined;
  let extensionKey: Buffer | undefined;
  try {
    providerKey = deriveCredentialStoreKey(storageKey, "provider");
    extensionKey = deriveCredentialStoreKey(storageKey, "extension");
    const journalInfo = journal ? lstatSync(journalPath) : undefined;
    const paths = verifyCommitted(stateDirectory, pointer, journal, { provider: providerKey, extension: extensionKey });
    if (journal) {
      onStep?.("commit-verified");
      removeVerifiedJournal(journalPath, journal, journalInfo!);
      syncDirectory(stateDirectory);
      onStep?.("journal-removed");
    }
    return preparedStores(stateDirectory, pointer, paths, providerKey, extensionKey);
  } catch (error) {
    providerKey?.fill(0);
    extensionKey?.fill(0);
    throw error;
  } finally {
    storageKey.fill(0);
  }
}

function preparedStores(
  stateDirectory: string,
  pointer: Pointer,
  paths: Record<StoreName, string>,
  providerKey: Buffer,
  extensionKey: Buffer,
): PreparedCredentialStores {
  return {
    providerPath: paths.provider,
    extensionPath: paths.extension,
    providerKey,
    extensionKey,
    assertLegacyUnchanged: () => assertHashesEqual(readLegacyHashes(stateDirectory), pointer.legacy),
  };
}

function verifyCommitted(
  stateDirectory: string,
  pointer: Pointer,
  journal: Journal | undefined,
  keys: Record<StoreName, Buffer>,
): Record<StoreName, string> {
  const paths = generationPaths(stateDirectory, pointer.generation, false);
  assertHashesEqual(readLegacyHashes(stateDirectory), pointer.legacy);
  if (journal) {
    if (journal.phase !== "verified" || journal.generation !== pointer.generation || !journal.staged) {
      throw new Error("Credential migration journal does not match the committed version.");
    }
    assertHashesEqual(journal.legacy, pointer.legacy);
    if (fileDigest(paths.provider) !== journal.staged.provider || fileDigest(paths.extension) !== journal.staged.extension) {
      throw new Error("Committed credential envelopes do not match the recovery journal.");
    }
  }
  verifyStaged(paths, keys);
  return paths;
}

function readLegacySnapshot(stateDirectory: string, token: string | undefined): LegacySnapshot {
  const legacyPaths = getLegacyPaths(stateDirectory);
  const values: Record<StoreName, unknown[]> = { provider: [], extension: [] };
  const legacy: LegacyHashes = { provider: null, extension: null };
  const tokenBytes = token === undefined ? undefined : Buffer.from(token, "utf8");
  try {
    for (const name of ["provider", "extension"] as const) {
      const bytes = readOptionalFile(legacyPaths[name]);
      if (bytes === undefined) continue;
      if (!tokenBytes || tokenBytes.length === 0) {
        throw new Error("Legacy credentials require the previous Runner token; restart with --token <previous-token>. Original files were not changed.");
      }
      legacy[name] = digest(bytes);
      try {
        const value: unknown = openEncryptedJson(tokenBytes, bytes.toString("utf8"));
        validateValue(name, value);
        values[name] = value;
      } catch (error) {
        throw new Error("Legacy credentials are locked or corrupt; supply the previous Runner token with --token or restore the original files. No credentials were overwritten.", { cause: error });
      }
    }
    return { legacy, values };
  } finally {
    tokenBytes?.fill(0);
  }
}

function verifyStaged(
  paths: Record<StoreName, string>,
  keys: Record<StoreName, Buffer>,
  expected?: Record<StoreName, unknown[]>,
): void {
  for (const name of ["provider", "extension"] as const) {
    try {
      const value: unknown = openEncryptedJson(keys[name], readFileSync(paths[name], "utf8"));
      validateValue(name, value);
      if (expected && JSON.stringify(value) !== JSON.stringify(expected[name])) {
        throw new Error("credential plaintext differs");
      }
    } catch (error) {
      throw new Error("Credential envelope is missing, corrupt, or cannot be decrypted; restore the protected state before retrying.", { cause: error });
    }
  }
}

function validateValue(name: StoreName, value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error("credential store must be an array");
  if (name === "provider") validateProviderConfigs(value as RunnerProviderConfig[]);
}

function getLegacyPaths(stateDirectory: string): Record<StoreName, string> {
  return {
    provider: join(stateDirectory, "provider-configs.enc"),
    extension: join(stateDirectory, "extension-credentials.enc"),
  };
}

function readLegacyHashes(stateDirectory: string): LegacyHashes {
  const paths = getLegacyPaths(stateDirectory);
  const provider = readOptionalFile(paths.provider);
  const extension = readOptionalFile(paths.extension);
  return { provider: provider === undefined ? null : digest(provider), extension: extension === undefined ? null : digest(extension) };
}

function readOptionalFile(path: string): Buffer | undefined {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Credential envelope must be a regular file.");
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function assertHashesEqual(actual: LegacyHashes, expected: LegacyHashes): void {
  if (actual.provider !== expected.provider || actual.extension !== expected.extension) {
    throw new Error("Legacy credential rollback files changed; stop older Runners and reconcile the protected state before retrying.");
  }
}

function generationPaths(stateDirectory: string, generation: string, create: boolean): Record<StoreName, string> {
  const root = join(stateDirectory, "credential-stores-v2");
  const directory = join(root, generation);
  for (const path of [root, directory]) {
    if (create && !existsSync(path)) {
      mkdirSync(path, { mode: 0o700 });
      syncDirectory(dirname(path));
    }
    if (!lstatSync(path).isDirectory()) throw new Error("Credential generation must be a regular directory.");
  }
  return { provider: join(directory, "provider-configs.enc"), extension: join(directory, "extension-credentials.enc") };
}

function removeVerifiedJournal(path: string, journal: Journal, verified: Stats): void {
  const current = lstatSync(path);
  if (!verified.isFile() || !current.isFile() || current.dev !== verified.dev || current.ino !== verified.ino ||
      JSON.stringify(readJournal(path)) !== JSON.stringify(journal)) {
    throw new Error("Credential migration journal changed; refusing removal.");
  }
  rmSync(path);
}

function readPointer(path: string): Pointer {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value.version !== 2 || !isGeneration(value.generation) || !isLegacyHashes(value.legacy)) {
    throw new Error("Credential version pointer is malformed; restore the protected state.");
  }
  return { version: 2, generation: value.generation, legacy: value.legacy };
}

function readJournal(path: string): Journal {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value.version !== 1 || !isGeneration(value.generation) || !isLegacyHashes(value.legacy) ||
      (value.phase !== "staging" && value.phase !== "verified") ||
      (value.phase === "verified" && !isDigestPair(value.staged))) {
    throw new Error("Credential migration journal is malformed; restore the protected state.");
  }
  return {
    version: 1,
    generation: value.generation,
    legacy: value.legacy,
    phase: value.phase,
    ...(isDigestPair(value.staged) ? { staged: value.staged } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isLegacyHashes(value: unknown): value is LegacyHashes {
  return isRecord(value) && (value.provider === null || isDigest(value.provider)) && (value.extension === null || isDigest(value.extension));
}

function isDigestPair(value: unknown): value is Record<StoreName, string> {
  return isRecord(value) && isDigest(value.provider) && isDigest(value.extension);
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileDigest(path: string): string {
  return digest(readFileSync(path));
}

function writeAtomicJson(path: string, value: unknown): void {
  const temporary = path + ".tmp-" + randomBytes(16).toString("hex");
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) rmSync(temporary, { force: true });
  }
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
