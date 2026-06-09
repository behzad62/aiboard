import type { AttachmentPayload } from "./types";

export function buildAttachmentPromptSection(attachments: AttachmentPayload[]): string {
  if (attachments.length === 0) return "";

  const lines = attachments.map((a) => {
    if (a.category === "text_inline" && a.textContent) {
      return `--- Attached file: ${a.filename} ---\n${a.textContent}`;
    }
    return `[Attached ${a.category}: ${a.filename} (${a.mimeType}) — provided as multimodal input]`;
  });

  return `\n\n--- User attachments ---\n${lines.join("\n\n")}`;
}
