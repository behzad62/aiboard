import type { AgentMediaAttachment } from "./agent-contracts.js";

type WireMessage = Record<string, unknown>;

/** Native-model adapters attach media to the last user turn, never to system instructions. */
export function withVisualMedia(
  messages: WireMessage[],
  attachments: readonly AgentMediaAttachment[] | undefined,
  format: "anthropic" | "gemini" | "openai-chat" | "openai-responses",
): WireMessage[] {
  if (!attachments?.length) return messages;
  const last = messages.findLastIndex((message) => message.role === "user");
  if (last < 0) throw new Error("Visual inputs require a user message.");
  const next = messages.map((message) => ({ ...message }));
  const current = next[last]!;
  if (format === "anthropic") {
    const parts: unknown[] = typeof current.content === "string"
      ? [{ type: "text", text: current.content }]
      : Array.isArray(current.content) ? [...current.content] : [];
    for (const item of attachments) {
      const source = { type: "base64", media_type: item.mimeType, data: item.base64Data };
      parts.push(item.mimeType === "application/pdf"
        ? { type: "document", source, title: item.filename }
        : { type: "image", source });
    }
    current.content = parts;
  } else if (format === "gemini") {
    const parts = Array.isArray(current.parts) ? [...current.parts] : [];
    for (const item of attachments) parts.push({ inlineData: { mimeType: item.mimeType, data: item.base64Data } });
    current.parts = parts;
  } else if (format === "openai-chat") {
    if (attachments.some((item) => item.mimeType === "application/pdf")) {
      throw new Error("PDF input requires a document-capable Responses, Anthropic, Gemini, or account-backed transport.");
    }
    const parts: unknown[] = typeof current.content === "string"
      ? [{ type: "text", text: current.content }]
      : Array.isArray(current.content) ? [...current.content] : [];
    for (const item of attachments) {
      parts.push({ type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.base64Data}` } });
    }
    current.content = parts;
  } else {
    const parts: unknown[] = typeof current.content === "string"
      ? [{ type: "input_text", text: current.content }]
      : Array.isArray(current.content) ? [...current.content] : [];
    for (const item of attachments) {
      parts.push(item.mimeType === "application/pdf"
        ? { type: "input_file", filename: item.filename, file_data: `data:application/pdf;base64,${item.base64Data}` }
        : { type: "input_image", image_url: `data:${item.mimeType};base64,${item.base64Data}` });
    }
    current.content = parts;
  }
  return next;
}
