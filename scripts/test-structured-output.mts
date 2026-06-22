/** Structured-output request shaping checks (run: npx tsx scripts/test-structured-output.mts) */

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const buildModule = await import("../lib/orchestrator/build");
const providerModule = await import("../lib/providers/structured-output").catch(
  (err: unknown) => err
);

check(
  "Build module exports architect structured-output schema",
  typeof buildModule.buildArchitectActionResponseFormat === "function",
  Object.keys(buildModule)
);
check(
  "provider structured-output helpers exist",
  !(providerModule instanceof Error) &&
    typeof providerModule.openAICompatibleStructuredOutputField === "function" &&
    typeof providerModule.googleStructuredOutputConfig === "function",
  providerModule instanceof Error ? providerModule.message : Object.keys(providerModule)
);

if (
  typeof buildModule.buildArchitectActionResponseFormat !== "function" ||
  providerModule instanceof Error ||
  typeof providerModule.openAICompatibleStructuredOutputField !== "function" ||
  typeof providerModule.googleStructuredOutputConfig !== "function"
) {
  process.exit(1);
}

const { buildArchitectActionResponseFormat } = buildModule;
const {
  googleStructuredOutputConfig,
  openAICompatibleStructuredOutputField,
} = providerModule;

const format = buildArchitectActionResponseFormat();

check("architect schema requires an action discriminator", format.schema.required?.includes("action") === true, format);
check(
  "architect schema allows terminal plan and review actions",
  Array.isArray(format.schema.properties?.action?.enum) &&
    format.schema.properties.action.enum.includes("plan") &&
    format.schema.properties.action.enum.includes("review"),
  format.schema.properties?.action
);
check(
  "architect schema includes tool actions used by inspection loops",
  Array.isArray(format.schema.properties?.action?.enum) &&
    format.schema.properties.action.enum.includes("read") &&
    format.schema.properties.action.enum.includes("patch") &&
    format.schema.properties.action.enum.includes("repo_status"),
  format.schema.properties?.action
);

const openRouterField = openAICompatibleStructuredOutputField("openrouter", format);
check(
  "OpenRouter receives response_format json_schema",
  openRouterField.response_format?.type === "json_schema" &&
    openRouterField.response_format.json_schema.name === "architect_action",
  openRouterField
);

const openAIField = openAICompatibleStructuredOutputField("openai", format);
check(
  "OpenAI chat completions receives response_format json_schema",
  openAIField.response_format?.type === "json_schema" &&
    openAIField.response_format.json_schema.schema.required.includes("action"),
  openAIField
);

const customField = openAICompatibleStructuredOutputField("custom", format);
check(
  "unknown OpenAI-compatible endpoints are not sent schema params",
  Object.keys(customField).length === 0,
  customField
);

const googleConfig = googleStructuredOutputConfig(format);
check(
  "Google receives JSON MIME type and schema",
  googleConfig.responseMimeType === "application/json" &&
    googleConfig.responseSchema?.properties?.action?.enum?.includes("review"),
  googleConfig
);

process.exit(failed === 0 ? 0 : 1);
