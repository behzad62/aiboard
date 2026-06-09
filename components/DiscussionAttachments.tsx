"use client";

import type { AttachmentSummary } from "@/lib/attachments/types";
import { formatCategoryLabel } from "@/lib/attachments/classify";
import { Badge } from "@/components/ui/badge";
import { FileText, Image as ImageIcon, Music, Video } from "lucide-react";

interface DiscussionAttachmentsProps {
  attachments: AttachmentSummary[];
}

function CategoryIcon({ category }: { category: AttachmentSummary["category"] }) {
  switch (category) {
    case "image":
      return <ImageIcon className="h-4 w-4" aria-hidden />;
    case "audio":
      return <Music className="h-4 w-4" />;
    case "video":
      return <Video className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
}

export function DiscussionAttachments({ attachments }: DiscussionAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="rounded-lg border bg-muted/20 p-4">
      <h3 className="mb-3 text-sm font-semibold">Attached files</h3>
      <ul className="flex flex-wrap gap-2">
        {attachments.map((file) => (
          <li key={file.id}>
            <a
              href={`/api/attachments/${file.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <CategoryIcon category={file.category} />
              <span>{file.filename}</span>
              <Badge variant="secondary">{formatCategoryLabel(file.category)}</Badge>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
