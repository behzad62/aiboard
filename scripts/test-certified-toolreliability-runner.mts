/* Certified ToolReliability runner checks (run: npx tsx scripts/test-certified-toolreliability-runner.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkToolCallTraces,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  TOOL_RELIABILITY_V0_1_CASES,
  buildPerfectToolReliabilityCandidate,
} from "../lib/benchmark/toolreliability";
import { runCertifiedToolReliability } from "../lib/benchmark/toolreliability/certified-runner";
import type { BenchmarkCaseV2, BenchmarkTeamComposition } from "../lib/benchmark/types";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = "2026-06-28T09:30:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: "toolreliability-v0.1-pack",
  schemaVersion: 2,
  track: "toolreliability",
  title: "ToolReliability v0.1 pack",
  description: "Certified ToolReliability schema/tool/patch/repair/safety pack.",
  difficulty: "easy",
  tags: ["toolreliability"],
  caseVersion: "0.1.0",
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Complete each ToolReliability case.",
  },
  environment: {
    type: "browser",
    timeoutSeconds: 60,
    network: "none",
  },
  verifier: {
    scorer: "rule-checker",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: 10,
  },
  scoring: {
    scoringVersion: "toolreliability-v0.1",
    primary: "tool_reliability",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-TOOLREL-RUNNER",
    referenceSolutionPrivate: true,
  },
};

const team: BenchmarkTeamComposition = {
  id: "team-certified-toolrel",
  name: "Certified ToolReliability single model",
  comboHash: "combo:certified-toolrel",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-toolrel",
      providerId: "openai",
      displayName: "GPT ToolRel",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};
const model: SelectedModel = {
  modelId: "openai:gpt-toolrel",
  providerId: "openai",
  displayName: "GPT ToolRel",
};
const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [{ id: "toolrel-fixture", label: "ToolReliability fixture certification", passed: true }],
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

const perfectOutputs = buildPerfectToolReliabilityCandidate().outputs;
const streamOutputs = TOOL_RELIABILITY_V0_1_CASES.flatMap((benchmarkCase) => perfectOutputs[benchmarkCase.id] ?? []);
let callIndex = 0;
const summary = await runCertifiedBenchmark({
  runId: "run-certified-toolrel",
  suiteId: "suite-certified-toolrel",
  track: "toolreliability",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: (context) =>
    runCertifiedToolReliability({
      context,
      models: [model],
      teamCompositionIds: [team.id],
      casePack: TOOL_RELIABILITY_V0_1_CASES,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* (): AsyncIterable<StreamChunk> {
        yield { type: "token", content: streamOutputs[callIndex++] ?? "{}" };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const verifiers = await listBenchmarkVerifierResults();
const toolTraces = await listBenchmarkToolCallTraces();
const bundle = exportBenchmarkReportBundleV2();
const attempt = attempts[0];
const verifier = verifiers[0];

check("certified ToolReliability run completes", summary.status === "completed" && summary.attemptCount === 1 && summary.verifierCount === 1, summary);
check("certified ToolReliability calls model for all outputs", callIndex === streamOutputs.length, { callIndex, expected: streamOutputs.length });
check("certified ToolReliability attempt persists perfect score", attempt?.status === "passed" && attempt.toolReliabilityScore === 100 && attempt.verifiedQuality === 1, attempt);
check("certified ToolReliability attempt accumulates traces and cost", attempt?.traceIds.length === streamOutputs.length && attempt.modelCalls === streamOutputs.length && attempt.costUsd !== null && attempt.costUsd > 0, attempt);
check("certified ToolReliability verifier records case assertions", verifier?.attemptId === attempt?.id && verifier.assertionResults.length === TOOL_RELIABILITY_V0_1_CASES.length && verifier.passed, verifier);
check("certified ToolReliability records tool traces", toolTraces.length > 0 && toolTraces.every((trace) => trace.attemptId === attempt?.id), toolTraces);
check("certified ToolReliability traces export", bundle.traces.length === streamOutputs.length && bundle.toolCallTraces.length === toolTraces.length, bundle);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
