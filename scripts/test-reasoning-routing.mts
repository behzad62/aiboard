/** Provider reasoning-effort routing checks (run: npx tsx scripts/test-reasoning-routing.mts) */
import type { ReasoningEffort } from "../lib/db/schema";
import { formatModelId, parseModelId } from "../lib/providers/base";
import { MODEL_CATALOG } from "../lib/providers/catalog";
import { providerSupportsReasoningEffortFeature } from "../lib/providers/provider-registry";
import {
  anthropicReasoningFields,
  geminiThinkingConfig,
  openAIReasoningEffort,
  openRouterReasoningEffort,
} from "../lib/providers/reasoning";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const efforts: ReasoningEffort[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "max",
];

function json(value: unknown): string {
  return JSON.stringify(value);
}

const expectedOpenAI: Record<ReasoningEffort, string | null> = {
  default: null,
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};
for (const effort of efforts) {
  check(
    `OpenAI maps ${effort} reasoning`,
    openAIReasoningEffort(effort) === expectedOpenAI[effort],
    openAIReasoningEffort(effort)
  );
}

const expectedOpenRouter: Record<ReasoningEffort, string | null> = {
  default: null,
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};
for (const effort of efforts) {
  check(
    `OpenRouter maps ${effort} reasoning`,
    openRouterReasoningEffort(effort) === expectedOpenRouter[effort],
    openRouterReasoningEffort(effort)
  );
}

check(
  "Claude off omits adaptive thinking and effort",
  json(anthropicReasoningFields("claude-opus-4-8", "none")) === "{}",
  anthropicReasoningFields("claude-opus-4-8", "none")
);
check(
  "Claude low sends adaptive thinking plus output_config effort",
  json(anthropicReasoningFields("claude-opus-4-8", "low")) ===
    json({ thinking: { type: "adaptive" }, output_config: { effort: "low" } }),
  anthropicReasoningFields("claude-opus-4-8", "low")
);
check(
  "Claude max sends highest supported Anthropic effort",
  json(anthropicReasoningFields("claude-opus-4-8", "max")) ===
    json({ thinking: { type: "adaptive" }, output_config: { effort: "max" } }),
  anthropicReasoningFields("claude-opus-4-8", "max")
);
check(
  "Claude Opus 4.5 medium sends effort without unsupported adaptive thinking",
  json(anthropicReasoningFields("claude-opus-4-5", "medium")) ===
    json({ output_config: { effort: "medium" } }),
  anthropicReasoningFields("claude-opus-4-5", "medium")
);
check(
  "Claude Opus 4.5 max falls back to its highest supported effort",
  json(anthropicReasoningFields("claude-opus-4-5", "max")) ===
    json({ output_config: { effort: "high" } }),
  anthropicReasoningFields("claude-opus-4-5", "max")
);
const foundryOpus45Model = parseModelId("foundry:claude-opus-4-5").model;
check(
  "Azure Foundry Opus 4.5 medium uses the Anthropic-compatible Opus 4.5 payload",
  json(anthropicReasoningFields(foundryOpus45Model, "medium")) ===
    json({ output_config: { effort: "medium" } }),
  anthropicReasoningFields(foundryOpus45Model, "medium")
);
check(
  "Claude Fable off maps to its lowest supported adaptive thinking effort",
  json(anthropicReasoningFields("claude-fable-5", "none")) ===
    json({ thinking: { type: "adaptive" }, output_config: { effort: "low" } }),
  anthropicReasoningFields("claude-fable-5", "none")
);
check(
  "Claude Haiku effort is omitted because the model rejects output_config effort",
  json(anthropicReasoningFields("claude-haiku-4-5-20251001", "high")) === "{}",
  anthropicReasoningFields("claude-haiku-4-5-20251001", "high")
);

check(
  "Gemini 3 off maps to minimal thinking",
  json(geminiThinkingConfig("gemini-3.5-flash", "none", 4096)) ===
    json({ thinkingLevel: "minimal" }),
  geminiThinkingConfig("gemini-3.5-flash", "none", 4096)
);
check(
  "Gemini 3 Pro off maps to its lowest supported thinking level",
  json(geminiThinkingConfig("gemini-3.1-pro-preview", "none", 4096)) ===
    json({ thinkingLevel: "low" }),
  geminiThinkingConfig("gemini-3.1-pro-preview", "none", 4096)
);
check(
  "Gemini 3 Pro medium maps to a supported thinking level",
  json(geminiThinkingConfig("gemini-3.1-pro-preview", "medium", 4096)) ===
    json({ thinkingLevel: "high" }),
  geminiThinkingConfig("gemini-3.1-pro-preview", "medium", 4096)
);
check(
  "Gemini 3 max maps to high thinking",
  json(geminiThinkingConfig("gemini-3.5-flash", "max", 4096)) ===
    json({ thinkingLevel: "high" }),
  geminiThinkingConfig("gemini-3.5-flash", "max", 4096)
);
check(
  "Gemini 2.5 off maps to zero thinking budget",
  json(geminiThinkingConfig("gemini-2.5-flash", "none", 4096)) ===
    json({ thinkingBudget: 0 }),
  geminiThinkingConfig("gemini-2.5-flash", "none", 4096)
);
check(
  "Gemini 2.5 max maps to dynamic thinking budget",
  json(geminiThinkingConfig("gemini-2.5-flash", "max", 4096)) ===
    json({ thinkingBudget: -1 }),
  geminiThinkingConfig("gemini-2.5-flash", "max", 4096)
);

for (const model of MODEL_CATALOG) {
  const fullModelId = formatModelId(model.providerId, model.id);
  const supportsReasoning = providerSupportsReasoningEffortFeature(
    model.providerId,
    model.id
  );

  if (model.providerId === "anthropic" && model.id === "claude-haiku-4-5-20251001") {
    check(
      `${fullModelId} is not advertised as reasoning-controllable`,
      !supportsReasoning,
      { supportsReasoning }
    );
    continue;
  }

  if (model.providerId === "github-copilot" && !/^gpt-\d+|auto$/i.test(model.id)) {
    check(
      `${fullModelId} is not advertised as reasoning-controllable`,
      !supportsReasoning,
      { supportsReasoning }
    );
    continue;
  }

  if (!supportsReasoning) continue;

  for (const effort of efforts) {
    if (model.providerId === "openai" || model.providerId === "chatgpt") {
      check(
        `${fullModelId} routes ${effort} through OpenAI-compatible reasoning`,
        openAIReasoningEffort(effort) === expectedOpenAI[effort],
        openAIReasoningEffort(effort)
      );
    } else if (model.providerId === "github-copilot") {
      check(
        `${fullModelId} routes ${effort} through Copilot GPT responses reasoning`,
        openAIReasoningEffort(effort) === expectedOpenAI[effort],
        openAIReasoningEffort(effort)
      );
    } else if (model.providerId === "openrouter") {
      check(
        `${fullModelId} routes ${effort} through OpenRouter reasoning`,
        openRouterReasoningEffort(effort) === expectedOpenRouter[effort],
        openRouterReasoningEffort(effort)
      );
    } else if (model.providerId === "anthropic") {
      const expected =
        effort === "default"
          ? {}
          : effort === "none" && model.id === "claude-fable-5"
            ? { thinking: { type: "adaptive" }, output_config: { effort: "low" } }
            : effort === "none"
              ? {}
          : { thinking: { type: "adaptive" }, output_config: { effort } };
      check(
        `${fullModelId} routes ${effort} through Anthropic adaptive thinking`,
        json(anthropicReasoningFields(model.id, effort)) === json(expected),
        anthropicReasoningFields(model.id, effort)
      );
    } else if (model.providerId === "google") {
      const config = geminiThinkingConfig(model.id, effort, 4096);
      check(
        `${fullModelId} routes ${effort} through Gemini thinkingConfig`,
        effort === "default" ? true : config !== null,
        config
      );
    }
  }
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
