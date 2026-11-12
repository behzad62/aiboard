import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAiboardHome, type AiboardHomeLocation } from "../src/aiboard-home-paths.js";
import { applyHomeBatch, keyHint, readAiboardHome, readAiboardHomeSync } from "../src/aiboard-home-store.js";
import { ControlServer } from "../src/control-server.js";
import { HomeBackedProviderConfigStore } from "../src/home-provider-configs.js";
import { CachedHomeReader } from "../src/home-reader.js";
import { createLocalPairTicket, LocalPairing } from "../src/local-pairing.js";
import { ModelProxy, PROXY_TOKEN_LIFETIME_MS, PROXY_TOKEN_REPLACEMENT_GRACE_MS } from "../src/model-proxy.js";
import { validateProviderConfigs, type ProviderConfigStore, type RunnerProviderConfig } from "../src/provider-config-store.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

// Stub keys only; the canaries prove no route ever returns a saved secret.
const token = "test-control-token";
const CANARY = "sk-canary-home-0123456789abcdefghijklmnop";
const CUSTOM_CANARY = "custom-canary-0123456789abcdefghij";
const MCP_CANARY = "mcp-canary-0123456789abcdefghij";
const INSTANCE = "runner-instance-1";

interface Fixture {
  root: string;
  location: AiboardHomeLocation;
  url: string;
  proxy: ModelProxy;
  proxyPort: number;
  pairing: LocalPairing;
  now: { value: number };
  configs: { current: RunnerProviderConfig[] };
  upstream: { server: Server; port: number; hits: number };
  responses: string[];
  call(path: string, init?: { method?: string; body?: unknown; bearer?: string }): Promise<{ status: number; body: Record<string, unknown> }>;
  pair(): string;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-control-home-"));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const environment: NodeJS.ProcessEnv = { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") };
  const location = resolveAiboardHome({ platform: process.platform, environment, home: userHome });
  const upstream = { server: createServer((_request, response) => { upstream.hits += 1; response.setHeader("content-type", "application/json"); response.end("{}"); }), port: 0, hits: 0 };
  await new Promise<void>((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
  upstream.port = (upstream.server.address() as { port: number }).port;
  const now = { value: Date.parse("2026-11-12T00:00:00.000Z") };
  const proxy = new ModelProxy({ home: location, clock: () => now.value });
  const { port: proxyPort } = await proxy.start(0);
  const pairing = new LocalPairing(INSTANCE);
  const configs = { current: [] as RunnerProviderConfig[] };
  const inner: ProviderConfigStore = {
    load: () => configs.current.map((config) => ({ ...config })),
    save: (next) => { validateProviderConfigs(next); configs.current = next.map((config) => ({ ...config })); },
    close: () => undefined,
  };
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
  const server = new ControlServer({
    supervisor, token, bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/x" }),
    runnerInfo: { projectPath: root, nodeVersion: process.versions.node },
    providerConfigs: new HomeBackedProviderConfigStore(inner, () => readAiboardHomeSync(location)),
    localPairing: pairing,
    home: location,
    modelProxy: proxy,
  });
  const { url } = await server.start(0);
  const responses: string[] = [];
  return {
    root, location, url, proxy, proxyPort, pairing, now, configs, upstream, responses,
    async call(path, init = {}) {
      const response = await fetch(`${url}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${init.bearer ?? token}`, "content-type": "application/json" },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await response.text();
      responses.push(text);
      return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
    },
    pair() {
      const ticket = createLocalPairTicket(INSTANCE);
      pairing.register(ticket.digest);
      const session = pairing.consume(ticket.code);
      assert.ok(session);
      return session;
    },
    async close() {
      await server.close();
      supervisor.close();
      await new Promise<void>((resolve) => { upstream.server.close(() => resolve()); upstream.server.closeAllConnections(); });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function proxyCall(fx: Fixture, proxyToken: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${fx.proxyPort}/v2/model-proxy/openai/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${proxyToken}`, "content-type": "application/json" }, body: "{}",
  });
  await response.arrayBuffer();
  return response.status;
}

async function seedOpenAi(fx: Fixture): Promise<void> {
  const home = await readAiboardHome(fx.location, { credentials: false });
  await applyHomeBatch(fx.location, { baseRevision: home.revision, ops: [
    { path: "providers.openai", op: "set", value: { enabled: true, baseUrl: `http://127.0.0.1:${fx.upstream.port}/v1` } },
    { path: "credentials.providers.openai", op: "set", value: { secret: "sk-stub-openai-0123456789abcdef" } },
  ] });
}

test("GET /v2/home never returns a secret; a canary secret in the home appears in no response", async () => {
  const fx = await fixture();
  try {
    assert.equal((await fx.call("/v2/home/credentials/openai", { method: "POST", body: { action: "set", secret: CANARY } })).status, 200);
    let view = await fx.call("/v2/home");
    assert.equal(view.status, 200);
    assert.equal((await fx.call("/v2/home", { method: "POST", body: { baseRevision: view.body.revision, ops: [
      { path: "customModels.local-a", op: "set", value: { label: "Local", baseURL: `http://127.0.0.1:${fx.upstream.port}/v1`, model: "gemma", createdAt: "2026-11-12T00:00:00.000Z" } },
      { path: "settings.toolRuntime", op: "set", value: { remoteMcpServer: { enabled: true, name: "remote", url: "https://mcp.example.test" } } },
    ] } })).status, 200);
    assert.equal((await fx.call("/v2/home/credentials/custom/local-a", { method: "POST", body: { action: "set", secret: CUSTOM_CANARY } })).status, 200);
    const mcp = await fx.call("/v2/home/credentials/remote-mcp", { method: "POST", body: { action: "set", secret: MCP_CANARY } });
    assert.deepEqual(mcp.body.keyHint, keyHint(MCP_CANARY), "a credential route answers with the hint only");

    view = await fx.call("/v2/home");
    const credentials = view.body.credentials as Record<string, Record<string, { hasKey: boolean; keyHint: string }>>;
    assert.deepEqual(credentials.providers!.openai, { hasKey: true, keyHint: keyHint(CANARY) });
    assert.deepEqual(credentials.customModels!["local-a"], { hasKey: true, keyHint: keyHint(CUSTOM_CANARY) });
    assert.deepEqual(credentials.remoteMcpAuthorizationToken, { hasKey: true, keyHint: keyHint(MCP_CANARY) });
    assert.equal(view.body.home, fx.location.home);
    assert.equal(view.body.keyPath, fx.location.keyPath);
    assert.equal(typeof view.body.revision, "number");
    assert.equal(typeof view.body.pathRevisions, "object");

    // Every other route that touches the home or the configs.
    await fx.call("/v2/home", { method: "POST", body: { baseRevision: 0, ops: [{ path: "credentials.providers.openai", op: "set", value: { secret: `${CANARY}-new` } }] } });
    await fx.call("/v2/health");
    await fx.call("/v2/provider-configs", { method: "PUT", body: { configs: [{ runtimeId: "openai:gpt-5", providerId: "openai", modelId: "gpt-5", transport: "openai-compatible", capabilities: ["*"], priority: 0 }] } });
    await fx.call("/v2/provider-configs");
    await fx.call("/v2/home/proxy-session", { method: "POST" });
    await fx.call("/v2/home/credentials/openai", { method: "POST", body: { action: "remove" } });
    await fx.call("/v2/home");
    assert.ok(fx.responses.length >= 10);
    for (const text of fx.responses) {
      for (const canary of [CANARY, CUSTOM_CANARY, MCP_CANARY]) assert.equal(text.includes(canary), false, `a response leaked a saved key: ${text.slice(0, 120)}`);
    }
    assert.equal(fx.configs.current.some((config) => JSON.stringify(config).includes(CANARY)), false, "a home key is never stored in a folder's provider configs");
  } finally {
    await fx.close();
  }
});

test("POST /v2/home batches apply all or nothing", async () => {
  const fx = await fixture();
  try {
    const before = await fx.call("/v2/home");
    const refused = await fx.call("/v2/home", { method: "POST", body: { baseRevision: before.body.revision, ops: [
      { path: "settings.defaultReasoningEffort", op: "set", value: "high" },
      { path: "settings.notAHomeSetting", op: "set", value: 1 },
    ] } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "home_invalid_op");
    const after = await fx.call("/v2/home");
    assert.equal(after.body.revision, before.body.revision, "nothing was written");
    assert.equal((after.body.config as { settings: Record<string, unknown> }).settings.defaultReasoningEffort, undefined, "the valid op did not land alone");
    for (const body of [{ ops: [] }, { baseRevision: -1, ops: [] }, { baseRevision: 0, ops: [], extra: true }, { baseRevision: 0, ops: {} }]) {
      assert.equal((await fx.call("/v2/home", { method: "POST", body })).status, 400);
    }
  } finally {
    await fx.close();
  }
});

test("two clients editing different entries of one map both land; a stale baseRevision on one section gets 409 with the current values", async () => {
  const fx = await fixture();
  try {
    const base = (await fx.call("/v2/home")).body.revision as number;
    const first = await fx.call("/v2/home", { method: "POST", body: { baseRevision: base, ops: [{ path: "settings.modelPricingOverrides.openai:a", op: "set", value: { inputPerMillion: 1, outputPerMillion: 2 } }] } });
    const second = await fx.call("/v2/home", { method: "POST", body: { baseRevision: base, ops: [{ path: "settings.modelPricingOverrides.openai:b", op: "set", value: { inputPerMillion: 3, outputPerMillion: 4 } }] } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, "a different entry of the same map, from the same base revision, lands too");
    const overrides = ((await fx.call("/v2/home")).body.config as { settings: { modelPricingOverrides: Record<string, unknown> } }).settings.modelPricingOverrides;
    assert.deepEqual(Object.keys(overrides).sort(), ["openai:a", "openai:b"]);
    const stale = await fx.call("/v2/home", { method: "POST", body: { baseRevision: base, ops: [{ path: "settings.modelPricingOverrides.openai:a", op: "set", value: { inputPerMillion: 9, outputPerMillion: 9 } }] } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "home_conflict");
    assert.equal(stale.body.currentRevision, second.body.revision);
    assert.deepEqual((stale.body.sections as Record<string, unknown>)["settings.modelPricingOverrides.openai:a"], { inputPerMillion: 1, outputPerMillion: 2 });
  } finally {
    await fx.close();
  }
});

test("the credential routes take the key in the body and answer with its hint only", async () => {
  const fx = await fixture();
  try {
    const saved = await fx.call("/v2/home/credentials/anthropic", { method: "POST", body: { action: "set", secret: CANARY } });
    assert.equal(saved.status, 200);
    assert.deepEqual(Object.keys(saved.body).sort(), ["keyHint", "revision", "saved"]);
    assert.equal(saved.body.keyHint, keyHint(CANARY));
    let config = (await fx.call("/v2/home")).body.config as { providers: Record<string, { enabled: boolean; lastValidationSucceeded: boolean | null }> };
    assert.equal(config.providers.anthropic!.enabled, true, "a provider seen for the first time is enabled");
    await fx.call("/v2/home", { method: "POST", body: { baseRevision: (await fx.call("/v2/home")).body.revision, ops: [{ path: "providers.anthropic", op: "merge", value: { lastValidationSucceeded: true, lastValidatedAt: "2026-11-12T00:00:00.000Z" } }] } });
    await fx.call("/v2/home/credentials/anthropic", { method: "POST", body: { action: "set", secret: `${CANARY}-2` } });
    config = (await fx.call("/v2/home")).body.config as typeof config;
    assert.equal(config.providers.anthropic!.lastValidationSucceeded, null, "a replaced key is not validated yet");
    const removed = await fx.call("/v2/home/credentials/anthropic", { method: "POST", body: { action: "remove" } });
    assert.deepEqual({ saved: removed.body.saved, keyHint: removed.body.keyHint }, { saved: false, keyHint: null });
    assert.deepEqual(((await fx.call("/v2/home")).body.credentials as { providers: object }).providers, {});

    for (const [path, body, status, code] of [
      ["/v2/home/credentials/chatgpt", { action: "set", secret: "x" }, 422, "home_invalid_op"],
      ["/v2/home/credentials/not-a-provider", { action: "set", secret: "x" }, 422, "unknown_provider"],
      ["/v2/home/credentials/openai", { action: "set" }, 400, "invalid_request"],
      ["/v2/home/credentials/openai", { action: "set", secret: "" }, 400, "invalid_request"],
      ["/v2/home/credentials/openai", { action: "remove", secret: "x" }, 400, "invalid_request"],
      ["/v2/home/credentials/openai", { action: "rotate" }, 400, "invalid_request"],
      ["/v2/home/credentials/custom/missing", { action: "set", secret: "x" }, 400, "home_invalid_op"],
    ] as const) {
      const reply = await fx.call(path, { method: "POST", body });
      assert.equal(reply.status, status, `${path} ${JSON.stringify(body)}`);
      assert.equal(reply.body.code, code, `${path} ${JSON.stringify(body)}`);
    }
  } finally {
    await fx.close();
  }
});

test("a proxy token is refused on the control port and on every other route", async () => {
  const fx = await fixture();
  try {
    await seedOpenAi(fx);
    const grant = await fx.call("/v2/home/proxy-session", { method: "POST" });
    assert.equal(grant.status, 200);
    const proxyToken = grant.body.token as string;
    assert.match(proxyToken, /^proxy_[A-Za-z0-9_-]{43}$/);
    assert.equal(grant.body.proxyBaseUrl, `http://127.0.0.1:${fx.proxyPort}`);
    assert.equal(grant.body.expiresAt, null, "a manual connection's token lives as long as the Runner");
    for (const path of ["/v2/health", "/v2/home", "/v2/provider-configs", "/v2/runs", "/v2/permissions"]) {
      const reply = await fx.call(path, { bearer: proxyToken });
      assert.equal(reply.status, 401, `${path} refuses the proxy token`);
    }
    assert.equal((await fx.call("/v2/home/proxy-session", { method: "POST", bearer: proxyToken })).status, 401, "a proxy token cannot mint another");
    for (const path of ["/v2/health", "/v2/home", "/v2/model-proxy-other", "/v1/local-mcp", "/"]) {
      const reply = await fetch(`http://127.0.0.1:${fx.proxyPort}${path}`, { headers: { authorization: `Bearer ${proxyToken}` } });
      await reply.arrayBuffer();
      assert.equal(reply.status, 404, `the proxy port serves only /v2/model-proxy/* (${path})`);
    }
    assert.equal(await proxyCall(fx, token), 401, "the Runner token is not a proxy token");
    assert.equal(await proxyCall(fx, proxyToken), 200);
    assert.equal(fx.upstream.hits, 1);
  } finally {
    await fx.close();
  }
});

test("a proxy token stops working 60 s after it is replaced", async () => {
  const fx = await fixture();
  try {
    await seedOpenAi(fx);
    const session = fx.pair();
    const first = (await fx.call("/v2/home/proxy-session", { method: "POST", bearer: session })).body.token as string;
    fx.now.value += 1_000;
    const second = (await fx.call("/v2/home/proxy-session", { method: "POST", bearer: session })).body.token as string;
    assert.notEqual(first, second);
    fx.now.value += PROXY_TOKEN_REPLACEMENT_GRACE_MS - 1;
    assert.equal(await proxyCall(fx, first), 200, "streams in flight can finish within the 60 s");
    fx.now.value += 1;
    assert.equal(await proxyCall(fx, first), 401, "the replaced token stops 60 s after its replacement");
    assert.equal(await proxyCall(fx, second), 200);
    // A manual connection's token is replaced the same way.
    const manualA = (await fx.call("/v2/home/proxy-session", { method: "POST" })).body.token as string;
    const manualB = (await fx.call("/v2/home/proxy-session", { method: "POST" })).body.token as string;
    fx.now.value += PROXY_TOKEN_REPLACEMENT_GRACE_MS;
    assert.equal(await proxyCall(fx, manualA), 401);
    assert.equal(await proxyCall(fx, manualB), 200);
    assert.equal(await proxyCall(fx, second), 200, "one principal's new token never retires another's");
  } finally {
    await fx.close();
  }
});

test("a paired session's proxy token expires after 12 h and dies with its session; a manual connection's lives as long as the Runner", async () => {
  const fx = await fixture();
  try {
    await seedOpenAi(fx);
    const session = fx.pair();
    const grant = (await fx.call("/v2/home/proxy-session", { method: "POST", bearer: session })).body;
    assert.equal(grant.expiresAt, new Date(fx.now.value + PROXY_TOKEN_LIFETIME_MS).toISOString());
    const manual = (await fx.call("/v2/home/proxy-session", { method: "POST" })).body.token as string;
    fx.now.value += PROXY_TOKEN_LIFETIME_MS - 1;
    assert.equal(await proxyCall(fx, grant.token as string), 200);
    fx.now.value += 1;
    assert.equal(await proxyCall(fx, grant.token as string), 401, "a paired session's token expires after 12 h");
    assert.equal(await proxyCall(fx, manual), 200, "a manual connection's token does not expire");

    const other = fx.pair();
    const live = (await fx.call("/v2/home/proxy-session", { method: "POST", bearer: other })).body.token as string;
    assert.equal(await proxyCall(fx, live), 200);
    assert.equal(fx.pairing.revoke(other), true);
    assert.equal(await proxyCall(fx, live), 401, "revoking the paired session revokes its proxy token at once");
    assert.equal((await fx.call("/v2/home/proxy-session", { method: "POST", bearer: other })).status, 401);
  } finally {
    await fx.close();
  }
});

test("GET /v2/home still shows the settings when the saved keys cannot be read", async () => {
  const fx = await fixture();
  try {
    await fx.call("/v2/home/credentials/openai", { method: "POST", body: { action: "set", secret: CANARY } });
    rmSync(fx.location.keyPath, { force: true });
    const view = await fx.call("/v2/home");
    assert.equal(view.status, 200);
    assert.equal(view.body.credentials, null);
    assert.equal((view.body.keysError as { code: string }).code, "home_unreadable");
    assert.equal((view.body.config as { providers: Record<string, { enabled: boolean }> }).providers.openai!.enabled, true);
    assert.equal(JSON.stringify(view.body).includes(CANARY), false);
  } finally {
    await fx.close();
  }
});

test("the synchronous home read sees exactly what the async read sees", async () => {
  const fx = await fixture();
  try {
    await seedOpenAi(fx);
    const asyncRead = await readAiboardHome(fx.location);
    const syncRead = readAiboardHomeSync(fx.location);
    assert.deepEqual(syncRead.config, asyncRead.config);
    assert.deepEqual(syncRead.credentials, asyncRead.credentials);
    assert.equal(syncRead.secret("credentials.providers.openai"), asyncRead.secret("credentials.providers.openai"));
    assert.equal(syncRead.writable, asyncRead.writable);
  } finally {
    await fx.close();
  }
});

test("the cached home reader reuses a snapshot only while the home's files are unchanged", async () => {
  const fx = await fixture();
  try {
    await seedOpenAi(fx);
    const reader = new CachedHomeReader(fx.location);
    const first = await reader.read();
    assert.equal(await reader.read(), first, "an unchanged home is not decrypted again");
    assert.equal(reader.readSync(), first);
    // Every kind of change is seen by the next read: a replaced key, a removed key, a settings write.
    await fx.call("/v2/home/credentials/openai", { method: "POST", body: { action: "set", secret: `${CANARY}-replaced` } });
    const replaced = reader.readSync();
    assert.notEqual(replaced, first);
    assert.equal(replaced.secret("credentials.providers.openai"), `${CANARY}-replaced`);
    await fx.call("/v2/home/credentials/openai", { method: "POST", body: { action: "remove" } });
    assert.equal((await reader.read()).secret("credentials.providers.openai"), undefined);
    const before = await reader.read();
    await fx.call("/v2/home", { method: "POST", body: { baseRevision: before.revision, ops: [{ path: "settings.defaultReasoningEffort", op: "set", value: "high" }] } });
    assert.equal((await reader.read()).config.settings.defaultReasoningEffort, "high");
    // A missing home key is an error every time, never a cached snapshot.
    await fx.call("/v2/home/credentials/openai", { method: "POST", body: { action: "set", secret: CANARY } });
    assert.equal((await reader.read()).secret("credentials.providers.openai"), CANARY);
    rmSync(fx.location.keyPath, { force: true });
    await assert.rejects(reader.read(), /home_unreadable/);
    assert.throws(() => reader.readSync(), /home_unreadable/);
  } finally {
    await fx.close();
  }
});
