import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RemoteDeviceIdentity {
  readonly deviceId: string;
  readonly accountId: string | null;
  readonly epoch: string;
  readonly revoked: boolean;
  readonly publicKey: string;
  readonly createdAt: string;
  /** The rotated key is staged separately so publishing the identity is atomic. */
  readonly keyFile?: string;
}

/** Provisioned relay session metadata. No token material is stored here (P1). */
/** One pinned relay signing key, provisioned with the session by the issuer (P1). */
export interface RemoteRelayKey {
  readonly keyId: string;
  readonly publicKey: string;
}

export interface RemoteDeviceSession {
  readonly accountId: string;
  readonly clientId: string;
  readonly scope: string;
  readonly issuedAt: string;
  /** Relay signing keys pinned at provisioning; request signatures must verify under one. */
  readonly relayKeys: readonly RemoteRelayKey[];
  /** Scope references this device session may be authorized for; anything else is refused. */
  readonly authorizedScopes: readonly string[];
  readonly relayOrigin?: string;
}

const IDENTITY_FILE = "remote-device.json";
const KEY_FILE = "remote-device-key";
const SESSION_FILE = "remote-device-session.json";
const NOTICE_FILE = "remote-notice.json";
const OWNER_LOCK_FILE = "remote-device-owner.sqlite";
const OWNER_RECORD_FILE = "remote-device-owner.json";
const PAIRING_LOCK_FILE = "remote-device-pairing.sqlite";

/**
 * Device custody: an Ed25519 keypair generated on this machine. The private key
 * is a separate secret from the project storage key (storage-key.ts), stored
 * user-only (0600) and never logged, placed in argv, or sent to the relay.
 */
export class RemoteDeviceStore {
  private readonly identityPath: string;
  private readonly keyPath: string;
  private readonly sessionPath: string;
  private readonly noticePath: string;
  private readonly lockPath: string;
  private readonly ownerRecordPath: string;
  private readonly pairingLockPath: string;
  private ownerDatabase: DatabaseSync | undefined;

  constructor(readonly stateDirectory: string) {
    if (!isAbsolute(stateDirectory)) throw new Error("Remote device state directory must be absolute.");
    this.identityPath = join(stateDirectory, IDENTITY_FILE);
    this.keyPath = join(stateDirectory, KEY_FILE);
    this.sessionPath = join(stateDirectory, SESSION_FILE);
    this.noticePath = join(stateDirectory, NOTICE_FILE);
    this.lockPath = join(stateDirectory, OWNER_LOCK_FILE);
    this.ownerRecordPath = join(stateDirectory, OWNER_RECORD_FILE);
    this.pairingLockPath = join(stateDirectory, PAIRING_LOCK_FILE);
  }

  load(): RemoteDeviceIdentity | undefined {
    let raw: string;
    try { raw = readPrivateText(this.identityPath); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.deviceId !== "string" || !value.deviceId ||
      !(value.accountId === null || typeof value.accountId === "string") ||
      typeof value.epoch !== "string" || !/^[1-9][0-9]{0,18}$/.test(value.epoch) ||
      typeof value.revoked !== "boolean" || typeof value.publicKey !== "string" || !value.publicKey ||
      typeof value.createdAt !== "string" ||
      (value.keyFile !== undefined && (typeof value.keyFile !== "string" ||
        !/^remote-device-key-device-[0-9a-f-]{36}$/.test(value.keyFile) ||
        value.keyFile !== `remote-device-key-${value.deviceId}`))) {
      throw new Error("Remote device identity record is invalid.");
    }
    return Object.freeze({
      deviceId: value.deviceId, accountId: value.accountId, epoch: value.epoch,
      revoked: value.revoked, publicKey: value.publicKey, createdAt: value.createdAt,
      ...(typeof value.keyFile === "string" ? { keyFile: value.keyFile } : {}),
    });
  }

  /**
   * Create the keypair on first use. An unclaimed device may be claimed by one
   * account once; moving it to another account requires revocation and re-pairing.
   */
  ensure(accountId?: string): RemoteDeviceIdentity {
    const existing = this.load();
    if (existing) {
      if (accountId === undefined || existing.accountId === accountId) return existing;
      if (existing.accountId !== null) {
        throw new Error("This device is linked to another AIBoard account; revoke it before pairing again (remote --logout alone retains the identity).");
      }
      return this.save({ ...existing, accountId });
    }
    const pair = generateKeyPairSync("ed25519");
    const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
    const publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    writePrivateExclusive(this.keyPath, Buffer.from(privateDer.toString("base64url"), "utf8"));
    const identity: RemoteDeviceIdentity = {
      deviceId: `device-${randomUUID()}`,
      accountId: accountId ?? null,
      epoch: "1",
      revoked: false,
      publicKey,
      createdAt: new Date().toISOString(),
    };
    try {
      writePrivateAtomic(this.identityPath, JSON.stringify(identity));
    } catch (error) {
      try { unlinkSync(this.keyPath); } catch { /* keep the original error */ }
      throw error;
    }
    return Object.freeze(identity);
  }

  sign(data: Buffer): Buffer {
    return cryptoSign(null, data, this.privateKey());
  }

  publicKeyObject(): KeyObject {
    const identity = this.load();
    if (!identity) throw new Error("Remote device is not provisioned.");
    return createPublicKey({ key: Buffer.from(identity.publicKey, "base64url"), type: "spki", format: "der" });
  }

  setAccountId(accountId: string): RemoteDeviceIdentity {
    const identity = this.requireIdentity();
    if (!accountId) throw new Error("Remote account id is invalid.");
    return this.save({ ...identity, accountId });
  }

  /** Epoch only moves forward; a stale epoch never overwrites the fence. */
  advanceEpochTo(epoch: string): boolean {
    if (!/^[1-9][0-9]{0,18}$/.test(epoch)) throw new Error("Remote device epoch is invalid.");
    const identity = this.requireIdentity();
    if (BigInt(epoch) <= BigInt(identity.epoch)) return false;
    this.save({ ...identity, epoch });
    return true;
  }

  revoke(): RemoteDeviceIdentity {
    const identity = this.requireIdentity();
    if (identity.revoked) return identity;
    return this.save({ ...identity, revoked: true });
  }

  isRevoked(): boolean {
    return this.load()?.revoked === true;
  }

  /** Replace a revoked identity while holding the same per-device owner fence. */
  rotateIdentity(): RemoteDeviceIdentity {
    const release = this.ownerDatabase ? undefined : this.acquireOwnerLock();
    if (!this.ownerDatabase) throw new Error("remote_active: Stop the remote Runner before rotating its identity.");
    try {
      const old = this.requireIdentity();
      if (!old.revoked) throw new Error("Only a revoked remote device identity may be rotated.");
      const pair = generateKeyPairSync("ed25519");
      const deviceId = `device-${randomUUID()}`;
      const keyFile = `remote-device-key-${deviceId}`;
      const keyPath = join(this.stateDirectory, keyFile);
      const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
      const identity: RemoteDeviceIdentity = {
        deviceId, accountId: null, epoch: "1", revoked: false, keyFile,
        publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
        createdAt: new Date().toISOString(),
      };
      // Clear the old session before publishing a new identity. A crash cannot
      // associate the old account's session with a newly generated key.
      try { unlinkSync(this.sessionPath); } catch (error) { if (!isMissing(error)) throw error; }
      writePrivateExclusive(keyPath, Buffer.from(privateDer.toString("base64url"), "utf8"));
      try { this.save(identity); }
      catch (error) { try { unlinkSync(keyPath); } catch { /* preserve the original failure */ } throw error; }
      try { unlinkSync(old.keyFile ? join(this.stateDirectory, old.keyFile) : this.keyPath); }
      catch (error) { if (!isMissing(error)) throw error; }
      return Object.freeze(identity);
    } finally { release?.(); }
  }

  saveSession(session: RemoteDeviceSession): void {
    // checkedSession validates every field, including pinned relay keys and scopes.
    if (!checkedSession(session)) {
      throw new Error("Remote device session is invalid.");
    }
    writePrivateAtomic(this.sessionPath, JSON.stringify(session));
  }

  loadSession(): RemoteDeviceSession | undefined {
    let raw: string;
    try { raw = readPrivateText(this.sessionPath); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !checkedSessionShape(value) || typeof value.accountId !== "string" || typeof value.clientId !== "string" ||
      typeof value.scope !== "string" || typeof value.issuedAt !== "string") {
      throw new Error("Remote device session record is invalid.");
    }
    return Object.freeze({
      accountId: value.accountId, clientId: value.clientId, scope: value.scope, issuedAt: value.issuedAt, relayKeys: checkedSessionShape(value)!.relayKeys, authorizedScopes: checkedSessionShape(value)!.authorizedScopes,
      ...(typeof value.relayOrigin === "string" ? { relayOrigin: value.relayOrigin } : {}),
    });
  }

  noticeAcknowledged(): boolean {
    try {
      const value: unknown = JSON.parse(readPrivateText(this.noticePath));
      return isRecord(value) && typeof value.acknowledgedAt === "string";
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  acknowledgeNotice(): void {
    writePrivateAtomic(this.noticePath, JSON.stringify({ acknowledgedAt: new Date().toISOString() }));
  }

  /**
   * Hold the per-user device owner lock: one remote-connected Runner per device.
   * Returns null when another owner holds it. The holder records its project so
   * a refused second Runner can say where remote is already active.
   */
  acquireOwnerLock(projectPath?: string): (() => void) | null {
    if (this.ownerDatabase) throw new Error("Remote device owner lock is already held.");
    const database = new DatabaseSync(this.lockPath, { timeout: 0 });
    try {
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      database.close();
      if (/database is locked|database is busy|SQLITE_BUSY/i.test(String(error))) return null;
      throw error;
    }
    this.ownerDatabase = database;
    if (projectPath !== undefined) {
      writePrivateAtomic(this.ownerRecordPath, JSON.stringify({ projectPath, pid: process.pid }));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.ownerDatabase === database) this.ownerDatabase = undefined;
      try { if (projectPath !== undefined) unlinkSync(this.ownerRecordPath); } catch (error) { if (!isMissing(error)) throw error; }
      finally {
        try { database.exec("ROLLBACK"); } finally { database.close(); }
      }
    };
  }

  /** The project whose Runner currently holds remote, as recorded by that holder (display only). */
  activeOwnerProject(): string | undefined {
    try {
      const value: unknown = JSON.parse(readPrivateText(this.ownerRecordPath));
      return isRecord(value) && typeof value.projectPath === "string" ? value.projectPath : undefined;
    } catch {
      return undefined;
    }
  }

  /** A separate, crash-released fence serializes pairing even across processes. */
  acquirePairingLock(): (() => void) | null {
    const database = new DatabaseSync(this.pairingLockPath, { timeout: 0 });
    try { database.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      database.close();
      if (/database is locked|database is busy|SQLITE_BUSY/i.test(String(error))) return null;
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { database.exec("ROLLBACK"); } finally { database.close(); }
    };
  }

  /** `remote --logout`: clear the session while retaining the device key and identity. */
  logout(): void {
    if (this.ownerDatabase) throw new Error("Stop the remote Runner before logging out.");
    const release = this.acquireOwnerLock();
    if (!release) {
      const project = this.activeOwnerProject();
      throw new Error(`remote_active: Stop the remote Runner${project ? ` for ${project}` : ""} before logging out.`);
    }
    try {
      try { unlinkSync(this.sessionPath); } catch (error) { if (!isMissing(error)) throw error; }
    } finally { release(); }
  }

  private requireIdentity(): RemoteDeviceIdentity {
    const identity = this.load();
    if (!identity) throw new Error("Remote device is not provisioned.");
    return identity;
  }

  private save(identity: RemoteDeviceIdentity): RemoteDeviceIdentity {
    writePrivateAtomic(this.identityPath, JSON.stringify(identity));
    return Object.freeze({ ...identity });
  }

  private privateKey(): KeyObject {
    const identity = this.requireIdentity();
    const encoded = readPrivateText(identity.keyFile ? join(this.stateDirectory, identity.keyFile) : this.keyPath).trim();
    const key = createPrivateKey({ key: Buffer.from(encoded, "base64url"), type: "pkcs8", format: "der" });
    if (createPublicKey(key.export({ type: "pkcs8", format: "pem" })).export({ type: "spki", format: "der" }).toString("base64url") !== identity.publicKey) {
      throw new Error("Remote device key does not match its identity.");
    }
    return key;
  }
}

function writePrivateExclusive(path: string, contents: Buffer): void {
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(temporary); } catch (error) { if (!isMissing(error)) throw error; }
    }
  }
}

function writePrivateAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* keep the original error */ }
    throw error;
  }
}

function readPrivateText(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error("Remote device state must be a regular file.");
  return readFileSync(path, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a provisioned session shape; pinned keys must parse as Ed25519 SPKI. */
export function checkedSessionShape(value: unknown): RemoteDeviceSession | undefined {
  if (!isRecord(value) || typeof value.accountId !== "string" || !value.accountId || typeof value.clientId !== "string" || !value.clientId ||
    typeof value.scope !== "string" || !value.scope || typeof value.issuedAt !== "string" || !value.issuedAt ||
    !Array.isArray(value.relayKeys) || !Array.isArray(value.authorizedScopes) ||
    (value.relayOrigin !== undefined && (typeof value.relayOrigin !== "string" || !value.relayOrigin))) return undefined;
  const keyIds = new Set<string>();
  const relayKeys: RemoteRelayKey[] = [];
  for (const entry of value.relayKeys as unknown[]) {
    if (!isRecord(entry) || typeof entry.keyId !== "string" || !entry.keyId || entry.keyId.length > 256 ||
      typeof entry.publicKey !== "string" || !entry.publicKey || keyIds.has(entry.keyId)) return undefined;
    try {
      const key = createPublicKey({ key: Buffer.from(entry.publicKey, "base64url"), type: "spki", format: "der" });
      if (key.asymmetricKeyType !== "ed25519") return undefined;
    } catch { return undefined; }
    keyIds.add(entry.keyId);
    relayKeys.push(Object.freeze({ keyId: entry.keyId, publicKey: entry.publicKey }));
  }
  const scopes = new Set<string>();
  for (const scope of value.authorizedScopes as unknown[]) {
    if (typeof scope !== "string" || !scope || scope.length > 256 || scopes.has(scope)) return undefined;
    scopes.add(scope);
  }
  return Object.freeze({
    accountId: value.accountId, clientId: value.clientId, scope: value.scope, issuedAt: value.issuedAt,
    relayKeys: Object.freeze(relayKeys), authorizedScopes: Object.freeze([...scopes]),
    ...(typeof value.relayOrigin === "string" ? { relayOrigin: value.relayOrigin } : {}),
  });
}

function checkedSession(session: RemoteDeviceSession): RemoteDeviceSession {
  const checked = checkedSessionShape(session);
  if (!checked) throw new Error("Remote device session is invalid.");
  return checked;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
