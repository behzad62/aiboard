/* Certified run bundle completeness quality shield (run: npx tsx scripts/test-certified-run-bundle-completeness.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  saveBenchmarkAttemptV2,
  saveBenchmarkCaseV2,
  saveBenchmarkRunEvent,
  saveBenchmarkTeamComposition,
  saveBenchmarkToolCallTrace,
  saveBenchmarkVerifierResult,
  saveHarnessCertificationResult,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkRunEvent,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const timestamp = "2026-06-27T00:00:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: "workbench-quality-shield-0001",
  schemaVersion: 2,
  track: "workbench",
  title: "Quality shield fixture",
  description: "Easy WorkBench fixture used to check bundle completeness.",
  difficulty: "easy",
  tags: ["quality-shield"],
  caseVersion: "0.1.0",
  createdAt: timestamp,
  updatedAt: timestamp,
  prompt: { userRequest: "Fix add()", publicContext: "Return a + b." },
  repo: {
    url: "fixture://quality-shield",
    baseCommit: "fixture-base",
    shallowClone: true,
    fixtureHash: "fixture:quality-shield",
  },
  environment: {
    type: "local-runner",
    timeoutSeconds: 120,
    network: "none",
  },
  verifier: {
    command: "npm test",
    resultFile: "verifier-result.json",
    publicCommand: "npm test",
    scorer: "verifier-json",
  },
  budget: { maxUsd: 1, maxWallClockSeconds: 120 },
  scoring: {
    scoringVersion: "certified-v0.1",
    primary: "verified_quality",
    costTargetUsd: 1,
    timeTargetSeconds: 60,
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-WORKBENCH-QUALITY-SHIELD",
    referenceSolutionPrivate: true,
  },
};
const team: BenchmarkTeamComposition = {
  id: "team-quality-shield",
  name: "Oracle",
  comboHash: "solo:oracle",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "certified:oracle",
      providerId: "certified",
      displayName: "Oracle",
      temperature: 0,
    },
  ],
};
const attempt: BenchmarkAttemptV2 = {
  id: "attempt-quality-shield",
  runId: "run-quality-shield",
  caseId: caseV2.id,
  teamCompositionId: team.id,
  mode: "certified",
  track: "workbench",
  harnessProfile: "aiboard-build-multi-worker",
  status: "passed",
  startedAt: timestamp,
  completedAt: timestamp,
  verifiedQuality: 1,
  jobSuccessScore: 100,
  efficiencyScore: 100,
  costUsd: 0,
  inputTokens: 10,
  outputTokens: 5,
  modelCalls: 1,
  toolCalls: 1,
  durationMs: 1000,
  verifierResultId: "verifier-quality-shield",
  artifactIds: ["artifact-quality-shield"],
  traceIds: ["trace-quality-shield"],
  failureIds: [],
  harnessVersion: "aiboard-build-multi-worker-v0.1",
  promptSetVersion: "certified-build-prompts-v0.1",
  scoringVersion: "certified-v0.1",
};
const verifier: BenchmarkVerifierResult = {
  id: "verifier-quality-shield",
  attemptId: attempt.id,
  caseId: caseV2.id,
  command: "npm test",
  passed: true,
  score: 1,
  durationMs: 1000,
  exitCode: 0,
  stdoutPreview: "PASS",
  stderrPreview: "",
  resultJson: JSON.stringify({ passed: true, score: 1, assertions: [] }),
  assertionResults: [],
  artifactIds: [],
};
const runEvent: BenchmarkRunEvent = {
  id: "event-quality-shield",
  attemptId: attempt.id,
  caseId: caseV2.id,
  type: "model_call_completed",
  phase: "worker",
  at: timestamp,
  message: "Oracle model call completed.",
  modelId: "certified:oracle",
  providerId: "certified",
  detailsJson: JSON.stringify({ deterministic: true }),
};
const toolCallTrace: BenchmarkToolCallTrace = {
  id: "tool-trace-quality-shield",
  attemptId: attempt.id,
  caseId: caseV2.id,
  toolName: "patch-file",
  status: "ok",
  startedAt: timestamp,
  completedAt: timestamp,
  durationMs: 10,
  inputJson: JSON.stringify({ path: "src/add.ts" }),
  outputPreview: "applied",
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);
await saveBenchmarkAttemptV2(attempt);
await saveBenchmarkVerifierResult(verifier);
await saveBenchmarkRunEvent(runEvent);
await saveBenchmarkToolCallTrace(toolCallTrace);
await saveHarnessCertificationResult(runHarnessCertification("aiboard-build-multi-worker"));

const bundle = exportBenchmarkReportBundleV2();
check("v2 bundle includes certified case", bundle.caseV2.some((item) => item.id === caseV2.id), bundle.caseV2);
check("v2 bundle includes certified attempt", bundle.attemptsV2.some((item) => item.id === attempt.id), bundle.attemptsV2);
check("v2 bundle includes verifier result", bundle.verifierResults.some((item) => item.id === verifier.id), bundle.verifierResults);
check("v2 bundle includes run event evidence", bundle.runEvents.some((item) => item.id === runEvent.id), bundle.runEvents);
check("v2 bundle includes tool trace evidence", bundle.toolCallTraces.some((item) => item.id === toolCallTrace.id), bundle.toolCallTraces);
check("v2 bundle includes team composition", bundle.teamCompositions.some((item) => item.id === team.id), bundle.teamCompositions);
check("v2 bundle includes harness certification", bundle.harnessCertifications.length === 1 && bundle.harnessCertifications[0]?.passed === true, bundle.harnessCertifications);
check("v2 bundle includes reproducibility hash", typeof bundle.bundleHash === "string" && bundle.bundleHash.startsWith("fnv1a:"), bundle.bundleHash);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);

process.exit(failures === 0 ? 0 : 1);
