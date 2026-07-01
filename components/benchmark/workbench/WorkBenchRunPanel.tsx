"use client";

import type { BenchRunnerHealth } from "@/lib/client/bench-runner";
import type { WorkBenchCasePackOption } from "@/lib/benchmark/workbench";
import { WorkBenchAttemptDetail } from "./WorkBenchAttemptDetail";
import { WorkBenchRunnerStatus } from "./WorkBenchRunnerStatus";

export function WorkBenchRunPanel({
  selectedPack,
  runnerUrl,
  runnerToken,
  runnerHealth,
  checkingRunner,
  onRunnerUrlChange,
  onRunnerTokenChange,
  onCheckRunner,
}: {
  selectedPack: WorkBenchCasePackOption | null;
  runnerUrl: string;
  runnerToken: string;
  runnerHealth: BenchRunnerHealth | null;
  checkingRunner: boolean;
  onRunnerUrlChange: (value: string) => void;
  onRunnerTokenChange: (value: string) => void;
  onCheckRunner: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-md border px-3 py-2 text-sm">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Selected pack
          </div>
          <div className="mt-1 font-medium leading-snug">
            {selectedPack?.label ?? "Select a WorkBench pack"}
          </div>
        </div>
        <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
          {selectedPack?.caseCount ?? 0} certified fixture cases
        </div>
      </div>
      <WorkBenchRunnerStatus
        url={runnerUrl}
        token={runnerToken}
        health={runnerHealth}
        checking={checkingRunner}
        onUrlChange={onRunnerUrlChange}
        onTokenChange={onRunnerTokenChange}
        onCheck={onCheckRunner}
      />
      <WorkBenchAttemptDetail selectedPack={selectedPack} />
    </div>
  );
}
