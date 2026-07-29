import assert from "node:assert/strict";
import {
  __clearClientStoreForTests,
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkResultSets,
  saveBenchmarkCaseV2,
  saveBenchmarkRun,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import { runCertifiedTeamIq } from "../lib/benchmark/teamiq";
import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability";
import {
  createPendingBenchmarkResultSet,
  failBenchmarkResultSet,
  publishBenchmarkResultSetIfComplete,
} from "../lib/benchmark/certified/result-set-publication";
import type {
  BenchmarkCaseV2,
  BenchmarkResultSet,
  BenchmarkRun,
  BenchmarkTeamComposition,
  HarnessCertificationResult,
} from "../lib/benchmark/types";

const now = "2026-07-29T10:00:00.000Z";
const caseRecord: BenchmarkCaseV2 = {
  id: "team-case",
  schemaVersion: 2,
  track: "teamiq",
  title: "Team case",
  description: "Team case",
  difficulty: "easy",
  tags: [],
  caseVersion: "case-v1",
  createdAt: now,
  updatedAt: now,
  prompt: { userRequest: "team" },
  environment: { type: "browser", timeoutSeconds: 30, network: "none" },
  verifier: { scorer: "rule-checker" },
  budget: {},
  scoring: {
    scoringVersion: "teamiq-toolreliability-v2",
    primary: "team_lift",
  },
  contamination: {
    originalTask: true,
    canary: "team-case-canary",
    referenceSolutionPrivate: true,
  },
};
const certification: HarnessCertificationResult = {
  id: "cert",
  createdAt: now,
  aiboardVersion: "v1",
  benchmarkEngineVersion: "v1",
  harnessProfile: "aiboard-panel",
  harnessVersion: "v1",
  promptSetVersion: "v1",
  passed: true,
  checks: [],
};
const teams: BenchmarkTeamComposition[] = [
  {
    id: "solo-a",
    name: "Solo A",
    comboHash: "solo-a",
    strategy: "solo",
    roles: [{
      role: "single", slot: "single", providerId: "test", modelId: "a",
      displayName: "A", reasoningEffort: "medium", temperature: 0,
    }],
  },
  {
    id: "team-b",
    name: "Team B",
    comboHash: "team-b",
    strategy: "architect_worker",
    roles: [{
      role: "architect", slot: "architect", providerId: "test", modelId: "b",
      displayName: "B", reasoningEffort: "medium", temperature: 0,
    }],
  },
];

function runRecord(): BenchmarkRun {
  return {
    id: "shared-team-run",
    suiteId: "suite-teamiq",
    name: "team",
    domain: "model-call",
    status: "running",
    startedAt: now,
    source: "manual",
    modelIds: [],
    caseIds: [caseRecord.id],
    summaryJson: JSON.stringify({ mode: "certified", track: "teamiq" }),
    metricValueIds: [],
    artifactIds: [],
    failureIds: [],
    resultSetIds: [],
  };
}

function pending(id: string): Omit<BenchmarkResultSet, "status" | "createdAt" | "metrics"> {
  return {
    id,
    schemaVersion: 1,
    executionId: "execution-team",
    anchorRunId: "shared-team-run",
    runIds: ["shared-team-run"],
    configurationKey: `${id}-key`,
    configuration: {
      subjectKind: id.startsWith("solo") ? "model" : "team",
      displayName: id,
      roles: [],
      tracks: [{
        track: "teamiq",
        suiteId: "suite-teamiq",
        caseManifest: [{
          caseId: caseRecord.id,
          caseVersion: caseRecord.caseVersion,
          scoringVersion: caseRecord.scoring.scoringVersion,
        }],
        maxTokens: null,
      }],
    },
    expectedAttempts: [{
      runId: "shared-team-run",
      track: "teamiq",
      suiteId: "suite-teamiq",
      caseId: caseRecord.id,
      caseVersion: caseRecord.caseVersion,
      scoringVersion: caseRecord.scoring.scoringVersion,
      teamCompositionId: id,
    }],
  };
}

__clearClientStoreForTests();
__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseRecord);
await saveBenchmarkRun(runRecord());
for (const team of teams) await saveBenchmarkTeamComposition(team);
for (const team of teams) await createPendingBenchmarkResultSet(pending(team.id));

const callbacks: string[] = [];
const toolCase = TOOL_RELIABILITY_CASES.find(
  (candidate) => candidate.kind === "write-scope"
)!;
const summary = await runCertifiedBenchmark({
  runId: "shared-team-run",
  suiteId: "suite-teamiq",
  track: "teamiq",
  harnessProfile: "aiboard-panel",
  caseIds: [caseRecord.id],
  teamCompositionIds: teams.map((team) => team.id),
  certification,
  resultSetOwnership: {
    byTeamCompositionId: { "solo-a": "solo-a", "team-b": "team-b" },
  },
  onSubjectCompleted: async (teamCompositionId) => {
    callbacks.push(teamCompositionId);
    await publishBenchmarkResultSetIfComplete(teamCompositionId);
  },
  runner: (context) =>
    runCertifiedTeamIq({
      context,
      teamCompositions: teams,
      task: { kind: "toolreliability", casePack: [toolCase] },
      includeSoloBaselines: false,
      streamChat: async function* ({ params }) {
        if (params.model === "b") {
          throw new Error("composition B infrastructure failed");
        }
        const prompt = params.messages
          .map((message) => message.content)
          .join("\n");
        const turn =
          (prompt.match(/Turn \d+ - you replied:/g) ?? []).length;
        yield {
          type: "token",
          content:
            STATEFUL_REFERENCE_TRANSCRIPTS[toolCase.id]?.[turn] ?? "done",
        };
        yield { type: "done" };
      },
    }),
});
assert.equal(summary.status, "failed");
await failBenchmarkResultSet("team-b", {
  kind: "infrastructure",
  code: "runner_failed",
  message: "composition B infrastructure failed",
});
assert.deepEqual(callbacks, ["solo-a"]);
assert.deepEqual(
  (await listBenchmarkResultSets()).map(({ id, status }) => [id, status]),
  [["solo-a", "completed"], ["team-b", "failed"]]
);
const ownedA = (await listBenchmarkAttemptsV2()).find((item) => item.teamCompositionId === "solo-a");
assert.equal(ownedA?.resultSetId, "solo-a");

console.log("PASS benchmark team result publication");
