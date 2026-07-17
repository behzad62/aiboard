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
import { CertifiedBenchmarkOverview } from "@/components/benchmark/certified/CertifiedBenchmarkOverview";
import { CertifiedRunPanel } from "@/components/benchmark/certified/CertifiedRunPanel";
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

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Model benchmark
        </h1>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Compare local benchmark evidence across saved cases, Build runs, and
          AI-vs-AI game benchmarks without sending data to a server.
        </p>
      </header>

      <Tabs defaultValue="run" className="space-y-6">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="results">Results</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
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
            <CertifiedBenchmarkOverview
              certified={certifiedDashboard}
              counts={reportCounts}
              track="all"
              corruptRunFileCount={corruptRunFileCount}
              onRefresh={refresh}
              setMessage={setMessage}
            />
          </DashboardGate>
          <BuildLeaderboard />
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
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export default BenchmarkPage;
