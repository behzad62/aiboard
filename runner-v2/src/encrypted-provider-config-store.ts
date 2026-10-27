import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  cloneProviderConfigs,
  validateProviderConfigs,
  type ProviderConfigStore,
  type RunnerProviderConfig,
} from "./provider-config-store.js";

interface EncryptedEnvelope {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface CredentialStoreOptions {
  requireExisting?: boolean;
  beforeAccess?: () => void;
}

export class EncryptedProviderConfigStore implements ProviderConfigStore {
  private readonly key: Buffer;
  private closed = false;

  constructor(
    private readonly path: string,
    key: Buffer,
    private readonly options: CredentialStoreOptions = {},
  ) {
    if (key.length !== 32) throw new Error("Provider storage key must contain exactly 32 bytes.");
    this.key = Buffer.from(key);
  }

  load(): RunnerProviderConfig[] {
    this.assertOpen();
    this.options.beforeAccess?.();
    if (!existsSync(this.path)) {
      if (this.options.requireExisting) throw new Error("Provider credential envelope is missing.");
      return [];
    }
    try {
      const configs = openEncryptedJson(this.key, readFileSync(this.path, "utf8")) as RunnerProviderConfig[];
      validateProviderConfigs(configs);
      return cloneProviderConfigs(configs);
    } catch (error) {
      throw new Error("Could not decrypt provider configuration with this storage key.", {
        cause: error,
      });
    }
  }

  save(configs: readonly RunnerProviderConfig[]): void {
    this.assertOpen();
    this.options.beforeAccess?.();
    if (this.options.requireExisting && !existsSync(this.path)) throw new Error("Provider credential envelope is missing.");
    validateProviderConfigs(configs);
    writeEncryptedJson(this.path, this.key, cloneProviderConfigs(configs));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.key.fill(0);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Provider configuration store is closed.");
  }
}

/** Decrypts an envelope (scrypt key derivation, AES-256-GCM). */
export function openEncryptedJson(secret: Buffer, serialized: string): unknown {
  const envelope = JSON.parse(serialized) as EncryptedEnvelope;
  if (!envelope || typeof envelope !== "object" || envelope.version !== 1) throw new Error("unsupported version");
  const salt = decodeBase64(envelope.salt, 16);
  const iv = decodeBase64(envelope.iv, 12);
  const tag = decodeBase64(envelope.tag, 16);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = scryptSync(secret, salt, 32);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    try {
      return JSON.parse(plaintext.toString("utf8"));
    } finally {
      plaintext.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

function decodeBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("invalid encrypted envelope");
  }
  const decoded = Buffer.from(value, "base64");
  if ((length !== undefined && decoded.length !== length) || decoded.toString("base64") !== value) {
    throw new Error("invalid encrypted envelope");
  }
  return decoded;
}

/** Encrypts a JSON value and atomically replaces the file (mode 0600). */
export function writeEncryptedJson(path: string, secret: Buffer, value: unknown): void {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const plaintext = Buffer.from(JSON.stringify(value));
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(temporary, "wx", 0o600);
      created = true;
      writeFileSync(fd, JSON.stringify(envelope));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) rmSync(temporary, { force: true });
    }
  } finally {
    plaintext.fill(0);
    key.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}
