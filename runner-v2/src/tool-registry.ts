import type {
  NativeTool,
  ToolCallBlock,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  ValidationResult,
} from "./agent-contracts.js";

export type { ValidationResult } from "./agent-contracts.js";

export type AgentProtocolErrorCode =
  | "duplicate_call_id"
  | "invalid_call_id"
  | "invalid_lifecycle_batch";

export class AgentProtocolError extends Error {
  constructor(readonly code: AgentProtocolErrorCode, message: string) {
    super(message);
    this.name = "AgentProtocolError";
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, NativeTool<unknown>>();

  register<TInput>(tool: NativeTool<TInput>): void {
    const name = tool.definition.name;
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
      throw new Error(`Tool name ${name} is invalid.`);
    }
    if (!tool.definition.description.trim()) {
      throw new Error(`Tool ${name} requires a description.`);
    }
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered.`);
    this.tools.set(name, tool as NativeTool<unknown>);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  isLifecycleTool(name: string): boolean {
    return this.tools.get(name)?.definition.lifecycle === true;
  }

  assertUniqueCallIds(
    calls: readonly ToolCallBlock[],
    seenCallIds: ReadonlySet<string>
  ): void {
    const current = new Set<string>();
    for (const call of calls) {
      if (!call.callId.trim()) {
        throw new AgentProtocolError(
          "invalid_call_id",
          "Tool call IDs must be non-empty."
        );
      }
      if (seenCallIds.has(call.callId) || current.has(call.callId)) {
        throw new AgentProtocolError(
          "duplicate_call_id",
          `Tool call ID ${call.callId} was already used.`
        );
      }
      current.add(call.callId);
    }
  }

  async invoke(
    call: ToolCallBlock,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return failure(call, "unknown_tool", `Tool ${call.name} is not registered.`);
    }
    let validation: ValidationResult<unknown>;
    try {
      validation = tool.validate(call.arguments);
    } catch (error) {
      return failure(
        call,
        "invalid_arguments",
        error instanceof Error ? error.message : "Tool argument validation failed."
      );
    }
    if (!validation.ok) {
      return {
        ...failure(call, "invalid_arguments", `Arguments for ${call.name} are invalid.`),
        error: {
          code: "invalid_arguments",
          message: `Arguments for ${call.name} are invalid.`,
          issues: [...validation.issues],
        },
      };
    }
    try {
      const output = await tool.execute(validation.value, context);
      if (output.lifecycle && tool.definition.lifecycle !== true) {
        return failure(
          call,
          "invalid_lifecycle_signal",
          `Non-lifecycle tool ${call.name} returned a lifecycle signal.`
        );
      }
      return { callId: call.callId, toolName: call.name, ...output };
    } catch (error) {
      return failure(
        call,
        "tool_execution_failed",
        error instanceof Error ? error.message : "Tool execution failed."
      );
    }
  }
}

function failure(
  call: ToolCallBlock,
  code: string,
  message: string
): ToolResult {
  return {
    callId: call.callId,
    toolName: call.name,
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
