import { createHash, randomUUID } from "node:crypto";

import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  AgentLifecycleSignal,
  LiveOutputChannel,
  ToolCallBlock,
  ToolResult,
  ToolExecutionContext,
} from "./agent-contracts.js";
import {
  AgentProtocolError,
  type AgentToolRuntime,
} from "./tool-registry.js";
import { BudgetExceededError } from "./budget-ledger.js";
import {
  completeWithProviderRetry,
  ProviderRetryDeadlineError,
  type RunnerProviderRetryEvent,
} from "./provider-call-retry.js";
import type { ProviderFailure } from "./provider-health.js";
import { publishLiveModelOutput } from "./live-model-output.js";
import { lifecycleEventResult } from "./lifecycle-receipt.js";
import type { SchedulerEvent } from "./scheduler-store.js";

export type AgentSuspensionReason =
  | "model_ended_without_lifecycle"
  | "provider_error"
  | "protocol_error"
  | "turn_limit"
  | "cancelled"
  | "max_tokens"
  | "checkpoint_error"
  | "budget_exhausted"
  | "read_only_stall"
  | "repeated_evidence_failure";

export type AgentLoopResult =
  | {
      status: "submitted";
      changeSetId: string;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "verifier_verdict_submitted";
      reviewId: string;
      satisfied: boolean;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "verifier_expectations_recorded";
      reviewId: string;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "plan_critique_submitted";
      critiqueId: string;
      blockingFindingCount: number;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "subagent_returned";
      summary: string;
      artifactHashes: string[];
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "waiting_for_architect";
      requestId: string;
      blocking: boolean;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "replan_requested";
      requestId: string;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "architect_action";
      action:
        | "plan_created"
        | "plan_reconciled"
        | "task_revised"
        | "guidance_answered"
        | "review_decided"
        | "integration_requested"
        | "acceptance_contract_upgraded"
        | "final_verification_planned"
        | "final_verification_review_decided"
        | "verification_repairs_planned"
        | "delivery_boundary_failure_resolved"
        | "test_integrity_reason_recorded"
        | "user_guidance_acknowledged"
        | "user_question_requested"
        | "plan_critique_resolved"
        | "context_recording_resolved"
        | "run_completed";
      referenceId?: string;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "suspended";
      reason: AgentSuspensionReason;
      error?: string;
      errorCode?: string;
      providerError?: {
        name?: string;
        status?: number;
        code?: string;
        retryAfterMs?: number;
      };
      turns: number;
      messages: AgentMessage[];
    };

export interface RunAgentLoopOptions {
  model: AgentModel;
  registry: AgentToolRuntime;
  context: ToolExecutionContext;
  initialMessages: readonly AgentMessage[];
  maxTurns?: number;
  signal?: AbortSignal;
  idFactory?: () => string;
  onCheckpoint?: (checkpoint: AgentLoopCheckpoint) => Promise<void>;
  workingSet?: AgentWorkingSetLimits;
  hostedTools?: AgentModelRequest["hostedTools"];
  readOnlyStall?: {
    warnTurns: number;
    suspendTurns: number;
  };
  providerRetry?: {
    runtimeId: string;
    providerId: string;
    modelId: string;
    deadlineMs?: number;
    classify(error: unknown): ProviderFailure;
    onRetry?(event: AgentProviderRetryEvent): void;
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  };
}

export interface AgentProviderRetryEvent
  extends Omit<RunnerProviderRetryEvent, "occurredAt"> {
  sessionId: string;
  turn: number;
}

export interface AgentWorkingSetLimits {
  maxMessages: number;
  maxBytes: number;
  retainRecent: number;
}

export interface AgentLoopCheckpoint {
  messages: readonly AgentMessage[];
  turns: number;
  seenCallIds: readonly string[];
}

export async function runAgentLoop(
  options: RunAgentLoopOptions
): Promise<AgentLoopResult> {
  const maxTurns = options.maxTurns ?? 50;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer.");
  }
  const messages = [...options.initialMessages];
  const seenCallIds = new Set<string>(
    messages
      .filter(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "object" &&
          !Array.isArray(message.content) &&
          "callId" in message.content
      )
      .map((message) => (message.content as { callId: string }).callId)
  );
  const nextId = options.idFactory ?? (() => randomUUID());
  const readOnlyStall = options.readOnlyStall ?? (
    options.context.actor.role === "worker"
      ? { warnTurns: 12, suspendTurns: 20 }
      : undefined
  );
  if (readOnlyStall && (
    !Number.isSafeInteger(readOnlyStall.warnTurns) ||
    !Number.isSafeInteger(readOnlyStall.suspendTurns) ||
    readOnlyStall.warnTurns < 1 ||
    readOnlyStall.suspendTurns <= readOnlyStall.warnTurns
  )) throw new Error("Read-only stall limits are invalid.");
  const initialTurns = messages.filter((message) => message.role === "assistant").length;
  let lifecycleBatchCorrections = 0;
  const finalTurn = initialTurns + maxTurns;

  const pendingCalls = messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter(
          (block): block is ToolCallBlock =>
            block.type === "tool_call" && !seenCallIds.has(block.callId)
        )
      : []
  );
  if (pendingCalls.length > 0) {
    let rejectedLifecycleBatch = false;
    try {
      options.registry.assertUniqueCallIds(pendingCalls, seenCallIds);
      assertLifecycleBatch(pendingCalls, options.registry);
    } catch (error) {
      if (isInvalidLifecycleBatch(error)) {
        const checkpointError = await rejectLifecycleBatch(
          pendingCalls,
          error,
          options,
          messages,
          initialTurns,
          seenCallIds,
          nextId
        );
        if (checkpointError) return checkpointError;
        rejectedLifecycleBatch = true;
      } else {
        return suspended(
          "protocol_error",
          initialTurns,
          messages,
          error instanceof Error ? error.message : String(error),
          undefined,
          protocolErrorCode(error)
        );
      }
    }
    if (!rejectedLifecycleBatch) {
      for (const call of pendingCalls) seenCallIds.add(call.callId);
      const pendingResult = await executeToolCalls(
        pendingCalls,
        options,
        messages,
        initialTurns,
        seenCallIds,
        nextId
      );
      if (pendingResult) return pendingResult;
    }
  }

  const initialStallResult = await enforceReadOnlyStall(
    options,
    messages,
    initialTurns,
    seenCallIds
  );
  if (initialStallResult) return initialStallResult;
  const initialEvidenceReminderError = await enforceRepeatedEvidenceFailure(
    options,
    messages,
    initialTurns,
    seenCallIds
  );
  if (initialEvidenceReminderError) return initialEvidenceReminderError;

  for (
    let turnNumber = initialTurns + 1;
    turnNumber <= finalTurn;
    turnNumber += 1
  ) {
    if (options.signal?.aborted) {
      return suspended("cancelled", turnNumber - 1, messages);
    }
    let attempt = 0;
    let streamingActive = false;
    const identity = () => ({
      runId: options.context.runId,
      sessionId: options.context.sessionId,
      actor: options.context.actor,
      turn: turnNumber,
      attempt,
    });
    // Retries repeat the exact same request, including callback identity.
    // Providers must settle/cancel their response stream before rejecting.
    const request = {
      sessionId: options.context.sessionId,
      messages: compactAgentMessages(messages, options.workingSet ?? workingSetForContextWindow(options.model.contextWindowTokens)),
      tools: options.registry.definitions(),
      ...(options.hostedTools ? { hostedTools: options.hostedTools } : {}),
      signal: options.signal,
      onTextDelta: (text: string, channel?: LiveOutputChannel) => {
        if (streamingActive && text && !options.signal?.aborted) {
          publishLiveModelOutput({
            ...identity(),
            phase: "delta" as const,
            text,
            ...(channel && channel !== "text" ? { channel } : {}),
          });
        }
      },
    };
    let turn;
    const streamAttempt = async () => {
      attempt += 1;
      const activeAttempt = identity();
      streamingActive = true;
      publishLiveModelOutput({ ...activeAttempt, phase: "reset", text: "" });
      try {
        const result = await options.model.complete(request);
        streamingActive = false;
        publishLiveModelOutput({ ...activeAttempt, phase: "finish", text: "" });
        return result;
      } catch (error) {
        streamingActive = false;
        publishLiveModelOutput({ ...activeAttempt, phase: "discard", text: "" });
        throw error;
      }
    };
    try {
      turn = options.providerRetry
        ? await completeWithProviderRetry({
            complete: streamAttempt,
            signal: options.signal,
            deadlineMs: options.providerRetry.deadlineMs,
            classify: options.providerRetry.classify,
            onRetry: options.providerRetry.onRetry
              ? (event) => options.providerRetry!.onRetry!({
                  ...event,
                  sessionId: request.sessionId,
                  turn: turnNumber,
                })
              : undefined,
            now: options.providerRetry.now,
            random: options.providerRetry.random,
            sleep: options.providerRetry.sleep,
            runtimeId: options.providerRetry.runtimeId,
            providerId: options.providerRetry.providerId,
            modelId: options.providerRetry.modelId,
            retryIdentity: `${request.sessionId}:turn:${turnNumber}`,
          })
        : await streamAttempt();
    } catch (error) {
      const budgetExhausted =
        error instanceof BudgetExceededError ||
        error instanceof ProviderRetryDeadlineError;
      return suspended(
        options.signal?.aborted
          ? "cancelled"
          : budgetExhausted
            ? "budget_exhausted"
            : "provider_error",
        turnNumber - 1,
        messages,
        error instanceof Error ? error.message : String(error),
        budgetExhausted ? undefined : providerErrorDetails(error)
      );
    }

    if (!turn || !Array.isArray(turn.blocks)) {
      return suspended(
        "protocol_error",
        turnNumber,
        messages,
        "Provider returned an invalid native turn.",
        undefined,
        "invalid_provider_turn"
      );
    }
    messages.push({
      id: `assistant_${nextId()}`,
      role: "assistant",
      content: [...turn.blocks],
    });
    const assistantCheckpointError = await checkpoint(
      options,
      messages,
      turnNumber,
      seenCallIds
    );
    if (assistantCheckpointError) return assistantCheckpointError;
    const calls = turn.blocks.filter(
      (block): block is ToolCallBlock => block.type === "tool_call"
    );
    if (calls.length === 0) {
      const reason: AgentSuspensionReason =
        turn.stopReason === "max_tokens"
          ? "max_tokens"
          : turn.stopReason === "cancelled"
            ? "cancelled"
            : "model_ended_without_lifecycle";
      return suspended(reason, turnNumber, messages);
    }

    try {
      options.registry.assertUniqueCallIds(calls, seenCallIds);
      assertLifecycleBatch(calls, options.registry);
    } catch (error) {
      if (isInvalidLifecycleBatch(error)) {
        const checkpointError = await rejectLifecycleBatch(
          calls,
          error,
          options,
          messages,
          turnNumber,
          seenCallIds,
          nextId
        );
        if (checkpointError) return checkpointError;
        // Nothing in the batch executed and the rejection is durable, so let the model correct the
        // batch in-loop instead of pausing the whole run for a manual resume. Repeated misuse still
        // fails closed.
        if (++lifecycleBatchCorrections <= MAX_LIFECYCLE_BATCH_CORRECTIONS) continue;
      }
      return suspended(
        "protocol_error",
        turnNumber,
        messages,
        error instanceof Error ? error.message : String(error),
        undefined,
        protocolErrorCode(error)
      );
    }
    for (const call of calls) seenCallIds.add(call.callId);

    const toolResult = await executeToolCalls(
      calls,
      options,
      messages,
      turnNumber,
      seenCallIds,
      nextId
    );
    if (toolResult) return toolResult;
    const evidenceReminderError = await enforceRepeatedEvidenceFailure(
      options,
      messages,
      turnNumber,
      seenCallIds
    );
    if (evidenceReminderError) return evidenceReminderError;
    const stallResult = await enforceReadOnlyStall(
      options,
      messages,
      turnNumber,
      seenCallIds
    );
    if (stallResult) return stallResult;
    const budgetResult = await remindTurnBudget(options, messages, turnNumber, finalTurn, maxTurns, seenCallIds);
    if (budgetResult) return budgetResult;
  }
  return suspended("turn_limit", finalTurn, messages);
}

const MAX_LIFECYCLE_BATCH_CORRECTIONS = 2;

function isInvalidLifecycleBatch(error: unknown): error is AgentProtocolError {
  return error instanceof AgentProtocolError && error.code === "invalid_lifecycle_batch";
}

async function rejectLifecycleBatch(
  calls: readonly ToolCallBlock[],
  error: AgentProtocolError,
  options: RunAgentLoopOptions,
  messages: AgentMessage[],
  turns: number,
  seenCallIds: Set<string>,
  nextId: () => string
): Promise<AgentLoopResult | null> {
  for (const call of calls) {
    seenCallIds.add(call.callId);
    messages.push({
      id: `tool_${nextId()}`,
      role: "tool",
      content: {
        callId: call.callId,
        toolName: call.name,
        content: [{ type: "text", text: error.message }],
        isError: true,
        error: { code: error.code, message: error.message },
      },
    });
  }
  return await checkpoint(options, messages, turns, seenCallIds);
}

async function executeToolCalls(
  calls: readonly ToolCallBlock[],
  options: RunAgentLoopOptions,
  messages: AgentMessage[],
  turns: number,
  seenCallIds: ReadonlySet<string>,
  nextId: () => string
): Promise<AgentLoopResult | null> {
  for (let index = 0; index < calls.length;) {
    if (options.signal?.aborted) {
      return suspended("cancelled", turns, messages);
    }
    const readOnly = options.registry.isReadOnlyTool(calls[index].name);
    let end = index + 1;
    if (readOnly) {
      while (
        end < calls.length &&
        options.registry.isReadOnlyTool(calls[end].name)
      ) end += 1;
    }
    const batch = calls.slice(index, end);
    const results = readOnly
      ? await Promise.all(batch.map((call) => invokeTool(call, options)))
      : [await invokeTool(batch[0], options)];
    for (const result of results) {
      messages.push({
        id: `tool_${nextId()}`,
        role: "tool",
        content: result,
      });
      const checkpointError = await checkpoint(
        options,
        messages,
        turns,
        seenCallIds
      );
      if (checkpointError) return checkpointError;
      if (result.isError && result.error?.code === "budget_exhausted") {
        return suspended(
          "budget_exhausted",
          turns,
          messages,
          result.error.message
        );
      }
      if (!result.isError && result.lifecycle) {
        return lifecycleResult(result.lifecycle, turns, messages);
      }
    }
    index = end;
  }
  return null;
}

async function invokeTool(
  call: ToolCallBlock,
  options: RunAgentLoopOptions
) {
  return await options.registry.invoke(call, {
    ...options.context,
    signal: options.signal ?? options.context.signal,
    inlineOutputBytes: inlineResultBytesForContextWindow(options.model.contextWindowTokens),
    imageInput: options.model.inputModalities?.image === true,
  });
}

/**
 * How large one tool result may be before it is stored as an artifact: about 15% of the model's
 * context window at ~3.5 bytes per token, within 32 KB-1 MB. A fixed 8-16 KB spilled a single
 * commit or evidence record, which the model then paged through artifact.read call by call, and a
 * spilled evidence read never counted as read, so a verdict citing it looped (tunnel run).
 */
export function inlineResultBytesForContextWindow(contextWindowTokens: number | undefined): number {
  if (contextWindowTokens === undefined || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) return 32 * 1024;
  return Math.min(1024 * 1024, Math.max(32 * 1024, Math.floor(contextWindowTokens * 3.5 * 0.15)));
}

/**
 * The working set a model's context window holds: about 60% of it at ~3.5 bytes per token, leaving
 * room for the system prompt, tool schemas and output, within 128 KB-2 MB. A fixed 512 KB compacted a
 * 1M-token model's sessions every few turns and dropped its prompt cache (tunnel run), and overflowed
 * small local models. Unknown windows keep the 512 KB default.
 */
export function workingSetForContextWindow(contextWindowTokens: number | undefined): AgentWorkingSetLimits | undefined {
  if (contextWindowTokens === undefined || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1) return undefined;
  const maxBytes = Math.min(2 * 1024 * 1024, Math.max(128 * 1024, Math.floor(contextWindowTokens * 3.5 * 0.6)));
  return { maxMessages: 1_000, maxBytes, retainRecent: 24 };
}

export function compactAgentMessages(
  messages: readonly AgentMessage[],
  limits: AgentWorkingSetLimits = {
    // Size governs. At 80 messages a worker batching several tool calls per turn compacted at ~85K
    // tokens of a 1M-token context, dropping the prompt cache and making it re-read its own files, and
    // the cutoff then moved every COMPACTION_GRID messages (tunnel run).
    maxMessages: 1_000,
    maxBytes: 512 * 1024,
    retainRecent: 24,
  }
): AgentMessage[] {
  if (
    !Number.isSafeInteger(limits.maxMessages) || limits.maxMessages < 3 ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1_024 ||
    !Number.isSafeInteger(limits.retainRecent) || limits.retainRecent < 1
  ) throw new Error("Agent working-set limits are invalid.");
  const currentMessages = stubSettledBulk(omitSupersededRunnerSnapshots(messages));
  if (
    currentMessages.length <= limits.maxMessages &&
    Buffer.byteLength(JSON.stringify(currentMessages)) <= limits.maxBytes
  ) return currentMessages;

  const fits = (list: readonly AgentMessage[]) =>
    list.length <= limits.maxMessages && Buffer.byteLength(JSON.stringify(list)) <= limits.maxBytes;
  const summaryBudget = Math.floor(limits.maxBytes / 2);
  const withinSummaryBudget = (summary: AgentMessage) =>
    Buffer.byteLength(JSON.stringify(summary)) <= summaryBudget;

  // Prompt-cache stability: provider caches reuse only an identical prefix. Compacting to just under
  // the limit left a session that lives near it (a 230k-token Architect) overflowing again on the
  // next turn, so the prefix was rewritten every few turns: 0-4% cache hits (tunnel run). The cutoff
  // now moves only when the working set overflows, and then drops to a low-water mark, so the turns
  // that follow append to a byte-identical prefix. Fall back to the exact sliding compaction when
  // nothing on the grid can fit.
  const cutoff = hysteresisCutoff(currentMessages, limits, summaryBudget);
  if (cutoff > 0) {
    const anchored = compactAtCutoff(currentMessages, cutoff, withinSummaryBudget);
    if (anchored && fits(anchored)) return anchored;
  }

  const naiveCutoff = Math.max(0, currentMessages.length - limits.retainRecent);
  return compactAtCutoff(currentMessages, naiveCutoff, (_summary, result) => fits(result)) ??
    currentMessages;
}

const COMPACTION_GRID = 16;
/** After an overflow the working set drops to this share of its byte limit. */
const COMPACTION_LOW_WATER = 0.55;

/**
 * Replays the history in order and moves the cutoff only where the working set first overflowed,
 * each time to the earliest grid point that brings it under the low-water mark. Every decision
 * depends only on the messages up to its overflow, so appending messages never moves an earlier
 * cutoff and the compacted prefix stays byte-identical until the next overflow. Sizes are estimated
 * from per-message bytes and the summary's own budget, so the scan stays linear.
 */
function hysteresisCutoff(
  messages: readonly AgentMessage[],
  limits: AgentWorkingSetLimits,
  summaryBudget: number,
): number {
  const count = messages.length;
  const bytePrefix = new Array<number>(count + 1).fill(0);
  const keptPrefix = new Array<number>(count + 1).fill(0);
  const keptCountPrefix = new Array<number>(count + 1).fill(0);
  const factPrefix = new Array<number>(count + 1).fill(0);
  messages.forEach((message, index) => {
    const bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    const kept = message.role === "system" || message.role === "user";
    bytePrefix[index + 1] = bytePrefix[index]! + bytes;
    keptPrefix[index + 1] = keptPrefix[index]! + (kept ? bytes : 0);
    keptCountPrefix[index + 1] = keptCountPrefix[index]! + (kept ? 1 : 0);
    factPrefix[index + 1] = factPrefix[index]! + (kept ? 0 : Buffer.byteLength(JSON.stringify(historyFact(message))) + 1);
  });
  // The working set with history before `cutoff` compacted, through message `last`.
  const size = (cutoff: number, last: number) => {
    const summary = cutoff === 0 ? 0 : Math.min(summaryBudget, 512 + factPrefix[cutoff]!);
    return keptPrefix[cutoff]! + summary + bytePrefix[last + 1]! - bytePrefix[cutoff]!;
  };
  const messageCount = (cutoff: number, last: number) =>
    keptCountPrefix[cutoff]! + (cutoff === 0 ? 0 : 1) + last + 1 - cutoff;
  const lowWater = Math.floor(limits.maxBytes * COMPACTION_LOW_WATER);
  const lowWaterMessages = Math.max(3, Math.floor(limits.maxMessages * COMPACTION_LOW_WATER));

  let cutoff = 0;
  for (let last = 0; last < count; last += 1) {
    if (size(cutoff, last) <= limits.maxBytes && messageCount(cutoff, last) <= limits.maxMessages) continue;
    let fallback: number | undefined;
    let chosen: number | undefined;
    for (let grid = (Math.floor(cutoff / COMPACTION_GRID) + 1) * COMPACTION_GRID; grid <= last; grid += COMPACTION_GRID) {
      // Never split a tool result from the assistant turn that issued it.
      let candidate = grid;
      while (candidate > cutoff && messages[candidate]?.role === "tool") candidate -= 1;
      if (candidate <= cutoff) continue;
      const bytes = size(candidate, last);
      const total = messageCount(candidate, last);
      if (bytes <= lowWater && total <= lowWaterMessages) { chosen = candidate; break; }
      if (fallback === undefined && bytes <= limits.maxBytes && total <= limits.maxMessages) fallback = candidate;
    }
    const next = chosen ?? fallback;
    if (next === undefined) return cutoff; // nothing on the grid fits; the sliding fallback takes over
    cutoff = next;
  }
  return cutoff;
}

/** Settled tool-call arguments and lifecycle echoes above this size are stubbed in the working set. */
export const SETTLED_BULK_STUB_BYTES = 32 * 1024;

/**
 * Settled bulk out of the working set. Whole-plan tool calls (84 KB each) and their full-event echoes
 * (86 KB) pushed the Architect past the working-set limit, so compaction fell back to the sliding
 * cutoff and rewrote the prefix every turn: 9-18% cache hits on 100k+ input calls (tunnel run).
 * A call's arguments are stubbed once its result exists (the durable state holds what it recorded,
 * readable through the matching read tool) and an oversized event echo becomes its receipt. Both
 * depend only on the message and its own result, so a stubbed message never changes again.
 *
 * A rejected call recorded nothing, and its arguments are what the model must correct: it keeps
 * them until a later call to the same tool replaces it. The stub said "sent and settled" for a
 * rejected 39 KB verdict, and the verifier resent the stub as its verdict (tunnel run).
 */
function stubSettledBulk(messages: readonly AgentMessage[]): AgentMessage[] {
  const settled = new Map<string, ToolResult>();
  for (const message of messages) {
    if (message.role === "tool" && !Array.isArray(message.content) && typeof message.content === "object") {
      const result = message.content as ToolResult;
      settled.set(result.callId, result);
    }
  }
  const latestCallByTool = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) if (block.type === "tool_call") latestCallByTool.set(block.name, block.callId);
  }
  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      let changed = false;
      const content = message.content.map((block) => {
        if (block.type !== "tool_call") return block;
        const result = settled.get(block.callId);
        if (!result) return block;
        const rejected = result.isError === true;
        if (rejected && latestCallByTool.get(block.name) === block.callId) return block;
        const bytes = Buffer.byteLength(JSON.stringify(block.arguments ?? null));
        if (bytes <= SETTLED_BULK_STUB_BYTES) return block;
        changed = true;
        return {
          ...block,
          arguments: {
            omittedArguments: rejected
              ? `Placeholder, not arguments: ${bytes} bytes of a call that was rejected (see its result) and later replaced.`
              : `Placeholder, not arguments: ${bytes} bytes accepted and recorded; read them back with the matching read tool if needed.`,
          },
        };
      });
      return changed ? { ...message, content } : message;
    }
    if (message.role === "tool" && !Array.isArray(message.content) && typeof message.content === "object") {
      const result = message.content as ToolResult;
      let changed = false;
      const content = (result.content ?? []).map((block) => {
        if (block.type !== "json" || !isEchoedEvent(block.value)) return block;
        if (Buffer.byteLength(JSON.stringify(block.value)) <= SETTLED_BULK_STUB_BYTES) return block;
        changed = true;
        return { ...block, value: lifecycleEventResult(block.value) };
      });
      return changed ? { ...message, content: { ...result, content } } : message;
    }
    return message;
  });
}

function isEchoedEvent(value: unknown): value is SchedulerEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.eventId === "string" && typeof event.sequence === "number" &&
    typeof event.type === "string" && typeof event.payload === "object" && event.payload !== null;
}

function compactAtCutoff(
  currentMessages: readonly AgentMessage[],
  requestedCutoff: number,
  accept: (summary: AgentMessage, result: readonly AgentMessage[]) => boolean
): AgentMessage[] | null {
  let cutoff = requestedCutoff;
  // Never split a tool result from the assistant turn that issued it: providers reject a tool output
  // whose call was compacted away ("No tool call found for function call output").
  while (cutoff > 0 && currentMessages[cutoff]?.role === "tool") cutoff -= 1;
  const protectedMessages = currentMessages
    .slice(0, cutoff)
    .filter((message) => message.role === "system" || message.role === "user");
  const compactable = currentMessages
    .slice(0, cutoff)
    .filter((message) => message.role === "assistant" || message.role === "tool");
  const recent = currentMessages.slice(cutoff);
  if (compactable.length === 0) return null;

  const facts = compactable.map(historyFact);
  let included = facts.length;
  let summary = summaryMessage(facts, included);
  let result = [...protectedMessages, summary, ...recent];
  while (included > 1 && !accept(summary, result)) {
    included = Math.max(1, Math.floor(included * 0.75));
    summary = summaryMessage(facts.slice(facts.length - included), facts.length);
    result = [...protectedMessages, summary, ...recent];
  }
  return result;
}

function omitSupersededRunnerSnapshots(
  messages: readonly AgentMessage[]
): AgentMessage[] {
  const prefixes = [
    "context:",
    "action-resume:",
    "worker-resume:",
    "progress-reminder:",
    "evidence-failure-reminder:",
    "turn-budget-reminder:",
  ];
  const newest = new Map<string, number>();
  for (const [index, message] of messages.entries()) {
    const prefix = prefixes.find((candidate) => message.id.startsWith(candidate));
    if (prefix) newest.set(prefix, index);
  }
  return messages.filter((message, index) => {
    const prefix = prefixes.find((candidate) => message.id.startsWith(candidate));
    return !prefix || newest.get(prefix) === index;
  });
}

interface FailedEvidenceStreak {
  signature: string;
  count: number;
  command: string;
}

function repeatedFailedEvidence(
  messages: readonly AgentMessage[]
): FailedEvidenceStreak | null {
  const attempts = new Map<string, FailedEvidenceStreak>();
  const remindedCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.id.startsWith("evidence-failure-reminder:")) {
      const reminderIdentity = message.id.slice("evidence-failure-reminder:".length);
      const separator = reminderIdentity.lastIndexOf(":");
      const signature = separator >= 0
        ? reminderIdentity.slice(0, separator)
        : reminderIdentity;
      const count = separator >= 0
        ? Number.parseInt(reminderIdentity.slice(separator + 1), 10)
        : 3;
      remindedCounts.set(signature, Math.max(
        remindedCounts.get(signature) ?? 0,
        Number.isSafeInteger(count) ? count : 0
      ));
      continue;
    }
    if (
      message.role !== "tool" ||
      typeof message.content !== "object" ||
      Array.isArray(message.content) ||
      message.content.toolName !== "run_evidence_command"
    ) continue;
    for (const block of message.content.content) {
      if (block.type !== "json" || typeof block.value !== "object" || !block.value) continue;
      const fact = (block.value as { fact?: unknown }).fact;
      if (typeof fact !== "object" || !fact) continue;
      const commandFact = fact as {
        kind?: unknown;
        command?: unknown;
        args?: unknown;
        cwd?: unknown;
        exitCode?: unknown;
      };
      if (commandFact.kind !== "command" || typeof commandFact.command !== "string") continue;
      const signature = createHash("sha256").update(JSON.stringify({
        command: commandFact.command,
        args: commandFact.args ?? [],
        cwd: commandFact.cwd ?? "",
      })).digest("hex").slice(0, 16);
      if (commandFact.exitCode === 0) {
        attempts.delete(signature);
        remindedCounts.delete(signature);
        continue;
      }
      if (typeof commandFact.exitCode !== "number") continue;
      const prior = attempts.get(signature);
      attempts.set(signature, {
        signature,
        count: (prior?.count ?? 0) + 1,
        command: commandFact.command,
      });
    }
  }
  return [...attempts.values()].find(
    (attempt) =>
      attempt.count >= 8 ||
      (
        attempt.count >= 3 &&
        (remindedCounts.get(attempt.signature) ?? 0) < attempt.count
      )
  ) ?? null;
}

async function enforceRepeatedEvidenceFailure(
  options: RunAgentLoopOptions,
  messages: AgentMessage[],
  turns: number,
  seenCallIds: ReadonlySet<string>
): Promise<AgentLoopResult | null> {
  if (options.context.actor.role !== "worker") return null;
  const repeated = repeatedFailedEvidence(messages);
  if (!repeated) return null;
  if (repeated.count >= 8) {
    return suspended(
      "repeated_evidence_failure",
      turns,
      messages,
      `The same command shape (${repeated.command}) failed ${repeated.count} times without a successful equivalent run; Architect resolution is required.`
    );
  }
  messages.push({
    id: `evidence-failure-reminder:${repeated.signature}:${repeated.count}`,
    role: "user",
    content: [
      "MECHANICAL_EVIDENCE_FAILURE_REMINDER",
      `The same command shape (${repeated.command}) has failed ${repeated.count} times without a successful equivalent run.`,
      "Do not keep changing expectations or retrying the same failure without a new mechanical basis.",
      "Inspect the execution path, make a materially different scoped change, or ask the Architect for guidance if the intended resolution is unclear.",
      "This reminder reports repeated command evidence only; it does not decide task meaning or whether the task is complete.",
    ].join("\n"),
  });
  return await checkpoint(options, messages, turns, seenCallIds);
}

function trailingUnproductiveTurns(
  messages: readonly AgentMessage[],
  registry: AgentToolRuntime
): number {
  const results = toolResults(messages);
  let streak = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(
      (block): block is ToolCallBlock => block.type === "tool_call"
    );
    if (calls.length === 0) continue;
    if (calls.some((call) => !results.has(call.callId))) continue;
    const madeProgress = calls.some((call) =>
      !registry.isReadOnlyTool(call.name) && results.get(call.callId)?.isError === false
    );
    if (madeProgress) break;
    streak += 1;
  }
  return streak;
}

function hasCurrentProgressReminder(
  messages: readonly AgentMessage[],
  registry: AgentToolRuntime
): boolean {
  const results = toolResults(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.id.startsWith("progress-reminder:")) return true;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(
      (block): block is ToolCallBlock => block.type === "tool_call"
    );
    const madeProgress = calls.some((call) =>
      !registry.isReadOnlyTool(call.name) && results.get(call.callId)?.isError === false
    );
    if (madeProgress) return false;
  }
  return false;
}

function toolResults(
  messages: readonly AgentMessage[]
): Map<string, { isError: boolean }> {
  const results = new Map<string, { isError: boolean }>();
  for (const message of messages) {
    if (
      message.role === "tool" &&
      typeof message.content === "object" &&
      !Array.isArray(message.content) &&
      "callId" in message.content &&
      "isError" in message.content
    ) {
      const result = message.content as { callId: string; isError: boolean };
      results.set(result.callId, result);
    }
  }
  return results;
}

/**
 * Sessions that end at the turn limit lose all their work (a plan critic that read for 20 turns and
 * never submitted). Warn shortly before the limit so the model concludes with its lifecycle tool.
 */
async function remindTurnBudget(
  options: RunAgentLoopOptions,
  messages: AgentMessage[],
  turns: number,
  finalTurn: number,
  maxTurns: number,
  seenCallIds: ReadonlySet<string>
): Promise<AgentLoopResult | null> {
  const remaining = finalTurn - turns;
  if (maxTurns < TURN_BUDGET_MIN_TURNS || (remaining !== 3 && remaining !== 1)) return null;
  const lifecycleTools = options.registry.definitions()
    .map((tool) => tool.name)
    .filter((name) => options.registry.isLifecycleTool(name));
  messages.push({
    id: `turn-budget-reminder:${turns}`,
    role: "user",
    content: [
      "TURN_BUDGET_REMINDER",
      remaining === 1
        ? "This is your final model turn in this session."
        : `You have ${remaining} model turns left in this session.`,
      `Stop exploring and finish with your lifecycle tool${lifecycleTools.length ? ` (${lifecycleTools.join(", ")})` : ""} using the evidence you already have.`,
      "If evidence is incomplete, still conclude and state the gaps explicitly; ending without the lifecycle tool discards this session's work.",
    ].join("\n"),
  });
  return await checkpoint(options, messages, turns, seenCallIds);
}

const TURN_BUDGET_MIN_TURNS = 8;

async function enforceReadOnlyStall(
  options: RunAgentLoopOptions,
  messages: AgentMessage[],
  turns: number,
  seenCallIds: ReadonlySet<string>
): Promise<AgentLoopResult | null> {
  const limits = options.readOnlyStall ?? (
    options.context.actor.role === "worker"
      ? { warnTurns: 8, suspendTurns: 16 }
      : undefined
  );
  if (!limits) return null;
  const streak = trailingUnproductiveTurns(messages, options.registry);
  if (streak >= limits.warnTurns && !hasCurrentProgressReminder(messages, options.registry)) {
    messages.push({
      id: `progress-reminder:${turns}`,
      role: "user",
      content: [
        "MECHANICAL_PROGRESS_REMINDER",
        `The last ${streak} model turns made no successful progress-producing tool call.`,
        "Avoid repeating inspection that is already represented in durable history.",
        "Make a scoped change, run task-relevant verification, submit if ready, or ask the Architect if the intended resolution is unclear.",
        "This reminder does not decide whether the task is complete.",
      ].join("\n"),
    });
    const checkpointError = await checkpoint(options, messages, turns, seenCallIds);
    if (checkpointError) return checkpointError;
  }
  if (streak >= limits.suspendTurns) {
    return suspended(
      "read_only_stall",
      turns,
      messages,
      `${streak} consecutive model turns made no successful progress-producing tool call.`
    );
  }
  return null;
}

function historyFact(message: AgentMessage): Record<string, unknown> {
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const blocks = message.content.map((block) =>
      block.type === "tool_call"
        ? {
            type: block.type,
            callId: block.callId,
            name: block.name,
            ...boundedToolArguments(block.arguments),
          }
        : { type: block.type, text: block.text.slice(0, 256) }
    );
    const fact = {
      id: message.id,
      role: message.role,
      blocks,
    };
    if (Buffer.byteLength(JSON.stringify(fact)) <= 8 * 1024) return fact;
    const serializedBlocks = JSON.stringify(blocks);
    return {
      id: message.id,
      role: message.role,
      blocksSummary: boundedSummary(serializedBlocks, 2 * 1024),
    };
  }
  if (
    message.role === "tool" &&
    typeof message.content === "object" &&
    !Array.isArray(message.content)
  ) {
    return {
      id: message.id,
      role: message.role,
      callId: message.content.callId,
      toolName: message.content.toolName,
      isError: message.content.isError,
      errorCode: message.content.error?.code,
      artifacts: message.content.content
        .filter((block) => block.type === "artifact")
        .map((block) => block.type === "artifact" ? block.hash : ""),
      preview: message.content.content
        .filter((block) => block.type === "text")
        .map((block) => block.type === "text" ? block.text.slice(0, 256) : "")
        .join("\n"),
    };
  }
  return { id: message.id, role: message.role };
}

function boundedToolArguments(
  argumentsValue: unknown,
  maximumBytes = 2 * 1024
): Record<string, unknown> {
  const redacted = redactSensitiveValues(argumentsValue);
  const serialized = JSON.stringify(redacted) ?? "null";
  const bytes = Buffer.from(serialized);
  if (bytes.byteLength <= maximumBytes) return { arguments: redacted };
  return {
    argumentsSummary: boundedSummary(serialized, maximumBytes),
  };
}

function boundedSummary(serialized: string, maximumBytes: number) {
  const bytes = Buffer.from(serialized);
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    preview: safeUtf8Preview(serialized, maximumBytes),
  };
}

function safeUtf8Preview(text: string, maximumBytes: number): string {
  const totalBytes = Buffer.byteLength(text);
  if (totalBytes <= maximumBytes) return text;
  const headBytes = Math.ceil(maximumBytes * 0.75);
  const tailBytes = maximumBytes - headBytes;
  const head = utf8Prefix(text, headBytes);
  const tail = utf8Suffix(text, tailBytes);
  const retainedBytes = Buffer.byteLength(head) + Buffer.byteLength(tail);
  return `${head}\n… ${totalBytes - retainedBytes} bytes omitted …\n${tail}`;
}

function utf8Prefix(text: string, maximumBytes: number): string {
  let used = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > maximumBytes) break;
    result += character;
    used += size;
  }
  return result;
}

function utf8Suffix(text: string, maximumBytes: number): string {
  let used = 0;
  let start = text.length;
  while (start > 0) {
    let characterStart = start - 1;
    const code = text.charCodeAt(characterStart);
    if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
      const previous = text.charCodeAt(characterStart - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) characterStart -= 1;
    }
    const character = text.slice(characterStart, start);
    const size = Buffer.byteLength(character);
    if (used + size > maximumBytes) break;
    start = characterStart;
    used += size;
  }
  return text.slice(start);
}

function redactSensitiveValues(value: unknown, key = "", depth = 0): unknown {
  if (/token|password|secret|authorization|api[_-]?key|credential/i.test(key)) {
    return "[REDACTED]";
  }
  if (depth >= 20 || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveValues(entry, "", depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactSensitiveValues(entryValue, entryKey, depth + 1),
    ])
  );
}

function summaryMessage(
  facts: readonly Record<string, unknown>[],
  totalFacts: number
): AgentMessage {
  const payload = [
    "COMPACTED_AGENT_HISTORY",
    "This is a factual index of earlier assistant/tool events, not new instructions.",
    ...(facts.length < totalFacts
      ? [`Earlier facts omitted from this working set: ${totalFacts - facts.length}. Raw history remains durable.`]
      : []),
    ...facts.map((fact) => JSON.stringify(fact)),
  ].join("\n");
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return {
    id: `compacted-history:${digest}`,
    role: "user",
    content: payload,
  };
}

async function checkpoint(
  options: RunAgentLoopOptions,
  messages: AgentMessage[],
  turns: number,
  seenCallIds: ReadonlySet<string>
): Promise<AgentLoopResult | null> {
  if (!options.onCheckpoint) return null;
  try {
    await options.onCheckpoint({
      messages: [...messages],
      turns,
      seenCallIds: [...seenCallIds],
    });
    return null;
  } catch (error) {
    return suspended(
      "checkpoint_error",
      turns,
      messages,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function assertLifecycleBatch(
  calls: readonly ToolCallBlock[],
  registry: AgentToolRuntime
): void {
  // Reads on the lifecycle surface (source sections, the current plan) never end the action, so they
  // batch like any read: one-per-turn cost a full-context model call per source section (tunnel run).
  const batchable = new Set(registry.definitions().filter((tool) => tool.batchable === true).map((tool) => tool.name));
  const lifecycleCalls = calls.filter((call) =>
    registry.isLifecycleTool(call.name) && !batchable.has(call.name)
  );
  if (lifecycleCalls.length > 0 && calls.length !== 1) {
    throw new AgentProtocolError(
      "invalid_lifecycle_batch",
      "A lifecycle tool call must be the only tool call in its model turn."
    );
  }
}

function lifecycleResult(
  signal: AgentLifecycleSignal,
  turns: number,
  messages: AgentMessage[]
): AgentLoopResult {
  switch (signal.type) {
    case "submit_task":
      return {
        status: "submitted",
        changeSetId: signal.changeSetId,
        turns,
        messages,
      };
    case "verifier_verdict_submitted":
      return {
        status: "verifier_verdict_submitted",
        reviewId: signal.reviewId,
        satisfied: signal.satisfied,
        turns,
        messages,
      };
    case "verifier_expectations_recorded":
      return {
        status: "verifier_expectations_recorded",
        reviewId: signal.reviewId,
        turns,
        messages,
      };
    case "plan_critique_submitted":
      return {
        status: "plan_critique_submitted",
        critiqueId: signal.critiqueId,
        blockingFindingCount: signal.blockingFindingCount,
        turns,
        messages,
      };
    case "ask_architect":
      return {
        status: "waiting_for_architect",
        requestId: signal.requestId,
        blocking: signal.blocking,
        turns,
        messages,
      };
    case "request_replan":
      return {
        status: "replan_requested",
        requestId: signal.requestId,
        turns,
        messages,
      };
    case "return_subagent":
      return {
        status: "subagent_returned",
        summary: signal.summary,
        artifactHashes: [...signal.artifactHashes],
        turns,
        messages,
      };
    case "architect_action":
      return {
        status: "architect_action",
        action: signal.action,
        ...(signal.referenceId ? { referenceId: signal.referenceId } : {}),
        turns,
        messages,
      };
  }
}

function suspended(
  reason: AgentSuspensionReason,
  turns: number,
  messages: AgentMessage[],
  error?: string,
  providerError?: {
    name?: string;
    status?: number;
    code?: string;
    retryAfterMs?: number;
  },
  errorCode?: string
): AgentLoopResult {
  return {
    status: "suspended",
    reason,
    ...(error ? { error } : {}),
    ...(providerError && Object.keys(providerError).length > 0
      ? { providerError }
      : {}),
    ...(errorCode ? { errorCode } : {}),
    turns,
    messages,
  };
}

function protocolErrorCode(error: unknown): string {
  return error instanceof AgentProtocolError ? error.code : "protocol_error";
}

function providerErrorDetails(error: unknown) {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.retryAfterMs === "number"
      ? { retryAfterMs: value.retryAfterMs }
      : {}),
  };
}
