import type { AttachmentPayload } from "@/lib/attachments/types";
import type { ChatMessage, ModelInfo, StreamChunk, StructuredOutputFormat } from "@/lib/providers/base";
import { parseModelId } from "@/lib/providers/base";
import {
  CAPABILITY_PROBES,
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
  defaultCapabilityProfile,
  type CapabilityProbeId,
  type CapabilityProbeResult,
  type ModelCapabilityProbeProfile,
} from "@/lib/providers/capability-probes";
import { getProviderKey, getUserSettings, updateUserSettings } from "./store";
import {
  CUSTOM_PROVIDER_ID,
  FOUNDRY_PROVIDER_ID,
  getCustomModelByFullId,
  getProvider,
  listFoundryModelInfos,
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
  error?: string;
}

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
  const modelInfo =
    providerId === FOUNDRY_PROVIDER_ID
      ? listFoundryModelInfos().find((m) => m.id === model)
      : provider?.listModels().find((m) => m.id === model);
  if (!provider || !modelInfo) throw new Error(`Model ${fullModelId} not found`);
  return { providerId, modelId: model, fullModelId, modelInfo };
}

async function collectStream(
  stream: AsyncIterable<StreamChunk>
): Promise<CollectedProbeOutput> {
  let text = "";
  let chunks = 0;
  try {
    for await (const chunk of stream) {
      if (chunk.type === "error") {
        return { text, chunks, error: chunk.error ?? "Provider returned an error" };
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
      error: err instanceof Error ? err.message : "Provider request failed",
    };
  }
  return { text: text.trim(), chunks };
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
  return { id, status: "pass", detail, preview: outputPreview(output ?? { text: "", chunks: 0 }) };
}

function fail(id: CapabilityProbeId, detail: string, output?: CollectedProbeOutput): CapabilityProbeResult {
  return { id, status: "fail", detail, preview: outputPreview(output ?? { text: "", chunks: 0 }) };
}

async function runProbeCall(input: {
  target: ProbeTarget;
  messages: ChatMessage[];
  attachments?: AttachmentPayload[];
  maxTokens?: number;
  temperature?: number;
  structuredOutput?: StructuredOutputFormat;
}): Promise<CollectedProbeOutput> {
  const { target } = input;
  if (target.providerId === CUSTOM_PROVIDER_ID) {
    const custom = getCustomModelByFullId(target.fullModelId);
    if (!custom) return { text: "", chunks: 0, error: "Custom model not found" };
    return collectStream(
      streamCustomChat(custom, {
        apiKey: "",
        model: custom.model,
        messages: input.messages,
        attachments: input.attachments ?? [],
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        structuredOutput: input.structuredOutput,
      })
    );
  }

  const provider = getProvider(target.providerId);
  const key = getProviderKey(target.providerId);
  if (!provider || !key?.apiKey) return { text: "", chunks: 0, error: "Provider is not configured" };
  return collectStream(
    provider.streamChat({
      apiKey: key.apiKey,
      baseURL: key.baseURL ?? undefined,
      model: target.modelId,
      messages: input.messages,
      attachments: input.attachments ?? [],
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      structuredOutput: input.structuredOutput,
    })
  );
}

async function runOneProbe(
  target: ProbeTarget,
  id: CapabilityProbeId
): Promise<CapabilityProbeResult> {
  if (id === "text") {
    const output = await runProbeCall({ target, messages: TEXT_PROBE_MESSAGES, maxTokens: 64 });
    if (output.error) return fail(id, output.error, output);
    return output.text.includes("AIBOARD_TEXT_OK")
      ? pass(id, "Text prompt passed", output)
      : fail(id, "Expected exact marker was not returned", output);
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
      maxTokens: 64,
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
      maxTokens: 64,
    });
    if (output.error) return fail(id, output.error, output);
    return /blue-river/i.test(output.text)
      ? pass(id, "Document input passed", output)
      : fail(id, "The model did not read the generated text attachment", output);
  }

  if (id === "temperature") {
    const output = await runProbeCall({
      target,
      messages: TEMPERATURE_PROBE_MESSAGES,
      maxTokens: 64,
      temperature: 0.7,
    });
    if (output.error) return fail(id, output.error, output);
    return output.text.includes("AIBOARD_TEMPERATURE_OK")
      ? pass(id, "Temperature parameter was accepted", output)
      : fail(id, "Temperature request succeeded but marker was missing", output);
  }

  if (id === "maxTokens") {
    const output = await runProbeCall({ target, messages: MAX_TOKENS_PROBE_MESSAGES, maxTokens: 8 });
    if (output.error) return fail(id, output.error, output);
    return /OK/i.test(output.text)
      ? pass(id, "Max-token parameter was accepted", output)
      : fail(id, "Small max-token request succeeded but expected reply was missing", output);
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
  profile.capabilities.temperature = results.some((r) => r.id === "temperature" && r.status === "pass");
  profile.capabilities.maxTokens = results.some((r) => r.id === "maxTokens" && r.status === "pass");

  saveCapabilityProfile(profile);
  return profile;
}
