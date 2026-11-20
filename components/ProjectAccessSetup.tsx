"use client";

import { useEffect, useMemo, useState } from "react";
import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";
import { getToolRuntimeRunnerIfLoaded, saveToolRuntimeRunner } from "@/lib/client/tool-runtime";
import { getLauncherConnection } from "@/lib/client/local-runner-handoff";
import { isInitialized } from "@/lib/client/store";
import { useStoreLoaded } from "@/lib/client/use-store-loaded";

interface ProjectAccessSetupProps {
  onFolderChange?: (folderName: string | null) => void;
  onRunnerChange?: (selection: RunnerSelection | null) => void;
}

/** Build execution is native-runner only; the browser never owns project files. */
export function ProjectAccessSetup({ onRunnerChange }: ProjectAccessSetupProps) {
  // This tab's `aiboard` session needs no store and wins either way, so with one the picker never changes when the
  // store finishes loading (that would reset the access the user chose). Without one, a Runner saved in this browser
  // is readable only once the store has loaded: until then the picker waits (disabled, since saving needs the
  // store) and starts again with the saved Runner.
  const [launcher, setLauncher] = useState(() => getLauncherConnection());
  const storeLoaded = useStoreLoaded();
  const savedRunnerReadable = !launcher && storeLoaded;
  const initialSelection = useMemo(() => {
    if (launcher) {
      return { url: launcher.url, token: launcher.token, access: "ask" as const, source: "launcher" as const };
    }
    return savedRunnerReadable ? getToolRuntimeRunnerIfLoaded() : null;
  }, [launcher, savedRunnerReadable]);
  useEffect(() => {
    onRunnerChange?.(initialSelection);
  }, [initialSelection, onRunnerChange]);
  return (
    <RunnerSetup
      key={launcher ? "launcher" : savedRunnerReadable ? "store-loaded" : "store-loading"}
      initialSelection={initialSelection}
      disabled={!launcher && !storeLoaded}
      launcherAccessCeiling
      onChange={(selection) => {
        if (launcher && selection === null && !getLauncherConnection()) {
          // The session was disconnected (the manual Disconnect also sends null, but leaves the session). A Runner
          // saved in this browser stays saved, and the picker goes on without the session (waiting for the store
          // if it is still loading).
          setLauncher(null);
          onRunnerChange?.(null);
          return;
        }
        // Launcher session tokens are tab-scoped and must never be persisted; saving a Runner needs the store.
        if (selection?.source !== "launcher" && isInitialized()) saveToolRuntimeRunner(selection);
        onRunnerChange?.(selection);
      }}
    />
  );
}
