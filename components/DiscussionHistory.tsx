"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { Discussion } from "@/lib/db/schema";
import { Trash2 } from "lucide-react";
import { deleteDiscussion } from "@/lib/client/api";

interface DiscussionHistoryProps {
  discussions: Discussion[];
  onDeleted?: (id: string) => void;
}

function statusVariant(status: string) {
  switch (status) {
    case "completed":
      return "success" as const;
    case "running":
      return "warning" as const;
    case "failed":
      return "destructive" as const;
    default:
      return "secondary" as const;
  }
}

export function DiscussionHistory({
  discussions,
  onDeleted,
}: DiscussionHistoryProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const remove = async (d: Discussion) => {
    if (!window.confirm(`Delete this discussion?\n\n"${d.topic.slice(0, 100)}"`)) {
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
    return <p className="text-sm text-muted-foreground">No discussions yet.</p>;
  }

  return (
    <div className="space-y-2">
      {discussions.map((d) => (
        <div
          key={d.id}
          className="flex items-center justify-between gap-2 rounded-lg border p-4 transition-colors hover:bg-accent"
        >
          <Link href={`/discussion?id=${d.id}`} className="min-w-0 flex-1">
            <p className="truncate font-medium">{d.topic}</p>
            <p className="text-xs text-muted-foreground">
              {formatDate(d.createdAt)} · {d.mode} · {d.effort}
            </p>
          </Link>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
            <button
              type="button"
              onClick={() => remove(d)}
              disabled={deletingId === d.id}
              title="Delete discussion"
              aria-label="Delete discussion"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
