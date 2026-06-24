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
  getBuildCheckpoints,
  getGenericGameMatchRecords,
  getModelStats,
} from "@/lib/client/store";
import {
  buildBenchmarkDashboardData,
  type BenchmarkDashboardData,
} from "@/lib/benchmark/metrics";

export interface BenchmarkDashboardState {
  dashboard: BenchmarkDashboardData | null;
  locked: boolean;
  loading: boolean;
  message: string | null;
  suiteCount: number;
  traceCount: number;
  reportCounts: BenchmarkReportCounts;
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
  gameMatches: number;
  buildCheckpoints: number;
  buildStats: number;
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
  gameMatches: 0,
  buildCheckpoints: 0,
  buildStats: 0,
};

export function useBenchmarkDashboard(): BenchmarkDashboardState {
  const [dashboard, setDashboard] = useState<BenchmarkDashboardData | null>(null);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [suiteCount, setSuiteCount] = useState(0);
  const [traceCount, setTraceCount] = useState(0);
  const [reportCounts, setReportCounts] =
    useState<BenchmarkReportCounts>(EMPTY_REPORT_COUNTS);

  const load = useCallback(async () => {
    setLoading(true);
    const ready = await ensureReady();
    if (ready.needsPassphrase) {
      setLocked(true);
      setDashboard(null);
      setSuiteCount(0);
      setTraceCount(0);
      setReportCounts(EMPTY_REPORT_COUNTS);
      setLoading(false);
      return;
    }

    setLocked(false);
    const gameMatches = [...getGenericGameMatchRecords()];
    const buildStats = getModelStats();
    const buildCheckpoints = [...getBuildCheckpoints()];
    const benchmarkRuns = [...getBenchmarkRuns()];
    const benchmarkCases = [...getBenchmarkCases()];
    const benchmarkMetricValues = [...getBenchmarkMetricValues()];
    const benchmarkFailures = [...getBenchmarkFailures()];
    const benchmarkSuites = [...getBenchmarkSuites()];
    const benchmarkTraces = [...getBenchmarkTraces()];
    const benchmarkAttempts = [...getBenchmarkAttempts()];
    const benchmarkArtifacts = [...getBenchmarkArtifacts()];
    setDashboard(
      buildBenchmarkDashboardData({
        gameMatches,
        buildStats,
        buildCheckpoints,
        benchmarkRuns,
        benchmarkCases,
        benchmarkMetricValues,
        benchmarkFailures,
      })
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
      gameMatches: gameMatches.length,
      buildCheckpoints: buildCheckpoints.length,
      buildStats: buildStats.length,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load().catch((error) => {
      setMessage(error instanceof Error ? error.message : String(error));
      setLoading(false);
    });
  }, [load]);

  return {
    dashboard,
    locked,
    loading,
    message,
    suiteCount,
    traceCount,
    reportCounts,
    load,
    refresh: load,
    setMessage,
  };
}
