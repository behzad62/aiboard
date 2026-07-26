/* Certified TeamIQ partial-persistence checks
 * (run: npx tsx scripts/test-certified-teamiq-partial-persistence.mts)
 */
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  listBenchmarkFailures,
  listBenchmarkRuns,
  listBenchmarkTeamCompositions,
  listBenchmarkTraces,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelEvidenceProfile } from "../components/benchmark/results/ModelEvidenceProfile";
import { withCertifiedDeleteMetadata } from "../components/benchmark/useBenchmarkDashboard";
import { readLeaderboard } from "../lib/benchmark/certified/dashboard-selectors";
import { rebuildCertifiedDashboardData } from "../lib/benchmark/certified/run-persistence";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability";
import { runCertifiedTeamIq } from "../lib/benchmark/teamiq";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";
import type { StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const now = "2026-07-26T00:00:00.000Z";
const benchmarkCase: BenchmarkCaseV2 = {
  id: "teamiq-partial-persistence-case",
  schemaVersion: 2,
  track: "teamiq",
  title: "TeamIQ partial persistence",
  description: "One-case Tool Reliability task for TeamIQ persistence coverage.",
  difficulty: "easy",
  tags: ["teamiq", "partial-persistence"],
  caseVersion: "1.0.0",
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Complete the Tool Reliability case.",
  },
  environment: {
    type: "browser",
    timeoutSeconds: 30,
    network: "none",
  },
  verifier: {
    scorer: "rule-checker",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: 20,
  },
  scoring: {
    scoringVersion: "teamiq-toolreliability-v2",
    primary: "team_lift",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-TEAMIQ-PARTIAL-PERSISTENCE",
    referenceSolutionPrivate: true,
  },
};

function singleModelTeam(input: {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
}): BenchmarkTeamComposition {
  return {
    id: input.id,
    name: input.displayName,
    comboHash: `combo:${input.id}`,
    strategy: "solo",
    roles: [
      {
        role: "single",
        slot: "single",
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        reasoningEffort: "none",
        temperature: 0,
      },
    ],
  };
}

const firstSolo = singleModelTeam({
  id: "unused-derived-first",
  providerId: "first-provider",
  modelId: "first-provider:first-model",
  displayName: "First model",
});
const secondSolo = singleModelTeam({
  id: "unused-derived-second",
  providerId: "second-provider",
  modelId: "second-provider:second-model",
  displayName: "Second model",
});
const firstTeam: BenchmarkTeamComposition = {
  id: "teamiq-partial-team-round-robin",
  name: "First + Second round robin",
  comboHash: "combo:partial-round-robin",
  strategy: "panel",
  roles: [
    { ...firstSolo.roles[0]!, role: "specialist", slot: "specialist-1" },
    { ...secondSolo.roles[0]!, role: "specialist", slot: "specialist-2" },
  ],
};
const secondTeam: BenchmarkTeamComposition = {
  ...firstTeam,
  id: "teamiq-partial-team-specialist",
  name: "First + Second specialist",
  comboHash: "combo:partial-specialist",
  strategy: "debate",
};
const toolCase = TOOL_RELIABILITY_CASES.find(
  (candidate) => candidate.kind === "write-scope"
)!;

function turnIndex(prompt: string): number {
  return (prompt.match(/Turn \d+ - you replied:/g) ?? []).length;
}

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(benchmarkCase);
await saveBenchmarkTeamComposition(firstTeam);
await saveBenchmarkTeamComposition(secondTeam);

const originalDateNow = Date.now;
let controlledNowMs = originalDateNow();
let secondProviderCalls = 0;
let durableCompositionIdsAtFirstExecution: string[] = [];
Date.now = () => controlledNowMs;
try {
  await runCertifiedBenchmark({
    runId: "run-certified-teamiq-partial-persistence",
    suiteId: "suite-certified-teamiq",
    track: "teamiq",
    harnessProfile: "raw-single-model",
    caseIds: [benchmarkCase.id],
    teamCompositionIds: [firstTeam.id, secondTeam.id],
    modelBudget: { maxWallClockMs: 3_600_000 },
    certification: runHarnessCertification("raw-single-model"),
    runner: (context) =>
      runCertifiedTeamIq({
        context,
        teamCompositions: [firstTeam, secondTeam],
        task: {
          kind: "toolreliability",
          casePack: [toolCase],
        },
        includeSoloBaselines: true,
        pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1 },
        streamChat: async function* ({
          providerId,
          params,
        }): AsyncIterable<StreamChunk> {
          if (durableCompositionIdsAtFirstExecution.length === 0) {
            const durableRun = (await listBenchmarkRuns()).find(
              (run) => run.id === context.runId && run.status === "running"
            );
            const summary = durableRun
              ? (JSON.parse(durableRun.summaryJson) as {
                  teamCompositionIds?: string[];
                })
              : {};
            durableCompositionIdsAtFirstExecution =
              summary.teamCompositionIds ?? [];
          }
          if (providerId === secondSolo.roles[0]!.providerId) {
            secondProviderCalls += 1;
          }
          const prompt = params.messages
            .map((message) => message.content)
            .join("\n");
          const content =
            STATEFUL_REFERENCE_TRANSCRIPTS[toolCase.id]?.[turnIndex(prompt)] ??
            "done";
          yield { type: "token", content };
          yield { type: "done" };
          if (
            providerId === secondSolo.roles[0]!.providerId &&
            secondProviderCalls === 1
          ) {
            controlledNowMs += 3_610_000;
          }
        },
      }),
  });
} finally {
  Date.now = originalDateNow;
}

const attempts = await listBenchmarkAttemptsV2();
const persistedTeams = await listBenchmarkTeamCompositions();
const traces = await listBenchmarkTraces();
const derivedSolos = persistedTeams.filter(
  (team) =>
    team.roles.length === 1 &&
    [firstSolo.roles[0]!.modelId, secondSolo.roles[0]!.modelId].includes(
      team.roles[0]!.modelId
    )
);
const completed = attempts.find((attempt) => {
  const composition = derivedSolos.find(
    (team) => team.id === attempt.teamCompositionId
  );
  return composition?.roles[0]?.modelId === firstSolo.roles[0]!.modelId;
});
const failed = attempts.find((attempt) => {
  const composition = derivedSolos.find(
    (team) => team.id === attempt.teamCompositionId
  );
  return composition?.roles[0]?.modelId === secondSolo.roles[0]!.modelId;
});

check(
  "completed expanded solo survives a later solo failure",
  completed?.status === "passed"
);
check(
  "current and remaining expanded compositions receive budget evidence",
  failed?.status === "failed_budget" &&
    attempts.length === 4 &&
    attempts.filter((attempt) => attempt.status === "failed_budget").length === 3 &&
    [firstTeam.id, secondTeam.id].every((teamId) =>
      attempts.some(
        (attempt) =>
          attempt.teamCompositionId === teamId &&
          attempt.status === "failed_budget"
      )
    ),
  attempts
);
check(
  "every expanded composition is registered before failure synthesis",
  derivedSolos.length === 2 &&
    attempts.every((attempt) =>
      persistedTeams.some((team) => team.id === attempt.teamCompositionId)
    ),
  { derivedSolos, attempts }
);
check(
  "expanded composition ids are durable before the first composition executes",
  persistedTeams.every((team) =>
    durableCompositionIdsAtFirstExecution.includes(team.id)
  ),
  { durableCompositionIdsAtFirstExecution, persistedTeams }
);
check(
  "completed TeamIQ solo is not recorded twice",
  attempts.filter((attempt) => attempt.id === completed?.id).length === 1
);
const failedOwnedTraces = traces.filter(
  (trace) =>
    trace.attemptId ===
    `teamiq-attempt:run-certified-teamiq-partial-persistence:${failed?.teamCompositionId}`
);
check(
  "failed solo owns only its explicit traces and exact token/cost totals",
  failedOwnedTraces.length > 0 &&
    failed?.traceIds.length === failedOwnedTraces.length &&
    failedOwnedTraces.every((trace) => failed.traceIds.includes(trace.id)) &&
    failed.inputTokens ===
      failedOwnedTraces.reduce((sum, trace) => sum + (trace.inputTokens ?? 0), 0) &&
    failed.outputTokens ===
      failedOwnedTraces.reduce((sum, trace) => sum + (trace.outputTokens ?? 0), 0) &&
    failed.costUsd ===
      failedOwnedTraces.reduce(
        (sum, trace) => sum + (trace.estimatedUsd ?? 0),
        0
      ) &&
    completed?.traceIds.every((traceId) => !failed.traceIds.includes(traceId)),
  { failed, failedOwnedTraces, completed }
);

const dashboardWithMetadata = withCertifiedDeleteMetadata(
  await rebuildCertifiedDashboardData(),
  attempts,
  persistedTeams,
  await listBenchmarkFailures()
);
const failedRow = readLeaderboard(
  dashboardWithMetadata,
  "teamiq",
  "overall"
).find((row) => row.teamCompositionId === failed?.teamCompositionId);
const profileMarkup = failedRow
  ? renderToStaticMarkup(
      createElement(ModelEvidenceProfile, {
        id: "budget-profile",
        row: failedRow,
        onClose: () => undefined,
      })
    )
  : "";
check(
  "exact all-modes budget provenance reaches row metadata and rendered profile",
  failedRow?.failureDetails.some((detail) =>
    detail.message.includes("maxWallClockMs 3600000")
  ) === true && profileMarkup.includes("maxWallClockMs 3600000"),
  {
    failedCompositionId: failed?.teamCompositionId,
    leaderboard: readLeaderboard(dashboardWithMetadata, "teamiq", "overall"),
    failureDetails: failedRow?.failureDetails,
    profileMarkup,
  }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
