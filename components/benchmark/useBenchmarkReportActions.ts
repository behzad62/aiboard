"use client";

import { useCallback } from "react";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import {
  downloadBenchmarkJson,
  downloadBenchmarkMarkdown,
  formatBenchmarkMarkdownReport,
} from "@/lib/benchmark/reports";
import {
  exportBenchmarkReportBundle,
  importBenchmarkReportBundle,
} from "@/lib/benchmark/store";
import type { BenchmarkReportBundle } from "@/lib/benchmark/types";

function readBundle(value: unknown): BenchmarkReportBundle {
  if (!value || typeof value !== "object") {
    throw new Error("Benchmark import must be a JSON object.");
  }
  const bundle = value as Partial<BenchmarkReportBundle>;
  if (
    bundle.version !== 1 ||
    !Array.isArray(bundle.suites) ||
    !Array.isArray(bundle.runs) ||
    !Array.isArray(bundle.cases) ||
    !Array.isArray(bundle.attempts) ||
    !Array.isArray(bundle.metricValues) ||
    !Array.isArray(bundle.artifacts) ||
    !Array.isArray(bundle.failures) ||
    !Array.isArray(bundle.traces)
  ) {
    throw new Error("File is not an AI Board benchmark report bundle.");
  }
  return bundle as BenchmarkReportBundle;
}

export function useBenchmarkReportActions({
  dashboard,
  reload,
  setMessage,
}: {
  dashboard: BenchmarkDashboardData | null;
  reload: () => Promise<void>;
  setMessage: (message: string | null) => void;
}) {
  const exportJson = useCallback(() => {
    if (!dashboard) return;
    const bundle = exportBenchmarkReportBundle();
    downloadBenchmarkJson(bundle);
    setMessage("Benchmark JSON exported.");
  }, [dashboard, setMessage]);

  const exportMarkdown = useCallback(async () => {
    if (!dashboard) return;
    const bundle = exportBenchmarkReportBundle();
    const markdown = formatBenchmarkMarkdownReport(bundle, dashboard);
    downloadBenchmarkMarkdown(markdown);
    await navigator.clipboard.writeText(markdown);
    setMessage("Benchmark report downloaded and copied to clipboard.");
  }, [dashboard, setMessage]);

  const importJson = useCallback(
    async (file: File) => {
      const text = await file.text();
      const bundle = readBundle(JSON.parse(text));
      await importBenchmarkReportBundle(bundle);
      await reload();
      setMessage(`Imported ${bundle.runs.length} run(s) and ${bundle.cases.length} case(s).`);
    },
    [reload, setMessage]
  );

  return { exportJson, exportMarkdown, importJson };
}
