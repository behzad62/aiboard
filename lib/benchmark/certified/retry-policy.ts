export const CERTIFIED_RETRY_DELAYS_MS =
  [2_000, 5_000, 15_000, 30_000, 60_000] as const;
export const CERTIFIED_RETRY_JITTER_RATIO = 0.2;

export interface CertifiedRetryProgress {
  providerId: string;
  modelId: string;
  participantId: string;
  resultSetId?: string;
  retry: number;
  maxRetries: 5;
  delayMs: number;
  reason: string;
}

export interface CertifiedRetryRuntime {
  now(): number;
  random(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const DEFAULT_CERTIFIED_RETRY_RUNTIME: CertifiedRetryRuntime = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export function certifiedRetryDelayMs(
  baseMs: number,
  retryAfterMs: number | undefined,
  random: number
): number {
  const jitteredBase = Math.round(
    baseMs * (1 + (random * 2 - 1) * CERTIFIED_RETRY_JITTER_RATIO)
  );
  return Math.max(jitteredBase, retryAfterMs ?? 0);
}
