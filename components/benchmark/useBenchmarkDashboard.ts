"use client";

import { useCallback, useEffect, useState } from "react";
import { ensureReady } from "@/lib/client/api";
import {
  getBenchmarkCases,
  getBenchmarkAttempts,
  getBenchmarkArtifacts,
  getBenchmarkFailures,
  getBenchmarkMetricValues,
  getBenchmarkRuns,
  getBenchmarkSuites,
  getBenchmarkTraces,
  getCorruptBenchmarkRunCount,
  rescanBenchmarkRunFiles,
} from "@/lib/client/store";
import {
  buildBenchmarkDashboardData,
  buildCertifiedBenchmarkDashboardData,
  type BenchmarkDashboardData,
} from "@/lib/benchmark/metrics";
import type {
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkTeamComposition,
} from "@/lib/benchmark/types";
import {
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
  listBenchmarkRunEvents,
  listBenchmarkTeamCompositions,
  listBenchmarkToolCallTraces,
  listBenchmarkVerifierResults,
  listHarnessCertificationResults,
} from "@/lib/benchmark/store";
import { reconcileStaleCertifiedRuns } from "@/lib/benchmark/certified/run-persistence";

export interface BenchmarkDashboardState {
  dashboard: BenchmarkDashboardData | null;
  certifiedDashboard: unknown | null;
  locked: boolean;
  loading: boolean;
  message: string | null;
  suiteCount: number;
  traceCount: number;
  reportCounts: BenchmarkReportCounts;
  benchmarkFailures: BenchmarkFailure[];
  /** Run files that could not be read this session (surface as a warning line). */
  corruptRunFileCount: number;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setMessage: (message: string | null) => void;
}

export interface BenchmarkReportCounts {
  suites: number;
  runs: number;
  cases: number;
  attempts: number;
  metricValues: number;
  artifacts: number;
  failures: number;
  traces: number;
  certifiedCases: number;
  certifiedAttempts: number;
  verifierResults: number;
  runEvents: number;
  toolCallTraces: number;
  teamCompositions: number;
  harnessCertifications: number;
}

const EMPTY_REPORT_COUNTS: BenchmarkReportCounts = {
  suites: 0,
  runs: 0,
  cases: 0,
  attempts: 0,
  metricValues: 0,
  artifacts: 0,
  failures: 0,
  traces: 0,
  certifiedCases: 0,
  certifiedAttempts: 0,
  verifierResults: 0,
  runEvents: 0,
  toolCallTraces: 0,
  teamCompositions: 0,
  harnessCertifications: 0,
};

export function useBenchmarkDashboard(): BenchmarkDashboardState {
  const [dashboard, setDashboard] = useState<BenchmarkDashboardData | null>(null);
  const [certifiedDashboard, setCertifiedDashboard] = useState<unknown | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [suiteCount, setSuiteCount] = useState(0);
  const [traceCount, setTraceCount] = useState(0);
  const [reportCounts, setReportCounts] =
    useState<BenchmarkReportCounts>(EMPTY_REPORT_COUNTS);
  const [benchmarkFailures, setBenchmarkFailures] = useState<BenchmarkFailure[]>([]);
  const [corruptRunFileCount, setCorruptRunFileCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const ready = await ensureReady();
    if (ready.needsPassphrase) {
      setLocked(true);
      setDashboard(null);
      setCertifiedDashboard(null);
      setSuiteCount(0);
      setTraceCount(0);
      setReportCounts(EMPTY_REPORT_COUNTS);
      setBenchmarkFailures([]);
      setCorruptRunFileCount(0);
      setLoading(false);
      return;
    }

    setLocked(false);
    await reconcileStaleCertifiedRuns();
    const benchmarkRuns = [...getBenchmarkRuns()];
    const benchmarkCases = [...getBenchmarkCases()];
    const benchmarkMetricValues = [...getBenchmarkMetricValues()];
    const benchmarkFailures = [...getBenchmarkFailures()];
    const benchmarkSuites = [...getBenchmarkSuites()];
    const benchmarkTraces = [...getBenchmarkTraces()];
    const benchmarkAttempts = [...getBenchmarkAttempts()];
    const benchmarkArtifacts = [...getBenchmarkArtifacts()];
    const [
      benchmarkCaseV2,
      benchmarkAttemptsV2,
      verifierResults,
      runEvents,
      toolCallTraces,
      teamCompositions,
      harnessCertifications,
    ] = await Promise.all([
      listBenchmarkCaseV2(),
      listBenchmarkAttemptsV2(),
      listBenchmarkVerifierResults(),
      listBenchmarkRunEvents(),
      listBenchmarkToolCallTraces(),
      listBenchmarkTeamCompositions(),
      listHarnessCertificationResults(),
    ]);
    setDashboard(
      buildBenchmarkDashboardData({
        benchmarkRuns,
        benchmarkCases,
        benchmarkMetricValues,
        benchmarkFailures,
      })
    );
    const certifiedDashboardData = buildCertifiedBenchmarkDashboardData({
      caseV2: benchmarkCaseV2,
      attemptsV2: benchmarkAttemptsV2,
      verifierResults,
      teamCompositions,
      harnessCertifications,
    });
    setCertifiedDashboard(
      withCertifiedDeleteMetadata(
        certifiedDashboardData,
        benchmarkAttemptsV2,
        teamCompositions
      )
    );
    setSuiteCount(benchmarkSuites.length);
    setTraceCount(benchmarkTraces.length);
    setReportCounts({
      suites: benchmarkSuites.length,
      runs: benchmarkRuns.length,
      cases: benchmarkCases.length,
      attempts: benchmarkAttempts.length,
      metricValues: benchmarkMetricValues.length,
      artifacts: benchmarkArtifacts.length,
      failures: benchmarkFailures.length,
      traces: benchmarkTraces.length,
      certifiedCases: benchmarkCaseV2.length,
      certifiedAttempts: benchmarkAttemptsV2.filter(
        (attempt) => attempt.mode === "certified"
      ).length,
      verifierResults: verifierResults.length,
      runEvents: runEvents.length,
      toolCallTraces: toolCallTraces.length,
      teamCompositions: teamCompositions.length,
      harnessCertifications: harnessCertifications.length,
    });
    setBenchmarkFailures(benchmarkFailures);
    setCorruptRunFileCount(getCorruptBenchmarkRunCount());
    setLoading(false);
  }, []);

  // Refresh re-lists run files first so runs that appeared after boot (another
  // tab, a cloud-synced folder, an external writer) are merged before the
  // in-memory re-read. The adapter list call is cheap, so refresh stays fast.
  const refresh = useCallback(async () => {
    const ready = await ensureReady();
    if (!ready.needsPassphrase) {
      await rescanBenchmarkRunFiles();
    }
    await load();
  }, [load]);

  useEffect(() => {
    void load().catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
      setLoading(false);
    });
  }, [load]);

  return {
    dashboard,
    certifiedDashboard,
    locked,
    loading,
    message,
    suiteCount,
    traceCount,
    reportCounts,
    benchmarkFailures,
    corruptRunFileCount,
    load,
    refresh,
    setMessage,
  };
}

type CertifiedDashboardWithLeaderboard = ReturnType<
  typeof buildCertifiedBenchmarkDashboardData
>;

function withCertifiedDeleteMetadata(
  dashboard: CertifiedDashboardWithLeaderboard,
  attempts: BenchmarkAttemptV2[],
  teams: BenchmarkTeamComposition[]
): CertifiedDashboardWithLeaderboard & {
  providerErrorAttempts: Array<{
    id: string;
    track: string;
    teamCompositionId: string;
  }>;
} {
  const certifiedAttempts = attempts.filter(
    (attempt) => attempt.mode === "certified"
  );
  const attemptsByTeam = new Map<string, BenchmarkAttemptV2[]>();
  const teamById = new Map(teams.map((team) => [team.id, team]));
  for (const attempt of certifiedAttempts) {
    const list = attemptsByTeam.get(attempt.teamCompositionId) ?? [];
    list.push(attempt);
    attemptsByTeam.set(attempt.teamCompositionId, list);
  }

  return {
    ...dashboard,
    leaderboard: dashboard.leaderboard.map((row) => {
      const teamAttempts = attemptsByTeam.get(row.teamCompositionId) ?? [];
      const latest = newestAttempt(teamAttempts);
      const team = teamById.get(row.teamCompositionId);
      return {
        ...row,
        latestAttemptId: latest?.id,
        latestAttemptStatus: latest?.status,
        latestAttemptTrack: latest?.track,
        latestAttemptsByTrack: latestAttemptsByTrack(teamAttempts),
        providerUnavailableAttemptIds: teamAttempts
          .filter((attempt) => attempt.status === "provider_unavailable")
          .map((attempt) => attempt.id),
        providerUnavailableAttemptIdsByTrack:
          providerUnavailableAttemptIdsByTrack(teamAttempts),
        providerIds: uniqueStrings(
          (team?.roles ?? []).map((role) => role.providerId)
        ),
        reasoningEfforts: uniqueStrings(
          (team?.roles ?? []).map((role) => role.reasoningEffort)
        ),
        latestCompletedAt: latest?.completedAt ?? latest?.startedAt,
      };
    }),
    providerErrorAttempts: certifiedAttempts
      .filter((attempt) => attempt.status === "provider_unavailable")
      .map((attempt) => ({
        id: attempt.id,
        track: attempt.track,
        teamCompositionId: attempt.teamCompositionId,
      })),
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  ).sort();
}

function latestAttemptsByTrack(
  attempts: BenchmarkAttemptV2[]
): Record<string, { id: string; status: string; track: string }> {
  const byTrack: Record<string, { id: string; status: string; track: string }> = {};
  const grouped = new Map<string, BenchmarkAttemptV2[]>();
  for (const attempt of attempts) {
    const list = grouped.get(attempt.track) ?? [];
    list.push(attempt);
    grouped.set(attempt.track, list);
  }
  for (const [track, rows] of grouped) {
    const latest = newestAttempt(rows);
    if (latest) {
      byTrack[track] = {
        id: latest.id,
        status: latest.status,
        track: latest.track,
      };
    }
  }
  return byTrack;
}

function providerUnavailableAttemptIdsByTrack(
  attempts: BenchmarkAttemptV2[]
): Record<string, string[]> {
  const byTrack: Record<string, string[]> = {};
  for (const attempt of attempts) {
    if (attempt.status !== "provider_unavailable") continue;
    byTrack[attempt.track] ??= [];
    byTrack[attempt.track].push(attempt.id);
  }
  return byTrack;
}

function newestAttempt(attempts: BenchmarkAttemptV2[]): BenchmarkAttemptV2 | null {
  return attempts.reduce<BenchmarkAttemptV2 | null>((best, attempt) => {
    if (!best) return attempt;
    return attemptTimestamp(attempt) >= attemptTimestamp(best) ? attempt : best;
  }, null);
}

function attemptTimestamp(attempt: BenchmarkAttemptV2): number {
  const parsed = Date.parse(attempt.completedAt ?? attempt.startedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}
