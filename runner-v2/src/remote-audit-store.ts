import { mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RemoteDevicePolicy, VerifiedRemoteIdentity } from "./remote-principal.js";

export interface RemoteAuditRecord {
  readonly id: number;
  readonly occurredAt: string;
  readonly kind: "tool" | "policy" | "approval" | "pruned";
  readonly role: "remote" | "local_mcp" | "local" | "system";
  readonly accountId: string | null;
  readonly clientId: string | null;
  readonly deviceId: string | null;
  readonly toolName: string | null;
  readonly decision: string;
  readonly reasonCode: string | null;
  readonly pathCategory: string | null;
  readonly jobId: string | null;
  readonly outcomeCode: string;
  readonly origin: "local" | "remote" | "system" | null;
  readonly beforeFlags: string | null;
  readonly afterFlags: string | null;
}

export interface RemoteAuditStoreOptions {
  readonly maxAgeDays?: number;
  readonly maxRows?: number;
  readonly now?: () => Date;
}

export interface RemoteToolAudit {
  readonly role: "remote" | "local_mcp";
  readonly accountId?: string;
  readonly clientId?: string;
  readonly deviceId?: string;
  readonly toolName: string;
  readonly decision: "allowed" | "denied" | "refused" | "failed";
  readonly reasonCode?: string;
  readonly pathCategory?: string;
  readonly jobId?: string;
  readonly outcomeCode: string;
}

/** Append-only, metadata-only audit. No tool inputs, paths or outputs are accepted. */
export class RemoteAuditStore {
  private readonly database: DatabaseSync;
  private readonly maxAgeDays: number;
  private readonly maxRows: number;
  private readonly now: () => Date;

  constructor(path: string, options: RemoteAuditStoreOptions = {}) {
    if (!isAbsolute(path)) throw new Error("Remote audit path must be absolute.");
    this.maxAgeDays = options.maxAgeDays ?? 90;
    this.maxRows = options.maxRows ?? 1_000_000;
    if (!Number.isFinite(this.maxAgeDays) || this.maxAgeDays <= 0 || !Number.isSafeInteger(this.maxRows) || this.maxRows < 2) {
      throw new Error("Remote audit retention is invalid.");
    }
    this.now = options.now ?? (() => new Date());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS remote_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL, kind TEXT NOT NULL,
        role TEXT NOT NULL, account_id TEXT, client_id TEXT, device_id TEXT, tool_name TEXT,
        decision TEXT NOT NULL, reason_code TEXT, path_category TEXT, job_id TEXT,
        outcome_code TEXT NOT NULL, origin TEXT, before_flags TEXT, after_flags TEXT
      );`);
  }

  recordTool(record: RemoteToolAudit, enabled: boolean): void {
    if (!enabled) return;
    this.append({ ...record, kind: "tool", origin: null, beforeFlags: null, afterFlags: null });
  }

  recordApproval(identity: VerifiedRemoteIdentity | undefined, jobId: string,
    decision: "requested" | "approved" | "denied" | "expired" | "fenced"): void {
    this.append({ kind: "approval", role: "local", ...(identity ?? {}), jobId,
      decision, outcomeCode: "recorded", origin: "local", beforeFlags: null, afterFlags: null });
  }

  recordPolicy(identity: VerifiedRemoteIdentity, origin: "local" | "remote" | "system", before: Readonly<RemoteDevicePolicy>, after: Readonly<RemoteDevicePolicy>): void {
    this.append({ kind: "policy", role: origin, accountId: identity.accountId, clientId: identity.clientId,
      deviceId: identity.deviceId, toolName: null, decision: "allowed", reasonCode: "policy_changed",
      outcomeCode: "recorded", origin, beforeFlags: flags(before), afterFlags: flags(after) });
  }

  list(limit = 50): readonly RemoteAuditRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Remote audit limit is invalid.");
    const rows = this.database.prepare(`SELECT id, occurred_at AS occurredAt, kind, role,
      account_id AS accountId, client_id AS clientId, device_id AS deviceId, tool_name AS toolName,
      decision, reason_code AS reasonCode, path_category AS pathCategory, job_id AS jobId,
      outcome_code AS outcomeCode, origin, before_flags AS beforeFlags, after_flags AS afterFlags
      FROM remote_audit ORDER BY id DESC LIMIT ?`).all(limit);
    return rows as unknown as RemoteAuditRecord[];
  }

  close(): void { this.database.close(); }

  private append(record: {
    kind: "tool" | "policy" | "approval"; role: string; accountId?: string | null; clientId?: string | null;
    deviceId?: string | null; toolName?: string | null; decision: string; reasonCode?: string | null;
    pathCategory?: string | null; jobId?: string | null; outcomeCode: string; origin: string | null;
    beforeFlags: string | null; afterFlags: string | null;
  }): void {
    const now = this.now();
    const timestamp = now.toISOString();
    const cutoff = new Date(now.getTime() - this.maxAgeDays * 86_400_000).toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO remote_audit (occurred_at, kind, role, account_id, client_id, device_id,
        tool_name, decision, reason_code, path_category, job_id, outcome_code, origin, before_flags, after_flags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(timestamp, record.kind, record.role,
        record.accountId ?? null, record.clientId ?? null, record.deviceId ?? null, record.toolName ?? null,
        record.decision, safeCode(record.reasonCode), safeCode(record.pathCategory), safeCode(record.jobId),
        safeCode(record.outcomeCode) ?? "unknown", record.origin, record.beforeFlags, record.afterFlags);
      let removed = Number(this.database.prepare("DELETE FROM remote_audit WHERE occurred_at < ?").run(cutoff).changes);
      const count = Number((this.database.prepare("SELECT COUNT(*) AS count FROM remote_audit").get() as { count: number }).count);
      const excess = Math.max(0, count - this.maxRows + (removed > 0 || count > this.maxRows ? 1 : 0));
      if (excess > 0) removed += Number(this.database.prepare("DELETE FROM remote_audit WHERE id IN (SELECT id FROM remote_audit ORDER BY id LIMIT ?)").run(excess).changes);
      if (removed > 0) this.database.prepare(`INSERT INTO remote_audit
        (occurred_at, kind, role, decision, reason_code, outcome_code) VALUES (?, 'pruned', 'system', 'allowed', 'retention_pruned', 'gap')`).run(timestamp);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function flags(policy: Readonly<RemoteDevicePolicy>): string {
  return JSON.stringify({ shell: policy.shell, approvals: policy.approvals, readOnly: policy.readOnly, onlyHere: policy.onlyHere, audit: policy.audit });
}

function safeCode(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}
