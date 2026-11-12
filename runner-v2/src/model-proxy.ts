import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  Agent as HttpAgent,
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import { AiboardHomeError, type AiboardHomeLocation } from "./aiboard-home-paths.js";
import { keyHint } from "./aiboard-home-store.js";
import { buildAllowedOriginSet, isAllowedBrowserOrigin, normalizeOrigin } from "./browser-origins.js";
import { snapshotProvider } from "./home-model-policy.js";
import { CachedHomeReader } from "./home-reader.js";
import { homeProviderUpstream } from "./home-runtime.js";

/**
 * The model proxy (Simple Build plan §9 "The model proxy", packet HM3). Browser model calls reach a
 * provider through the Runner, which swaps a short-lived proxy token for the key saved in the AIBoard
 * home. It listens on its own loopback port, so long streams never queue the control port's approvals
 * and cancels behind Chrome's six connections per host and port.
 *
 * - The upstream is fixed by the home: the provider's saved base URL, else the catalog snapshot's
 *   default; for a custom model, its base URL. A request chooses only an allow-listed path below it.
 * - The raw request target is read, never a decoded one; anything that could leave the base is refused,
 *   and the built URL's origin and path prefix are checked against the base before sending.
 * - The proxy token is accepted only in the header where the provider's SDK puts a key, never in a
 *   query, compared in constant time, and replaced by the real key. No other route takes it.
 * - Request and response headers are allow-listed per provider; CORS is answered here.
 * - Bytes are piped both ways with no timeout; the client's abort is the only stop. Error bodies are
 *   scrubbed of the key, which is replaced by its hint, across chunk boundaries.
 * - The request body is capped by counting streamed bytes, chunked bodies included.
 *
 * Owned filesystem targets: none. It reads the home through aiboard-home-store.ts and writes nothing.
 */

export const MODEL_PROXY_PATH_PREFIX = "/v2/model-proxy/";
/** A paired session's proxy token lives 12 h; the page asks again on 401 `proxy_token_expired`. */
export const PROXY_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
/** A replaced token keeps working this long, so streams in flight can finish. */
export const PROXY_TOKEN_REPLACEMENT_GRACE_MS = 60_000;
/** The principal of every Runner-token (manual) connection; it is shared by every tab using that token. */
export const MANUAL_PROXY_PRINCIPAL = "manual";
/** Live manual tokens kept at once; issuing one more retires the oldest, with the usual grace. */
export const MAX_MANUAL_PROXY_TOKENS = 16;
/**
 * The request cap: lib/attachments/types.ts allows 8 attachments (MAX_ATTACHMENTS) of 15 MiB
 * (MAX_ATTACHMENT_BYTES), sent base64 (4/3), plus 8 MiB for the rest of the request. HM4a shares this
 * number with the composer, which refuses a larger message before sending.
 */
export const MODEL_PROXY_MAX_REQUEST_BYTES = Math.ceil((8 * 15 * 1024 * 1024 * 4) / 3) + 8 * 1024 * 1024;

type Family = "openai-compatible" | "anthropic" | "google";
type KeyHeader = "authorization" | "x-api-key" | "x-goog-api-key";

interface PathRule { method: "GET" | "POST"; pattern: RegExp }
interface FamilyRules {
  keyHeader: KeyHeader;
  headers: readonly string[];
  headerPrefixes: readonly string[];
  paths: readonly PathRule[];
}

const SEGMENT = "[A-Za-z0-9._:-]+";
const GOOGLE_MODEL = "[A-Za-z0-9._-]+";

/**
 * The paths AIBoard's own clients call below each base (lib/providers/*, lib/client/settings-api.ts,
 * lib/client/capability-api.ts). HM4a's browser test fails if any call AIBoard makes is refused.
 */
const FAMILY_RULES: Readonly<Record<Family, FamilyRules>> = {
  "openai-compatible": {
    keyHeader: "authorization",
    headers: ["content-type", "accept", "idempotency-key"],
    headerPrefixes: ["x-stainless-"],
    paths: [
      { method: "POST", pattern: /^chat\/completions$/ },
      { method: "POST", pattern: /^responses$/ },
      { method: "POST", pattern: /^embeddings$/ },
      { method: "GET", pattern: /^models$/ },
      { method: "GET", pattern: new RegExp(`^models/${SEGMENT}$`) },
    ],
  },
  anthropic: {
    keyHeader: "x-api-key",
    headers: ["content-type", "accept", "idempotency-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access"],
    headerPrefixes: ["x-stainless-"],
    paths: [
      { method: "POST", pattern: /^v1\/messages$/ },
      { method: "POST", pattern: /^v1\/messages\/count_tokens$/ },
      { method: "GET", pattern: /^v1\/models$/ },
      { method: "GET", pattern: new RegExp(`^v1/models/${SEGMENT}$`) },
    ],
  },
  google: {
    keyHeader: "x-goog-api-key",
    headers: ["content-type", "accept", "x-goog-api-client", "api-revision"],
    headerPrefixes: [],
    paths: [
      { method: "GET", pattern: /^v1beta\/models$/ },
      { method: "GET", pattern: new RegExp(`^v1beta/models/${GOOGLE_MODEL}$`) },
      { method: "POST", pattern: new RegExp(`^v1beta/models/${GOOGLE_MODEL}:(?:generateContent|streamGenerateContent|countTokens)$`) },
      { method: "POST", pattern: /^v1beta\/interactions$/ },
    ],
  },
};

/** Paths one provider adds to its family's list: xAI's model catalog with modalities (lib/client/settings-api.ts, HM4a). */
const PROVIDER_EXTRA_PATHS: Readonly<Record<string, readonly PathRule[]>> = {
  xai: [{ method: "GET", pattern: /^language-models$/ }],
};

/** OpenRouter's attribution headers (lib/providers/openrouter.ts). */
const PROVIDER_EXTRA_HEADERS: Readonly<Record<string, readonly string[]>> = {
  openrouter: ["http-referer", "x-title"],
};

/** Response headers the SDKs and AIBoard's retry classifiers read. CORS has no prefix wildcard, so each is named. */
export const MODEL_PROXY_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "retry-after",
  "retry-after-ms",
  "x-should-retry",
  "x-request-id",
  "request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  ...["requests", "tokens"].flatMap((kind) => ["limit", "remaining", "reset"].map((part) => `x-ratelimit-${part}-${kind}`)),
  ...["requests", "tokens", "input-tokens", "output-tokens"].flatMap((kind) => ["limit", "remaining", "reset"].map((part) => `anthropic-ratelimit-${kind}-${part}`)),
];

/** Query parameters that could carry a key: the token is accepted only in the key header. */
const KEY_QUERY_PARAMETERS = new Set(["key", "api_key", "api-key", "apikey", "access_token", "token", "x-goog-api-key", "x-api-key", "authorization"]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CUSTOM_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface ProxySessionGrant {
  token: string;
  proxyBaseUrl: string;
  /** Null for a manual connection's token, which lives as long as the Runner. */
  expiresAt: string | null;
}

export interface ModelProxyOptions {
  /** The home, or a reader shared with the rest of the Runner. */
  home: AiboardHomeLocation | CachedHomeReader;
  /** The control port's `--allow-origin` list; loopback origins and AI Board's site are always answered. */
  allowedOrigins?: string[];
  /** Milliseconds since the epoch; tests pin it. */
  clock?: () => number;
  maxRequestBytes?: number;
  /** Test seam: every upstream request, as it is made. */
  onUpstreamRequest?: (request: ClientRequest) => void;
}

interface TokenRecord {
  readonly digest: Buffer;
  readonly sessionKey: string;
  readonly expiresAt: number | null;
  retiresAt: number | null;
}

type Target =
  | { kind: "provider"; id: string; suffix: string; query: string }
  | { kind: "custom"; id: string; suffix: string; query: string };

class ProxyRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

/** Reads the raw request target: the control server decodes path segments, the proxy never does. */
export function parseProxyTarget(raw: string): Target {
  if (!raw.startsWith("/")) throw new ProxyRefusal(400, "proxy_path_refused", "The request target must be a path, not an absolute URL.");
  const queryAt = raw.indexOf("?");
  const path = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = queryAt < 0 ? "" : raw.slice(queryAt + 1);
  if (!path.startsWith(MODEL_PROXY_PATH_PREFIX)) throw new ProxyRefusal(404, "not_found", "Route not found.");
  // Dot segments, any percent-encoding (%2e, %2f, %5c and the rest), backslashes, empty segments and
  // user-info never reach the URL builder.
  if (/\.\.|%|\\|\/\/|@/.test(path)) throw new ProxyRefusal(400, "proxy_path_refused", "The request path is not allowed.");
  const rest = path.slice(MODEL_PROXY_PATH_PREFIX.length);
  if (!/^[A-Za-z0-9._:/-]+$/.test(rest)) throw new ProxyRefusal(400, "proxy_path_refused", "The request path is not allowed.");
  if (!/^[A-Za-z0-9._~=&%+:,-]*$/.test(query)) throw new ProxyRefusal(400, "proxy_path_refused", "The request query is not allowed.");
  const segments = rest.split("/");
  if (segments[0] === "custom") {
    const id = segments[1] ?? "";
    if (!CUSTOM_MODEL_ID.test(id)) throw new ProxyRefusal(404, "proxy_path_refused", "Unknown custom model path.");
    return { kind: "custom", id, suffix: segments.slice(2).join("/"), query };
  }
  const id = segments[0] ?? "";
  if (!PROVIDER_ID.test(id)) throw new ProxyRefusal(404, "proxy_path_refused", "Unknown provider path.");
  return { kind: "provider", id, suffix: segments.slice(1).join("/"), query };
}

function familyOf(target: Target): Family {
  if (target.kind === "custom") return "openai-compatible";
  const provider = snapshotProvider(target.id);
  if (!provider || provider.accountBacked) {
    throw new ProxyRefusal(404, "proxy_provider_refused", "That provider is not reached through the model proxy.");
  }
  return provider.transport as Family;
}

function allowedRequestHeader(name: string, family: Family, target: Target): boolean {
  const rules = FAMILY_RULES[family];
  return rules.headers.includes(name) || rules.headerPrefixes.some((prefix) => name.startsWith(prefix)) ||
    (target.kind === "provider" && (PROVIDER_EXTRA_HEADERS[target.id] ?? []).includes(name));
}

function assertNoKeyInQuery(query: string): void {
  if (!query) return;
  for (const pair of query.split("&")) {
    const name = pair.split("=")[0]!.toLowerCase();
    let decoded = name;
    try { decoded = decodeURIComponent(name.replaceAll("+", " ")); } catch { /* checked as written */ }
    if (KEY_QUERY_PARAMETERS.has(name) || KEY_QUERY_PARAMETERS.has(decoded)) {
      throw new ProxyRefusal(401, "proxy_token_in_query", "The proxy token is accepted only in the key header, never in a query.");
    }
  }
}

/** Replaces every copy of `secret` with `hint`, keeping a key-length tail so a key split across chunks is caught. */
export class KeyScrubber {
  private tail = Buffer.alloc(0);
  private readonly secret: Buffer;
  private readonly hint: Buffer;

  constructor(secret: string, hint: string) {
    this.secret = Buffer.from(secret, "utf8");
    this.hint = Buffer.from(hint, "utf8");
  }

  push(chunk: Buffer): Buffer {
    const scrubbed = this.scrub(Buffer.concat([this.tail, chunk]));
    const keep = Math.min(scrubbed.length, Math.max(0, this.secret.length - 1));
    this.tail = Buffer.from(scrubbed.subarray(scrubbed.length - keep));
    return scrubbed.subarray(0, scrubbed.length - keep);
  }

  end(): Buffer {
    const rest = this.scrub(this.tail);
    this.tail = Buffer.alloc(0);
    return rest;
  }

  private scrub(buffer: Buffer): Buffer {
    if (this.secret.length === 0) return buffer;
    const parts: Buffer[] = [];
    let from = 0;
    for (let at = buffer.indexOf(this.secret, from); at >= 0; at = buffer.indexOf(this.secret, from)) {
      parts.push(buffer.subarray(from, at), this.hint);
      from = at + this.secret.length;
    }
    if (parts.length === 0) return buffer;
    parts.push(buffer.subarray(from));
    return Buffer.concat(parts);
  }
}

function sendRefusal(request: IncomingMessage, response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) { response.destroy(); return; }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (status === 401) response.setHeader("WWW-Authenticate", "Bearer");
  // A refused request is never read: close the connection rather than drain an unwanted body.
  if (!request.complete) response.setHeader("Connection", "close");
  response.end(JSON.stringify({ error: message, code }));
}

export class ModelProxy {
  private readonly home: CachedHomeReader;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly clock: () => number;
  private readonly maxRequestBytes: number;
  private readonly onUpstreamRequest?: (request: ClientRequest) => void;
  private readonly tokens: TokenRecord[] = [];
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true });
  private readonly httpAgent = new HttpAgent({ keepAlive: true });
  private server: Server | undefined;
  private baseUrl: string | undefined;

  constructor(options: ModelProxyOptions) {
    this.home = options.home instanceof CachedHomeReader ? options.home : new CachedHomeReader(options.home);
    this.allowedOrigins = buildAllowedOriginSet(options.allowedOrigins);
    this.clock = options.clock ?? (() => Date.now());
    this.maxRequestBytes = options.maxRequestBytes ?? MODEL_PROXY_MAX_REQUEST_BYTES;
    this.onUpstreamRequest = options.onUpstreamRequest;
  }

  /** The proxy's base URL, once started. */
  get url(): string | undefined {
    return this.baseUrl;
  }

  /** The listening server, for tests that check it sets no timeouts. */
  get listener(): Server | undefined {
    return this.server;
  }

  async start(port = 0): Promise<{ port: number; url: string }> {
    if (this.server) throw new Error("Model proxy is already running.");
    // No request, header-body or socket timeout: a reasoning call can be silent for minutes, and the
    // client's abort is the only stop (§9 "Transport").
    const server = createServer({ requestTimeout: 0, keepAliveTimeout: 5_000 }, (request, response) => {
      void this.handle(request, response);
    });
    server.timeout = 0;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Model proxy did not expose a TCP address.");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return { port: address.port, url: this.baseUrl };
  }

  /**
   * A proxy token for one principal: a paired session's id, or `MANUAL_PROXY_PRINCIPAL`. A paired
   * session's new token replaces its current one, which stops working 60 s later, and it expires after
   * 12 h. Manual tokens live as long as the Runner and never retire each other; past
   * `MAX_MANUAL_PROXY_TOKENS` the oldest live one is retired with the same 60 s grace.
   */
  issue(sessionKey: string, options: { expires: boolean }): ProxySessionGrant {
    if (!this.baseUrl) throw new Error("Model proxy is not running.");
    const now = this.clock();
    this.prune(now);
    const retire = (record: TokenRecord): void => {
      const at = now + PROXY_TOKEN_REPLACEMENT_GRACE_MS;
      record.retiresAt = record.retiresAt === null ? at : Math.min(record.retiresAt, at);
    };
    if (sessionKey === MANUAL_PROXY_PRINCIPAL) {
      // Every tab using the saved Runner token shares this principal, so a new manual token never
      // retires another: each lives as long as the Runner. Only past the cap is the oldest retired.
      const live = this.tokens.filter((record) => record.sessionKey === sessionKey && record.retiresAt === null);
      for (const record of live.slice(0, Math.max(0, live.length - (MAX_MANUAL_PROXY_TOKENS - 1)))) retire(record);
    } else {
      // A paired session is one tab: its new token replaces the old one.
      for (const record of this.tokens) if (record.sessionKey === sessionKey) retire(record);
    }
    const token = `proxy_${randomBytes(32).toString("base64url")}`;
    const expiresAt = options.expires ? now + PROXY_TOKEN_LIFETIME_MS : null;
    this.tokens.push({ digest: digest(token), sessionKey, expiresAt, retiresAt: null });
    return { token, proxyBaseUrl: this.baseUrl, expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() };
  }

  /** Every token of a principal stops working at once (its paired session was revoked). */
  endSession(sessionKey: string): void {
    for (let index = this.tokens.length - 1; index >= 0; index -= 1) {
      if (this.tokens[index]!.sessionKey === sessionKey) this.tokens.splice(index, 1);
    }
  }

  async close(): Promise<void> {
    this.tokens.length = 0;
    const server = this.server;
    this.server = undefined;
    this.baseUrl = undefined;
    this.httpsAgent.destroy();
    this.httpAgent.destroy();
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  private prune(now: number): void {
    for (let index = this.tokens.length - 1; index >= 0; index -= 1) {
      const record = this.tokens[index]!;
      if ((record.expiresAt !== null && now >= record.expiresAt) || (record.retiresAt !== null && now >= record.retiresAt)) {
        this.tokens.splice(index, 1);
      }
    }
  }

  /** Constant-time: every live token is compared, with no early exit. */
  private authenticate(presented: string): void {
    const wanted = digest(presented);
    let match: TokenRecord | undefined;
    for (const record of this.tokens) {
      if (timingSafeEqual(record.digest, wanted)) match = record;
    }
    if (!match) throw new ProxyRefusal(401, "proxy_token_invalid", "A valid model proxy token is required.");
    const now = this.clock();
    if ((match.expiresAt !== null && now >= match.expiresAt) || (match.retiresAt !== null && now >= match.retiresAt)) {
      throw new ProxyRefusal(401, "proxy_token_expired", "The model proxy token expired; ask the Runner for a new one.");
    }
  }

  private presentedToken(request: IncomingMessage, keyHeader: KeyHeader): string {
    const count = headerCount(request, keyHeader);
    const value = request.headers[keyHeader];
    if (count === 0 || typeof value !== "string" || value === "") {
      throw new ProxyRefusal(401, "proxy_token_missing", "The model proxy token is required in the provider's key header.");
    }
    if (count !== 1) throw new ProxyRefusal(401, "proxy_token_invalid", "A valid model proxy token is required.");
    if (keyHeader !== "authorization") return value;
    if (!value.startsWith("Bearer ")) throw new ProxyRefusal(401, "proxy_token_invalid", "A valid model proxy token is required.");
    return value.slice("Bearer ".length);
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    if (origin === undefined) return;
    const normalized = typeof origin === "string" && headerCount(request, "origin") === 1 ? normalizeOrigin(origin) : undefined;
    if (!normalized || !isAllowedBrowserOrigin(normalized, this.allowedOrigins)) {
      throw new ProxyRefusal(403, "origin_not_allowed", "The model proxy accepts browser requests only from AI Board's allowed origins.");
    }
    response.setHeader("Access-Control-Allow-Origin", normalized);
    response.setHeader("Vary", "Origin");
  }

  private preflight(request: IncomingMessage, response: ServerResponse, target: Target, family: Family): void {
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    const requested = typeof request.headers["access-control-request-headers"] === "string"
      ? request.headers["access-control-request-headers"].split(",").map((name) => name.trim().toLowerCase()).filter(Boolean)
      : [];
    const allowed = requested.filter((name) => name === FAMILY_RULES[family].keyHeader || allowedRequestHeader(name, family, target));
    if (allowed.length > 0) response.setHeader("Access-Control-Allow-Headers", allowed.join(", "));
    response.setHeader("Access-Control-Expose-Headers", MODEL_PROXY_RESPONSE_HEADERS.join(", "));
    response.setHeader("Access-Control-Max-Age", "600");
    if (request.headers["access-control-request-private-network"] === "true") {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    response.statusCode = 204;
    response.end();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      this.applyCors(request, response);
      const target = parseProxyTarget(request.url ?? "");
      const family = familyOf(target);
      if (request.method === "OPTIONS") { this.preflight(request, response, target, family); return; }
      response.setHeader("Access-Control-Expose-Headers", MODEL_PROXY_RESPONSE_HEADERS.join(", "));
      const method = request.method;
      const pathRules = [...FAMILY_RULES[family].paths, ...(target.kind === "provider" ? PROVIDER_EXTRA_PATHS[target.id] ?? [] : [])];
      if ((method !== "GET" && method !== "POST") || !pathRules.some((rule) => rule.method === method && rule.pattern.test(target.suffix))) {
        throw new ProxyRefusal(404, "proxy_path_refused", "That path is not on the model proxy's allow-list.");
      }
      assertNoKeyInQuery(target.query);
      this.authenticate(this.presentedToken(request, FAMILY_RULES[family].keyHeader));
      const declared = request.headers["content-length"];
      if (declared !== undefined && (!/^[0-9]{1,15}$/.test(declared) || Number(declared) > this.maxRequestBytes)) {
        throw new ProxyRefusal(413, "body_too_large", "The request body exceeds the model proxy's limit.");
      }
      const upstream = await this.upstreamFor(target);
      this.forward(request, response, target, family, method, upstream);
    } catch (error) {
      if (error instanceof ProxyRefusal) { sendRefusal(request, response, error.status, error.code, error.message); return; }
      if (error instanceof AiboardHomeError) {
        sendRefusal(request, response, error.code === "home_busy" ? 503 : 422, error.code, error.message);
        return;
      }
      sendRefusal(request, response, 500, "internal_error", "The model proxy could not complete the request.");
    }
  }

  private async upstreamFor(target: Target): Promise<{ url: URL; secret: string | undefined }> {
    const home = await this.home.read();
    let base: string | null;
    let secret: string | undefined;
    if (target.kind === "custom") {
      const model = home.config.customModels.find((entry) => entry.id === target.id);
      if (!model) throw new ProxyRefusal(404, "model_not_configured", "That custom model is not in the AIBoard home.");
      base = typeof model.baseURL === "string" ? model.baseURL : null;
      secret = home.secret(`credentials.customModels.${target.id}`);
    } else {
      const entry = Object.hasOwn(home.config.providers, target.id) ? home.config.providers[target.id] : undefined;
      if (entry?.enabled !== true) throw new ProxyRefusal(422, "provider_not_configured", "That provider is not enabled in the AIBoard home.");
      secret = home.secret(`credentials.providers.${target.id}`);
      if (secret === undefined) throw new ProxyRefusal(422, "home_key_missing", "The AIBoard home has no key for that provider.");
      base = homeProviderUpstream(home.config, target.id);
    }
    if (!base) throw new ProxyRefusal(422, "base_url_required", "That provider needs its endpoint base URL in the AIBoard home.");
    let baseUrl: URL;
    try { baseUrl = new URL(base); }
    catch { throw new ProxyRefusal(422, "proxy_upstream_invalid", "The saved base URL is not a valid URL."); }
    if ((baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new ProxyRefusal(422, "proxy_upstream_invalid", "The saved base URL must be a plain http or https URL.");
    }
    // A key never crosses the network in clear text: with a key, plain http only to this machine. A
    // keyless custom model (an Ollama on the LAN) sends nothing secret, so it may use plain http anywhere.
    if (baseUrl.protocol === "http:" && !LOOPBACK_HOSTS.has(baseUrl.hostname) && secret !== undefined) {
      throw new ProxyRefusal(502, "proxy_upstream_insecure", "The model proxy sends keys over plain http only to this computer; use an https base URL.");
    }
    const prefix = baseUrl.pathname.replace(/\/+$/, "");
    const built = new URL(`${baseUrl.origin}${prefix}/${target.suffix}${target.query ? `?${target.query}` : ""}`);
    if (built.origin !== baseUrl.origin || !built.pathname.startsWith(`${prefix}/`)) {
      throw new ProxyRefusal(400, "proxy_path_refused", "The request path is not allowed.");
    }
    return { url: built, secret };
  }

  private forward(
    request: IncomingMessage,
    response: ServerResponse,
    target: Target,
    family: Family,
    method: "GET" | "POST",
    upstream: { url: URL; secret: string | undefined },
  ): void {
    const rules = FAMILY_RULES[family];
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined && name !== rules.keyHeader && allowedRequestHeader(name, family, target)) headers[name] = value;
    }
    if (request.headers["content-length"] !== undefined) headers["content-length"] = request.headers["content-length"];
    headers["accept-encoding"] = "identity";
    if (upstream.secret !== undefined) {
      headers[rules.keyHeader] = rules.keyHeader === "authorization" ? `Bearer ${upstream.secret}` : upstream.secret;
    }
    const send = upstream.url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(upstream.url, { method, headers, agent: upstream.url.protocol === "https:" ? this.httpsAgent : this.httpAgent });
    this.onUpstreamRequest?.(outgoing);
    let finished = false;
    response.on("close", () => {
      // The client went away (an abort, or a closed tab): stop the upstream call too.
      if (!finished) outgoing.destroy();
    });
    outgoing.on("error", () => {
      if (!response.headersSent) sendRefusal(request, response, 502, "proxy_upstream_unreachable", "The provider could not be reached.");
      else response.destroy();
    });
    outgoing.on("response", (incoming) => {
      const status = incoming.statusCode ?? 502;
      response.statusCode = status;
      for (const name of MODEL_PROXY_RESPONSE_HEADERS) {
        const value = incoming.headers[name];
        if (value !== undefined) response.setHeader(name, value);
      }
      response.flushHeaders();
      const scrubber = status >= 400 && upstream.secret ? new KeyScrubber(upstream.secret, keyHint(upstream.secret)) : undefined;
      incoming.on("data", (chunk: Buffer) => {
        const bytes = scrubber ? scrubber.push(chunk) : chunk;
        if (bytes.length > 0 && !response.write(bytes)) {
          incoming.pause();
          response.once("drain", () => incoming.resume());
        }
      });
      incoming.on("end", () => {
        finished = true;
        if (scrubber) {
          const rest = scrubber.end();
          if (rest.length > 0) response.write(rest);
        }
        response.end();
      });
      incoming.on("error", () => response.destroy());
    });

    if (method === "GET") {
      request.resume();
      outgoing.end();
      return;
    }
    let size = 0;
    let refused = false;
    request.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > this.maxRequestBytes) {
        // Past the cap: the upstream never gets the rest, and never a complete request.
        refused = true;
        finished = true;
        outgoing.destroy();
        sendRefusal(request, response, 413, "body_too_large", "The request body exceeds the model proxy's limit.");
        return;
      }
      if (!outgoing.write(chunk)) {
        request.pause();
        outgoing.once("drain", () => request.resume());
      }
    });
    request.on("end", () => { if (!refused) outgoing.end(); });
    request.on("error", () => outgoing.destroy());
  }
}
