/**
 * Browser engine — a port of lib/orchestrator/engine.ts that reads/writes the
 * client store and calls providers in-browser. Same logic; the only differences
 * are the data layer (client store) and that events go to an `emit` callback
 * (no SSE). The OrchestratorEvent type is reused (type-only) from the server
 * engine so the UI keeps a single definition.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  DiscussionMode,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import {
  getBuildCheckpoint,
  getDiscussionById,
  getMessagesForDiscussion,
  insertFinalResult,
  insertMessage,
  updateDiscussion,
  upsertBuildCheckpoint,
} from "./store";
import {
  CUSTOM_PROVIDER_ID,
  getCustomModelByFullId,
  customModelPlanningContext,
  getDecryptedApiKey,
  getPersistedProviderCapabilityEvidence,
  getProvider,
  getProviderBaseURL,
  getProviderRunnerToken,
  getRunnerCapabilityPlanningContext,
  resolveClientModelContextProfile,
  resolveModelCapabilities,
  streamCustomChat,
} from "./providers";
import {
  parseModelId,
  type AIProvider,
  type ChatMessage,
  type ChatParams,
  type ModelContextProfile,
  type NativeToolCall,
  type SelectedModel,
  type StreamChunk,
  type StreamUsage,
  type StructuredOutputFormat,
} from "@/lib/providers/base";
import {
  clampJudgeMaxTokens,
  EFFORT_CONFIG,
} from "@/lib/orchestrator/config";
import {
  assessJudgeOutput,
  extractJudgeResult,
} from "@/lib/orchestrator/parse";
import {
  buildConvergencePrompt,
  buildConvergenceVoteResponseFormat,
  buildJudgePrompt,
  buildRoundSystemPrompt,
  buildTranscriptFromMessages,
  buildUserPrompt,
  buildVerbosityInstruction,
} from "@/lib/orchestrator/prompts";
import { loadAttachmentPayloads } from "./attachments";
import type { AttachmentPayload } from "@/lib/attachments/types";
import { buildAttachmentPromptSection } from "@/lib/attachments/prompt-text";
import { modelSupportsInputTypes } from "@/lib/providers/capabilities";
import type { OrchestratorEvent } from "@/lib/orchestrator/engine";
import {
  mergeStreamUsage,
  resolveModelCallUsage,
  type ResolvedTokenUsage,
} from "./token-usage";
import {
  createGameModelCallTrace,
  type GameAIDiagnosticLike,
  recordBenchmarkModelCallTrace,
} from "@/lib/benchmark/model-call-traces";
import {
  webSearchToolIntent,
  withWebSearchCapabilityNote,
} from "@/lib/providers/web-search";
import {
  mergeNativeToolActionContent,
  nativeToolCallsToActionText,
} from "@/lib/orchestrator/build";
import type { ProviderArtifactSink, ProviderToolEvent } from "@/lib/providers/provider-events";
import { resolveProviderCallPlan } from "@/lib/providers/call-planner";
import {
  buildProviderToolRequest,
  type ProviderToolRequest,
} from "@/lib/providers/tool-request";
import type {
  CapabilityEvidence,
  ProviderTransportId,
  ToolCapabilityDescriptor,
  ToolResourceState,
} from "@/lib/providers/tool-capabilities";
import {
  applyToolRuntimeToRequest,
  resolveToolRuntimeResourceStateCached,
} from "./tool-runtime";

export type { OrchestratorEvent } from "@/lib/orchestrator/engine";

type EventCallback = (event: OrchestratorEvent) => void;
type StructuredTraceValidation =
  | { ok: true; parsedResponseJson?: string }
  | { ok: false; message: string };
export interface CollectedStreamResult {
  content: string;
  reportedUsage?: StreamUsage;
  finishReason?: string;
  providerToolEvents?: ProviderToolEvent[];
}

export function clientToolCallFromChunk(chunk: StreamChunk): NativeToolCall | undefined {
  return chunk.type === "tool_call" ? chunk.toolCall : undefined;
}

export function providerToolEventFromChunk(
  chunk: StreamChunk
): ProviderToolEvent | undefined {
  return chunk.type === "provider_tool_event" ? chunk.providerToolEvent : undefined;
}

export interface ProviderPreflightOverrides {
  evidence?: CapabilityEvidence[];
  allowedTransports?: ProviderTransportId[];
  customOverrides?: ToolCapabilityDescriptor[];
  resourceState?: ToolResourceState;
  mode?: "discussion" | "build" | "benchmark" | "test";
}

function normalizedToolChoice(params: ChatParams) {
  const choice = params.toolChoice;
  if (choice === undefined) return "auto" as const;
  if (typeof choice === "string") return choice;
  return { name: choice.name };
}

function inferredCallMode(
  params: ChatParams,
  explicit: ProviderPreflightOverrides["mode"],
): NonNullable<ProviderPreflightOverrides["mode"]> {
  if (explicit) return explicit;
  return params.functionTools?.length ? "build" : "discussion";
}

function enabledCapabilitySet(params: ChatParams): Set<string> {
  return new Set(params.callPlan?.enabledTools.map((tool) => tool.intent.id) ?? []);
}

function callPlanEnables(params: ChatParams, capabilityId: string): boolean {
  return params.callPlan?.enabledTools.some((tool) => tool.intent.id === capabilityId) === true;
}

function optionalWebSearchRequest(allowWebSearch = true): ProviderToolRequest {
  const intent = webSearchToolIntent({ allowWebSearch });
  return buildProviderToolRequest({ toolIntents: intent ? [intent] : [] });
}

export function preflightProviderChatParams(
  providerId: string,
  params: ChatParams,
  overrides: ProviderPreflightOverrides = {},
): ChatParams {
  const normalized = buildProviderToolRequest(params);
  const callPlan = resolveProviderCallPlan({
    context: {
      providerId,
      modelId: params.model,
      evidence: overrides.evidence,
      allowedTransports: overrides.allowedTransports,
      customOverrides: overrides.customOverrides,
      resourceState: overrides.resourceState,
      features: {
        structuredOutput: Boolean(params.structuredOutput),
        reasoning:
          params.reasoningEffort !== undefined &&
          params.reasoningEffort !== "default" &&
          params.reasoningEffort !== "none",
        attachments: Boolean(params.attachments?.length),
        parallelTools: false,
        toolChoice: normalizedToolChoice(params),
        mode: inferredCallMode(params, overrides.mode),
      },
    },
    requestedTools: normalized.toolIntents,
  });
  const prepared: ChatParams = {
    ...params,
    toolIntents: normalized.toolIntents,
    toolInventory: normalized.toolInventory,
    callPlan,
  };
  const enabled = enabledCapabilitySet(prepared);
  prepared.functionTools = enabled.has("function_calling") ? params.functionTools : undefined;
  return prepared;
}

export function streamProviderWithPreflight(
  provider: AIProvider,
  providerId: string,
  params: ChatParams,
  overrides: ProviderPreflightOverrides = {},
): AsyncIterable<StreamChunk> {
  return provider.streamChat(preflightProviderChatParams(providerId, params, overrides));
}

function discoveredCapabilityEvidence(
  providerId: string,
  model: string,
): CapabilityEvidence[] | undefined {
  return getPersistedProviderCapabilityEvidence(providerId, model);
}

const runningDiscussions = new Set<string>();
const abortControllers = new Map<string, AbortController>();

export function isDiscussionRunning(id: string): boolean {
  return runningDiscussions.has(id);
}

/** Stop a running discussion/build. The engine winds down at the next token. */
export function stopDiscussion(id: string): void {
  abortControllers.get(id)?.abort();
}

export function abortError(): DOMException {
  return new DOMException("Stopped by the user", "AbortError");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

// ── Transient-error retry ─────────────────────────────────────────────────────
// Provider hiccups (503 high demand, 429 rate limits, network blips) shouldn't
// kill a whole run. Retried with backoff — but only while NOTHING has been
// streamed yet, so the UI never sees duplicated tokens.

const TRANSIENT_ERROR =
  /\b(408|409|429|500|502|503|504|529)\b|overloaded|rate.?limit|high demand|temporar|timeout|timed out|network|fetch failed|failed to fetch|econn|socket|unavailable|try again/i;

function isTransientError(err: unknown): boolean {
  return err instanceof Error && TRANSIENT_ERROR.test(err.message);
}

const RETRY_DELAYS_MS = [2_000, 6_000];

/**
 * Run `attempt` with retries on transient errors. `hasOutput` guards against
 * retrying a stream that already emitted tokens (which would duplicate them).
 */
async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  hasOutput: () => boolean,
  label: string,
  signal?: AbortSignal,
  onRetry?: (retry: { attempt: number; delayMs: number; message: string }) => void
): Promise<T> {
  for (let tryNo = 0; ; tryNo++) {
    try {
      return await attempt();
    } catch (err) {
      if (
        isAbortError(err) ||
        hasOutput() ||
        tryNo >= RETRY_DELAYS_MS.length ||
        !isTransientError(err)
      ) {
        throw err;
      }
      console.warn(
        `[engine] transient error from ${label} — retrying in ${RETRY_DELAYS_MS[tryNo] / 1000}s (${tryNo + 1}/${RETRY_DELAYS_MS.length}):`,
        err instanceof Error ? err.message : err
      );
      onRetry?.({
        attempt: tryNo + 1,
        delayMs: RETRY_DELAYS_MS[tryNo],
        message: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[tryNo])
      );
      if (signal?.aborted) throw abortError();
    }
  }
}

export async function collectStream(
  modelId: string,
  providerId: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  reasoningEffort: ReasoningEffort,
  attachments: AttachmentPayload[],
  onToken?: (token: string) => void,
  signal?: AbortSignal,
  stopWhen?: (content: string) => boolean,
  structuredOutput?: StructuredOutputFormat,
  onProviderRetry?: (retry: {
    attempt: number;
    delayMs: number;
    message: string;
  }) => void,
  contextProfile?: ModelContextProfile,
  toolRequest: ProviderToolRequest = { toolIntents: [], toolInventory: [] },
  artifactSink?: ProviderArtifactSink
): Promise<string> {
  const result = await collectStreamWithUsage(
    modelId,
    providerId,
    model,
    messages,
    maxTokens,
    temperature,
    reasoningEffort,
    attachments,
    onToken,
    signal,
    stopWhen,
    structuredOutput,
    onProviderRetry,
    contextProfile,
    toolRequest,
    artifactSink
  );
  return result.content;
}

export async function collectStreamWithUsage(
  modelId: string,
  providerId: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  reasoningEffort: ReasoningEffort,
  attachments: AttachmentPayload[],
  onToken?: (token: string) => void,
  signal?: AbortSignal,
  stopWhen?: (content: string) => boolean,
  structuredOutput?: StructuredOutputFormat,
  onProviderRetry?: (retry: {
    attempt: number;
    delayMs: number;
    message: string;
  }) => void,
  contextProfile?: ModelContextProfile,
  toolRequest: ProviderToolRequest = { toolIntents: [], toolInventory: [] },
  artifactSink?: ProviderArtifactSink
): Promise<CollectedStreamResult> {
  if (signal?.aborted) throw abortError();
  const effectiveToolRequest = applyToolRuntimeToRequest(toolRequest);
  const needsLocalRunner = effectiveToolRequest.toolIntents.some(
    (intent) => intent.id === "shell" || intent.id === "apply_patch",
  );
  const runtimeResourceState = await resolveToolRuntimeResourceStateCached({
    checkRunnerHealth: needsLocalRunner,
  });
  if (providerId === CUSTOM_PROVIDER_ID) {
    const customModel = getCustomModelByFullId(modelId);
    if (!customModel) {
      throw new Error("Custom model not found");
    }
    const customCaps = customModel.capabilities ?? {
      image: false,
      document: false,
      audio: false,
      video: false,
    };
    const customAttachments = attachments.filter(
      (a) => a.category !== "text_inline" && customCaps[a.category]
    );
    const customParams = preflightProviderChatParams(
      CUSTOM_PROVIDER_ID,
      {
        apiKey: "",
        model: customModel.model,
        messages,
        attachments: customAttachments,
        maxTokens,
        temperature,
        reasoningEffort,
        structuredOutput,
        contextProfile,
        ...effectiveToolRequest,
        artifactSink,
      },
      customModelPlanningContext(customModel),
    );
    customParams.messages = callPlanEnables(customParams, "web_search")
      ? withWebSearchCapabilityNote(messages)
      : messages;
    let customContent = "";
    let customNativeActionContent = "";
    let customReportedUsage: StreamUsage | undefined;
    let customFinishReason: string | undefined;
    const customProviderToolEvents: ProviderToolEvent[] = [];
    return withTransientRetry(
      async () => {
        for await (const chunk of streamCustomChat(customModel, customParams)) {
          if (signal?.aborted) throw abortError();
          if (
            chunk.type === "token" &&
            chunk.content &&
            !customNativeActionContent
          ) {
            customContent += chunk.content;
            onToken?.(chunk.content);
            if (stopWhen?.(customContent)) break;
          }
          const clientToolCall = clientToolCallFromChunk(chunk);
          if (clientToolCall) {
            const actionText = nativeToolCallsToActionText([clientToolCall]);
            if (actionText) {
              const merged = mergeNativeToolActionContent({
                content: customContent,
                nativeActionContent: customNativeActionContent,
                actionText,
              });
              customContent = merged.content;
              customNativeActionContent = merged.nativeActionContent;
              onToken?.(actionText);
            }
          }
          const providerEvent = providerToolEventFromChunk(chunk);
          if (providerEvent) customProviderToolEvents.push(providerEvent);
          if (chunk.type === "usage") {
            customReportedUsage = mergeStreamUsage(
              customReportedUsage,
              chunk.usage
            );
          }
          if (chunk.type === "done" && chunk.finishReason) {
            customFinishReason = chunk.finishReason;
          }
          if (chunk.type === "error") {
            throw new Error(chunk.error ?? "Stream error");
          }
        }
        return {
          content: customContent,
          ...(customReportedUsage ? { reportedUsage: customReportedUsage } : {}),
          ...(customFinishReason ? { finishReason: customFinishReason } : {}),
          ...(customProviderToolEvents.length > 0
            ? { providerToolEvents: [...customProviderToolEvents] }
            : {}),
        };
      },
      () => customContent.length > 0,
      modelId,
      signal,
      onProviderRetry
    );
  }

  const provider = getProvider(providerId);
  const apiKey = getDecryptedApiKey(providerId);
  if (!provider || !apiKey) {
    throw new Error(`Provider ${providerId} is not configured`);
  }

  // Foundry models (and any future gateway provider) aren't in the static
  // capability registry — resolve their caps explicitly.
  const resolvedCaps = resolveModelCapabilities(modelId);
  const modelAttachments = attachments.filter((a) => {
    if (a.category === "text_inline") return true;
    return resolvedCaps
      ? resolvedCaps[a.category]
      : modelSupportsInputTypes(modelId, [a.category]);
  });
  const runnerContext = await getRunnerCapabilityPlanningContext(
    providerId,
    model,
    signal,
  );
  const evidence = [
    ...(discoveredCapabilityEvidence(providerId, model) ?? []),
    ...(runnerContext.evidence ?? []),
  ];
  const providerParams = preflightProviderChatParams(
    providerId,
    {
      apiKey,
      baseURL: getProviderBaseURL(providerId),
      runnerToken: getProviderRunnerToken(providerId),
      model,
      messages,
      attachments: modelAttachments,
      maxTokens,
      temperature,
      reasoningEffort,
      structuredOutput,
      ...effectiveToolRequest,
      artifactSink,
      contextProfile,
      ...(resolvedCaps ? { capabilities: resolvedCaps } : {}),
    },
    {
      ...(evidence.length > 0 ? { evidence } : {}),
      allowedTransports: runnerContext.allowedTransports,
      resourceState: runtimeResourceState,
    },
  );
  providerParams.messages = callPlanEnables(providerParams, "web_search")
    ? withWebSearchCapabilityNote(messages)
    : messages;

  let content = "";
  let nativeActionContent = "";
  let reportedUsage: StreamUsage | undefined;
  let finishReason: string | undefined;
  const providerToolEvents: ProviderToolEvent[] = [];
  return withTransientRetry(
    async () => {
      for await (const chunk of provider.streamChat(providerParams)) {
        if (signal?.aborted) throw abortError();
        if (chunk.type === "token" && chunk.content && !nativeActionContent) {
          content += chunk.content;
          onToken?.(chunk.content);
          if (stopWhen?.(content)) break;
        }
        const clientToolCall = clientToolCallFromChunk(chunk);
        if (clientToolCall) {
          const actionText = nativeToolCallsToActionText([clientToolCall]);
          if (actionText) {
            const merged = mergeNativeToolActionContent({
              content,
              nativeActionContent,
              actionText,
            });
            content = merged.content;
            nativeActionContent = merged.nativeActionContent;
            onToken?.(actionText);
          }
        }
        const providerEvent = providerToolEventFromChunk(chunk);
        if (providerEvent) providerToolEvents.push(providerEvent);
        if (chunk.type === "usage") {
          reportedUsage = mergeStreamUsage(reportedUsage, chunk.usage);
        }
        if (chunk.type === "done" && chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
        if (chunk.type === "error") {
          throw new Error(chunk.error ?? "Stream error");
        }
      }
      return {
        content,
        ...(reportedUsage ? { reportedUsage } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(providerToolEvents.length > 0
          ? { providerToolEvents: [...providerToolEvents] }
          : {}),
      };
    },
    () => content.length > 0,
    modelId,
    signal,
    onProviderRetry
  );
}

function parseJsonResponse<T>(text: string): T | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

function wordOverlapSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function resolveModels(modelIds: string[]): SelectedModel[] {
  return modelIds.map((fullId) => {
    const { providerId, model } = parseModelId(fullId);
    const contextProfile = resolveClientModelContextProfile(fullId);
    if (providerId === CUSTOM_PROVIDER_ID) {
      const customModel = getCustomModelByFullId(fullId);
      return {
        modelId: fullId,
        providerId,
        displayName: customModel?.label ?? model,
        contextProfile,
      };
    }
    const provider = getProvider(providerId);
    const modelInfo = provider?.listModels().find((m) => m.id === model);
    return {
      modelId: fullId,
      providerId,
      displayName: modelInfo?.name ?? model,
      contextProfile,
    };
  });
}

export async function runDiscussion(
  discussionId: string,
  emit: EventCallback,
  _hooks?: unknown
): Promise<void> {
  if (runningDiscussions.has(discussionId)) {
    return;
  }

  runningDiscussions.add(discussionId);
  const controller = new AbortController();
  abortControllers.set(discussionId, controller);
  const signal = controller.signal;

  try {
    const discussion = getDiscussionById(discussionId);
    if (!discussion) {
      emit({ type: "error", message: "Discussion not found" });
      return;
    }

    const modelIds: string[] = JSON.parse(discussion.modelIds);
    const models = resolveModels(modelIds);
    const effort = discussion.effort as EffortLevel;
    const mode = discussion.mode as DiscussionMode;

    if (mode === "build") {
      const { runNativeBuildDiscussion } = await import("./native-build-engine");
      await runNativeBuildDiscussion(discussion, emit, signal);
      return;
    }

    const config = EFFORT_CONFIG[effort];
    const verbosity = (discussion.verbosity ?? "balanced") as Verbosity;
    const verbosityInstruction = buildVerbosityInstruction(
      verbosity,
      discussion.styleNote
    );
    const reasoningEffort = (discussion.reasoningEffort ??
      "default") as ReasoningEffort;
    const roundMaxTokens = config.maxTokens;
    const configuredJudgeMaxTokens = config.judgeMaxTokens;
    const skipConvergenceVote = config.skipConvergenceVote;
    const modelNames = Object.fromEntries(
      models.map((m) => [m.modelId, m.displayName])
    );
    const emitTokenUsage = (input: {
      messageId: string;
      modelId: string;
      modelName: string;
      providerId: string;
      round: number;
      label: string;
      usage: ResolvedTokenUsage;
    }): void => {
      emit({
        type: "token_usage",
        messageId: input.messageId,
        modelId: input.modelId,
        modelName: input.modelName,
        providerId: input.providerId,
        round: input.round,
        label: input.label,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        totalTokens: input.usage.totalTokens,
        maxTokens: input.usage.maxTokens,
        estimated: input.usage.estimated,
        usageSource: input.usage.usageSource,
        reasoningTokens: input.usage.reasoningTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
        inputAudioTokens: input.usage.inputAudioTokens,
        outputAudioTokens: input.usage.outputAudioTokens,
        providerCost: input.usage.providerCost,
        providerCostUnit: input.usage.providerCostUnit,
      });
    };

    const runTracedModelCall = async (input: {
      modelId: string;
      providerId: string;
      rawModel: string;
      label: string;
      messages: ChatMessage[];
      maxTokens: number;
      temperature: number;
      reasoningEffort: ReasoningEffort;
      attachments: AttachmentPayload[];
      onToken?: (token: string) => void;
      signal?: AbortSignal;
      stopWhen?: (content: string) => boolean;
      structuredOutput?: StructuredOutputFormat;
      validateStructuredOutput?: (output: string) => StructuredTraceValidation;
    }): Promise<{
      output: string;
      usage: ResolvedTokenUsage;
      finishReason?: string;
    }> => {
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      const promptText = input.messages
        .map((message) => `${message.role}:\n${message.content}`)
        .join("\n\n");
      const diagnostics: GameAIDiagnosticLike[] = [];

      try {
        const collected = await collectStreamWithUsage(
          input.modelId,
          input.providerId,
          input.rawModel,
          input.messages,
          input.maxTokens,
          input.temperature,
          input.reasoningEffort,
          input.attachments,
          input.onToken,
          input.signal,
          input.stopWhen,
          input.structuredOutput,
          (retry) =>
            diagnostics.push({
              attempt: retry.attempt,
              type: "request",
              message: `Transient provider error; retrying in ${retry.delayMs}ms: ${retry.message}`,
            }),
          undefined,
          optionalWebSearchRequest(true)
        );
        const output = collected.content;
        const usage = resolveModelCallUsage({
          messages: input.messages,
          output,
          maxTokens: input.maxTokens,
          reportedUsage: collected.reportedUsage,
        });
        const validation = input.validateStructuredOutput?.(output);
        const traceParsedJson =
          validation?.ok === true
            ? validation.parsedResponseJson ?? output
            : validation?.ok === false
              ? undefined
              : input.structuredOutput
                ? output
                : undefined;
        const traceStatus =
          validation?.ok === false ? "parse_error" : "parsed";
        await recordBenchmarkModelCallTrace(
          createGameModelCallTrace({
            modelId: input.modelId,
            providerId: input.providerId,
            participantId: input.label,
            reasoningEffort: input.reasoningEffort,
            schemaMode: input.structuredOutput ? "structured" : "text",
            promptText,
            startedAt,
            completedAt: new Date().toISOString(),
            latencyMs: Date.now() - startMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            usageSource: usage.usageSource,
            reasoningTokens: usage.reasoningTokens,
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            inputAudioTokens: usage.inputAudioTokens,
            outputAudioTokens: usage.outputAudioTokens,
            providerCost: usage.providerCost,
            providerCostUnit: usage.providerCostUnit,
            rawResponse: output,
            parsedResponseJson: traceParsedJson,
            diagnostics,
            finalStatus: traceStatus,
            error: validation?.ok === false ? validation.message : undefined,
          })
        );
        return { output, usage, finishReason: collected.finishReason };
      } catch (error) {
        await recordBenchmarkModelCallTrace(
          createGameModelCallTrace({
            modelId: input.modelId,
            providerId: input.providerId,
            participantId: input.label,
            reasoningEffort: input.reasoningEffort,
            schemaMode: input.structuredOutput ? "structured" : "text",
            promptText,
            startedAt,
            completedAt: new Date().toISOString(),
            latencyMs: Date.now() - startMs,
            diagnostics: [
              ...diagnostics,
              {
                attempt: diagnostics.length + 1,
                type: "request",
                message: error instanceof Error ? error.message : String(error),
              },
            ],
            finalStatus: "provider_error",
            error: error instanceof Error ? error.message : String(error),
          })
        );
        throw error;
      }
    };

    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `Starting discussion with ${models.length} model${models.length === 1 ? "" : "s"}`,
    });

    const attachmentIds: string[] = discussion.attachmentIds
      ? JSON.parse(discussion.attachmentIds)
      : [];
    const allAttachments = loadAttachmentPayloads(attachmentIds);
    const inlineAttachmentText = buildAttachmentPromptSection(
      allAttachments.filter((a) => a.category === "text_inline")
    );

    updateDiscussion(discussionId, {
      status: "running",
      maxRounds: config.maxRounds,
      updatedAt: new Date().toISOString(),
    });

    emit({ type: "status", status: "running", round: 0, maxRounds: config.maxRounds });

    // Resume support: responses persist per (round, model), so after a failure
    // (e.g. a network error during judging) we keep what's already saved, skip
    // those turns, and continue from the first missing one.
    const allMessages: Array<{
      id: string;
      round: number;
      modelId: string;
      content: string;
    }> = getMessagesForDiscussion(discussionId)
      .filter((m) => m.role === "assistant")
      .map((m) => ({
        id: m.id,
        round: m.round,
        modelId: m.modelId,
        content: m.content,
      }));
    const resumeRound = allMessages.reduce((max, m) => Math.max(max, m.round), 0);
    const startRound = Math.max(1, resumeRound);
    if (resumeRound > 0) {
      emit({
        type: "diagnostic",
        phase: "initializing",
        message: `Resuming from round ${resumeRound} — keeping ${allMessages.length} earlier response${allMessages.length === 1 ? "" : "s"}`,
      });
    }

    let previousRoundTexts: string[] = [];
    let shouldStopEarly = false;

    for (let round = startRound; round <= config.maxRounds; round++) {
      if (shouldStopEarly) break;
      if (signal.aborted) throw abortError();

      emit({
        type: "diagnostic",
        phase: "round_preparing",
        round,
        message: `Preparing round ${round} of ${config.maxRounds}`,
      });

      updateDiscussion(discussionId, {
        currentRound: round,
        updatedAt: new Date().toISOString(),
      });

      emit({ type: "status", status: "running", round, maxRounds: config.maxRounds });

      // The specialist lead is pinned to the first selected model for the whole
      // discussion — rotating it would tell a different model each round to
      // "revise your draft" for a draft it never wrote.
      const leadIndex = 0;
      const currentRoundTexts: string[] = [];

      for (let index = 0; index < models.length; index++) {
        const model = models[index];

        if (mode === "specialist" && round === 1 && index !== leadIndex) {
          continue;
        }

        // Already answered this round before a resume — keep the saved response.
        if (
          allMessages.some(
            (m) => m.round === round && m.modelId === model.modelId
          )
        ) {
          continue;
        }

        const transcript = buildTranscriptFromMessages(allMessages, modelNames);
        const systemPrompt = buildRoundSystemPrompt(
          mode,
          round,
          config.maxRounds,
          models,
          index,
          leadIndex,
          verbosityInstruction
        );

        const messageId = uuidv4();
        emit({
          type: "message_start",
          messageId,
          modelId: model.modelId,
          modelName: model.displayName,
          round,
          role: "assistant",
        });

        const { providerId, model: modelName } = parseModelId(model.modelId);
        emit({
          type: "diagnostic",
          phase: "model_connecting",
          round,
          modelId: model.modelId,
          modelName: model.displayName,
          providerId,
          message: `Connecting to ${model.displayName} via ${providerId}`,
        });

        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: buildUserPrompt(
              discussion.topic,
              transcript,
              inlineAttachmentText
            ),
          },
        ];

        const roundAttachments = round === 1 ? allAttachments : [];

        try {
          emit({
            type: "diagnostic",
            phase: "model_streaming",
            round,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            message: `${model.displayName} is generating a response`,
          });

          const { output: content, usage } = await runTracedModelCall({
            modelId: model.modelId,
            providerId,
            rawModel: modelName,
            label: `${model.displayName} round ${round}`,
            messages,
            maxTokens: roundMaxTokens,
            temperature: config.temperature,
            reasoningEffort,
            attachments: roundAttachments,
            onToken: (token) => emit({ type: "message_token", messageId, token }),
            signal,
          });
          emitTokenUsage({
            messageId,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            round,
            label: `${model.displayName} round ${round}`,
            usage,
          });

          insertMessage({
            id: messageId,
            discussionId,
            round,
            modelId: model.modelId,
            role: "assistant",
            content,
            createdAt: new Date().toISOString(),
          });

          allMessages.push({ id: messageId, round, modelId: model.modelId, content });
          currentRoundTexts.push(content);

          emit({
            type: "diagnostic",
            phase: "model_completed",
            round,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            message: `${model.displayName} finished round ${round}`,
          });

          emit({ type: "message_complete", messageId, content });
        } catch (err) {
          if (isAbortError(err)) throw err;
          emit({
            type: "diagnostic",
            phase: "model_failed",
            round,
            modelId: model.modelId,
            modelName: model.displayName,
            providerId,
            message: `${model.displayName} failed: ${err instanceof Error ? err.message : "Failed"}`,
          });
          emit({
            type: "error",
            message: `${model.displayName}: ${err instanceof Error ? err.message : "Failed"}`,
          });
        }
      }

      if (previousRoundTexts.length > 0 && currentRoundTexts.length > 0) {
        const prevCombined = previousRoundTexts.join(" ");
        const currCombined = currentRoundTexts.join(" ");
        if (wordOverlapSimilarity(prevCombined, currCombined) > 0.92) {
          shouldStopEarly = true;
          emit({
            type: "status",
            status: "stagnation_detected",
            round,
            maxRounds: config.maxRounds,
          });
        }
      }
      previousRoundTexts = currentRoundTexts;

      // A fully-skipped resume round generated nothing new: don't re-vote, but
      // honor a convergence score the previous run had already reached.
      if (currentRoundTexts.length === 0) {
        if (
          discussion.convergenceScore != null &&
          discussion.convergenceScore >= config.convergenceThreshold
        ) {
          shouldStopEarly = true;
        }
        continue;
      }

      if (round >= 2 && !skipConvergenceVote && !shouldStopEarly) {
        const voteTranscript = buildTranscriptFromMessages(allMessages, modelNames);
        const scores: number[] = [];

        emit({
          type: "diagnostic",
          phase: "convergence_voting",
          round,
          message: "Running convergence vote across participating models",
        });

        for (const model of models) {
          const { providerId, model: modelName } = parseModelId(model.modelId);
          try {
            const voteMessages: ChatMessage[] = [
              {
                role: "system",
                content:
                  "You evaluate discussion completeness. Respond only with JSON.",
              },
              {
                role: "user",
                content: buildConvergencePrompt(discussion.topic, voteTranscript),
              },
            ];
            const { output: voteText, usage: voteUsage } =
              await runTracedModelCall({
                modelId: model.modelId,
                providerId,
                rawModel: modelName,
                label: `${model.displayName} convergence vote`,
                messages: voteMessages,
                maxTokens: 200,
                temperature: 0.2,
                reasoningEffort: "low",
                attachments: [],
                structuredOutput: buildConvergenceVoteResponseFormat(),
                validateStructuredOutput: (output) => {
                  const parsed = parseJsonResponse<{
                    score: number;
                    reason?: string;
                  }>(output);
                  return typeof parsed?.score === "number"
                    ? { ok: true, parsedResponseJson: JSON.stringify(parsed) }
                    : {
                        ok: false,
                        message:
                          "Convergence vote response could not be parsed as JSON with a numeric score.",
                      };
                },
              });
            emitTokenUsage({
              messageId: uuidv4(),
              modelId: model.modelId,
              modelName: model.displayName,
              providerId,
              round,
              label: `${model.displayName} convergence vote`,
              usage: voteUsage,
            });
            const parsed = parseJsonResponse<{ score: number; reason?: string }>(
              voteText
            );
            if (parsed?.score) {
              scores.push(Math.min(10, Math.max(1, parsed.score)));
            }
          } catch {
            // skip failed vote
          }
        }

        if (scores.length > 0) {
          const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
          updateDiscussion(discussionId, {
            convergenceScore: avg,
            updatedAt: new Date().toISOString(),
          });
          emit({ type: "convergence", score: avg });

          if (avg >= config.convergenceThreshold) {
            shouldStopEarly = true;
          }
        }
      }
    }

    if (signal.aborted) throw abortError();
    emit({ type: "status", status: "judging" });
    emit({
      type: "diagnostic",
      phase: "judging",
      message: "Judge model is synthesizing the final answer",
    });

    const judgeFullId = discussion.judgeModelId ?? modelIds[0];
    const { providerId: judgeProviderId, model: judgeModel } =
      parseModelId(judgeFullId);
    const judgeContextProfile = resolveClientModelContextProfile(judgeFullId);
    const finalMaxTokens = clampJudgeMaxTokens(
      configuredJudgeMaxTokens,
      judgeContextProfile.maxOutputTokens
    );
    const finalTranscript = buildTranscriptFromMessages(allMessages, modelNames);
    const judgeMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are the final judge. Synthesize the discussion into the single best answer in Markdown.",
      },
      {
        role: "user",
        content: buildJudgePrompt(
          discussion.topic,
          finalTranscript,
          verbosityInstruction,
          mode
        ),
      },
    ];

    const initialJudge = await runTracedModelCall({
      modelId: judgeFullId,
      providerId: judgeProviderId,
      rawModel: judgeModel,
      label: "Judge synthesis",
      messages: judgeMessages,
      maxTokens: finalMaxTokens,
      temperature: 0.3,
      reasoningEffort,
      attachments: allAttachments,
      signal,
    });
    emitTokenUsage({
      messageId: uuidv4(),
      modelId: judgeFullId,
      modelName: modelNames[judgeFullId] ?? judgeFullId,
      providerId: judgeProviderId,
      round: config.maxRounds + 1,
      label: "Judge synthesis",
      usage: initialJudge.usage,
    });

    let judgeRaw = initialJudge.output;
    let judgeFinishReason = initialJudge.finishReason;
    let judgeAssessment = assessJudgeOutput(judgeRaw, judgeFinishReason);

    if (!judgeAssessment.complete) {
      emit({
        type: "diagnostic",
        phase: "judge_retrying",
        message: `Judge response was incomplete (${judgeAssessment.reason}); retrying with a concise completion instruction`,
      });

      const retryJudgeMessages: ChatMessage[] = judgeMessages.map(
        (message, index) =>
          index === judgeMessages.length - 1
            ? {
                ...message,
                content: `${message.content}\n\nIMPORTANT: Your previous generation was incomplete. Regenerate the final answer concisely, finish every section, and append the exact metadata footer before stopping.`,
              }
            : message
      );
      const retryJudge = await runTracedModelCall({
        modelId: judgeFullId,
        providerId: judgeProviderId,
        rawModel: judgeModel,
        label: "Judge synthesis retry",
        messages: retryJudgeMessages,
        maxTokens: finalMaxTokens,
        temperature: 0.3,
        reasoningEffort,
        attachments: allAttachments,
        signal,
      });
      emitTokenUsage({
        messageId: uuidv4(),
        modelId: judgeFullId,
        modelName: modelNames[judgeFullId] ?? judgeFullId,
        providerId: judgeProviderId,
        round: config.maxRounds + 1,
        label: "Judge synthesis retry",
        usage: retryJudge.usage,
      });
      judgeRaw = retryJudge.output;
      judgeFinishReason = retryJudge.finishReason;
      judgeAssessment = assessJudgeOutput(judgeRaw, judgeFinishReason);
    }

    if (!judgeAssessment.complete) {
      throw new Error(
        `Judge response remained incomplete after retry (${judgeAssessment.reason})`
      );
    }

    const { answer, confidence, dissent } = extractJudgeResult(judgeRaw);

    insertFinalResult({
      discussionId,
      answer,
      confidence,
      dissent: JSON.stringify(dissent),
      createdAt: new Date().toISOString(),
    });

    updateDiscussion(discussionId, {
      status: "completed",
      updatedAt: new Date().toISOString(),
    });

    emit({ type: "final_answer", answer, confidence, dissent });
    emit({
      type: "diagnostic",
      phase: "finished",
      message: "Discussion completed successfully",
    });
    emit({ type: "complete" });
  } catch (err) {
    if (isAbortError(err)) {
      updateDiscussion(discussionId, {
        status: "stopped",
        updatedAt: new Date().toISOString(),
      });
      emit({ type: "status", status: "stopped" });
      emit({
        type: "diagnostic",
        phase: "finished",
        message: "Stopped by the user — restart it whenever you're ready",
      });
    } else {
      const failedDiscussion = getDiscussionById(discussionId);
      if (failedDiscussion?.mode === "build") {
        finalizeRunningBuildCheckpointAfterFailure(
          discussionId,
          err instanceof Error ? err.message : "Discussion failed"
        );
      }
      updateDiscussion(discussionId, {
        status: "failed",
        updatedAt: new Date().toISOString(),
      });
      emit({
        type: "error",
        message: err instanceof Error ? err.message : "Discussion failed",
      });
      emit({
        type: "diagnostic",
        phase: "model_failed",
        message:
          err instanceof Error
            ? `Discussion failed: ${err.message}`
            : "Discussion failed",
      });
    }
  } finally {
    runningDiscussions.delete(discussionId);
    abortControllers.delete(discussionId);
  }
}

export function finalizeRunningBuildCheckpointAfterFailure(
  discussionId: string,
  message: string
): boolean {
  const checkpoint = getBuildCheckpoint(discussionId);
  if (!checkpoint || checkpoint.status !== "running") return false;

  const now = new Date().toISOString();
  const detail = message.trim() || "Discussion failed";
  const buildProblems = [
    ...(checkpoint.buildProblems ?? []),
    {
      id: uuidv4(),
      createdAt: now,
      code: "incomplete_tasks" as const,
      severity: "blocked" as const,
      source: "engine" as const,
      wave: checkpoint.wave,
      message: `Build failed before a terminal checkpoint was saved: ${detail}`,
    },
  ].slice(-80);

  upsertBuildCheckpoint({
    ...checkpoint,
    status: "blocked",
    stopReason: "blocked",
    updatedAt: now,
    recoveryLog: [
      ...(checkpoint.recoveryLog ?? []),
      `Stopped as blocked after unexpected failure: ${detail}`,
    ],
    buildProblems,
  });
  return true;
}
