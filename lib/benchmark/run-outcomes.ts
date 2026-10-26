import { benchmarkConfigurationDisplay, sanitizeBenchmarkDisplayText } from "./configuration-display";
import type { CertifiedBenchmarkDashboardInput } from "./scoring/types";
import type { CertifiedAttemptStatus } from "./types";

export interface BenchmarkCaseOutcome {
  key: string;
  title: string;
  status: CertifiedAttemptStatus | "not_recorded" | "conflicting_records";
  reason: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
}

export interface BenchmarkRunOutcome {
  id: string;
  subject: string;
  configuration: string;
  tracks: string[];
  startedAt: string;
  terminalAt?: string;
  status: string;
  ranked: boolean;
  failure: string;
  expected: number;
  recorded: number;
  passed: number;
  failed: number;
  excluded: number;
  cases: BenchmarkCaseOutcome[];
}

const scoredFailures = new Set<CertifiedAttemptStatus>(["failed_model", "failed_verifier", "failed_tool_use", "failed_budget"]);

/** Raw diagnostic outcomes remain visible even when publication rejects the batch. */
export function buildBenchmarkRunOutcomes(
  input: Pick<CertifiedBenchmarkDashboardInput, "resultSets" | "caseV2" | "attemptsV2" | "verifierResults">,
  publishedIds: ReadonlySet<string>,
): BenchmarkRunOutcome[] {
  const casesById = new Map(input.caseV2.map(item => [item.id, item]));
  const verifiersById = new Map(input.verifierResults.map(item => [item.id, item]));
  return input.resultSets.filter(result => result.status !== "deleting").map(result => {
    const display = benchmarkConfigurationDisplay(result);
    const cases = result.expectedAttempts.map((expected): BenchmarkCaseOutcome => {
      const matches = input.attemptsV2.filter(attempt => attempt.mode === "certified" && attempt.resultSetId === result.id &&
        attempt.runId === expected.runId && attempt.caseId === expected.caseId &&
        attempt.track === expected.track && attempt.teamCompositionId === expected.teamCompositionId &&
        attempt.scoringVersion === expected.scoringVersion);
      const attempt = matches.length === 1 ? matches[0] : undefined;
      const verifier = attempt?.verifierResultId ? verifiersById.get(attempt.verifierResultId) : undefined;
      const ownedVerifier = verifier?.attemptId === attempt?.id && verifier?.resultSetId === result.id && verifier?.caseId === expected.caseId ? verifier : undefined;
      return {
        key: `${expected.runId}:${expected.caseId}:${expected.teamCompositionId}`,
        title: sanitizeBenchmarkDisplayText(casesById.get(expected.caseId)?.title ?? expected.caseId),
        status: matches.length > 1 ? "conflicting_records" : attempt?.status ?? "not_recorded",
        reason: sanitizeBenchmarkDisplayText(matches.length > 1 ? "Multiple records match this expected case; inspect Data before scoring."
          : ownedVerifier?.assertionResults.find(assertion => !assertion.passed)?.message ?? ownedVerifier?.stderrPreview ?? ""),
        inputTokens: attempt?.inputTokens ?? null,
        outputTokens: attempt?.outputTokens ?? null,
        costUsd: attempt?.costUsd ?? null,
        durationMs: attempt?.durationMs ?? null,
      };
    });
    const recorded = cases.filter(item => item.status !== "not_recorded");
    return {
      id: result.id, subject: display.subject, configuration: display.identity,
      tracks: result.configuration.tracks.map(track => ({toolreliability:"ToolBench", harnessbench:"HarnessBench", workbench:"WorkBench smoke", teamiq:"TeamIQ experimental", gameiq:"GameIQ historical"})[track.track]),
      startedAt: result.createdAt, terminalAt: result.completedAt ?? result.terminalAt,
      status: result.status, ranked: publishedIds.has(result.id),
      failure: sanitizeBenchmarkDisplayText(result.failure?.message ?? ""),
      expected: cases.length, recorded: recorded.length,
      passed: recorded.filter(item => item.status === "passed").length,
      failed: recorded.filter(item => scoredFailures.has(item.status as CertifiedAttemptStatus)).length,
      excluded: recorded.filter(item => item.status !== "passed" && !scoredFailures.has(item.status as CertifiedAttemptStatus)).length,
      cases,
    };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
