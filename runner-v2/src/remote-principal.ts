import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RemoteAuditStore } from "./remote-audit-store.js";

/** The connector must verify these claims before passing them to this store. */
export interface VerifiedRemoteIdentity {
  readonly accountId: string;
  readonly clientId: string;
  readonly deviceId: string;
}

/** Reserved for L1f; local MCP identities are not remote account identities. */
export interface LocalMcpIdentity {
  readonly kind: "local_mcp";
  readonly localClientId: string;
}

export interface RemotePrincipal {
  readonly identity: VerifiedRemoteIdentity;
  readonly principalId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly revoked: boolean;
}

export interface RemoteDevicePolicy {
  readonly shell: boolean;
  readonly approvals: boolean;
  readonly readOnly: boolean;
  readonly onlyHere: boolean;
  readonly audit: boolean;
}

export const DEFAULT_REMOTE_DEVICE_POLICY: Readonly<RemoteDevicePolicy> = Object.freeze({
  shell: true, approvals: false, readOnly: false, onlyHere: false, audit: true,
});

type PolicyOrigin = "local" | "remote";
type PrincipalRow = {
  account_id: string; client_id: string; device_id: string; principal_id: string;
  run_id: string; session_id: string; revoked: number;
};
type PolicyRow = { shell: number; approvals: number; read_only: number; only_here: number; audit: number };

/** Local durable identity and policy. Revocation leaves a tombstone, never a new owner. */
export class RemotePrincipalStore {
  private readonly database: DatabaseSync;
  private readonly policyTable: string;
  readonly auditStore: RemoteAuditStore;
  private readonly ownsAuditStore: boolean;

  constructor(path: string, auditStore?: RemoteAuditStore, devicePolicyPath?: string) {
    if (!isAbsolute(path)) throw new Error("Remote principal state path must be absolute.");
    if (devicePolicyPath !== undefined && !isAbsolute(devicePolicyPath)) throw new Error("Remote device policy path must be absolute.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.auditStore = auditStore ?? new RemoteAuditStore(join(dirname(path), "remote-audit.sqlite"));
    this.ownsAuditStore = auditStore === undefined;
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS remote_principals (
        account_id TEXT NOT NULL, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
        principal_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
        PRIMARY KEY (account_id, client_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS remote_device_policy (
        account_id TEXT NOT NULL, device_id TEXT NOT NULL,
        shell INTEGER NOT NULL, approvals INTEGER NOT NULL, read_only INTEGER NOT NULL,
        only_here INTEGER NOT NULL, audit INTEGER NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );
    `);
    this.policyTable = devicePolicyPath ? "remote_device.remote_device_policy" : "remote_device_policy";
    if (devicePolicyPath) {
      mkdirSync(dirname(devicePolicyPath), { recursive: true, mode: 0o700 });
      this.database.prepare("ATTACH DATABASE ? AS remote_device").run(devicePolicyPath);
      this.database.exec(`CREATE TABLE IF NOT EXISTS remote_device.remote_device_policy (
        account_id TEXT NOT NULL, device_id TEXT NOT NULL, shell INTEGER NOT NULL, approvals INTEGER NOT NULL,
        read_only INTEGER NOT NULL, only_here INTEGER NOT NULL, audit INTEGER NOT NULL,
        PRIMARY KEY (account_id, device_id)
      );
      CREATE TABLE IF NOT EXISTS remote_policy_migrations (policy_path TEXT PRIMARY KEY);`);
      this.migratePolicy(devicePolicyPath);
    }
  }

  getOrCreate(identity: VerifiedRemoteIdentity): RemotePrincipal {
    const verified = checkedIdentity(identity);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT OR IGNORE INTO remote_principals
        (account_id, client_id, device_id, principal_id, run_id, session_id)
        VALUES (?, ?, ?, ?, ?, ?)`).run(verified.accountId, verified.clientId, verified.deviceId,
        `remote-${randomUUID()}`, `remote-run-${randomUUID()}`, `remote-session-${randomUUID()}`);
      const result = this.find(verified);
      if (!result) throw new Error("Remote principal could not be created.");
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  find(identity: VerifiedRemoteIdentity): RemotePrincipal | undefined {
    const verified = checkedIdentity(identity);
    const row = this.database.prepare(`SELECT * FROM remote_principals
      WHERE account_id = ? AND client_id = ? AND device_id = ?`).get(
      verified.accountId, verified.clientId, verified.deviceId,
    ) as unknown as PrincipalRow | undefined;
    if (!row) return undefined;
    if (![0, 1].includes(row.revoked) || !/^remote-[a-f0-9-]+$/.test(row.principal_id) ||
      !/^remote-run-[a-f0-9-]+$/.test(row.run_id) || !/^remote-session-[a-f0-9-]+$/.test(row.session_id)) {
      throw new Error("Remote principal record is invalid.");
    }
    return Object.freeze({ identity: Object.freeze(verified), principalId: row.principal_id,
      runId: row.run_id, sessionId: row.session_id, revoked: row.revoked === 1 });
  }

  revoke(identity: VerifiedRemoteIdentity, origin: PolicyOrigin): void {
    if (origin !== "local") throw new Error("Only the local user can revoke a remote principal.");
    const verified = checkedIdentity(identity);
    this.database.prepare(`UPDATE remote_principals SET revoked = 1
      WHERE account_id = ? AND client_id = ? AND device_id = ?`).run(
      verified.accountId, verified.clientId, verified.deviceId,
    );
  }

  policy(identity: VerifiedRemoteIdentity): Readonly<RemoteDevicePolicy> {
    return this.policyStatus(identity).policy;
  }

  policyStatus(identity: VerifiedRemoteIdentity): { readonly policy: Readonly<RemoteDevicePolicy>; readonly fromDefaults: boolean } {
    const verified = checkedIdentity(identity);
    const row = this.database.prepare(`SELECT shell, approvals, read_only, only_here, audit
      FROM ${this.policyTable} WHERE account_id = ? AND device_id = ?`).get(
      verified.accountId, verified.deviceId,
    ) as unknown as PolicyRow | undefined;
    return policyFromRow(row);
  }

  static readDevicePolicy(path: string, identity: VerifiedRemoteIdentity): { readonly policy: Readonly<RemoteDevicePolicy>; readonly fromDefaults: boolean } {
    if (!isAbsolute(path)) throw new Error("Remote device policy path must be absolute.");
    const verified = checkedIdentity(identity);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare(`SELECT shell, approvals, read_only, only_here, audit FROM remote_device_policy
        WHERE account_id = ? AND device_id = ?`).get(verified.accountId, verified.deviceId) as unknown as PolicyRow | undefined;
      return policyFromRow(row);
    } finally { database.close(); }
  }

  updatePolicy(identity: VerifiedRemoteIdentity, patch: Partial<RemoteDevicePolicy>, origin: PolicyOrigin): Readonly<RemoteDevicePolicy> {
    const verified = checkedIdentity(identity);
    if (origin !== "local" && origin !== "remote") throw new Error("Remote policy origin is invalid.");
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.entries(patch).some(([key, value]) =>
      !Object.hasOwn(DEFAULT_REMOTE_DEVICE_POLICY, key) || typeof value !== "boolean")) throw new Error("Remote device policy update is invalid.");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const principal = this.find(verified);
      if (!principal || principal.revoked) throw new Error("Remote principal is unavailable or revoked.");
      const before = this.policy(verified);
      const next = { ...before, ...patch };
      if (origin !== "local" && ((!before.shell && next.shell) || (before.approvals && !next.approvals) ||
        (before.readOnly && !next.readOnly) || (before.onlyHere && !next.onlyHere) || (before.audit && !next.audit))) {
        throw new Error("Only the local user can broaden remote device policy.");
      }
      this.database.prepare(`INSERT INTO ${this.policyTable} (account_id, device_id, shell, approvals, read_only, only_here, audit)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, device_id) DO UPDATE SET
        shell=excluded.shell, approvals=excluded.approvals, read_only=excluded.read_only,
        only_here=excluded.only_here, audit=excluded.audit`).run(verified.accountId, verified.deviceId,
        Number(next.shell), Number(next.approvals), Number(next.readOnly), Number(next.onlyHere), Number(next.audit));
      // Record before committing: a failed audit write must never broaden policy silently.
      this.auditStore.recordPolicy(verified, origin, before, next);
      this.database.exec("COMMIT");
      return Object.freeze(next);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.database.close(); if (this.ownsAuditStore) this.auditStore.close(); }

  /** Migrate each project's earlier policy once, preserving the stricter choices. */
  private migratePolicy(path: string): void {
    if (this.database.prepare("SELECT 1 FROM remote_policy_migrations WHERE policy_path = ?").get(path)) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare("SELECT * FROM remote_device_policy").all() as unknown as Array<PolicyRow & { account_id: string; device_id: string }>;
      for (const row of rows) {
        const principal = this.database.prepare("SELECT client_id FROM remote_principals WHERE account_id = ? AND device_id = ? LIMIT 1").get(row.account_id, row.device_id) as { client_id: string } | undefined;
        if (!principal) throw new Error("Remote policy migration cannot identify its owner.");
        if ([row.shell, row.approvals, row.read_only, row.only_here, row.audit].some((value) => value !== 0 && value !== 1)) throw new Error("Remote device policy is invalid.");
        const identity = checkedIdentity({ accountId: row.account_id, clientId: principal.client_id, deviceId: row.device_id });
        const legacy: RemoteDevicePolicy = { shell: row.shell === 1, approvals: row.approvals === 1, readOnly: row.read_only === 1, onlyHere: row.only_here === 1, audit: row.audit === 1 };
        const current = this.policyStatus(identity);
        const next = current.fromDefaults ? legacy : { shell: current.policy.shell && legacy.shell,
          approvals: current.policy.approvals || legacy.approvals, readOnly: current.policy.readOnly || legacy.readOnly,
          onlyHere: current.policy.onlyHere || legacy.onlyHere, audit: current.policy.audit || legacy.audit };
        this.database.prepare(`INSERT INTO ${this.policyTable} (account_id, device_id, shell, approvals, read_only, only_here, audit)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, device_id) DO UPDATE SET shell=excluded.shell,
          approvals=excluded.approvals, read_only=excluded.read_only, only_here=excluded.only_here, audit=excluded.audit`).run(
          identity.accountId, identity.deviceId, Number(next.shell), Number(next.approvals), Number(next.readOnly), Number(next.onlyHere), Number(next.audit));
        this.auditStore.recordPolicy(identity, "system", current.policy, next);
      }
      this.database.prepare("INSERT INTO remote_policy_migrations (policy_path) VALUES (?)").run(path);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}

function policyFromRow(row: PolicyRow | undefined): { readonly policy: Readonly<RemoteDevicePolicy>; readonly fromDefaults: boolean } {
  if (!row) return { policy: DEFAULT_REMOTE_DEVICE_POLICY, fromDefaults: true };
  if (Object.values(row).some((value) => value !== 0 && value !== 1)) throw new Error("Remote device policy is invalid.");
  return { policy: Object.freeze({ shell: row.shell === 1, approvals: row.approvals === 1,
    readOnly: row.read_only === 1, onlyHere: row.only_here === 1, audit: row.audit === 1 }), fromDefaults: false };
}

function checkedIdentity(value: VerifiedRemoteIdentity): VerifiedRemoteIdentity {
  if (!value || typeof value !== "object" || [value.accountId, value.clientId, value.deviceId].some(
    (id) => typeof id !== "string" || id.length === 0 || id.length > 256 || id.includes("\0"),
  )) throw new Error("Verified remote identity is invalid.");
  return { accountId: value.accountId, clientId: value.clientId, deviceId: value.deviceId };
}
