import type { AttachmentPayload } from "@/lib/attachments/types";
import { buildNativeBuildToolDefinitions, nativeToolCallsToActionText } from "@/lib/orchestrator/build";
import type {
  ChatMessage,
  ModelCapabilities,
  ModelInfo,
  NativeToolCall,
  NativeToolDefinition,
  StreamChunk,
  StructuredOutputFormat,
} from "@/lib/providers/base";
import type { ProviderArtifactSink, ProviderToolEvent } from "@/lib/providers/provider-events";
import { parseModelId } from "@/lib/providers/base";
import { providerSupportsMaxTokensFeature } from "@/lib/providers/provider-registry";
import { resolveProviderCallPlan } from "@/lib/providers/call-planner";
import { resolveProviderCapabilityProfile } from "@/lib/providers/capability-resolution";
import {
  ProviderCallPlanError,
  type CapabilityEvidence,
  type ProviderCallPlan,
  type ProviderTransportId,
  type ToolCapabilityId,
  type ToolIntent,
  type ToolCapabilityDescriptor,
  type ToolResourceState,
} from "@/lib/providers/tool-capabilities";
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
  buildToolCapabilityProbeDefinitions,
  capabilityEvidenceFromToolProbe,
  defaultCapabilityProfile,
  parseToolCapabilityProbeId,
  type CapabilityProbeId,
  type CapabilityProbeResult,
  type CapabilityProbeDefinition,
  type ModelCapabilityProbeProfile,
  type ToolCapabilityProbeDefinition,
} from "@/lib/providers/capability-probes";
import { getProviderKey, getUserSettings, updateUserSettings } from "./store";
import {
  configuredOpenAIFileSearchIntent,
  configuredRemoteMcpIntent,
  getToolRuntimeSettings,
  resolveToolRuntimeResourceStateCached,
} from "./tool-runtime";
import { mergeCapabilityEvidenceRecords } from "./provider-capability-migration";
import {
  CUSTOM_PROVIDER_ID,
  FOUNDRY_PROVIDER_ID,
  NVIDIA_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  customModelPlanningContext,
  getCustomModelByFullId,
  getPersistedProviderCapabilityEvidence,
  getProvider,
  getRunnerCapabilityPlanningContext,
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

interface ProbeRuntimeContext {
  catalogEvidence?: CapabilityEvidence[];
  runnerEvidence?: CapabilityEvidence[];
  allowedTransports?: ProviderTransportId[];
  customOverrides?: ToolCapabilityDescriptor[];
  resourceState: ToolResourceState;
  toolProbes: ToolCapabilityProbeDefinition[];
}

export interface CapabilityLabProbeCatalog {
  generalProbes: CapabilityProbeDefinition[];
  toolProbes: ToolCapabilityProbeDefinition[];
}

export interface CollectedProbeOutput {
  text: string;
  chunks: number;
  toolCalls: NativeToolCall[];
  providerToolEvents: ProviderToolEvent[];
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

function createProbeArtifactSink(): ProviderArtifactSink {
  let index = 0;
  return {
    async persist(payload) {
      index += 1;
      const size = payload.bytes instanceof ArrayBuffer
        ? payload.bytes.byteLength
        : payload.bytes.byteLength;
      const id = payload.id?.trim() || `probe-artifact-${index}`;
      return {
        id,
        ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
        ...(payload.filename ? { filename: payload.filename } : {}),
        size,
        storageRef: `capability-probe://${id}`,
      };
    },
  };
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

async function resolveProbeRuntime(target: ProbeTarget): Promise<ProbeRuntimeContext> {
  const catalogEvidence = getPersistedProviderCapabilityEvidence(target.providerId, target.modelId);
  const runner = await getRunnerCapabilityPlanningContext(target.providerId, target.modelId);
  const custom = target.providerId === CUSTOM_PROVIDER_ID
    ? getCustomModelByFullId(target.fullModelId)
    : null;
  const customContext = custom ? customModelPlanningContext(custom) : undefined;
  const resourceState = await resolveToolRuntimeResourceStateCached();
  const profile = resolveProviderCapabilityProfile({
    providerId: target.providerId,
    modelId: target.modelId,
    catalogEvidence,
    runnerEvidence: runner.evidence,
    resourceState,
    customOverrides: customContext?.customOverrides,
  });
  return {
    catalogEvidence,
    runnerEvidence: runner.evidence,
    allowedTransports: customContext?.allowedTransports ?? runner.allowedTransports,
    customOverrides: customContext?.customOverrides,
    resourceState,
    toolProbes: buildToolCapabilityProbeDefinitions(profile),
  };
}

export async function getCapabilityLabProbeCatalog(fullModelId: string): Promise<CapabilityLabProbeCatalog> {
  const target = resolveProbeTarget(fullModelId);
  const runtime = await resolveProbeRuntime(target);
  return {
    generalProbes: CAPABILITY_PROBES.map((probe) => ({ ...probe })),
    toolProbes: runtime.toolProbes.map((probe) => ({
      ...probe,
      transports: [...probe.transports],
      missingPrerequisiteIds: [...probe.missingPrerequisiteIds],
    })),
  };
}
async function collectStream(
  stream: AsyncIterable<StreamChunk>
): Promise<CollectedProbeOutput> {
  let text = "";
  let chunks = 0;
  const toolCalls: NativeToolCall[] = [];
  const providerToolEvents: ProviderToolEvent[] = [];
  try {
    for await (const chunk of stream) {
      if (chunk.type === "error") {
        return {
          text,
          chunks,
          toolCalls,
          providerToolEvents,
          error: chunk.error ?? "Provider returned an error",
          errorMetadata: chunk.errorMetadata,
        };
      }
      if (chunk.type === "tool_call" && chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
      }
      if (chunk.type === "provider_tool_event" && chunk.providerToolEvent) {
        providerToolEvents.push(chunk.providerToolEvent);
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
      providerToolEvents,
      error: err instanceof Error ? err.message : "Provider request failed",
    };
  }
  return { text: text.trim(), chunks, toolCalls, providerToolEvents };
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
  return { id, status: "pass", detail, preview: outputPreview(output ?? { text: "", chunks: 0, toolCalls: [], providerToolEvents: [] }) };
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
    preview: outputPreview(output ?? { text: "", chunks: 0, toolCalls: [], providerToolEvents: [] }),
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
  functionTools?: NativeToolDefinition[];
  toolChoice?: "auto" | "required";
  callPlan?: ProviderCallPlan;
  artifactSink?: ProviderArtifactSink;
}): Promise<CollectedProbeOutput> {
  const { target } = input;
  if (target.providerId === CUSTOM_PROVIDER_ID) {
    const custom = getCustomModelByFullId(target.fullModelId);
    if (!custom) return { text: "", chunks: 0, toolCalls: [], providerToolEvents: [], error: "Custom model not found" };
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
        functionTools: input.functionTools,
        toolChoice: input.toolChoice,
        callPlan: input.callPlan,
        artifactSink: input.artifactSink,
      })
    );
  }

  const provider = getProvider(target.providerId);
  const key = getProviderKey(target.providerId);
  if (!provider || !key?.apiKey) return { text: "", chunks: 0, toolCalls: [], providerToolEvents: [], error: "Provider is not configured" };
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
      functionTools: input.functionTools,
      toolChoice: input.toolChoice,
      callPlan: input.callPlan,
      artifactSink: input.artifactSink,
    })
  );
}

function toolProbeMessages(capabilityId: ToolCapabilityId): ChatMessage[] {
  const instructions: Record<ToolCapabilityId, string> = {
    function_calling: "Call the aiboard_sum function with a=2 and b=3. Do not answer directly.",
    web_search: "You must use Web Search exactly once to search for the IANA Example Domain, then reply with AIBOARD_TOOL_OK.",
    web_fetch: "You must use Web Fetch exactly once on https://example.com/ and then reply with AIBOARD_TOOL_OK.",
    file_search: "You must use File Search exactly once against the configured store. Search for any occurrence of the word 'the'; even if there are no matches, use the tool before replying AIBOARD_TOOL_OK.",
    url_context: "You must use URL Context on https://example.com/ and then reply with AIBOARD_TOOL_OK.",
    maps: "You must use Maps to look up the Eiffel Tower and then reply with AIBOARD_TOOL_OK.",
    x_search: "You must use X Search once for recent posts mentioning xAI and then reply with AIBOARD_TOOL_OK.",
    code_execution: "You must use Code Execution to calculate 123457 * 76543, then reply with AIBOARD_TOOL_OK.",
    shell: "You must use the Shell tool for one read-only command that prints AIBOARD_SHELL_OK. Do not create, edit, or delete files.",
    apply_patch: "You must invoke the Apply Patch/editor tool once using the exact probe path .aiboard-capability-probe.txt. This is a capability invocation probe; do not perform any other edit.",
    computer_use: "You must use Computer Use once for a harmless observation-only action, then reply AIBOARD_TOOL_OK.",
    browser_use: "You must use Browser Use once to open https://example.com/ without submitting forms or changing data, then reply AIBOARD_TOOL_OK.",
    image_generation: "You must use Image Generation to create a simple blue square, then reply AIBOARD_TOOL_OK.",
    remote_mcp: "You must use the configured remote MCP server once. Prefer listing tools or a read-only operation and do not perform writes or external side effects. Then reply AIBOARD_TOOL_OK.",
    tool_search: "You must use Tool Search to find the deferred tool whose description says it returns the capability marker. Call that discovered tool rather than guessing its name.",
    advisor: "You must use the Advisor tool once to independently answer 2+3, then reply AIBOARD_TOOL_OK.",
    subagent: "You must use the Subagent tool once for the tiny task 'return the word probe', then reply AIBOARD_TOOL_OK.",
    fusion: "You must use the Fusion tool once to combine two tiny candidate answers ('alpha' and 'beta'), then reply AIBOARD_TOOL_OK.",
    datetime: "You must use the Date/Time tool once to obtain the current date or time, then reply AIBOARD_TOOL_OK.",
    memory: "You must use the Memory tool once for a read-only lookup. Do not write or change memory. Then reply AIBOARD_TOOL_OK.",
  };
  return [
    { role: "system", content: "You are running an AI Board tool capability probe. Use the requested tool; do not substitute prior knowledge or another tool." },
    { role: "user", content: instructions[capabilityId] },
  ];
}

function sumProbeTool(): NativeToolDefinition {
  return {
    name: "aiboard_sum",
    description: "Add two small integers for an AI Board capability probe.",
    parameters: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
    strict: true,
  };
}

function toolSearchProbeTools(): NativeToolDefinition[] {
  return Array.from({ length: 18 }, (_, index) => {
    const target = index === 11;
    return {
      name: target ? "aiboard_capability_marker" : `aiboard_deferred_${index + 1}`,
      description: target
        ? "The capability probe target. Returns the capability marker."
        : `Unrelated deferred capability probe tool ${index + 1}.`,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
      deferLoading: true,
    };
  });
}

function toolProbeIntent(target: ProbeTarget, capabilityId: ToolCapabilityId): ToolIntent {
  const settings = getToolRuntimeSettings();
  if (capabilityId === "remote_mcp") {
    const configured = configuredRemoteMcpIntent(settings.remoteMcpServer);
    if (configured) return { ...configured, requirement: "required" };
  }
  if (capabilityId === "file_search" && target.providerId === "openai") {
    const configured = configuredOpenAIFileSearchIntent(settings.openaiFileSearch);
    if (configured) return { ...configured, requirement: "required" };
  }
  if (capabilityId === "advisor" && target.providerId === "anthropic") {
    return { id: capabilityId, requirement: "required", parameters: { model: target.modelId } };
  }
  if (capabilityId === "web_search" || capabilityId === "web_fetch") {
    return { id: capabilityId, requirement: "required", parameters: { maxUses: 1 } };
  }
  if (capabilityId === "tool_search" && target.providerId === "anthropic") {
    return { id: capabilityId, requirement: "required", parameters: { variant: "regex" } };
  }
  return { id: capabilityId, requirement: "required" };
}

function toolProbeFunctionTools(capabilityId: ToolCapabilityId): NativeToolDefinition[] | undefined {
  if (capabilityId === "function_calling") return [sumProbeTool()];
  if (capabilityId === "tool_search") return toolSearchProbeTools();
  return undefined;
}

function toolProbeArguments(call: NativeToolCall): Record<string, unknown> {
  if (call.arguments && typeof call.arguments === "object") return call.arguments;
  if (!call.argumentsJson?.trim()) return {};
  try {
    const parsed = JSON.parse(call.argumentsJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
function unavailableToolProbeResult(definition: ToolCapabilityProbeDefinition): CapabilityProbeResult | undefined {
  const base = { id: definition.id, capabilityId: definition.capabilityId, execution: definition.execution };
  if (definition.readiness === "setup_required") {
    return { ...base, status: "setup_required", detail: definition.reason ?? "Required tool setup is missing." };
  }
  if (definition.readiness === "unsupported") {
    return { ...base, status: "unsupported", detail: "The resolved provider/model profile marks this tool unsupported." };
  }
  if (definition.readiness === "conditional") {
    return { ...base, status: "conditional", detail: "Tool support is conditional and has not been verified for this model/runtime." };
  }
  if (definition.readiness === "unknown") {
    return { ...base, status: "skipped", detail: "Tool support is unknown, so the Lab will not spend quota probing it implicitly." };
  }
  return undefined;
}

function resolveToolProbeCallPlan(
  target: ProbeTarget,
  runtime: ProbeRuntimeContext,
  capabilityId: ToolCapabilityId,
  functionTools?: NativeToolDefinition[],
): ProviderCallPlan {
  const requestedTools: ToolIntent[] = [toolProbeIntent(target, capabilityId)];
  if (capabilityId === "tool_search" && functionTools?.length) {
    requestedTools.push({ id: "function_calling", requirement: "optional" });
  }
  return resolveProviderCallPlan({
    context: {
      providerId: target.providerId,
      modelId: target.modelId,
      evidence: [...(runtime.catalogEvidence ?? []), ...(runtime.runnerEvidence ?? [])],
      allowedTransports: runtime.allowedTransports,
      customOverrides: runtime.customOverrides,
      resourceState: runtime.resourceState,
      features: {
        mode: "test",
        toolChoice: capabilityId === "function_calling" ? "required" : "auto",
      },
    },
    requestedTools,
  });
}

function matchingToolEvents(output: CollectedProbeOutput, capabilityId: ToolCapabilityId): ProviderToolEvent[] {
  return output.providerToolEvents.filter((event) => event.tool === capabilityId);
}

function clientProbeToolNames(capabilityId: ToolCapabilityId): string[] {
  if (capabilityId === "shell") return ["shell"];
  if (capabilityId === "apply_patch") return ["patch", "apply_patch"];
  if (capabilityId === "computer_use") return ["computer", "computer_use"];
  if (capabilityId === "browser_use") return ["browser", "browser_use"];
  if (capabilityId === "memory") return ["memory"];
  return [];
}

export function evaluateToolCapabilityProbeResult(
  definition: ToolCapabilityProbeDefinition,
  plan: ProviderCallPlan,
  output: CollectedProbeOutput,
): CapabilityProbeResult {
  const meta = {
    id: definition.id,
    capabilityId: definition.capabilityId,
    transport: plan.transport,
    execution: definition.execution,
  } as const;
  if (output.error) return { ...fail(definition.id, output.error, output), ...meta };

  if (definition.capabilityId === "function_calling") {
    const call = output.toolCalls.find((item) => item.name === "aiboard_sum");
    const args = call ? toolProbeArguments(call) : {};
    return call && args.a === 2 && args.b === 3
      ? { ...pass(definition.id, "Provider emitted the requested function call with the expected arguments.", output), ...meta }
      : { ...fail(definition.id, "Provider did not emit the requested aiboard_sum(2, 3) function call.", output), ...meta };
  }

  const events = matchingToolEvents(output, definition.capabilityId);
  const successfulEvent = events.find((event) => event.phase === "completed");
  const failedEvent = events.find((event) => event.phase === "failed");
  if (failedEvent && !successfulEvent) {
    return { ...fail(definition.id, `Provider reported a failed ${definition.label} event.`, output), ...meta };
  }

  if (definition.capabilityId === "image_generation" && successfulEvent) {
    const hasArtifact = events.some((event) => (event.artifacts?.length ?? 0) > 0);
    return hasArtifact
      ? { ...pass(definition.id, "Image Generation completed and returned a generated artifact.", output), ...meta }
      : { ...fail(definition.id, "Image Generation was invoked but no generated artifact was returned.", output), ...meta };
  }

  if (successfulEvent) {
    return {
      ...pass(definition.id, `${definition.label} emitted a verified ${successfulEvent.phase} provider event.`, output),
      ...meta,
    };
  }

  const clientNames = clientProbeToolNames(definition.capabilityId);
  const clientCall = output.toolCalls.find((call) => clientNames.includes(call.name));
  if (clientCall) {
    return { ...pass(definition.id, `${definition.label} emitted the expected client tool call (${clientCall.name}).`, output), ...meta };
  }

  if (definition.execution === "runner") {
    return {
      ...meta,
      status: "skipped",
      detail: `${definition.label} is runner-managed, but the current runner chat stream does not expose a tool-execution event that the Lab can verify.`,
      preview: outputPreview(output),
    };
  }
  return {
    ...fail(definition.id, `${definition.label} returned no matching provider event or client tool call, so the capability was not verified.`, output),
    ...meta,
  };
}

async function runToolCapabilityProbe(
  target: ProbeTarget,
  runtime: ProbeRuntimeContext,
  capabilityId: ToolCapabilityId,
): Promise<CapabilityProbeResult> {
  const definition = runtime.toolProbes.find((probe) => probe.capabilityId === capabilityId);
  if (!definition) {
    return { id: `tool:${capabilityId}`, status: "unsupported", detail: "The provider has no resolved descriptor for this tool." };
  }
  const unavailable = unavailableToolProbeResult(definition);
  if (unavailable) return unavailable;
  if (capabilityId === "remote_mcp") {
    return {
      id: definition.id,
      status: "skipped",
      detail: "Remote MCP automatic invocation is disabled for safety because a generic server may expose only mutating tools. Readiness verifies the configured server resource; add an explicitly safe probe tool before live MCP invocation is enabled.",
      capabilityId,
      execution: definition.execution,
    };
  }
  const functionTools = toolProbeFunctionTools(capabilityId);
  let plan: ProviderCallPlan;
  try {
    plan = resolveToolProbeCallPlan(target, runtime, capabilityId, functionTools);
  } catch (error) {
    const detail = error instanceof ProviderCallPlanError
      ? error.decisions.map((decision) => decision.reason).join(" ") || error.message
      : error instanceof Error ? error.message : "Tool preflight failed";
    return { id: definition.id, status: "fail", detail, capabilityId, execution: definition.execution };
  }
  const output = await runProbeCall({
    target,
    messages: toolProbeMessages(capabilityId),
    maxTokens: 384,
    functionTools,
    toolChoice: capabilityId === "function_calling" ? "required" : "auto",
    callPlan: plan,
    artifactSink: createProbeArtifactSink(),
  });
  return evaluateToolCapabilityProbeResult(definition, plan, output);
}

async function runBuildProtocolProbe(
  target: ProbeTarget,
  runtime: ProbeRuntimeContext,
): Promise<CapabilityProbeResult> {
  const functionDefinition = runtime.toolProbes.find((probe) => probe.capabilityId === "function_calling");
  if (!functionDefinition) {
    return { id: "buildProtocol", status: "unsupported", detail: "AI Board Build Protocol requires Function Calling." };
  }
  const unavailable = unavailableToolProbeResult(functionDefinition);
  if (unavailable) {
    return { id: "buildProtocol", status: unavailable.status, detail: `Build Protocol requires Function Calling. ${unavailable.detail}` };
  }
  const repoStatus = buildNativeBuildToolDefinitions("worker").find((tool) => tool.name === "repo_status");
  if (!repoStatus) return { id: "buildProtocol", status: "fail", detail: "AI Board repo_status Build tool is unavailable." };
  let plan: ProviderCallPlan;
  try {
    plan = resolveToolProbeCallPlan(target, runtime, "function_calling", [repoStatus]);
  } catch (error) {
    return {
      id: "buildProtocol",
      status: "fail",
      detail: error instanceof Error ? error.message : "Build Protocol preflight failed",
    };
  }
  const output = await runProbeCall({
    target,
    messages: [
      { role: "system", content: "You are running an AI Board Build Protocol probe. Use the provided typed Build tool exactly as requested." },
      { role: "user", content: "Call repo_status exactly once. Do not answer with prose and do not call any mutating tool." },
    ],
    maxTokens: 256,
    functionTools: [repoStatus],
    toolChoice: "required",
    callPlan: plan,
  });
  if (output.error) return fail("buildProtocol", output.error, output);
  const call = output.toolCalls.find((item) => item.name === "repo_status");
  if (!call) return fail("buildProtocol", "Model did not emit the required repo_status Build tool call.", output);
  try {
    const actionText = nativeToolCallsToActionText([call]);
    const action = JSON.parse(actionText) as { action?: unknown };
    return action.action === "repo_status"
      ? pass("buildProtocol", "Model emitted repo_status and AI Board converted it into the canonical Build action stream.", output)
      : fail("buildProtocol", "Build tool call did not convert to the expected canonical action.", output);
  } catch (error) {
    return fail("buildProtocol", error instanceof Error ? error.message : "Build action conversion failed", output);
  }
}
async function runOneProbe(
  target: ProbeTarget,
  runtime: ProbeRuntimeContext,
  id: CapabilityProbeId
): Promise<CapabilityProbeResult> {
  const toolCapabilityId = parseToolCapabilityProbeId(id);
  if (toolCapabilityId) return runToolCapabilityProbe(target, runtime, toolCapabilityId);
  if (id === "buildProtocol") return runBuildProtocolProbe(target, runtime);
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
        providerToolEvents: [...a.providerToolEvents, ...b.providerToolEvents],
        error: a.error ?? b.error,
      });
    }
    return a.text.includes("AIBOARD_CONCURRENCY_A") && b.text.includes("AIBOARD_CONCURRENCY_B")
      ? pass(id, "Two parallel requests completed successfully", {
          text: `${a.text}\n${b.text}`,
          chunks: a.chunks + b.chunks,
          toolCalls: [...a.toolCalls, ...b.toolCalls],
          providerToolEvents: [...a.providerToolEvents, ...b.providerToolEvents],
        })
      : fail(id, "Parallel requests completed but expected markers were missing", {
          text: `${a.text}\n${b.text}`,
          chunks: a.chunks + b.chunks,
          toolCalls: [...a.toolCalls, ...b.toolCalls],
          providerToolEvents: [...a.providerToolEvents, ...b.providerToolEvents],
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
  const runtime = await resolveProbeRuntime(target);
  const validProbeIds = new Set<CapabilityProbeId>([
    ...CAPABILITY_PROBES.map((probe) => probe.id),
    ...runtime.toolProbes.map((probe) => probe.id),
  ]);
  const probeIds = input.probeIds.filter((id) => validProbeIds.has(id));
  const profile = defaultCapabilityProfile(
    target.fullModelId,
    target.providerId,
    target.modelInfo,
  );

  const results: CapabilityProbeResult[] = [];
  for (const id of probeIds) {
    results.push(await runOneProbe(target, runtime, id));
  }
  profile.results = results;
  profile.capabilities.text = results.some((r) => r.id === "text" && r.status === "pass");
  profile.capabilities.structuredOutput = results.some(
    (r) => r.id === "structuredOutput" && r.status === "pass",
  );
  profile.capabilities.streaming = results.some((r) => r.id === "streaming" && r.status === "pass");
  profile.capabilities.imageInput = results.some((r) => r.id === "imageInput" && r.status === "pass");
  profile.capabilities.documentInput = results.some((r) => r.id === "documentInput" && r.status === "pass");
  const functionCallingPassed = results.some(
    (r) => r.id === "tool:function_calling" && r.status === "pass",
  );
  profile.capabilities.toolCalls = functionCallingPassed;
  profile.capabilities.functionCalling = functionCallingPassed;
  profile.capabilities.buildProtocol = results.some(
    (r) => r.id === "buildProtocol" && r.status === "pass",
  );
  profile.capabilities.toolCapabilities = Object.fromEntries(
    results.flatMap((result) => {
      const capabilityId = parseToolCapabilityProbeId(result.id);
      return capabilityId ? [[capabilityId, result.status]] : [];
    }),
  );
  profile.capabilities.temperature = results.some((r) => r.id === "temperature" && r.status === "pass");
  profile.capabilities.maxTokens = results.some((r) => r.id === "maxTokens" && r.status === "pass");
  profile.capabilities.parallelRequests = results.some((r) => r.id === "concurrency" && r.status === "pass")
    ? 2
    : 1;

  saveCapabilityProfile(profile);
  const evidence = results.flatMap((result) => {
    const capabilityId = parseToolCapabilityProbeId(result.id);
    if (!capabilityId || !result.transport) return [];
    const item = capabilityEvidenceFromToolProbe({
      providerId: target.providerId,
      modelId: target.modelId,
      transport: result.transport,
      execution: result.execution,
      testedAt: profile.testedAt,
      expiresAt: profile.expiresAt,
      result,
    });
    return item ? [item] : [];
  });
  if (evidence.length > 0) {
    updateUserSettings({
      providerToolCapabilityEvidence: mergeCapabilityEvidenceRecords(
        getUserSettings().providerToolCapabilityEvidence,
        evidence,
      ),
    });
  }
  return profile;
}
