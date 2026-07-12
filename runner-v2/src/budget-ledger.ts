export type BudgetReservationKind = "model" | "tool";

export interface BudgetUsage {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  estimatedCostMicros: number;
  activeMs: number;
  artifactBytes: number;
}

export type BudgetAmount = Partial<Omit<BudgetUsage, "modelCalls" | "toolCalls" | "activeMs">>;

export interface BudgetLimits {
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxEstimatedCostMicros?: number;
  maxActiveMs?: number;
  maxArtifactBytes?: number;
}

export type BudgetDimension = Exclude<
  keyof BudgetUsage,
  "cachedInputTokens" | "cacheWriteInputTokens"
>;

export class BudgetExceededError extends Error {
  constructor(
    readonly scopeId: string,
    readonly dimension: BudgetDimension,
    readonly attempted: number,
    readonly limit: number
  ) {
    super(
      `Budget ${dimension} for ${scopeId} would reach ${attempted}, above limit ${limit}.`
    );
    this.name = "BudgetExceededError";
  }
}

export type BudgetEventType =
  | "budget.reserved"
  | "budget.settled"
  | "active.started"
  | "active.stopped";

export interface BudgetEvent {
  sequence: number;
  eventId: string;
  scopeId: string;
  type: BudgetEventType;
  occurredAt: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export interface BudgetReservationProjection {
  reservationId: string;
  kind: BudgetReservationKind;
  estimate: BudgetAmount;
  actual?: BudgetAmount;
  status: "reserved" | "settled";
}

export interface ActiveSegmentProjection {
  segmentId: string;
  startedAt: string;
  reserveMs: number;
  durationMs?: number;
}

export interface BudgetProjection {
  scopeId: string;
  reservations: Record<string, BudgetReservationProjection>;
  activeSegments: Record<string, ActiveSegmentProjection>;
  effective: BudgetUsage;
  lastSequence: number;
}

export interface ReserveBudgetInput {
  scopeId: string;
  reservationId: string;
  kind: BudgetReservationKind;
  estimate: BudgetAmount;
  occurredAt: string;
  idempotencyKey: string;
}

export interface SettleBudgetInput {
  scopeId: string;
  reservationId: string;
  actual: BudgetAmount;
  occurredAt: string;
  idempotencyKey: string;
}

export interface StartActiveInput {
  scopeId: string;
  segmentId: string;
  reserveMs?: number;
  occurredAt: string;
  idempotencyKey: string;
}

export interface StopActiveInput {
  scopeId: string;
  segmentId: string;
  occurredAt: string;
  idempotencyKey: string;
}

export interface BudgetLedger {
  reserve(input: ReserveBudgetInput): BudgetEvent;
  settle(input: SettleBudgetInput): BudgetEvent;
  startActive(input: StartActiveInput): BudgetEvent;
  stopActive(input: StopActiveInput): BudgetEvent;
  snapshot(scopeId: string): BudgetProjection;
  events(scopeId: string): BudgetEvent[];
  close(): void;
}

export function rebuildBudgetProjection(
  scopeId: string,
  events: readonly BudgetEvent[]
): BudgetProjection {
  const projection: BudgetProjection = {
    scopeId,
    reservations: {},
    activeSegments: {},
    effective: emptyUsage(),
    lastSequence: 0,
  };
  for (const event of events) reduceBudgetEvent(projection, event);
  projection.effective = effectiveUsage(projection);
  return projection;
}

export function reduceBudgetEvent(
  projection: BudgetProjection,
  event: BudgetEvent
): void {
  if (event.scopeId !== projection.scopeId) {
    throw new Error(`Budget event ${event.eventId} belongs to another scope.`);
  }
  if (event.type === "budget.reserved") {
    const reservationId = requiredString(event.payload, "reservationId");
    if (projection.reservations[reservationId]) {
      throw new Error(`Duplicate budget reservation ${reservationId}.`);
    }
    const kind = requiredString(event.payload, "kind");
    if (kind !== "model" && kind !== "tool") throw new Error(`Invalid budget kind ${kind}.`);
    projection.reservations[reservationId] = {
      reservationId,
      kind,
      estimate: usageAmount(event.payload.estimate),
      status: "reserved",
    };
  } else if (event.type === "budget.settled") {
    const reservationId = requiredString(event.payload, "reservationId");
    const reservation = projection.reservations[reservationId];
    if (!reservation || reservation.status !== "reserved") {
      throw new Error(`Budget reservation ${reservationId} is not open.`);
    }
    projection.reservations[reservationId] = {
      ...reservation,
      status: "settled",
      actual: usageAmount(event.payload.actual),
    };
  } else if (event.type === "active.started") {
    const segmentId = requiredString(event.payload, "segmentId");
    if (projection.activeSegments[segmentId]) {
      throw new Error(`Duplicate active segment ${segmentId}.`);
    }
    projection.activeSegments[segmentId] = {
      segmentId,
      startedAt: event.occurredAt,
      reserveMs: requiredNonNegative(event.payload, "reserveMs"),
    };
  } else {
    const segmentId = requiredString(event.payload, "segmentId");
    const segment = projection.activeSegments[segmentId];
    if (!segment || segment.durationMs !== undefined) {
      throw new Error(`Active segment ${segmentId} is not open.`);
    }
    projection.activeSegments[segmentId] = {
      ...segment,
      durationMs: requiredNonNegative(event.payload, "durationMs"),
    };
  }
  projection.lastSequence = event.sequence;
  projection.effective = effectiveUsage(projection);
}

function effectiveUsage(projection: BudgetProjection): BudgetUsage {
  const usage = emptyUsage();
  for (const reservation of Object.values(projection.reservations)) {
    if (reservation.kind === "model") usage.modelCalls += 1;
    else usage.toolCalls += 1;
    addAmount(usage, reservation.actual ?? reservation.estimate);
  }
  for (const segment of Object.values(projection.activeSegments)) {
    usage.activeMs += segment.durationMs ?? segment.reserveMs;
  }
  return usage;
}

function addAmount(target: BudgetUsage, amount: BudgetAmount): void {
  target.inputTokens += amount.inputTokens ?? 0;
  target.cachedInputTokens =
    (target.cachedInputTokens ?? 0) + (amount.cachedInputTokens ?? 0);
  target.cacheWriteInputTokens =
    (target.cacheWriteInputTokens ?? 0) + (amount.cacheWriteInputTokens ?? 0);
  target.outputTokens += amount.outputTokens ?? 0;
  target.estimatedCostMicros += amount.estimatedCostMicros ?? 0;
  target.artifactBytes += amount.artifactBytes ?? 0;
}

export function emptyUsage(): BudgetUsage {
  return {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    estimatedCostMicros: 0,
    activeMs: 0,
    artifactBytes: 0,
  };
}

export function usageAmount(value: unknown): BudgetAmount {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Budget amount must be an object.");
  }
  const input = value as Record<string, unknown>;
  const result: BudgetAmount = {};
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "estimatedCostMicros",
    "artifactBytes",
  ] as const) {
    const amount = input[key];
    if (amount === undefined) continue;
    if (!Number.isSafeInteger(amount) || (amount as number) < 0) {
      throw new Error(`Budget ${key} must be a non-negative integer.`);
    }
    result[key] = amount as number;
  }
  return result;
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing ${key}.`);
  return value;
}

function requiredNonNegative(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Missing ${key}.`);
  }
  return value as number;
}
