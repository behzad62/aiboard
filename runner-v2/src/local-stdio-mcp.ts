import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import { Server, type Tool, type Transport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { LOCAL_MCP_DEPTH_LIMIT } from "./child-environment.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionHost } from "./execution-host.js";
import { MANAGED_OUTPUT_WAIT_MAX_MS } from "./managed-process-contracts.js";
import { PROCESS_RUN_DEFAULT_TIMEOUT_MS } from "./process-tools.js";
import { createLocalMcpOwner, LocalMcpToolSession, type LocalMcpOwner, type LocalMcpPolicyOptions } from "./remote-tool-runtime.js";
import { RemoteDeviceStore } from "./remote-device-store.js";
import { DEFAULT_REMOTE_DEVICE_POLICY, RemotePrincipalStore } from "./remote-principal.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";

const IDLE_TTL_MS = 5 * 60_000;

interface SessionEntry {
  session: LocalMcpToolSession;
  expiresAt: number;
  active: number;
  timer?: NodeJS.Timeout;
}

/** Runner-owned sessions; the control socket owns revocation, not the MCP peer. */
export class LocalMcpSessions {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly cleanup = new Map<LocalMcpToolSession, Promise<void>>();
  private readonly failedRecovery = new Set<LocalMcpToolSession>();
  private readonly database: DatabaseSync;
  private recovered = false;
  private closing = false;
  private databaseClosed = false;
  private closePending?: Promise<void>;
  private readonly principals?: RemotePrincipalStore;
  private readonly options: {
    host: ExecutionHost; workspacePath: string; statePath: string; permissionProfile: PermissionProfile; capabilitiesConfig: RunnerCapabilitiesConfig;
    stateDirectory?: string; deviceDirectory?: string; extensionDirectories?: readonly string[]; installerBinDirectories?: readonly string[];
    protectedLocations?: import("./protected-locations.js").ProtectedLocations; pathGuard?: import("./remote-path-guard.js").RemotePathGuard;
  } & LocalMcpPolicyOptions;

  constructor(options: {
    host: ExecutionHost; workspacePath: string; statePath: string; permissionProfile: PermissionProfile; capabilitiesConfig: RunnerCapabilitiesConfig;
    stateDirectory?: string; deviceDirectory?: string; extensionDirectories?: readonly string[]; installerBinDirectories?: readonly string[];
    protectedLocations?: import("./protected-locations.js").ProtectedLocations; pathGuard?: import("./remote-path-guard.js").RemotePathGuard;
  } & LocalMcpPolicyOptions) {
    if (options.statePath !== ":memory:" && !isAbsolute(options.statePath)) throw new Error("Local MCP state path must be absolute.");
    const devicePolicyPath = options.deviceDirectory && existsSync(join(options.deviceDirectory, "remote-device.json"))
      ? join(options.deviceDirectory, "remote-device-policy.sqlite") : undefined;
    this.principals = options.stateDirectory ? new RemotePrincipalStore(join(options.stateDirectory, "remote-principals.sqlite"), undefined, devicePolicyPath) : undefined;
    const device = options.deviceDirectory ? new RemoteDeviceStore(options.deviceDirectory) : undefined;
    const policyIdentity = options.policyIdentity ?? (() => {
      const identity = device?.load();
      const session = device?.loadSession();
      if (!identity || !session) return undefined;
      if (identity.accountId !== session.accountId) throw new Error("Remote device identity does not match its session.");
      return { accountId: session.accountId, clientId: session.clientId, deviceId: identity.deviceId };
    });
    this.options = { ...options, policyIdentity,
      policy: options.policy ?? (() => { const identity = policyIdentity(); return identity && this.principals ? this.principals.policy(identity) : DEFAULT_REMOTE_DEVICE_POLICY; }),
      ...(options.auditStore || this.principals ? { auditStore: options.auditStore ?? this.principals!.auditStore } : {}) };
    this.database = new DatabaseSync(options.statePath);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS local_mcp_owners (
        run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL UNIQUE,
        depth INTEGER NOT NULL CHECK (depth >= 0 AND depth < 2)
      );`);
  }

  /** Recover exact previously recorded owners before admitting new sessions. */
  async recover(): Promise<void> {
    if (this.recovered || this.closing) throw new Error("Local MCP recovery is unavailable.");
    const rows = this.database.prepare("SELECT run_id, session_id, principal_id, depth FROM local_mcp_owners").all();
    if (rows.length > 1_024) throw new Error("Local MCP recovery exceeds its bounded owner count.");
    for (const row of rows) {
      const owner = parseOwner(row);
      const session = new LocalMcpToolSession(this.options, owner);
      try {
        await session.recover();
      } catch (error) {
        this.failedRecovery.add(session);
        const pending = session.close();
        this.cleanup.set(session, pending);
        void pending.catch(() => undefined);
        throw new AggregateError([error], "Local MCP recovery remains unverified.");
      }
      try { await session.close(); this.removeOwner(owner); }
      catch (error) {
        const pending = this.cleanupOwner(session);
        this.cleanup.set(session, pending);
        void pending.catch(() => undefined);
        throw new AggregateError([error], "Local MCP recovery cleanup remains unverified.");
      }
    }
    this.recovered = true;
  }

  mint(depth: number): { token: string; revoke: () => void } {
    if (this.closing || !Number.isSafeInteger(depth) || depth < 0 || depth >= LOCAL_MCP_DEPTH_LIMIT) throw new Error("local_mcp_recursion_limit: MCP nesting limit is 2.");
    if (!this.recovered) throw new Error("Local MCP startup recovery is incomplete.");
    const token = randomBytes(32).toString("hex");
    const owner = createLocalMcpOwner(depth);
    this.database.prepare("INSERT INTO local_mcp_owners (run_id, session_id, principal_id, depth) VALUES (?, ?, ?, ?)")
      .run(owner.runId, owner.sessionId, owner.identity.localClientId, owner.depth);
    const entry: SessionEntry = { session: new LocalMcpToolSession(this.options, owner), expiresAt: Date.now() + IDLE_TTL_MS, active: 0 };
    this.sessions.set(token, entry);
    this.schedule(token, entry);
    return { token, revoke: () => this.revoke(token) };
  }

  async perform(token: string, body: unknown): Promise<unknown> {
    const entry = this.sessions.get(token);
    if (!entry || this.closing || entry.active === 0 && Date.now() >= entry.expiresAt) {
      if (entry) this.revoke(token);
      throw new Error("Local MCP session is unavailable.");
    }
    entry.active += 1;
    try {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid local MCP request.");
      const request = body as Record<string, unknown>;
      if (request.operation === "list" && Object.keys(request).length === 1) return { tools: await entry.session.list() };
      if (request.operation === "call" && Object.keys(request).every((key) => ["operation", "name", "arguments"].includes(key)) && typeof request.name === "string") {
        const result = await entry.session.invoke(request.name, request.arguments ?? {});
        if (this.closing || this.sessions.get(token) !== entry) throw new Error("Local MCP session is unavailable.");
        if (request.name !== "image_inspect" || result.isError) return result;
        const content = await Promise.all(result.content.map(async (part) => {
          if (part.type !== "artifact" || !part.visual || !["image/png", "image/jpeg", "image/webp"].includes(part.mediaType)) return part;
          const bytes = await this.options.host.artifacts.get(part.hash);
          if (createHash("sha256").update(bytes).digest("hex") !== part.hash) throw new Error("Local MCP image artifact is invalid.");
          return { type: "image", mimeType: part.mediaType, data: bytes.toString("base64") };
        }));
        if (this.closing || this.sessions.get(token) !== entry) throw new Error("Local MCP session is unavailable.");
        return { ...result, content };
      }
      throw new Error("Invalid local MCP request.");
    } finally {
      entry.active -= 1;
      entry.expiresAt = Date.now() + IDLE_TTL_MS;
      if (this.sessions.get(token) === entry) this.schedule(token, entry);
    }
  }

  private schedule(token: string, entry: SessionEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.active > 0) { entry.expiresAt = Date.now() + IDLE_TTL_MS; this.schedule(token, entry); }
      else this.revoke(token);
    }, Math.max(1, entry.expiresAt - Date.now()));
    entry.timer.unref();
  }

  private revoke(token: string): void {
    const entry = this.sessions.get(token);
    if (!entry) return;
    this.sessions.delete(token);
    if (entry.timer) clearTimeout(entry.timer);
    const pending = this.cleanupOwner(entry.session);
    this.cleanup.set(entry.session, pending);
    void pending.then(() => this.cleanup.delete(entry.session), () => undefined);
  }

  close(): Promise<void> {
    if (this.databaseClosed) return Promise.resolve();
    if (this.closePending) return this.closePending;
    const pending = this.closeOnce();
    this.closePending = pending;
    void pending.finally(() => { if (this.closePending === pending) this.closePending = undefined; }).catch(() => undefined);
    return pending;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    for (const token of this.sessions.keys()) this.revoke(token);
    await Promise.allSettled(this.cleanup.values());
    const failures: unknown[] = [];
    for (const [session] of this.cleanup) {
      try {
        if (this.failedRecovery.has(session)) await session.close();
        else await this.cleanupOwner(session);
        this.cleanup.delete(session);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Local MCP cleanup remains unverified.");
    this.database.close();
    this.principals?.close();
    this.databaseClosed = true;
  }

  private removeOwner(owner: LocalMcpOwner): void {
    const result = this.database.prepare("DELETE FROM local_mcp_owners WHERE run_id = ? AND session_id = ? AND principal_id = ? AND depth = ?")
      .run(owner.runId, owner.sessionId, owner.identity.localClientId, owner.depth);
    if (result.changes !== 1) throw new Error("Local MCP owner record changed before cleanup.");
  }

  private async cleanupOwner(session: LocalMcpToolSession): Promise<void> {
    await session.close();
    this.removeOwner(session.owner);
  }
}

function parseOwner(row: Record<string, unknown>): LocalMcpOwner {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (typeof row.run_id !== "string" || !new RegExp(`^local-mcp-run-${uuid}$`).test(row.run_id) ||
      typeof row.session_id !== "string" || !new RegExp(`^local-mcp-session-${uuid}$`).test(row.session_id) ||
      typeof row.principal_id !== "string" || !new RegExp(`^local-mcp-${uuid}$`).test(row.principal_id) ||
      !Number.isSafeInteger(row.depth) || (row.depth as number) < 0 || (row.depth as number) >= LOCAL_MCP_DEPTH_LIMIT) {
    throw new Error("Local MCP owner record is invalid.");
  }
  return Object.freeze({ identity: Object.freeze({ kind: "local_mcp" as const, localClientId: row.principal_id }),
    runId: row.run_id, sessionId: row.session_id, depth: row.depth as number });
}

const seconds = (ms: number): string => `${ms / 1000} s`;

/**
 * Sent once at initialization; clients show it to the model alongside the tool list. It is the relay's
 * MCP_INSTRUCTIONS (packages/relay/src/mcp-tools.ts in aiboard-tunnel) without what only the remote path
 * has: devices, jobs and the relay's 45 s wait. local-stdio-mcp.test.ts holds it to a copy of the relay's.
 */
export const LOCAL_MCP_INSTRUCTIONS = [
  "AI Board Runner runs these tools on this computer, in the project folder it was started for.",
  "- Commands: process_run waits for the command to finish and returns the result. Large output comes back as head, tail and diagnostics plus a processId. process_read_output with that processId takes search to find lines and lines to read them by number (process_run takes search too); do not run the command again or pipe it to see more.",
  "- Servers, long jobs and interactive programs: process_start with until (port, pattern or exit), because process_run stops a command at timeoutMs (default " + seconds(PROCESS_RUN_DEFAULT_TIMEOUT_MS) + "): what it printed comes back, but its effect is unknown. process_read_output with until {exit: true} and waitMs waits up to " + seconds(MANAGED_OUTPUT_WAIT_MAX_MS) + " a call, so there is no need to poll quickly. process_interact sends one line and returns that turn's reply. process_signal stops a process and confirms it.",
  "- Files: files_read returns the file's sha256, even for a one-line range. files_patch (exact search and replace) and files_write default to the revision you last read or wrote, so read a file before changing it.",
  "- Git: status, diff and log have their own tools; commit by running git through process_run.",
  "- Every action that changes something needs an idempotencyKey: a new string per action, reused only to retry that same action.",
].join("\n");

/** The proxy implements protocol framing only; all tool operations go to Runner. */
export function createLocalMcpProxy(dispatch: (body: unknown) => Promise<unknown>): Server {
  const server = new Server({ name: "aiboard", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: LOCAL_MCP_INSTRUCTIONS });
  server.setRequestHandler("tools/list", async () => {
    const result = await dispatch({ operation: "list" });
    return result as { tools: Tool[] };
  });
  server.setRequestHandler("tools/call", async (request) => {
    const value = await dispatch({ operation: "call", name: request.params.name, arguments: request.params.arguments ?? {} });
    if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) throw new Error("Invalid Runner tool response.");
    const result = value as { content: Array<Record<string, unknown>>; isError?: boolean; error?: { code?: string; message?: string } };
    const content = result.content.map((part) => {
      if (part.type === "text" && typeof part.text === "string") return { type: "text" as const, text: part.text };
      if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return { type: "image" as const, data: part.data, mimeType: part.mimeType };
      return { type: "text" as const, text: JSON.stringify(part.type === "json" ? part.value : part) };
    });
    return { content, ...(result.isError ? { isError: true } : {}) };
  });
  return server;
}

export async function serveLocalStdioMcp(options: {
  port: number; token: string; closed: Promise<void>; input?: Readable; output?: Writable; transport?: Transport;
}): Promise<void> {
  const dispatch = async (body: unknown): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${options.port}/v1/local-mcp`, {
      method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Runner local MCP request refused (${response.status}).`);
    return await response.json();
  };
  const server = createLocalMcpProxy(dispatch);
  const input = options.input ?? process.stdin;
  const transport = options.transport ?? new StdioServerTransport(input, options.output ?? process.stdout, { maxBufferSize: 1_048_576 });
  let end!: () => void;
  const ended = new Promise<void>((resolve) => { end = resolve; });
  input.once("end", end);
  input.once("close", end);
  server.onclose = end;
  try { await server.connect(transport); await Promise.race([ended, options.closed]); }
  finally { input.off("end", end); input.off("close", end); await server.close(); }
}
