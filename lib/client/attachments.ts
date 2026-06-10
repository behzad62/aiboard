import type { AttachmentPayload } from "@/lib/attachments/types";
import { getAttachments } from "./store";

/** Client equivalent of lib/attachments/storage.loadAttachmentPayloads. */
export function loadAttachmentPayloads(ids: string[]): AttachmentPayload[] {
  return getAttachments(ids).map((record) => ({
    id: record.id,
    filename: record.filename,
    mimeType: record.mimeType,
    category: record.category,
    textContent: record.textContent,
    base64Data:
      record.category !== "text_inline" ? record.base64Data : undefined,
  }));
}
