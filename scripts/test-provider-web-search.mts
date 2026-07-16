/* Provider-native web search request shaping (run: npx tsx scripts/test-provider-web-search.mts) */
import {
  WEB_SEARCH_CAPABILITY_NOTE,
  shouldEnableProviderNativeWebSearch,
  withWebSearchCapabilityNote,
} from "../lib/providers/web-search";
import { openAIResponsesWebSearchField } from "../lib/providers/openai";
import { openAICompatibleWebSearchField } from "../lib/providers/openai-compat";
import { anthropicWebSearchField } from "../lib/providers/anthropic";
import { googleWebSearchTools } from "../lib/providers/google";
import type { StructuredOutputFormat } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const structuredOutput: StructuredOutputFormat = {
  name: "test_schema",
  schema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
};

const searchableModels: Array<{ providerId: string; model: string }> = [
  { providerId: "openai", model: "gpt-5.5" },
  { providerId: "anthropic", model: "claude-opus-4-8" },
  { providerId: "google", model: "gemini-3.5-flash" },
  { providerId: "openrouter", model: "qwen/qwen3.7-max" },
  { providerId: "chatgpt", model: "gpt-5.4" },
  { providerId: "github-copilot", model: "gemini-3.5-flash" },
];

for (const { providerId, model } of searchableModels) {
  check(
    `${providerId}:${model} discussion calls enable provider-native web search`,
    shouldEnableProviderNativeWebSearch({
      providerId,
      model,
    }),
    { providerId, model }
  );
}

const nonSearchableModels: Array<{ providerId: string; model: string }> = [
  { providerId: "custom", model: "model" },
  { providerId: "foundry", model: "claude-opus-4-8" },
  { providerId: "openai", model: "gpt-5.3-codex" },
  { providerId: "chatgpt", model: "gpt-5.3-codex-spark" },
  { providerId: "openrouter", model: "nex-agi/nex-n2-pro:free" },
];

for (const { providerId, model } of nonSearchableModels) {
  check(
    `${providerId}:${model} does not claim provider-native web search`,
    !shouldEnableProviderNativeWebSearch({ providerId, model }),
    { providerId, model }
  );
}

check(
  "structured-output calls keep provider-native web search disabled",
  !shouldEnableProviderNativeWebSearch({
    providerId: "google",
    model: "gemini-3.5-flash",
    structuredOutput,
  }),
  structuredOutput
);

const notedMessages = withWebSearchCapabilityNote([
  { role: "system", content: "You are debating a topic." },
  { role: "user", content: "What should we discuss?" },
]);
check(
  "capability note is added to the system prompt",
  notedMessages[0].role === "system" &&
    notedMessages[0].content.includes(WEB_SEARCH_CAPABILITY_NOTE) &&
    notedMessages.length === 2,
  notedMessages
);

const notedWithoutSystem = withWebSearchCapabilityNote([
  { role: "user", content: "What changed this week?" },
]);
check(
  "capability note creates a system prompt when none exists",
  notedWithoutSystem[0].role === "system" &&
    notedWithoutSystem[0].content.includes(WEB_SEARCH_CAPABILITY_NOTE) &&
    notedWithoutSystem[1].role === "user",
  notedWithoutSystem
);

const doubleNoted = withWebSearchCapabilityNote(notedMessages);
check(
  "capability note is not duplicated",
  doubleNoted[0].content.indexOf(WEB_SEARCH_CAPABILITY_NOTE) ===
    doubleNoted[0].content.lastIndexOf(WEB_SEARCH_CAPABILITY_NOTE),
  doubleNoted
);

check(
  "OpenAI Chat Completions web search field uses auto search options",
  JSON.stringify(openAICompatibleWebSearchField("openai", true)) ===
    JSON.stringify({ web_search_options: { search_context_size: "medium" } }),
  openAICompatibleWebSearchField("openai", true)
);

check(
  "OpenRouter web search field uses server tool",
  JSON.stringify(openAICompatibleWebSearchField("openrouter", true)) ===
    JSON.stringify({
      tools: [
        {
          type: "openrouter:web_search",
          parameters: { search_context_size: "medium" },
        },
      ],
    }),
  openAICompatibleWebSearchField("openrouter", true)
);

check(
  "OpenAI Responses web search field uses auto tool choice",
  JSON.stringify(openAIResponsesWebSearchField(true)) ===
    JSON.stringify({
      tools: [{ type: "web_search_preview" }],
      tool_choice: "auto",
    }),
  openAIResponsesWebSearchField(true)
);

check(
  "Anthropic web search field uses documented server tool",
  JSON.stringify(anthropicWebSearchField(true)) ===
    JSON.stringify({
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      tool_choice: { type: "auto" },
    }),
  anthropicWebSearchField(true)
);

check(
  "current Gemini models use googleSearch grounding",
  JSON.stringify(googleWebSearchTools("gemini-3.5-flash", true)) ===
    JSON.stringify([{ googleSearch: {} }]),
  googleWebSearchTools("gemini-3.5-flash", true)
);

check(
  "Gemini 2.5 models use current googleSearch grounding",
  JSON.stringify(googleWebSearchTools("gemini-2.5-flash", true)) ===
    JSON.stringify([{ googleSearch: {} }]),
  googleWebSearchTools("gemini-2.5-flash", true)
);

check(
  "older Gemini 2.0 models use googleSearchRetrieval grounding",
  JSON.stringify(googleWebSearchTools("gemini-2.0-flash", true)) ===
    JSON.stringify([{ googleSearchRetrieval: {} }]),
  googleWebSearchTools("gemini-2.0-flash", true)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
