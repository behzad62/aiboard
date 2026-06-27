/* TeamIQ combo matrix checks (run: npx tsx scripts/test-teamiq-combos.mts) */
import {
  buildTeamIqComboMatrixRows,
  deriveSoloTeamComposition,
  deriveTeamComposition,
} from "../lib/benchmark/teamiq";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamCompositionRole,
} from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const createdAt = "2026-06-27T10:00:00.000Z";

const gptRole: BenchmarkTeamCompositionRole = {
  role: "architect",
  slot: "architect",
  modelId: "openai:gpt-test",
  providerId: "openai",
  displayName: "GPT Test",
  temperature: 0,
};

const geminiRole: BenchmarkTeamCompositionRole = {
  role: "worker",
  slot: "worker-1",
  modelId: "google:gemini-test",
  providerId: "google",
  displayName: "Gemini Test",
  temperature: 0.2,
};

const claudeRole: BenchmarkTeamCompositionRole = {
  role: "reviewer",
  slot: "reviewer",
  modelId: "anthropic:claude-test",
  providerId: "anthropic",
  displayName: "Claude Test",
  temperature: 0,
};

const soloGpt = deriveSoloTeamComposition({
  modelId: "openai:gpt-test",
  displayName: "GPT Test",
  temperature: 0,
});
const soloGemini = deriveSoloTeamComposition({
  modelId: "google:gemini-test",
  displayName: "Gemini Test",
  temperature: 0.2,
});
const soloClaude = deriveSoloTeamComposition({
  modelId: "anthropic:claude-test",
  displayName: "Claude Test",
  temperature: 0,
});

const strongTeam = deriveTeamComposition({
  name: "GPT plus Gemini",
  roles: [gptRole, geminiRole],
});
const dominatedTeam = deriveTeamComposition({
  name: "GPT plus Claude",
  roles: [gptRole, claudeRole],
});
const cheapTeam = deriveTeamComposition({
  name: "Gemini plus Claude",
  roles: [
    { ...geminiRole, slot: "worker" },
    { ...claudeRole, slot: "critic" },
  ],
});
const partialBaselineTeam = deriveTeamComposition({
  name: "GPT plus missing solo",
  roles: [
    { ...gptRole, slot: "architect-partial" },
    {
      role: "worker",
      slot: "worker-missing-solo",
      modelId: "custom:no-solo",
      providerId: "custom",
      displayName: "No Solo Baseline",
      temperature: 0,
    },
  ],
});

const rows = buildTeamIqComboMatrixRows({
  attempts: [
    attempt("solo-gpt", soloGpt.id, "case-1", 74, 0.74, 0.8, 60_000, "raw-single-model"),
    attempt("solo-gemini", soloGemini.id, "case-1", 60, 0.6, 0.4, 40_000, "raw-single-model"),
    attempt("solo-claude", soloClaude.id, "case-1", 71, 0.71, 0.6, 45_000, "raw-single-model"),
    attempt("strong-team", strongTeam.id, "case-1", 84, 0.84, 1, 50_000, "aiboard-build-multi-worker"),
    attempt("dominated-team", dominatedTeam.id, "case-1", 70, 0.7, 2, 90_000, "aiboard-build-multi-worker"),
    attempt("cheap-team", cheapTeam.id, "case-1", 76, 0.76, 0.2, 30_000, "aiboard-build-multi-worker"),
    attempt("partial-baseline-team", partialBaselineTeam.id, "case-1", 99, 0.99, 0.1, 20_000, "aiboard-build-multi-worker"),
  ],
  teamCompositions: [
    soloGpt,
    soloGemini,
    soloClaude,
    strongTeam,
    dominatedTeam,
    cheapTeam,
    partialBaselineTeam,
  ],
  track: "teamiq",
});

const teamRows = rows.filter((row) => row.modelIds.length > 1);
const strongRow = rows.find((row) => row.teamCompositionId === strongTeam.id);
const dominatedRow = rows.find((row) => row.teamCompositionId === dominatedTeam.id);
const cheapRow = rows.find((row) => row.teamCompositionId === cheapTeam.id);
const partialBaselineRow = rows.find(
  (row) => row.teamCompositionId === partialBaselineTeam.id
);

check("combo matrix returns TeamIQ team rows", teamRows.length === 4, rows);
check(
  "combo matrix rows expose quality, cost, speed, and lift",
  strongRow?.verifiedQuality === 0.84 &&
    strongRow?.averageCostUsd === 1 &&
    strongRow?.averageDurationMs === 50_000 &&
    strongRow?.teamLift === 10,
  strongRow
);
check("combo matrix adds recommendation labels", typeof strongRow?.recommendationLabel === "string", strongRow);
check(
  "Pareto recommendations exclude dominated combos",
  dominatedRow?.isParetoRecommended === false &&
    dominatedRow?.recommendationLabel === "dominated" &&
    strongRow?.isParetoRecommended === true &&
    cheapRow?.isParetoRecommended === true,
  rows
);
check(
  "combo rows without complete solo baselines are not recommended",
  partialBaselineRow?.teamLift === null &&
    partialBaselineRow?.teamLiftLabel === null &&
    partialBaselineRow?.isParetoRecommended === false &&
    partialBaselineRow?.recommendationLabel === "insufficient_data",
  partialBaselineRow
);

function attempt(
  id: string,
  teamCompositionId: string,
  caseId: string,
  jobSuccessScore: number,
  verifiedQuality: number,
  costUsd: number,
  durationMs: number,
  harnessProfile: BenchmarkAttemptV2["harnessProfile"]
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId,
    teamCompositionId,
    mode: "certified",
    track: "teamiq",
    harnessProfile,
    status: "passed",
    startedAt: createdAt,
    completedAt: createdAt,
    verifiedQuality,
    jobSuccessScore,
    efficiencyScore: jobSuccessScore,
    costUsd,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test-harness",
    promptSetVersion: "test-prompts",
    scoringVersion: "test-scoring",
  };
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
