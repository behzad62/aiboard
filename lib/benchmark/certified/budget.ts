import type { CertifiedRunBudget } from "./run-context";

export interface CertifiedModelCallReservation {
  inputTokens?: number;
}

export interface CertifiedModelCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedUsd?: number | null;
}

export interface CertifiedBudgetSnapshot {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

export class CertifiedBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CertifiedBudgetExceededError";
  }
}

export interface CertifiedBudgetController {
  reserveModelCall(input?: CertifiedModelCallReservation): void;
  recordModelCallUsage(input: CertifiedModelCallUsage): void;
  snapshot(): CertifiedBudgetSnapshot;
}

export function createCertifiedBudgetController(input: {
  budget: CertifiedRunBudget;
  startedAt: string;
  now?: () => number;
}): CertifiedBudgetController {
  const now = input.now ?? (() => Date.now());
  const startedMs = new Date(input.startedAt).getTime();
  const state: CertifiedBudgetSnapshot = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
  };

  const assertWithinBudget = (phase: string): void => {
    const budget = input.budget;
    if (
      typeof budget.maxModelCalls === "number" &&
      state.modelCalls > budget.maxModelCalls
    ) {
      throw new CertifiedBudgetExceededError(
        `Certified budget exceeded during ${phase}: model calls ${state.modelCalls} exceeded maxModelCalls ${budget.maxModelCalls}.`
      );
    }
    if (
      typeof budget.maxInputTokens === "number" &&
      state.inputTokens > budget.maxInputTokens
    ) {
      throw new CertifiedBudgetExceededError(
        `Certified budget exceeded during ${phase}: input tokens ${state.inputTokens} exceeded maxInputTokens ${budget.maxInputTokens}.`
      );
    }
    if (
      typeof budget.maxOutputTokens === "number" &&
      state.outputTokens > budget.maxOutputTokens
    ) {
      throw new CertifiedBudgetExceededError(
        `Certified budget exceeded during ${phase}: output tokens ${state.outputTokens} exceeded maxOutputTokens ${budget.maxOutputTokens}.`
      );
    }
    if (
      typeof budget.maxUsd === "number" &&
      state.pricedCalls > 0 &&
      state.estimatedUsd > budget.maxUsd
    ) {
      throw new CertifiedBudgetExceededError(
        `Certified budget exceeded during ${phase}: estimated USD ${state.estimatedUsd.toFixed(6)} exceeded maxUsd ${budget.maxUsd}.`
      );
    }
    if (
      typeof budget.maxWallClockMs === "number" &&
      Number.isFinite(startedMs) &&
      now() - startedMs > budget.maxWallClockMs
    ) {
      throw new CertifiedBudgetExceededError(
        `Certified budget exceeded during ${phase}: wall-clock time exceeded maxWallClockMs ${budget.maxWallClockMs}.`
      );
    }
  };

  return {
    reserveModelCall(reservation = {}) {
      assertWithinBudget("model-call preflight");
      const projectedInputTokens =
        state.inputTokens + positiveInteger(reservation.inputTokens);
      if (
        typeof input.budget.maxInputTokens === "number" &&
        projectedInputTokens > input.budget.maxInputTokens
      ) {
        throw new CertifiedBudgetExceededError(
          `Certified budget exceeded during model-call preflight: input tokens ${projectedInputTokens} exceeded maxInputTokens ${input.budget.maxInputTokens}.`
        );
      }
      state.modelCalls += 1;
      assertWithinBudget("model-call preflight");
    },
    recordModelCallUsage(usage) {
      state.inputTokens += positiveInteger(usage.inputTokens);
      state.outputTokens += positiveInteger(usage.outputTokens);
      if (typeof usage.estimatedUsd === "number" && Number.isFinite(usage.estimatedUsd)) {
        state.estimatedUsd += Math.max(0, usage.estimatedUsd);
        state.pricedCalls += 1;
      } else {
        state.unpricedCalls += 1;
      }
      assertWithinBudget("model-call accounting");
    },
    snapshot() {
      return { ...state };
    },
  };
}

function positiveInteger(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}
