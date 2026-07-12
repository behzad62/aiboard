import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ToolAccessRequest } from "./agent-contracts.js";
import type { PermissionProfile } from "./contracts.js";
import type { ToolApprovalRequest } from "./tool-broker.js";

export type PermissionDecision = "approved" | "denied";

export interface PermissionRequest {
  requestId: string;
  runId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  actor: { role: "architect" | "worker" | "subagent"; id: string };
  permissionProfile: PermissionProfile;
  access: ToolAccessRequest;
  outsideWorkspace: boolean;
  occurredAt: string;
}

export interface PermissionProjection extends PermissionRequest {
  status: "pending" | PermissionDecision;
  decidedAt?: string;
  decisionIdempotencyKey?: string;
}

export interface DecidePermissionInput {
  requestId: string;
  decision: PermissionDecision;
  idempotencyKey: string;
  occurredAt: string;
}

interface PermissionRow {
  request_id: string;
  run_id: string;
  request_json: string;
  status: string;
  decided_at: string | null;
  decision_idempotency_key: string | null;
}

export class SqlitePermissionStore {
  private readonly database: DatabaseSync;
  private readonly waiters = new Map<string, Array<(approved: boolean) => void>>();
  private closed = false;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS permission_requests (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_at TEXT,
        decision_idempotency_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_permission_requests_run
      ON permission_requests(run_id, request_id);
    `);
  }

  request(input: PermissionRequest): boolean | Promise<boolean> {
    this.assertOpen();
    validateRequest(input);
    const encoded = canonicalRequest(input);
    const existing = this.row(input.requestId);
    if (existing) {
      if (!sameRequest(JSON.parse(existing.request_json) as PermissionRequest, input)) {
        throw new Error(`Permission request ${input.requestId} conflicts with its durable identity.`);
      }
      if (existing.status === "approved") return true;
      if (existing.status === "denied") return false;
    } else {
      this.database.prepare(`
        INSERT INTO permission_requests (
          request_id, run_id, request_json, status, decided_at, decision_idempotency_key
        ) VALUES (?, ?, ?, 'pending', NULL, NULL)
      `).run(input.requestId, input.runId, encoded);
    }
    return new Promise<boolean>((resolve) => {
      const waiting = this.waiters.get(input.requestId) ?? [];
      waiting.push(resolve);
      this.waiters.set(input.requestId, waiting);
    });
  }

  async requestTool(input: ToolApprovalRequest): Promise<boolean> {
    return await this.request({
      requestId: permissionRequestId(input.runId, input.sessionId, input.callId),
      runId: input.runId,
      sessionId: input.sessionId,
      callId: input.callId,
      toolName: input.toolName,
      actor: input.actor,
      permissionProfile: input.permissionProfile,
      access: input.access,
      outsideWorkspace: input.outsideWorkspace,
      occurredAt: input.occurredAt,
    });
  }

  decide(input: DecidePermissionInput): PermissionProjection {
    this.assertOpen();
    if (!input.requestId || !input.idempotencyKey || Number.isNaN(Date.parse(input.occurredAt))) {
      throw new Error("Permission decision identity and timestamp are required.");
    }
    if (input.decision !== "approved" && input.decision !== "denied") {
      throw new Error("Permission decision must be approved or denied.");
    }
    const existing = this.row(input.requestId);
    if (!existing) throw new Error(`Unknown permission request ${input.requestId}.`);
    if (existing.status !== "pending") {
      if (
        existing.status !== input.decision ||
        existing.decision_idempotency_key !== input.idempotencyKey
      ) {
        throw new Error(`Permission request ${input.requestId} already has a different decision.`);
      }
      return decode(existing);
    }
    this.database.prepare(`
      UPDATE permission_requests
      SET status = ?, decided_at = ?, decision_idempotency_key = ?
      WHERE request_id = ? AND status = 'pending'
    `).run(input.decision, input.occurredAt, input.idempotencyKey, input.requestId);
    const waiters = this.waiters.get(input.requestId) ?? [];
    this.waiters.delete(input.requestId);
    for (const resolve of waiters) resolve(input.decision === "approved");
    return decode(this.row(input.requestId)!);
  }

  list(runId?: string): PermissionProjection[] {
    this.assertOpen();
    const rows = runId
      ? this.database.prepare(`
          SELECT request_id, run_id, request_json, status, decided_at,
                 decision_idempotency_key
          FROM permission_requests WHERE run_id = ? ORDER BY rowid
        `).all(runId)
      : this.database.prepare(`
          SELECT request_id, run_id, request_json, status, decided_at,
                 decision_idempotency_key
          FROM permission_requests ORDER BY rowid
        `).all();
    return (rows as unknown as PermissionRow[]).map(decode);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiters of this.waiters.values()) {
      for (const resolve of waiters) resolve(false);
    }
    this.waiters.clear();
    this.database.close();
  }

  private row(requestId: string): PermissionRow | undefined {
    return this.database.prepare(`
      SELECT request_id, run_id, request_json, status, decided_at,
             decision_idempotency_key
      FROM permission_requests WHERE request_id = ?
    `).get(requestId) as unknown as PermissionRow | undefined;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Permission store is closed.");
  }
}

export function permissionRequestId(
  runId: string,
  sessionId: string,
  callId: string
): string {
  return `perm_${createHash("sha256")
    .update(`${runId}\0${sessionId}\0${callId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function validateRequest(input: PermissionRequest): void {
  if (
    !input.requestId || !input.runId || !input.sessionId || !input.callId ||
    !input.toolName || !input.actor.id || !input.access.capability ||
    Number.isNaN(Date.parse(input.occurredAt))
  ) throw new Error("Permission request identity, access, and timestamp are required.");
}

function canonicalRequest(input: PermissionRequest): string {
  return JSON.stringify({
    requestId: input.requestId,
    runId: input.runId,
    sessionId: input.sessionId,
    callId: input.callId,
    toolName: input.toolName,
    actor: input.actor,
    permissionProfile: input.permissionProfile,
    access: input.access,
    outsideWorkspace: input.outsideWorkspace,
    occurredAt: input.occurredAt,
  });
}

function sameRequest(left: PermissionRequest, right: PermissionRequest): boolean {
  const withoutTime = (value: PermissionRequest) => ({
    requestId: value.requestId,
    runId: value.runId,
    sessionId: value.sessionId,
    callId: value.callId,
    toolName: value.toolName,
    actor: value.actor,
    permissionProfile: value.permissionProfile,
    access: value.access,
    outsideWorkspace: value.outsideWorkspace,
  });
  return JSON.stringify(withoutTime(left)) === JSON.stringify(withoutTime(right));
}

function decode(row: PermissionRow): PermissionProjection {
  const request = JSON.parse(row.request_json) as PermissionRequest;
  return {
    ...request,
    status: row.status as PermissionProjection["status"],
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.decision_idempotency_key
      ? { decisionIdempotencyKey: row.decision_idempotency_key }
      : {}),
  };
}
