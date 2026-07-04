import type {
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkTrack,
  HarnessCertificationResult,
  HarnessProfile,
} from "@/lib/benchmark/types";
import { getHarnessProfileDefinition } from "./harness-profiles";
import {
  assertCertifiedHarnessCanRun,
  loadAndValidateCertifiedRunSelection,
} from "./run-guards";
import {
  createBenchmarkRunRecord,
  completeBenchmarkRunRecord,
  createCertifiedRunSummary,
  benchmarkDomainForTrack,
  type CertifiedRunSummary,
} from "./run-status";
import {
  createCertifiedRunContext,
  persistCertifiedRunRecord,
  rebuildCertifiedDashboardData,
} from "./run-persistence";
import { classifyProviderFailure, isProviderFailureMessage } from "./classify-provider-failure";
import { persistReturnedAttempts, type CertifiedTrackRunner } from "./model-runner";
import type { CertifiedRunBudget } from "./run-context";
import { throwIfCertifiedRunAborted } from "./model-call";

export interface RunCertifiedBenchmarkInput {
  runId?: string;
  name?: string;
  suiteId: string;
  track: BenchmarkTrack;
  harnessProfile: HarnessProfile;
  caseIds: string[];
  teamCompositionIds: string[];
  modelBudget?: CertifiedRunBudget;
  certification: HarnessCertificationResult;
  runner: CertifiedTrackRunner;
  signal?: AbortSignal;
}

export async function runCertifiedBenchmark(
  input: RunCertifiedBenchmarkInput
): Promise<CertifiedRunSummary> {
  assertCertifiedHarnessCanRun(input.certification);
  const profile = getHarnessProfileDefinition(input.harnessProfile);
  if (!profile) throw new Error(`Unknown harness profile: ${input.harnessProfile}`);

  const selection = await loadAndValidateCertifiedRunSelection(input);
  const runId = input.runId ?? createRunId(input.track);
  const startedAt = new Date().toISOString();
  const context = createCertifiedRunContext({
    runId,
    suiteId: input.suiteId,
    track: input.track,
    harnessProfile: input.harnessProfile,
    startedAt,
    caseIds: input.caseIds,
    teamCompositionIds: input.teamCompositionIds,
    modelBudget: input.modelBudget,
  });
  const run = createBenchmarkRunRecord({
    context,
    name: input.name,
    modelIds: modelIdsForTeams(selection.teamCompositions),
  });
  await persistCertifiedRunRecord(run);

  let status: CertifiedRunSummary["status"] = "completed";
  let errorMessage: string | undefined;
  try {
    throwIfCertifiedRunAborted(input.signal);
    await persistReturnedAttempts(
      context,
      await input.runner(context, { signal: input.signal })
    );
    throwIfCertifiedRunAborted(input.signal);
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
    await context.recordFailure(createRunEngineFailure({
      runId,
      track: input.track,
      message: errorMessage,
    }));
    await persistReturnedAttempts(
      context,
      createFailedAttemptsForRunError({
        context,
        track: input.track,
        message: errorMessage,
      })
    );
  }

  const completedAt = new Date().toISOString();
  const snapshot = context.snapshot();
  const dashboard = await rebuildCertifiedDashboardData();
  const summary = createCertifiedRunSummary({
    context,
    completedAt,
    status,
    snapshot,
    dashboard,
    error: errorMessage,
  });
  await persistCertifiedRunRecord(
    completeBenchmarkRunRecord({
      run,
      completedAt,
      status,
      summary,
      snapshot,
    })
  );

  return summary;
}

function createFailedAttemptsForRunError(input: {
  context: ReturnType<typeof createCertifiedRunContext>;
  track: BenchmarkTrack;
  message: string;
}): BenchmarkAttemptV2[] {
  const snapshot = input.context.snapshot();
  const existingKeys = new Set(
    snapshot.attempts.map((attempt) =>
      attemptKey(attempt.caseId, attempt.teamCompositionId)
    )
  );
  const status = statusForRunError(input.message);
  const completedAt = new Date().toISOString();
  const durationMs = Math.max(
    0,
    Date.now() - new Date(input.context.startedAt).getTime()
  );
  const profile = getHarnessProfileDefinition(input.context.harnessProfile);
  const attempts: BenchmarkAttemptV2[] = [];
  // A trace can only be summed into one synthesized attempt. Without this, a
  // single persisted trace's cost/tokens/modelCalls are multiplied across teams.
  const usedTraceIds = new Set<string>();
  const ownerTeamId = input.context.teamCompositionIds[0];

  for (const caseId of input.context.caseIds) {
    for (const teamCompositionId of input.context.teamCompositionIds) {
      if (existingKeys.has(attemptKey(caseId, teamCompositionId))) continue;
      const isOwnerTeam = teamCompositionId === ownerTeamId;
      const traces = isOwnerTeam
        ? snapshot.traces.filter(
            (trace) =>
              trace.runId === input.context.runId &&
              (!trace.caseId || trace.caseId === caseId) &&
              !usedTraceIds.has(trace.id)
          )
        : [];
      for (const trace of traces) usedTraceIds.add(trace.id);
      attempts.push({
        id: `${input.context.runId}:${caseId}:${teamCompositionId}:failed`,
        runId: input.context.runId,
        caseId,
        teamCompositionId,
        mode: "certified",
        track: input.track,
        harnessProfile: input.context.harnessProfile,
        status,
        startedAt: input.context.startedAt,
        completedAt,
        verifiedQuality: 0,
        jobSuccessScore: 0,
        efficiencyScore: 0,
        ...(input.track === "gameiq" ? { gameIqScore: 0 } : {}),
        ...(input.track === "toolreliability" || input.track === "teamiq"
          ? { toolReliabilityScore: 0 }
          : {}),
        costUsd: sumNullable(traces.map((trace) => trace.estimatedUsd ?? null)),
        inputTokens: traces.reduce(
          (sum, trace) => sum + (trace.inputTokens ?? 0),
          0
        ),
        outputTokens: traces.reduce(
          (sum, trace) => sum + (trace.outputTokens ?? 0),
          0
        ),
        modelCalls: traces.length,
        toolCalls: snapshot.toolCalls.filter(
          (trace) => trace.caseId === caseId
        ).length,
        durationMs,
        artifactIds: [],
        traceIds: traces.map((trace) => trace.id),
        failureIds: [],
        harnessVersion:
          profile?.harnessVersion ?? `${input.context.harnessProfile}-v0.1`,
        promptSetVersion:
          profile?.promptSetVersion ?? "certified-run-error-v0.1",
        scoringVersion: "certified-run-error-v0.1",
      });
    }
  }

  return attempts;
}

function attemptKey(caseId: string, teamCompositionId: string): string {
  return `${caseId}\u0000${teamCompositionId}`;
}

export function statusForRunError(message: string): BenchmarkAttemptV2["status"] {
  const normalized = message.toLowerCase();
  if (/abort|cancel/.test(normalized)) {
    return "aborted_user";
  }
  if (isProviderFailureMessage(normalized)) {
    return "provider_unavailable";
  }
  if (/budget|token limit|cost limit|wall.?clock/.test(normalized)) {
    return "failed_budget";
  }
  // A fatal/transient provider or account error whose message lacks
  // isProviderFailureMessage's keywords (e.g. "insufficient funds", "billing",
  // a bare "credits depleted" without a 429) is still the provider's fault, not
  // a broken harness. Consult the B1 classifier (which owns the billing/credits/
  // quota/key patterns) before falling to invalid_harness, so this synthesized
  // status matches how B1/B2 classify the same error. Placed AFTER the budget
  // branch so budget errors (which classify as "other") stay failed_budget.
  if (classifyProviderFailure(message) !== "other") {
    return "provider_unavailable";
  }
  return "invalid_harness";
}

function sumNullable(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) return null;
  let total = 0;
  for (const value of values) total += value ?? 0;
  return total;
}

function createRunId(track: BenchmarkTrack): string {
  return `certified-${track}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function modelIdsForTeams(
  teams: Array<{ roles: Array<{ modelId: string }> }>
): string[] {
  return Array.from(
    new Set(
      teams.flatMap((team) =>
        team.roles.map((role) => role.modelId).filter(Boolean)
      )
    )
  ).sort();
}

function createRunEngineFailure(input: {
  runId: string;
  track: BenchmarkTrack;
  message: string;
}): BenchmarkFailure {
  return {
    id: `${input.runId}:failure:run_engine_failed`,
    runId: input.runId,
    domain: benchmarkDomainForTrack(input.track),
    source: "benchmark",
    code: "run_engine_failed",
    severity: "error",
    message: input.message,
    createdAt: new Date().toISOString(),
  };
}
