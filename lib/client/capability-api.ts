import type { AttachmentPayload } from "@/lib/attachments/types";
import type {
  ChatMessage,
  ModelCapabilities,
  ModelInfo,
  NativeToolCall,
  NativeToolDefinition,
  StreamChunk,
  StructuredOutputFormat,
} from "@/lib/providers/base";
import { parseModelId } from "@/lib/providers/base";
import { providerSupportsMaxTokensFeature } from "@/lib/providers/provider-registry";
import { getProviderCapabilityManifest } from "@/lib/providers/capability-manifests";
import type { ProviderCallPlan, ProviderTransportId } from "@/lib/providers/tool-capabilities";
import {
  CAPABILITY_PROBES,
  CONCURRENCY_A_MESSAGES,
  CONCURRENCY_B_MESSAGES,
  DOCUMENT_PROBE_MESSAGES,
  IMAGE_PROBE_MESSAGES,
  MAX_TOKENS_PROBE_MESSAGES,
  PROBE_IMAGE_ATTACHMENT,
  PROBE_TEXT_ATTACHMENT,
  STREAMING_PROBE_MESSAGES,
  STRUCTURED_PROBE_FORMAT,
  STRUCTURED_PROBE_MESSAGES,
  TEMPERATURE_PROBE_MESSAGES,
  TEXT_PROBE_MESSAGES,
  TOOL_CALL_PROBE_MESSAGES,
  capabilityEvidenceFromToolProbe,
  defaultCapabilityProfile,
  type CapabilityProbeId,
  type CapabilityProbeResult,
  type ModelCapabilityProbeProfile,
} from "@/lib/providers/capability-probes";
import { getProviderKey, getUserSettings, updateUserSettings } from "./store";
import { mergeCapabilityEvidenceRecords } from "./provider-capability-migration";
import {
  CUSTOM_PROVIDER_ID,
  FOUNDRY_PROVIDER_ID,
  NVIDIA_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  getCustomModelByFullId,
  getProvider,
  listFoundryModelInfos,
  listOpenRouterModelInfos,
  listNvidiaModelInfos,
  streamCustomChat,
} from "./providers";

interface CapabilitySettingsExtension {
  modelCapabilityProfiles?: Record<string, ModelCapabilityProbeProfile>;
}

interface ProbeTarget {
  providerId: string;
  modelId: string;
  fullModelId: string;
  modelInfo: ModelInfo;
}

interface CollectedProbeOutput {
  text: string;
  chunks: number;
  toolCalls: NativeToolCall[];
  error?: string;
  errorMetadata?: StreamChunk["errorMetadata"];
}

const DEFAULT_PROBE_CAPABILITIES: ModelCapabilities = {
  image: false,
  document: false,
  audio: false,
  video: false,
};

const EXACT_MARKER_PROBE_MAX_TOKENS = 256;

function updateCapabilitySettings(patch: CapabilitySettingsExtension): void {
  updateUserSettings(patch as unknown as Parameters<typeof updateUserSettings>[0]);
}

export function getCapabilityProfiles(): Record<string, ModelCapabilityProbeProfile> {
  return {
    ...((getUserSettings() as CapabilitySettingsExtension).modelCapabilityProfiles ?? {}),
  };
}

export function getCapabilityProfile(
  fullModelId: string
): ModelCapabilityProbeProfile | undefined {
  return getCapabilityProfiles()[fullModelId];
}

export function clearCapabilityProfile(fullModelId: string): void {
  const next = getCapabilityProfiles();
  delete next[fullModelId];
  updateCapabilitySettings({ modelCapabilityProfiles: next });
}

function saveCapabilityProfile(profile: ModelCapabilityProbeProfile): void {
  updateCapabilitySettings({
    modelCapabilityProfiles: {
      ...getCapabilityProfiles(),
      [profile.fullModelId]: profile,
    },
  });
}

function resolveProbeTarget(fullModelId: string): ProbeTarget {
  const { providerId, model } = parseModelId(fullModelId);
  if (providerId === CUSTOM_PROVIDER_ID) {
    const custom = getCustomModelByFullId(fullModelId);
    if (!custom) throw new Error("Custom model not found");
    return {
      providerId,
      modelId: model,
      fullModelId,
      modelInfo: {
        id: model,
        name: custom.label,
        providerId,
        description: custom.model,
        capabilities: custom.capabilities,
      },
    };
  }

  const provider = getProvider(providerId);
  const gatewayModelInfo =
    providerId === FOUNDRY_PROVIDER_ID
      ? listFoundryModelInfos().find((m) => m.id === model)
      : providerId === OPENROUTER_PROVIDER_ID
        ? listOpenRouterModelInfos().find((m) => m.id === model)
      : providerId === NVIDIA_PROVIDER_ID
        ? listNvidiaModelInfos().find((m) => m.id === model)
        : undefined;
  const modelInfo = gatewayModelInfo ?? provider?.listModels().find((m) => m.id === model);
  if (!provider || !modelInfo) throw new Error(`Model ${fullModelId} not found`);
  return { providerId, modelId: model, fullModelId, modelInfo };
}

async function collectStream(
  stream: AsyncIterable<StreamChunk>
): Promise<CollectedProbeOutput> {
  let text = "";
  let chunks = 0;
  const toolCalls: NativeToolCall[] = [];
  try {
    for await (const chunk of stream) {
      if (chunk.type === "error") {
        return {
          text,
          chunks,
          toolCalls,
          error: chunk.error ?? "Provider returned an error",
          errorMetadata: chunk.errorMetadata,
        };
      }
      if (chunk.type === "tool_call" && chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
      }
      if (chunk.type === "token" && chunk.content) {
        chunks += 1;
        text += chunk.content;
        if (text.length > 2000) break;
      }
    }
  } catch (err) {
    return {
      text,
      chunks,
      toolCalls,
      error: err instanceof Error ? err.message : "Provider request failed",
    };
  }
  return { text: text.trim(), chunks, toolCalls };
}

function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function outputPreview(output: CollectedProbeOutput): string | undefined {
  return output.text ? output.text.slice(0, 240) : undefined;
}

function pass(id: CapabilityProbeId, detail: string, output?: CollectedProbeOutput): CapabilityProbeResult {
  return { id, status: "pass", detail, preview: outputPreview(output ?? { text: "", chunks: 0, toolCalls: [] }) };
}

function classifyProbeFailure(output: CollectedProbeOutput): CapabilityProbeResult["failureKind"] {
  const status = output.errorMetadata?.statusCode;
  const detail = output.error ?? "";
  if (
    status === 401 || status === 403 || status === 408 || status === 409 ||
    status === 429 || (status !== undefined && status >= 500) ||
    /network|fetch failed|failed to fetch|econn|socket|timeout|timed out|rate.?limit/i.test(detail)
  ) return "transient";
  if (
    (status === 400 || status === 404 || status === 405 || status === 415 || status === 422) &&
    /(tool|function).*(unsupported|not supported|unknown|invalid)|unsupported.*(tool|function)/i.test(detail)
  ) return "protocol_unsupported";
  return "behavior";
}

function fail(id: CapabilityProbeId, detail: string, output?: CollectedProbeOutput): CapabilityProbeResult {
  return {
    id,
    status: "fail",
    detail,
    preview: outputPreview(output ?? { text: "", chunks: 0, toolCalls: [] }),
    ...(output?.error ? { failureKind: classifyProbeFailure(output) } : { failureKind: "behavior" as const }),
    ...(output?.errorMetadata ? { errorMetadata: output.errorMetadata } : {}),
  };
}

function markerMatches(text: string, marker: string | RegExp): boolean {
  return typeof marker === "string" ? text.includes(marker) : marker.test(text);
}

export function evaluateMarkerProbeResult(input: {
  id: CapabilityProbeId;
  output: CollectedProbeOutput;
  marker: string | RegExp;
  passDetail: string;
  failDetail: string;
}): CapabilityProbeResult {
  if (input.output.error) return fail(input.id, input.output.error, input.output);
  return markerMatches(input.output.text, input.marker)
    ? pass(input.id, input.passDetail, input.output)
    : fail(input.id, input.failDetail, input.output);
}

export function evaluateParameterAcceptanceProbeResult(input: {
  id: CapabilityProbeId;
  output: CollectedProbeOutput;
  marker: string | RegExp;
  passDetail: string;
  acceptedWithoutMarkerDetail: string;
}): CapabilityProbeResult {
  if (input.output.error) return fail(input.id, input.output.error, input.output);
  return markerMatches(input.output.text, input.marker)
    ? pass(input.id, input.passDetail, input.output)
    : pass(input.id, input.acceptedWithoutMarkerDetail, input.output);
}

export function capabilityProbeCapabilities(
  capabilities: ModelCapabilities | undefined,
  id: CapabilityProbeId
): ModelCapabilities {
  const base = capabilities ?? DEFAULT_PROBE_CAPABILITIES;
  if (id === "imageInput") {
    return { ...base, image: true };
  }
  return base;
}

async function runProbeCall(input: {
  target: ProbeTarget;
  messages: ChatMessage[];
  attachments?: AttachmentPayload[];
  maxTokens?: number;
  temperature?: number;
  structuredOutput?: StructuredOutputFormat;
  capabilities?: ModelCapabilities;
  nativeTools?: NativeToolDefinition[];
  toolChoice?: "auto" | "required";
  callPlan?: ProviderCallPlan;
}): Promise<CollectedProbeOutput> {
  const { target } = input;
  if (target.providerId === CUSTOM_PROVIDER_ID) {
    const custom = getCustomModelByFullId(target.fullModelId);
    if (!custom) return { text: "", chunks: 0, toolCalls: [], error: "Custom model not found" };
    return collectStream(
      streamCustomChat(custom, {
        apiKey: "",
        model: custom.model,
        messages: input.messages,
        attachments: input.attachments ?? [],
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        structuredOutput: input.structuredOutput,
        capabilities: input.capabilities ?? custom.capabilities,
        nativeTools: input.nativeTools,
        toolChoice: input.toolChoice,
        callPlan: input.callPlan,
      })
    );
  }

  const provider = getProvider(target.providerId);
  const key = getProviderKey(target.providerId);
  if (!provider || !key?.apiKey) return { text: "", chunks: 0, toolCalls: [], error: "Provider is not configured" };
  return collectStream(
    provider.streamChat({
      apiKey: key.apiKey,
      baseURL: key.baseURL ?? undefined,
      runnerToken: key.runnerToken ?? undefined,
      model: target.modelId,
      messages: input.messages,
      attachments: input.attachments ?? [],
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      structuredOutput: input.structuredOutput,
      capabilities: input.capabilities,
      nativeTools: input.nativeTools,
      toolChoice: input.toolChoice,
      callPlan: input.callPlan,
    })
  );
}

async function runOneProbe(
  target: ProbeTarget,
  id: CapabilityProbeId
): Promise<CapabilityProbeResult> {
  if (id === "text") {
    const output = await runProbeCall({
      target,
      messages: TEXT_PROBE_MESSAGES,
      maxTokens: EXACT_MARKER_PROBE_MAX_TOKENS,
    });
    return evaluateMarkerProbeResult({
      id,
      output,
      marker: "AIBOARD_TEXT_OK",
      passDetail: "Text prompt passed",
      failDetail: "Expected exact marker was not returned",
    });
  }

  if (id === "structuredOutput") {
    const output = await runProbeCall({
      target,
      messages: STRUCTURED_PROBE_MESSAGES,
      maxTokens: 256,
      structuredOutput: STRUCTURED_PROBE_FORMAT,
    });
    if (output.error) return fail(id, output.error, output);
    const parsed = extractJson(output.text) as { ok?: boolean; label?: string } | null;
    return parsed?.ok === true && parsed.label === "aiboard"
      ? pass(id, "Structured JSON passed", output)
      : fail(id, "Response did not match the expected JSON shape", output);
  }

  if (id === "streaming") {
    const output = await runProbeCall({ target, messages: STREAMING_PROBE_MESSAGES, maxTokens: 128 });
    if (output.error) return fail(id, output.error, output);
    return output.chunks > 1
      ? pass(id, `Streaming emitted ${output.chunks} chunks`, output)
      : fail(id, "Provider returned only one chunk on the app streaming path", output);
  }

  if (id === "imageInput") {
    const output = await runProbeCall({
      target,
      messages: IMAGE_PROBE_MESSAGES,
      attachments: [PROBE_IMAGE_ATTACHMENT],
      maxTokens: EXACT_MARKER_PROBE_MAX_TOKENS,
      capabilities: capabilityProbeCapabilities(target.modelInfo.capabilities, id),
    });
    if (output.error) return fail(id, output.error, output);
    return /red/i.test(output.text)
      ? pass(id, "Image input passed", output)
      : fail(id, "The model did not identify the red test image", output);
  }

  if (id === "documentInput") {
    const output = await runProbeCall({
      target,
      messages: DOCUMENT_PROBE_MESSAGES,
      attachments: [PROBE_TEXT_ATTACHMENT],
      maxTokens: EXACT_MARKER_PROBE_MAX_TOKENS,
    });
    if (output.error) return fail(id, output.error, output);
    return /blue-river/i.test(output.text)
      ? pass(id, "Document input passed", output)
      : fail(id, "The model did not read the generated text attachment", output);
  }

  if (id === "toolCalls") {
    const manifest = getProviderCapabilityManifest(target.providerId);
    const descriptor = manifest?.capabilities.find((item) => item.id === "function_calling");
    const transport = descriptor?.transports[0] ?? manifest?.transports[0];
    if (!descriptor || !transport) {
      return fail(id, "Provider has no function-calling transport to probe");
    }
    const tool: NativeToolDefinition = {
      name: "aiboard_sum",
      description: "Add two small integers for an AI Board capability probe.",
      parameters: {
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { type: "integer" },
        },
        required: ["a", "b"],
        additionalProperties: false,
      },
      strict: true,
    };
    const intent = { id: "function_calling" as const, requirement: "required" as const };
    const callPlan: ProviderCallPlan = {
      transport,
      enabledTools: [{
        intent,
        descriptor: { ...descriptor, support: "supported", supportSource: "probed" },
        transport,
        readiness: "available",
      }],
      omittedOptionalTools: [],
      toolPolicyTrace: {
        requestedTools: [intent],
        enabledTools: ["function_calling"],
        omittedTools: [],
        transport,
        decisions: [],
      },
      toolChoice: "auto",
      parallelToolCalls: false,
    };
    const output = await runProbeCall({
      target,
      messages: TOOL_CALL_PROBE_MESSAGES,
      maxTokens: 256,
      nativeTools: [tool],
      toolChoice: "auto",
      callPlan,
    });
    if (output.error) return fail(id, output.error, output);
    const call = output.toolCalls.find((item) => item.name === "aiboard_sum");
    if (!call) return fail(id, "Provider did not emit the requested function call", output);
    return pass(id, "Provider emitted the requested function call", output);
  }

  if (id === "concurrency") {
    const [a, b] = await Promise.all([
      runProbeCall({
        target,
        messages: CONCURRENCY_A_MESSAGES,
        maxTokens: EXACT_MARKER_PROBE_MAX_TOKENS,
      }),
      runProbeCall({
        target,
        messages: CONCURRENCY_B_MESSAGES,
        maxTokens: EXACT_MARKER_PROBE_MAX_TOKENS,
      }),
    ]);
    if (a.error || b.error) {
      return fail(id, a.error ?? b.error ?? "Parallel probe failed", {
        text: [a.text, b.text].filter(Boolean).join("\n"),
        chunks: a.chunks + b.chunks,
        toolCalls: [...a.toolCalls, ...b.toolCalls],
        error: a.error ?? b.error,
      });
    }
    return a.text.includes("AIBOARD_CONCURRENCY_A") && b.text.includes("AIBOARD_CONCURRENCY_B")
      ? pass(id, "Two parallel requests completed successfully", {
          text: `${a.text}\n${b.text}`,
          chunks: a.chunks + b.chunks,
          toolCalls: [...a.toolCalls, ...b.toolCalls],
        })
      : fail(id, "Parallel requests completed but expected markers were missing", {
          text: `${a.text}\n${b.text}`,
          chunks: a.chunks + b.chunks,
          toolCalls: [...a.toolCalls, ...b.toolCalls],
        });
  }

  if (id === "temperature") {
    const output = await runProbeCall({
      target,
      messages: TEMPERATURE_PROBE_MESSAGES,
      maxTokens: EXACT_MARKER_PROBE_MAX_TOKENS,
      temperature: 0.7,
    });
    return evaluateParameterAcceptanceProbeResult({
      id,
      output,
      marker: "AIBOARD_TEMPERATURE_OK",
      passDetail: "Temperature parameter was accepted",
      acceptedWithoutMarkerDetail:
        "Temperature request succeeded but marker was missing",
    });
  }

  if (id === "maxTokens") {
    if (!providerSupportsMaxTokensFeature(target.providerId, target.modelId)) {
      return {
        id,
        status: "skipped",
        detail: "Provider path does not expose a max-token request parameter",
      };
    }
    const output = await runProbeCall({ target, messages: MAX_TOKENS_PROBE_MESSAGES, maxTokens: 8 });
    return evaluateParameterAcceptanceProbeResult({
      id,
      output,
      marker: /^OK$/i,
      passDetail: "Max-token parameter was accepted",
      acceptedWithoutMarkerDetail:
        "Small max-token request succeeded but expected reply was missing",
    });
  }

  return { id, status: "skipped", detail: "Probe is not implemented yet" };
}

export async function runCapabilityProbes(input: {
  fullModelId: string;
  probeIds: CapabilityProbeId[];
}): Promise<ModelCapabilityProbeProfile> {
  const target = resolveProbeTarget(input.fullModelId);
  const validProbeIds = new Set(CAPABILITY_PROBES.map((p) => p.id));
  const probeIds = input.probeIds.filter((id) => validProbeIds.has(id));
  const profile = defaultCapabilityProfile(
    target.fullModelId,
    target.providerId,
    target.modelInfo
  );

  const results: CapabilityProbeResult[] = [];
  for (const id of probeIds) {
    results.push(await runOneProbe(target, id));
  }
  profile.results = results;
  profile.capabilities.text = results.some((r) => r.id === "text" && r.status === "pass");
  profile.capabilities.structuredOutput = results.some(
    (r) => r.id === "structuredOutput" && r.status === "pass"
  );
  profile.capabilities.streaming = results.some((r) => r.id === "streaming" && r.status === "pass");
  profile.capabilities.imageInput = results.some((r) => r.id === "imageInput" && r.status === "pass");
  profile.capabilities.documentInput = results.some((r) => r.id === "documentInput" && r.status === "pass");
  profile.capabilities.toolCalls = results.some((r) => r.id === "toolCalls" && r.status === "pass");
  profile.capabilities.temperature = results.some((r) => r.id === "temperature" && r.status === "pass");
  profile.capabilities.maxTokens = results.some((r) => r.id === "maxTokens" && r.status === "pass");
  profile.capabilities.parallelRequests = results.some((r) => r.id === "concurrency" && r.status === "pass")
    ? 2
    : 1;

  saveCapabilityProfile(profile);
  const toolResult = results.find((result) => result.id === "toolCalls");
  if (toolResult) {
    const manifest = getProviderCapabilityManifest(target.providerId);
    const transport = manifest?.capabilities.find((item) => item.id === "function_calling")?.transports[0]
      ?? manifest?.transports[0];
    if (transport) {
      const evidence = capabilityEvidenceFromToolProbe({
        providerId: target.providerId,
        modelId: target.modelId,
        transport,
        testedAt: profile.testedAt,
        expiresAt: profile.expiresAt,
        result: toolResult,
      });
      if (evidence) {
        updateUserSettings({
          providerToolCapabilityEvidence: mergeCapabilityEvidenceRecords(
            getUserSettings().providerToolCapabilityEvidence,
            [evidence],
          ),
        });
      }
    }
  }
  return profile;
}
