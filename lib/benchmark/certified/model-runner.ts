import type {
  BenchmarkAttemptV2,
  BenchmarkFailure,
  CertifiedAttemptStatus,
} from "@/lib/benchmark/types";
import type { CertifiedRunContext } from "./run-context";
import { explainCertifiedFailureStatus } from "./classify-failure";
import { benchmarkDomainForTrack } from "./run-status";

export interface CertifiedRunnerOptions {
  signal?: AbortSignal;
}

export type CertifiedTrackRunner = (
  context: CertifiedRunContext,
  options?: CertifiedRunnerOptions
) => Promise<void | BenchmarkAttemptV2[]>;

export async function persistReturnedAttempts(
  context: CertifiedRunContext,
  attempts: void | BenchmarkAttemptV2[]
): Promise<void> {
  if (!attempts) return;
  for (const attempt of attempts) {
    const normalized = await persistFailureForAttempt(context, attempt);
    await context.recordAttempt(normalized);
  }
}

async function persistFailureForAttempt(
  context: CertifiedRunContext,
  attempt: BenchmarkAttemptV2
): Promise<BenchmarkAttemptV2> {
  if (attempt.status === "passed") return attempt;

  const existingCanonicalId = attempt.failureIds.find((id) =>
    id.startsWith(`${attempt.id}:failure:`)
  );
  const failureId =
    existingCanonicalId ?? `${attempt.id}:failure:${failureCodeForStatus(attempt.status)}`;
  const normalizedAttempt = attempt.failureIds.includes(failureId)
    ? attempt
    : { ...attempt, failureIds: [...attempt.failureIds, failureId] };

  if (!recordedFailureIds(context).has(failureId)) {
    await context.recordFailure(createAttemptFailure(normalizedAttempt, failureId));
  }

  return normalizedAttempt;
}

function recordedFailureIds(context: CertifiedRunContext): Set<string> {
  if (hasPersistenceSnapshot(context)) {
    return new Set(context.snapshot().failures.map((failure) => failure.id));
  }
  return new Set();
}

function hasPersistenceSnapshot(
  context: CertifiedRunContext
): context is CertifiedRunContext & { snapshot(): { failures: BenchmarkFailure[] } } {
  return (
    "snapshot" in context &&
    typeof (context as { snapshot?: unknown }).snapshot === "function"
  );
}

function createAttemptFailure(
  attempt: BenchmarkAttemptV2,
  failureId: string
): BenchmarkFailure {
  const code = failureCodeFromId(failureId) ?? failureCodeForStatus(attempt.status);
  return {
    id: failureId,
    runId: attempt.runId,
    caseId: attempt.caseId,
    attemptId: attempt.id,
    domain: benchmarkDomainForTrack(attempt.track),
    source: failureSourceForStatus(attempt.status),
    code,
    severity: "error",
    message: explainCertifiedFailureStatus(attempt.status),
    details: JSON.stringify({
      status: attempt.status,
      originalFailureIds: attempt.failureIds,
      verifierResultId: attempt.verifierResultId,
    }),
    createdAt: attempt.completedAt ?? new Date().toISOString(),
  };
}

function failureCodeFromId(failureId: string): string | null {
  const marker = ":failure:";
  const markerIndex = failureId.indexOf(marker);
  return markerIndex >= 0 ? failureId.slice(markerIndex + marker.length) : null;
}

function failureCodeForStatus(status: CertifiedAttemptStatus): string {
  switch (status) {
    case "failed_model":
      return "model_failed";
    case "failed_verifier":
      return "verification_failed";
    case "failed_tool_use":
      return "invalid_tool_call";
    case "failed_budget":
      return "budget_exhausted";
    case "provider_unavailable":
      return "provider_unavailable";
    case "invalid_harness":
      return "invalid_harness";
    case "invalid_environment":
      return "invalid_environment";
    case "invalid_case":
      return "invalid_case";
    case "aborted_user":
      return "aborted_user";
    case "passed":
      return "passed";
  }
}

function failureSourceForStatus(
  status: CertifiedAttemptStatus
): BenchmarkFailure["source"] {
  if (status === "provider_unavailable") return "provider";
  if (status === "failed_tool_use" || status === "failed_verifier") return "rules";
  return "benchmark";
}
