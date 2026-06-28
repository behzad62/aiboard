/* Fireworks benchmark UI checks (run: npx tsx scripts/test-fireworks-ui.tsx) */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FireworksBenchmarkSummary } from "../components/benchmark/fireworks/FireworksBenchmarkSummary";
import { FireworksTranscriptViewer } from "../components/benchmark/fireworks/FireworksTranscriptViewer";
import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
} from "../lib/benchmark/types";
import type { FireworksGameMetrics } from "../lib/games/fireworks/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function metrics(overrides: Partial<FireworksGameMetrics>): FireworksGameMetrics {
  return {
    scoreKind: "full_game",
    scenarioQualityScore: null,
    fullGameStackScore: 10,
    fullGameTeamScore: 0.72,
    finalScore: 10,
    maxScore: 15,
    normalizedScore: 0.72,
    legalActions: 12,
    illegalActions: 0,
    fallbackActions: 1,
    cluesGiven: 4,
    usefulClues: 3,
    wastedClues: 1,
    plays: 5,
    safePlays: 4,
    badPlays: 1,
    discards: 3,
    safeDiscards: 2,
    criticalDiscards: 1,
    memoryConsistentActions: 10,
    memoryInconsistentActions: 1,
    modelCalls: 12,
    inputTokens: 1000,
    outputTokens: 300,
    costUsd: 1.2,
    durationMs: 5000,
    ...overrides,
  };
}

const attempt: BenchmarkAttemptV2 = {
  id: "attempt-fireworks-ui",
  runId: "run-fireworks-ui",
  caseId: "case-fireworks-ui",
  teamCompositionId: "team-fireworks-ui",
  mode: "certified",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  status: "failed_model",
  startedAt: "2026-06-28T10:00:00.000Z",
  completedAt: "2026-06-28T10:00:05.000Z",
  verifiedQuality: 0.72,
  jobSuccessScore: 72,
  efficiencyScore: 72,
  teamLift: 4.2,
  costUsd: 1.2,
  inputTokens: 1000,
  outputTokens: 300,
  modelCalls: 12,
  toolCalls: 0,
  durationMs: 5000,
  verifierResultId: "verifier-fireworks-ui",
  artifactIds: ["summary-fireworks-ui", "transcript-fireworks-ui"],
  traceIds: [],
  failureIds: [],
  harnessVersion: "fireworks-teamiq-runner-v0.1",
  promptSetVersion: "fireworks-action-prompts-v0.1",
  scoringVersion: "fireworks-teamiq-v0.1",
};

function artifact(id: string, content: unknown): BenchmarkArtifact {
  return {
    id,
    runId: "run-fireworks-ui",
    caseId: "case-fireworks-ui",
    attemptId: "attempt-fireworks-ui",
    kind: "json",
    label: id,
    mimeType: "application/json",
    content: JSON.stringify(content),
    createdAt: "2026-06-28T10:00:00.000Z",
  };
}

const fullSummaryMarkup = renderToStaticMarkup(
  <FireworksBenchmarkSummary
    attempt={attempt}
    artifacts={[
      artifact("attempt-fireworks-ui:fireworks-summary", {
        score: 72,
        team: "Fireworks UI Team",
        metrics: metrics({ scoreKind: "full_game" }),
        caseScores: [{ caseId: "fireworks-full-001", score: 0.72 }],
      }),
      artifact("attempt-fireworks-ui:fireworks-transcript", {
        team: "Fireworks UI Team",
        cases: [],
      }),
    ]}
  />
);
check(
  "Fireworks summary uses benchmark-point cost label",
  fullSummaryMarkup.includes("Cost / benchmark point") &&
    !fullSummaryMarkup.includes("Cost per point"),
  fullSummaryMarkup
);
check(
  "full-game Fireworks summary includes stack-point cost label",
  fullSummaryMarkup.includes("Cost / stack point"),
  fullSummaryMarkup
);

const scenarioSummaryMarkup = renderToStaticMarkup(
  <FireworksBenchmarkSummary
    attempt={attempt}
    artifacts={[
      artifact("attempt-fireworks-ui:fireworks-summary", {
        score: 80,
        team: "Fireworks UI Team",
        metrics: metrics({
          scoreKind: "scenario",
          scenarioQualityScore: 0.8,
          fullGameStackScore: null,
          fullGameTeamScore: null,
          finalScore: 0,
        }),
        caseScores: [{ caseId: "fireworks-safe-play-001", score: 0.8 }],
      }),
    ]}
  />
);
check(
  "scenario Fireworks summary keeps stack-point cost hidden",
  scenarioSummaryMarkup.includes("Scenario quality") &&
    !scenarioSummaryMarkup.includes("Cost / stack point"),
  scenarioSummaryMarkup
);

const transcriptMarkup = renderToStaticMarkup(
  <FireworksTranscriptViewer
    transcript={{
      team: "Transcript Team",
      cases: [
        {
          id: "fireworks-memory-001",
          suite: "fireworks-memory-v0.1",
          category: "combine_color_and_rank",
          score: 0.5,
          action: { action: "play", cardIndex: 1 },
          fallbackUsed: true,
          finalState: {
            stacks: { red: 1, blue: 2, green: 3 },
            events: [
              {
                turn: 0,
                playerId: "P2",
                action: { action: "play", cardIndex: 1 },
                legal: true,
                fallbackUsed: true,
                playResult: "misplay",
                criticalDiscard: false,
                resultingScore: 6,
                message: "P2 misplayed red 4.",
              },
              {
                turn: 1,
                playerId: "P1",
                action: { action: "discard", cardIndex: 0 },
                legal: true,
                fallbackUsed: false,
                criticalDiscard: true,
                resultingScore: 6,
                message: "P1 discarded a critical card.",
              },
            ],
          },
        },
      ],
    }}
  />
);
check(
  "Fireworks transcript renders structured case and turn details",
    transcriptMarkup.includes("fireworks-memory-001") &&
    transcriptMarkup.includes("combine_color_and_rank") &&
    transcriptMarkup.includes("Final score") &&
    transcriptMarkup.includes("Turn 1") &&
    !transcriptMarkup.includes("Turn 0") &&
    transcriptMarkup.includes("Fallback") &&
    transcriptMarkup.includes("Bad play") &&
    transcriptMarkup.includes("Critical discard") &&
    transcriptMarkup.includes("red 1") &&
    !transcriptMarkup.includes("{&quot;team&quot;"),
  transcriptMarkup
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
