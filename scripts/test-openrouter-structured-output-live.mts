/** Live OpenRouter structured-output smoke test.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... npx tsx scripts/test-openrouter-structured-output-live.mts
 *   npx tsx scripts/test-openrouter-structured-output-live.mts   # the OpenRouter key saved in the AIBoard home
 *   npx tsx scripts/test-openrouter-structured-output-live.mts --dry-run   # find the key, call nothing
 *
 * Without OPENROUTER_API_KEY the key comes from the AIBoard home (`~/.aiboard`, or AIBOARD_HOME), as
 * `aiboard keys set openrouter` or Settings saved it, together with the home's OpenRouter base URL.
 * The key is never printed.
 *
 * Optional:
 *   OPENROUTER_LIVE_MODELS="z-ai/glm-5.2,minimax/minimax-m3"
 */

import type { AIProvider, StructuredOutputFormat } from "../lib/providers/base";
import { liveProviderKey } from "./live-home-key.mts";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const openrouterModule = await import("../lib/providers/openrouter");
const openrouterProvider = resolveOpenRouterProvider(openrouterModule);
const found = liveProviderKey("openrouter", "OPENROUTER_API_KEY");

if (!found.found) {
  console.log(
    `SKIP - ${found.reason}; set OPENROUTER_API_KEY or save an OpenRouter key in the AIBoard home to run the live OpenRouter structured-output smoke test`
  );
  process.exit(0);
}
const apiKey = found.key;
const baseURL = found.baseUrl ?? undefined;

if (process.argv.includes("--dry-run")) {
  console.log(`DRY-RUN - OpenRouter key found (source=${found.source}${baseURL ? ", home base URL" : ""}); no provider call made`);
  process.exit(0);
}

const models = (process.env.OPENROUTER_LIVE_MODELS ?? "z-ai/glm-5.2,minimax/minimax-m3")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);

const structuredOutput: StructuredOutputFormat = {
  name: "gameiq_connect_four_action_smoke",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "object",
        additionalProperties: false,
        required: ["column"],
        properties: {
          column: { type: "integer" },
        },
      },
    },
  },
};

for (const model of models) {
  const result = await callStructuredSmoke(model);
  check(`${model} OpenRouter provider call completed`, !result.error, result);
  check(`${model} returned valid JSON`, result.parseOk, result);
  check(`${model} returned the expected action shape`, result.shapeOk, result);
}

process.exit(failed === 0 ? 0 : 1);

function resolveOpenRouterProvider(module: unknown): AIProvider {
  const value = module as {
    openrouterProvider?: AIProvider;
    default?: { openrouterProvider?: AIProvider };
  };
  const provider = value.openrouterProvider ?? value.default?.openrouterProvider;
  if (!provider) throw new Error("Could not import openrouterProvider.");
  return provider;
}

async function callStructuredSmoke(model: string): Promise<{
  model: string;
  elapsedMs: number;
  parseOk: boolean;
  shapeOk: boolean;
  usageReported: boolean;
  contentLength: number;
  preview: string;
  error?: string;
}> {
  const started = Date.now();
  let content = "";
  let usageReported = false;
  let error: string | undefined;

  for await (const chunk of openrouterProvider.streamChat({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    model,
    messages: [
      {
        role: "system",
        content: "Return only the requested structured JSON. No prose.",
      },
      {
        role: "user",
        content: 'Return column 1 as {"action":{"column":1}}.',
      },
    ],
    structuredOutput,
    maxTokens: 256,
    temperature: 0,
    // This script checks OpenRouter transport/schema routing, not reasoning
    // quality. Keep reasoning off so small action schemas cannot be starved by
    // hidden thinking tokens on reasoning-heavy endpoints.
    reasoningEffort: "none",
  })) {
    if (chunk.type === "token") content += chunk.content;
    if (chunk.type === "usage") usageReported = true;
    if (chunk.type === "error") {
      error = chunk.error;
      break;
    }
  }

  let parsed: unknown;
  let parseOk = false;
  try {
    parsed = JSON.parse(content);
    parseOk = true;
  } catch {
    parsed = undefined;
  }

  const shapeOk =
    parseOk &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    typeof (parsed as { action?: { column?: unknown } }).action === "object" &&
    (parsed as { action?: { column?: unknown } }).action !== null &&
    Number.isInteger((parsed as { action: { column?: unknown } }).action.column);

  return {
    model,
    elapsedMs: Date.now() - started,
    parseOk,
    shapeOk,
    usageReported,
    contentLength: content.length,
    preview: content.slice(0, 120),
    ...(error ? { error: error.slice(0, 260) } : {}),
  };
}
