/**
 * The page's side of the Runner's model proxy (HM4a, plan §9 "The model proxy").
 *
 * The page reaches the proxy only through the launcher's connection
 * (`getLauncherConnection`), never a discussion's saved `runnerUrl`. It asks
 * the control port for a proxy session (POST /v2/home/proxy-session), keeps it
 * in memory, renews it before it expires, and asks again on a 401
 * `proxy_token_expired`. A Runner without `capabilities.home` and
 * `capabilities.modelProxy` counts as not connected for model calls.
 */

import { getLauncherConnection, type LauncherConnection } from "./local-runner-handoff";

export const CONNECT_AI_BOARD_MESSAGE =
  "Connect AI Board: run `aiboard` in a project folder (not your home folder)";
export const UPDATE_AI_BOARD_MESSAGE = "Update AI Board: run `aiboard update`";

/** Renew a session this long before it expires (Google's SDK takes no custom fetch, so renewal is proactive). */
export const PROXY_SESSION_RENEW_BEFORE_MS = 10 * 60 * 1000;

/** The 401 codes after which the page asks for a new proxy token and retries once. */
const RENEWABLE_TOKEN_CODES = new Set(["proxy_token_expired", "proxy_token_invalid"]);

/** The request headers a provider SDK puts its key in (runner-v2/src/model-proxy.ts FAMILY_RULES). */
const KEY_HEADERS = ["authorization", "x-api-key", "x-goog-api-key"] as const;

export type ModelConnectionErrorCode =
  | "not_connected"
  | "update_required"
  | "account_peer_missing"
  | "proxy_session_failed";

export class ModelConnectionError extends Error {
  constructor(readonly code: ModelConnectionErrorCode, message: string) {
    super(message);
    this.name = "ModelConnectionError";
  }
}

export function isModelConnectionError(error: unknown): error is ModelConnectionError {
  return error instanceof ModelConnectionError;
}

export interface ProxySession {
  token: string;
  proxyBaseUrl: string;
  expiresAtMs: number | null;
}

export interface ModelProxyClientDeps {
  fetch: typeof fetch;
  now: () => number;
  launcher: () => LauncherConnection | null;
}

interface RunnerHealthCapabilities {
  home?: boolean;
  modelProxy?: boolean;
  secretlessProviderConfigs?: boolean;
}

function launcherKey(connection: LauncherConnection): string {
  return `${connection.url}|${connection.token}`;
}

export class ModelProxyClient {
  private healthFor: string | null = null;
  private healthOk: Promise<void> | null = null;
  private sessionFor: string | null = null;
  private session: ProxySession | null = null;
  private pending: Promise<ProxySession> | null = null;

  constructor(private readonly deps: ModelProxyClientDeps) {}

  /** The launcher connection, or the "Connect AI Board" refusal. */
  launcher(): LauncherConnection {
    const connection = this.deps.launcher();
    if (!connection) throw new ModelConnectionError("not_connected", CONNECT_AI_BOARD_MESSAGE);
    return connection;
  }

  /** Refuses before any model call when the Runner has no home or no model proxy. */
  async assertCapable(signal?: AbortSignal): Promise<LauncherConnection> {
    const connection = this.launcher();
    const key = launcherKey(connection);
    if (this.healthFor !== key || !this.healthOk) {
      this.healthFor = key;
      this.healthOk = this.checkHealth(connection, signal);
    }
    try {
      await this.healthOk;
    } catch (error) {
      if (this.healthFor === key) this.healthOk = null;
      throw error;
    }
    return connection;
  }

  private async checkHealth(connection: LauncherConnection, signal?: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await this.deps.fetch(`${connection.url}/v2/health`, {
        headers: { Authorization: `Bearer ${connection.token}` },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModelConnectionError("not_connected", CONNECT_AI_BOARD_MESSAGE);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ModelConnectionError("not_connected", CONNECT_AI_BOARD_MESSAGE);
    }
    const body = (await response.json().catch(() => ({}))) as { capabilities?: RunnerHealthCapabilities };
    if (!response.ok) throw new ModelConnectionError("not_connected", CONNECT_AI_BOARD_MESSAGE);
    if (body.capabilities?.home !== true || body.capabilities?.modelProxy !== true) {
      throw new ModelConnectionError("update_required", UPDATE_AI_BOARD_MESSAGE);
    }
  }

  /**
   * The current proxy session, renewed before it nears expiry. `staleToken`
   * asks for a new token unless the cached one already differs from it, so
   * several requests refused at once renew only once.
   */
  async getSession(options: { staleToken?: string; signal?: AbortSignal } = {}): Promise<ProxySession> {
    const connection = await this.assertCapable(options.signal);
    const key = launcherKey(connection);
    if (this.sessionFor !== key) {
      this.sessionFor = key;
      this.session = null;
      this.pending = null;
    }
    const current = this.session;
    const fresh = current &&
      (current.expiresAtMs === null || current.expiresAtMs - this.deps.now() > PROXY_SESSION_RENEW_BEFORE_MS);
    const stale = options.staleToken !== undefined && current?.token === options.staleToken;
    if (current && fresh && !stale) return current;
    // A renewal already in flight serves every caller.
    if (this.pending) return this.pending;
    const pending = this.issue(connection, options.signal).then(
      (session) => {
        if (this.sessionFor === key) this.session = session;
        return session;
      },
    ).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  private async issue(connection: LauncherConnection, signal?: AbortSignal): Promise<ProxySession> {
    let response: Response;
    try {
      response = await this.deps.fetch(`${connection.url}/v2/home/proxy-session`, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
        body: "{}",
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.forgetHealth();
      throw new ModelConnectionError("not_connected", CONNECT_AI_BOARD_MESSAGE);
    }
    const body = (await response.json().catch(() => ({}))) as {
      token?: unknown;
      proxyBaseUrl?: unknown;
      expiresAt?: unknown;
      error?: string;
      code?: string;
    };
    if (response.status === 404 && body.code !== "home_unavailable") {
      throw new ModelConnectionError("update_required", UPDATE_AI_BOARD_MESSAGE);
    }
    if (!response.ok || typeof body.token !== "string" || typeof body.proxyBaseUrl !== "string") {
      throw new ModelConnectionError(
        "proxy_session_failed",
        body.error ?? `AI Board could not open a model proxy session (HTTP ${response.status}).`,
      );
    }
    const expiresAtMs = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : null;
    return {
      token: body.token,
      proxyBaseUrl: body.proxyBaseUrl.replace(/\/+$/, ""),
      expiresAtMs: expiresAtMs !== null && Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    };
  }

  private forgetHealth(): void {
    this.healthFor = null;
    this.healthOk = null;
  }

  /**
   * The fetch handed to the OpenAI and Anthropic SDKs and to raw provider
   * requests: it puts the current proxy token in whichever key header the
   * request carries, and on a 401 `proxy_token_expired` (or `_invalid`) asks
   * for a new token and retries once.
   */
  readonly fetch: typeof fetch = async (input, init) => {
    // The SDKs call fetch(url, init); a Request is read once so a retry can resend it.
    const request = typeof input === "object" && !(input instanceof URL) ? input : null;
    const url = request ? request.url : input instanceof URL ? input.href : String(input);
    const baseInit: RequestInit = request
      ? {
          method: request.method,
          headers: new Headers(request.headers),
          body: request.body ? await request.clone().arrayBuffer() : undefined,
          signal: request.signal,
          ...init,
        }
      : { ...init };
    const send = (token: string) => {
      const headers = new Headers(baseInit.headers);
      for (const name of KEY_HEADERS) {
        if (!headers.has(name)) continue;
        headers.set(name, name === "authorization" ? `Bearer ${token}` : token);
      }
      return this.deps.fetch(url, { ...baseInit, headers });
    };
    const signal = baseInit.signal ?? undefined;
    const session = await this.getSession({ signal });
    const response = await send(session.token);
    if (response.status !== 401) return response;
    const code = await response.clone().json().then(
      (body: { code?: unknown }) => (typeof body?.code === "string" ? body.code : null),
      () => null,
    );
    if (!code || !RENEWABLE_TOKEN_CODES.has(code)) return response;
    const renewed = await this.getSession({ staleToken: session.token, signal });
    if (renewed.token === session.token) return response;
    return send(renewed.token);
  };

  /** Drops every cached session (tests, and a launcher change). */
  reset(): void {
    this.forgetHealth();
    this.sessionFor = null;
    this.session = null;
    this.pending = null;
  }
}

export const modelProxyClient = new ModelProxyClient({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  launcher: () => getLauncherConnection(),
});
