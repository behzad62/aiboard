/**
 * A stub Runner for node test scripts (HM4a): a launcher session in memory,
 * GET /v2/health and POST /v2/home/proxy-session on the control port, and a
 * handler for everything the provider clients send to the proxy port or the
 * account peer. No real Runner, provider or key is involved.
 */
import { clearLauncherSession, storeLauncherSession } from "../lib/client/local-runner-handoff";
import { modelProxyClient } from "../lib/client/model-proxy-client";

export const STUB_CONTROL_PORT = 47_811;
export const STUB_ACCOUNTS_PORT = 47_813;
export const STUB_CONTROL_URL = `http://127.0.0.1:${STUB_CONTROL_PORT}`;
export const STUB_PROXY_URL = "http://127.0.0.1:47812";
export const STUB_ACCOUNTS_URL = `http://127.0.0.1:${STUB_ACCOUNTS_PORT}`;
export const STUB_SESSION_TOKEN = "stub-launcher-session-token";
export const STUB_PEER_TOKEN = "stub-account-peer-token";

export interface StubRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal;
}

export interface StubRunnerOptions {
  capabilities?: Record<string, boolean>;
  /** Proxy tokens handed out, in order; the last repeats. */
  proxyTokens?: string[];
  expiresInMs?: number | null;
  withAccountPeer?: boolean;
  /** Answers every request that is not a control-port call. */
  upstream?: (request: StubRequest) => Response | Promise<Response>;
  /** Answers other control-port routes (HM4b: `/v2/home`); undefined falls through to 404. */
  control?: (path: string, method: string, body: string) => Response | undefined | Promise<Response | undefined>;
}

export interface StubRunner {
  /** Requests sent anywhere but the control port. */
  requests: StubRequest[];
  /** Control-port paths, in order. */
  controlCalls: string[];
  restore(): void;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function installStubRunner(options: StubRunnerOptions = {}): StubRunner {
  const original = globalThis.fetch;
  const requests: StubRequest[] = [];
  const controlCalls: string[] = [];
  const tokens = options.proxyTokens ?? ["proxy_stub-token"];
  let issued = 0;
  clearLauncherSession(null);
  storeLauncherSession({ port: STUB_CONTROL_PORT, instanceId: "stub-runner", kind: "runner", sessionToken: STUB_SESSION_TOKEN }, null);
  if (options.withAccountPeer) {
    storeLauncherSession({ port: STUB_ACCOUNTS_PORT, instanceId: "stub-accounts", kind: "accounts", sessionToken: STUB_PEER_TOKEN }, null);
  }
  modelProxyClient.reset();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === "string" ? init.body : init?.body ? await new Response(init.body).text() : "";
    if (url.startsWith(`${STUB_CONTROL_URL}/`)) {
      const path = url.slice(STUB_CONTROL_URL.length);
      controlCalls.push(`${method} ${path}`);
      // Any stub launcher token is accepted, so a test can replace the session (a Runner restart).
      if (!headers.get("authorization")?.startsWith("Bearer stub-")) return json({ error: "unauthorized", code: "unauthorized" }, 401);
      if (path === "/v2/health") {
        return json({ ok: true, protocolVersion: 2, capabilities: options.capabilities ?? { home: true, modelProxy: true, secretlessProviderConfigs: true } });
      }
      if (path === "/v2/home/proxy-session" && method === "POST") {
        const token = tokens[Math.min(issued, tokens.length - 1)]!;
        issued += 1;
        const expiresInMs = options.expiresInMs === undefined ? 12 * 60 * 60 * 1000 : options.expiresInMs;
        return json({ token, proxyBaseUrl: STUB_PROXY_URL, expiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs).toISOString() });
      }
      const routed = await options.control?.(path, method, body);
      if (routed) return routed;
      return json({ error: "not found", code: "not_found" }, 404);
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    const request = { url, method, headers, body, ...(signal ? { signal } : {}) };
    requests.push(request);
    if (!options.upstream) return json({ error: "no upstream stub" }, 500);
    return options.upstream(request);
  }) as typeof fetch;
  return {
    requests,
    controlCalls,
    restore() {
      globalThis.fetch = original;
      clearLauncherSession(null);
      modelProxyClient.reset();
    },
  };
}
