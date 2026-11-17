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
import { dirname, join } from "node:path";

import {
  cloneProviderConfigs,
  validateProviderConfigs,
  type ProviderConfigStore,
  type RunnerProviderConfig,
} from "./provider-config-store.js";

/**
 * CLI worker configs (`transport: "cli"`, CLI workers plan §3.1) hold no secret, so they are kept beside
 * the envelope in this plain JSON file, never inside it. A Runner from before CW1 validates the whole
 * envelope on load and refuses an unknown transport, which would leave it unable to load any config
 * after `aiboard update --rollback`; it never reads this file, so it only loses its CLI workers.
 */
export const CLI_WORKER_CONFIGS_FILE = "cli-worker-configs.json";

interface CliWorkerConfigsFile {
  version: 1;
  configs: unknown[];
}

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
      return this.loadCliConfigs(new Set());
    }
    let keyed: RunnerProviderConfig[];
    try {
      const configs = openEncryptedJson(this.key, readFileSync(this.path, "utf8")) as RunnerProviderConfig[];
      validateProviderConfigs(configs);
      keyed = cloneProviderConfigs(configs);
    } catch (error) {
      throw new Error("Could not decrypt provider configuration with this storage key.", {
        cause: error,
      });
    }
    return [...keyed, ...this.loadCliConfigs(new Set(keyed.map((config) => config.runtimeId)))];
  }

  save(configs: readonly RunnerProviderConfig[]): void {
    this.assertOpen();
    this.options.beforeAccess?.();
    if (this.options.requireExisting && !existsSync(this.path)) throw new Error("Provider credential envelope is missing.");
    validateProviderConfigs(configs);
    const cli = configs.filter((config) => config.transport === "cli");
    writeEncryptedJson(this.path, this.key, cloneProviderConfigs(configs.filter((config) => config.transport !== "cli")));
    // A store that never held a CLI worker gets no sidecar; one that did is rewritten, empty when the last is gone.
    const sidecar = this.cliConfigsPath();
    if (cli.length > 0 || existsSync(sidecar)) {
      replaceFileAtomically(sidecar, `${JSON.stringify({ version: 1, configs: cloneProviderConfigs(cli) } satisfies CliWorkerConfigsFile, null, 2)}\n`);
    }
  }

  /** Where the CLI worker configs of this store live: CLI_WORKER_CONFIGS_FILE beside the envelope. */
  cliConfigsPath(): string {
    return join(dirname(this.path), CLI_WORKER_CONFIGS_FILE);
  }

  /**
   * The sidecar's CLI worker configs. They were checked strictly when pushed; here an entry this Runner
   * cannot use (a field a newer Runner added, a hand edit, a runtime id the envelope already has) is left
   * out with a warning instead of refusing every config, so a later packet's fields still roll back.
   */
  private loadCliConfigs(taken: ReadonlySet<string>): RunnerProviderConfig[] {
    const path = this.cliConfigsPath();
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, "utf8")); }
    catch { console.warn(`[runner] ${path} is not JSON; its CLI workers are not loaded.`); return []; }
    if (!parsed || typeof parsed !== "object" || (parsed as CliWorkerConfigsFile).version !== 1 || !Array.isArray((parsed as CliWorkerConfigsFile).configs)) {
      console.warn(`[runner] ${path} is not a CLI worker config list this Runner reads; its CLI workers are not loaded.`);
      return [];
    }
    const loaded: RunnerProviderConfig[] = [];
    const seen = new Set(taken);
    for (const entry of (parsed as CliWorkerConfigsFile).configs) {
      const config = entry as RunnerProviderConfig;
      const name = config && typeof config === "object" && typeof config.runtimeId === "string" ? config.runtimeId.slice(0, 160) : "(no id)";
      try {
        if (!config || typeof config !== "object" || config.transport !== "cli") throw new Error("it is not a CLI worker config");
        if (seen.has(config.runtimeId)) throw new Error("its runtime id is already configured");
        validateProviderConfigs([config]);
      } catch (error) {
        console.warn(`[runner] CLI worker ${name} in ${CLI_WORKER_CONFIGS_FILE} is left out: ${error instanceof Error ? error.message : "it is invalid"}`);
        continue;
      }
      seen.add(config.runtimeId);
      loaded.push(config);
    }
    return cloneProviderConfigs(loaded);
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
    replaceFileAtomically(path, JSON.stringify(envelope));
  } finally {
    plaintext.fill(0);
    key.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

/** Writes `text` to an exclusive random temporary beside `path` (mode 0600), fsyncs it, and renames it over `path`. */
function replaceFileAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) rmSync(temporary, { force: true });
  }
}
