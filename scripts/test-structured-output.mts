/** Structured-output request shaping checks (run: npx tsx scripts/test-structured-output.mts) */

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const buildModule = await import("../lib/orchestrator/build");
const promptsModule = await import("../lib/orchestrator/prompts").catch(
  (err: unknown) => err
);
const chessAIModule = await import("../lib/games/chess/ai").catch(
  (err: unknown) => err
);
const connectFourAIModule = await import("../lib/games/connect-four/ai").catch(
  (err: unknown) => err
);
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
    typeof providerModule.googleStructuredOutputConfig === "function" &&
    typeof providerModule.anthropicStructuredToolConfig === "function",
  providerModule instanceof Error ? providerModule.message : Object.keys(providerModule)
);
check(
  "JSON-producing app modules expose structured-output schemas",
  !(promptsModule instanceof Error) &&
    !(chessAIModule instanceof Error) &&
    !(connectFourAIModule instanceof Error) &&
    typeof promptsModule.buildConvergenceVoteResponseFormat === "function" &&
    typeof chessAIModule.buildChessMoveResponseFormat === "function" &&
    typeof connectFourAIModule.buildConnectFourMoveResponseFormat === "function",
  {
    prompts:
      promptsModule instanceof Error ? promptsModule.message : Object.keys(promptsModule),
    chess:
      chessAIModule instanceof Error ? chessAIModule.message : Object.keys(chessAIModule),
    connectFour:
      connectFourAIModule instanceof Error
        ? connectFourAIModule.message
        : Object.keys(connectFourAIModule),
  }
);

if (
  typeof buildModule.buildArchitectActionResponseFormat !== "function" ||
  promptsModule instanceof Error ||
  chessAIModule instanceof Error ||
  connectFourAIModule instanceof Error ||
  typeof promptsModule.buildConvergenceVoteResponseFormat !== "function" ||
  typeof chessAIModule.buildChessMoveResponseFormat !== "function" ||
  typeof connectFourAIModule.buildConnectFourMoveResponseFormat !== "function" ||
  providerModule instanceof Error ||
  typeof providerModule.openAICompatibleStructuredOutputField !== "function" ||
  typeof providerModule.googleStructuredOutputConfig !== "function" ||
  typeof providerModule.anthropicStructuredToolConfig !== "function"
) {
  process.exit(1);
}

const { buildArchitectActionResponseFormat } = buildModule;
const { buildConvergenceVoteResponseFormat } = promptsModule;
const { buildChessMoveResponseFormat } = chessAIModule;
const { buildConnectFourMoveResponseFormat } = connectFourAIModule;
const {
  anthropicStructuredToolConfig,
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

const googleNullableEnumFormat = {
  name: "google_nullable_enum",
  schema: {
    type: "object",
    required: ["promotion", "rank"],
    properties: {
      promotion: {
        type: ["string", "null"],
        enum: ["queen", "rook", null],
      },
      rank: {
        type: ["integer", "null"],
        enum: [1, 2, 3, null],
      },
    },
  },
} as const;
const googleNullableEnumConfig = googleStructuredOutputConfig(
  googleNullableEnumFormat
);
const googlePromotionSchema =
  googleNullableEnumConfig.responseSchema?.properties?.promotion;
const googleRankSchema =
  googleNullableEnumConfig.responseSchema?.properties?.rank;
check(
  "Google nullable string enums use nullable plus string-only enum values",
  googlePromotionSchema?.nullable === true &&
    Array.isArray(googlePromotionSchema.enum) &&
    googlePromotionSchema.enum.join(",") === "queen,rook",
  googlePromotionSchema
);
check(
  "Google numeric enums are omitted because Gemini schema enum is string-only",
  googleRankSchema?.nullable === true &&
    googleRankSchema.type === "integer" &&
    googleRankSchema.enum === undefined,
  googleRankSchema
);

const anthropicTool = anthropicStructuredToolConfig(format);
check(
  "Anthropic receives a forced structured-output tool",
  anthropicTool.tools?.[0]?.name === "architect_action" &&
    anthropicTool.tool_choice?.type === "tool" &&
    anthropicTool.tool_choice.name === "architect_action" &&
    anthropicTool.tools[0].input_schema.required?.includes("action"),
  anthropicTool
);

const convergenceFormat = buildConvergenceVoteResponseFormat();
check(
  "convergence vote schema requires score and reason",
  convergenceFormat.name === "convergence_vote" &&
    convergenceFormat.schema.required?.includes("score") &&
    convergenceFormat.schema.required?.includes("reason"),
  convergenceFormat
);

const chessFormat = buildChessMoveResponseFormat();
check(
  "chess move schema requires from and to squares",
  chessFormat.name === "chess_move" &&
    chessFormat.schema.required?.includes("from") &&
    chessFormat.schema.required?.includes("to"),
  chessFormat
);

const connectFourFormat = buildConnectFourMoveResponseFormat();
check(
  "Connect Four schema requires a one-based column",
  connectFourFormat.name === "connect_four_move" &&
    connectFourFormat.schema.required?.includes("column"),
  connectFourFormat
);

process.exit(failed === 0 ? 0 : 1);
