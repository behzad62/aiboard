"use client";

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ProjectFolderPicker } from "@/components/ProjectFolderPicker";
import { RunnerSetup, type RunnerSelection } from "@/components/RunnerSetup";
import { getPendingProjectFolder } from "@/lib/client/project-fs";

interface ProjectAccessSetupProps {
  onFolderChange?: (folderName: string | null) => void;
  onRunnerChange?: (selection: RunnerSelection | null) => void;
}

/**
 * Build-mode project access. The local runner is the primary path (files +
 * commands + MCP tools); the browser folder picker is a no-terminal fallback,
 * collapsed by default so the two don't read as competing options.
 */
export function ProjectAccessSetup({
  onFolderChange,
  onRunnerChange,
}: ProjectAccessSetupProps) {
  const [folderName, setFolderName] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);

  // A folder picked earlier in this session should stay visible.
  useEffect(() => {
    const pending = getPendingProjectFolder()?.name ?? null;
    if (pending) {
      setFolderName(pending);
      setShowFallback(true);
    }
  }, []);

  return (
    <div className="space-y-2">
      <RunnerSetup onChange={onRunnerChange} pickedFolderName={folderName} />

      <button
        type="button"
        onClick={() => setShowFallback((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={showFallback}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            showFallback && "rotate-90"
          )}
        />
        No terminal? Pick a folder in the browser instead
        {folderName && !showFallback && (
          <span className="ml-1 font-medium text-foreground">
            ({folderName})
          </span>
        )}
      </button>

      {showFallback && (
        <ProjectFolderPicker
          onChange={(name) => {
            setFolderName(name);
            onFolderChange?.(name);
          }}
        />
      )}
    </div>
  );
}
