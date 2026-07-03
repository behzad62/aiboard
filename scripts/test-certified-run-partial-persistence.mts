/* Task B3 contract pin (run: npx tsx scripts/test-certified-run-partial-persistence.mts)
 *
 * Guarantees that when a GameIQ (or any certified) runner records some pack
 * attempts and THEN throws a fatal/budget error mid-run, the already-recorded
 * attempts survive in the final snapshot instead of being clobbered by the
 * run engine's synthesized failure rows. createFailedAttemptsForRunError in
 * run-engine.ts already skips caseIds it finds in context.snapshot().attempts
 * (see existingKeys) -- this test pins that behavior at the engine level so a
 * future change to run-engine.ts can't silently regress it.
 */
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import { persistReturnedAttempts } from "../lib/benchmark/certified/model-runner";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";
import type { CertifiedRunContext } from "../lib/benchmark/certified/run-context";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const now = "2026-07-03T08:00:00.000Z";

function caseFor(id: string, canary: string): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track: "gameiq",
    title: `Partial persistence ${id}`,
    description: "A deterministic GameIQ case for partial-persistence coverage.",
    difficulty: "easy",
    tags: ["engine", "partial-persistence"],
    caseVersion: "0.1.0",
    createdAt: now,
    updatedAt: now,
    prompt: {
      userRequest: "Choose the winning move.",
      publicContext: "Return JSON.",
    },
    game: {
      gameId: "connect-four",
      seed: id,
      scenarioId: `${id}-scenario`,
    },
    environment: {
      type: "browser",
      timeoutSeconds: 30,
      network: "none",
    },
    verifier: {
      scorer: "game-engine",
    },
    budget: {
      maxUsd: 1,
      maxModelCalls: 4,
    },
    scoring: {
      scoringVersion: "certified-v0.1",
      primary: "game_iq",
    },
    contamination: {
      originalTask: true,
      canary,
      referenceSolutionPrivate: true,
    },
  };
}

const caseA = caseFor("case-a", "AIBENCH-PARTIAL-PERSIST-A");
const caseB = caseFor("case-b", "AIBENCH-PARTIAL-PERSIST-B");
const caseC = caseFor("case-c", "AIBENCH-PARTIAL-PERSIST-C");

const team: BenchmarkTeamComposition = {
  id: "team-partial-persistence",
  name: "Partial persistence single model",
  comboHash: "combo:partial-persistence",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-partial",
      providerId: "openai",
      displayName: "GPT Partial",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};

const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [{ id: "partial-persistence-fixture", label: "Partial persistence fixture", passed: true }],
};

function makeScoredAttempt(
  context: CertifiedRunContext,
  caseId: string,
  teamCompositionId: string
): BenchmarkAttemptV2 {
  return {
    id: `${context.runId}:${caseId}:${teamCompositionId}`,
    runId: context.runId,
    caseId,
    teamCompositionId,
    mode: "certified",
    track: "gameiq",
    harnessProfile: context.harnessProfile,
    status: "passed",
    startedAt: context.startedAt,
    completedAt: new Date().toISOString(),
    verifiedQuality: 1,
    jobSuccessScore: 100,
    efficiencyScore: 100,
    gameIqScore: 100,
    costUsd: 0.001,
    inputTokens: 10,
    outputTokens: 5,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 20,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "raw-single-model-v0.1",
    promptSetVersion: "certified-prompts-v0.1",
    scoringVersion: "certified-v0.1",
  };
}

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseA);
await saveBenchmarkCaseV2(caseB);
await saveBenchmarkCaseV2(caseC);
await saveBenchmarkTeamComposition(team);

const summary = await runCertifiedBenchmark({
  runId: "run-partial-persistence",
  suiteId: "suite-gameiq",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseA.id, caseB.id, caseC.id],
  teamCompositionIds: [team.id],
  certification: passingCertification,
  runner: async (context) => {
    // Simulate the UI's per-pack incremental persistence: case-a's attempt is
    // recorded (as the real runner would) BEFORE the fatal error surfaces from
    // a later pack.
    await persistReturnedAttempts(context, [
      makeScoredAttempt(context, caseA.id, team.id),
    ]);
    // Fatal (billing) error mid-run: matches both the B2 fatal-error
    // classifier and statusForRunError's provider-unavailable pattern, and
    // escapes the runner (not caught by GameIQ's transient containment).
    throw new Error("Provider quota exceeded: prepayment credits are depleted.");
  },
});

check("run summary status is failed", summary.status === "failed", summary);

const allAttempts = await listBenchmarkAttemptsV2();
const runAttempts = allAttempts.filter((attempt) => attempt.runId === summary.runId);
const caseAAttempts = runAttempts.filter((attempt) => attempt.caseId === caseA.id);
const caseBAttempts = runAttempts.filter((attempt) => attempt.caseId === caseB.id);
const caseCAttempts = runAttempts.filter((attempt) => attempt.caseId === caseC.id);

check(
  "case-a's already-recorded attempt survives exactly once",
  caseAAttempts.length === 1 && caseAAttempts[0].status === "passed",
  caseAAttempts
);
check(
  "case-b is synthesized as provider_unavailable",
  caseBAttempts.length === 1 && caseBAttempts[0].status === "provider_unavailable",
  caseBAttempts
);
check(
  "case-c is synthesized as provider_unavailable",
  caseCAttempts.length === 1 && caseCAttempts[0].status === "provider_unavailable",
  caseCAttempts
);

// Also assert against the summary's own attemptCount (the shape callers
// actually consume), not just the store, so this pins the engine's public
// contract: 3 cases total, none double-recorded (case-a kept once, case-b
// and case-c synthesized once each).
check(
  "summary.attemptCount reflects exactly 3 attempts (no clobber, no duplication)",
  summary.attemptCount === 3,
  summary
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
