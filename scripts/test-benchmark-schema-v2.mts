/* Benchmark schema v2 regression checks (run: npx tsx scripts/test-benchmark-schema-v2.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  importBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkCaseV2,
  listBenchmarkRunEvents,
  listBenchmarkTeamCompositions,
  listBenchmarkToolCallTraces,
  listBenchmarkVerifierResults,
  listHarnessCertificationResults,
  saveBenchmarkArtifact,
  saveBenchmarkAttemptV2,
  saveBenchmarkCaseV2,
  saveBenchmarkRunEvent,
  saveBenchmarkTeamComposition,
  saveBenchmarkToolCallTrace,
  saveBenchmarkVerifierResult,
  saveHarnessCertificationResult,
  verifyBenchmarkBundleHash,
} from "../lib/benchmark/store";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkRunEvent,
  BenchmarkTeamComposition,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
  HarnessCertificationResult,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function expectReject(
  name: string,
  action: () => Promise<void>,
  messagePattern: RegExp
): Promise<void> {
  try {
    await action();
    check(name, false, "resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, messagePattern.test(message), message);
  }
}

const createdAt = "2026-06-27T10:00:00.000Z";

const caseV2: BenchmarkCaseV2 = {
  id: "workbench-ts-0001",
  schemaVersion: 2,
  track: "workbench",
  title: "TypeScript CLI CSV output",
  description: "Add CSV output to a report command.",
  difficulty: "medium",
  tags: ["typescript", "cli"],
  caseVersion: "0.1.0",
  createdAt,
  updatedAt: createdAt,
  prompt: {
    userRequest: "Add --format csv to the report command.",
    publicContext: "The JSON format must remain unchanged.",
    hiddenNotesHash: "hidden:abc123",
  },
  repo: {
    url: "https://example.invalid/repo.git",
    baseCommit: "abc123",
    shallowClone: true,
    fixtureHash: "fixture:abc123",
  },
  environment: {
    type: "local-runner",
    timeoutSeconds: 1200,
    memoryMb: 2048,
    network: "none",
  },
  verifier: {
    command: "npm test",
    resultFile: "verifier-result.json",
    publicCommand: "npm test",
    hiddenCommandHash: "hidden-verifier:abc123",
    timeoutSeconds: 120,
    scorer: "verifier-json",
  },
  budget: {
    maxUsd: 2,
    maxWallClockSeconds: 1200,
    maxModelCalls: 20,
    maxToolCalls: 100,
    maxInputTokens: 200_000,
    maxOutputTokens: 50_000,
  },
  scoring: {
    scoringVersion: "certified-v0.1",
    primary: "verified_quality",
    costTargetUsd: 1,
    timeTargetSeconds: 600,
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CANARY-0001",
    referenceSolutionPrivate: true,
    publicAfter: "2027-01-01",
  },
};

const composition: BenchmarkTeamComposition = {
  id: "team-1",
  name: "Architect plus worker",
  comboHash: "combo:abc123",
  roles: [
    {
      role: "architect",
      slot: "architect",
      modelId: "openai:gpt-test",
      providerId: "openai",
      displayName: "GPT Test",
      reasoningEffort: "medium",
      temperature: 0,
      maxTokens: 4096,
    },
    {
      role: "worker",
      slot: "worker-1",
      modelId: "google:gemini-test",
      providerId: "google",
      displayName: "Gemini Test",
      reasoningEffort: "medium",
      temperature: 0.2,
    },
  ],
};

const verifierResult: BenchmarkVerifierResult = {
  id: "verifier-1",
  attemptId: "attempt-1",
  caseId: caseV2.id,
  command: "npm test",
  passed: true,
  score: 0.92,
  durationMs: 12_000,
  exitCode: 0,
  stdoutPreview: "PASS",
  stderrPreview: "",
  resultJson: JSON.stringify({ passed: true, score: 0.92 }),
  assertionResults: [
    {
      id: "csv-escaping",
      label: "CSV escaping handles quotes",
      passed: true,
      weight: 0.4,
    },
  ],
  artifactIds: ["artifact-1"],
};

const runEvent: BenchmarkRunEvent = {
  id: "event-1",
  attemptId: "attempt-1",
  caseId: caseV2.id,
  type: "model_call_completed",
  phase: "worker",
  at: createdAt,
  message: "Worker model call completed.",
  modelId: "openai:gpt-test",
  providerId: "openai",
  detailsJson: JSON.stringify({ inputTokens: 12_000, outputTokens: 2_000 }),
};

const toolCallTrace: BenchmarkToolCallTrace = {
  id: "tool-trace-1",
  attemptId: "attempt-1",
  caseId: caseV2.id,
  toolName: "run-command",
  command: "npm test",
  status: "ok",
  startedAt: createdAt,
  completedAt: "2026-06-27T10:01:00.000Z",
  durationMs: 12_000,
  inputJson: JSON.stringify({ command: "npm test" }),
  outputPreview: "PASS",
};

const attemptV2: BenchmarkAttemptV2 = {
  id: "attempt-1",
  runId: "run-1",
  caseId: caseV2.id,
  teamCompositionId: composition.id,
  mode: "certified",
  track: "workbench",
  harnessProfile: "aiboard-build-multi-worker",
  status: "passed",
  startedAt: createdAt,
  completedAt: "2026-06-27T10:02:00.000Z",
  verifiedQuality: 0.92,
  jobSuccessScore: 92,
  efficiencyScore: 88.5,
  toolReliabilityScore: 98,
  gameIqScore: 0,
  teamLift: 10,
  costUsd: 0.32,
  inputTokens: 12_000,
  outputTokens: 2_000,
  modelCalls: 8,
  toolCalls: 14,
  durationMs: 120_000,
  verifierResultId: verifierResult.id,
  artifactIds: ["artifact-1"],
  traceIds: ["trace-1"],
  failureIds: [],
  harnessVersion: "aiboard-build-harness-v0.1",
  promptSetVersion: "workbench-prompts-v0.1",
  scoringVersion: "certified-v0.1",
};

const certification: HarnessCertificationResult = {
  id: "cert-1",
  createdAt,
  aiboardVersion: "0.1.0",
  benchmarkEngineVersion: "0.1.0",
  harnessProfile: "aiboard-build-multi-worker",
  harnessVersion: "aiboard-build-harness-v0.1",
  promptSetVersion: "workbench-prompts-v0.1",
  passed: true,
  checks: [
    {
      id: "fake-model-override",
      label: "Fake model override is honored",
      passed: true,
    },
  ],
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(composition);
await saveBenchmarkVerifierResult(verifierResult);
await saveBenchmarkRunEvent(runEvent);
await saveBenchmarkToolCallTrace(toolCallTrace);
await saveBenchmarkAttemptV2(attemptV2);
await saveHarnessCertificationResult(certification);
await saveBenchmarkArtifact({
  id: "secret-artifact",
  kind: "log",
  label: "Runner log",
  mimeType: "text/plain",
  content: "Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
  createdAt,
});

check("caseV2 saves and lists", (await listBenchmarkCaseV2()).length === 1);
check("team composition saves and lists", (await listBenchmarkTeamCompositions()).length === 1);
check("verifier result saves and lists", (await listBenchmarkVerifierResults()).length === 1);
check("run event saves and lists", (await listBenchmarkRunEvents()).length === 1);
check("tool call trace saves and lists", (await listBenchmarkToolCallTraces()).length === 1);
check("attemptV2 saves and lists", (await listBenchmarkAttemptsV2()).length === 1);
check("harness certification saves and lists", (await listHarnessCertificationResults()).length === 1);

const bundleV2 = exportBenchmarkReportBundleV2();
check("v2 bundle exports all new arrays", bundleV2.version === 2 &&
  bundleV2.caseV2.length === 1 &&
  bundleV2.attemptsV2.length === 1 &&
  bundleV2.verifierResults.length === 1 &&
  bundleV2.runEvents.length === 1 &&
  bundleV2.toolCallTraces.length === 1 &&
  bundleV2.teamCompositions.length === 1 &&
  bundleV2.harnessCertifications.length === 1,
  bundleV2);
check("v2 bundle includes a bundle hash", typeof bundleV2.bundleHash === "string" && bundleV2.bundleHash.length > 0, bundleV2.bundleHash);
const goodVerify = verifyBenchmarkBundleHash(bundleV2);
check("matching bundleHash verifies ok", goodVerify.ok, goodVerify);
const tamperedBundle = {
  ...bundleV2,
  attemptsV2: bundleV2.attemptsV2.map((attempt) => ({
    ...attempt,
    verifiedQuality: 0.01,
  })),
};
const badVerify = verifyBenchmarkBundleHash(tamperedBundle);
check("mutated payload with original hash fails verification", !badVerify.ok, badVerify);
check(
  "v2 bundle export redacts artifact secrets",
  !bundleV2.artifacts[0]?.content.includes("sk-proj-") &&
    (bundleV2.redactionSummary?.scannedArtifacts ?? 0) >= 1 &&
    (bundleV2.redactionSummary?.redactedSecrets ?? 0) >= 1,
  { artifact: bundleV2.artifacts[0], summary: bundleV2.redactionSummary }
);

const legacyBundle = {
  version: 1,
  exportedAt: createdAt,
  suites: [],
  runs: [],
  cases: [],
  attempts: [],
  metricValues: [],
  artifacts: [],
  failures: [],
  traces: [],
};

__resetBenchmarkStoreForTests();
await expectReject(
  "legacy v1 bundle import is rejected",
  () => importBenchmarkReportBundleV2(legacyBundle as never),
  /Unsupported benchmark report version/i
);

__resetBenchmarkStoreForTests();
const cleanImport = await importBenchmarkReportBundleV2(bundleV2);
check("clean import reports no hash mismatch", cleanImport.hashMismatch === false, cleanImport);
const roundTrip = exportBenchmarkReportBundleV2();
check("imported v2 bundle round-trips without score drift", roundTrip.attemptsV2[0]?.verifiedQuality === attemptV2.verifiedQuality, roundTrip.attemptsV2[0]);
check("imported v2 bundle round-trips run evidence", roundTrip.runEvents.length === 1 && roundTrip.toolCallTraces.length === 1, {
  runEvents: roundTrip.runEvents,
  toolCallTraces: roundTrip.toolCallTraces,
});
const dirtyImport = await importBenchmarkReportBundleV2(tamperedBundle);
check("tampered import reports hash mismatch", dirtyImport.hashMismatch === true, dirtyImport);

const {
  toolReliabilityScore: _omittedToolReliabilityScore,
  ...attemptWithOptionalScores
}: BenchmarkAttemptV2 = {
  ...attemptV2,
  id: "attempt-null-cost",
  costUsd: null,
  gameIqScore: 42,
  teamLift: 3,
};
await importBenchmarkReportBundleV2({
  ...bundleV2,
  attemptsV2: [attemptWithOptionalScores],
});
check("attemptV2 accepts null cost and optional score fields", true);

await expectReject(
  "malformed caseV2 rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, caseV2: [{ ...caseV2, schemaVersion: 1 } as never] }),
  /caseV2/i
);
await expectReject(
  "malformed verifier result rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, verifierResults: [{ ...verifierResult, resultJson: "not-json" } as never] }),
  /verifier/i
);
await expectReject(
  "malformed legacy trace retry history rejected",
  () =>
    importBenchmarkReportBundleV2({
      ...bundleV2,
      traces: [
        {
          id: "legacy-trace-invalid",
          runId: "run-1",
          caseId: caseV2.id,
          attemptId: attemptV2.id,
          modelId: "openai:gpt-test",
          providerId: "openai",
          startedAt: createdAt,
          retryHistory: {} as never,
        },
      ],
    }),
  /trace/i
);
await expectReject(
  "missing run events array rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, runEvents: undefined } as never),
  /runEvents/i
);
await expectReject(
  "missing tool traces array rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, toolCallTraces: undefined } as never),
  /toolCallTraces/i
);
await expectReject(
  "malformed run event rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, runEvents: [{ ...runEvent, type: "unknown" } as never] }),
  /run event/i
);
await expectReject(
  "malformed tool trace rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, toolCallTraces: [{ ...toolCallTrace, status: "complete" } as never] }),
  /tool trace/i
);
await expectReject(
  "malformed team composition rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, teamCompositions: [{ ...composition, roles: [] } as never] }),
  /team/i
);
await expectReject(
  "malformed attempt status rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, attemptsV2: [{ ...attemptV2, status: "completed" } as never] }),
  /status/i
);
await expectReject(
  "malformed track rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, caseV2: [{ ...caseV2, track: "game" } as never] }),
  /track/i
);
await expectReject(
  "malformed mode rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, attemptsV2: [{ ...attemptV2, mode: "raw" } as never] }),
  /mode/i
);
await expectReject(
  "malformed harness profile rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, attemptsV2: [{ ...attemptV2, harnessProfile: "browser" } as never] }),
  /harness/i
);
await expectReject(
  "missing case description rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, caseV2: [{ ...caseV2, description: undefined } as never] }),
  /caseV2/i
);
await expectReject(
  "missing case canary rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, caseV2: [{ ...caseV2, contamination: { ...caseV2.contamination, canary: undefined } } as never] }),
  /contamination/i
);
await expectReject(
  "malformed environment type rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, caseV2: [{ ...caseV2, environment: { ...caseV2.environment, type: "container" } } as never] }),
  /environment/i
);
await expectReject(
  "malformed verifier scorer rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, caseV2: [{ ...caseV2, verifier: { ...caseV2.verifier, scorer: "text" } } as never] }),
  /verifier/i
);
await expectReject(
  "missing assertion weight rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, verifierResults: [{ ...verifierResult, assertionResults: [{ ...verifierResult.assertionResults[0], weight: undefined }] } as never] }),
  /verifier/i
);
await expectReject(
  "missing team role temperature rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, teamCompositions: [{ ...composition, roles: [{ ...composition.roles[0], temperature: undefined }] } as never] }),
  /team/i
);
await expectReject(
  "malformed harness certification profile rejected",
  () => importBenchmarkReportBundleV2({ ...bundleV2, harnessCertifications: [{ ...certification, harnessProfile: "browser" } as never] }),
  /harness/i
);

__resetBenchmarkStoreForTests();
await saveBenchmarkAttemptV2({
  ...attemptV2,
  completedAt: "2026-07-01T00:00:00.000Z",
  verifiedQuality: 0.99,
});
await importBenchmarkReportBundleV2({
  ...bundleV2,
  attemptsV2: [{ ...attemptV2, verifiedQuality: 0.01 }],
});
const staleAttemptImport = (await listBenchmarkAttemptsV2()).find(
  (attempt) => attempt.id === attemptV2.id
);
check(
  "stale same-id attempt import does not clobber newer local certified attempt",
  staleAttemptImport?.verifiedQuality === 0.99,
  staleAttemptImport
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
