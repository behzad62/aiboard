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
  /**
   * The provider's documented maximum output, sent as reasoning headroom (never a length control).
   * DeepSeek's Responses default cut the Architect's thinking at 16,384 tokens twice in a row, each
   * time re-sending a 282k-token context (tunnel run).
   */
  readonly maxOutputTokens?: number;
  /** The protocol whose tools the provider documents for agents; the runner prefers it over the app default. */
  readonly preferredProtocol?: "responses";
  readonly responses?: {
    /** Send reasoning back as Responses `reasoning` items with plain `reasoning_text` content. */
    readonly reasoningItems?: boolean;
    /**
     * Provider-native client tools, declared exactly as documented. A native tool replaces the
     * generic tools it covers, so the model never sees two edit tools; it is offered only to a session
     * that can edit (it sees `fs.patch`).
     */
    readonly nativeTools?: ReadonlyArray<{ readonly wire: Readonly<Record<string, unknown>>; readonly replaces: readonly string[] }>;
  };
  readonly docsUrl: string;
  readonly verifiedAt: string;
}

const CODEX_APPLY_PATCH_DESCRIPTION = [
  "Edit files with a patch. This is a freeform tool: send the patch text itself, not JSON.",
  "*** Begin Patch",
  "*** Add File: path/to/new.ts",
  "+first line of the new file",
  "*** Update File: path/to/existing.ts",
  "@@ a line near the change",
  " unchanged context line",
  "-removed line",
  "+added line",
  "*** Delete File: path/to/old.ts",
  "*** End Patch",
  "Paths are relative to the workspace. Give about three lines of unchanged context around each change.",
].join("\n");

export const PROVIDER_PROTOCOL_PROFILES: Readonly<Record<string, ProviderProtocolProfile>> = Object.freeze({
  deepseek: Object.freeze({
    chatReasoningContent: true,
    // deepseek-flash and deepseek-v4-pro (api-docs.deepseek.com/quick_start/pricing).
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 393_216,
    // Responses accepts exactly one custom tool, apply_patch, "for Codex compatibility"
    // (api-docs.deepseek.com/guides/responses_api).
    preferredProtocol: "responses",
    responses: Object.freeze({
      reasoningItems: true,
      nativeTools: Object.freeze([Object.freeze({
        wire: Object.freeze({ type: "custom", name: "apply_patch", description: CODEX_APPLY_PATCH_DESCRIPTION }),
        replaces: Object.freeze(["fs.patch", "fs.write"]),
      })]),
    }),
    docsUrl: "https://api-docs.deepseek.com/guides/thinking_mode/",
    verifiedAt: "2026-10-20",
  }),
  // apply_patch on Responses (also Chat Completions and Assistants), listed for GPT-5.1 to 5.5. It
  // returns apply_patch_call { operation: create_file | update_file (V4A diff) | delete_file } and
  // takes apply_patch_call_output { status: completed | failed, output }.
  openai: Object.freeze({
    preferredProtocol: "responses",
    responses: Object.freeze({
      nativeTools: Object.freeze([Object.freeze({
        wire: Object.freeze({ type: "apply_patch" }),
        replaces: Object.freeze(["fs.patch", "fs.write"]),
      })]),
    }),
    docsUrl: "https://developers.openai.com/api/docs/guides/tools-apply-patch",
    verifiedAt: "2026-10-20",
  }),
  // openrouter:apply_patch (beta, Responses only): OpenRouter validates the V4A patch and the client
  // applies it, with the same apply_patch_call / apply_patch_call_output items as OpenAI. Its
  // openrouter:shell runs in OpenRouter's sandbox, outside the project, so it is not offered.
  openrouter: Object.freeze({
    preferredProtocol: "responses",
    responses: Object.freeze({
      nativeTools: Object.freeze([Object.freeze({
        wire: Object.freeze({ type: "openrouter:apply_patch" }),
        replaces: Object.freeze(["fs.patch", "fs.write"]),
      })]),
    }),
    docsUrl: "https://openrouter.ai/docs/guides/features/server-tools/apply-patch",
    verifiedAt: "2026-10-20",
  }),
});

export function providerProtocolProfile(providerId: string | undefined): ProviderProtocolProfile | undefined {
  return providerId ? PROVIDER_PROTOCOL_PROFILES[providerId] : undefined;
}
