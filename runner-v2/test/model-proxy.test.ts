import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAiboardHome, type AiboardHomeLocation } from "../src/aiboard-home-paths.js";
import { applyHomeBatch, keyHint, readAiboardHome, type HomeOp } from "../src/aiboard-home-store.js";
import {
  KeyScrubber,
  MODEL_PROXY_RESPONSE_HEADERS,
  ModelProxy,
  PROXY_TOKEN_LIFETIME_MS,
  parseProxyTarget,
} from "../src/model-proxy.js";

// Stub keys only: no live provider is ever called, and these strings are not real keys.
const OPENAI_KEY = "sk-stub-openai-0123456789abcdefghij";
const ANTHROPIC_KEY = "sk-ant-stub-0123456789abcdefghij";
const GOOGLE_KEY = "AIzaStub0123456789abcdefghijklmn";
const OPENROUTER_KEY = "sk-or-stub-0123456789abcdefghij";
const CUSTOM_KEY = "custom-stub-0123456789abcdefghij";

interface Recorded { method: string; url: string; headers: IncomingHttpHeaders; body: string; complete: boolean }

class Upstream {
  readonly requests: Recorded[] = [];
  handler: (request: IncomingMessage, response: ServerResponse, recorded: Recorded) => void = (_request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("x-request-id", "req_stub");
    response.setHeader("set-cookie", "upstream=1");
    response.setHeader("x-internal-upstream", "hidden");
    response.end('{"ok":true}');
  };
  private constructor(private readonly server: Server, readonly port: number) {}

  static async start(): Promise<Upstream> {
    const holder: { upstream?: Upstream } = {};
    const server = createServer((incoming, response) => {
      const recorded: Recorded = { method: incoming.method ?? "", url: incoming.url ?? "", headers: incoming.headers, body: "", complete: false };
      holder.upstream!.requests.push(recorded);
      incoming.on("data", (chunk: Buffer) => { recorded.body += chunk.toString("utf8"); });
      incoming.on("end", () => {
        recorded.complete = true;
        holder.upstream!.handler(incoming, response, recorded);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    holder.upstream = new Upstream(server, address.port);
    return holder.upstream;
  }

  get base(): string { return `http://127.0.0.1:${this.port}`; }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
  }
}

interface Fixture {
  root: string;
  location: AiboardHomeLocation;
  upstream: Upstream;
  proxy: ModelProxy;
  port: number;
  now: { value: number };
  token: string;
  close(): Promise<void>;
}

async function fixture(options: { maxRequestBytes?: number; homeOps?: (upstream: Upstream) => HomeOp[]; onUpstreamRequest?: ConstructorParameters<typeof ModelProxy>[0]["onUpstreamRequest"] } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-model-proxy-"));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const environment: NodeJS.ProcessEnv = { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") };
  const location = resolveAiboardHome({ platform: process.platform, environment, home: userHome });
  const upstream = await Upstream.start();
  const ops: HomeOp[] = options.homeOps?.(upstream) ?? [
    { path: "providers.openai", op: "set", value: { enabled: true, baseUrl: `${upstream.base}/v1` } },
    { path: "credentials.providers.openai", op: "set", value: { secret: OPENAI_KEY } },
    { path: "providers.anthropic", op: "set", value: { enabled: true, baseUrl: upstream.base } },
    { path: "credentials.providers.anthropic", op: "set", value: { secret: ANTHROPIC_KEY } },
    { path: "providers.google", op: "set", value: { enabled: true, baseUrl: upstream.base } },
    { path: "credentials.providers.google", op: "set", value: { secret: GOOGLE_KEY } },
    { path: "providers.openrouter", op: "set", value: { enabled: true, baseUrl: `${upstream.base}/api/v1` } },
    { path: "credentials.providers.openrouter", op: "set", value: { secret: OPENROUTER_KEY } },
    { path: "providers.deepseek", op: "set", value: { enabled: true, baseUrl: `${upstream.base}/deepseek` } },
    { path: "customModels.keyed", op: "set", value: { label: "Keyed", baseURL: `${upstream.base}/custom/v1`, model: "m", createdAt: "2026-11-12T00:00:00.000Z" } },
    { path: "credentials.customModels.keyed", op: "set", value: { secret: CUSTOM_KEY } },
    { path: "customModels.local", op: "set", value: { label: "Local", baseURL: `${upstream.base}/local/v1`, model: "gemma", createdAt: "2026-11-12T00:00:00.000Z" } },
  ];
  await applyHomeBatch(location, { baseRevision: 0, ops });
  const now = { value: Date.parse("2026-11-12T00:00:00.000Z") };
  const proxy = new ModelProxy({
    home: location,
    clock: () => now.value,
    ...(options.maxRequestBytes ? { maxRequestBytes: options.maxRequestBytes } : {}),
    ...(options.onUpstreamRequest ? { onUpstreamRequest: options.onUpstreamRequest } : {}),
  });
  const { port } = await proxy.start(0);
  const token = proxy.issue("manual", { expires: false }).token;
  return {
    root, location, upstream, proxy, port, now, token,
    async close() {
      await proxy.close();
      await upstream.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function send(port: number, init: { method?: string; path: string; headers?: Record<string, string>; body?: string; chunks?: string[] }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method: init.method ?? "GET", path: init.path, headers: init.headers ?? {} }, (incoming) => {
      let body = "";
      incoming.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }));
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    if (init.chunks) {
      for (const chunk of init.chunks) outgoing.write(chunk);
      outgoing.end();
    } else {
      outgoing.end(init.body);
    }
  });
}

const json = { "content-type": "application/json" };

test("the proxy sets each provider's key in its own header, strips the proxy token and allow-lists headers", async () => {
  const fx = await fixture();
  try {
    const bearer = { ...json, authorization: `Bearer ${fx.token}` };
    const openai = await send(fx.port, {
      method: "POST", path: "/v2/model-proxy/openai/chat/completions", body: '{"model":"m"}',
      headers: { ...bearer, "x-stainless-lang": "js", cookie: "session=1", origin: "http://localhost:3000", referer: "http://localhost:3000/", "sec-fetch-mode": "cors", "x-evil": "1", "accept-encoding": "gzip" },
    });
    assert.equal(openai.status, 200);
    assert.equal(openai.headers["x-request-id"], "req_stub", "an allow-listed response header passes");
    assert.equal(openai.headers["set-cookie"], undefined, "a response header off the list is dropped");
    assert.equal(openai.headers["x-internal-upstream"], undefined);
    const anthropic = await send(fx.port, {
      method: "POST", path: "/v2/model-proxy/anthropic/v1/messages", body: "{}",
      headers: { ...json, "x-api-key": fx.token, "anthropic-version": "2023-06-01", "anthropic-beta": "b1" },
    });
    assert.equal(anthropic.status, 200);
    const google = await send(fx.port, {
      method: "POST", path: "/v2/model-proxy/google/v1beta/models/gemini-x:streamGenerateContent?alt=sse", body: "{}",
      headers: { ...json, "x-goog-api-key": fx.token, "x-goog-api-client": "genai-js/2.10.0" },
    });
    assert.equal(google.status, 200);
    const openrouter = await send(fx.port, {
      method: "POST", path: "/v2/model-proxy/openrouter/chat/completions", body: "{}",
      headers: { ...bearer, "http-referer": "https://aiboard.me", "x-title": "AI Board" },
    });
    assert.equal(openrouter.status, 200);
    const custom = await send(fx.port, { method: "POST", path: "/v2/model-proxy/custom/keyed/chat/completions", body: "{}", headers: bearer });
    assert.equal(custom.status, 200);
    const local = await send(fx.port, { method: "GET", path: "/v2/model-proxy/custom/local/models", headers: { authorization: `Bearer ${fx.token}` } });
    assert.equal(local.status, 200);

    const [o, a, g, r, c, l] = fx.upstream.requests;
    assert.equal(o!.url, "/v1/chat/completions");
    assert.equal(o!.headers.authorization, `Bearer ${OPENAI_KEY}`);
    assert.equal(o!.headers["x-stainless-lang"], "js");
    assert.equal(o!.headers["accept-encoding"], "identity", "bodies arrive plain so they can be scrubbed");
    for (const name of ["cookie", "origin", "referer", "sec-fetch-mode", "x-evil"]) assert.equal(o!.headers[name], undefined, `${name} is never forwarded`);
    assert.equal(o!.headers.host, `127.0.0.1:${fx.upstream.port}`, "the host is the upstream's, never the client's");
    assert.equal(a!.url, "/v1/messages");
    assert.equal(a!.headers["x-api-key"], ANTHROPIC_KEY);
    assert.equal(a!.headers.authorization, undefined);
    assert.equal(a!.headers["anthropic-version"], "2023-06-01");
    assert.equal(a!.headers["anthropic-beta"], "b1");
    assert.equal(g!.url, "/v1beta/models/gemini-x:streamGenerateContent?alt=sse");
    assert.equal(g!.headers["x-goog-api-key"], GOOGLE_KEY);
    assert.equal(g!.headers["x-goog-api-client"], "genai-js/2.10.0");
    assert.equal(r!.url, "/api/v1/chat/completions");
    assert.equal(r!.headers.authorization, `Bearer ${OPENROUTER_KEY}`);
    assert.equal(r!.headers["http-referer"], "https://aiboard.me");
    assert.equal(r!.headers["x-title"], "AI Board");
    assert.equal(c!.url, "/custom/v1/chat/completions");
    assert.equal(c!.headers.authorization, `Bearer ${CUSTOM_KEY}`);
    assert.equal(l!.url, "/local/v1/models");
    assert.equal(l!.headers.authorization, undefined, "a keyless custom endpoint gets no key, and never the proxy token");
    for (const recorded of fx.upstream.requests) {
      assert.equal(JSON.stringify(recorded.headers).includes(fx.token), false, "the proxy token never reaches an upstream");
    }
  } finally {
    await fx.close();
  }
});

test("a missing, wrong or expired token gets 401 and nothing is forwarded; a token in a query parameter is refused", async () => {
  const fx = await fixture();
  try {
    const path = "/v2/model-proxy/openai/chat/completions";
    const cases: Array<[string, Record<string, string>, string, string]> = [
      ["missing", { ...json }, path, "proxy_token_missing"],
      ["wrong", { ...json, authorization: "Bearer proxy_wrong" }, path, "proxy_token_invalid"],
      ["not a Bearer", { ...json, authorization: fx.token }, path, "proxy_token_invalid"],
      ["another provider's header", { ...json, "x-api-key": fx.token }, path, "proxy_token_missing"],
      ["anthropic with a Bearer", { ...json, authorization: `Bearer ${fx.token}` }, "/v2/model-proxy/anthropic/v1/messages", "proxy_token_missing"],
      ["in a query", { ...json }, `${path}?key=${fx.token}`, "proxy_token_in_query"],
      ["in a query beside the header", { ...json, authorization: `Bearer ${fx.token}` }, `${path}?api_key=${fx.token}`, "proxy_token_in_query"],
      ["google key query", { ...json }, `/v2/model-proxy/google/v1beta/models/gemini-x:generateContent?key=${fx.token}`, "proxy_token_in_query"],
    ];
    for (const [label, headers, target, code] of cases) {
      const reply = await send(fx.port, { method: "POST", path: target, body: "{}", headers });
      assert.equal(reply.status, 401, label);
      assert.equal(JSON.parse(reply.body).code, code, label);
    }
    const paired = fx.proxy.issue("paired:session-a", { expires: true }).token;
    assert.equal((await send(fx.port, { method: "POST", path, body: "{}", headers: { ...json, authorization: `Bearer ${paired}` } })).status, 200);
    fx.now.value += PROXY_TOKEN_LIFETIME_MS;
    const expired = await send(fx.port, { method: "POST", path, body: "{}", headers: { ...json, authorization: `Bearer ${paired}` } });
    assert.equal(expired.status, 401);
    assert.equal(JSON.parse(expired.body).code, "proxy_token_expired", "the page asks again on proxy_token_expired");
    assert.equal(fx.upstream.requests.length, 1, "only the one authorized call was forwarded");
  } finally {
    await fx.close();
  }
});

test("encoded slashes, dot segments, backslashes, @ and an absolute-form target never reach any host but the base's; a path off the allow-list gets 404", async () => {
  const fx = await fixture();
  const elsewhere = await Upstream.start();
  try {
    const auth = { ...json, authorization: `Bearer ${fx.token}` };
    const unsafe = [
      "/v2/model-proxy/openai/..%2F..%2Fsecret",
      "/v2/model-proxy/openai/%2e%2e/%2e%2e/chat/completions",
      "/v2/model-proxy/openai/%2E%2E/models",
      "/v2/model-proxy/openai/chat%2Fcompletions",
      "/v2/model-proxy/openai/models%5c..%5cx",
      "/v2/model-proxy/openai/../../v2/health",
      "/v2/model-proxy/openai/models/..",
      "/v2/model-proxy/openai/\\..\\chat/completions",
      `/v2/model-proxy/openai//127.0.0.1:${elsewhere.port}/chat/completions`,
      `/v2/model-proxy/openai/@127.0.0.1:${elsewhere.port}/chat/completions`,
      `/v2/model-proxy/custom/keyed@127.0.0.1:${elsewhere.port}/chat/completions`,
      `http://127.0.0.1:${elsewhere.port}/v2/model-proxy/openai/chat/completions`,
      `//127.0.0.1:${elsewhere.port}/v2/model-proxy/openai/chat/completions`,
    ];
    for (const target of unsafe) {
      const reply = await send(fx.port, { method: "POST", path: target, body: "{}", headers: auth });
      assert.ok(reply.status === 400 || reply.status === 404, `${target} is refused (got ${reply.status})`);
    }
    const offList: Array<[string, string]> = [
      ["POST", "/v2/model-proxy/openai/files"],
      ["POST", "/v2/model-proxy/openai/fine_tuning/jobs"],
      ["GET", "/v2/model-proxy/openai/chat/completions"],
      ["DELETE", "/v2/model-proxy/openai/models/m"],
      ["POST", "/v2/model-proxy/anthropic/v1/complete"],
      ["POST", "/v2/model-proxy/google/v1beta/models/gemini-x:deleteEverything"],
      ["POST", "/v2/model-proxy/chatgpt/responses"],
      ["POST", "/v2/model-proxy/github-copilot/chat/completions"],
      ["POST", "/v2/model-proxy/nonexistent/chat/completions"],
      ["GET", "/v2/health"],
      ["GET", "/v2/home"],
    ];
    for (const [method, target] of offList) {
      const reply = await send(fx.port, { method, path: target, ...(method === "POST" ? { body: "{}" } : {}), headers: auth });
      assert.equal(reply.status, 404, `${method} ${target} is not on the allow-list`);
    }
    assert.equal(fx.upstream.requests.length, 0, "nothing was forwarded to the base");
    assert.equal(elsewhere.requests.length, 0, "nothing reached another host");

    assert.throws(() => parseProxyTarget("http://evil.example/v2/model-proxy/openai/models"), /path, not an absolute URL/);
    assert.deepEqual(parseProxyTarget("/v2/model-proxy/custom/a.b:c/chat/completions"), { kind: "custom", id: "a.b:c", suffix: "chat/completions", query: "" });
    assert.deepEqual(parseProxyTarget("/v2/model-proxy/google/v1beta/models?pageSize=50"), { kind: "provider", id: "google", suffix: "v1beta/models", query: "pageSize=50" });
  } finally {
    await elsewhere.close();
    await fx.close();
  }
});

// Recorded 2026-11-12 from the SDKs AI Board ships (openai 6.45.0, @anthropic-ai/sdk 0.110.0,
// @google/genai 2.10.0) against a local capture server with stub keys: each call's request header names,
// less the ones a browser sets itself or never lists in a preflight (host, connection, content-length,
// accept, accept-encoding, accept-language, user-agent, cookie, sec-*), sorted as Chrome sends them.
const STAINLESS = ["x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version", "x-stainless-retry-count", "x-stainless-runtime", "x-stainless-runtime-version"];
const RECORDED_PREFLIGHTS: Array<{ label: string; method: "GET" | "POST"; path: string; headers: string[] }> = [
  { label: "openai chat.completions stream", method: "POST", path: "/v2/model-proxy/openai/chat/completions", headers: ["authorization", "content-type", ...STAINLESS] },
  { label: "openai responses stream", method: "POST", path: "/v2/model-proxy/openai/responses", headers: ["authorization", "content-type", ...STAINLESS] },
  { label: "openai models.list", method: "GET", path: "/v2/model-proxy/openai/models", headers: ["authorization", ...STAINLESS] },
  { label: "openrouter chat with attribution", method: "POST", path: "/v2/model-proxy/openrouter/chat/completions", headers: ["authorization", "content-type", "http-referer", ...STAINLESS, "x-title"] },
  { label: "anthropic messages stream", method: "POST", path: "/v2/model-proxy/anthropic/v1/messages", headers: ["anthropic-dangerous-direct-browser-access", "anthropic-version", "content-type", "x-api-key", ...STAINLESS, "x-stainless-timeout"] },
  { label: "anthropic beta messages", method: "POST", path: "/v2/model-proxy/anthropic/v1/messages?beta=true", headers: ["anthropic-beta", "anthropic-dangerous-direct-browser-access", "anthropic-version", "content-type", "x-api-key", ...STAINLESS, "x-stainless-timeout"] },
  { label: "anthropic count_tokens", method: "POST", path: "/v2/model-proxy/anthropic/v1/messages/count_tokens", headers: ["anthropic-dangerous-direct-browser-access", "anthropic-version", "content-type", "x-api-key", ...STAINLESS] },
  { label: "anthropic models.list", method: "GET", path: "/v2/model-proxy/anthropic/v1/models", headers: ["anthropic-dangerous-direct-browser-access", "anthropic-version", "x-api-key", ...STAINLESS] },
  { label: "google generateContentStream", method: "POST", path: "/v2/model-proxy/google/v1beta/models/gemini-x:streamGenerateContent?alt=sse", headers: ["content-type", "x-goog-api-client", "x-goog-api-key"] },
  { label: "google countTokens", method: "POST", path: "/v2/model-proxy/google/v1beta/models/gemini-x:countTokens", headers: ["content-type", "x-goog-api-client", "x-goog-api-key"] },
  { label: "google models.list", method: "GET", path: "/v2/model-proxy/google/v1beta/models", headers: ["content-type", "x-goog-api-client", "x-goog-api-key"] },
  { label: "google interactions stream", method: "POST", path: "/v2/model-proxy/google/v1beta/interactions", headers: ["api-revision", "content-type", "x-goog-api-client", "x-goog-api-key"] },
];

test("a recorded preflight from each provider SDK gets a passing answer, and Expose-Headers lists the allowed response headers", async () => {
  const fx = await fixture();
  try {
    for (const preflight of RECORDED_PREFLIGHTS) {
      const reply = await send(fx.port, {
        method: "OPTIONS", path: preflight.path,
        headers: {
          origin: "https://aiboard.me",
          "access-control-request-method": preflight.method,
          "access-control-request-headers": preflight.headers.join(","),
          "access-control-request-private-network": "true",
        },
      });
      assert.equal(reply.status, 204, preflight.label);
      assert.equal(reply.headers["access-control-allow-origin"], "https://aiboard.me", preflight.label);
      assert.ok(String(reply.headers["access-control-allow-methods"]).split(", ").includes(preflight.method), preflight.label);
      const allowed = String(reply.headers["access-control-allow-headers"] ?? "").split(", ");
      for (const name of preflight.headers) assert.ok(allowed.includes(name), `${preflight.label}: ${name} is allowed`);
      const exposed = String(reply.headers["access-control-expose-headers"] ?? "").split(", ");
      for (const name of MODEL_PROXY_RESPONSE_HEADERS) assert.ok(exposed.includes(name), `${preflight.label}: ${name} is exposed`);
      assert.equal(reply.headers["access-control-max-age"], "600");
      assert.equal(reply.headers["access-control-allow-private-network"], "true");
    }
    const loopback = await send(fx.port, { method: "OPTIONS", path: "/v2/model-proxy/openai/models", headers: { origin: "http://localhost:3000", "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-evil,cookie2" } });
    assert.equal(loopback.status, 204);
    assert.equal(loopback.headers["access-control-allow-headers"], "authorization", "only allow-listed names are echoed");
    assert.equal(String(loopback.headers["access-control-allow-methods"]), "GET, POST, OPTIONS");
    const hostile = await send(fx.port, { method: "OPTIONS", path: "/v2/model-proxy/openai/models", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    assert.equal(hostile.status, 403);
    assert.equal(hostile.headers["access-control-allow-origin"], undefined);
    const hostileCall = await send(fx.port, { method: "GET", path: "/v2/model-proxy/openai/models", headers: { origin: "https://evil.example", authorization: `Bearer ${fx.token}` } });
    assert.equal(hostileCall.status, 403);
    const actual = await send(fx.port, { method: "GET", path: "/v2/model-proxy/openai/models", headers: { origin: "https://aiboard.me", authorization: `Bearer ${fx.token}` } });
    assert.equal(actual.status, 200);
    assert.equal(actual.headers["access-control-allow-origin"], "https://aiboard.me");
    assert.ok(String(actual.headers["access-control-expose-headers"]).split(", ").includes("retry-after"));
    assert.equal(fx.upstream.requests.length, 1, "a disallowed origin is never forwarded");
  } finally {
    await fx.close();
  }
});

test("SSE streams unbuffered: each event reaches the client before the upstream sends the next", async () => {
  const fx = await fixture();
  let releaseSecond!: () => void;
  const secondMayGo = new Promise<void>((resolve) => { releaseSecond = resolve; });
  fx.upstream.handler = (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: one\n\n");
    void secondMayGo.then(() => { response.write("data: two\n\n"); response.end(); });
  };
  try {
    const events = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      const outgoing = request({ host: "127.0.0.1", port: fx.port, method: "POST", path: "/v2/model-proxy/openai/chat/completions", headers: { ...json, authorization: `Bearer ${fx.token}` } }, (incoming) => {
        assert.equal(incoming.headers["content-type"], "text/event-stream");
        incoming.on("data", (chunk: Buffer) => {
          seen.push(chunk.toString("utf8"));
          // Only once the first event arrived does the upstream send the second: a buffering proxy hangs here.
          if (seen.length === 1) releaseSecond();
        });
        incoming.on("end", () => resolve(seen));
      });
      outgoing.on("error", reject);
      outgoing.end('{"stream":true}');
      setTimeout(() => reject(new Error("the first event never arrived: the proxy buffered the stream")), 5_000).unref();
    });
    assert.deepEqual(events.join(""), "data: one\n\ndata: two\n\n");
  } finally {
    releaseSecond();
    await fx.close();
  }
});

test("no timeout cuts a silent upstream: the server, the request and the upstream socket set none (the 6-minute case)", async () => {
  const sockets: Array<number | undefined> = [];
  const fx = await fixture({
    onUpstreamRequest: (outgoing) => outgoing.on("socket", (socket) => { sockets.push((socket as unknown as { timeout?: number }).timeout); }),
  });
  fx.upstream.handler = (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    // A reasoning call can be silent for minutes; 1.5 s of silence here, then the answer.
    setTimeout(() => { response.end("data: done\n\n"); }, 1_500);
  };
  try {
    const listener = fx.proxy.listener!;
    assert.equal(listener.requestTimeout, 0, "no request timeout");
    assert.equal(listener.timeout, 0, "no socket idle timeout");
    const reply = await send(fx.port, { method: "POST", path: "/v2/model-proxy/openai/chat/completions", body: "{}", headers: { ...json, authorization: `Bearer ${fx.token}` } });
    assert.equal(reply.status, 200);
    assert.equal(reply.body, "data: done\n\n");
    assert.ok(sockets.length >= 1);
    for (const timeout of sockets) assert.ok(timeout === undefined || timeout === 0, "the upstream socket has no timeout");
  } finally {
    await fx.close();
  }
});

test("an abort reaches upstream", async () => {
  const fx = await fixture();
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  fx.upstream.handler = (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: one\n\n");
    response.on("close", () => upstreamClosed());
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const outgoing = request({ host: "127.0.0.1", port: fx.port, method: "POST", path: "/v2/model-proxy/openai/chat/completions", headers: { ...json, authorization: `Bearer ${fx.token}` } }, (incoming) => {
        incoming.once("data", () => { outgoing.destroy(); resolve(); });
      });
      outgoing.on("error", () => undefined);
      outgoing.end("{}");
      setTimeout(() => reject(new Error("no first event")), 5_000).unref();
    });
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("the abort never reached the upstream")), 5_000).unref())]);
  } finally {
    await fx.close();
  }
});

test("an oversized chunked body gets 413 before the upstream sees it", async () => {
  const fx = await fixture({ maxRequestBytes: 1_024 });
  try {
    const chunked = await send(fx.port, {
      method: "POST", path: "/v2/model-proxy/openai/chat/completions",
      headers: { ...json, authorization: `Bearer ${fx.token}` },
      chunks: ["a".repeat(600), "b".repeat(600), "c".repeat(600)],
    });
    assert.equal(chunked.status, 413);
    assert.equal(JSON.parse(chunked.body).code, "body_too_large");
    const declared = await send(fx.port, {
      method: "POST", path: "/v2/model-proxy/openai/chat/completions",
      headers: { ...json, authorization: `Bearer ${fx.token}`, "content-length": "4096" },
      body: "x".repeat(4096),
    });
    assert.equal(declared.status, 413);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fx.upstream.requests.filter((recorded) => recorded.complete).length, 0, "the upstream never received a whole request");
    assert.ok(fx.upstream.requests.every((recorded) => recorded.body.length <= 1_024), "and never more than the cap");
    const fits = await send(fx.port, { method: "POST", path: "/v2/model-proxy/openai/chat/completions", headers: { ...json, authorization: `Bearer ${fx.token}` }, chunks: ["a".repeat(500), "b".repeat(500)] });
    assert.equal(fits.status, 200, "a chunked body under the cap is forwarded whole");
    assert.equal(fx.upstream.requests.at(-1)!.body.length, 1_000);
  } finally {
    await fx.close();
  }
});

test("a key split across two chunks of an error body is scrubbed to its hint", async () => {
  const fx = await fixture();
  const cut = 9;
  fx.upstream.handler = (_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.write(`{"error":{"message":"Incorrect API key provided: ${OPENAI_KEY.slice(0, cut)}`);
    setTimeout(() => { response.end(`${OPENAI_KEY.slice(cut)}. Also ${OPENAI_KEY}."}}`); }, 50);
  };
  try {
    const reply = await send(fx.port, { method: "POST", path: "/v2/model-proxy/openai/chat/completions", body: "{}", headers: { ...json, authorization: `Bearer ${fx.token}` } });
    assert.equal(reply.status, 401, "the upstream status passes through for the retry classifiers");
    assert.equal(reply.body.includes(OPENAI_KEY), false);
    assert.equal(reply.body.includes(OPENAI_KEY.slice(4, -4)), false);
    assert.equal(reply.body, `{"error":{"message":"Incorrect API key provided: ${keyHint(OPENAI_KEY)}. Also ${keyHint(OPENAI_KEY)}."}}`);
  } finally {
    await fx.close();
  }

  // Every split position of a key, at every chunk size.
  const secret = "sk-split-0123456789";
  const text = `pre ${secret} mid ${secret}${secret} post`;
  for (let size = 1; size <= text.length; size += 1) {
    const scrubber = new KeyScrubber(secret, "HINT");
    let out = "";
    for (let at = 0; at < text.length; at += size) out += scrubber.push(Buffer.from(text.slice(at, at + size))).toString();
    out += scrubber.end().toString();
    assert.equal(out, "pre HINT mid HINTHINT post", `chunk size ${size}`);
  }
});

test("the proxy uses the home's key at call time: a removed key gets home_key_missing and is never forwarded", async () => {
  const fx = await fixture();
  try {
    const home = await readAiboardHome(fx.location, { credentials: false });
    await applyHomeBatch(fx.location, { baseRevision: home.revision, ops: [{ path: "credentials.providers.openai", op: "remove" }] });
    const reply = await send(fx.port, { method: "POST", path: "/v2/model-proxy/openai/chat/completions", body: "{}", headers: { ...json, authorization: `Bearer ${fx.token}` } });
    assert.equal(reply.status, 422);
    assert.equal(JSON.parse(reply.body).code, "home_key_missing");
    const keyless = await send(fx.port, { method: "POST", path: "/v2/model-proxy/deepseek/chat/completions", body: "{}", headers: { ...json, authorization: `Bearer ${fx.token}` } });
    assert.equal(JSON.parse(keyless.body).code, "home_key_missing");
    assert.equal(fx.upstream.requests.length, 0);
  } finally {
    await fx.close();
  }
});

test("the proxy sends a key over plain http only to this computer", async () => {
  const fx = await fixture({
    homeOps: () => [
      { path: "providers.openai", op: "set", value: { enabled: true, baseUrl: "http://gateway.example.test/v1" } },
      { path: "credentials.providers.openai", op: "set", value: { secret: OPENAI_KEY } },
    ],
  });
  try {
    const reply = await send(fx.port, { method: "POST", path: "/v2/model-proxy/openai/chat/completions", body: "{}", headers: { ...json, authorization: `Bearer ${fx.token}` } });
    assert.equal(reply.status, 502);
    assert.equal(JSON.parse(reply.body).code, "proxy_upstream_insecure");
  } finally {
    await fx.close();
  }
});
