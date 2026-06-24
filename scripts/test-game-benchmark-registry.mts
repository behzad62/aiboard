import {
  getGameBenchmarkRunner,
  listGameBenchmarkRunners,
  registerGameBenchmark,
} from "../lib/games/core/benchmark";
import {
  connectFourMatchToGenericGameMatchRecord,
  isRecoverableConnectFourAIError,
} from "../lib/games/connect-four/benchmark";
import { battleshipMatchToGenericGameMatchRecord } from "../lib/games/battleship/benchmark";
import { codenamesMatchToGenericGameMatchRecord } from "../lib/games/codenames/benchmark";
import { listRunnableGameBenchmarkDefinitions } from "../lib/games/core/benchmark-definitions";
import type { GameId } from "../lib/games/core/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const gameId = "registry-test" as GameId;
const unregister = registerGameBenchmark<{ moves: number }, { ok: boolean }>({
  gameId,
  label: "Registry Test",
  run: async (config, signal) => ({
    ok: config.moves === 12 && !signal.aborted,
  }),
});

const listed = listGameBenchmarkRunners();
check(
  "registered benchmark is listed",
  listed.some((runner) => runner.gameId === gameId && runner.label === "Registry Test"),
  listed
);

const runner = getGameBenchmarkRunner(gameId);
check("registered benchmark can be read", runner?.gameId === gameId, runner);

const result = await runner?.run({ moves: 12 }, new AbortController().signal);
check("registered benchmark can run", result && typeof result === "object" && "ok" in result && result.ok === true, result);

unregister();
check("unregister removes benchmark", getGameBenchmarkRunner(gameId) === null, listGameBenchmarkRunners());

const unregisterConnectFour = registerGameBenchmark({
  gameId: "connect-four",
  label: "AI vs AI Connect Four Benchmark",
  run: async () => [{ id: "test" }],
});

check(
  "connect four benchmark can be registered",
  getGameBenchmarkRunner("connect-four") !== null,
  listGameBenchmarkRunners()
);

unregisterConnectFour();
check(
  "connect four benchmark can be unregistered",
  getGameBenchmarkRunner("connect-four") === null,
  listGameBenchmarkRunners()
);

check(
  "connect four parse failures can use fallback",
  isRecoverableConnectFourAIError("Failed to parse AI response after multiple attempts")
);

check(
  "connect four auth failures do not use fallback",
  !isRecoverableConnectFourAIError("AI request failed: 401 Unauthorized invalid API key")
);

check(
  "connect four unknown provider failures do not use fallback",
  !isRecoverableConnectFourAIError("Unknown provider for red model: unknown")
);

const genericConnectFourRecord = connectFourMatchToGenericGameMatchRecord({
  id: "connect-four-match-1",
  timestamp: "2026-06-24T10:00:00.000Z",
  mode: "aivai",
  redModel: "openai:gpt-4.1",
  yellowModel: "anthropic:claude-sonnet-4",
  redReasoningEffort: "low",
  yellowReasoningEffort: "high",
  result: "red",
  moves: 21,
  durationMs: 12000,
  avgAiResponseMs: 750,
  invalidResponses: 2,
  fallbackMoves: 1,
});
const genericConnectFourResult = JSON.parse(
  genericConnectFourRecord.resultJson
) as { result?: string; winner?: string | null; draw?: boolean };
const genericConnectFourStats = JSON.parse(
  genericConnectFourRecord.statsJson
) as {
  moves?: number;
  durationMs?: number;
  avgAiResponseMs?: number;
  invalidResponses?: number;
  fallbackMoves?: number;
};

check(
  "connect four match converts to generic game record",
  genericConnectFourRecord.gameId === "connect-four" &&
    genericConnectFourRecord.participants.length === 2 &&
    genericConnectFourRecord.participants[0]?.id === "red" &&
    genericConnectFourRecord.participants[0]?.modelId === "openai:gpt-4.1" &&
    genericConnectFourRecord.participants[0]?.reasoningEffort === "low" &&
    genericConnectFourRecord.participants[1]?.id === "yellow" &&
    genericConnectFourRecord.participants[1]?.modelId === "anthropic:claude-sonnet-4" &&
    genericConnectFourRecord.participants[1]?.reasoningEffort === "high" &&
    genericConnectFourResult.result === "red" &&
    genericConnectFourResult.winner === "red" &&
    genericConnectFourResult.draw === false &&
    genericConnectFourStats.moves === 21 &&
    genericConnectFourStats.durationMs === 12000 &&
    genericConnectFourStats.avgAiResponseMs === 750 &&
    genericConnectFourStats.invalidResponses === 2 &&
    genericConnectFourStats.fallbackMoves === 1,
  genericConnectFourRecord
);

const runnableGameIds = listRunnableGameBenchmarkDefinitions().map(
  (definition) => definition.gameId
);
check(
  "all shipped AI games are runnable benchmark targets",
  ["chess", "connect-four", "battleship", "codenames"].every((gameId) =>
    runnableGameIds.includes(gameId)
  ),
  runnableGameIds
);

const genericBattleshipRecord = battleshipMatchToGenericGameMatchRecord({
  id: "battleship-match-1",
  timestamp: "2026-06-24T10:00:00.000Z",
  mode: "aivai",
  blueModel: "openai:gpt-4.1",
  orangeModel: "anthropic:claude-sonnet-4",
  blueReasoningEffort: "low",
  orangeReasoningEffort: "high",
  result: "blue",
  shots: 44,
  durationMs: 21000,
  avgAiResponseMs: 900,
  invalidResponses: 1,
  fallbackMoves: 2,
  placementFallbacks: 1,
});
const battleshipResult = JSON.parse(genericBattleshipRecord.resultJson) as {
  result?: string;
  winner?: string | null;
};
const battleshipStats = JSON.parse(genericBattleshipRecord.statsJson) as {
  shots?: number;
  placementFallbacks?: number;
};
check(
  "battleship match converts to generic game record",
  genericBattleshipRecord.gameId === "battleship" &&
    genericBattleshipRecord.participants.length === 2 &&
    genericBattleshipRecord.participants[0]?.id === "blue" &&
    genericBattleshipRecord.participants[1]?.id === "orange" &&
    battleshipResult.winner === "blue" &&
    battleshipStats.shots === 44 &&
    battleshipStats.placementFallbacks === 1,
  genericBattleshipRecord
);

const genericCodenamesRecord = codenamesMatchToGenericGameMatchRecord({
  id: "codenames-match-1",
  timestamp: "2026-06-24T10:00:00.000Z",
  mode: "aivai",
  redModel: "openai:gpt-4.1",
  blueModel: "anthropic:claude-sonnet-4",
  redReasoningEffort: "low",
  blueReasoningEffort: "high",
  result: "blue",
  turns: 8,
  moves: 19,
  durationMs: 32000,
  avgAiResponseMs: 1100,
  invalidResponses: 3,
  fallbackMoves: 2,
  assassinHits: 1,
});
const codenamesResult = JSON.parse(genericCodenamesRecord.resultJson) as {
  result?: string;
  winner?: string | null;
};
const codenamesStats = JSON.parse(genericCodenamesRecord.statsJson) as {
  turns?: number;
  assassinHits?: number;
};
check(
  "codenames match converts to generic game record",
  genericCodenamesRecord.gameId === "codenames" &&
    genericCodenamesRecord.participants.length === 4 &&
    genericCodenamesRecord.participants[0]?.id === "red-spymaster" &&
    genericCodenamesRecord.participants[1]?.id === "red-operative" &&
    genericCodenamesRecord.participants[2]?.id === "blue-spymaster" &&
    genericCodenamesRecord.participants[3]?.id === "blue-operative" &&
    codenamesResult.winner === "blue" &&
    codenamesStats.turns === 8 &&
    codenamesStats.assassinHits === 1,
  genericCodenamesRecord
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
