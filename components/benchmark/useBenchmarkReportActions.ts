"use client";

import { useCallback } from "react";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import {
  downloadBenchmarkJson,
  downloadBenchmarkMarkdown,
  formatBenchmarkMarkdownReport,
  type BenchmarkReportBundleAny,
} from "@/lib/benchmark/reports";
import {
  exportBenchmarkReportBundle,
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundle,
  importBenchmarkReportBundleV2,
} from "@/lib/benchmark/store";
import type {
  BenchmarkReportBundle,
  BenchmarkReportBundleV2,
} from "@/lib/benchmark/types";

type ImportCandidate = Omit<Partial<BenchmarkReportBundle>, "version"> &
  Omit<Partial<BenchmarkReportBundleV2>, "version"> & {
    version?: unknown;
  };

function readBundle(value: unknown): BenchmarkReportBundleAny {
  if (!value || typeof value !== "object") {
    throw new Error("Benchmark import must be a JSON object.");
  }
  const bundle = value as ImportCandidate;
  if (!isBaseBundleShape(bundle)) {
    throw new Error("File is not an AI Board benchmark report bundle.");
  }
  if (bundle.version === 1) return bundle as BenchmarkReportBundle;
  if (
    bundle.version === 2 &&
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
  throw new Error("File is not a supported AI Board benchmark report bundle.");
}

function isBaseBundleShape(
  bundle: ImportCandidate
): bundle is ImportCandidate & {
  version: 1 | 2;
} {
  return (
    (bundle.version === 1 || bundle.version === 2) &&
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

  const exportLegacyJson = useCallback(() => {
    if (!dashboard) return;
    const bundle = exportBenchmarkReportBundle();
    downloadBenchmarkJson(bundle);
    setMessage("Legacy Lab Bundle v1 exported.");
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
      if (bundle.version === 2) {
        await importBenchmarkReportBundleV2(bundle);
      } else {
        await importBenchmarkReportBundle(bundle);
      }
      await reload();
      const certified =
        bundle.version === 2
          ? `, ${
              bundle.attemptsV2.filter((attempt) => attempt.mode === "certified")
                .length
            } certified attempt(s)`
          : "";
      setMessage(
        `Imported ${bundle.runs.length} run(s), ${bundle.cases.length} case(s)${certified}.`
      );
    },
    [reload, setMessage]
  );

  return { exportJson, exportLegacyJson, exportMarkdown, importJson };
}
