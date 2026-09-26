/**
 * Client backend for the Settings surface: provider keys, validation, pricing
 * overrides, custom models, and attachments. Mirrors the old /api/keys,
 * /api/providers/validate, /api/custom-models and /api/attachments routes, but
 * runs against the client store and calls providers in-browser.
 */

import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import type { CustomModel, UserSettings } from "@/lib/db/schema";
import type { ModelInfo, StreamChunk } from "@/lib/providers/base";
import { streamOpenAICompatibleChat } from "@/lib/providers/openai-compat";
import {
  resolveModelContextProfile,
  type ModelContextProfileOverride,
} from "@/lib/providers/model-context";
import type { AttachmentPayload, AttachmentSummary } from "@/lib/attachments/types";
import { classifyMimeType } from "@/lib/attachments/classify";
import { maskApiKey } from "@/lib/utils";
import {
  addAttachment,
  addCustomModel as storeAddCustomModel,
  deleteAttachmentRecord,
  deleteCustomModel as storeDeleteCustomModel,
  getAttachment,
  getCustomModelById,
  getCustomModels,
  getProviderKey,
  getProviderKeys,
  getUserSettings,
  updateCustomModel as storeUpdateCustomModel,
  updateProviderKey,
  updateUserSettings,
  upsertProviderKey,
} from "./store";
import {
  CUSTOM_PROVIDER_ID,
  FOUNDRY_PROVIDER_ID,
  NVIDIA_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  getAllProviders,
  getProvider,
  listFoundryModelInfos,
  normalizeOpenRouterModelId,
  listOpenRouterModelInfos,
  listNvidiaModelInfos,
  resolveModelCapabilities,
} from "./providers";
import { formatModelId } from "@/lib/providers/base";

// ── Providers / keys ──────────────────────────────────────────────────────────

export interface ProviderConfig {
  providerId: string;
  name: string;
  models: ModelInfo[];
  hasKey: boolean;
  keyHint?: string | null;
  baseURL?: string | null;
  runnerTokenHint?: string | null;
  /** Optional extra model ids saved for providers that support user additions. */
  modelIds?: string[];
  defaultModel?: string | null;
  enabled: boolean;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

export function loadProviders(): {
  providers: ProviderConfig[];
  settings: UserSettings;
} {
  const keys = getProviderKeys();
  const settings = getUserSettings();
  const withContext = (model: ModelInfo): ModelInfo => ({
    ...model,
    contextProfile: resolveModelContextProfile(
      model.id,
      model.providerId,
      settings.modelContextOverrides
    ),
  });
  const providers = getAllProviders().map((p) => {
    const saved = keys.find((k) => k.providerId === p.id);
    return {
      providerId: p.id,
      name: p.name,
      // Gateway provider models are user-defined (deployment/account-specific).
      models:
        p.id === FOUNDRY_PROVIDER_ID
          ? listFoundryModelInfos().map(withContext)
          : p.id === OPENROUTER_PROVIDER_ID
            ? listOpenRouterModelInfos().map(withContext)
          : p.id === NVIDIA_PROVIDER_ID
            ? listNvidiaModelInfos().map(withContext)
          : p.listModels().map(withContext),
      hasKey: !!saved,
      keyHint: saved?.keyHint,
      baseURL: saved?.baseURL ?? null,
      runnerTokenHint: saved?.runnerTokenHint ?? null,
      modelIds: saved?.models ?? [],
      defaultModel: saved?.defaultModel,
      enabled: saved?.enabled ?? false,
      lastValidationSucceeded: saved?.lastValidationSucceeded ?? null,
      lastValidatedAt: saved?.lastValidatedAt ?? null,
    };
  });
  return { providers, settings };
}

export function saveProviderKey(input: {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  runnerToken?: string;
  models?: string[];
  defaultModel?: string;
  enabled?: boolean;
}): void {
  const existing = getProviderKey(input.providerId);
  const now = new Date().toISOString();
  const baseURL = input.baseURL?.trim();
  const runnerToken = input.runnerToken?.trim();
  const models = input.models
    ?.map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (existing) {
    updateProviderKey(input.providerId, {
      ...(input.apiKey
        ? {
            apiKey: input.apiKey,
            keyHint: maskApiKey(input.apiKey),
            lastValidationSucceeded: null,
            lastValidatedAt: null,
          }
        : {}),
      ...(input.baseURL !== undefined ? { baseURL: baseURL || null } : {}),
      ...(input.runnerToken
        ? {
            runnerToken,
            runnerTokenHint: runnerToken ? maskApiKey(runnerToken) : null,
            lastValidationSucceeded: null,
            lastValidatedAt: null,
          }
        : {}),
      ...(input.models !== undefined ? { models: models ?? [] } : {}),
      defaultModel: input.defaultModel ?? existing.defaultModel,
      enabled: input.enabled ?? existing.enabled,
      updatedAt: now,
    });
  } else if (input.apiKey) {
    upsertProviderKey({
      providerId: input.providerId,
      apiKey: input.apiKey,
      baseURL: baseURL || null,
      runnerToken: runnerToken || null,
      runnerTokenHint: runnerToken ? maskApiKey(runnerToken) : null,
      models: models ?? [],
      defaultModel: input.defaultModel ?? null,
      enabled: input.enabled ?? true,
      keyHint: maskApiKey(input.apiKey),
      lastValidationSucceeded: null,
      lastValidatedAt: null,
      updatedAt: now,
    });
  } else {
    throw new Error("API key required");
  }
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    name?: string;
    description?: string;
    supported_parameters?: string[];
    architecture?: {
      input_modalities?: string[];
    };
  }>;
}

export interface OpenRouterCatalogModel {
  id: string;
  name: string;
  description?: string;
  inputModalities: string[];
  supportedParameters: string[];
  supportsImageInput: boolean;
  supportsDocumentInput: boolean;
  supportsAudioInput: boolean;
  supportsVideoInput: boolean;
  supportsTools: boolean;
  supportsToolChoice: boolean;
  supportsStructuredOutputs: boolean;
  supportsReasoning: boolean;
  supportsReasoningEffort: boolean;
  supportsTemperature: boolean;
  supportsMaxTokens: boolean;
}

function normalizeOpenRouterSupportedParameters(
  parameters?: string[]
): Set<string> {
  return new Set(
    (parameters ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
}

function normalizeOpenRouterInputModalities(modalities?: string[]): Set<string> {
  return new Set(
    (modalities ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean)
  );
}

export function buildOpenRouterCatalogModel(
  entry: NonNullable<OpenRouterModelsResponse["data"]>[number] & { id: string }
): OpenRouterCatalogModel {
  const inputModalities = [...(entry.architecture?.input_modalities ?? [])];
  const modalitySet = normalizeOpenRouterInputModalities(inputModalities);
  const supportedParameters = [...(entry.supported_parameters ?? [])];
  const parameterSet = normalizeOpenRouterSupportedParameters(supportedParameters);
  return {
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    description: entry.description?.trim() || undefined,
    inputModalities,
    supportedParameters,
    supportsImageInput: modalitySet.has("image"),
    supportsDocumentInput: modalitySet.has("file"),
    supportsAudioInput: modalitySet.has("audio"),
    supportsVideoInput: modalitySet.has("video"),
    supportsTools: parameterSet.has("tools"),
    supportsToolChoice: parameterSet.has("tool_choice"),
    supportsStructuredOutputs: parameterSet.has("structured_outputs"),
    supportsReasoning: parameterSet.has("reasoning"),
    supportsReasoningEffort: parameterSet.has("reasoning_effort"),
    supportsTemperature: parameterSet.has("temperature"),
    supportsMaxTokens: parameterSet.has("max_tokens"),
  };
}

async function fetchOpenRouterModelsPayload(): Promise<OpenRouterModelsResponse> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    throw new Error(`OpenRouter model catalog request failed (${response.status})`);
  }
  return (await response.json()) as OpenRouterModelsResponse;
}

export async function fetchOpenRouterModelCatalog(): Promise<OpenRouterCatalogModel[]> {
  const payload = await fetchOpenRouterModelsPayload();
  return (payload.data ?? [])
    .filter(
      (
        entry
      ): entry is NonNullable<OpenRouterModelsResponse["data"]>[number] & { id: string } =>
        typeof entry.id === "string" && entry.id.length > 0
    )
    .map(buildOpenRouterCatalogModel)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function openRouterCapabilitiesFromEntry(
  entry: NonNullable<OpenRouterModelsResponse["data"]>[number]
) {
  const modalities = normalizeOpenRouterInputModalities(entry.architecture?.input_modalities);
  const parameters = normalizeOpenRouterSupportedParameters(entry.supported_parameters);
  return {
    image: modalities.has("image"),
    document: modalities.has("file"),
    audio: modalities.has("audio"),
    video: modalities.has("video"),
    tools: parameters.has("tools"),
    toolChoice: parameters.has("tool_choice"),
    structuredOutputs: parameters.has("structured_outputs"),
    reasoning: parameters.has("reasoning"),
    reasoningEffort: parameters.has("reasoning_effort"),
    temperature: parameters.has("temperature"),
    maxTokens: parameters.has("max_tokens"),
  };
}

export async function refreshOpenRouterModelCapabilities(
  modelIds?: string[]
): Promise<{ synced: number; missing: string[] }> {
  const targets = (modelIds ?? getProviderKey(OPENROUTER_PROVIDER_ID)?.models ?? [])
    .map(normalizeOpenRouterModelId)
    .filter((id, index, all) => id.length > 0 && all.indexOf(id) === index);
  if (targets.length === 0) return { synced: 0, missing: [] };

  const payload = await fetchOpenRouterModelsPayload();
  const modelIndex = new Map(
    (payload.data ?? [])
      .filter((entry): entry is NonNullable<OpenRouterModelsResponse["data"]>[number] & { id: string } =>
        typeof entry.id === "string" && entry.id.length > 0
      )
      .map((entry) => [entry.id, entry])
  );

  const next = { ...(getUserSettings().discoveredModelCapabilities ?? {}) };
  const missing: string[] = [];
  let synced = 0;
  const updatedAt = new Date().toISOString();
  for (const id of targets) {
    const entry = modelIndex.get(id);
    if (!entry) {
      missing.push(id);
      continue;
    }
    next[formatModelId(OPENROUTER_PROVIDER_ID, id)] = {
      ...openRouterCapabilitiesFromEntry(entry),
      updatedAt,
      source: "openrouter-models",
    };
    synced += 1;
  }
  updateUserSettings({ discoveredModelCapabilities: next });
  return { synced, missing };
}

const TEST_IMAGE: AttachmentPayload = {
  id: "test-image-red-dot",
  filename: "tiny-red-square.png",
  mimeType: "image/png",
  category: "image",
  base64Data:
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVDhPY7ijpvafEjxqwKgBIDxqwDAwQO0/AEkhJx9IQd3PAAAAAElFTkSuQmCC",
};

const TEST_SYSTEM =
  "You are validating that this model can answer a short settings test request.";
const VISION_PROMPT =
  "Look at the attached test image and reply with only 2 to 4 words describing its color and shape, for example 'red square'. Do not use a full sentence.";
const TEXT_PROMPT =
  "Reply with one short sentence confirming this model test works.";
// Generous ceiling so "thinking" models (e.g. local Gemma via Ollama, which
// streams its reasoning before any visible content) have room to finish
// reasoning AND emit an answer. Cloud models bill per token generated, so a high
// cap costs nothing for their short replies.
const TEST_MAX_TOKENS = 4096;
const DEFAULT_MODEL_TEST_TIMEOUT_MS = 30_000;

export interface ModelTestResult {
  valid: boolean;
  usedImage: boolean;
  preview?: string;
  error?: string;
}

async function collectPreview(
  stream: AsyncIterable<StreamChunk>,
  options: { signal?: AbortSignal; timeoutMs: number }
): Promise<{ preview: string; error?: string }> {
  const iterator = stream[Symbol.asyncIterator]();
  let preview = "";
  let error: string | undefined;
  try {
    for (;;) {
      const next = await nextPreviewChunk(iterator, options);
      if (next.done) break;
      const chunk = next.value;
      if (chunk.type === "error") {
        error = chunk.error ?? "Validation failed";
        break;
      }
      if (chunk.type === "token" && chunk.content) {
        preview += chunk.content;
        if (preview.length >= 240) break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Validation failed";
  } finally {
    closePreviewIterator(iterator);
  }
  return { preview: preview.trim(), error };
}

function modelTestTimeoutMessage(timeoutMs: number): string {
  return `Model test timed out after ${(timeoutMs / 1000).toFixed(1)}s`;
}

async function nextPreviewChunk(
  iterator: AsyncIterator<StreamChunk>,
  options: { signal?: AbortSignal; timeoutMs: number }
): Promise<IteratorResult<StreamChunk>> {
  if (options.signal?.aborted) {
    closePreviewIterator(iterator);
    throw new Error(modelTestTimeoutMessage(options.timeoutMs));
  }
  if (!options.signal) return iterator.next();

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    abortHandler = () => {
      closePreviewIterator(iterator);
      reject(new Error(modelTestTimeoutMessage(options.timeoutMs)));
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    return await Promise.race([iterator.next(), abortPromise]);
  } finally {
    if (abortHandler) {
      options.signal.removeEventListener("abort", abortHandler);
    }
  }
}

function closePreviewIterator(iterator: AsyncIterator<StreamChunk>): void {
  try {
    const closeResult = iterator.return?.();
    if (closeResult) {
      void Promise.resolve(closeResult).catch(() => undefined);
    }
  } catch {
    // The caller is already unwinding a completed, failed, or aborted stream.
  }
}

/**
 * Unified test used by every provider AND custom models: try the "red dot"
 * vision test when model metadata allows images, then fall back to a plain text
 * confirmation for text-only models or endpoints that reject images.
 */
type StreamFactory = (
  prompt: string,
  attachments: AttachmentPayload[],
  signal?: AbortSignal
) => AsyncIterable<StreamChunk>;

async function collectProbePreview(
  makeStream: StreamFactory,
  prompt: string,
  attachments: AttachmentPayload[],
  timeoutMs: number
): Promise<{ preview: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await collectPreview(makeStream(prompt, attachments, controller.signal), {
      signal: controller.signal,
      timeoutMs,
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeModelTestTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_MODEL_TEST_TIMEOUT_MS;
}

async function runModelTest(
  makeStream: StreamFactory,
  options?: { allowImage?: boolean; timeoutMs?: number }
): Promise<ModelTestResult> {
  const timeoutMs = normalizeModelTestTimeoutMs(options?.timeoutMs);
  if (options?.allowImage !== false) {
    const vision = await collectProbePreview(
      makeStream,
      VISION_PROMPT,
      [TEST_IMAGE],
      timeoutMs
    );
    if (!vision.error && vision.preview.length > 0) {
      return { valid: true, usedImage: true, preview: vision.preview };
    }
  }
  const text = await collectProbePreview(makeStream, TEXT_PROMPT, [], timeoutMs);
  const valid = !text.error && text.preview.length > 0;
  return {
    valid,
    usedImage: false,
    preview: text.preview || undefined,
    error: valid ? undefined : text.error ?? "No response received from model",
  };
}

export async function validateProvider(input: {
  providerId: string;
  apiKey?: string;
  baseURL?: string;
  runnerToken?: string;
  modelId?: string;
}, options?: { timeoutMs?: number }): Promise<ModelTestResult & { modelId?: string }> {
  const provider = getProvider(input.providerId);
  if (!provider) return { valid: false, usedImage: false, error: "Unknown provider" };

  const saved = getProviderKey(input.providerId);
  const usingSaved = !input.apiKey;
  const apiKey = input.apiKey ?? saved?.apiKey ?? null;
  if (!apiKey) return { valid: false, usedImage: false, error: "No API key available" };
  const baseURL = input.baseURL?.trim() || saved?.baseURL || undefined;
  const runnerToken =
    input.runnerToken?.trim() || saved?.runnerToken || undefined;

  const modelId =
    input.modelId ??
    saved?.defaultModel ??
    provider.listModels()[0]?.id ??
    (input.providerId === FOUNDRY_PROVIDER_ID
      ? listFoundryModelInfos()[0]?.id
      : input.providerId === OPENROUTER_PROVIDER_ID
        ? listOpenRouterModelInfos()[0]?.id
      : input.providerId === NVIDIA_PROVIDER_ID
        ? listNvidiaModelInfos()[0]?.id
      : undefined);
  if (!modelId)
    return {
      valid: false,
      usedImage: false,
      error:
        input.providerId === FOUNDRY_PROVIDER_ID
          ? "Add at least one model id (e.g. claude-opus-4-5) and save first"
          : input.providerId === OPENROUTER_PROVIDER_ID
            ? "Add an OpenRouter model id (e.g. qwen/qwen3-coder) or pick a built-in OpenRouter model"
          : input.providerId === NVIDIA_PROVIDER_ID
            ? "Add at least one NVIDIA model id (e.g. z-ai/glm-5.2) and save first"
            : "No model available",
    };

  const capabilities = resolveModelCapabilities(formatModelId(input.providerId, modelId));
  const result = await runModelTest(
    (prompt, attachments, signal) =>
      provider.streamChat({
        apiKey,
        baseURL,
        runnerToken,
        model: modelId,
        messages: [
          { role: "system", content: TEST_SYSTEM },
          { role: "user", content: prompt },
        ],
        attachments,
        maxTokens: TEST_MAX_TOKENS,
        temperature: 0.2,
        signal,
      }),
    { allowImage: capabilities?.image !== false, timeoutMs: options?.timeoutMs }
  );

  if (usingSaved && saved) {
    updateProviderKey(input.providerId, {
      lastValidationSucceeded: result.valid,
      lastValidatedAt: new Date().toISOString(),
    });
  }
  return { ...result, modelId };
}

// ── Pricing overrides ─────────────────────────────────────────────────────────

export function savePricingOverride(input: {
  fullModelId: string;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  cachedInputUsdPer1M?: number | null;
  clear?: boolean;
}): void {
  const settings = getUserSettings();
  const next = { ...(settings.modelPricingOverrides ?? {}) };
  if (input.clear) {
    delete next[input.fullModelId];
  } else {
    if (input.inputUsdPer1M === undefined || input.outputUsdPer1M === undefined) {
      throw new Error("Input and output pricing are required");
    }
    next[input.fullModelId] = {
      inputUsdPer1M: input.inputUsdPer1M,
      outputUsdPer1M: input.outputUsdPer1M,
      cachedInputUsdPer1M: input.cachedInputUsdPer1M ?? null,
      updatedAt: new Date().toISOString(),
    };
  }
  updateUserSettings({ modelPricingOverrides: next });
}

// ── Context overrides ─────────────────────────────────────────────────────────

export function saveModelContextOverride(input: {
  fullModelId: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  buildOutputReserveTokens?: number;
  effectiveBuildInputCeilingTokens?: number;
  longContextQuality?: ModelContextProfileOverride["longContextQuality"];
  promptCaching?: boolean;
  recommendedBuildRoles?: ModelContextProfileOverride["recommendedBuildRoles"];
  clear?: boolean;
}): void {
  const settings = getUserSettings();
  const next = { ...(settings.modelContextOverrides ?? {}) };
  if (input.clear) {
    delete next[input.fullModelId];
  } else {
    next[input.fullModelId] = {
      ...(input.contextWindowTokens !== undefined
        ? { contextWindowTokens: input.contextWindowTokens }
        : {}),
      ...(input.maxOutputTokens !== undefined
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
      ...(input.buildOutputReserveTokens !== undefined
        ? { buildOutputReserveTokens: input.buildOutputReserveTokens }
        : {}),
      ...(input.effectiveBuildInputCeilingTokens !== undefined
        ? {
            effectiveBuildInputCeilingTokens:
              input.effectiveBuildInputCeilingTokens,
          }
        : {}),
      ...(input.longContextQuality !== undefined
        ? { longContextQuality: input.longContextQuality }
        : {}),
      ...(input.promptCaching !== undefined
        ? { promptCaching: input.promptCaching }
        : {}),
      ...(input.recommendedBuildRoles !== undefined
        ? { recommendedBuildRoles: input.recommendedBuildRoles }
        : {}),
      updatedAt: new Date().toISOString(),
    };
  }
  updateUserSettings({ modelContextOverrides: next });
}

// ── Custom models ─────────────────────────────────────────────────────────────

const NO_CAPS = { image: false, document: false, audio: false, video: false };

export interface CustomModelView {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
  capabilities: { image: boolean; document: boolean; audio: boolean; video: boolean };
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
}

function redactCustom(m: CustomModel): CustomModelView {
  return {
    id: m.id,
    label: m.label,
    baseURL: m.baseURL,
    model: m.model,
    hasKey: !!m.apiKey,
    capabilities: m.capabilities ?? { ...NO_CAPS },
    lastValidationSucceeded: m.lastValidationSucceeded ?? null,
    lastValidatedAt: m.lastValidatedAt ?? null,
  };
}

export function listCustomModels(): CustomModelView[] {
  return getCustomModels().map(redactCustom);
}

export function addCustomModel(input: {
  label: string;
  baseURL: string;
  model: string;
  apiKey?: string;
  capabilities?: CustomModelView["capabilities"];
}): CustomModelView {
  const record: CustomModel = {
    id: uuidv4(),
    label: input.label,
    baseURL: input.baseURL,
    model: input.model,
    apiKey: input.apiKey || undefined,
    hasKey: !!input.apiKey,
    capabilities: input.capabilities ?? { ...NO_CAPS },
    createdAt: new Date().toISOString(),
  };
  storeAddCustomModel(record);
  return redactCustom(record);
}

export function updateCustomModelCapabilities(
  id: string,
  capabilities: CustomModelView["capabilities"]
): void {
  storeUpdateCustomModel(id, { capabilities });
}

export function deleteCustomModel(id: string): void {
  storeDeleteCustomModel(id);
}

export async function testCustomModel(input: {
  baseURL: string;
  model: string;
  apiKey?: string;
}): Promise<ModelTestResult> {
  const client = new OpenAI({
    apiKey: input.apiKey || "not-needed",
    baseURL: input.baseURL,
    dangerouslyAllowBrowser: true,
  });
  // Force image capability on so the compat layer attaches the test image; the
  // text fallback covers endpoints that don't accept images.
  return runModelTest((prompt, attachments) =>
    streamOpenAICompatibleChat(
      client,
      {
        apiKey: input.apiKey ?? "",
        model: input.model,
        messages: [
          { role: "system", content: TEST_SYSTEM },
          { role: "user", content: prompt },
        ],
        attachments,
        // No token cap — local models are free, and "thinking" models need room
        // to finish reasoning before they emit any content.
        temperature: 0.2,
        capabilities: { image: true, document: false, audio: false, video: false },
      },
      CUSTOM_PROVIDER_ID,
      input.model,
      "max_tokens"
    )
  );
}

/** Test a saved custom model by id (uses its stored key/base URL), and record
 * the result so the list can show a "Connection verified" badge like providers. */
export async function testSavedCustomModel(id: string): Promise<ModelTestResult> {
  const model = getCustomModelById(id);
  if (!model) return { valid: false, usedImage: false, error: "Model not found" };
  const result = await testCustomModel({
    baseURL: model.baseURL,
    model: model.model,
    apiKey: model.apiKey,
  });
  storeUpdateCustomModel(id, {
    lastValidationSucceeded: result.valid,
    lastValidatedAt: new Date().toISOString(),
  });
  return result;
}

// ── Attachments ───────────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...(bytes.subarray(i, i + chunk) as unknown as number[])
    );
  }
  return btoa(binary);
}

export async function saveAttachmentFile(file: File): Promise<AttachmentSummary> {
  const category = classifyMimeType(file.type, file.name);
  const id = uuidv4();
  const mimeType = file.type || "application/octet-stream";

  let textContent: string | undefined;
  let base64Data: string | undefined;
  if (category === "text_inline") {
    textContent = await file.text();
  } else {
    base64Data = arrayBufferToBase64(await file.arrayBuffer());
  }

  addAttachment({
    id,
    filename: file.name,
    mimeType,
    category,
    size: file.size,
    textContent,
    base64Data,
    createdAt: new Date().toISOString(),
  });

  return { id, filename: file.name, mimeType, category, size: file.size };
}

export function deleteAttachmentFile(id: string): void {
  deleteAttachmentRecord(id);
}

export function getAttachmentDataUrl(id: string): string | null {
  const record = getAttachment(id);
  if (!record?.base64Data) return null;
  return `data:${record.mimeType};base64,${record.base64Data}`;
}
