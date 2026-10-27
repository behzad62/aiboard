import { hkdfSync, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface StorageKeyProvider {
  getKey(options: { createIfMissing: boolean }): Buffer;
}

/** A per-state-directory key; other custody providers can implement the same interface. */
export class FileStorageKeyProvider implements StorageKeyProvider {
  readonly path: string;

  constructor(stateDirectory: string) {
    this.path = join(stateDirectory, "storage-key");
  }

  getKey({ createIfMissing }: { createIfMissing: boolean }): Buffer {
    try {
      return readStorageKey(this.path);
    } catch (error) {
      if (!isMissing(error) || !createIfMissing) throw error;
    }

    // Publish a fully written, exclusively created file without replacing a racing key.
    const temporary = `${this.path}.tmp-${randomBytes(16).toString("hex")}`;
    const key = randomBytes(32);
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(temporary, "wx", 0o600);
      created = true;
      writeFileSync(fd, key);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      try {
        linkSync(temporary, this.path);
      } catch (error) {
        if (!isAlreadyPresent(error)) throw error;
      }
      return readStorageKey(this.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) {
        try { unlinkSync(temporary); } catch (error) { if (!isMissing(error)) throw error; }
      }
      key.fill(0);
    }
  }
}

export function deriveCredentialStoreKey(key: Buffer, store: "provider" | "extension"): Buffer {
  if (key.length !== 32) throw new Error("Storage key must contain exactly 32 bytes.");
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `aiboard/runner-v2/${store}-credentials/v1`, 32));
}

function readStorageKey(path: string): Buffer {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error("Runner storage key must be a regular file.");
  const key = readFileSync(path);
  if (key.length !== 32) {
    key.fill(0);
    throw new Error("Runner storage key is corrupt; restore the protected key before starting the Runner.");
  }
  return key;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyPresent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
