"use client";

import type { ReactNode } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BenchmarkLab } from "@/components/BenchmarkLab";
import { BuildLeaderboard } from "@/components/benchmark/BuildLeaderboard";
import { BenchmarkHeadToHeadTable } from "@/components/benchmark/BenchmarkHeadToHeadTable";
import { CapabilityRadarChart } from "@/components/benchmark/CapabilityRadarChart";
import { CertifiedBenchmarkOverview } from "@/components/benchmark/certified/CertifiedBenchmarkOverview";
import { CertifiedRunPanel } from "@/components/benchmark/certified/CertifiedRunPanel";
import { VerdictStrip } from "@/components/benchmark/results/VerdictStrip";
import { useBenchmarkDashboard } from "@/components/benchmark/useBenchmarkDashboard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";

export function BenchmarkPage() {
  const {
    dashboard,
    certifiedDashboard,
    reportCounts,
    corruptRunFileCount,
    locked,
    loading,
    message,
    refresh,
    setMessage,
  } = useBenchmarkDashboard();

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Model benchmark
        </h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Run, compare, and manage local benchmark evidence without sending
          data to a server.
        </p>
      </header>

      <Tabs defaultValue="run" className="space-y-6">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="build">Build</TabsTrigger>
        </TabsList>

        <TabsContent value="run" className="space-y-6">
          <DashboardGate locked={locked} loading={loading}>
            {message && <MessageBanner message={message} />}
            <CertifiedRunPanel
              track="all"
              onComplete={refresh}
              setMessage={setMessage}
            />
          </DashboardGate>
        </TabsContent>

        <TabsContent value="results" className="space-y-6">
          <DashboardGate locked={locked} loading={loading}>
            {message && <MessageBanner message={message} />}
            <VerdictStrip certified={certifiedDashboard} />
            <CertifiedBenchmarkOverview
              certified={certifiedDashboard}
              counts={reportCounts}
              track="all"
              corruptRunFileCount={corruptRunFileCount}
              onRefresh={refresh}
              setMessage={setMessage}
            />
            <AnalysisSection dashboard={dashboard} />
          </DashboardGate>
        </TabsContent>

        <TabsContent value="data" className="space-y-6">
          <BenchmarkLab />
        </TabsContent>

        <TabsContent value="build" className="space-y-6">
          <BuildLeaderboard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DashboardGate({
  locked,
  loading,
  children,
}: {
  locked: boolean;
  loading: boolean;
  children: ReactNode;
}) {
  if (locked) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Benchmark</CardTitle>
          <CardDescription>
            Unlock storage to load benchmark data.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Benchmark</CardTitle>
          <CardDescription>Loading benchmark evidence...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return <>{children}</>;
}

function MessageBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

// Collapsed by default (design doc: Results tab item 3). Head-to-head table
// and capability radar survived the Task 3 IA collapse unimported — they
// remount here with the same useBenchmarkDashboard() data BenchmarkLab used
// to feed them under the old "lab-evidence" view.
function AnalysisSection({
  dashboard,
}: {
  dashboard: BenchmarkDashboardData | null;
}) {
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
        Analysis: head-to-head outcomes and capability profile
      </summary>
      <div className="grid gap-4 border-t p-4 xl:grid-cols-2">
        {dashboard ? (
          <>
            <BenchmarkHeadToHeadTable rows={dashboard.headToHeadRows} />
            <CapabilityRadarChart dashboard={dashboard} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground xl:col-span-2">
            Loading benchmark evidence...
          </p>
        )}
      </div>
    </details>
  );
}

export default BenchmarkPage;
