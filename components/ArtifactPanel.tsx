"use client";

import { useState } from "react";
import JSZip from "jszip";
import type { ExtractedFile } from "@/lib/artifacts/extract";
import { Button } from "@/components/ui/button";
import { ChevronRight, Download, FileCode2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NativeBuildFileSnapshot } from "@/lib/client/runner-v2";

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type ArtifactSnapshotMetadata = Pick<
  NativeBuildFileSnapshot,
  "source" | "revision" | "appliedToProject" | "omittedFileCount"
>;

export function artifactSourceLabel(snapshot: ArtifactSnapshotMetadata): string {
  return snapshot.source === "project" ? "Applied project" : "Proposed integration";
}

export function abbreviateArtifactRevision(revision: string): string {
  return revision.slice(0, 12);
}

export function ArtifactPanel({
  files,
  snapshot,
}: {
  files: ExtractedFile[];
  snapshot?: ArtifactSnapshotMetadata;
}) {
  const [openPath, setOpenPath] = useState<string | null>(files[0]?.path ?? null);
  const [zipping, setZipping] = useState(false);

  if (files.length === 0 && !snapshot) return null;

  const downloadOne = (file: ExtractedFile) => {
    downloadBlob(
      new Blob([file.content], { type: "text/plain;charset=utf-8" }),
      basename(file.path)
    );
  };

  const downloadZip = async () => {
    setZipping(true);
    try {
      const zip = new JSZip();
      for (const file of files) zip.file(file.path, file.content);
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, "project.zip");
    } finally {
      setZipping(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <FileCode2 className="h-5 w-5 text-primary" />
          <h3 className="font-display text-lg font-semibold">Project files</h3>
          <span className="font-mono text-xs text-muted-foreground">
            {files.length}
          </span>
          {snapshot && (
            <span className="rounded-full border bg-background px-2 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
              {artifactSourceLabel(snapshot)} · {abbreviateArtifactRevision(snapshot.revision)}
            </span>
          )}
        </div>
        <Button size="sm" onClick={downloadZip} disabled={zipping || files.length === 0}>
          <Download className="mr-1 h-4 w-4" />
          {zipping ? "Zipping…" : "Download .zip"}
        </Button>
      </header>

      {snapshot && snapshot.omittedFileCount > 0 && (
        <p className="border-b bg-amber-50 px-5 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          {snapshot.omittedFileCount} {snapshot.omittedFileCount === 1 ? "file" : "files"} omitted.
          Runner leaves files out when they are binary, oversized, or outside the snapshot budget.
        </p>
      )}

      <ul className="divide-y">
        {files.map((file) => {
          const isOpen = openPath === file.path;
          return (
            <li key={file.path}>
              <div className="flex items-center gap-1 px-3 py-1.5 transition-colors hover:bg-accent/40">
                <button
                  type="button"
                  onClick={() => setOpenPath(isOpen ? null : file.path)}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
                >
                  <ChevronRight
                    className={cn(
                      "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                      isOpen && "rotate-90"
                    )}
                  />
                  <span className="truncate font-mono text-sm">{file.path}</span>
                  <span className="ml-auto shrink-0 pl-2 font-mono text-[0.7rem] text-muted-foreground">
                    {formatBytes(file.content.length)}
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => downloadOne(file)}
                  title={`Download ${basename(file.path)}`}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </div>
              {isOpen && (
                <pre className="max-h-[28rem] overflow-auto border-t border-slate-800 bg-slate-950 px-5 py-4 text-xs leading-relaxed text-slate-100">
                  <code>{file.content}</code>
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
