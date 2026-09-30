"use client";

import { useEffect, useMemo } from "react";
import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";
import { getToolRuntimeRunner, saveToolRuntimeRunner } from "@/lib/client/tool-runtime";

interface ProjectAccessSetupProps {
  onFolderChange?: (folderName: string | null) => void;
  onRunnerChange?: (selection: RunnerSelection | null) => void;
}

/** Build execution is native-runner only; the browser never owns project files. */
export function ProjectAccessSetup({ onRunnerChange }: ProjectAccessSetupProps) {
  const initialSelection = useMemo(() => getToolRuntimeRunner(), []);
  useEffect(() => {
    onRunnerChange?.(initialSelection);
  }, [initialSelection, onRunnerChange]);
  return (
    <RunnerSetup
      initialSelection={initialSelection}
      onChange={(selection) => {
        saveToolRuntimeRunner(selection);
        onRunnerChange?.(selection);
      }}
    />
  );
}
