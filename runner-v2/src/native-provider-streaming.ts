import { readProviderSse } from "./provider-sse.js";

export interface AnthropicStreamResult {
  id?: string;
  stop_reason?: string;
  content: Array<{ type: "text"; text: string } |
    { type: "tool_use"; id: string; name: string; input: unknown }>;
  usage?: { input_tokens?: number; cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number; output_tokens?: number };
}

export async function collectAnthropicStream(
  fetchImpl: typeof fetch, url: string, init: RequestInit, onText: (text: string) => void
): Promise<AnthropicStreamResult> {
  const blocks = new Map<number, { type: "text"; text: string } |
    { type: "tool_use"; id: string; name: string; json: string }>();
  const result: AnthropicStreamResult = { content: [] };
  for await (const { type, data } of readProviderSse(fetchImpl, url, init)) {
    if (type === "message_start") {
      const message = data.message as Record<string, unknown> | undefined;
      if (typeof message?.id === "string") result.id = message.id;
      if (message?.usage) result.usage = message.usage as AnthropicStreamResult["usage"];
    } else if (type === "content_block_start") {
      const index = typeof data.index === "number" ? data.index : blocks.size;
      const value = data.content_block as Record<string, unknown> | undefined;
      if (value?.type === "text") blocks.set(index, { type: "text", text: String(value.text ?? "") });
      else if (value?.type === "tool_use") blocks.set(index, {
        type: "tool_use", id: String(value.id ?? ""), name: String(value.name ?? ""), json: "",
      });
    } else if (type === "content_block_delta") {
      const index = data.index as number;
      const block = blocks.get(index);
      const delta = data.delta as Record<string, unknown> | undefined;
      if (block?.type === "text" && delta?.type === "text_delta" && typeof delta.text === "string") {
        block.text += delta.text;
        onText(delta.text);
      } else if (block?.type === "tool_use" && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.json += delta.partial_json;
      }
    } else if (type === "message_delta") {
      const delta = data.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === "string") result.stop_reason = delta.stop_reason;
      const usage = data.usage as { output_tokens?: number } | undefined;
      if (usage) result.usage = { ...result.usage, ...usage };
    }
  }
  result.content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => {
    if (block.type === "text") return block;
    let input: unknown = {};
    try { input = JSON.parse(block.json || "{}"); } catch { input = {}; }
    return { type: "tool_use" as const, id: block.id, name: block.name, input };
  });
  return result;
}

export interface GoogleStreamResult {
  responseId?: string;
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<
    { text?: string } | { functionCall?: { id?: string; name?: string; args?: unknown }; thoughtSignature?: string }
  > } }>;
  usageMetadata?: {
    promptTokenCount?: number; candidatesTokenCount?: number;
    thoughtsTokenCount?: number; cachedContentTokenCount?: number;
    totalTokenCount?: number; toolUsePromptTokenCount?: number;
  };
}
export async function collectGoogleStream(
  fetchImpl: typeof fetch, url: string, init: RequestInit, onText: (text: string) => void
): Promise<GoogleStreamResult> {
  const parts: NonNullable<NonNullable<NonNullable<GoogleStreamResult["candidates"]>[0]["content"]>["parts"]> = [];
  let last: GoogleStreamResult = {};
  for await (const { data } of readProviderSse(fetchImpl, url, init)) {
    const event = data as GoogleStreamResult;
    const candidate = event.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if ("text" in part && typeof part.text === "string" &&
          !("thought" in part && part.thought === true)) {
        parts.push({ text: part.text });
        onText(part.text);
      } else if ("functionCall" in part && part.functionCall) parts.push(part);
    }
    last = { ...last, ...event, usageMetadata: { ...last.usageMetadata, ...event.usageMetadata } };
  }
  return { ...last, candidates: [{ ...last.candidates?.[0], content: { parts } }] };
}
