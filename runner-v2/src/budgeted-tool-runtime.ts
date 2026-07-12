import type {
  ToolCallBlock,
  ToolExecutionContext,
  ToolResult,
} from "./agent-contracts.js";
import {
  BudgetExceededError,
  type BudgetLedger,
} from "./budget-ledger.js";
import type { AgentToolRuntime } from "./tool-registry.js";

export interface BudgetedToolRuntimeOptions {
  runtime: AgentToolRuntime;
  ledger: BudgetLedger;
  scopeId: string;
  clock?: () => string;
}

export class BudgetedToolRuntime implements AgentToolRuntime {
  private readonly clock: () => string;

  constructor(private readonly options: BudgetedToolRuntimeOptions) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  definitions() {
    return this.options.runtime.definitions();
  }

  isLifecycleTool(name: string): boolean {
    return this.options.runtime.isLifecycleTool(name);
  }

  assertUniqueCallIds(
    calls: readonly ToolCallBlock[],
    seenCallIds: ReadonlySet<string>
  ): void {
    this.options.runtime.assertUniqueCallIds(calls, seenCallIds);
  }

  async invoke(
    call: ToolCallBlock,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const reservationId = `tool:${context.sessionId}:${call.callId}`;
    try {
      this.options.ledger.reserve({
        scopeId: this.options.scopeId,
        reservationId,
        kind: "tool",
        estimate: {},
        occurredAt: this.clock(),
        idempotencyKey: `reserve:${reservationId}`,
      });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        const message = `Tool-call budget ${error.dimension} reached its limit ${error.limit}.`;
        return {
          callId: call.callId,
          toolName: call.name,
          content: [{ type: "text", text: message }],
          isError: true,
          error: { code: "budget_exhausted", message },
        };
      }
      throw error;
    }
    const activeSegmentId = `active:${reservationId}`;
    this.options.ledger.startActive({
      scopeId: this.options.scopeId,
      segmentId: activeSegmentId,
      occurredAt: this.clock(),
      idempotencyKey: `start:${activeSegmentId}`,
    });
    try {
      return await this.options.runtime.invoke(call, context);
    } finally {
      this.options.ledger.settle({
        scopeId: this.options.scopeId,
        reservationId,
        actual: {},
        occurredAt: this.clock(),
        idempotencyKey: `settle:${reservationId}`,
      });
      this.options.ledger.stopActive({
        scopeId: this.options.scopeId,
        segmentId: activeSegmentId,
        occurredAt: this.clock(),
        idempotencyKey: `stop:${activeSegmentId}`,
      });
    }
  }
}
