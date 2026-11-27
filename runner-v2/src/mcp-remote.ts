import { GetTaskResultV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { appToolMeta, appResourceDocument, appUri, type McpAppResourceDocument } from "./mcp-chat-app.js";
import { MCP_TASK_CAPABILITIES, settleModernToolCall, type McpInputResolver } from "./mcp-optional-features.js";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { acceptMcpProgress, type McpDispatchAuthorization, type McpProgressReporter } from "./mcp-gateway-tools.js";
import type { McpDiscoveryTool } from "./runner-internal-execution-context.js";

/** Streamable HTTP protocol versions this client negotiates, newest first. Legacy HTTP+SSE is not supported. */
const MODERN_MCP_VERSION = "2026-07-28";
export const REMOTE_MCP_PROTOCOL_VERSIONS = Object.freeze([MODERN_MCP_VERSION, "2025-11-25", "2025-06-18", "2025-03-26"]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_PAGES = 20;

// The modern HTTP binding mirrors method-specific names in a header. Task IDs
// are opaque and can contain Unicode or whitespace; use the spec sentinel.
function encodeMcpName(value: string): string {
  const safe = value.length > 0 && value === value.trim() &&
    !(value.startsWith("=?base64?") && value.endsWith("?=")) &&
    [...value].every(c => { const code = c.charCodeAt(0); return code === 9 || (code >= 32 && code <= 126); });
  return safe ? value : "=?base64?" + Buffer.from(value, "utf8").toString("base64") + "?=";
}

export class RemoteMcpError extends Error {
  constructor(readonly code: "needs_auth" | "insufficient_scope" | "destination_refused" | "protocol_error" | "http_error" | "outcome_unknown" | "session_expired" | "unsupported", message: string, readonly scope?: string) {
    super(message);
    this.name = "RemoteMcpError";
  }
}

export interface BoundMcpAuthorization {
  readonly header: string;
  readonly binding: string;
  readonly current: () => boolean;
}
type AuthorizationObserver = (binding: string | null | undefined) => void;
export interface RemoteMcpClientOptions {
  readonly url: string;
  /** Authorization header value for each request (refreshed by the caller's credential service). */
  readonly authorization?: (signal?: AbortSignal) => Promise<string | BoundMcpAuthorization | undefined>;
  readonly authorizeBeforeCredentials?: boolean;
  readonly timeoutMs?: number;
  readonly resolveInput?: McpInputResolver;
  readonly apps?: boolean;
  readonly fetch?: typeof fetch;
}

/**
 * Runner-hosted Streamable HTTP MCP client. One POST per JSON-RPC message; responses may be JSON or an
 * SSE stream. Redirects are never followed (credentials never cross origins), destinations are
 * validated, and server-initiated requests (sampling, elicitation, roots) are refused explicitly.
 */
export class RemoteMcpClient {
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private nextId = 1;
  private reconnect?: Promise<unknown>;
  private readonly lifetime = new AbortController();

  constructor(private readonly options: RemoteMcpClientOptions) {}

  get negotiatedVersion(): string | undefined {
    return this.protocolVersion;
  }

  async initialize(signal?: AbortSignal, modernOnly = false, authorize?: McpDispatchAuthorization): Promise<{ protocolVersion: string; serverName?: string }> {
    await assertRemoteDestination(this.options.url);
    // Probe only with a read-only request; never replay a tool call to negotiate.
    const probeId = this.nextId++;
    const probe = await this.post({
      jsonrpc: "2.0", id: probeId, method: "server/discover", params: { _meta: this.modernMeta() },
    }, probeId, false, signal, undefined, authorize, true);
    if (probe?.jsonrpc === "2.0" && probe.id === probeId && probe.result) {
      const discovery = record(probe.result);
      if (Array.isArray(discovery.supportedVersions) && discovery.supportedVersions.includes(MODERN_MCP_VERSION)) {
        this.protocolVersion = MODERN_MCP_VERSION;
        this.sessionId = undefined;
        const meta = record(discovery._meta ?? {});
        const info = record(meta["io.modelcontextprotocol/serverInfo"] ?? {});
        return { protocolVersion: MODERN_MCP_VERSION, ...(typeof info.name === "string" ? { serverName: info.name.slice(0, 120) } : {}) };
      }
    }
    if (modernOnly) throw new RemoteMcpError("unsupported","Recovery requires modern MCP.");
    this.sessionId = undefined;
    const result = record(await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: this.options.apps ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {},
      clientInfo: { name: "aiboard-runner", version: "2" },
    }));
    const version = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
    if (version === MODERN_MCP_VERSION || !REMOTE_MCP_PROTOCOL_VERSIONS.includes(version)) throw new RemoteMcpError("unsupported", `The server speaks MCP ${version || "(unknown)"}; AI Board supports ${REMOTE_MCP_PROTOCOL_VERSIONS.join(" and ")}.`);
    this.protocolVersion = version;
    await this.notify("notifications/initialized");
    const info = result.serverInfo && typeof result.serverInfo === "object" ? result.serverInfo as Record<string, unknown> : {};
    return { protocolVersion: version, ...(typeof info.name === "string" ? { serverName: info.name.slice(0, 120) } : {}) };
  }

  async listTools(signal?: AbortSignal, authorize?: McpDispatchAuthorization): Promise<McpDiscoveryTool[]> {
    try {
      if (!this.protocolVersion) await this.reinitialize();
      return await this.readTools(signal,authorize);
    } catch (error) {
      if (!(error instanceof RemoteMcpError) || error.code !== "session_expired") throw error;
      if (!this.protocolVersion) await this.reinitialize();
      return await this.readTools(signal,authorize);
    }
  }

  private async reinitialize(): Promise<void> {
    this.reconnect ??= this.initialize().finally(() => { this.reconnect = undefined; });
    await this.reconnect;
  }

  private async readTools(signal?: AbortSignal, authorize?: McpDispatchAuthorization): Promise<McpDiscoveryTool[]> {
    if (this.reconnect) await this.reconnect;
    const tools: McpDiscoveryTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = record(await this.request("tools/list", cursor ? { cursor } : {}, signal,false,undefined,authorize));
      for (const raw of Array.isArray(result.tools) ? result.tools : []) {
        const tool = record(raw);
        if (typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) continue;
        if (names.has(tool.name) || names.size >= 1024) throw new RemoteMcpError("protocol_error", "MCP tools are duplicated or exceed the inventory bound.");
        names.add(tool.name);
        const ui = appToolMeta(tool._meta);
        if (ui.appOnly) continue;
        const annotations = tool.annotations && typeof tool.annotations === "object" ? tool.annotations as Record<string, unknown> : undefined;
        tools.push({
          name: tool.name,
          ...(ui.resourceUri ? { uiResourceUri: ui.resourceUri } : {}),
          ...(ui.modelOnly ? { modelOnly: true as const } : {}),
          ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 2000) } : {}),
          ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
          ...(annotations ? { annotations: {
            ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
            ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
          } } : {}),
        });
      }
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) {
        throw new RemoteMcpError("protocol_error", "MCP tool discovery returned an invalid cursor.");
      }
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new RemoteMcpError("protocol_error", "MCP tool discovery exceeded its page bound.");
  }

  /**
   * One tool call, sent once. If the request may have reached the server but no response arrived, the
   * result is outcome_unknown and is never retried automatically.
   */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal,
    progress?: McpProgressReporter, authorize?: McpDispatchAuthorization, resolveInput?: McpInputResolver, onTask?: (task: import("./mcp-task-recovery.js").McpTaskHandleObservation) => void, onCredential?: AuthorizationObserver): Promise<{ content: unknown[]; isError: boolean; structuredContent?: unknown; _meta?: Record<string, unknown> }> {
    const params = { name, arguments: args };
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const budget = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, budget]) : budget;
    let binding: string | null | undefined;
    let observed=false;
    const observe: AuthorizationObserver=value=>{
      if (observed && value!==binding) throw new RemoteMcpError("outcome_unknown","Downstream credential changed during the original call.");
      if (!observed) onCredential?.(value);
      binding=value; observed=true;
    };
    const initial = await this.request("tools/call", params, combined, true, progress, authorize,observe);
    let result = record(initial);
    if (this.protocolVersion === MODERN_MCP_VERSION && ["input_required", "task"].includes(String(result.resultType))) {
      try {
        result = await settleModernToolCall({ initial, params, timeoutMs, signal: combined,
          resolveInput: resolveInput ?? this.options.resolveInput,
          onTask: onTask && (task=>{if(observed && binding!==null) onTask({...task,...(binding?{credentialBinding:binding}:{})});}),
          request: (method, payload, requestSignal) => this.request(method, payload, requestSignal, method !== "tasks/get", progress, authorize,observe),
        });
      } catch {
        throw new RemoteMcpError("outcome_unknown", "MCP task or continuation did not complete; cancellation is not proof of termination. The original call was not replayed.");
      }
    }
    if (!Array.isArray(result.content)) throw new RemoteMcpError("outcome_unknown", "MCP returned no completed tool result (interactive continuations are not supported); the call was not retried.");
    return { content: result.content, isError: result.isError === true,
      ...(Object.hasOwn(result, "structuredContent") ? { structuredContent: result.structuredContent } : {}),
      ...(result._meta && typeof result._meta === "object" && !Array.isArray(result._meta) ? { _meta: result._meta as Record<string, unknown> } : {}) };
  }

  /** Recovery is read only: never dispatch tools/call, update, or cancel. */
  async readTaskOutcome(taskId: string, createdAt: string, signal: AbortSignal, authorize?: McpDispatchAuthorization): Promise<Record<string, unknown> | undefined> {
    if (this.protocolVersion !== MODERN_MCP_VERSION || !taskId || taskId.length>512) return;
    const raw=await this.request("tasks/get",{taskId},signal,false,undefined,authorize);
    const parsed=GetTaskResultV2Schema.safeParse(raw);
    if (!parsed.success || parsed.data.taskId!==taskId || Date.parse(parsed.data.createdAt)!==Date.parse(createdAt)) return;
    if (parsed.data.status==="completed" && Array.isArray(parsed.data.result.content)) return parsed.data.result;
    // A failed/cancelled status without completed tool content does not establish the effect outcome.
  }

  async readAppResourceDocument(uri: string, signal?: AbortSignal, authorize?: McpDispatchAuthorization): Promise<McpAppResourceDocument | undefined> {
    if (!this.options.apps || !appUri(uri)) return;
    const deadline = AbortSignal.timeout(5000);
    const raw = await this.request("resources/read", { uri }, signal ? AbortSignal.any([signal, deadline]) : deadline, false, undefined, authorize);
    return appResourceDocument(uri, raw);
  }
  async readAppResource(uri: string, signal?: AbortSignal, authorize?: McpDispatchAuthorization): Promise<string | undefined> {
    const document=await this.readAppResourceDocument(uri,signal,authorize);
    return document && !document.resourceDomains.length ? document.html : undefined;
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    if (!this.sessionId) return;
    const headers = await this.headers();
    this.sessionId = undefined;
    await (this.options.fetch ?? fetch)(this.options.url, { method: "DELETE", headers, redirect: "manual", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method }, undefined, false);
  }

  private modernMeta(): Record<string, unknown> {
    return {
      "io.modelcontextprotocol/protocolVersion": MODERN_MCP_VERSION,
      "io.modelcontextprotocol/clientCapabilities": { ...MCP_TASK_CAPABILITIES, extensions: { ...MCP_TASK_CAPABILITIES.extensions, ...(this.options.apps ? { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } : {}) }, elicitation: { form: {} } },
      "io.modelcontextprotocol/clientInfo": { name: "aiboard-runner", version: "2" },
    };
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal, mutating = false,
    progress?: McpProgressReporter, authorize?: McpDispatchAuthorization, observe?: AuthorizationObserver): Promise<unknown> {
    const id = this.nextId++;
    const modern = this.protocolVersion === MODERN_MCP_VERSION;
    const message = await this.post({ jsonrpc: "2.0", id, method,
      params: modern || progress ? { ...params, _meta: { ...(modern ? this.modernMeta() : {}), ...(progress ? { progressToken: id } : {}) } } : params }, id, mutating, signal, progress, authorize,false,observe);
    if (!message || message.jsonrpc !== "2.0" || message.id !== id || ("result" in message) === ("error" in message)) throw new RemoteMcpError("protocol_error", `The server sent no matching response to ${method}.`);
    if (message.error) {
      const error = record(message.error);
      throw new RemoteMcpError("protocol_error", `The server refused ${method}: ${String(error.message ?? "error").slice(0, 300)}`);
    }
    return message.result;
  }

  private async headers(capture?: (value: BoundMcpAuthorization | string | undefined) => void, signal?: AbortSignal): Promise<Record<string, string>> {
    const credential = await this.options.authorization?.(signal);
    capture?.(credential);
    const authorization=typeof credential==="object"?credential.header:credential;
    return {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
      ...(authorization ? { authorization } : {}),
    };
  }

  private async post(body: Record<string, unknown>, id: number | undefined, mutating: boolean, signal?: AbortSignal,
    progress?: McpProgressReporter, authorize?: McpDispatchAuthorization, probing = false, observe?: AuthorizationObserver): Promise<Record<string, unknown> | undefined> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? (mutating ? 120_000 : 60_000));
    const combined = AbortSignal.any([this.lifetime.signal, timeout, ...(signal ? [signal] : [])]);
    let response: Response;
    let sent = false;
    let sentHeaders: Record<string, string> | undefined;
    let requestSession: string | undefined;
    const notifyCancellation = () => {
      if (this.protocolVersion === MODERN_MCP_VERSION || !mutating || id === undefined || !sentHeaders || !combined.aborted) return;
      // The older HTTP protocol cancels a specific request with a separate notification.
      void (this.options.fetch ?? fetch)(this.options.url, { method: "POST", headers: sentHeaders, redirect: "manual",
        signal: AbortSignal.timeout(1_000), body: JSON.stringify({
          jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id },
        }) }).then((reply) => reply.body?.cancel()).catch(() => undefined);
    };
    try {
      if (this.options.authorizeBeforeCredentials && authorize && !await authorize())
        throw new RemoteMcpError("unsupported", "MCP authorization changed before credential access.");
      combined.throwIfAborted();
      let credential: BoundMcpAuthorization | string | undefined;
      const headers = await this.headers(value=>{credential=value;},combined);
      if (probing || this.protocolVersion === MODERN_MCP_VERSION) {
        delete headers["mcp-session-id"];
        headers["mcp-protocol-version"] = MODERN_MCP_VERSION;
        headers["mcp-method"] = String(body.method);
        const nameField = body.method === "tools/call" || body.method === "prompts/get" ? "name"
          : body.method === "resources/read" ? "uri"
          : ["tasks/get", "tasks/update", "tasks/cancel"].includes(String(body.method)) ? "taskId" : undefined;
        if (nameField) {
          const value = record(body.params)[nameField];
          if (typeof value === "string") headers["mcp-name"] = encodeMcpName(value);
        }
      }
      if (authorize && !await authorize()) throw new RemoteMcpError("unsupported", "MCP authorization changed before dispatch.");
      combined.throwIfAborted();
      if (typeof credential==="object" && !credential.current()) throw new RemoteMcpError("needs_auth","Downstream credential changed before dispatch.");
      observe?.(typeof credential==="object"?credential.binding:typeof credential==="string"?null:undefined);
      sentHeaders = headers;
      requestSession = headers["mcp-session-id"];
      sent = true;
      response = await (this.options.fetch ?? fetch)(this.options.url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: combined });
    } catch (error) {
      notifyCancellation();
      if (error instanceof RemoteMcpError) throw error;
      if (mutating && sent) throw new RemoteMcpError("outcome_unknown", "The connection failed after the call was sent; it may or may not have run. It was not retried.");
      throw new RemoteMcpError("http_error", `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) throw new RemoteMcpError("destination_refused", "The server redirected the request; AI Board does not follow MCP redirects.");
    if (response.status === 401) throw new RemoteMcpError("needs_auth", "The server needs you to sign in.", challengeScope(response.headers.get("www-authenticate")));
    if (response.status === 403 && /insufficient_scope/i.test(response.headers.get("www-authenticate") ?? "")) {
      throw new RemoteMcpError("insufficient_scope", "The server needs additional permissions; sign in again.", challengeScope(response.headers.get("www-authenticate")));
    }
    if (response.status === 404 && requestSession) {
      if (this.sessionId === requestSession) {
        this.sessionId = undefined;
        this.protocolVersion = undefined;
      }
      throw new RemoteMcpError(mutating ? "outcome_unknown" : "session_expired", "The server ended this MCP session.");
    }
    if (probing && [400, 404, 405, 501].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!response.ok && response.status !== 202) {
      if (mutating) throw new RemoteMcpError("outcome_unknown", `The server answered ${response.status} to a tool call; it was not retried.`);
      throw new RemoteMcpError("http_error", `The server answered ${response.status}.`);
    }
    const session = response.headers.get("mcp-session-id");
    if (!probing && this.protocolVersion !== MODERN_MCP_VERSION && !this.lifetime.signal.aborted && session && /^[\x21-\x7e]{1,256}$/.test(session)) this.sessionId = session;
    if (id === undefined || response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
      if (mutating) throw new RemoteMcpError("outcome_unknown", "The server accepted the tool call without returning its result.");
      return undefined;
    }
    const type = response.headers.get("content-type") ?? "";
    try {
      const message = type.includes("text/event-stream") ? await this.readStream(response, id, progress) : record(JSON.parse(await boundedText(response)));
      if (mutating && (!message || message.jsonrpc !== "2.0" || message.id !== id || ("result" in message) === ("error" in message))) {
        throw new RemoteMcpError("outcome_unknown", "The server did not return a matching tool response.");
      }
      return message;
    } catch (error) {
      notifyCancellation();
      if (error instanceof RemoteMcpError && error.code === "outcome_unknown") throw error;
      if (mutating) throw new RemoteMcpError("outcome_unknown", "The tool response was unreadable or cut off; the call may or may not have run.");
      throw new RemoteMcpError("protocol_error", "The server sent an unreadable response.");
    }
  }

  private async readStream(response: Response, id: number, progress?: McpProgressReporter): Promise<Record<string, unknown> | undefined> {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) throw new RemoteMcpError("protocol_error", "The server's response is too large.");
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const message = record(JSON.parse(data));
          if (progress && message.jsonrpc === "2.0") {
            try { acceptMcpProgress(message, id, progress); } catch { /* Reporting never interrupts the request. */ }
          }
          if (message.id === id && ("result" in message || "error" in message)) return message;
          if (this.protocolVersion !== MODERN_MCP_VERSION && typeof message.method === "string" && message.id !== undefined) await this.refuseServerRequest(message);
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return undefined;
  }

  /** Sampling, elicitation and roots requests never trigger model calls or user prompts from here. */
  private async refuseServerRequest(message: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `${String(message.method)} is not supported by this client.` } }, undefined, false).catch(() => undefined);
  }
}

/** HTTPS by default; plain HTTP only for loopback. Hostnames resolving to private networks are refused. */
export async function assertRemoteDestination(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RemoteMcpError("destination_refused", "That is not a valid URL.");
  }
  if (parsed.username || parsed.password) throw new RemoteMcpError("destination_refused", "Credentials in the URL are not allowed; use the sign-in or secret field.");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || isLoopback(host);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new RemoteMcpError("destination_refused", "Remote MCP servers must use https (plain http is allowed only for localhost).");
  if (loopback) return parsed;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [] as Array<{ address: string }>);
  if (!addresses.length) throw new RemoteMcpError("destination_refused", `${host} could not be resolved.`);
  if (addresses.some((entry) => isPrivate(entry.address))) throw new RemoteMcpError("destination_refused", `${host} resolves to a private network address; only public servers and localhost are allowed.`);
  return parsed;
}

function isLoopback(address: string): boolean {
  return /^127\./.test(address) || address === "::1";
}

function isPrivate(address: string): boolean {
  if (isLoopback(address)) return true;
  if (/^(10\.|192\.168\.|169\.254\.|0\.)/.test(address)) return true;
  const match = /^172\.(\d+)\./.exec(address);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return true;
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("::ffff:10.") || lower.startsWith("::ffff:192.168.") || lower.startsWith("::ffff:127.");
}

function challengeScope(header: string | null): string | undefined {
  return header ? /scope="([^"]{1,500})"/i.exec(header)?.[1] : undefined;
}

function resourceMetadataFromChallenge(header: string | null): string | undefined {
  return header ? /resource_metadata="([^"]{1,2000})"/i.exec(header)?.[1] : undefined;
}

async function boundedText(response: Response): Promise<string> {
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) throw new RemoteMcpError("protocol_error", "The server's response is too large.");
  return Buffer.from(body).toString("utf8");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RemoteMcpError("protocol_error", "Unexpected response shape.");
  return value as Record<string, unknown>;
}

// ---- OAuth (MCP authorization: protected resource metadata, RFC 8414, RFC 7591, PKCE, RFC 8707) -----------

export interface OAuthServerDescription {
  readonly resource: string;
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly scope?: string;
}

export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scope?: string;
}

/** The canonical resource identifier for an MCP server URL (no fragment or query). */
export function canonicalResource(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || ""}`;
}

/**
 * Discovers the authorization server for an MCP server. Metadata is fetched only from the MCP
 * server's own origin and from the issuer it names, never from an arbitrary model- or server-supplied
 * URL elsewhere, so discovery is not a general fetch primitive.
 */
export async function discoverOAuthServer(serverUrl: string, fetcher: typeof fetch = fetch): Promise<OAuthServerDescription> {
  const server = await assertRemoteDestination(serverUrl);
  const headers = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  const clientInfo = { name: "aiboard-runner", version: "2" };
  const probe = await fetcher(server, { method: "POST", headers: { ...headers, "mcp-protocol-version": MODERN_MCP_VERSION, "mcp-method": "server/discover" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_MCP_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": clientInfo,
    } } }), redirect: "manual", signal: AbortSignal.timeout(20_000) });
  await probe.body?.cancel().catch(() => undefined);
  let challenge = probe.headers.get("www-authenticate");
  if (!challenge && (probe.ok || [400, 404, 405, 501].includes(probe.status))) {
    // Some legacy servers do not challenge until initialize. No credentials or
    // tool calls are sent during either authorization discovery probe.
    const legacy = await fetcher(server, { method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo },
    }), redirect: "manual", signal: AbortSignal.timeout(20_000) });
    challenge = legacy.headers.get("www-authenticate");
    await legacy.body?.cancel().catch(() => undefined);
  }
  const advertised = resourceMetadataFromChallenge(challenge);
  const candidates = advertised ? [advertised] : [`${server.origin}/.well-known/oauth-protected-resource${server.pathname.replace(/\/+$/, "")}`, `${server.origin}/.well-known/oauth-protected-resource`];
  let metadata: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    const url = new URL(candidate, server);
    if (url.origin !== server.origin) throw new RemoteMcpError("destination_refused", "The server's resource metadata is on another origin; AI Board does not follow it.");
    metadata = await fetchMetadata(url, fetcher).catch(() => undefined);
    if (metadata) break;
  }
  if (!metadata) throw new RemoteMcpError("unsupported", "The server asked for sign-in but publishes no OAuth resource metadata.");
  const resource = typeof metadata.resource === "string" ? metadata.resource : "";
  // The protected resource must be this server's origin and a path prefix of its URL.
  const covers = (() => {
    try {
      const declared = canonicalResource(resource);
      const actual = canonicalResource(server.href);
      return new URL(resource).origin === server.origin && (actual === declared || actual.startsWith(`${declared}/`) || declared === server.origin);
    } catch {
      return false;
    }
  })();
  if (!covers) {
    throw new RemoteMcpError("destination_refused", "The server's resource metadata does not describe this server.");
  }
  const issuers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string") : [];
  if (!issuers[0]) throw new RemoteMcpError("unsupported", "The server names no authorization server.");
  const issuer = await assertRemoteDestination(issuers[0]);
  const path = issuer.pathname.replace(/\/+$/, "");
  let authorization: Record<string, unknown> | undefined;
  for (const candidate of [`${issuer.origin}/.well-known/oauth-authorization-server${path}`, `${issuer.origin}/.well-known/openid-configuration${path}`, ...(path ? [`${issuer.origin}${path}/.well-known/openid-configuration`] : [])]) {
    authorization = await fetchMetadata(new URL(candidate), fetcher).catch(() => undefined);
    if (authorization) break;
  }
  if (!authorization) throw new RemoteMcpError("unsupported", "The authorization server publishes no metadata.");
  if (typeof authorization.issuer !== "string" || authorization.issuer.replace(/\/+$/, "") !== `${issuer.origin}${path}`) throw new RemoteMcpError("destination_refused", "The authorization server's metadata names a different issuer.");
  const methods = Array.isArray(authorization.code_challenge_methods_supported) ? authorization.code_challenge_methods_supported : [];
  if (!methods.includes("S256")) throw new RemoteMcpError("unsupported", "The authorization server does not support PKCE (S256), which MCP requires.");
  const endpoint = async (value: unknown, what: string) => {
    if (typeof value !== "string") throw new RemoteMcpError("unsupported", `The authorization server has no ${what}.`);
    return (await assertRemoteDestination(value)).href;
  };
  const scopes = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.filter((entry): entry is string => typeof entry === "string") : [];
  const scope = challengeScope(challenge) ?? (scopes.length ? scopes.join(" ") : undefined);
  return {
    resource: canonicalResource(resource),
    issuer: `${issuer.origin}${path}`,
    authorizationEndpoint: await endpoint(authorization.authorization_endpoint, "authorization endpoint"),
    tokenEndpoint: await endpoint(authorization.token_endpoint, "token endpoint"),
    ...(typeof authorization.registration_endpoint === "string" ? { registrationEndpoint: await endpoint(authorization.registration_endpoint, "registration endpoint") } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** RFC 7591 dynamic registration as a public client (PKCE, no client secret). */
export async function registerOAuthClient(description: OAuthServerDescription, redirectUri: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!description.registrationEndpoint) throw new RemoteMcpError("unsupported", "This server needs a pre-registered OAuth client, which AI Board does not support yet.");
  const response = await fetcher(description.registrationEndpoint, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: "AI Board Runner", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
  });
  if (!response.ok) throw new RemoteMcpError("http_error", `Client registration failed (${response.status}).`);
  const body = record(JSON.parse(await boundedText(response)));
  if (typeof body.client_id !== "string" || !body.client_id) throw new RemoteMcpError("protocol_error", "Client registration returned no client id.");
  return body.client_id;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(description: OAuthServerDescription, input: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(description.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", description.resource);
  if (description.scope) url.searchParams.set("scope", description.scope);
  return url.href;
}

export async function exchangeToken(description: Pick<OAuthServerDescription, "tokenEndpoint" | "resource">, form: Record<string, string>, fetcher: typeof fetch = fetch, now = Date.now(), signal?: AbortSignal): Promise<OAuthTokens> {
  const deadline=AbortSignal.timeout(20_000);
  const combined=signal?AbortSignal.any([signal,deadline]):deadline;
  combined.throwIfAborted();
  const response = await fetcher(description.tokenEndpoint, {
    method: "POST", redirect: "manual", signal: combined,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...form, resource: description.resource }).toString(),
  });
  if (!response.ok) throw new RemoteMcpError("needs_auth", `The authorization server refused the token request (${response.status}).`);
  const body = record(JSON.parse(await boundedText(response)));
  if (typeof body.access_token !== "string" || !body.access_token) throw new RemoteMcpError("protocol_error", "The token response has no access token.");
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") throw new RemoteMcpError("unsupported", `Unsupported token type ${body.token_type}.`);
  return {
    accessToken: body.access_token,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" ? { expiresAt: new Date(now + body.expires_in * 1000).toISOString() } : {}),
    ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
  };
}

async function fetchMetadata(url: URL, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  await assertRemoteDestination(url.href);
  const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
  if (!response.ok) throw new RemoteMcpError("http_error", `Metadata answered ${response.status}.`);
  return record(JSON.parse(await boundedText(response)));
}
