import type { AttachmentCategory, CapabilityInputType } from "./types";

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "application/csv",
  "application/rtf",
]);

export function classifyMimeType(mimeType: string, filename: string): AttachmentCategory {
  const mime = mimeType.toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";

  if (
    TEXT_MIMES.has(mime) ||
    ["txt", "md", "csv", "json", "html", "xml", "rtf", "log"].includes(ext)
  ) {
    return "text_inline";
  }

  if (
    mime === "application/pdf" ||
    mime.includes("word") ||
    mime.includes("excel") ||
    mime.includes("powerpoint") ||
    mime.includes("opendocument") ||
    ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt"].includes(ext)
  ) {
    return "document";
  }

  return "document";
}

export function getRequiredCapabilityTypes(
  categories: AttachmentCategory[]
): CapabilityInputType[] {
  const required = new Set<CapabilityInputType>();
  for (const cat of categories) {
    if (cat !== "text_inline") {
      required.add(cat);
    }
  }
  return Array.from(required);
}

export function formatCategoryLabel(category: AttachmentCategory): string {
  switch (category) {
    case "image":
      return "Image";
    case "document":
      return "Document";
    case "audio":
      return "Audio";
    case "video":
      return "Video";
    case "text_inline":
      return "Text file";
  }
}
