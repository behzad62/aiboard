import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { openEncryptedJson, writeEncryptedJson, type CredentialStoreOptions } from "./encrypted-provider-config-store.js";
import { ExtensionManagementError } from "./extension-management-contracts.js";

export interface CredentialMetadata {
  readonly ref: string;
  readonly extensionId: string;
  readonly name: string;
  readonly kind: "env" | "bearer" | "oauth";
  readonly createdAt: string;
  readonly updatedAt: string;
  /** OAuth only: when the access token stops being usable. */
  readonly expiresAt?: string;
}

interface StoredCredential extends CredentialMetadata {
  readonly value: string;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly resource?: string;
}

const MAX_CREDENTIALS = 256;
const MAX_SECRET_BYTES = 16 * 1024;

/**
 * Runner-owned secret custody for extensions. Values are encrypted with a store key (same envelope
 * as provider configuration) and are only ever returned to Runner-internal launch/transport code.
 * Every outward-facing method returns metadata without values.
 */
export class ExtensionCredentialStore {
  private readonly key: Buffer;
  private closed = false;

  constructor(private readonly path: string, key: Buffer, private readonly options: CredentialStoreOptions = {}) {
    if (key.length !== 32) throw new Error("Extension storage key must contain exactly 32 bytes.");
    this.key = Buffer.from(key);
  }

  list(extensionId?: string): CredentialMetadata[] {
    return this.load().filter((entry) => !extensionId || entry.extensionId === extensionId).map(metadata);
  }

  has(ref: string): boolean {
    return this.load().some((entry) => entry.ref === ref);
  }

  /** Stores or replaces the secret for (extensionId, name); returns the stable reference. */
  put(input: { extensionId: string; name: string; kind: CredentialMetadata["kind"]; value: string; refreshToken?: string; expiresAt?: string; scope?: string; resource?: string }): CredentialMetadata {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(input.name)) throw new ExtensionManagementError("credential_name_invalid", "Credential names are environment-variable style identifiers.");
    if (typeof input.value !== "string" || input.value.length === 0 || Buffer.byteLength(input.value) > MAX_SECRET_BYTES)
      throw new ExtensionManagementError("credential_value_invalid", "A credential value is required and must be at most 16 KiB.");
    const entries = this.load();
    const now = new Date().toISOString();
    const prior = entries.find((entry) => entry.extensionId === input.extensionId && entry.name === input.name);
    if (!prior && entries.length >= MAX_CREDENTIALS) throw new ExtensionManagementError("credential_limit", "Too many stored extension credentials.");
    const next: StoredCredential = {
      ref: prior?.ref ?? `cred_${randomBytes(12).toString("hex")}`,
      extensionId: input.extensionId,
      name: input.name,
      kind: input.kind,
      value: input.value,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.resource ? { resource: input.resource } : {}),
    };
    this.save([...entries.filter((entry) => entry.ref !== next.ref), next]);
    return metadata(next);
  }

  /** Runner-internal only: the secret for an approved launch or request. Never serialize the result. */
  reveal(ref: string): Readonly<{ value: string; refreshToken?: string; expiresAt?: string; scope?: string; resource?: string; name: string }> {
    const entry = this.load().find((candidate) => candidate.ref === ref);
    if (!entry) throw new ExtensionManagementError("credential_missing", "A required credential is not stored on this Runner.", 409);
    return Object.freeze({ value: entry.value, name: entry.name,
      ...(entry.refreshToken ? { refreshToken: entry.refreshToken } : {}), ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      ...(entry.scope ? { scope: entry.scope } : {}), ...(entry.resource ? { resource: entry.resource } : {}) });
  }

  /** Revokes stored values. Remote token revocation at the issuer is the caller's responsibility. */
  revoke(filter: { ref?: string; extensionId?: string }): CredentialMetadata[] {
    const entries = this.load();
    const removed = entries.filter((entry) => (filter.ref !== undefined && entry.ref === filter.ref) || (filter.extensionId !== undefined && entry.extensionId === filter.extensionId));
    if (removed.length) this.save(entries.filter((entry) => !removed.includes(entry)));
    return removed.map(metadata);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.key.fill(0);
  }

  private load(): StoredCredential[] {
    if (this.closed) throw new Error("Extension credential store is closed.");
    this.options.beforeAccess?.();
    if (!existsSync(this.path)) {
      if (this.options.requireExisting) throw new ExtensionManagementError("credential_store_corrupt", "Extension credential envelope is missing.", 500);
      return [];
    }
    let value: unknown;
    try {
      value = openEncryptedJson(this.key, readFileSync(this.path, "utf8"));
    } catch {
      throw new ExtensionManagementError("credential_store_locked", "Extension credentials cannot be decrypted with the storage key.", 500);
    }
    if (!Array.isArray(value)) throw new ExtensionManagementError("credential_store_corrupt", "Extension credential store is malformed.", 500);
    return value as StoredCredential[];
  }

  private save(entries: readonly StoredCredential[]): void {
    this.options.beforeAccess?.();
    if (this.options.requireExisting && !existsSync(this.path)) throw new ExtensionManagementError("credential_store_corrupt", "Extension credential envelope is missing.", 500);
    writeEncryptedJson(this.path, this.key, entries);
  }
}

function metadata(entry: StoredCredential): CredentialMetadata {
  return Object.freeze({
    ref: entry.ref, extensionId: entry.extensionId, name: entry.name, kind: entry.kind, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
  });
}
