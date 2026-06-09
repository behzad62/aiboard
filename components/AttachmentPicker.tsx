"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { AttachmentSummary } from "@/lib/attachments/types";
import { formatCategoryLabel } from "@/lib/attachments/classify";
import { MAX_ATTACHMENTS } from "@/lib/attachments/types";
import { Paperclip, X, FileText, Image as ImageIcon, Music, Video } from "lucide-react";
import { cn } from "@/lib/utils";

const ACCEPT =
  "image/*,audio/*,video/*,.pdf,.txt,.md,.csv,.json,.html,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.xml";

interface AttachmentPickerProps {
  attachments: AttachmentSummary[];
  onChange: (attachments: AttachmentSummary[]) => void;
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

export function AttachmentPicker({ attachments, onChange }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      if (attachments.length + files.length > MAX_ATTACHMENTS) {
        setError(`Maximum ${MAX_ATTACHMENTS} attachments allowed`);
        return;
      }

      setUploading(true);
      setError(null);
      try {
        const formData = new FormData();
        Array.from(files).forEach((f) => formData.append("files", f));

        const res = await fetch("/api/attachments", {
          method: "POST",
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Upload failed");

        onChange([...attachments, ...data.attachments]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [attachments, onChange]
  );

  const remove = async (id: string) => {
    await fetch(`/api/attachments?id=${id}`, { method: "DELETE" });
    onChange(attachments.filter((a) => a.id !== id));
  };

  return (
    <div className="space-y-3">
      <Label>Attachments (optional)</Label>
      <p className="text-xs text-muted-foreground">
        Images, documents (PDF, Word, text), audio, and video. Models incompatible with attached types will be disabled.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading || attachments.length >= MAX_ATTACHMENTS}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip className="mr-2 h-4 w-4" />
          {uploading ? "Uploading..." : "Add files"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => uploadFiles(e.target.files)}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {attachments.length > 0 && (
        <ul className="space-y-2">
          {attachments.map((file) => (
            <li
              key={file.id}
              className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
            >
              <div className="flex min-w-0 items-center gap-2">
                <CategoryIcon category={file.category} />
                <span className="truncate font-medium">{file.filename}</span>
                <Badge variant="secondary" className="shrink-0">
                  {formatCategoryLabel(file.category)}
                </Badge>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {(file.size / 1024).toFixed(0)} KB
                </span>
              </div>
              <button
                type="button"
                onClick={() => remove(file.id)}
                className={cn(
                  "shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                )}
                aria-label={`Remove ${file.filename}`}
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type { AttachmentSummary };
