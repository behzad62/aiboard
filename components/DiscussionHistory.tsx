"use client";

import { useState } from "react";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import type { Discussion } from "@/lib/db/schema";
import { Trash2 } from "lucide-react";
import { deleteDiscussion } from "@/lib/client/api";

interface DiscussionHistoryProps {
  discussions: Discussion[];
  onDeleted?: (id: string) => void;
}

const STATUS_TONE: Record<string, string> = {
  completed: "text-success",
  failed: "text-destructive",
  stopped: "text-warning",
};

function statusLabel(status: string): string {
  if (status === "completed") return "Done";
  if (status === "failed") return "Failed";
  if (status === "stopped") return "Stopped";
  return "Running";
}

export function DiscussionHistory({
  discussions,
  onDeleted,
}: DiscussionHistoryProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const remove = async (d: Discussion) => {
    if (!window.confirm(`Delete this session?\n\n"${d.topic.slice(0, 100)}"`)) {
      return;
    }
    setDeletingId(d.id);
    try {
      deleteDiscussion(d.id);
      onDeleted?.(d.id);
    } finally {
      setDeletingId(null);
    }
  };

  if (discussions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sessions yet. Your chats and builds will appear here.
      </p>
    );
  }

  return (
    <div className="-mx-2 space-y-0.5">
      {discussions.map((d) => (
        <div
          key={d.id}
          className="group flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-accent"
        >
          <Link href={`/discussion?id=${d.id}`} className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug">{d.topic}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <span className={STATUS_TONE[d.status] ?? "text-primary"}>
                {statusLabel(d.status)}
              </span>
              {" · "}
              {d.mode === "build"
                ? "Build"
                : d.mode === "chat"
                  ? "Chat"
                  : `Chat · ${d.mode}`}
              {" · "}
              {formatDate(d.createdAt)}
            </p>
          </Link>
          <button
            type="button"
            onClick={() => remove(d)}
            disabled={deletingId === d.id}
            title="Delete session"
            aria-label={`Delete session: ${d.topic.slice(0, 60)}`}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-60 transition hover:bg-destructive/10 hover:text-destructive hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50 group-hover:opacity-100"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
