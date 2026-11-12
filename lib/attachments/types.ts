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

/**
 * The largest model request AI Board sends: its 8 attachments of 15 MiB after
 * base64, plus 8 MiB for the messages. The Runner's model proxy answers 413
 * past it, with the same value as `MODEL_PROXY_MAX_REQUEST_BYTES`
 * (runner-v2/src/model-proxy.ts); Runner code cannot import lib/, so
 * scripts/test-model-proxy-client.mts pins the two to each other.
 */
export const MODEL_REQUEST_MAX_BYTES =
  Math.ceil((MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4) / 3) + 8 * 1024 * 1024;

/** The bytes a message and its attachments take in a model request (attachments go base64). */
export function modelRequestBytes(text: string, attachmentSizes: readonly number[]): number {
  const textBytes = new TextEncoder().encode(text).length;
  return attachmentSizes.reduce((total, size) => total + Math.ceil((Math.max(0, size) * 4) / 3), textBytes);
}

/** The composer's refusal for a message the model proxy would refuse with 413, or null when it fits. */
export function modelRequestTooLargeMessage(bytes: number, limit = MODEL_REQUEST_MAX_BYTES): string | null {
  if (bytes <= limit) return null;
  const mib = (value: number) => (value / (1024 * 1024)).toFixed(1);
  return `This message is ${mib(bytes)} MiB with its attachments, and AI Board sends at most ${mib(limit)} MiB to a model. Remove an attachment or shorten the message.`;
}

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
