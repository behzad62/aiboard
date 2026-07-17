"use client";

import { useState } from "react";
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
import { BenchmarkReportActions } from "@/components/benchmark/BenchmarkReportActions";
import { BenchmarkReportSummary } from "@/components/benchmark/BenchmarkReportSummary";
import { BenchmarkSummaryStrip } from "@/components/benchmark/BenchmarkSummaryStrip";
import { useBenchmarkDashboard } from "@/components/benchmark/useBenchmarkDashboard";
import { useBenchmarkReportActions } from "@/components/benchmark/useBenchmarkReportActions";

/**
 * Housekeeping view for the benchmark page's "Data" tab: run history counts,
 * export/import, and the danger zone. This used to be one of nine views this
 * component could render (overview / lab-evidence / per-track certified /
 * reports) — the others now live directly in BenchmarkPage.tsx (Run/Results)
 * or were retired with the 3-tab collapse. The head-to-head table and
 * capability radar chart this component used to render under "lab-evidence"
 * are unused here but intentionally NOT deleted (components/benchmark/
 * BenchmarkHeadToHeadTable.tsx, BenchmarkCharts.tsx,
 * CapabilityRadarChart.tsx) — the Results tab's Analysis section remounts
 * them with the same useBenchmarkDashboard data.
 */
export function BenchmarkLab() {
  const {
    dashboard,
    locked,
    loading,
    message,
    suiteCount,
    traceCount,
    reportCounts,
    corruptRunFileCount,
    refresh,
    setMessage,
  } = useBenchmarkDashboard();
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const { exportJson, exportMarkdown, importJson } = useBenchmarkReportActions({
    dashboard,
    reload: refresh,
    setMessage,
  });

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

  return (
    <section className="space-y-6">
      <BenchmarkLabHeader
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

function BenchmarkLabHeader({
  onRefresh,
  onCopyReport,
  onExportJson,
  onImportJson,
}: {
  onRefresh: () => void;
  onCopyReport: () => void;
  onExportJson: () => void;
  onImportJson: (file: File) => void;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Reports</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Export the current benchmark bundle, copy a Markdown report, or
          import a saved JSON report.
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
