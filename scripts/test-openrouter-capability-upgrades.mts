import assert from "node:assert/strict";

import type {
  HostedToolDefinition,
  NativeToolDefinition,
  NativeToolChoice,
  StreamChunk,
} from "../lib/providers/base";
import {
  buildOpenAIUserContent,
  openAICompatibleNativeToolField,
} from "../lib/providers/openai-compat";
import {
  openAIResponsesNativeToolField,
  openRouterHostedToolField,
} from "../lib/providers/openai";
import { openrouterProvider } from "../lib/providers/openrouter";
import { buildOpenRouterCatalogModel } from "../lib/client/settings-api";
import { providerSupportsNativeBuildToolsFeature } from "../lib/providers/provider-registry";

const discovered = buildOpenRouterCatalogModel({
  id: "xiaomi/mimo-v2.6-pro",
  name: "MiMo-V2.6-Pro",
  supported_parameters: [
    "max_tokens",
    "reasoning",
    "response_format",
    "structured_outputs",
    "temperature",
    "tool_choice",
    "tools",
  ],
  architecture: { input_modalities: ["text", "image", "audio", "video"] },
});
assert.equal(discovered.supportsTools, true);
assert.equal(discovered.supportsToolChoice, true);
assert.equal(discovered.supportsStructuredOutputs, true);
assert.equal(discovered.supportsTemperature, true);
assert.equal(discovered.supportsMaxTokens, true);
assert.equal(discovered.supportsAudioInput, true);
assert.equal(discovered.supportsVideoInput, true);

assert.equal(
  providerSupportsNativeBuildToolsFeature("openrouter", "brand-new/model", true),
  true,
  "live-discovered tool support should override the static fallback"
);
assert.equal(
  providerSupportsNativeBuildToolsFeature("openrouter", "qwen/qwen3.7-max", false),
  false,
  "live-discovered lack of tool support should override the static fallback"
);

const attachments = [
  {
    id: "audio",
    filename: "clip.wav",
    mimeType: "audio/wav",
    category: "audio" as const,
    base64Data: "UklGRg==",
  },
  {
    id: "video",
    filename: "clip.mp4",
    mimeType: "video/mp4",
    category: "video" as const,
    base64Data: "AAAAIGZ0eXA=",
  },
];
const content = buildOpenAIUserContent("Analyze both files.", attachments, {
  image: false,
  document: false,
  audio: true,
  video: true,
}) as Array<Record<string, unknown>>;
assert.deepEqual(content[1], {
  type: "input_audio",
  input_audio: { data: "UklGRg==", format: "wav" },
});
assert.deepEqual(content[2], {
  type: "video_url",
  video_url: { url: "data:video/mp4;base64,AAAAIGZ0eXA=" },
});

const readTool: NativeToolDefinition = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  strict: true,
  deferLoading: false,
};
const forcedChoice: NativeToolChoice = { type: "function", name: "read" };
const chatTools = openAICompatibleNativeToolField(
  "openrouter",
  [readTool],
  forcedChoice
) as {
  tool_choice?: unknown;
  tools?: Array<{ function?: { strict?: boolean } }>;
};
assert.deepEqual(chatTools.tool_choice, {
  type: "function",
  function: { name: "read" },
});
assert.equal(chatTools.tools?.[0]?.function?.strict, true);

const responseTools = openAIResponsesNativeToolField([readTool], {
  providerId: "openrouter",
  toolChoice: "required",
}) as {
  tool_choice?: unknown;
  tools?: Array<Record<string, unknown>>;
};
assert.equal(responseTools.tool_choice, "required");
assert.equal(responseTools.tools?.[0]?.strict, true);

const manyTools: NativeToolDefinition[] = Array.from({ length: 18 }, (_, index) => ({
  name: index === 0 ? "read" : `tool_${index}`,
  description: `Tool ${index}`,
  parameters: { type: "object", properties: {} },
  ...(index === 0 ? { deferLoading: false } : {}),
}));
const searched = openAIResponsesNativeToolField(manyTools, {
  providerId: "openrouter",
  toolChoice: "auto",
}) as { tools?: Array<Record<string, unknown>> };
assert.equal(
  searched.tools?.some((tool) => tool.type === "openrouter:tool_search"),
  true,
  "large OpenRouter tool catalogs should enable Tool Search"
);
const eagerRead = searched.tools?.find((tool) => tool.name === "read");
const deferred = searched.tools?.find((tool) => tool.name === "tool_1");
assert.equal(eagerRead?.defer_loading, undefined);
assert.equal(deferred?.defer_loading, true);

const hosted: HostedToolDefinition[] = [
  { type: "web_fetch" },
  { type: "shell", parameters: { engine: "openrouter" } },
  { type: "apply_patch" },
  { type: "datetime" },
  { type: "image_generation" },
  { type: "advisor", parameters: { model: "~anthropic/claude-opus-latest" } },
  { type: "subagent" },
  { type: "fusion" },
];
assert.deepEqual(openRouterHostedToolField(hosted), {
  tools: hosted.map((tool) => ({
    type: `openrouter:${tool.type}`,
    ...(tool.parameters ? { parameters: tool.parameters } : {}),
  })),
});

function sseResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const originalFetch = globalThis.fetch;
try {
  const urls: string[] = [];
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return sseResponse([
      { choices: [{ delta: { content: "Multimodal chat worked." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  };
  const chunks = await collect(openrouterProvider.streamChat({
    apiKey: "test-key",
    model: "xiaomi/mimo-v2.6-pro",
    messages: [{ role: "user", content: "Analyze the media." }],
    attachments,
    capabilities: { image: true, document: false, audio: true, video: true },
    disableAutomaticRetries: true,
  }));
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/chat/completions"]);
  const messages = requestBody?.messages as Array<{ content?: unknown }> | undefined;
  const parts = messages?.[0]?.content as Array<Record<string, unknown>> | undefined;
  assert.equal(parts?.some((part) => part.type === "input_audio"), true);
  assert.equal(parts?.some((part) => part.type === "video_url"), true);
  assert.equal(chunks.some((chunk) => chunk.type === "token"), true);

  urls.length = 0;
  requestBody = undefined;
  await collect(openrouterProvider.streamChat({
    apiKey: "test-key",
    model: "xiaomi/mimo-v2.6-pro",
    messages: [{ role: "user", content: "Search while analyzing audio." }],
    attachments: [attachments[0]],
    capabilities: { image: false, document: false, audio: true, video: false },
    webSearch: true,
    hostedBuildTools: true,
    disableAutomaticRetries: true,
  }));
  const combinedTools = requestBody?.tools as Array<{ type?: string }> | undefined;
  assert.equal(
    combinedTools?.filter((tool) => tool.type === "openrouter:web_search").length,
    1,
    "web search must not be duplicated when both discussion search and hosted Build tools enable it"
  );

  urls.length = 0;
  requestBody = undefined;
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (String(input).endsWith("/responses")) {
      return sseResponse([
        {
          type: "response.completed",
          response: {
            id: "resp_dedupe",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
        "[DONE]",
      ]);
    }
    return sseResponse([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  };
  await collect(openrouterProvider.streamChat({
    apiKey: "test-key",
    model: "xiaomi/mimo-v2.6-pro",
    messages: [{ role: "user", content: "Search the web." }],
    capabilities: { image: false, document: false, audio: false, video: false },
    webSearch: true,
    hostedBuildTools: true,
    disableAutomaticRetries: true,
  }));
  const responseCombinedTools = requestBody?.tools as Array<{ type?: string }> | undefined;
  assert.equal(
    responseCombinedTools?.filter((tool) => tool.type === "openrouter:web_search").length,
    1,
    "Responses web search must not be duplicated when hosted Build tools also enable it"
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log("PASS OpenRouter capability upgrades");
