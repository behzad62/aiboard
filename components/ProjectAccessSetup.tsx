"use client";

import { useEffect, useMemo } from "react";
import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";
import { getToolRuntimeRunnerIfLoaded, saveToolRuntimeRunner } from "@/lib/client/tool-runtime";
import { getLauncherConnection } from "@/lib/client/local-runner-handoff";
import { useStoreLoaded } from "@/lib/client/use-store-loaded";

interface ProjectAccessSetupProps {
  onFolderChange?: (folderName: string | null) => void;
  onRunnerChange?: (selection: RunnerSelection | null) => void;
}

/** Build execution is native-runner only; the browser never owns project files. */
export function ProjectAccessSetup({ onRunnerChange }: ProjectAccessSetupProps) {
  // A Runner saved in this browser is readable only once the store has loaded; until then only this tab's
  // `aiboard` session is known, and the picker starts again with the saved Runner when the store is ready.
  const storeLoaded = useStoreLoaded();
  const initialSelection = useMemo(() => {
    const launcher = getLauncherConnection();
    if (launcher) {
      return { url: launcher.url, token: launcher.token, access: "ask" as const, source: "launcher" as const };
    }
    return storeLoaded ? getToolRuntimeRunnerIfLoaded() : null;
  }, [storeLoaded]);
  useEffect(() => {
    onRunnerChange?.(initialSelection);
  }, [initialSelection, onRunnerChange]);
  return (
    <RunnerSetup
      key={storeLoaded ? "store-loaded" : "store-loading"}
      initialSelection={initialSelection}
      launcherAccessCeiling
      onChange={(selection) => {
        // Launcher session tokens are tab-scoped and must never be persisted.
        if (selection?.source !== "launcher") saveToolRuntimeRunner(selection);
        onRunnerChange?.(selection);
      }}
    />
  );
}
