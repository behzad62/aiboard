/* Certified GameIQ runner checks (run: npx tsx scripts/test-certified-gameiq-runner.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import { getGameIqScenarioPack } from "../lib/benchmark/gameiq";
import { runCertifiedGameIq } from "../lib/benchmark/gameiq/certified-runner";
import type { BenchmarkCaseV2, BenchmarkTeamComposition } from "../lib/benchmark/types";
import type {
  JsonSchemaObject,
  SelectedModel,
  StreamChunk,
  StructuredOutputFormat,
} from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const pack = getGameIqScenarioPack("connect-four");
if (!pack) throw new Error("Connect Four GameIQ pack is required for this test.");
const chessPack = getGameIqScenarioPack("chess");
if (!chessPack) throw new Error("Chess GameIQ pack is required for this test.");

const now = "2026-06-28T09:00:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: pack.id,
  schemaVersion: 2,
  track: "gameiq",
  title: pack.label,
  description: "Certified GameIQ Connect Four scenario pack.",
  difficulty: "easy",
  tags: ["gameiq", "connect-four"],
  caseVersion: pack.version,
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Solve each Connect Four scenario.",
    publicContext: "Return a JSON object with an action field.",
  },
  game: {
    gameId: "connect-four",
    seed: pack.id,
  },
  environment: {
    type: "browser",
    timeoutSeconds: 60,
    network: "none",
  },
  verifier: {
    scorer: "game-engine",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: pack.scenarios.length,
  },
  scoring: {
    scoringVersion: "certified-gameiq-v0.1",
    primary: "game_iq",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-GAMEIQ-RUNNER",
    referenceSolutionPrivate: true,
  },
};
const chessCaseV2: BenchmarkCaseV2 = {
  ...caseV2,
  id: chessPack.id,
  title: chessPack.label,
  description: "Certified GameIQ Chess scenario pack.",
  tags: ["gameiq", "chess"],
  caseVersion: chessPack.version,
  prompt: {
    userRequest: "Solve each Chess scenario.",
    publicContext: "Return a JSON object with a chess move action.",
  },
  game: {
    gameId: "chess",
    seed: chessPack.id,
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: chessPack.scenarios.length,
  },
};

const team: BenchmarkTeamComposition = {
  id: "team-certified-gameiq",
  name: "Certified GameIQ single model",
  comboHash: "combo:certified-gameiq",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-gameiq",
      providerId: "openai",
      displayName: "GPT GameIQ",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};
const model: SelectedModel = {
  modelId: "openai:gpt-gameiq",
  providerId: "openai",
  displayName: "GPT GameIQ",
};
const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [{ id: "gameiq-fixture", label: "GameIQ fixture certification", passed: true }],
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

let callIndex = 0;
let observedStructuredOutput: StructuredOutputFormat | undefined;
let observedReasoningEffort: string | undefined;
let observedMaxTokens: number | undefined;
const summary = await runCertifiedBenchmark({
  runId: "run-certified-gameiq",
  suiteId: "suite-certified-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [pack.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: (context) =>
    runCertifiedGameIq({
      context,
      models: [model],
      scenarioPackIds: [pack.id],
      teamCompositionIds: [team.id],
      trials: 1,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* ({ params }): AsyncIterable<StreamChunk> {
        observedStructuredOutput = params.structuredOutput;
        observedReasoningEffort = params.reasoningEffort;
        observedMaxTokens = params.maxTokens;
        const scenario = pack.scenarios[callIndex++];
        yield {
          type: "token",
          content: JSON.stringify({
            action: scenario.expectedActions[0]?.action,
          }),
        };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const verifiers = await listBenchmarkVerifierResults();
const bundle = exportBenchmarkReportBundleV2();
const attempt = attempts[0];
const verifier = verifiers[0];

check("certified GameIQ run completes", summary.status === "completed" && summary.attemptCount === 1 && summary.verifierCount === 1, summary);
check("certified GameIQ calls one model per scenario", callIndex === pack.scenarios.length, { callIndex, scenarios: pack.scenarios.length });
check("certified GameIQ attempt persists verified score", attempt?.status === "passed" && attempt.gameIqScore === 100 && attempt.verifiedQuality === 1, attempt);
check("certified GameIQ attempt accumulates traces and cost", attempt?.traceIds.length === pack.scenarios.length && attempt.modelCalls === pack.scenarios.length && attempt.costUsd !== null && attempt.costUsd > 0, attempt);
check("certified GameIQ verifier records scenario assertions", verifier?.attemptId === attempt?.id && verifier.assertionResults.length === pack.scenarios.length && verifier.passed, verifier);
check("certified GameIQ dashboard updates", summary.dashboard.summary.certifiedAttempts === 1 && summary.dashboard.summary.verifiedPassRate === 1, summary.dashboard.summary);
check("certified GameIQ traces export", bundle.traces.length === pack.scenarios.length && bundle.traces.every((trace) => trace.runId === "run-certified-gameiq"), bundle.traces);
check(
  "certified GameIQ structured output has no open object schemas",
  !!observedStructuredOutput &&
    schemaObjectNodes(observedStructuredOutput.schema).every(
      (node) => node.additionalProperties === false
    ),
  observedStructuredOutput
);
check(
  "certified GameIQ structured output requires every object property",
  !!observedStructuredOutput &&
    schemaObjectNodes(observedStructuredOutput.schema).every((node) => {
      const keys = Object.keys(node.properties ?? {});
      return keys.every((key) => node.required?.includes(key));
    }),
  observedStructuredOutput
);
check(
  "certified GameIQ leaves reasoning unset so providers use model defaults",
  observedReasoningEffort === undefined,
  observedReasoningEffort
);
check(
  "certified GameIQ default output ceiling leaves room for hidden thinking plus JSON",
  typeof observedMaxTokens === "number" && observedMaxTokens >= 2048,
  observedMaxTokens
);

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(chessCaseV2);
await saveBenchmarkTeamComposition(team);

let chessCallIndex = 0;
let observedChessStructuredOutput: StructuredOutputFormat | undefined;
const chessSummary = await runCertifiedBenchmark({
  runId: "run-certified-gameiq-chess-schema",
  suiteId: "suite-certified-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [chessPack.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: (context) =>
    runCertifiedGameIq({
      context,
      models: [model],
      scenarioPackIds: [chessPack.id],
      teamCompositionIds: [team.id],
      trials: 1,
      streamChat: async function* ({ params }): AsyncIterable<StreamChunk> {
        observedChessStructuredOutput ??= params.structuredOutput;
        const scenario = chessPack.scenarios[chessCallIndex++];
        const action = scenario.expectedActions[0]?.action as {
          from: string;
          to: string;
          promotion?: string | null;
        };
        yield {
          type: "token",
          content: JSON.stringify({
            action: {
              from: action.from,
              to: action.to,
              promotion: action.promotion ?? null,
            },
          }),
        };
        yield { type: "done" };
      },
    }),
});
const chessAttempts = await listBenchmarkAttemptsV2();
const chessAttempt = chessAttempts[0];
const chessVerifier = (await listBenchmarkVerifierResults())[0];
const chessActionSchema =
  observedChessStructuredOutput?.schema.properties?.action?.properties ?? {};
check(
  "certified Chess structured output does not expose nested action discriminator",
  !!observedChessStructuredOutput &&
    !Object.prototype.hasOwnProperty.call(chessActionSchema, "action") &&
    Object.keys(chessActionSchema).join(",") === "from,to,promotion",
  observedChessStructuredOutput
);
check(
  "certified Chess accepts direct move action object",
  chessSummary.status === "completed" &&
    chessAttempt?.status === "passed" &&
    chessAttempt.gameIqScore === 100,
  { chessSummary, chessAttempt }
);

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(chessCaseV2);
await saveBenchmarkTeamComposition(team);

let invalidChessCallIndex = 0;
await runCertifiedBenchmark({
  runId: "run-certified-gameiq-chess-failure-evidence",
  suiteId: "suite-certified-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [chessPack.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: (context) =>
    runCertifiedGameIq({
      context,
      models: [model],
      scenarioPackIds: [chessPack.id],
      teamCompositionIds: [team.id],
      trials: 1,
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        invalidChessCallIndex++;
        yield {
          type: "token",
          content: JSON.stringify({
            action: {
              from: null,
              to: null,
              promotion: null,
            },
          }),
        };
        yield { type: "done" };
      },
    }),
});
const failedChessVerifier = (await listBenchmarkVerifierResults())[0];
const failedAssertionWithDetails = failedChessVerifier?.assertionResults.find(
  (assertion) => !assertion.passed && assertion.details?.includes("Raw response")
);
check(
  "certified GameIQ failed assertions include raw response details",
  Boolean(failedAssertionWithDetails) &&
    failedAssertionWithDetails?.details?.includes('"from":null') === true,
  failedChessVerifier
);
check(
  "certified GameIQ failed assertions include expected result details",
  Boolean(failedAssertionWithDetails) &&
    failedAssertionWithDetails?.details?.includes("Expected result") === true &&
    failedAssertionWithDetails.details.includes('"action"') &&
    failedAssertionWithDetails.details.includes(
      `"from":"${chessPack.scenarios[0]?.expectedActions[0]?.action.from}"`
    ),
  failedAssertionWithDetails
);
check(
  "certified GameIQ verifier result stores failed case diagnostics",
  failedChessVerifier?.resultJson.includes('"caseResults"') === true &&
    failedChessVerifier.resultJson.includes('"rawResponse"') &&
    failedChessVerifier.resultJson.includes('"action"') &&
    failedChessVerifier.resultJson.includes('"expectedActions"'),
  failedChessVerifier?.resultJson
);

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

let malformedJsonCallCount = 0;
const malformedJsonSummary = await runCertifiedBenchmark({
  runId: "run-certified-gameiq-malformed-json",
  suiteId: "suite-certified-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [pack.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: (context) =>
    runCertifiedGameIq({
      context,
      models: [model],
      scenarioPackIds: [pack.id],
      teamCompositionIds: [team.id],
      trials: 1,
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        malformedJsonCallCount++;
        yield { type: "token", content: '{"action":{"column":3' };
        yield { type: "done" };
      },
    }),
});
const malformedJsonAttempt = (await listBenchmarkAttemptsV2())[0];
check(
  "certified GameIQ malformed JSON is scored as failed tool use, not invalid harness",
  malformedJsonSummary.status === "completed" &&
    malformedJsonAttempt?.status === "failed_tool_use" &&
    malformedJsonAttempt.traceIds.length === pack.scenarios.length &&
    malformedJsonCallCount === pack.scenarios.length,
  { malformedJsonSummary, malformedJsonAttempt, malformedJsonCallCount }
);

function schemaObjectNodes(schema: JsonSchemaObject | undefined): JsonSchemaObject[] {
  if (!schema) return [];
  const isObjectNode = schema.type === "object" || !!schema.properties;
  const nodes = isObjectNode ? [schema] : [];
  for (const child of Object.values(schema.properties ?? {})) {
    nodes.push(...schemaObjectNodes(child));
  }
  if (schema.items) {
    nodes.push(...schemaObjectNodes(schema.items));
  }
  return nodes;
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
