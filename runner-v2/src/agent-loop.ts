import { randomUUID } from "node:crypto";

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

export type AgentSuspensionReason =
  | "model_ended_without_lifecycle"
  | "provider_error"
  | "protocol_error"
  | "turn_limit"
  | "cancelled"
  | "max_tokens"
  | "checkpoint_error";

export type AgentLoopResult =
  | {
      status: "submitted";
      changeSetId: string;
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
      status: "suspended";
      reason: AgentSuspensionReason;
      error?: string;
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
    for (const call of pendingCalls) {
      seenCallIds.add(call.callId);
      const result = await options.registry.invoke(call, {
        ...options.context,
        signal: options.signal ?? options.context.signal,
      });
      messages.push({
        id: `tool_${nextId()}`,
        role: "tool",
        content: result,
      });
      const checkpointError = await checkpoint(
        options,
        messages,
        initialTurns,
        seenCallIds
      );
      if (checkpointError) return checkpointError;
      if (!result.isError && result.lifecycle) {
        return lifecycleResult(result.lifecycle, initialTurns, messages);
      }
    }
  }

  for (
    let turnNumber = initialTurns + 1;
    turnNumber <= maxTurns;
    turnNumber += 1
  ) {
    if (options.signal?.aborted) {
      return suspended("cancelled", turnNumber - 1, messages);
    }
    let turn;
    try {
      turn = await options.model.complete({
        sessionId: options.context.sessionId,
        messages: [...messages],
        tools: options.registry.definitions(),
        signal: options.signal,
      });
    } catch (error) {
      return suspended(
        options.signal?.aborted ? "cancelled" : "provider_error",
        turnNumber - 1,
        messages,
        error instanceof Error ? error.message : String(error)
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

    for (const call of calls) {
      if (options.signal?.aborted) {
        return suspended("cancelled", turnNumber, messages);
      }
      const result = await options.registry.invoke(call, {
        ...options.context,
        signal: options.signal ?? options.context.signal,
      });
      messages.push({
        id: `tool_${nextId()}`,
        role: "tool",
        content: result,
      });
      const toolCheckpointError = await checkpoint(
        options,
        messages,
        turnNumber,
        seenCallIds
      );
      if (toolCheckpointError) return toolCheckpointError;
      if (!result.isError && result.lifecycle) {
        return lifecycleResult(result.lifecycle, turnNumber, messages);
      }
    }
  }
  return suspended("turn_limit", maxTurns, messages);
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
  }
}

function suspended(
  reason: AgentSuspensionReason,
  turns: number,
  messages: AgentMessage[],
  error?: string
): AgentLoopResult {
  return {
    status: "suspended",
    reason,
    ...(error ? { error } : {}),
    turns,
    messages,
  };
}
