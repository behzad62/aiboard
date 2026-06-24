"use client";

import { useMemo, useState } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BenchmarkCharts } from "@/components/benchmark/BenchmarkCharts";
import { BenchmarkEvidencePanel } from "@/components/benchmark/BenchmarkEvidencePanel";
import { BenchmarkHeadToHeadTable } from "@/components/benchmark/BenchmarkHeadToHeadTable";
import { BenchmarkModelScorecards } from "@/components/benchmark/BenchmarkModelScorecards";
import { BenchmarkReportActions } from "@/components/benchmark/BenchmarkReportActions";
import { BenchmarkReportSummary } from "@/components/benchmark/BenchmarkReportSummary";
import { BenchmarkSummaryStrip } from "@/components/benchmark/BenchmarkSummaryStrip";
import { useBenchmarkDashboard } from "@/components/benchmark/useBenchmarkDashboard";
import { useBenchmarkReportActions } from "@/components/benchmark/useBenchmarkReportActions";
import type { BenchmarkEvidenceItem } from "@/lib/benchmark/metrics";

type BenchmarkLabView = "overview" | "evidence" | "reports" | "full";

export function BenchmarkLab({ view = "full" }: { view?: BenchmarkLabView }) {
  const {
    dashboard,
    locked,
    loading,
    message,
    suiteCount,
    traceCount,
    reportCounts,
    refresh,
    setMessage,
  } = useBenchmarkDashboard();
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] =
    useState<BenchmarkEvidenceItem | null>(null);
  const { exportJson, exportMarkdown, importJson } = useBenchmarkReportActions({
    dashboard,
    reload: refresh,
    setMessage,
  });

  const selectedModel = useMemo(
    () => dashboard?.models.find((model) => model.modelId === selectedModelId) ?? null,
    [dashboard, selectedModelId]
  );
  const selectedEvidenceList = selectedModelId
    ? dashboard?.evidenceByModel[selectedModelId] ?? []
    : [];

  if (locked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Benchmark Lab</CardTitle>
          <CardDescription>Unlock storage to load benchmark reports.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (loading || !dashboard) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Benchmark Lab</CardTitle>
          <CardDescription>Loading benchmark evidence...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const showOverview = view === "overview" || view === "full";
  const showScorecards = view === "overview" || view === "evidence" || view === "full";
  const showEvidence = view === "evidence" || view === "full";
  const showReports = view === "reports";

  return (
    <section className="space-y-6">
      <BenchmarkLabHeader
        view={view}
        onRefresh={() => void refresh()}
        onCopyReport={() => void exportMarkdown().catch(reportError)}
        onExportJson={exportJson}
        onImportJson={(file) => void importJson(file).catch(reportError)}
      />

      {message && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {message}
        </div>
      )}

      {showOverview && (
        <>
          <BenchmarkSummaryStrip
            dashboard={dashboard}
            suiteCount={suiteCount}
            traceCount={traceCount}
          />
          <BenchmarkCharts dashboard={dashboard} onSelectModel={setSelectedModelId} />
        </>
      )}

      {showScorecards && (
        <div className={showEvidence ? "grid gap-4 xl:grid-cols-[1.2fr_0.8fr]" : "grid gap-4"}>
          <BenchmarkModelScorecards
            models={dashboard.models}
            selectedModelId={selectedModelId}
            onSelect={(model) => {
              setSelectedModelId(model.modelId);
              setSelectedEvidence(null);
            }}
          />
          {showEvidence && (
            <BenchmarkEvidencePanel
              model={selectedModel}
              evidence={selectedEvidenceList}
              selectedEvidence={selectedEvidence}
              onSelectEvidence={setSelectedEvidence}
            />
          )}
        </div>
      )}

      {showEvidence && <BenchmarkHeadToHeadTable rows={dashboard.headToHeadRows} />}

      {showReports && (
        <div className="space-y-4">
          <BenchmarkSummaryStrip
            dashboard={dashboard}
            suiteCount={suiteCount}
            traceCount={traceCount}
          />
          <BenchmarkReportSummary counts={reportCounts} />
        </div>
      )}
    </section>
  );

  function reportError(error: unknown) {
    setMessage(error instanceof Error ? error.message : String(error));
  }
}

function BenchmarkLabHeader({
  view,
  onRefresh,
  onCopyReport,
  onExportJson,
  onImportJson,
}: {
  view: BenchmarkLabView;
  onRefresh: () => void;
  onCopyReport: () => void;
  onExportJson: () => void;
  onImportJson: (file: File) => void;
}) {
  const copy =
    view === "evidence"
      ? "Inspect source records, model responses, retries, fallbacks, artifacts, and head-to-head outcomes."
      : view === "reports"
        ? "Export the current benchmark bundle, copy a Markdown report, or import a saved JSON report."
        : "Local-first model scorecards from game matches, Build-mode results, saved benchmark cases, raw failures, and imported reports.";

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          {view === "evidence"
            ? "Evidence"
            : view === "reports"
              ? "Reports"
              : "Benchmark Lab"}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{copy}</p>
      </div>
      <BenchmarkReportActions
        onRefresh={onRefresh}
        onCopyReport={onCopyReport}
        onExportJson={onExportJson}
        onImportJson={onImportJson}
      />
    </div>
  );
}

export default BenchmarkLab;
