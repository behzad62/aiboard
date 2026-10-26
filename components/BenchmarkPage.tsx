"use client";

import { useState, type ReactNode } from "react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BenchmarkLab } from "@/components/BenchmarkLab";
import { CertifiedBenchmarkOverview } from "@/components/benchmark/certified/CertifiedBenchmarkOverview";
import { CertifiedRunPanel } from "@/components/benchmark/certified/CertifiedRunPanel";
import { BenchmarkDecisionDashboard } from "@/components/benchmark/results/BenchmarkDecisionDashboard";
import { useBenchmarkDashboard } from "@/components/benchmark/useBenchmarkDashboard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function BenchmarkPage() {
  const {
    certifiedDashboard,
    reportCounts,
    corruptRunFileCount,
    locked,
    loading,
    message,
    refresh,
    setMessage,
  } = useBenchmarkDashboard();
  const [tab, setTab] = useState("results");

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Benchmark
        </h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Compare models with HarnessBench and qualify their native tool use with ToolBench.
          Runs use your own keys; results stay on this device.
        </p>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>

        <TabsContent value="run" className="space-y-6">
          <DashboardGate locked={locked} loading={loading}>
            {message && <MessageBanner message={message} />}
            <CertifiedRunPanel
              onComplete={refresh}
              setMessage={setMessage}
            />
          </DashboardGate>
        </TabsContent>

        <TabsContent value="results" className="space-y-6">
          <DashboardGate locked={locked} loading={loading}>
            {message && <MessageBanner message={message} />}
            <BenchmarkDecisionDashboard
              certified={certifiedDashboard}
              onStartRun={() => setTab("run")}
              onRefresh={refresh}
              setMessage={setMessage}
            />
            <details className="glass overflow-hidden rounded-xl border">
              <summary className="cursor-pointer select-none px-4 py-4">
                <span className="block text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  Audit
                </span>
                <span className="mt-1 block text-base font-semibold">Audit evidence</span>
                <span className="mt-1 block max-w-3xl text-xs font-normal text-muted-foreground">
                  Inspect exclusions, verifier counts, team and role lenses, and evidence-removal controls.
                </span>
              </summary>
              <div className="space-y-6 border-t p-4">
                <CertifiedBenchmarkOverview
                  certified={certifiedDashboard}
                  counts={reportCounts}
                  track="all"
                  corruptRunFileCount={corruptRunFileCount}
                  onRefresh={refresh}
                  setMessage={setMessage}
                />
              </div>
            </details>
          </DashboardGate>
        </TabsContent>

        <TabsContent value="data" className="space-y-6">
          <BenchmarkLab />
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
    <div role="status" className="rounded-lg border bg-accent/40 px-3 py-2 text-sm text-accent-foreground">
      {message}
    </div>
  );
}

export default BenchmarkPage;
