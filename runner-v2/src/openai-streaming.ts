import { readProviderSse } from "./provider-sse.js";

interface ChatResult {
  id?: string;
  choices: Array<{ message: {
    content: string; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
  }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}
export async function streamOpenAIChat(
  fetchImpl: typeof fetch, url: string, init: RequestInit, onText: (delta: string) => void
): Promise<ChatResult> {
  let id: string | undefined;
  let content = "";
  let finishReason: string | undefined;
  let usage: ChatResult["usage"];
  const tools = new Map<number, { id: string; name: string; arguments: string }>();
  // Live display only: reasoning models (DeepSeek, OpenRouter) stream their thinking separately from
  // content and many turns are tool calls with no content, so the feed showed nothing but
  // "Generating..." until the call ended. The returned turn is built from content/tool_calls only.
  const live = liveProgress(onText);
  for await (const { data } of readProviderSse(fetchImpl, url, init)) {
    if (typeof data.id === "string") id = data.id;
    if (data.usage && typeof data.usage === "object") usage = data.usage as ChatResult["usage"];
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content
      : typeof delta?.reasoning === "string" ? delta.reasoning : undefined;
    if (reasoning) live.reasoning(reasoning);
    if (typeof delta?.content === "string") {
      content += delta.content;
      live.text(delta.content);
    }
    const calls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    for (const call of calls ?? []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof call.id === "string") current.id = call.id;
      const fn = call.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string") {
        if (!current.name) live.toolCall(fn.name);
        current.name += fn.name;
      }
      if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
      tools.set(index, current);
    }
  }
  return {
    ...(id ? { id } : {}),
    choices: [{
      message: {
        content, tool_calls: [...tools.entries()].sort((a, b) => a[0] - b[0])
          .map(([index, call]) => ({ id: call.id || `tool_${index + 1}`, function: { name: call.name, arguments: call.arguments } })),
      },
      ...(finishReason ? { finish_reason: finishReason } : {}),
    }],
    ...(usage ? { usage } : {}),
  };
}

export async function streamOpenAIResponses<T extends { output?: unknown[] }>(
  fetchImpl: typeof fetch, url: string, init: RequestInit, onText: (delta: string) => void
): Promise<T> {
  let completed: T | undefined;
  const live = liveProgress(onText);
  for await (const { type, data } of readProviderSse(fetchImpl, url, init)) {
    const kind = typeof data.type === "string" ? data.type : type;
    if (kind === "response.output_text.delta" && typeof data.delta === "string") live.text(data.delta);
    if ((kind === "response.reasoning_summary_text.delta" || kind === "response.reasoning_text.delta") &&
      typeof data.delta === "string") live.reasoning(data.delta);
    if (kind === "response.output_item.added") {
      const item = data.item as { type?: unknown; name?: unknown } | undefined;
      if (item?.type === "function_call" && typeof item.name === "string") live.toolCall(item.name);
    }
    if (type === "response.completed" || data.type === "response.completed" ||
      type === "response.incomplete" || data.type === "response.incomplete") {
      if (data.response && typeof data.response === "object") completed = data.response as T;
    }
  }
  if (!completed) throw new Error("Responses stream ended without a completed response");
  return completed;
}

/** Formats live progress (reasoning, answer text, tool-call starts) for the transient output feed. */
function liveProgress(onText: (delta: string) => void) {
  let mode: "none" | "reasoning" | "text" = "none";
  const enter = (next: "reasoning" | "text", heading: string) => {
    if (mode === next) return;
    onText(mode === "none" ? heading : `\n\n${heading}`);
    mode = next;
  };
  return {
    reasoning(delta: string) { enter("reasoning", "Thinking: "); onText(delta); },
    text(delta: string) { if (mode === "reasoning") enter("text", ""); else mode = "text"; onText(delta); },
    toolCall(name: string) { onText(`${mode === "none" ? "" : "\n"}-> calling ${name}\n`); mode = "none"; },
  };
}
