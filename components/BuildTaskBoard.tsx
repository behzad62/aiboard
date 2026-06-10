"use client";

import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  CircleDashed,
  FileCode2,
  Hammer,
  ListTodo,
  SearchCheck,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";

export interface BuildTaskView {
  id: string;
  title: string;
  status: "planned" | "in_progress" | "review" | "fixing" | "done" | "failed";
  worker?: string;
}

export interface WrittenFileView {
  path: string;
  bytes: number;
  location: "disk" | "virtual";
}

export interface CommandRunView {
  command: string;
  exitCode: number;
  durationMs: number;
  outputPreview: string;
  denied?: boolean;
}

const STATUS_META: Record<
  BuildTaskView["status"],
  { label: string; variant: "secondary" | "warning" | "success" | "destructive"; icon: React.ReactNode }
> = {
  planned: { label: "Planned", variant: "secondary", icon: <CircleDashed className="h-3.5 w-3.5" /> },
  in_progress: { label: "In progress", variant: "warning", icon: <Hammer className="h-3.5 w-3.5" /> },
  review: { label: "In review", variant: "warning", icon: <SearchCheck className="h-3.5 w-3.5" /> },
  fixing: { label: "Fixing", variant: "warning", icon: <Wrench className="h-3.5 w-3.5" /> },
  done: { label: "Done", variant: "success", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  failed: { label: "Failed", variant: "destructive", icon: <XCircle className="h-3.5 w-3.5" /> },
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function BuildTaskBoard({
  tasks,
  files,
  commands = [],
  folderName,
}: {
  tasks: BuildTaskView[];
  files: WrittenFileView[];
  commands?: CommandRunView[];
  folderName?: string | null;
}) {
  if (tasks.length === 0 && files.length === 0 && commands.length === 0)
    return null;
  const doneCount = tasks.filter((t) => t.status === "done").length;

  // Reflect where files ACTUALLY went, not just where they were meant to go.
  const diskCount = files.filter((f) => f.location === "disk").length;
  const wroteToDisk = diskCount > 0;
  const folderButInApp = !!folderName && files.length > 0 && diskCount === 0;

  const locationNote = wroteToDisk
    ? ` · wrote ${diskCount} file${diskCount === 1 ? "" : "s"} to ${folderName ? `"${folderName}"` : "the project folder on disk"}`
    : folderButInApp
      ? ` · could NOT write to "${folderName}" — files kept in the app`
      : files.length > 0
        ? " · files kept in the app (download below)"
        : folderName
          ? ` · target folder "${folderName}"`
          : "";

  return (
    <section className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <ListTodo className="h-5 w-5 text-primary" />
          Build plan
        </h2>
        <span className="text-sm text-muted-foreground">
          {doneCount}/{tasks.length} tasks done{locationNote}
        </span>
      </div>

      {folderButInApp && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          Nothing was written to <strong>{folderName}</strong> — the browser
          didn&apos;t have write access at run time, so files were kept in the
          app (download below). Re-run and click <strong>Grant folder access</strong>{" "}
          when prompted, or check the browser console (F12) for the exact error.
        </p>
      )}

      {tasks.length > 0 && (
        <ul className="mt-4 space-y-2">
          {tasks.map((task) => {
            const meta = STATUS_META[task.status];
            return (
              <li
                key={task.id}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    <span className="font-mono text-xs text-muted-foreground">{task.id}</span>{" "}
                    {task.title}
                  </p>
                  {task.worker && (
                    <p className="text-xs text-muted-foreground">{task.worker}</p>
                  )}
                </div>
                <Badge variant={meta.variant} className="shrink-0 gap-1">
                  {meta.icon}
                  {meta.label}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      {files.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <FileCode2 className="h-4 w-4 text-primary" />
            Files written ({files.length})
          </p>
          <ul className="grid gap-1 sm:grid-cols-2">
            {files.map((file) => (
              <li
                key={file.path}
                className="flex items-center justify-between gap-2 rounded border bg-muted/20 px-2 py-1 font-mono text-xs"
              >
                <span className="truncate">{file.path}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatBytes(file.bytes)}
                  {file.location === "disk" ? "" : " · in-app"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {commands.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <Terminal className="h-4 w-4 text-primary" />
            Commands run ({commands.length})
          </p>
          <ul className="space-y-1.5">
            {commands.map((cmd, i) => (
              <li key={i} className="rounded border bg-muted/20 p-2">
                <div className="flex items-center justify-between gap-2 font-mono text-xs">
                  <span className="truncate">$ {cmd.command}</span>
                  <Badge
                    variant={
                      cmd.denied
                        ? "secondary"
                        : cmd.exitCode === 0
                          ? "success"
                          : "destructive"
                    }
                    className="shrink-0"
                  >
                    {cmd.denied
                      ? "denied"
                      : `exit ${cmd.exitCode} · ${(cmd.durationMs / 1000).toFixed(1)}s`}
                  </Badge>
                </div>
                {cmd.outputPreview && (
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[0.7rem] text-muted-foreground">
                    {cmd.outputPreview}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
