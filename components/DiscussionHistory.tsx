"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { Discussion } from "@/lib/db/schema";

interface DiscussionHistoryProps {
  discussions: Discussion[];
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

export function DiscussionHistory({ discussions }: DiscussionHistoryProps) {
  if (discussions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No discussions yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {discussions.map((d) => (
        <Link
          key={d.id}
          href={`/discussion/${d.id}`}
          className="flex items-center justify-between rounded-lg border p-4 transition-colors hover:bg-accent"
        >
          <div className="min-w-0 flex-1 pr-4">
            <p className="truncate font-medium">{d.topic}</p>
            <p className="text-xs text-muted-foreground">
              {formatDate(d.createdAt)} · {d.mode} · {d.effort}
            </p>
          </div>
          <Badge variant={statusVariant(d.status)}>{d.status}</Badge>
        </Link>
      ))}
    </div>
  );
}
