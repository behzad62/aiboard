/* Fireworks scoring checks (run: npx tsx scripts/test-fireworks-scoring.mts) */
import {
  computeFireworksGameMetrics,
  scoreFireworksTeamIq,
} from "../lib/games/fireworks/scoring";
import { createFireworksGame } from "../lib/games/fireworks/engine";
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
    finalScore: 0,
    maxScore: 15,
    normalizedScore: 0,
    legalActions: 0,
    illegalActions: 0,
    fallbackActions: 0,
    cluesGiven: 0,
    usefulClues: 0,
    wastedClues: 0,
    plays: 0,
    safePlays: 0,
    badPlays: 0,
    discards: 0,
    safeDiscards: 0,
    criticalDiscards: 0,
    memoryConsistentActions: 0,
    memoryInconsistentActions: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    durationMs: 0,
    ...overrides,
  } as FireworksGameMetrics;
}

const emptyScore = scoreFireworksTeamIq({ metrics: metrics({}) });
check(
  "empty Fireworks action history is not rewarded with perfect positive rates",
  emptyScore === 20,
  emptyScore
);

const noClueNoPlayScore = scoreFireworksTeamIq({
  metrics: metrics({
    finalScore: 3,
    normalizedScore: 0.2,
    legalActions: 5,
    discards: 5,
    safeDiscards: 5,
    memoryConsistentActions: 5,
  }),
});
check(
  "teams that never clue or play do not receive useful-clue or safe-play credit",
  noClueNoPlayScore < 50,
  noClueNoPlayScore
);

const fullGameState = createFireworksGame({
  seed: "scoring-full-game",
  players: [
    { id: "P1", label: "Player 1", kind: "human" },
    { id: "P2", label: "Player 2", kind: "human" },
  ],
});
const fullGameMetrics = computeFireworksGameMetrics({ state: fullGameState }) as
  FireworksGameMetrics & Record<string, unknown>;
check(
  "full-game metrics expose full-game score kind and stack/team scores",
  fullGameMetrics.scoreKind === "full_game" &&
    typeof fullGameMetrics.fullGameStackScore === "number" &&
    typeof fullGameMetrics.fullGameTeamScore === "number" &&
    fullGameMetrics.scenarioQualityScore === null,
  fullGameMetrics
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
