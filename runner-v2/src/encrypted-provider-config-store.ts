import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
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

export class EncryptedProviderConfigStore implements ProviderConfigStore {
  private readonly token: Buffer;
  private closed = false;

  constructor(
    private readonly path: string,
    runnerToken: string
  ) {
    if (runnerToken.length < 16) {
      throw new Error("Runner token must contain at least 16 characters.");
    }
    this.token = Buffer.from(runnerToken, "utf8");
  }

  load(): RunnerProviderConfig[] {
    this.assertOpen();
    if (!existsSync(this.path)) return [];
    try {
      const envelope = JSON.parse(readFileSync(this.path, "utf8")) as EncryptedEnvelope;
      if (envelope.version !== 1) throw new Error("unsupported version");
      const salt = Buffer.from(envelope.salt, "base64");
      const key = scryptSync(this.token, salt, 32);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(envelope.iv, "base64")
        );
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]);
        const configs = JSON.parse(plaintext.toString("utf8")) as RunnerProviderConfig[];
        plaintext.fill(0);
        validateProviderConfigs(configs);
        return cloneProviderConfigs(configs);
      } finally {
        key.fill(0);
      }
    } catch (error) {
      throw new Error("Could not decrypt provider configuration with this runner token.", {
        cause: error,
      });
    }
  }

  save(configs: readonly RunnerProviderConfig[]): void {
    this.assertOpen();
    validateProviderConfigs(configs);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(this.token, salt, 32);
    const plaintext = Buffer.from(JSON.stringify(cloneProviderConfigs(configs)));
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
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 });
      try {
        renameSync(temporary, this.path);
      } finally {
        rmSync(temporary, { force: true });
      }
    } finally {
      plaintext.fill(0);
      key.fill(0);
      salt.fill(0);
      iv.fill(0);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.token.fill(0);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Provider configuration store is closed.");
  }
}
