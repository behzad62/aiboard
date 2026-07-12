import { createHash, randomUUID } from "node:crypto";

import type {
  AgentMessage,
  AgentModel,
  AgentLifecycleSignal,
  ToolCallBlock,
  ToolExecutionContext,
} from "./agent-contracts.js";
import {
  AgentProtocolError,
  type AgentToolRuntime,
} from "./tool-registry.js";
import { BudgetExceededError } from "./budget-ledger.js";

export type AgentSuspensionReason =
  | "model_ended_without_lifecycle"
  | "provider_error"
  | "protocol_error"
  | "turn_limit"
  | "cancelled"
  | "max_tokens"
  | "checkpoint_error"
  | "budget_exhausted";

export type AgentLoopResult =
  | {
      status: "submitted";
      changeSetId: string;
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
        | "task_revised"
        | "guidance_answered"
        | "review_decided"
        | "integration_requested"
        | "run_completed";
      referenceId?: string;
      turns: number;
      messages: AgentMessage[];
    }
  | {
      status: "suspended";
      reason: AgentSuspensionReason;
      error?: string;
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
  const initialTurns = messages.filter((message) => message.role === "assistant").length;
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
    try {
      options.registry.assertUniqueCallIds(pendingCalls, seenCallIds);
      assertLifecycleBatch(pendingCalls, options.registry);
    } catch (error) {
      return suspended(
        "protocol_error",
        initialTurns,
        messages,
        error instanceof Error ? error.message : String(error)
      );
    }
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

  for (
    let turnNumber = initialTurns + 1;
    turnNumber <= finalTurn;
    turnNumber += 1
  ) {
    if (options.signal?.aborted) {
      return suspended("cancelled", turnNumber - 1, messages);
    }
    let turn;
    try {
      turn = await options.model.complete({
        sessionId: options.context.sessionId,
        messages: compactAgentMessages(messages, options.workingSet),
        tools: options.registry.definitions(),
        signal: options.signal,
      });
    } catch (error) {
      return suspended(
        options.signal?.aborted
          ? "cancelled"
          : error instanceof BudgetExceededError
            ? "budget_exhausted"
            : "provider_error",
        turnNumber - 1,
        messages,
        error instanceof Error ? error.message : String(error),
        error instanceof BudgetExceededError ? undefined : providerErrorDetails(error)
      );
    }

    if (!turn || !Array.isArray(turn.blocks)) {
      return suspended(
        "protocol_error",
        turnNumber,
        messages,
        "Provider returned an invalid native turn."
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
      return suspended(
        "protocol_error",
        turnNumber,
        messages,
        error instanceof Error ? error.message : String(error)
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
  }
  return suspended("turn_limit", finalTurn, messages);
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
  });
}

export function compactAgentMessages(
  messages: readonly AgentMessage[],
  limits: AgentWorkingSetLimits = {
    maxMessages: 80,
    maxBytes: 512 * 1024,
    retainRecent: 24,
  }
): AgentMessage[] {
  if (
    !Number.isSafeInteger(limits.maxMessages) || limits.maxMessages < 3 ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1_024 ||
    !Number.isSafeInteger(limits.retainRecent) || limits.retainRecent < 1
  ) throw new Error("Agent working-set limits are invalid.");
  const currentMessages = omitSupersededRunnerSnapshots(messages);
  if (
    currentMessages.length <= limits.maxMessages &&
    Buffer.byteLength(JSON.stringify(currentMessages)) <= limits.maxBytes
  ) return currentMessages;

  const cutoff = Math.max(0, currentMessages.length - limits.retainRecent);
  const protectedMessages = currentMessages
    .slice(0, cutoff)
    .filter((message) => message.role === "system" || message.role === "user");
  const compactable = currentMessages
    .slice(0, cutoff)
    .filter((message) => message.role === "assistant" || message.role === "tool");
  const recent = currentMessages.slice(cutoff);
  if (compactable.length === 0) return currentMessages;

  const facts = compactable.map(historyFact);
  let included = facts.length;
  let summary = summaryMessage(facts, included);
  let result = [...protectedMessages, summary, ...recent];
  while (
    included > 1 &&
    (result.length > limits.maxMessages ||
      Buffer.byteLength(JSON.stringify(result)) > limits.maxBytes)
  ) {
    included = Math.max(1, Math.floor(included * 0.75));
    summary = summaryMessage(facts.slice(facts.length - included), facts.length);
    result = [...protectedMessages, summary, ...recent];
  }
  return result;
}

function omitSupersededRunnerSnapshots(
  messages: readonly AgentMessage[]
): AgentMessage[] {
  const prefixes = ["context:", "action-resume:", "worker-resume:"];
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

function historyFact(message: AgentMessage): Record<string, unknown> {
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return {
      id: message.id,
      role: message.role,
      blocks: message.content.map((block) =>
        block.type === "tool_call"
          ? { type: block.type, callId: block.callId, name: block.name }
          : { type: block.type, text: block.text.slice(0, 256) }
      ),
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
  const lifecycleCalls = calls.filter((call) =>
    registry.isLifecycleTool(call.name)
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
  }
): AgentLoopResult {
  return {
    status: "suspended",
    reason,
    ...(error ? { error } : {}),
    ...(providerError && Object.keys(providerError).length > 0
      ? { providerError }
      : {}),
    turns,
    messages,
  };
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
