/**
 * What each provider's own documentation asks of a client, as data. A provider that changes its
 * protocol gets a new or edited entry here (with the page and the date it was read), not a code
 * change in every model adapter.
 */
export interface ProviderProtocolProfile {
  /**
   * Send each assistant turn's reasoning back as `reasoning_content` on Chat Completions. DeepSeek
   * requires it in thinking mode whenever tools are present; without it the model loses its own
   * reasoning between tool calls.
   */
  readonly chatReasoningContent?: boolean;
  /**
   * The context window the provider documents for its current models, used when the app sent none
   * (an older app, or a run started before the app knew it). Unknown windows fell back to a 512 KB
   * working set and compacted a 1M-token model's sessions every ~140k tokens (tunnel run).
   */
  readonly contextWindowTokens?: number;
  readonly docsUrl: string;
  readonly verifiedAt: string;
}

export const PROVIDER_PROTOCOL_PROFILES: Readonly<Record<string, ProviderProtocolProfile>> = Object.freeze({
  deepseek: Object.freeze({
    chatReasoningContent: true,
    // deepseek-flash and deepseek-v4-pro (api-docs.deepseek.com/quick_start/pricing).
    contextWindowTokens: 1_048_576,
    docsUrl: "https://api-docs.deepseek.com/guides/thinking_mode/",
    verifiedAt: "2026-10-20",
  }),
});

export function providerProtocolProfile(providerId: string | undefined): ProviderProtocolProfile | undefined {
  return providerId ? PROVIDER_PROTOCOL_PROFILES[providerId] : undefined;
}
