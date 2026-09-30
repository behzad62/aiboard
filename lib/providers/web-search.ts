import type { ChatMessage, StructuredOutputFormat } from "./base";
import type { ToolIntent } from "./tool-capabilities";

export const WEB_SEARCH_CAPABILITY_NOTE =
  "Internet search is available when needed. Use it for current, time-sensitive, or source-dependent facts; avoid it for stable general knowledge. If you use search results, cite the sources you relied on.";

export interface WebSearchPolicyInput {
  providerId?: string;
  model?: string;
  structuredOutput?: StructuredOutputFormat;
  allowWebSearch?: boolean;
}

export function webSearchToolIntent(
  input: WebSearchPolicyInput,
): ToolIntent | undefined {
  return input.allowWebSearch === false
    ? undefined
    : { id: "web_search", requirement: "optional" };
}

export function withWebSearchCapabilityNote(
  messages: ChatMessage[]
): ChatMessage[] {
  if (
    messages.some((message) =>
      message.content.includes(WEB_SEARCH_CAPABILITY_NOTE)
    )
  ) {
    return messages;
  }

  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex < 0) {
    return [{ role: "system", content: WEB_SEARCH_CAPABILITY_NOTE }, ...messages];
  }

  return messages.map((message, index) =>
    index === systemIndex
      ? {
          ...message,
          content: `${message.content.trimEnd()}\n\n${WEB_SEARCH_CAPABILITY_NOTE}`,
        }
      : message
  );
}
