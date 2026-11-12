import { MODEL_CATALOG_SNAPSHOT } from "./generated/model-catalog.js";
import type { AiboardHomeConfigV1, AiboardHomeSnapshot, HomeCustomModelV1, HomeProviderV1 } from "./aiboard-home-store.js";
import {
  CUSTOM_PROVIDER_ID,
  formatFullModelId,
  getModelPricing,
  normalizeProviderModelId,
  openRouterSupportsFunctionTools,
  parseFullModelId,
  persistedCapabilityEvidence,
  pricingMicros,
  resolveModelContextProfile,
  runtimeEffort,
  runtimeModelRef,
  snapshotCatalogModel,
  snapshotProvider,
  snapshotProviderIds,
  type CapabilityEvidence,
  type DiscoveredMetadataMap,
  type ModelContextOverrides,
  type ModelPricingOverride,
  type SnapshotProvider,
} from "./home-model-policy.js";
import type { ProviderBillingBasis, RunnerProviderConfig } from "./provider-config-store.js";

/**
 * Model ids and runtime configs from the AIBoard home (Simple Build plan §9 "The Runner knows models",
 * packet HM2). `resolveHomeRuntime` is the Runner's port of the web's `createNativeProviderConfig`
 * (lib/client/native-build-engine.ts) and `listHomeEnabledModels` of `getEnabledModels`
 * (lib/client/providers.ts); scripts/test-runner-model-catalog-parity.mts keeps each equal to its original.
 *
 * Where the home differs from the web on purpose:
 * - The model-id rules (§9 "Model ids"): an unknown provider is refused; a discovering provider's id
 *   that the snapshot lacks is accepted with a warning; Azure AI Foundry does not discover, so its id
 *   must be one of the user's deployments.
 * - A provider whose base URL is required (Azure AI Foundry) is refused without one, where the web
 *   would leave the Anthropic adapter on its default host with the Foundry key.
 * - NVIDIA NIM is called directly over its OpenAI-compatible API (OD-32); the web still reaches it
 *   through the account peer until HM4a.
 * - Account-backed providers (ChatGPT, Copilot) take no credential from the home: their peer's address
 *   and token change with every launch and come from the launcher (`accountPeer`, OD-32).
 */

/** Only the parts of a home read the resolver needs, so fixtures can stand in for a real read. */
export type HomeModelSource = Pick<AiboardHomeSnapshot, "config" | "secret">;

export type HomeModelErrorCode =
  | "unknown_provider"
  | "model_not_configured"
  | "provider_not_configured"
  | "home_key_missing"
  | "base_url_required"
  | "account_peer_required";

export class HomeModelError extends Error {
  constructor(readonly code: HomeModelErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "HomeModelError";
  }
}

export interface HomeModelWarning {
  code: "model_not_in_catalog";
  message: string;
}

export interface HomeModelIdCheck {
  providerId: string;
  modelId: string;
  /** The snapshot's catalog has this model (always false for custom models). */
  inCatalog: boolean;
  warnings: HomeModelWarning[];
}

/** The account peer the launcher started (OD-32): its address and session token, never saved in the home. */
export interface AccountPeerConnection {
  baseUrl: string;
  token: string;
}

export interface ResolveHomeRuntimeOptions {
  priority?: number;
  /** The role's reasoning effort; defaults to the effort a `model#effort` runtime id names. */
  reasoningEffort?: string | null;
  /** Required for account-backed providers; ignored for every other provider. */
  accountPeer?: AccountPeerConnection;
  /** For capability-evidence expiry; tests pin it. */
  nowMs?: number;
}

export interface HomeRuntimeResolution {
  config: RunnerProviderConfig;
  warnings: HomeModelWarning[];
}

/** The web's placeholder for a custom endpoint that needs no key (native-build-engine.ts). */
export const LOCAL_ENDPOINT_PLACEHOLDER_SECRET = "aiboard-local-endpoint";

const TEXT_ONLY = { image: false, document: false, audio: false, video: false } as const;

// ------------------------------------------------------------------ home accessors

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerEntry(config: AiboardHomeConfigV1, providerId: string): HomeProviderV1 | undefined {
  const entry = Object.hasOwn(config.providers, providerId) ? config.providers[providerId] : undefined;
  return isRecord(entry) ? entry : undefined;
}

function customModel(config: AiboardHomeConfigV1, id: string): HomeCustomModelV1 | undefined {
  return config.customModels.find((entry) => entry.id === id);
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function settingsRecord<T>(config: AiboardHomeConfigV1, field: string): Record<string, T> | undefined {
  const value = config.settings[field];
  return isRecord(value) ? value as Record<string, T> : undefined;
}

function capabilityEvidence(config: AiboardHomeConfigV1): CapabilityEvidence[] {
  const value = config.settings.providerToolCapabilityEvidence;
  return Array.isArray(value) ? value.filter((item): item is CapabilityEvidence => isRecord(item) && typeof item.providerId === "string") : [];
}

function providerSecret(home: HomeModelSource, providerId: string): string | undefined {
  return home.secret(`credentials.providers.${providerId}`);
}

/**
 * Whether a provider counts as having a key, as `getDecryptedApiKey` decides for the web: enabled, with
 * a key bound to its current upstream. An account-backed provider has no key in the home (OD-32): it
 * counts as keyed while enabled, because the launcher supplies its peer's token at call time.
 */
export function homeProviderHasKey(home: HomeModelSource, providerId: string): boolean {
  const entry = providerEntry(home.config, providerId);
  if (entry?.enabled !== true) return false;
  if (snapshotProvider(providerId)?.accountBacked) return true;
  return providerSecret(home, providerId) !== undefined;
}

/**
 * Where a provider's requests go: its saved base URL, else the snapshot's default (§9 "Upstream").
 * Null when it has neither (Azure AI Foundry without an endpoint; account-backed providers, whose peer
 * the launcher names). Keys saved with no base URL stay bound to HM1's `default:<providerId>` sentinel:
 * the sentinel means "this provider's default upstream", which this function resolves.
 */
export function homeProviderUpstream(config: AiboardHomeConfigV1, providerId: string): string | null {
  const provider = snapshotProvider(providerId);
  if (!provider || provider.accountBacked) return null;
  const baseUrl = providerEntry(config, providerId)?.baseUrl;
  if (typeof baseUrl === "string" && baseUrl) return baseUrl;
  return provider.defaultBaseUrl;
}

// ------------------------------------------------------------------ enabled models

export interface HomeEnabledModel {
  /** The full id, `providerId:modelId` (`custom:<id>` for a custom model). */
  id: string;
  providerId: string;
  modelId: string;
}

/**
 * The models a provider lists before its `enabledModelIds` filter (lib/client/providers.ts
 * `listProviderModelInfos`), as ids; [] for an unknown provider.
 */
export function listHomeProviderModelIds(config: AiboardHomeConfigV1, providerId: string): string[] {
  const provider = snapshotProvider(providerId);
  return provider ? providerModelIds(config, providerId, provider) : [];
}

function providerModelIds(config: AiboardHomeConfigV1, providerId: string, provider: SnapshotProvider): string[] {
  const entry = providerEntry(config, providerId);
  if (provider.modelSource === "user-defined" && provider.modelDiscovery === null) {
    // Azure AI Foundry: the user's deployments (`listFoundryModelInfos`).
    return (stringList(entry?.models) ?? [])
      .map((id) => normalizeProviderModelId(providerId, id))
      .filter((id) => id.length > 0);
  }
  const hasDiscovery = provider.modelDiscovery !== null;
  const catalogIds = hasDiscovery ? [] : catalogModelIds(providerId);
  const known = new Set(catalogIds);
  const defaultModel = typeof entry?.defaultModel === "string" ? entry.defaultModel : null;
  const configured = [...new Set([
    ...(stringList(entry?.models) ?? []),
    ...(hasDiscovery ? stringList(entry?.enabledModelIds) ?? [] : []),
    ...(hasDiscovery && defaultModel ? [defaultModel] : []),
  ])];
  const additions = configured
    .map((id) => normalizeProviderModelId(providerId, id))
    .filter((id, index, all) => id.length > 0 && !known.has(id) && all.indexOf(id) === index);
  return [...catalogIds, ...additions];
}

function catalogModelIds(providerId: string): string[] {
  return MODEL_CATALOG_SNAPSHOT.models.filter((entry) => entry.providerId === providerId).map((entry) => entry.id);
}

/**
 * Every model the home enables, in the web's order (`getEnabledModels`): for each keyed provider its
 * listed models, filtered by `enabledModelIds` when that is set, then every custom model.
 */
export function listHomeEnabledModels(home: HomeModelSource): HomeEnabledModel[] {
  const models: HomeEnabledModel[] = [];
  for (const providerId of snapshotProviderIds()) {
    if (!homeProviderHasKey(home, providerId)) continue;
    const provider = snapshotProvider(providerId)!;
    const ids = providerModelIds(home.config, providerId, provider);
    const configured = stringList(providerEntry(home.config, providerId)?.enabledModelIds);
    const enabled = configured === null ? ids : ids.filter((id) => new Set(configured).has(id));
    for (const modelId of enabled) models.push({ id: formatFullModelId(providerId, modelId), providerId, modelId });
  }
  for (const model of home.config.customModels) {
    models.push({ id: formatFullModelId(CUSTOM_PROVIDER_ID, model.id), providerId: CUSTOM_PROVIDER_ID, modelId: model.id });
  }
  return models;
}

/** The web's enabled-model rule (`getEnabledModels`) for one model id; a `model#effort` id counts as its model. */
export function isHomeModelEnabled(home: HomeModelSource, modelId: string): boolean {
  const ref = runtimeModelRef(modelId);
  return listHomeEnabledModels(home).some((model) => model.id === ref);
}

// ------------------------------------------------------------------ model-id rules

/**
 * The model-id rules of §9: an id with an unknown provider is refused (`unknown_provider`); a custom
 * model must exist in the home; Azure AI Foundry does not discover its models, so its id must be one
 * of the user's deployments (`model_not_configured`); for every other provider an id the snapshot lacks
 * is accepted with a `model_not_in_catalog` warning, because their models are discovered and often
 * newer than the catalog.
 */
export function checkHomeModelId(config: AiboardHomeConfigV1, modelId: string): HomeModelIdCheck {
  const ref = runtimeModelRef(modelId);
  const { providerId, model } = parseFullModelId(ref);
  if (!model) throw new HomeModelError("unknown_provider", `${modelId} is not a model id of the form provider:model.`);
  if (providerId === CUSTOM_PROVIDER_ID) {
    if (!customModel(config, model)) throw new HomeModelError("model_not_configured", `Custom model ${model} is not configured.`);
    return { providerId, modelId: model, inCatalog: false, warnings: [] };
  }
  const provider = snapshotProvider(providerId);
  if (!provider) throw new HomeModelError("unknown_provider", `${providerId} is not a provider AI Board knows.`);
  const inCatalog = snapshotCatalogModel(providerId, model) !== undefined;
  if (inCatalog) return { providerId, modelId: model, inCatalog, warnings: [] };
  if (provider.modelDiscovery === null) {
    const deployments = (stringList(providerEntry(config, providerId)?.models) ?? []).map((id) => normalizeProviderModelId(providerId, id));
    if (!deployments.includes(model)) {
      throw new HomeModelError("model_not_configured", `${provider.name} does not list its models, so ${model} must be one of the model ids saved for it.`);
    }
    return { providerId, modelId: model, inCatalog, warnings: [] };
  }
  return {
    providerId,
    modelId: model,
    inCatalog,
    warnings: [{
      code: "model_not_in_catalog",
      message: `${ref} is not in AI Board's model catalog; it is used as given, with pricing and context from your settings or the ${provider.name} defaults.`,
    }],
  };
}

// ------------------------------------------------------------------ runtime configs

function billingBasis(pricing: ReturnType<typeof pricingMicros>, accountSubscription: boolean): ProviderBillingBasis {
  if (accountSubscription) return "account_not_metered";
  return pricing.inputCostMicrosPerMillion !== undefined && pricing.outputCostMicrosPerMillion !== undefined ? "api_priced" : "unknown";
}

function inputCapabilities(capabilities: Record<string, unknown> | undefined): NonNullable<RunnerProviderConfig["inputCapabilities"]> {
  return {
    image: capabilities?.image === true,
    document: capabilities?.document === true,
    audio: capabilities?.audio === true,
    video: capabilities?.video === true,
  };
}

function contextWindow(profileTokens: number): { contextWindowTokens?: number } {
  return Number.isSafeInteger(profileTokens) && profileTokens > 0 ? { contextWindowTokens: profileTokens } : {};
}

/**
 * Builds the `RunnerProviderConfig` for a runtime id (`provider:model`, `custom:<id>`, or either with
 * `#effort`) from the home and the catalog snapshot, as `createNativeProviderConfig` does from the
 * browser store: pricing (with overrides, discovered metadata and the account API-equivalent rule),
 * context window and output limit, input capabilities, OpenRouter's tool support, the transport, base
 * URL and protocol, and the secret from the home's credentials. Throws `HomeModelError`.
 */
export function resolveHomeRuntime(home: HomeModelSource, runtimeId: string, options: ResolveHomeRuntimeOptions = {}): HomeRuntimeResolution {
  const config = home.config;
  const check = checkHomeModelId(config, runtimeId);
  const modelRef = runtimeModelRef(runtimeId);
  const { providerId, modelId: model } = check;
  const priority = options.priority ?? 0;
  const requestedEffort = options.reasoningEffort === undefined ? runtimeEffort(runtimeId) : options.reasoningEffort ?? undefined;
  const pricingOverrides = settingsRecord<ModelPricingOverride>(config, "modelPricingOverrides");
  const contextOverrides = settingsRecord<ModelContextOverrides[string]>(config, "modelContextOverrides");
  const discovered = settingsRecord<DiscoveredMetadataMap[string]>(config, "discoveredModelMetadata") as DiscoveredMetadataMap | undefined;
  const pricing = pricingMicros(getModelPricing(modelRef, pricingOverrides, discovered));
  const profile = resolveModelContextProfile(model, providerId, contextOverrides, discovered);

  if (providerId === CUSTOM_PROVIDER_ID) {
    const custom = customModel(config, model)!;
    const effort = requestedEffort && requestedEffort !== "default" ? requestedEffort : custom.reasoningEffort;
    return {
      warnings: check.warnings,
      config: {
        runtimeId,
        providerId,
        modelId: custom.model,
        displayName: custom.label,
        billingBasis: billingBasis(pricing, false),
        transport: "openai-compatible",
        baseUrl: custom.baseURL,
        secret: home.secret(`credentials.customModels.${model}`) || LOCAL_ENDPOINT_PLACEHOLDER_SECRET,
        ...(effort && effort !== "default" ? { reasoningEffort: effort } : {}),
        maxOutputTokens: profile.maxOutputTokens,
        capabilities: ["*"],
        inputCapabilities: inputCapabilities(custom.capabilities),
        priority,
        ...pricing,
        ...contextWindow(profile.contextWindowTokens),
      },
    };
  }

  const provider = snapshotProvider(providerId)!;
  const entry = providerEntry(config, providerId);
  if (entry?.enabled !== true) throw new HomeModelError("provider_not_configured", `${provider.name} is not enabled in the AIBoard home.`);
  const savedBaseUrl = typeof entry.baseUrl === "string" && entry.baseUrl ? entry.baseUrl : undefined;
  let connection: Pick<RunnerProviderConfig, "transport" | "baseUrl" | "secret">;
  if (provider.accountBacked) {
    if (!options.accountPeer) {
      throw new HomeModelError("account_peer_required", `${provider.name} runs through the account runner, which only a plain \`aiboard\` start launches.`);
    }
    connection = { transport: "account-runner", baseUrl: options.accountPeer.baseUrl, secret: options.accountPeer.token };
  } else {
    const secret = providerSecret(home, providerId);
    if (secret === undefined) throw new HomeModelError("home_key_missing", `The AIBoard home has no key for ${provider.name}; set one with \`aiboard keys set ${providerId}\` or in Settings.`);
    // A provider with no default upstream (Azure AI Foundry) is the user's own endpoint.
    if (provider.defaultBaseUrl === null && !savedBaseUrl) throw new HomeModelError("base_url_required", `${provider.name} needs its endpoint base URL in the AIBoard home.`);
    if (provider.transport === "anthropic" || provider.transport === "google") {
      // The Runner's adapters default to the provider's host; a config names a base URL only when one is saved.
      connection = { transport: provider.transport, ...(savedBaseUrl ? { baseUrl: savedBaseUrl } : {}), secret };
    } else {
      const baseUrl = savedBaseUrl ?? provider.defaultBaseUrl ?? undefined;
      if (!baseUrl) throw new HomeModelError("base_url_required", `${provider.name} needs an OpenAI-compatible base URL.`);
      connection = { transport: "openai-compatible", baseUrl, secret };
    }
  }

  const catalogModel = snapshotCatalogModel(providerId, model);
  const discoveredMetadata = discovered?.[modelRef] ?? null;
  const capabilities = (discoveredMetadata ?? catalogModel?.capabilities ?? TEXT_ONLY) as Record<string, unknown>;
  const nowMs = options.nowMs ?? Date.now();
  return {
    warnings: check.warnings,
    config: {
      runtimeId,
      providerId,
      modelId: model,
      ...(catalogModel?.name ? { displayName: catalogModel.name } : {}),
      billingBasis: billingBasis(pricing, provider.accountBacked),
      transport: connection.transport,
      ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      secret: connection.secret,
      capabilities: ["*"],
      inputCapabilities: inputCapabilities(capabilities),
      ...(providerId === "openrouter"
        ? {
            supportsTools: openRouterSupportsFunctionTools(model, persistedCapabilityEvidence(capabilityEvidence(config), providerId, model, nowMs)),
            hostedTools: [{ type: "web_search" as const }, { type: "web_fetch" as const }, { type: "datetime" as const }],
          }
        : {}),
      priority,
      ...pricing,
      ...contextWindow(profile.contextWindowTokens),
      ...(requestedEffort && requestedEffort !== "default" ? { reasoningEffort: requestedEffort } : {}),
      ...(connection.transport === "openai-compatible" ? { protocol: provider.protocol ?? "chat-completions" } : {}),
    },
  };
}
