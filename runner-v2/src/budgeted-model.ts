import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "./agent-contracts.js";
import type { BudgetLedger } from "./budget-ledger.js";

export interface BudgetedAgentModelOptions {
  model: AgentModel;
  ledger: BudgetLedger;
  scopeId: string;
  outputTokenReserve: number;
  estimateCostMicros?: (inputTokens: number, outputTokens: number) => number;
  clock?: () => string;
}

export class BudgetedAgentModel implements AgentModel {
  private readonly model: AgentModel;
  private readonly ledger: BudgetLedger;
  private readonly scopeId: string;
  private readonly outputTokenReserve: number;
  private readonly estimateCostMicros: (
    inputTokens: number,
    outputTokens: number
  ) => number;
  private readonly clock: () => string;

  constructor(options: BudgetedAgentModelOptions) {
    if (
      !Number.isSafeInteger(options.outputTokenReserve) ||
      options.outputTokenReserve < 0
    ) {
      throw new Error("outputTokenReserve must be a non-negative integer.");
    }
    this.model = options.model;
    this.ledger = options.ledger;
    this.scopeId = options.scopeId;
    this.outputTokenReserve = options.outputTokenReserve;
    this.estimateCostMicros = options.estimateCostMicros ?? (() => 0);
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const inputTokens = estimateInputTokens(request);
    const reservationId = this.nextReservationId(request.sessionId);
    const estimatedCostMicros = checkedCost(
      this.estimateCostMicros(inputTokens, this.outputTokenReserve)
    );
    this.ledger.reserve({
      scopeId: this.scopeId,
      reservationId,
      kind: "model",
      estimate: {
        inputTokens,
        outputTokens: this.outputTokenReserve,
        estimatedCostMicros,
      },
      occurredAt: this.clock(),
      idempotencyKey: `reserve:${reservationId}`,
    });
    const activeSegmentId = `active:${reservationId}`;
    this.ledger.startActive({
      scopeId: this.scopeId,
      segmentId: activeSegmentId,
      occurredAt: this.clock(),
      idempotencyKey: `start:${activeSegmentId}`,
    });
    try {
      const turn = await this.model.complete(request);
      const actualInput = nonNegative(turn.usage?.inputTokens, inputTokens);
      const actualOutput = nonNegative(
        turn.usage?.outputTokens,
        this.outputTokenReserve
      );
      this.settle(
        reservationId,
        actualInput,
        actualOutput,
        checkedCost(this.estimateCostMicros(actualInput, actualOutput))
      );
      return turn;
    } catch (error) {
      this.settle(
        reservationId,
        inputTokens,
        this.outputTokenReserve,
        estimatedCostMicros
      );
      throw error;
    } finally {
      this.ledger.stopActive({
        scopeId: this.scopeId,
        segmentId: activeSegmentId,
        occurredAt: this.clock(),
        idempotencyKey: `stop:${activeSegmentId}`,
      });
    }
  }

  private settle(
    reservationId: string,
    inputTokens: number,
    outputTokens: number,
    estimatedCostMicros: number
  ): void {
    this.ledger.settle({
      scopeId: this.scopeId,
      reservationId,
      actual: { inputTokens, outputTokens, estimatedCostMicros },
      occurredAt: this.clock(),
      idempotencyKey: `settle:${reservationId}`,
    });
  }

  private nextReservationId(sessionId: string): string {
    const prefix = `model:${sessionId}:`;
    const count = this.ledger
      .events(this.scopeId)
      .filter(
        (event) =>
          event.type === "budget.reserved" &&
          typeof event.payload.reservationId === "string" &&
          event.payload.reservationId.startsWith(prefix)
      ).length;
    return `${prefix}${count + 1}`;
  }
}

function estimateInputTokens(request: AgentModelRequest): number {
  return Math.ceil(
    Buffer.byteLength(
      JSON.stringify({ messages: request.messages, tools: request.tools })
    ) / 4
  );
}

function checkedCost(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Estimated model cost must be a non-negative integer in micros.");
  }
  return value;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : fallback;
}
