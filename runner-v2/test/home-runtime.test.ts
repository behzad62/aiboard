import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveAiboardHome, type AiboardHomeLocation } from "../src/aiboard-home-paths.js";
import { applyHomeBatch, readAiboardHome, type HomeBatch } from "../src/aiboard-home-store.js";
import { catalogVersion, MODEL_CATALOG_SNAPSHOT } from "../src/generated/model-catalog.js";
import { migrateHomeConfigModelIds, runtimeEffort, runtimeModelRef } from "../src/home-model-policy.js";
import {
  checkHomeModelId,
  HomeModelError,
  homeProviderUpstream,
  isHomeModelEnabled,
  LOCAL_ENDPOINT_PLACEHOLDER_SECRET,
  listHomeEnabledModels,
  resolveHomeRuntime,
} from "../src/home-runtime.js";

// Packet HM2 (Simple Build plan §9 "The Runner knows models"). Equality with the web's
// createNativeProviderConfig and getEnabledModels is scripts/test-runner-model-catalog-parity.mts;
// this file pins the home's own rules through a real home on disk. Stub keys only.
const STUB_KEY = "stub-key-hm2-0001";
const PEER = { baseUrl: "http://127.0.0.1:1455", token: "stub-peer-token" };

interface Fixture { root: string; location: AiboardHomeLocation }

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aiboard-home-runtime-"));
  const userHome = join(root, "user");
  mkdirSync(userHome, { recursive: true });
  const environment: NodeJS.ProcessEnv = { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") };
  return { root, location: resolveAiboardHome({ platform: process.platform, environment, home: userHome }) };
}

async function write(fx: Fixture, ops: HomeBatch["ops"]) {
  const current = (await readAiboardHome(fx.location, { credentials: false })).revision;
  return await applyHomeBatch(fx.location, { baseRevision: current, ops });
}

async function withHome(ops: HomeBatch["ops"], run: (fx: Fixture) => Promise<void>): Promise<void> {
  const fx = fixture();
  try {
    if (ops.length > 0) await write(fx, ops);
    await run(fx);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

const provider = (patch: Record<string, unknown> = {}) => ({
  enabled: true, baseUrl: null, models: null, enabledModelIds: null, defaultModel: null,
  lastValidationSucceeded: null, lastValidatedAt: null, ...patch,
});

function refuses(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HomeModelError, `expected HomeModelError ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

const catalogModel = (providerId: string) => {
  const model = MODEL_CATALOG_SNAPSHOT.models.find((entry) => entry.providerId === providerId);
  assert.ok(model, `the snapshot has a ${providerId} model`);
  return model;
};

// ------------------------------------------------------------------ the snapshot

test("the catalog snapshot is a committed, data-only module with a catalog version", () => {
  assert.match(catalogVersion, /^[0-9a-f]{16}$/);
  assert.equal(MODEL_CATALOG_SNAPSHOT.catalogVersion, catalogVersion);
  const source = readFileSync(new URL("../src/generated/model-catalog.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /=>|\bfunction\b|\bclass\b/);
  assert.ok(MODEL_CATALOG_SNAPSHOT.models.length > 0);
  assert.deepEqual([...MODEL_CATALOG_SNAPSHOT.providerOrder].sort(), Object.keys(MODEL_CATALOG_SNAPSHOT.providers).sort());
  // Every provider names its transport; every direct provider but Azure AI Foundry has a default upstream.
  for (const entry of Object.values(MODEL_CATALOG_SNAPSHOT.providers)) {
    if (entry.accountBacked) assert.equal(entry.transport, "account-runner", entry.id);
    else if (entry.id !== "foundry") assert.match(entry.defaultBaseUrl ?? "", /^https:\/\//, entry.id);
  }
});

// ------------------------------------------------------------------ model-id rules

test("an id with an unknown provider is refused", async () => {
  await withHome([{ path: "providers.openai", op: "set", value: provider() }], async (fx) => {
    const home = await readAiboardHome(fx.location);
    refuses(() => checkHomeModelId(home.config, "nonesuch:model-1"), "unknown_provider");
    refuses(() => resolveHomeRuntime(home, "nonesuch:model-1"), "unknown_provider");
    refuses(() => checkHomeModelId(home.config, "no-separator"), "unknown_provider");
    refuses(() => checkHomeModelId(home.config, "custom:missing"), "model_not_configured");
    assert.equal(isHomeModelEnabled(home, "nonesuch:model-1"), false);
  });
});

test("an id a discovering provider has but the snapshot lacks is accepted with a warning", async () => {
  await withHome([
    { path: "providers.openai", op: "set", value: provider({ models: ["gpt-not-in-catalog"] }) },
    { path: "credentials.providers.openai", op: "set", value: { secret: STUB_KEY } },
  ], async (fx) => {
    const home = await readAiboardHome(fx.location);
    const known = catalogModel("openai");
    assert.deepEqual(checkHomeModelId(home.config, `openai:${known.id}`).warnings, []);
    const unknown = checkHomeModelId(home.config, "openai:gpt-not-in-catalog");
    assert.equal(unknown.inCatalog, false);
    assert.deepEqual(unknown.warnings.map((warning) => warning.code), ["model_not_in_catalog"]);
    const resolved = resolveHomeRuntime(home, "openai:gpt-not-in-catalog");
    assert.equal(resolved.config.modelId, "gpt-not-in-catalog");
    assert.deepEqual(resolved.warnings.map((warning) => warning.code), ["model_not_in_catalog"]);
    assert.equal(resolved.config.billingBasis, "unknown", "no price is invented for an uncatalogued model");
  });
});

test("Azure AI Foundry does not discover: its id must be a saved deployment, and its endpoint is required", async () => {
  const endpoint = "https://stub-resource.services.ai.azure.com/anthropic/";
  await withHome([
    { path: "providers.foundry", op: "set", value: provider({ baseUrl: endpoint, models: ["claude-opus-4-5", "foundry:claude-sonnet-4-5"] }) },
    { path: "credentials.providers.foundry", op: "set", value: { secret: STUB_KEY } },
  ], async (fx) => {
    const home = await readAiboardHome(fx.location);
    refuses(() => checkHomeModelId(home.config, "foundry:claude-not-deployed"), "model_not_configured");
    const resolved = resolveHomeRuntime(home, "foundry:claude-sonnet-4-5");
    assert.deepEqual(resolved.warnings, []);
    assert.equal(resolved.config.transport, "anthropic");
    assert.equal(resolved.config.baseUrl, endpoint);
    assert.deepEqual(listHomeEnabledModels(home).map((model) => model.id), ["foundry:claude-opus-4-5", "foundry:claude-sonnet-4-5"]);
  });
  await withHome([
    { path: "providers.foundry", op: "set", value: provider({ models: ["claude-opus-4-5"] }) },
    { path: "credentials.providers.foundry", op: "set", value: { secret: STUB_KEY } },
  ], async (fx) => {
    const home = await readAiboardHome(fx.location);
    refuses(() => resolveHomeRuntime(home, "foundry:claude-opus-4-5"), "base_url_required");
  });
});

// ------------------------------------------------------------------ renamed ids

test("renamed model ids migrate on read, and the next write saves them", async () => {
  const fx = fixture();
  try {
    await write(fx, [
      { path: "providers.openai", op: "set", value: provider({ defaultModel: "gpt-5.6", enabledModelIds: ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-mini"], models: ["gpt-5.6-pro"] }) },
      { path: "providers.chatgpt", op: "set", value: provider({ defaultModel: "gpt-5.6" }) },
      { path: "settings.judgeModelId", op: "set", value: "openai:gpt-5.6-pro" },
      { path: "settings.modelPricingOverrides.openai:gpt-5.6-mini", op: "set", value: { inputUsdPer1M: 1, outputUsdPer1M: 2, updatedAt: "2026-11-12" } },
      { path: "settings.modelContextOverrides.openai:gpt-5.6", op: "set", value: { contextWindowTokens: 50_000 } },
      { path: "settings.modelContextOverrides.openai:gpt-5.6-terra", op: "set", value: { contextWindowTokens: 60_000 } },
      { path: "settings.discoveredModelMetadata.openai:gpt-5.6", op: "set", value: { contextWindowTokens: 1 } },
    ]);
    // DX1's exec section is not an op path yet; a writer keeps it verbatim, a reader migrates its id.
    const raw = JSON.parse(readFileSync(fx.location.configPath, "utf8")) as Record<string, unknown>;
    raw.exec = { defaultModelId: "openai:gpt-5.6-mini", ceilings: { maxWallClockMs: null, maxModelCalls: null, maxUsd: null } };
    writeFileSync(fx.location.configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON file read back in a test
    type Json = any;
    const expectMigrated = (config: Json) => {
      assert.equal(config.providers.openai.defaultModel, "gpt-5.6-terra");
      assert.deepEqual(config.providers.openai.enabledModelIds, ["gpt-5.6-terra", "gpt-5.6-luna"], "a renamed id already listed under its new name is listed once");
      assert.deepEqual(config.providers.openai.models, ["gpt-5.6-sol"]);
      assert.equal(config.providers.chatgpt.defaultModel, "gpt-5.6", "only OpenAI's ids were renamed");
      assert.equal(config.settings.judgeModelId, "openai:gpt-5.6-sol");
      assert.deepEqual(Object.keys(config.settings.modelPricingOverrides), ["openai:gpt-5.6-luna"]);
      assert.deepEqual(config.settings.modelContextOverrides, { "openai:gpt-5.6-terra": { contextWindowTokens: 60_000 } }, "an entry already under the new id wins");
      assert.deepEqual(Object.keys(config.settings.discoveredModelMetadata), ["openai:gpt-5.6"], "discovered metadata keeps its exact id, as in the web");
      assert.equal(config.exec.defaultModelId, "openai:gpt-5.6-luna");
    };
    expectMigrated((await readAiboardHome(fx.location, { credentials: false })).config as Json);
    const before = JSON.parse(readFileSync(fx.location.configPath, "utf8")) as Json;
    assert.equal(before.providers.openai.defaultModel, "gpt-5.6", "a read never writes");

    await write(fx, [{ path: "settings.defaultMode", op: "set", value: "chat" }]);
    const after = JSON.parse(readFileSync(fx.location.configPath, "utf8")) as Json;
    expectMigrated(after);
    assert.equal(after.exec.ceilings.maxUsd, null, "the exec section is otherwise kept verbatim");

    const unchanged = { providers: { openai: { enabledModelIds: ["gpt-5.6-sol", "gpt-5.6-sol"] } }, settings: {} };
    assert.equal(migrateHomeConfigModelIds(unchanged), false);
    assert.deepEqual(unchanged.providers.openai.enabledModelIds, ["gpt-5.6-sol", "gpt-5.6-sol"], "a list with nothing to migrate is left alone");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ upstreams and keys

test("a key saved with no base URL stays bound to default:<provider> and resolves to the snapshot's default upstream", async () => {
  const fx = fixture();
  try {
    await write(fx, [
      { path: "providers.openai", op: "set", value: provider() },
      { path: "credentials.providers.openai", op: "set", value: { secret: STUB_KEY } },
      { path: "providers.anthropic", op: "set", value: provider() },
      { path: "credentials.providers.anthropic", op: "set", value: { secret: STUB_KEY } },
      { path: "providers.nvidia", op: "set", value: provider({ models: ["z-ai/glm-5.2"] }) },
      { path: "credentials.providers.nvidia", op: "set", value: { secret: STUB_KEY } },
    ]);
    let home = await readAiboardHome(fx.location);
    assert.equal(homeProviderUpstream(home.config, "openai"), MODEL_CATALOG_SNAPSHOT.providers.openai.defaultBaseUrl);
    assert.equal(homeProviderUpstream(home.config, "anthropic"), "https://api.anthropic.com");
    assert.equal(homeProviderUpstream(home.config, "chatgpt"), null, "the launcher names an account peer");
    assert.equal(homeProviderUpstream(home.config, "foundry"), null);
    const openai = resolveHomeRuntime(home, `openai:${catalogModel("openai").id}`).config;
    assert.equal(openai.transport, "openai-compatible");
    assert.equal(openai.baseUrl, "https://api.openai.com/v1");
    assert.equal(openai.protocol, "responses");
    assert.ok(openai.secret === STUB_KEY, "the home's key is the runtime's secret");
    const anthropic = resolveHomeRuntime(home, `anthropic:${catalogModel("anthropic").id}`).config;
    assert.equal(anthropic.transport, "anthropic");
    assert.equal(anthropic.baseUrl, undefined, "the Anthropic adapter defaults to the provider's host");
    // OD-32: NVIDIA is called directly, not through the account peer.
    const nvidia = resolveHomeRuntime(home, "nvidia:z-ai/glm-5.2").config;
    assert.equal(nvidia.transport, "openai-compatible");
    assert.equal(nvidia.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(nvidia.protocol, "chat-completions");

    // The binding is the sentinel; HM2 keeps it, so this key stays usable.
    const credentials = (await readAiboardHome(fx.location)).credentials;
    assert.ok(credentials?.providers.openai, "the key saved under default:openai is usable");

    // A saved base URL is the upstream; HM1's base-URL rule removes the key bound to the default.
    await write(fx, [{ path: "providers.openai", op: "merge", value: { baseUrl: "https://gateway.example.test/v1" } }]);
    home = await readAiboardHome(fx.location);
    assert.equal(homeProviderUpstream(home.config, "openai"), "https://gateway.example.test/v1");
    refuses(() => resolveHomeRuntime(home, `openai:${catalogModel("openai").id}`), "home_key_missing");
    await write(fx, [{ path: "credentials.providers.openai", op: "set", value: { secret: STUB_KEY } }]);
    home = await readAiboardHome(fx.location);
    assert.equal(resolveHomeRuntime(home, `openai:${catalogModel("openai").id}`).config.baseUrl, "https://gateway.example.test/v1");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("a provider that is disabled or has no key is refused; account-backed providers need the launcher's peer", async () => {
  await withHome([
    { path: "providers.openai", op: "set", value: provider({ enabled: false }) },
    { path: "credentials.providers.openai", op: "set", value: { secret: STUB_KEY } },
    { path: "providers.deepseek", op: "set", value: provider() },
    { path: "providers.chatgpt", op: "set", value: provider({ enabledModelIds: [catalogModel("chatgpt").id] }) },
  ], async (fx) => {
    const home = await readAiboardHome(fx.location);
    refuses(() => resolveHomeRuntime(home, `openai:${catalogModel("openai").id}`), "provider_not_configured");
    refuses(() => resolveHomeRuntime(home, `deepseek:${catalogModel("deepseek").id}`), "home_key_missing");
    refuses(() => resolveHomeRuntime(home, `xai:${catalogModel("xai").id}`), "provider_not_configured");
    const chatgptId = `chatgpt:${catalogModel("chatgpt").id}`;
    refuses(() => resolveHomeRuntime(home, chatgptId), "account_peer_required");
    const account = resolveHomeRuntime(home, chatgptId, { accountPeer: PEER }).config;
    assert.equal(account.transport, "account-runner");
    assert.equal(account.baseUrl, PEER.baseUrl);
    assert.ok(account.secret === PEER.token, "the peer's token comes from the launcher, never the home");
    assert.equal(account.billingBasis, "account_not_metered");
    // Enabled-model rule: an account-backed provider counts as keyed while enabled (OD-32).
    assert.deepEqual(listHomeEnabledModels(home).map((model) => model.id), [chatgptId]);
    assert.equal(isHomeModelEnabled(home, `${chatgptId}#high`), true, "a model#effort runtime counts as its model");
  });
});

test("custom models resolve from the home, with the placeholder secret for a keyless endpoint", async () => {
  await withHome([
    { path: "customModels.local-a", op: "set", value: { label: "Local", baseURL: "http://127.0.0.1:11434/v1", model: "gemma", reasoningEffort: "none", createdAt: "2026-11-12T00:00:00.000Z" } },
    { path: "customModels.remote-b", op: "set", value: { label: "Remote", baseURL: "https://gateway.example.test/v1", model: "remote", createdAt: "2026-11-12T00:00:00.000Z" } },
    { path: "credentials.customModels.remote-b", op: "set", value: { secret: STUB_KEY } },
    { path: "settings.modelContextOverrides.custom:local-a", op: "set", value: { contextWindowTokens: 65_536, maxOutputTokens: 32_768 } },
  ], async (fx) => {
    const home = await readAiboardHome(fx.location);
    const local = resolveHomeRuntime(home, "custom:local-a").config;
    assert.equal(local.modelId, "gemma");
    assert.equal(local.transport, "openai-compatible");
    assert.equal(local.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(local.secret, LOCAL_ENDPOINT_PLACEHOLDER_SECRET);
    assert.equal(local.reasoningEffort, "none", "the custom model's own effort when the role names none");
    assert.equal(local.contextWindowTokens, 65_536);
    assert.equal(local.maxOutputTokens, 32_768);
    assert.equal(resolveHomeRuntime(home, "custom:local-a#high").config.reasoningEffort, "high");
    assert.equal(resolveHomeRuntime(home, "custom:local-a", { reasoningEffort: "default" }).config.reasoningEffort, "none");
    assert.ok(resolveHomeRuntime(home, "custom:remote-b").config.secret === STUB_KEY);
    assert.deepEqual(listHomeEnabledModels(home).map((model) => model.id), ["custom:local-a", "custom:remote-b"]);
  });
});

test("model#effort runtimes strip the effort for the model and send it as the reasoning effort", async () => {
  assert.equal(runtimeModelRef("openai:gpt-5.5#high"), "openai:gpt-5.5");
  assert.equal(runtimeModelRef("openai:gpt-5.5"), "openai:gpt-5.5");
  assert.equal(runtimeEffort("openai:gpt-5.5#high"), "high");
  assert.equal(runtimeEffort("openai:gpt-5.5#bogus"), undefined);
  assert.equal(runtimeEffort("#high"), undefined);
  const model = catalogModel("anthropic");
  await withHome([
    { path: "providers.anthropic", op: "set", value: provider() },
    { path: "credentials.providers.anthropic", op: "set", value: { secret: STUB_KEY } },
  ], async (fx) => {
    const home = await readAiboardHome(fx.location);
    const resolved = resolveHomeRuntime(home, `anthropic:${model.id}#high`, { priority: 3 }).config;
    assert.equal(resolved.runtimeId, `anthropic:${model.id}#high`);
    assert.equal(resolved.modelId, model.id);
    assert.equal(resolved.reasoningEffort, "high");
    assert.equal(resolved.priority, 3);
    assert.equal(resolveHomeRuntime(home, `anthropic:${model.id}#default`).config.reasoningEffort, undefined);
    assert.equal(resolveHomeRuntime(home, `anthropic:${model.id}`, { reasoningEffort: "low" }).config.reasoningEffort, "low");
  });
});
