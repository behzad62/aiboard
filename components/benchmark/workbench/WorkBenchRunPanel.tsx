"use client";

import type { BenchRunnerHealth } from "@/lib/client/bench-runner";
import { WorkBenchAttemptDetail } from "./WorkBenchAttemptDetail";
import {
  WorkBenchCasePicker,
  type WorkBenchCasePickerOption,
} from "./WorkBenchCasePicker";
import { WorkBenchRunnerStatus } from "./WorkBenchRunnerStatus";

export function WorkBenchRunPanel({
  cases,
  selectedCaseId,
  runnerUrl,
  runnerToken,
  runnerHealth,
  checkingRunner,
  onCaseChange,
  onRunnerUrlChange,
  onRunnerTokenChange,
  onCheckRunner,
}: {
  cases: WorkBenchCasePickerOption[];
  selectedCaseId: string;
  runnerUrl: string;
  runnerToken: string;
  runnerHealth: BenchRunnerHealth | null;
  checkingRunner: boolean;
  onCaseChange: (value: string) => void;
  onRunnerUrlChange: (value: string) => void;
  onRunnerTokenChange: (value: string) => void;
  onCheckRunner: () => void;
}) {
  const selectedCase =
    cases.find((item) => item.id === selectedCaseId) ?? cases[0] ?? null;
  const v2Count = cases.filter((item) => item.case.caseVersion.startsWith("2")).length;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <WorkBenchCasePicker
          value={selectedCaseId}
          cases={cases}
          onChange={onCaseChange}
        />
        <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
          {cases.length} certified fixture cases · {v2Count} v2 challenges
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
      <WorkBenchAttemptDetail selectedCase={selectedCase} />
    </div>
  );
}
