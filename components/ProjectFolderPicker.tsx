"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FolderOpen, X } from "lucide-react";
import {
  fileSystemAccessSupported,
  getPendingProjectFolder,
  pickProjectFolder,
  setPendingProjectFolder,
} from "@/lib/client/project-fs";

interface ProjectFolderPickerProps {
  onChange?: (folderName: string | null) => void;
}

/**
 * Build-mode project folder selection. The picked handle is held as the
 * "pending" folder and bound to the discussion id on creation; models then
 * read and write real files inside it. Without a folder, Build falls back to
 * in-app files with zip download.
 */
export function ProjectFolderPicker({ onChange }: ProjectFolderPickerProps) {
  const [supported, setSupported] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSupported(fileSystemAccessSupported());
    setFolderName(getPendingProjectFolder()?.name ?? null);
  }, []);

  const pick = async () => {
    setError(null);
    try {
      const handle = await pickProjectFolder();
      setPendingProjectFolder(handle);
      setFolderName(handle.name);
      onChange?.(handle.name);
    } catch (err) {
      // AbortError = user cancelled the picker; stay quiet.
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message);
      }
    }
  };

  const clear = () => {
    setPendingProjectFolder(null);
    setFolderName(null);
    onChange?.(null);
  };

  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
      <Label>Browser folder access (no terminal needed)</Label>
      <p className="text-xs text-muted-foreground">
        {supported
          ? "The browser itself reads and writes the picked folder — nothing to install or start. Trade-offs vs the runner: access must be re-granted each browser session, and commands/MCP tools aren't available. Without a folder or a runner, files stay in the app and can be downloaded as a zip."
          : "Folder access isn't supported in this browser — connect the local runner above for disk access, or files stay in the app and can be downloaded as a zip."}
      </p>
      {supported && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={pick}>
            <FolderOpen className="mr-2 h-4 w-4" />
            {folderName ? "Change folder" : "Choose folder…"}
          </Button>
          {folderName && (
            <Badge variant="success" className="gap-1">
              {folderName}
              <button
                type="button"
                onClick={clear}
                aria-label="Clear project folder"
                className="ml-1 rounded-full hover:opacity-70"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
