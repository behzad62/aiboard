/* Provider-native Build tool calls (run: npx tsx scripts/test-provider-native-tools.mts) */
import {
  buildNativeBuildToolDefinitions,
  nativeToolCallsToActionText,
} from "../lib/orchestrator/build";
import {
  openAIResponsesHostedBuildToolsField,
  openAIResponsesNativeToolField,
} from "../lib/providers/openai";
import { openAICompatibleNativeToolField } from "../lib/providers/openai-compat";
import { anthropicNativeToolField } from "../lib/providers/anthropic";
import {
  googleHostedBuildToolConfig,
  googleNativeToolConfig,
} from "../lib/providers/google";
import type { NativeToolCall } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const architectPlanTools = buildNativeBuildToolDefinitions("architect_plan");
const architectReviewTools = buildNativeBuildToolDefinitions("architect_review");
const workerTools = buildNativeBuildToolDefinitions("worker");

function names(tools: Array<{ name: string }>): string[] {
  return tools.map((tool) => tool.name);
}

check(
  "architect plan native tools include plan and inspection actions",
  names(architectPlanTools).includes("plan") &&
    names(architectPlanTools).includes("read") &&
    names(architectPlanTools).includes("repo_status"),
  names(architectPlanTools)
);

check(
  "architect review native tools include review and repo actions",
  names(architectReviewTools).includes("review") &&
    names(architectReviewTools).includes("repo_pr_create"),
  names(architectReviewTools)
);

check(
  "worker native tools are scoped to worker-safe actions",
  names(workerTools).includes("read") &&
    names(workerTools).includes("patch") &&
    !names(workerTools).includes("repo_commit") &&
    !names(workerTools).includes("plan"),
  names(workerTools)
);

const readTool = workerTools.find((tool) => tool.name === "read");
check(
  "native tool parameter schemas do not require an action discriminator",
  !!readTool &&
    readTool.parameters.type === "object" &&
    !Object.keys(readTool.parameters.properties ?? {}).includes("action") &&
    JSON.stringify(readTool.parameters.required) === JSON.stringify(["paths"]),
  readTool
);

const nativeCalls: NativeToolCall[] = [
  { id: "call_1", name: "read", argumentsJson: "{\"paths\":[\"src/a.ts\"]}" },
  { id: "call_2", name: "run", arguments: { command: "npm test" } },
];
const actionText = nativeToolCallsToActionText(nativeCalls);
check(
  "native tool calls translate to existing Build action JSON lines",
  actionText ===
    "{\"action\":\"read\",\"paths\":[\"src/a.ts\"]}\n{\"action\":\"run\",\"command\":\"npm test\"}",
  actionText
);

const sampleTools = workerTools.filter((tool) =>
  ["read", "search"].includes(tool.name)
);

const openAIResponsesField = openAIResponsesNativeToolField(sampleTools);
check(
  "OpenAI Responses native tools use function tool objects",
  JSON.stringify(openAIResponsesField) ===
    JSON.stringify({
      tools: [
        {
          type: "function",
          name: "read",
          description: sampleTools[0].description,
          parameters: sampleTools[0].parameters,
          strict: false,
        },
        {
          type: "function",
          name: "search",
          description: sampleTools[1].description,
          parameters: sampleTools[1].parameters,
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  openAIResponsesField
);

const openAIChatField = openAICompatibleNativeToolField("openai", sampleTools);
check(
  "OpenAI-compatible native tools use chat function tool objects",
  JSON.stringify(openAIChatField) ===
    JSON.stringify({
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: sampleTools[0].description,
            parameters: sampleTools[0].parameters,
            strict: false,
          },
        },
        {
          type: "function",
          function: {
            name: "search",
            description: sampleTools[1].description,
            parameters: sampleTools[1].parameters,
            strict: false,
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  openAIChatField
);

check(
  "OpenRouter uses the same OpenAI-compatible native tool field",
  JSON.stringify(openAICompatibleNativeToolField("openrouter", sampleTools)) ===
    JSON.stringify(openAIChatField),
  openAICompatibleNativeToolField("openrouter", sampleTools)
);

const anthropicField = anthropicNativeToolField(sampleTools);
check(
  "Anthropic native tools use input_schema and auto tool choice",
  JSON.stringify(anthropicField) ===
    JSON.stringify({
      tools: [
        {
          name: "read",
          description: sampleTools[0].description,
          input_schema: sampleTools[0].parameters,
        },
        {
          name: "search",
          description: sampleTools[1].description,
          input_schema: sampleTools[1].parameters,
        },
      ],
      tool_choice: { type: "auto" },
    }),
  anthropicField
);

const googleConfig = googleNativeToolConfig(sampleTools);
check(
  "Google native tools use functionDeclarations and AUTO mode",
  JSON.stringify(googleConfig) ===
    JSON.stringify({
      tools: [
        {
          functionDeclarations: [
            {
              name: "read",
              description: sampleTools[0].description,
              parameters: sampleTools[0].parameters,
            },
            {
              name: "search",
              description: sampleTools[1].description,
              parameters: sampleTools[1].parameters,
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    }),
  googleConfig
);

check(
  "OpenAI local shell Build tools are gated",
  JSON.stringify(openAIResponsesHostedBuildToolsField(false)) === "{}" &&
    JSON.stringify(openAIResponsesHostedBuildToolsField(true)) ===
      JSON.stringify({
        tools: [{ type: "local_shell" }],
      }),
  openAIResponsesHostedBuildToolsField(true)
);

check(
  "Google hosted Build tools are gated",
  JSON.stringify(googleHostedBuildToolConfig(false)) === "{}" &&
    JSON.stringify(googleHostedBuildToolConfig(true)) ===
      JSON.stringify({ tools: [{ codeExecution: {} }] }),
  googleHostedBuildToolConfig(true)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
