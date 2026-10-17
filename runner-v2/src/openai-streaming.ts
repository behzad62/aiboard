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
  for await (const { data } of readProviderSse(fetchImpl, url, init)) {
    if (typeof data.id === "string") id = data.id;
    if (data.usage && typeof data.usage === "object") usage = data.usage as ChatResult["usage"];
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string") {
      content += delta.content;
      onText(delta.content);
    }
    const calls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    for (const call of calls ?? []) {
      const index = typeof call.index === "number" ? call.index : 0;
      const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof call.id === "string") current.id = call.id;
      const fn = call.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string") current.name += fn.name;
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
  for await (const { type, data } of readProviderSse(fetchImpl, url, init)) {
    if ((type === "response.output_text.delta" || data.type === "response.output_text.delta") &&
      typeof data.delta === "string") onText(data.delta);
    if (type === "response.completed" || data.type === "response.completed" ||
      type === "response.incomplete" || data.type === "response.incomplete") {
      if (data.response && typeof data.response === "object") completed = data.response as T;
    }
  }
  if (!completed) throw new Error("Responses stream ended without a completed response");
  return completed;
}
