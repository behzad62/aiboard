import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { LOCAL_MCP_DEPTH_LIMIT } from "./child-environment.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionHost } from "./execution-host.js";
import { createLocalMcpOwner, LocalMcpToolSession, type LocalMcpOwner } from "./remote-tool-runtime.js";
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

  constructor(private readonly options: {
    host: ExecutionHost; workspacePath: string; statePath: string; permissionProfile: PermissionProfile; capabilitiesConfig: RunnerCapabilitiesConfig;
    stateDirectory?: string; deviceDirectory?: string; extensionDirectories?: readonly string[]; installerBinDirectories?: readonly string[];
    protectedLocations?: import("./protected-locations.js").ProtectedLocations; pathGuard?: import("./remote-path-guard.js").RemotePathGuard;
  }) {
    if (options.statePath !== ":memory:" && !isAbsolute(options.statePath)) throw new Error("Local MCP state path must be absolute.");
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

/** The proxy implements protocol framing only; all tool operations go to Runner. */
export function createLocalMcpProxy(dispatch: (body: unknown) => Promise<unknown>): Server {
  const server = new Server({ name: "aiboard", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await dispatch({ operation: "list" });
    return result as { tools: Tool[] };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
