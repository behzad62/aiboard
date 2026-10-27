import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { McpDiscoveryTool } from "./runner-internal-execution-context.js";

/** Streamable HTTP protocol versions this client negotiates, newest first. Legacy HTTP+SSE is not supported. */
export const REMOTE_MCP_PROTOCOL_VERSIONS = Object.freeze(["2025-06-18", "2025-03-26"]);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_PAGES = 20;

export class RemoteMcpError extends Error {
  constructor(readonly code: "needs_auth" | "insufficient_scope" | "destination_refused" | "protocol_error" | "http_error" | "outcome_unknown" | "unsupported", message: string, readonly scope?: string) {
    super(message);
    this.name = "RemoteMcpError";
  }
}

export interface RemoteMcpClientOptions {
  readonly url: string;
  /** Authorization header value for each request (refreshed by the caller's credential service). */
  readonly authorization?: () => Promise<string | undefined>;
  readonly timeoutMs?: number;
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

  constructor(private readonly options: RemoteMcpClientOptions) {}

  get negotiatedVersion(): string | undefined {
    return this.protocolVersion;
  }

  async initialize(): Promise<{ protocolVersion: string; serverName?: string }> {
    await assertRemoteDestination(this.options.url);
    const result = record(await this.request("initialize", {
      protocolVersion: REMOTE_MCP_PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "aiboard-runner", version: "2" },
    }));
    const version = typeof result.protocolVersion === "string" ? result.protocolVersion : "";
    if (!REMOTE_MCP_PROTOCOL_VERSIONS.includes(version)) throw new RemoteMcpError("unsupported", `The server speaks MCP ${version || "(unknown)"}; AI Board supports ${REMOTE_MCP_PROTOCOL_VERSIONS.join(" and ")}.`);
    this.protocolVersion = version;
    await this.notify("notifications/initialized");
    const info = result.serverInfo && typeof result.serverInfo === "object" ? result.serverInfo as Record<string, unknown> : {};
    return { protocolVersion: version, ...(typeof info.name === "string" ? { serverName: info.name.slice(0, 120) } : {}) };
  }

  async listTools(): Promise<McpDiscoveryTool[]> {
    const tools: McpDiscoveryTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = record(await this.request("tools/list", cursor ? { cursor } : {}));
      for (const raw of Array.isArray(result.tools) ? result.tools : []) {
        const tool = record(raw);
        if (typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) continue;
        const annotations = tool.annotations && typeof tool.annotations === "object" ? tool.annotations as Record<string, unknown> : undefined;
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 2000) } : {}),
          ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
          ...(annotations ? { annotations: {
            ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
            ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
          } } : {}),
        });
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * One tool call, sent once. If the request may have reached the server but no response arrived, the
   * result is outcome_unknown and is never retried automatically.
   */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: unknown[]; isError: boolean }> {
    const result = record(await this.request("tools/call", { name, arguments: args }, signal, true));
    return { content: Array.isArray(result.content) ? result.content : [], isError: result.isError === true };
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    const headers = await this.headers();
    await (this.options.fetch ?? fetch)(this.options.url, { method: "DELETE", headers, redirect: "manual", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
    this.sessionId = undefined;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: "2.0", method }, undefined, false);
  }

  private async request(method: string, params: unknown, signal?: AbortSignal, mutating = false): Promise<unknown> {
    const id = this.nextId++;
    const message = await this.post({ jsonrpc: "2.0", id, method, params }, id, mutating, signal);
    if (!message) throw new RemoteMcpError("protocol_error", `The server sent no response to ${method}.`);
    if (message.error) {
      const error = record(message.error);
      throw new RemoteMcpError("protocol_error", `The server refused ${method}: ${String(error.message ?? "error").slice(0, 300)}`);
    }
    return message.result;
  }

  private async headers(): Promise<Record<string, string>> {
    const authorization = await this.options.authorization?.();
    return {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
      ...(authorization ? { authorization } : {}),
    };
  }

  private async post(body: Record<string, unknown>, id: number | undefined, mutating: boolean, signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    let sent = false;
    try {
      const headers = await this.headers();
      sent = true;
      response = await (this.options.fetch ?? fetch)(this.options.url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: combined });
    } catch (error) {
      if (error instanceof RemoteMcpError) throw error;
      if (mutating && sent) throw new RemoteMcpError("outcome_unknown", "The connection failed after the call was sent; it may or may not have run. It was not retried.");
      throw new RemoteMcpError("http_error", `Could not reach the server: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) throw new RemoteMcpError("destination_refused", "The server redirected the request; AI Board does not follow MCP redirects.");
    if (response.status === 401) throw new RemoteMcpError("needs_auth", "The server needs you to sign in.", challengeScope(response.headers.get("www-authenticate")));
    if (response.status === 403 && /insufficient_scope/i.test(response.headers.get("www-authenticate") ?? "")) {
      throw new RemoteMcpError("insufficient_scope", "The server needs additional permissions; sign in again.", challengeScope(response.headers.get("www-authenticate")));
    }
    if (response.status === 404 && this.sessionId) {
      this.sessionId = undefined;
      throw new RemoteMcpError("protocol_error", "The server ended this MCP session.");
    }
    if (!response.ok && response.status !== 202) {
      if (mutating) throw new RemoteMcpError("outcome_unknown", `The server answered ${response.status} to a tool call; it was not retried.`);
      throw new RemoteMcpError("http_error", `The server answered ${response.status}.`);
    }
    const session = response.headers.get("mcp-session-id");
    if (session && /^[\x21-\x7e]{1,256}$/.test(session)) this.sessionId = session;
    if (id === undefined || response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const type = response.headers.get("content-type") ?? "";
    try {
      if (type.includes("text/event-stream")) return await this.readStream(response, id);
      return record(JSON.parse(await boundedText(response)));
    } catch (error) {
      if (error instanceof RemoteMcpError) throw error;
      if (mutating) throw new RemoteMcpError("outcome_unknown", "The response to the tool call was cut off; it may or may not have run. It was not retried.");
      throw new RemoteMcpError("protocol_error", "The server sent an unreadable response.");
    }
  }

  private async readStream(response: Response, id: number): Promise<Record<string, unknown> | undefined> {
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
          if (message.id === id && ("result" in message || "error" in message)) return message;
          if (typeof message.method === "string" && message.id !== undefined) await this.refuseServerRequest(message);
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
  const probe = await fetcher(server, { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: REMOTE_MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: "aiboard-runner", version: "2" } } }), redirect: "manual", signal: AbortSignal.timeout(20_000) });
  await probe.body?.cancel().catch(() => undefined);
  const challenge = probe.headers.get("www-authenticate");
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

export async function exchangeToken(description: Pick<OAuthServerDescription, "tokenEndpoint" | "resource">, form: Record<string, string>, fetcher: typeof fetch = fetch, now = Date.now()): Promise<OAuthTokens> {
  const response = await fetcher(description.tokenEndpoint, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(20_000),
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
