"use client";

import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";

interface ProjectAccessSetupProps {
  onFolderChange?: (folderName: string | null) => void;
  onRunnerChange?: (selection: RunnerSelection | null) => void;
}

/** Build execution is native-runner only; the browser never owns project files. */
export function ProjectAccessSetup({ onRunnerChange }: ProjectAccessSetupProps) {
  return <RunnerSetup onChange={onRunnerChange} />;
}
