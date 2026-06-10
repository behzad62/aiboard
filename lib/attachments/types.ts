/** Input types that require explicit model capability */
export type CapabilityInputType = "image" | "document" | "audio" | "video";

/** All attachment categories including inline text files */
export type AttachmentCategory = CapabilityInputType | "text_inline";

export interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  category: AttachmentCategory;
  size: number;
  textContent?: string;
  /** Server representation: path to the file on disk. */
  storagePath?: string;
  /** Client representation: base64 of the file (for non-text attachments). */
  base64Data?: string;
  createdAt: string;
}

export interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  category: AttachmentCategory;
  size: number;
}

export interface AttachmentPayload {
  id: string;
  filename: string;
  mimeType: string;
  category: AttachmentCategory;
  textContent?: string;
  base64Data?: string;
}

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;

export const ACCEPTED_MIME_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "text/",
  "application/pdf",
  "application/json",
  "application/xml",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/rtf",
  "application/csv",
];
