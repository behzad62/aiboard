/* OpenRouter catalog model normalization checks (run: npx tsx scripts/test-openrouter-catalog-models.mts) */
import { buildOpenRouterCatalogModel } from "../lib/client/settings-api";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const gemini = buildOpenRouterCatalogModel({
  id: "google/gemini-3.1-pro-preview",
  name: "Gemini 3.1 Pro Preview",
  description: "Gemini via OpenRouter",
  supported_parameters: [
    "include_reasoning",
    "max_tokens",
    "reasoning",
    "reasoning_effort",
    "response_format",
    "structured_outputs",
    "temperature",
    "tool_choice",
    "tools",
  ],
  architecture: {
    input_modalities: ["text", "image", "file", "audio", "video"],
  },
});

check(
  "Gemini catalog model exposes multimodal and tool flags",
  gemini.supportsImageInput &&
    gemini.supportsDocumentInput &&
    gemini.supportsAudioInput &&
    gemini.supportsVideoInput &&
    gemini.supportsTools &&
    gemini.supportsStructuredOutputs &&
    gemini.supportsReasoning &&
    gemini.supportsReasoningEffort,
  gemini
);

const minimax = buildOpenRouterCatalogModel({
  id: "minimax/minimax-m3",
  name: "MiniMax M3",
  description: "MiniMax via OpenRouter",
  supported_parameters: [
    "max_tokens",
    "reasoning",
    "response_format",
    "structured_outputs",
    "temperature",
    "tool_choice",
    "tools",
    "top_k",
  ],
  architecture: {
    input_modalities: ["text", "image", "video"],
  },
});

check(
  "MiniMax catalog model distinguishes reasoning from reasoning-effort",
  minimax.supportsImageInput &&
    !minimax.supportsDocumentInput &&
    !minimax.supportsAudioInput &&
    minimax.supportsVideoInput &&
    minimax.supportsTools &&
    minimax.supportsStructuredOutputs &&
    minimax.supportsReasoning &&
    !minimax.supportsReasoningEffort,
  minimax
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);