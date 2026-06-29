"use client";

import { useCallback } from "react";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import {
  downloadBenchmarkJson,
  downloadBenchmarkMarkdown,
  formatBenchmarkMarkdownReport,
} from "@/lib/benchmark/reports";
import {
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundleV2,
} from "@/lib/benchmark/store";
import type { BenchmarkReportBundleV2 } from "@/lib/benchmark/types";

type ImportCandidate = Omit<Partial<BenchmarkReportBundleV2>, "version"> & {
  version?: unknown;
};

function readBundle(value: unknown): BenchmarkReportBundleV2 {
  if (!value || typeof value !== "object") {
    throw new Error("Benchmark import must be a JSON object.");
  }
  const bundle = value as ImportCandidate;
  if (
    bundle.version === 2 &&
    isBaseBundleShape(bundle) &&
    Array.isArray(bundle.caseV2) &&
    Array.isArray(bundle.attemptsV2) &&
    Array.isArray(bundle.verifierResults) &&
    Array.isArray(bundle.runEvents) &&
    Array.isArray(bundle.toolCallTraces) &&
    Array.isArray(bundle.teamCompositions) &&
    Array.isArray(bundle.harnessCertifications)
  ) {
    return bundle as BenchmarkReportBundleV2;
  }
  throw new Error("Only AI Board Benchmark Bundle v2 imports are supported.");
}

function isBaseBundleShape(bundle: ImportCandidate): boolean {
  return (
    bundle.version === 2 &&
    Array.isArray(bundle.suites) &&
    Array.isArray(bundle.runs) &&
    Array.isArray(bundle.cases) &&
    Array.isArray(bundle.attempts) &&
    Array.isArray(bundle.metricValues) &&
    Array.isArray(bundle.artifacts) &&
    Array.isArray(bundle.failures) &&
    Array.isArray(bundle.traces)
  );
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
    const bundle = exportBenchmarkReportBundleV2();
    downloadBenchmarkJson(bundle);
    setMessage(
      `Benchmark Bundle v2 exported. Redaction scanned ${
        bundle.redactionSummary?.scannedArtifacts ?? 0
      } artifact(s).`
    );
  }, [dashboard, setMessage]);

  const exportMarkdown = useCallback(async () => {
    if (!dashboard) return;
    const bundle = exportBenchmarkReportBundleV2();
    const markdown = formatBenchmarkMarkdownReport(bundle, dashboard);
    downloadBenchmarkMarkdown(markdown);
    await navigator.clipboard.writeText(markdown);
    setMessage("Benchmark report downloaded and copied to clipboard.");
  }, [dashboard, setMessage]);

  const importJson = useCallback(
    async (file: File) => {
      const text = await file.text();
      const bundle = readBundle(JSON.parse(text));
      await importBenchmarkReportBundleV2(bundle);
      await reload();
      const certified = bundle.attemptsV2.filter(
        (attempt) => attempt.mode === "certified"
      ).length;
      setMessage(
        `Imported ${bundle.runs.length} run(s), ${bundle.cases.length} case(s), ${certified} certified attempt(s).`
      );
    },
    [reload, setMessage]
  );

  return { exportJson, exportMarkdown, importJson };
}
