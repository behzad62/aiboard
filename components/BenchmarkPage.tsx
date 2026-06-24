"use client";

import { BenchmarkLab } from "@/components/BenchmarkLab";
import { BuildLeaderboard } from "@/components/benchmark/BuildLeaderboard";
import { GamesBenchmark } from "@/components/games/GamesBenchmark";
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
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="build">Build</TabsTrigger>
          <TabsTrigger value="games">Game Benchmarks</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <BenchmarkLab view="overview" />
        </TabsContent>

        <TabsContent value="evidence" className="space-y-6">
          <BenchmarkLab view="evidence" />
        </TabsContent>

        <TabsContent value="build" className="space-y-6">
          <BuildLeaderboard />
        </TabsContent>

        <TabsContent value="games" className="space-y-6">
          <GamesBenchmark />
        </TabsContent>

        <TabsContent value="reports" className="space-y-6">
          <BenchmarkLab view="reports" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default BenchmarkPage;
