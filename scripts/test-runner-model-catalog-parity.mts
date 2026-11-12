/**
 * Runner model catalog parity (Simple Build plan §9 "The Runner knows models", packet HM2, OD-30).
 * The Runner cannot run web code, so it carries a generated snapshot of the web's model data and ports
 * of the web's model rules. This script fails when either drifts from the web:
 *
 * 1. the committed snapshot equals what the generator builds from lib/providers now, and `--check`
 *    fails on a stale copy;
 * 2. every ported rule in runner-v2/src/home-model-policy.ts equals its web original: reasoning-effort
 *    and max-token support, the model-id migration, pricing (with the account API-equivalent rule) and
 *    context profiles;
 * 3. `resolveHomeRuntime` equals `describeNativeProviderConfig` for every catalog model, custom models and
 *    `model#effort` runtimes, secrets aside, pricing and context included, from one fixture saved to a
 *    real home (homeOpsFromWebState + applyHomeBatch) and to the browser store; and the secretless
 *    push the web sends since HM4a (`createNativeProviderConfig`) resolves, through the Runner's
 *    `resolvePushedConfig`, to that same runtime;
 * 4. `listHomeEnabledModels` equals `getEnabledModels` on fixtures, for providers whose key the home
 *    holds (since HM4a the web lists an enabled row without a browser key; HM4b mirrors the home).
 *
 * Stub keys only: no live provider call is made and no real key appears here.
 *
 *   npx tsx scripts/test-runner-model-catalog-parity.mts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CustomModel, ProviderKey, UserSettings } from "../lib/db/schema";
import { createNativeProviderConfig, describeNativeProviderConfig } from "../lib/client/native-build-engine";
import { getEnabledModels } from "../lib/client/providers";
import { __clearClientStoreForTests, __resetClientStoreForTests } from "../lib/client/store";
import { MODEL_CATALOG } from "../lib/providers/catalog";
import { resolveModelContextProfile as webContextProfile } from "../lib/providers/model-context";
import { migrateFullModelId as webMigrateFullModelId, OPENAI_LEGACY_MODEL_IDS } from "../lib/providers/model-id-migration";
import { getModelPricing as webPricing, MODEL_PRICING } from "../lib/providers/pricing";
import {
  PROVIDER_DEFINITIONS,
  PROVIDER_IDS,
  providerSupportsMaxTokensFeature,
  providerSupportsReasoningEffortFeature,
} from "../lib/providers/provider-registry";
import { buildRunnerModelCatalogSnapshot, renderRunnerModelCatalog, RUNNER_MODEL_CATALOG_PATH, runnerModelCatalogIsCurrent } from "./generate-runner-model-catalog.mts";
import { resolveAiboardHome } from "../runner-v2/src/aiboard-home-paths";
import { applyHomeBatch, homeOpsFromWebState, readAiboardHome } from "../runner-v2/src/aiboard-home-store";
import { MODEL_CATALOG_SNAPSHOT } from "../runner-v2/src/generated/model-catalog";
import {
  getModelPricing as homePricing,
  migrateFullModelId as homeMigrateFullModelId,
  portedFeatureRuleProviders,
  providerSupportsMaxTokens,
  providerSupportsReasoningEffort,
  resolveModelContextProfile as homeContextProfile,
  type DiscoveredMetadataMap,
} from "../runner-v2/src/home-model-policy";
import { listHomeEnabledModels, resolveHomeRuntime, type AccountPeerConnection } from "../runner-v2/src/home-runtime";
import { resolvePushedConfig } from "../runner-v2/src/home-provider-configs";
import type { RunnerProviderConfig } from "../runner-v2/src/provider-config-store";

const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

let checks = 0;
function pass(label: string): void {
  checks += 1;
  console.log(`PASS ${label}`);
}

// ------------------------------------------------------------------ 1. the snapshot

assert.deepEqual(JSON.parse(JSON.stringify(MODEL_CATALOG_SNAPSHOT)), buildRunnerModelCatalogSnapshot(),
  "runner-v2/src/generated/model-catalog.ts differs from lib/providers: run `npx tsx scripts/generate-runner-model-catalog.mts`");
assert.ok(runnerModelCatalogIsCurrent(), "the committed snapshot module is not byte-current");
assert.match(MODEL_CATALOG_SNAPSHOT.catalogVersion, /^[0-9a-f]{16}$/);
assert.equal(MODEL_CATALOG_SNAPSHOT.models.length, MODEL_CATALOG.length);
for (const id of PROVIDER_IDS) {
  const definition = PROVIDER_DEFINITIONS[id];
  const entry = MODEL_CATALOG_SNAPSHOT.providers[id];
  assert.equal(entry.transport, definition.connection.transport, `${id} transport`);
  assert.equal(entry.defaultBaseUrl, definition.connection.defaultBaseUrl, `${id} default base URL`);
}
assert.deepEqual(Object.keys(MODEL_CATALOG_SNAPSHOT.pricing).sort(), Object.keys(MODEL_PRICING).sort());
assert.deepEqual(MODEL_CATALOG_SNAPSHOT.modelIdMigrations.openai, OPENAI_LEGACY_MODEL_IDS);
pass("the snapshot equals the web's catalog, provider registry, pricing, context profiles and renamed ids");

const scratch = mkdtempSync(join(tmpdir(), "aiboard-catalog-parity-"));
try {
  const stale = join(scratch, "model-catalog.ts");
  writeFileSync(stale, renderRunnerModelCatalog().replace(/"catalogVersion": "[0-9a-f]+"/, '"catalogVersion": "0000000000000000"'));
  const staleCheck = spawnSync(process.execPath, [TSX_CLI, "scripts/generate-runner-model-catalog.mts", "--check", "--file", stale], { encoding: "utf8" });
  assert.equal(staleCheck.status, 1, `--check passed a stale file: ${staleCheck.stdout}${staleCheck.stderr}`);
  assert.match(staleCheck.stderr, /stale/);
  writeFileSync(stale, renderRunnerModelCatalog().replace(/\n/g, "\r\n"));
  const crlfCheck = spawnSync(process.execPath, [TSX_CLI, "scripts/generate-runner-model-catalog.mts", "--check", "--file", stale], { encoding: "utf8" });
  assert.equal(crlfCheck.status, 0, `--check failed a current file with CRLF line endings: ${crlfCheck.stderr}`);
  const committed = spawnSync(process.execPath, [TSX_CLI, "scripts/generate-runner-model-catalog.mts", "--check"], { encoding: "utf8" });
  assert.equal(committed.status, 0, committed.stderr);
  pass("`--check` fails on a stale file and passes the committed one (line endings aside)");

  const source = readFileSync(RUNNER_MODEL_CATALOG_PATH, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "the snapshot module imports nothing");
  assert.doesNotMatch(source, /=>|\bfunction\b|\bclass\b/, "the snapshot module is data only");
  pass("the snapshot module is data only");

  // ---------------------------------------------------------------- 2. ported rules

  const ruleProviders = {
    reasoningEffort: PROVIDER_IDS.filter((id) => typeof PROVIDER_DEFINITIONS[id].reasoningEffort === "function").sort(),
    maxTokens: PROVIDER_IDS.filter((id) => typeof PROVIDER_DEFINITIONS[id].maxTokens === "function").sort(),
  };
  assert.deepEqual(portedFeatureRuleProviders(), ruleProviders, "every model-dependent provider rule has a port");
  const sampleModelIds = [
    ...new Set([
      ...MODEL_CATALOG.map((model) => model.id),
      "", "auto", "AUTO", "gpt-6", "gpt-x", "claude-haiku-4-5-20251001", "claude-opus-5", "grok-4-non-reasoning", "grok-4.7",
      "muse-spark-1.3", "Muse-Spark-2", "llama-5", "gemini-3.5-flash", "gemini-3.8-flash", "z-ai/glm-5.2", " spaced ",
    ]),
  ];
  for (const providerId of [...PROVIDER_IDS, "custom", "unknown"]) {
    for (const modelId of sampleModelIds) {
      assert.equal(providerSupportsReasoningEffort(providerId, modelId), providerSupportsReasoningEffortFeature(providerId, modelId), `reasoning effort ${providerId}:${modelId}`);
      assert.equal(providerSupportsMaxTokens(providerId, modelId), providerSupportsMaxTokensFeature(providerId, modelId), `max tokens ${providerId}:${modelId}`);
    }
  }
  pass("reasoning-effort and max-token support equal the provider registry for every provider and sample model");

  const migrationSamples = [
    ...Object.keys(OPENAI_LEGACY_MODEL_IDS).flatMap((id) => [`openai:${id}`, `chatgpt:${id}`, id]),
    "openai:gpt-5.6-sol", "openai:unknown", "malformed", ":gpt-5.6", "openai:", "openai:gpt-5.6#high",
  ];
  for (const id of migrationSamples) assert.equal(homeMigrateFullModelId(id), webMigrateFullModelId(id), `migrate ${id}`);
  pass("migrateFullModelId equals the web's");

  // One fixture for every rule below. Stub values only.
  const anthropicPriced = Object.keys(MODEL_PRICING).find((id) => id.startsWith("anthropic:"))!;
  const settings = {
    modelPricingOverrides: {
      "openai:gpt-5.5": { inputUsdPer1M: 3, outputUsdPer1M: 9, cachedInputUsdPer1M: null, updatedAt: "2026-11-01T00:00:00.000Z" },
      "chatgpt:gpt-5.5": { inputUsdPer1M: 1.5, outputUsdPer1M: 4, updatedAt: "2026-11-02T00:00:00.000Z" },
      "custom:remote-b": { inputUsdPer1M: 0.5, outputUsdPer1M: 1, cachedInputUsdPer1M: 0.05, updatedAt: "2026-11-03T00:00:00.000Z" },
    },
    modelContextOverrides: {
      "anthropic:*": { maxOutputTokens: 20_000 },
      "custom:local-a": { contextWindowTokens: 65_536, maxOutputTokens: 32_768 },
      "openai:gpt-5.4": { contextWindowTokens: 3_000_000, buildOutputReserveTokens: 1 },
      "xai:*": { longContextQuality: "poor", recommendedBuildRoles: ["worker", "bogus", "worker"] },
    },
    discoveredModelMetadata: {
      "openrouter:qwen/qwen3-coder": {
        contextWindowTokens: 262_144, maxOutputTokens: 65_536, inputUsdPer1M: 0.2, outputUsdPer1M: 0.8, cachedInputUsdPer1M: 0.02,
        image: true, document: false, reportedFields: ["contextWindowTokens", "maxOutputTokens", "inputUsdPer1M", "outputUsdPer1M", "cachedInputUsdPer1M", "image", "document"],
        source: "openrouter-models", updatedAt: "2026-11-04T10:00:00.000Z",
      },
      "openai:gpt-future-1": {
        reportedFields: ["contextWindowTokens"], contextWindowTokens: 400_000,
        supplemental: { source: "models.dev", fetchedAt: "2026-11-05T00:00:00.000Z", values: { inputUsdPer1M: 1, outputUsdPer1M: 4 } },
      },
      "github-copilot:claude-sonnet-x": {
        apiEquivalentPricing: { modelId: anthropicPriced, source: "models.dev", fetchedAt: "2026-11-06T00:00:00.000Z", values: {} },
        overrides: { outputUsdPer1M: 11 },
      },
      "xai:grok-4.7": { reportedFields: [] },
    },
    providerToolCapabilityEvidence: [
      { providerId: "openrouter", modelId: "qwen/qwen3-coder", capabilityId: "function_calling", support: "supported", source: "catalog", expiresAt: "2999-01-01T00:00:00.000Z" },
      { providerId: "openrouter", modelId: "z-ai/glm-5.2", capabilityId: "function_calling", support: "unsupported", source: "catalog", expiresAt: "2000-01-01T00:00:00.000Z" },
      { providerId: "openrouter", modelId: "minimax/minimax-m3", capabilityId: "function_calling", support: "unsupported", source: "catalog" },
      { providerId: "openrouter", capabilityId: "web_search", support: "supported", source: "catalog" },
    ],
  } satisfies Partial<UserSettings> & Record<string, unknown>;
  const discovered = settings.discoveredModelMetadata as unknown as DiscoveredMetadataMap;

  const pricingIds = [...new Set([
    ...MODEL_CATALOG.map((model) => `${model.providerId}:${model.id}`),
    ...Object.keys(MODEL_PRICING),
    ...Object.keys(settings.modelPricingOverrides),
    ...Object.keys(settings.discoveredModelMetadata),
    "chatgpt:gpt-unknown", "github-copilot:gpt-5.5", "github-copilot:gemini-x", "custom:local-a",
  ])];
  for (const id of pricingIds) {
    assert.deepEqual(homePricing(id, settings.modelPricingOverrides, discovered), webPricing(id, settings.modelPricingOverrides, settings.discoveredModelMetadata as never), `pricing ${id}`);
    assert.deepEqual(homePricing(id), webPricing(id), `pricing without settings ${id}`);
  }
  pass(`pricing equals getModelPricing for ${pricingIds.length} models, account API-equivalent pricing included`);

  for (const id of [...pricingIds, "anthropic:claude-new", "custom:anything", "nvidia:z-ai/glm-5.2", "unknown:model", " openai : gpt-5.5 "]) {
    const separator = id.indexOf(":");
    const providerId = id.slice(0, separator), modelId = id.slice(separator + 1);
    assert.deepEqual(homeContextProfile(modelId, providerId, settings.modelContextOverrides as never, discovered),
      webContextProfile(modelId, providerId, settings.modelContextOverrides as never, settings.discoveredModelMetadata as never), `context ${id}`);
    assert.deepEqual(homeContextProfile(modelId, providerId), webContextProfile(modelId, providerId), `context without settings ${id}`);
  }
  pass("context profiles equal resolveModelContextProfile, overrides and discovered metadata included");

  // ---------------------------------------------------------------- 3 and 4. the home against the browser store

  const PEER: AccountPeerConnection = { baseUrl: "http://127.0.0.1:1455", token: "stub-peer-token" };
  const now = "2026-11-12T00:00:00.000Z";
  const row = (providerId: string, patch: Partial<ProviderKey> = {}): ProviderKey => ({
    providerId, apiKey: `stub-key-${providerId}`, baseURL: null, runnerToken: null, models: [], enabledModelIds: null,
    defaultModel: null, enabled: true, keyHint: "stub", lastValidationSucceeded: null, lastValidatedAt: null, updatedAt: now, ...patch,
  });
  const accountRow = (providerId: string, patch: Partial<ProviderKey> = {}) => row(providerId, { apiKey: PEER.token, baseURL: PEER.baseUrl, ...patch });
  const customModels: CustomModel[] = [
    { id: "local-a", label: "Local A", baseURL: "http://127.0.0.1:11434/v1", model: "gemma-local", hasKey: false, reasoningEffort: "none",
      capabilities: { image: true, document: false, audio: false, video: false }, createdAt: now },
    { id: "remote-b", label: "Remote B", baseURL: "https://gateway.example.test/v1", model: "remote-model", apiKey: "stub-key-custom", hasKey: true,
      reasoningEffort: "high", createdAt: now },
  ];

  interface Scenario { name: string; providerKeys: ProviderKey[]; customModels: CustomModel[] }
  const allCatalogIds = (providerId: string) => MODEL_CATALOG.filter((model) => model.providerId === providerId).map((model) => model.id);
  const scenarios: Scenario[] = [
    {
      name: "every provider keyed, every catalog model listed",
      providerKeys: [
        row("openai", { models: ["gpt-future-1"], defaultModel: "gpt-5.5", enabledModelIds: null }),
        row("deepseek", { enabledModelIds: allCatalogIds("deepseek") }),
        row("anthropic", { enabledModelIds: [...allCatalogIds("anthropic"), "claude-new"] }),
        row("foundry", { baseURL: "https://stub-resource.services.ai.azure.com/anthropic/", models: ["claude-opus-4-5", "foundry:claude-sonnet-4-5", " "] }),
        row("google", { enabledModelIds: allCatalogIds("google") }),
        row("openrouter", { enabledModelIds: [...allCatalogIds("openrouter"), "qwen/qwen3-coder", "openrouter:z-ai/glm-5.2", "minimax/minimax-m3"] }),
        row("xai", { models: allCatalogIds("xai"), enabledModelIds: null }),
        row("meta", { enabledModelIds: allCatalogIds("meta") }),
        accountRow("chatgpt", { enabledModelIds: [...allCatalogIds("chatgpt"), "gpt-unknown"] }),
        accountRow("github-copilot", { enabledModelIds: [...allCatalogIds("github-copilot"), "claude-sonnet-x"] }),
        // No runner token: the web resolves NVIDIA directly too, from the registry's default (OD-32).
        row("nvidia", { models: ["z-ai/glm-5.2", "nvidia/nemotron-3-ultra-550b-a55b"], enabledModelIds: null }),
      ],
      customModels,
    },
    {
      name: "disabled, keyless and filtered providers",
      providerKeys: [
        row("openai", { enabled: false, models: ["gpt-5.5"], defaultModel: "gpt-5.5" }),
        row("anthropic", { apiKey: undefined, enabledModelIds: ["claude-opus-5"] }),
        row("openrouter", { enabledModelIds: [] }),
        row("deepseek", { models: ["deepseek-flash", "deepseek-flash", "deepseek:deepseek-v4-pro"], enabledModelIds: ["deepseek-v4-pro", "deepseek-extra"], defaultModel: "deepseek-default" }),
        row("google", { models: ["gemini-3.8-flash"], enabledModelIds: ["gemini-other"] }),
        row("foundry", { baseURL: "https://stub-resource.services.ai.azure.com/anthropic/", models: ["dup", "dup", ""], enabledModelIds: ["dup"] }),
        accountRow("chatgpt", { enabled: false, defaultModel: "gpt-5.5" }),
        accountRow("github-copilot", { models: ["auto"], enabledModelIds: null }),
      ],
      customModels: [],
    },
    { name: "an empty home", providerKeys: [], customModels: [] },
  ];

  let homeIndex = 0;
  async function saveToHome(scenario: Scenario) {
    homeIndex += 1;
    const root = join(scratch, `home-${homeIndex}`);
    const userHome = join(root, "user");
    mkdirSync(userHome, { recursive: true });
    const environment = { AIBOARD_HOME: join(root, "home"), LOCALAPPDATA: join(root, "local"), XDG_DATA_HOME: join(root, "data") };
    const location = resolveAiboardHome({ platform: process.platform, environment, home: userHome });
    const ops = homeOpsFromWebState({
      settings: settings as unknown as Record<string, unknown>,
      // Account-backed providers keep no credential in the home (OD-32): their token is the launcher's.
      providerKeys: scenario.providerKeys.map((key) => (PROVIDER_DEFINITIONS[key.providerId as keyof typeof PROVIDER_DEFINITIONS] as { accountRunner?: unknown }).accountRunner
        ? { ...key, apiKey: undefined } : key) as unknown as Record<string, unknown>[],
      customModels: scenario.customModels as unknown as Record<string, unknown>[],
    });
    if (ops.length > 0) await applyHomeBatch(location, { baseRevision: 0, ops });
    return await readAiboardHome(location);
  }

  for (const scenario of scenarios) {
    __resetClientStoreForTests({ providerKeys: scenario.providerKeys, customModels: scenario.customModels, userSettings: settings as never });
    const home = await saveToHome(scenario);
    // The home lists a provider only with a key in the home; the web (HM4a) holds no key and lists
    // every enabled row. Account-backed providers need no key in either.
    const homeKeyed = (providerId: string) => providerId === "custom" ||
      Boolean((PROVIDER_DEFINITIONS[providerId as keyof typeof PROVIDER_DEFINITIONS] as { accountRunner?: unknown }).accountRunner) ||
      Boolean(scenario.providerKeys.find((key) => key.providerId === providerId)?.apiKey);
    const web = getEnabledModels().filter((model) => homeKeyed(model.providerId)).map((model) => `${model.providerId}:${model.id}`);
    assert.deepEqual(listHomeEnabledModels(home).map((model) => model.id), web, `enabled models: ${scenario.name}`);
  }
  pass(`listHomeEnabledModels equals getEnabledModels on ${scenarios.length} fixtures, for providers keyed in the home`);
  {
    const keyless = scenarios[1]!;
    __resetClientStoreForTests({ providerKeys: keyless.providerKeys, customModels: keyless.customModels, userSettings: settings as never });
    assert.ok(getEnabledModels().some((model) => model.providerId === "anthropic"), "an enabled row lists its models with no key in the browser (HM4a)");
    pass("the web lists an enabled provider with no browser key (the key lives in the home)");
  }

  const main = scenarios[0]!;
  __resetClientStoreForTests({ providerKeys: main.providerKeys, customModels: main.customModels, userSettings: settings as never });
  const home = await saveToHome(main);
  const runtimeIds = [
    ...MODEL_CATALOG.map((model) => `${model.providerId}:${model.id}`),
    "openai:gpt-future-1", "anthropic:claude-new", "openrouter:qwen/qwen3-coder", "openrouter:z-ai/glm-5.2", "openrouter:minimax/minimax-m3",
    "foundry:claude-opus-4-5", "nvidia:z-ai/glm-5.2", "chatgpt:gpt-unknown", "github-copilot:claude-sonnet-x",
    "custom:local-a", "custom:remote-b",
    `${MODEL_CATALOG[0]!.providerId}:${MODEL_CATALOG[0]!.id}#high`, "anthropic:claude-new#low", "custom:local-a#medium", "custom:remote-b#default",
    "openrouter:qwen/qwen3-coder#xhigh", "chatgpt:gpt-5.5#max",
  ];
  const nowMs = Date.now();
  const accountPeer = { url: PEER.baseUrl, token: PEER.token };
  for (const [index, runtimeId] of runtimeIds.entries()) {
    const effort = /#([a-z]+)$/.exec(runtimeId)?.[1];
    const web = { ...describeNativeProviderConfig(runtimeId, index, effort, { accountPeer }) } as Record<string, unknown>;
    const resolved = resolveHomeRuntime(home, runtimeId, { priority: index, accountPeer: PEER, nowMs });
    const runner = { ...resolved.config } as Record<string, unknown>;
    // Account-backed runtimes carry the launcher peer's token on both sides; the web holds no other key.
    if (web.transport === "account-runner") {
      assert.ok(web.secret === runner.secret && web.secret === PEER.token, `the peer token of ${runtimeId} differs (values not printed)`);
      assert.ok(web.runnerToken === runner.runnerToken, `the runner token of ${runtimeId} differs (values not printed)`);
    } else {
      assert.equal(web.secret, undefined, `${runtimeId}: the web describes no key`);
      assert.equal(web.runnerToken, undefined, `${runtimeId}: the web describes no runner token`);
    }
    delete web.secret; delete runner.secret; delete web.runnerToken; delete runner.runnerToken;
    assert.deepEqual(runner, web, `resolveHomeRuntime(${runtimeId})`);

    // The push itself (HM4a): no key, and the Runner resolves it to the same runtime.
    const pushed = createNativeProviderConfig(runtimeId, index, effort, { accountPeer }) as unknown as RunnerProviderConfig;
    if (pushed.transport === "account-runner") {
      assert.ok(pushed.secret === PEER.token && pushed.baseUrl === PEER.baseUrl, `${runtimeId}: an account push carries only the launcher peer`);
      continue;
    }
    assert.equal(pushed.secret, undefined, `${runtimeId}: the push carries no secret`);
    assert.equal(pushed.runnerToken, undefined, `${runtimeId}: the push carries no runner token`);
    assert.equal(pushed.baseUrl, undefined, `${runtimeId}: the push leaves the base URL to the home`);
    assert.equal(pushed.secretSource, "home", `${runtimeId}: the push names the home as its key source`);
    const filled = { ...resolvePushedConfig(home, pushed) } as Record<string, unknown>;
    assert.equal(filled.secret, "");
    assert.equal(filled.secretSource, "home");
    delete filled.secret; delete filled.secretSource;
    assert.deepEqual(filled, runner, `resolvePushedConfig(${runtimeId})`);
  }
  pass(`resolveHomeRuntime equals describeNativeProviderConfig for ${runtimeIds.length} runtimes (every catalog model, custom models, model#effort), secrets aside, and each secretless push resolves to it`);

  // NVIDIA (OD-32): the web, like the home, calls NVIDIA's API directly; a saved peer URL and runner token
  // from before HM4a are ignored.
  __resetClientStoreForTests({ providerKeys: [row("nvidia", { baseURL: PEER.baseUrl, runnerToken: "stub-runner-token", models: ["z-ai/glm-5.2"] })], userSettings: settings as never });
  const nvidia = describeNativeProviderConfig("nvidia:z-ai/glm-5.2", 0);
  assert.equal(nvidia.transport, "openai-compatible");
  assert.equal(nvidia.secret, undefined);
  assert.equal(createNativeProviderConfig("nvidia:z-ai/glm-5.2", 0).runnerToken, undefined);
  assert.equal(resolveHomeRuntime(home, "nvidia:z-ai/glm-5.2").config.baseUrl, PROVIDER_DEFINITIONS.nvidia.connection.defaultBaseUrl);
  pass("NVIDIA: the web and the home both call the provider directly (OD-32); no account peer");
} finally {
  __clearClientStoreForTests();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`PASS runner model catalog parity (${checks} checks, catalogVersion ${MODEL_CATALOG_SNAPSHOT.catalogVersion})`);
