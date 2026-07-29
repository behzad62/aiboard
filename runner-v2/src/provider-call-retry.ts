import type { ProviderFailure } from "./provider-health.js";
import type { RunnerProviderRetryEvent } from "./contracts.js";
import { ProviderTransportError } from "./account-runner-model.js";

export const RUNNER_PROVIDER_RETRY_DELAYS_MS =
  [2_000, 5_000, 15_000, 30_000, 60_000] as const;

const RUNNER_PROVIDER_RETRY_JITTER_RATIO = 0.2;

export type { RunnerProviderRetryEvent } from "./contracts.js";

export interface RunnerProviderRetryRuntime {
  now(): number;
  random(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function runnerProviderRetryDeadlineMs(
  maxActiveMs: number | undefined,
  usedActiveMs: number,
  nowMs: number
): number | undefined {
  if (maxActiveMs === undefined) return undefined;
  return nowMs + Math.max(0, maxActiveMs - usedActiveMs);
}

export class ProviderRetryDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`Provider retry cannot be admitted before deadline ${deadlineMs}.`);
    this.name = "ProviderRetryDeadlineError";
  }
}

export async function completeWithProviderRetry<T>(input: {
  complete: () => Promise<T>;
  signal?: AbortSignal;
  deadlineMs?: number;
  classify(error: unknown): ProviderFailure;
  onRetry?(event: Omit<RunnerProviderRetryEvent, "occurredAt">): void;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  runtimeId?: string;
  providerId?: string;
  modelId?: string;
  retryIdentity?: string;
}): Promise<T> {
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? defaultSleep;
  throwIfAborted(input.signal);
  assertBeforeDeadline(input.deadlineMs, now(), 0);

  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= RUNNER_PROVIDER_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    if (attempt > 0) {
      const failure = input.classify(lastError);
      const delayMs = retryDelayMs(
        RUNNER_PROVIDER_RETRY_DELAYS_MS[attempt - 1],
        failure.retryAfterMs,
        input.retryIdentity
          ? stableRetryRandom(input.retryIdentity, attempt)
          : random()
      );
      throwIfAborted(input.signal);
      assertBeforeDeadline(input.deadlineMs, now(), delayMs);
      if (input.onRetry) {
        input.onRetry({
          runtimeId: input.runtimeId ?? "",
          providerId: input.providerId ?? "",
          modelId: input.modelId ?? "",
          retry: attempt,
          maxRetries: 5,
          delayMs,
          reason: sanitizedRetryReason(failure),
        });
      }
      await sleep(delayMs, input.signal);
      throwIfAborted(input.signal);
      assertBeforeDeadline(input.deadlineMs, now(), 0);
    }

    throwIfAborted(input.signal);
    try {
      return await input.complete();
    } catch (error) {
      lastError = error;
      if (!isTypedProviderFailure(error) || !isRetryable(input.classify(error))) {
        throw error;
      }
    }
  }
  throw lastError;
}

function isTypedProviderFailure(error: unknown): boolean {
  return error instanceof ProviderTransportError ||
    (
      typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "ProviderTransportError"
    );
}

function stableRetryRandom(identity: string, retry: number): number {
  let hash = 2_166_136_261;
  const value = `${identity}:retry:${retry}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function retryDelayMs(
  baseMs: number,
  retryAfterMs: number | undefined,
  random: number
): number {
  const jitteredBase = Math.round(
    baseMs * (1 + (random * 2 - 1) * RUNNER_PROVIDER_RETRY_JITTER_RATIO)
  );
  return Math.max(jitteredBase, retryAfterMs ?? 0);
}

function isRetryable(failure: ProviderFailure): boolean {
  return failure.kind === "rate_limit" ||
    failure.kind === "provider_unavailable" ||
    failure.kind === "transient";
}

function sanitizedRetryReason(failure: ProviderFailure): string {
  switch (failure.kind) {
    case "rate_limit":
      return "Provider rate limit";
    case "provider_unavailable":
      return "Provider temporarily unavailable";
    default:
      return "Temporary provider failure";
  }
}

function assertBeforeDeadline(
  deadlineMs: number | undefined,
  nowMs: number,
  delayMs: number
): void {
  if (
    deadlineMs !== undefined &&
    (!Number.isFinite(deadlineMs) || nowMs + delayMs > deadlineMs)
  ) {
    throw new ProviderRetryDeadlineError(deadlineMs);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
