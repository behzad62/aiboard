"use client";

import { useState } from "react";
import JSZip from "jszip";
import type { ExtractedFile } from "@/lib/artifacts/extract";
import { Button } from "@/components/ui/button";
import { ChevronRight, Download, FileCode2 } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function ArtifactPanel({ files }: { files: ExtractedFile[] }) {
  const [openPath, setOpenPath] = useState<string | null>(files[0]?.path ?? null);
  const [zipping, setZipping] = useState(false);

  if (files.length === 0) return null;

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
        <div className="flex items-center gap-2">
          <FileCode2 className="h-5 w-5 text-primary" />
          <h3 className="font-display text-lg font-semibold">Project files</h3>
          <span className="font-mono text-xs text-muted-foreground">
            {files.length}
          </span>
        </div>
        <Button size="sm" onClick={downloadZip} disabled={zipping}>
          <Download className="mr-1 h-4 w-4" />
          {zipping ? "Zipping…" : "Download .zip"}
        </Button>
      </header>

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
