"use client";

import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { clearAllBenchmarkData } from "@/lib/benchmark/store";
import { ClearBenchmarkDataDialog } from "@/components/benchmark/ClearBenchmarkDataDialog";
import { BenchmarkCharts } from "@/components/benchmark/BenchmarkCharts";
import { BenchmarkEvidencePanel } from "@/components/benchmark/BenchmarkEvidencePanel";
import { BenchmarkHeadToHeadTable } from "@/components/benchmark/BenchmarkHeadToHeadTable";
import { BenchmarkModelScorecards } from "@/components/benchmark/BenchmarkModelScorecards";
import { BenchmarkReportActions } from "@/components/benchmark/BenchmarkReportActions";
import { BenchmarkReportSummary } from "@/components/benchmark/BenchmarkReportSummary";
import { BenchmarkSummaryStrip } from "@/components/benchmark/BenchmarkSummaryStrip";
import {
  CertifiedBenchmarkOverview,
  type CertifiedTrackView,
} from "@/components/benchmark/certified/CertifiedBenchmarkOverview";
import { CertifiedRunPanel } from "@/components/benchmark/certified/CertifiedRunPanel";
import { FailureTaxonomyPanel } from "@/components/benchmark/certified/FailureTaxonomyPanel";
import { useBenchmarkDashboard } from "@/components/benchmark/useBenchmarkDashboard";
import { useBenchmarkReportActions } from "@/components/benchmark/useBenchmarkReportActions";
import type { BenchmarkEvidenceItem } from "@/lib/benchmark/metrics";

type BenchmarkLabView =
  | "overview"
  | "lab-evidence"
  | "certified"
  | "workbench"
  | "gameiq"
  | "teamiq"
  | "toolreliability"
  | "reports"
  | "full";

export function BenchmarkLab({ view = "full" }: { view?: BenchmarkLabView }) {
  const {
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
    refresh,
    setMessage,
  } = useBenchmarkDashboard();
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] =
    useState<BenchmarkEvidenceItem | null>(null);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { exportJson, exportMarkdown, importJson } = useBenchmarkReportActions({
    dashboard,
    reload: refresh,
    setMessage,
  });

  const selectedModel = useMemo(
    () =>
      dashboard?.models.find((model) => model.modelId === selectedModelId) ??
      null,
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

  const certifiedTrack = certifiedTrackForView(view);
  const showLabOverview = view === "overview" || view === "full";
  const showCertified =
    view === "overview" ||
    view === "certified" ||
    view === "full" ||
    certifiedTrack !== null;
  const showScorecards = view === "lab-evidence" || view === "full";
  const showEvidence = view === "lab-evidence" || view === "full";
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

      {showLabOverview && (
        <div className="space-y-4">
          <SectionHeading
            title="Lab evidence"
            description="Uncertified local scorecards from saved cases, game matches, Build runs, and imported lab reports."
          />
          <BenchmarkSummaryStrip
            dashboard={dashboard}
            suiteCount={suiteCount}
            traceCount={traceCount}
          />
          <BenchmarkCharts dashboard={dashboard} onSelectModel={setSelectedModelId} />
        </div>
      )}

      {showCertified && (
        <div className="space-y-4">
          {(view === "certified" ||
            view === "gameiq" ||
            view === "teamiq" ||
            view === "workbench" ||
            view === "toolreliability" ||
            view === "full") && (
            <CertifiedRunPanel
              track={certifiedTrack ?? "all"}
              onComplete={refresh}
              setMessage={setMessage}
            />
          )}
          <CertifiedBenchmarkOverview
            certified={certifiedDashboard}
            counts={reportCounts}
            track={certifiedTrack ?? "all"}
            corruptRunFileCount={corruptRunFileCount}
            onRefresh={refresh}
            setMessage={setMessage}
          />
          {(view === "certified" || view === "full") && (
            <FailureTaxonomyPanel failures={benchmarkFailures} />
          )}
        </div>
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
          {corruptRunFileCount > 0 && (
            <div
              role="status"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
            >
              {corruptRunFileCount} benchmark run file
              {corruptRunFileCount === 1 ? "" : "s"} could not be read — see the
              browser console for details.
            </div>
          )}
          <BenchmarkSummaryStrip
            dashboard={dashboard}
            suiteCount={suiteCount}
            traceCount={traceCount}
          />
          <BenchmarkReportSummary counts={reportCounts} />
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
            <div className="text-sm">
              <p className="font-medium text-foreground">Danger zone</p>
              <p className="text-muted-foreground">
                Permanently delete every benchmark record. Game match history,
                Build Lab stats, and settings are kept. Export a bundle first if
                you might need this data later.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setClearDialogOpen(true)}
              data-testid="clear-benchmark-open"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Clear all benchmark data
            </Button>
          </div>
        </div>
      )}

      {clearDialogOpen && (
        <ClearBenchmarkDataDialog
          busy={clearing}
          onCancel={() => {
            if (!clearing) setClearDialogOpen(false);
          }}
          onConfirm={() => void handleClearAllBenchmarkData()}
        />
      )}
    </section>
  );

  function reportError(error: unknown) {
    setMessage(error instanceof Error ? error.message : String(error));
  }

  async function handleClearAllBenchmarkData() {
    setClearing(true);
    try {
      const { runFiles, records } = await clearAllBenchmarkData();
      await refresh();
      setClearDialogOpen(false);
      setMessage(
        `Cleared all benchmark data: ${records} record${
          records === 1 ? "" : "s"
        } and ${runFiles} run file${runFiles === 1 ? "" : "s"} deleted. Game ` +
          `match history, Build Lab stats, and settings were kept.`
      );
    } catch (error) {
      reportError(error);
    } finally {
      setClearing(false);
    }
  }
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        {description}
      </p>
    </div>
  );
}

function certifiedTrackForView(
  view: BenchmarkLabView
): CertifiedTrackView | null {
  if (
    view === "workbench" ||
    view === "gameiq" ||
    view === "teamiq" ||
    view === "toolreliability"
  ) {
    return view;
  }
  return null;
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
  const header = headerCopyForView(view);

  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          {header.title}
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {header.description}
        </p>
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

function headerCopyForView(view: BenchmarkLabView): {
  title: string;
  description: string;
} {
  switch (view) {
    case "lab-evidence":
      return {
        title: "Lab Evidence",
        description:
          "Inspect source records, model responses, retries, fallbacks, artifacts, and head-to-head outcomes.",
      };
    case "certified":
      return {
        title: "Certified",
        description:
          "Versioned benchmark cases, verifier results, teams, harness versions, and reproducibility metadata.",
      };
    case "workbench":
      return {
        title: "WorkBench",
        description:
          "Certified software-work attempts scored by verifier quality, cost, time, and tool reliability.",
      };
    case "gameiq":
      return {
        title: "GameIQ",
        description:
          "Certified game-playing attempts scored separately from informal AI-vs-AI lab matches.",
      };
    case "teamiq":
      return {
        title: "TeamIQ",
        description:
          "Certified team-composition attempts for comparing solo and multi-model performance.",
      };
    case "toolreliability":
      return {
        title: "Tool Reliability",
        description:
          "Certified tool-use attempts focused on schemas, repairs, patching, and command safety.",
      };
    case "reports":
      return {
        title: "Reports",
        description:
          "Export the current benchmark bundle, copy a Markdown report, or import a saved JSON report.",
      };
    case "overview":
      return {
        title: "Benchmark Overview",
        description:
          "Local lab evidence and certified benchmark records are summarized separately.",
      };
    case "full":
    default:
      return {
        title: "Benchmark Lab",
        description:
          "Local scorecards, certified benchmark runs, evidence, and reports in one place.",
      };
  }
}
