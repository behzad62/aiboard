import type { AgentMediaAttachment, ToolVisualInput } from "./agent-contracts.js";
import { toolVisualCaption } from "./tool-visual-input.js";

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

/**
 * Tool-result images for chat-style transports whose tool messages cannot carry images: one user
 * message placed right after the contiguous tool-output group that contains the producing calls.
 */
export function withToolVisualMessages(
  messages: WireMessage[],
  visuals: readonly ToolVisualInput[] | undefined,
  format: "openai-chat" | "openai-responses",
): WireMessage[] {
  if (!visuals?.length) return messages;
  const calls = new Set(visuals.map((visual) => visual.callId));
  const isOutput = (message: WireMessage) => format === "openai-chat"
    ? message.role === "tool"
    : typeof message.type === "string" && message.type.endsWith("_output");
  const callOf = (message: WireMessage) => format === "openai-chat" ? message.tool_call_id : message.call_id;
  let last = -1;
  messages.forEach((message, index) => { if (isOutput(message) && calls.has(callOf(message) as string)) last = index; });
  if (last < 0) return messages;
  while (last + 1 < messages.length && isOutput(messages[last + 1]!)) last += 1;
  const caption = toolVisualCaption(visuals);
  const content = format === "openai-chat"
    ? [{ type: "text", text: caption }, ...visuals.map((visual) => ({ type: "image_url", image_url: { url: "data:" + visual.mimeType + ";base64," + visual.base64Data } }))]
    : [{ type: "input_text", text: caption }, ...visuals.map((visual) => ({ type: "input_image", image_url: "data:" + visual.mimeType + ";base64," + visual.base64Data }))];
  return [...messages.slice(0, last + 1), { role: "user", content }, ...messages.slice(last + 1)];
}

/** Anthropic tool_result content: the text result followed by native image blocks. */
export function anthropicToolResultContent(text: string, visuals: readonly ToolVisualInput[]): string | unknown[] {
  if (!visuals.length) return text;
  return [{ type: "text", text }, ...visuals.map((visual) => ({ type: "image", source: { type: "base64", media_type: visual.mimeType, data: visual.base64Data } }))];
}

/** Gemini: inline image parts beside the functionResponse part of the same tool turn. */
export function geminiToolVisualParts(visuals: readonly ToolVisualInput[]): unknown[] {
  return visuals.map((visual) => ({ inlineData: { mimeType: visual.mimeType, data: visual.base64Data } }));
}
