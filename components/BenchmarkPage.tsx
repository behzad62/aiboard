"use client";

import { BenchmarkLab } from "@/components/BenchmarkLab";
import { BuildLeaderboard } from "@/components/benchmark/BuildLeaderboard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function BenchmarkPage() {
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

      <Tabs defaultValue="overview" className="space-y-6">
        <TabsList className="flex h-auto flex-wrap justify-start gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="lab-evidence">Lab Evidence</TabsTrigger>
          <TabsTrigger value="certified">Certified</TabsTrigger>
          <TabsTrigger value="workbench">WorkBench</TabsTrigger>
          <TabsTrigger value="gameiq">GameIQ</TabsTrigger>
          <TabsTrigger value="teamiq">TeamIQ</TabsTrigger>
          <TabsTrigger value="toolreliability">Tool Reliability</TabsTrigger>
          <TabsTrigger value="build-lab">Build Lab</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <BenchmarkLab view="overview" />
        </TabsContent>

        <TabsContent value="lab-evidence" className="space-y-6">
          <BenchmarkLab view="lab-evidence" />
        </TabsContent>

        <TabsContent value="certified" className="space-y-6">
          <BenchmarkLab view="certified" />
        </TabsContent>

        <TabsContent value="workbench" className="space-y-6">
          <BenchmarkLab view="workbench" />
        </TabsContent>

        <TabsContent value="gameiq" className="space-y-6">
          <BenchmarkLab view="gameiq" />
        </TabsContent>

        <TabsContent value="teamiq" className="space-y-6">
          <BenchmarkLab view="teamiq" />
        </TabsContent>

        <TabsContent value="toolreliability" className="space-y-6">
          <BenchmarkLab view="toolreliability" />
        </TabsContent>

        <TabsContent value="build-lab" className="space-y-6">
          <BuildLeaderboard />
        </TabsContent>

        <TabsContent value="reports" className="space-y-6">
          <BenchmarkLab view="reports" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default BenchmarkPage;
