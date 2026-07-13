import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "./agent-contracts.js";
import type {
  BudgetLedger,
  ModelCallAttribution,
  ModelCostBasisSnapshot,
  ModelTokenSource,
} from "./budget-ledger.js";

export interface BudgetedAgentModelOptions {
  model: AgentModel;
  ledger: BudgetLedger;
  scopeId: string;
  attribution: ModelCallAttribution;
  outputTokenReserve: number;
  estimateCostMicros?: ModelCostEstimator;
  costBasis?: ModelCostBasisSnapshot;
  clock?: () => string;
}

export type ModelCostEstimator = (
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens?: number,
  cacheWriteInputTokens?: number
) => number;

export class BudgetedAgentModel implements AgentModel {
  private readonly model: AgentModel;
  private readonly ledger: BudgetLedger;
  private readonly scopeId: string;
  private readonly attribution: Readonly<ModelCallAttribution>;
  private readonly outputTokenReserve: number;
  private readonly estimateCostMicros: ModelCostEstimator;
  private readonly costBasis: ModelCostBasisSnapshot;
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
    this.attribution = Object.freeze({ ...options.attribution });
    this.outputTokenReserve = options.outputTokenReserve;
    this.estimateCostMicros = options.estimateCostMicros ?? (() => 0);
    this.costBasis = options.costBasis ?? { kind: "unknown" };
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
      attribution: this.attribution,
      costBasis: this.costBasis,
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
      const actualInput = resolveTransportInputTokens(
        turn.usage?.inputTokens,
        turn.usage?.inputTokenSource
      );
      const actualOutput = resolveTokens(
        turn.usage?.outputTokens,
        estimateSerializedTokens(turn.blocks)
      );
      const cachedInput = nonNegative(turn.usage?.cachedInputTokens, 0);
      const cacheWriteInput = nonNegative(turn.usage?.cacheWriteInputTokens, 0);
      this.settle(
        reservationId,
        actualInput.value,
        actualOutput.value,
        checkedCost(this.estimateCostMicros(
          actualInput.value,
          actualOutput.value,
          cachedInput,
          cacheWriteInput
        )),
        cachedInput,
        cacheWriteInput,
        actualInput.source,
        actualOutput.source
      );
      return turn;
    } catch (error) {
      this.settle(
        reservationId,
        inputTokens,
        this.outputTokenReserve,
        estimatedCostMicros,
        0,
        0,
        "estimated",
        "estimated"
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
    estimatedCostMicros: number,
    cachedInputTokens: number,
    cacheWriteInputTokens: number,
    inputTokenSource: ModelTokenSource,
    outputTokenSource: ModelTokenSource
  ): void {
    const settledAt = this.clock();
    this.ledger.settle({
      scopeId: this.scopeId,
      reservationId,
      actual: {
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens,
        estimatedCostMicros,
      },
      tokenSources: {
        inputTokens: inputTokenSource,
        outputTokens: outputTokenSource,
      },
      costBasis: this.costBasis,
      occurredAt: settledAt,
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
  return estimateSerializedTokens({ messages: request.messages, tools: request.tools });
}

function estimateSerializedTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value)) / 4);
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

function resolveTransportInputTokens(
  value: number | undefined,
  source: ModelTokenSource | undefined
): { value: number; source: ModelTokenSource } {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Invalid transport input token usage.");
  }
  return {
    value: value as number,
    source: source ?? "reported",
  };
}

function resolveTokens(
  reported: number | undefined,
  estimated: number
): { value: number; source: ModelTokenSource } {
  return Number.isSafeInteger(reported) && (reported as number) >= 0
    ? { value: reported as number, source: "reported" }
    : { value: estimated, source: "estimated" };
}
