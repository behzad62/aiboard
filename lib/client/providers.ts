/**
 * Browser-safe provider registry + key/model resolution, reading from the
 * client store. Mirrors lib/providers/index.ts + the custom provider, but
 * without the Node-only crypto/fs imports.
 */

import type {
  AIProvider,
  ChatParams,
  ModelCapabilities,
  ModelInfo,
  StreamChunk,
} from "@/lib/providers/base";
import { formatModelId, parseModelId } from "@/lib/providers/base";
import {
  resolveModelContextProfile,
  type DiscoveredModelContextMap,
  type ModelContextOverrides,
} from "@/lib/providers/model-context";
import { openaiProvider, streamOpenAIResponses } from "@/lib/providers/openai";
import { deepseekProvider } from "@/lib/providers/deepseek";
import { anthropicProvider } from "@/lib/providers/anthropic";
import { foundryProvider } from "@/lib/providers/foundry";
import { googleProvider } from "@/lib/providers/google";
import { openrouterProvider } from "@/lib/providers/openrouter";
import { xaiProvider } from "@/lib/providers/xai";
import { metaProvider } from "@/lib/providers/meta";
import { chatgptProvider } from "@/lib/providers/chatgpt";
import { githubCopilotProvider } from "@/lib/providers/github-copilot";
import { nvidiaProvider } from "@/lib/providers/nvidia";
import { getModelDisplayName } from "@/lib/providers/catalog";
import { getProviderDefinition } from "@/lib/providers/provider-registry";
import { effectiveModelMetadata } from "@/lib/providers/model-metadata";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/constants";
import { streamOpenAICompatibleChat } from "@/lib/providers/openai-compat";
import {
  connectionFromParams,
  connectionParams,
  createOpenAIClient,
  MODEL_PROXY_PATH_PREFIX,
  type ProviderConnection,
} from "@/lib/providers/connection";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "@/lib/providers/openrouter";
import {
  CONNECT_AI_BOARD_MESSAGE,
  ModelConnectionError,
  modelProxyClient,
} from "./model-proxy-client";
import { customCompatibleTransports } from "@/lib/providers/custom-capabilities";
import { getPeerConnection } from "./local-runner-handoff";
import type { CustomModel } from "@/lib/db/schema";
import type {
  CapabilityEvidence,
  ProviderTransportId,
} from "@/lib/providers/tool-capabilities";
import {
  ACCOUNT_RUNNER_CAPABILITY_MINIMUM_VERSION,
  getCachedAccountRunnerCapabilities,
} from "@/lib/providers/account-runner";
import {
  runnerCapabilityEvidence,
  type RunnerCapabilityProviderId,
  type RunnerCapabilityValidationResult,
} from "@/lib/providers/runner-capabilities";
import {
  getCustomModelById,
  getCustomModels,
  getProviderKey,
  getUserSettings,
} from "./store";

export const CUSTOM_PROVIDER_ID = "custom";
export const FOUNDRY_PROVIDER_ID = "foundry";
export const CHATGPT_PROVIDER_ID = "chatgpt";
export const GITHUB_COPILOT_PROVIDER_ID = "github-copilot";
export const NVIDIA_PROVIDER_ID = "nvidia";
export const OPENROUTER_PROVIDER_ID = "openrouter";
export const DEEPSEEK_PROVIDER_ID = "deepseek";

const RUNNER_CAPABILITY_PROVIDER_IDS = new Set<RunnerCapabilityProviderId>([
  "chatgpt",
  "github-copilot",
]);

/** ChatGPT and Copilot: the launcher's account peer, never the proxy or the home (OD-32). */
export const ACCOUNT_PEER_PROVIDER_IDS: ReadonlySet<string> = new Set([
  CHATGPT_PROVIDER_ID,
  GITHUB_COPILOT_PROVIDER_ID,
]);

export function isAccountPeerProvider(providerId: string): boolean {
  return ACCOUNT_PEER_PROVIDER_IDS.has(providerId);
}

export const ACCOUNT_PEER_MISSING_MESSAGE =
  "This model runs through the account peer that a plain `aiboard` start launches. " +
  `${CONNECT_AI_BOARD_MESSAGE}, and open the link it prints.`;

/**
 * The only way to a provider (HM4a, plan §9 "Browser side: one resolver").
 * `id` is a provider id, a full model id (`openai:gpt-5`), or a custom model
 * id (`custom:<id>`). Proxied providers and custom models get the Runner's
 * model proxy, whose token the proxy swaps for the key in the AIBoard home;
 * ChatGPT and Copilot get the account peer's address and token from the
 * launcher, read at call time so they survive a Runner restart.
 *
 * With no Runner, or one without `capabilities.home`/`modelProxy`, it throws a
 * `ModelConnectionError` naming the fix, before any provider call.
 */
export async function resolveProviderConnection(
  id: string,
  options: { signal?: AbortSignal } = {},
): Promise<ProviderConnection> {
  const parsed = id.includes(":") ? parseModelId(id) : { providerId: id, model: "" };
  const providerId = parsed.providerId;
  if (providerId === CUSTOM_PROVIDER_ID) {
    if (!parsed.model) throw new Error("A custom model connection needs the model id (custom:<id>).");
    const session = await modelProxyClient.getSession({ signal: options.signal });
    return {
      baseURL: `${session.proxyBaseUrl}${MODEL_PROXY_PATH_PREFIX}custom/${encodeURIComponent(parsed.model)}`,
      apiKey: session.token,
      headers: {},
      fetch: modelProxyClient.fetch,
    };
  }
  if (!PROVIDER_IDS.includes(providerId as ProviderId)) {
    throw new Error(`Unknown provider: ${providerId}`);
  }
  if (isAccountPeerProvider(providerId)) {
    await modelProxyClient.assertCapable(options.signal);
    const peer = getPeerConnection("accounts");
    if (!peer) throw new ModelConnectionError("account_peer_missing", ACCOUNT_PEER_MISSING_MESSAGE);
    return { baseURL: peer.url, apiKey: peer.token, headers: {} };
  }
  const session = await modelProxyClient.getSession({ signal: options.signal });
  return {
    baseURL: `${session.proxyBaseUrl}${MODEL_PROXY_PATH_PREFIX}${providerId}`,
    apiKey: session.token,
    headers: providerId === OPENROUTER_PROVIDER_ID ? { ...OPENROUTER_ATTRIBUTION_HEADERS } : {},
    fetch: modelProxyClient.fetch,
  };
}

/** Refuses before any model call when AI Board is not connected or too old (plan §9). */
export async function assertModelConnection(signal?: AbortSignal): Promise<void> {
  await modelProxyClient.assertCapable(signal);
}

type UnconnectedChatParams = Omit<ChatParams, "apiKey"> & { apiKey?: string };

/** `params` with the resolved connection for `id` filled in. */
export async function withProviderConnection<T extends UnconnectedChatParams>(
  id: string,
  params: T,
): Promise<T & ChatParams> {
  const connection = await resolveProviderConnection(id, { signal: params.signal });
  return { ...params, ...connectionParams(connection) } as T & ChatParams;
}

export interface RunnerCapabilityPlanningContext {
  evidence?: CapabilityEvidence[];
  allowedTransports?: ProviderTransportId[];
  validation?: RunnerCapabilityValidationResult;
}

export function isRunnerCapabilityProvider(
  providerId: string,
): providerId is RunnerCapabilityProviderId {
  return RUNNER_CAPABILITY_PROVIDER_IDS.has(providerId as RunnerCapabilityProviderId);
}

export async function getRunnerCapabilityPlanningContext(
  providerId: string,
  modelId: string,
  signal?: AbortSignal,
  connectionOverride?: {
    baseURL?: string;
    runnerToken?: string;
    apiKey?: string;
  },
): Promise<RunnerCapabilityPlanningContext> {
  if (!isRunnerCapabilityProvider(providerId)) return {};
  // The account peer's address and token come from the launcher at call time (OD-32).
  const launcherAccount = !connectionOverride?.baseURL && !connectionOverride?.runnerToken
    ? getPeerConnection("accounts")
    : null;
  const baseURL = connectionOverride?.baseURL ?? launcherAccount?.url ?? undefined;
  const runnerToken = connectionOverride?.runnerToken ?? launcherAccount?.token ?? undefined;
  if (!baseURL?.trim() || !runnerToken?.trim()) return {};

  const validation = await getCachedAccountRunnerCapabilities({
    baseURL,
    runnerToken,
    providerId,
    signal,
    minimumRunnerVersion: ACCOUNT_RUNNER_CAPABILITY_MINIMUM_VERSION,
  });
  if (validation.status !== "valid") return { validation, evidence: [] };
  return {
    validation,
    evidence: runnerCapabilityEvidence(validation, modelId),
    allowedTransports: [...validation.handshake.transports],
  };
}

const TEXT_ONLY = {
  image: false,
  document: false,
  audio: false,
  video: false,
} as const;

function getDiscoveredCapabilities(fullModelId: string): ModelCapabilities | null {
  const metadata = getUserSettings().discoveredModelMetadata?.[fullModelId];
  if (!metadata) return null;
  const effective = effectiveModelMetadata(metadata);
  return {
    image: effective.image === true,
    document: effective.document === true,
    audio: effective.audio === true,
    video: effective.video === true,
  };
}

export function getDiscoveredModelMetadata(fullModelId: string) {
  return getUserSettings().discoveredModelMetadata?.[fullModelId] ?? null;
}

export function getPersistedProviderCapabilityEvidence(
  providerId: string,
  modelId: string,
  nowMs = Date.now(),
): CapabilityEvidence[] | undefined {
  const evidence = (getUserSettings().providerToolCapabilityEvidence ?? []).filter((item) => {
    if (item.providerId !== providerId) return false;
    if (item.modelId !== undefined && item.modelId !== modelId) return false;
    if (item.expiresAt) {
      const expiresAt = Date.parse(item.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
    }
    return true;
  });
  return evidence.length > 0 ? evidence : undefined;
}

/** Compatibility alias for callers/tests that still use the OpenRouter-specific name. */
export function getDiscoveredOpenRouterApiCapabilities(modelId: string) {
  return getDiscoveredModelMetadata(
    formatModelId(OPENROUTER_PROVIDER_ID, normalizeOpenRouterModelId(modelId)),
  );
}

export function getDiscoveredOpenRouterCapabilityEvidence(
  modelId: string,
): CapabilityEvidence[] | undefined {
  return getPersistedProviderCapabilityEvidence(
    OPENROUTER_PROVIDER_ID,
    normalizeOpenRouterModelId(modelId),
  );
}

// Foundry serves Claude models, which accept image + document inputs.
const FOUNDRY_CAPABILITIES = {
  image: true,
  document: true,
  audio: false,
  video: false,
} as const;

const providers: Record<ProviderId, AIProvider> = {
  openai: openaiProvider,
  deepseek: deepseekProvider,
  anthropic: anthropicProvider,
  foundry: foundryProvider,
  google: googleProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
  meta: metaProvider,
  chatgpt: chatgptProvider,
  "github-copilot": githubCopilotProvider,
  nvidia: nvidiaProvider,
};

export function getProvider(id: string): AIProvider | undefined {
  return providers[id as ProviderId];
}

export function getAllProviders(): AIProvider[] {
  return PROVIDER_IDS.map((id) => providers[id]);
}

function withContextProfile(
  model: ModelInfo,
  overrides?: ModelContextOverrides,
  discoveredModelContext?: DiscoveredModelContextMap,
): ModelInfo {
  return {
    ...model,
    contextProfile: resolveModelContextProfile(
      model.id,
      model.providerId,
      overrides,
      discoveredModelContext,
    ),
  };
}

function withContextProfiles(
  models: ModelInfo[],
  overrides?: ModelContextOverrides,
  discoveredModelContext?: DiscoveredModelContextMap,
): ModelInfo[] {
  return models.map((model) =>
    withContextProfile(model, overrides, discoveredModelContext),
  );
}

export function customModelPlanningContext(model: CustomModel): {
  customOverrides: CustomModel["toolCapabilityOverrides"];
  allowedTransports: ProviderTransportId[];
} {
  return {
    customOverrides: model.toolCapabilityOverrides ?? [],
    allowedTransports: customCompatibleTransports(model.compatibleTransports),
  };
}
function customModelToInfo(model: CustomModel): ModelInfo {
  return {
    id: model.id,
    name: model.label,
    providerId: CUSTOM_PROVIDER_ID,
    description: `Custom · ${model.model}`,
    capabilities: model.capabilities ?? { ...TEXT_ONLY },

  };
}

export function listCustomModelInfos(): ModelInfo[] {
  return getCustomModels().map(customModelToInfo);
}

/** User-defined Azure Foundry model ids (from the provider key). */
export function normalizeFoundryModelId(id: string): string {
  const trimmed = id.trim();
  const parsed = parseModelId(trimmed);
  return parsed.providerId === FOUNDRY_PROVIDER_ID ? parsed.model : trimmed;
}

export function listFoundryModelInfos(): ModelInfo[] {
  const ids = getProviderKey(FOUNDRY_PROVIDER_ID)?.models ?? [];
  return ids
    .map(normalizeFoundryModelId)
    .filter((id) => id.length > 0)
    .map((id) => ({
      id,
      name: id,
      providerId: FOUNDRY_PROVIDER_ID,
      description: "Azure AI Foundry deployment",
      capabilities: { ...FOUNDRY_CAPABILITIES },
    }));
}

export function normalizeProviderModelId(providerId: string, id: string): string {
  const trimmed = id.trim();
  const parsed = parseModelId(trimmed);
  return parsed.providerId === providerId ? parsed.model : trimmed;
}

export function normalizeOpenRouterModelId(id: string): string {
  return normalizeProviderModelId(OPENROUTER_PROVIDER_ID, id);
}

/** Configured models for discoverable providers; built-ins only for other providers. */
export function listProviderModelInfos(providerId: ProviderId): ModelInfo[] {
  if (providerId === FOUNDRY_PROVIDER_ID) return listFoundryModelInfos();

  const provider = getProvider(providerId);
  const hasDiscovery = getProviderDefinition(providerId)?.modelDiscovery != null;
  const catalogModels = hasDiscovery ? [] : provider?.listModels() ?? [];
  const knownIds = new Set(catalogModels.map((model) => model.id));
  const saved = getProviderKey(providerId);
  const configured = [...new Set([...(saved?.models ?? []), ...(hasDiscovery ? saved?.enabledModelIds ?? [] : []),
    ...(hasDiscovery && saved?.defaultModel ? [saved.defaultModel] : [])])];
  const additions = configured
    .map((id) => normalizeProviderModelId(providerId, id))
    .filter((id, index, all) => id.length > 0 && !knownIds.has(id) && all.indexOf(id) === index)
    .map((id) => ({
      id,
      name: getDiscoveredModelMetadata(formatModelId(providerId, id))?.name ?? id,
      providerId,
      description: getDiscoveredModelMetadata(formatModelId(providerId, id))?.description ?? `User-added ${provider?.name ?? providerId} model`,
      capabilities:
        getDiscoveredCapabilities(formatModelId(providerId, id)) ??
        { ...TEXT_ONLY },
    }));
  return [...catalogModels, ...additions];
}

export function listOpenRouterModelInfos(): ModelInfo[] {
  return listProviderModelInfos(OPENROUTER_PROVIDER_ID);
}

export function normalizeNvidiaModelId(id: string): string {
  return normalizeProviderModelId(NVIDIA_PROVIDER_ID, id);
}


export function listNvidiaModelInfos(): ModelInfo[] {
  return listProviderModelInfos(NVIDIA_PROVIDER_ID);
}

export function getAllModels(): ModelInfo[] {
  const settings = getUserSettings();
  return withContextProfiles(
    [
      ...getAllProviders().flatMap((provider) =>
        listProviderModelInfos(provider.id as ProviderId)
      ),
      ...listCustomModelInfos(),
    ],
    settings.modelContextOverrides,
    settings.discoveredModelMetadata,
  );
}

/**
 * True when the provider's row is enabled. The key lives in the AIBoard home
 * and never reaches the browser (HM4a), so a browser key is no longer the
 * test; HM4b replaces the row with the home's mirror.
 */
export function isProviderEnabled(providerId: string): boolean {
  return getProviderKey(providerId)?.enabled === true;
}

export function getEnabledModels(): ModelInfo[] {
  const settings = getUserSettings();
  const keyed = getAllProviders()
    .map((p) => p.id as ProviderId)
    .filter((id) => isProviderEnabled(id));
  const providerRows = Object.fromEntries(
    keyed.map((providerId) => [providerId, getProviderKey(providerId)]),
  );
  return withContextProfiles(
    [
      ...keyed.flatMap((providerId) => {
        const models = listProviderModelInfos(providerId);
        const configuredIds = providerRows[providerId]?.enabledModelIds;
        if (configuredIds === undefined || configuredIds === null) return models;
        const enabledSet = new Set(configuredIds);
        return models.filter((model) => enabledSet.has(model.id));
      }),
      ...listCustomModelInfos(),
    ],
    settings.modelContextOverrides,
    settings.discoveredModelMetadata,
  );
}

export function resolveClientModelContextProfile(fullId: string) {
  const { providerId, model } = parseModelId(fullId);
  const settings = getUserSettings();
  return resolveModelContextProfile(
    model,
    providerId,
    settings.modelContextOverrides,
    settings.discoveredModelMetadata,
  );
}

export function resolveModelName(fullId: string): string {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.label ?? model;
  }
  if (PROVIDER_IDS.includes(providerId as ProviderId)) {
    return (
      listProviderModelInfos(providerId as ProviderId).find((entry) => entry.id === model)
        ?.name ?? model
    );
  }
  return getModelDisplayName(fullId);
}

/**
 * Capabilities for a full model id, resolving user-defined gateway models
 * (Foundry/custom) that aren't in the static catalog.
 */
export function resolveModelCapabilities(fullId: string) {
  const { providerId, model } = parseModelId(fullId);
  if (providerId === CUSTOM_PROVIDER_ID) {
    return getCustomModelById(model)?.capabilities ?? { ...TEXT_ONLY };
  }
  if (!PROVIDER_IDS.includes(providerId as ProviderId)) return null;
  return (
    listProviderModelInfos(providerId as ProviderId).find((entry) => entry.id === model)
      ?.capabilities ?? null
  );
}

export function getCustomModelByFullId(fullId: string): CustomModel | null {
  const { providerId, model } = parseModelId(fullId);
  if (providerId !== CUSTOM_PROVIDER_ID) return null;
  return getCustomModelById(model) ?? null;
}

/**
 * Streams a custom model through the model proxy's `custom/<id>` route, which
 * sends it to the endpoint and key saved for that id in the AIBoard home.
 * Params that already carry a connection keep it.
 */
export async function* streamCustomChat(
  model: CustomModel,
  params: UnconnectedChatParams
): AsyncIterable<StreamChunk> {
  const connected: ChatParams = params.baseURL && connectionFromParams({ ...params, apiKey: params.apiKey ?? "" })
    ? { ...params, apiKey: params.apiKey ?? "" }
    : await withProviderConnection(formatModelId(CUSTOM_PROVIDER_ID, model.id), params);
  const client = createOpenAIClient(connected, model.label, {
    disableAutomaticRetries: params.disableAutomaticRetries,
  });
  const prepared = {
    ...connected,
    model: model.model,
    capabilities: model.capabilities ?? { ...TEXT_ONLY },
    reasoningEffort: params.reasoningEffort && params.reasoningEffort !== "default"
      ? params.reasoningEffort
      : (model.reasoningEffort ?? "default"),
  };
  if (params.callPlan?.transport === "responses") {
    yield* streamOpenAIResponses(client, prepared, "custom");
    return;
  }
  yield* streamOpenAICompatibleChat(
    client,
    prepared,
    CUSTOM_PROVIDER_ID,
    model.label,
    "max_tokens"
  );
}
