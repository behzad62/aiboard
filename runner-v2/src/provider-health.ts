export type ProviderFailureKind =
  | "usage_limit"
  | "rate_limit"
  | "authentication"
  | "provider_unavailable"
  | "transient"
  | "invalid_request"
  | "cancelled";

export interface ProviderFailure {
  kind: ProviderFailureKind;
  message: string;
  retryAfterMs?: number;
}

export interface ProviderErrorDetails {
  status?: number;
  code?: string;
  message?: string;
  retryAfterMs?: number;
  name?: string;
}

export interface ProviderHealthState {
  providerId: string;
  status: "healthy" | "cooldown";
  consecutiveFailures: number;
  updatedAt: number;
  failureKind?: ProviderFailureKind;
  failureMessage?: string;
  cooldownUntil?: number;
}

export interface ProviderHealthRegistryOptions {
  clock?: () => number;
  initial?: readonly ProviderHealthState[];
  transientFailureThreshold?: number;
}

const DEFAULT_COOLDOWN_MS: Partial<Record<ProviderFailureKind, number>> = {
  usage_limit: 60 * 60 * 1_000,
  rate_limit: 60 * 1_000,
  authentication: 24 * 60 * 60 * 1_000,
  provider_unavailable: 5 * 60 * 1_000,
  transient: 30 * 1_000,
};

export function classifyProviderFailure(error: unknown): ProviderFailure {
  const details = normalizeError(error);
  const code = details.code?.toLowerCase() ?? "";
  const message = details.message || "Provider request failed.";
  let kind: ProviderFailureKind;
  if (details.name === "AbortError" || code === "aborted" || code === "cancelled") {
    kind = "cancelled";
  } else if (details.status === 401 || details.status === 403) {
    kind = "authentication";
  } else if (
    details.status === 429 &&
    (/usage|quota|insufficient/.test(code) || /usage limit|quota/i.test(message))
  ) {
    kind = "usage_limit";
  } else if (details.status === 429) {
    kind = "rate_limit";
  } else if (details.status !== undefined && details.status >= 500) {
    kind = "provider_unavailable";
  } else if (details.status !== undefined && details.status >= 400) {
    kind = "invalid_request";
  } else {
    kind = "transient";
  }
  return {
    kind,
    message,
    ...(details.retryAfterMs !== undefined
      ? { retryAfterMs: details.retryAfterMs }
      : {}),
  };
}

export class ProviderHealthRegistry {
  private readonly states = new Map<string, ProviderHealthState>();
  private readonly clock: () => number;
  private readonly transientFailureThreshold: number;

  constructor(options: ProviderHealthRegistryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.transientFailureThreshold = options.transientFailureThreshold ?? 2;
    if (
      !Number.isSafeInteger(this.transientFailureThreshold) ||
      this.transientFailureThreshold < 1
    ) {
      throw new Error("transientFailureThreshold must be a positive integer.");
    }
    for (const state of options.initial ?? []) {
      if (!state.providerId) throw new Error("Provider health requires providerId.");
      this.states.set(state.providerId, cloneState(state));
    }
  }

  recordFailure(
    providerId: string,
    failure: ProviderFailure
  ): ProviderHealthState {
    if (!providerId) throw new Error("providerId is required.");
    if (!failure.message.trim()) throw new Error("Provider failure message is required.");
    if (
      failure.retryAfterMs !== undefined &&
      (!Number.isSafeInteger(failure.retryAfterMs) || failure.retryAfterMs < 0)
    ) {
      throw new Error("retryAfterMs must be a non-negative integer.");
    }
    const now = this.clock();
    const previous = this.states.get(providerId);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const confirmed =
      failure.kind !== "invalid_request" &&
      failure.kind !== "cancelled" &&
      (failure.kind !== "transient" ||
        consecutiveFailures >= this.transientFailureThreshold);
    const cooldownMs = confirmed
      ? failure.retryAfterMs ?? DEFAULT_COOLDOWN_MS[failure.kind] ?? 0
      : 0;
    const state: ProviderHealthState = {
      providerId,
      status: cooldownMs > 0 ? "cooldown" : "healthy",
      consecutiveFailures,
      updatedAt: now,
      failureKind: failure.kind,
      failureMessage: failure.message,
      ...(cooldownMs > 0 ? { cooldownUntil: now + cooldownMs } : {}),
    };
    this.states.set(providerId, state);
    return cloneState(state);
  }

  recordSuccess(providerId: string): ProviderHealthState {
    if (!providerId) throw new Error("providerId is required.");
    const state: ProviderHealthState = {
      providerId,
      status: "healthy",
      consecutiveFailures: 0,
      updatedAt: this.clock(),
    };
    this.states.set(providerId, state);
    return cloneState(state);
  }

  isAvailable(providerId: string): boolean {
    const state = this.states.get(providerId);
    if (!state || state.status === "healthy") return true;
    return state.cooldownUntil !== undefined && this.clock() >= state.cooldownUntil;
  }

  get(providerId: string): ProviderHealthState {
    const state = this.states.get(providerId);
    return state
      ? cloneState(state)
      : {
          providerId,
          status: "healthy",
          consecutiveFailures: 0,
          updatedAt: this.clock(),
        };
  }

  snapshot(): ProviderHealthState[] {
    return [...this.states.values()]
      .map(cloneState)
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }
}

function cloneState(state: ProviderHealthState): ProviderHealthState {
  return { ...state };
}

function normalizeError(error: unknown): ProviderErrorDetails {
  if (error instanceof Error) {
    const extended = error as Error & ProviderErrorDetails;
    return {
      name: error.name,
      message: error.message,
      ...(typeof extended.status === "number" ? { status: extended.status } : {}),
      ...(typeof extended.code === "string" ? { code: extended.code } : {}),
      ...(typeof extended.retryAfterMs === "number"
        ? { retryAfterMs: extended.retryAfterMs }
        : {}),
    };
  }
  if (typeof error === "object" && error !== null) {
    const value = error as Record<string, unknown>;
    return {
      ...(typeof value.status === "number" ? { status: value.status } : {}),
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.message === "string" ? { message: value.message } : {}),
      ...(typeof value.retryAfterMs === "number"
        ? { retryAfterMs: value.retryAfterMs }
        : {}),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
    };
  }
  return { message: String(error) };
}
