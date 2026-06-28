import type { ChatMessage, StructuredOutputFormat } from "./base";

export const WEB_SEARCH_CAPABILITY_NOTE =
  "Internet search is available when needed. Use it for current, time-sensitive, or source-dependent facts; avoid it for stable general knowledge. If you use search results, cite the sources you relied on.";

const PROVIDER_NATIVE_WEB_SEARCH_IDS = new Set([
  "openai",
  "anthropic",
  "google",
  "openrouter",
]);

export function providerSupportsNativeWebSearch(providerId: string): boolean {
  return PROVIDER_NATIVE_WEB_SEARCH_IDS.has(providerId);
}

export function shouldEnableProviderNativeWebSearch(input: {
  providerId: string;
  model?: string;
  structuredOutput?: StructuredOutputFormat;
  allowWebSearch?: boolean;
}): boolean {
  if (input.allowWebSearch === false || input.structuredOutput) {
    return false;
  }
  return providerSupportsNativeWebSearch(input.providerId);
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
