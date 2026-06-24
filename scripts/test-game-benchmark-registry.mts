import {
  getGameBenchmarkRunner,
  listGameBenchmarkRunners,
  registerGameBenchmark,
} from "../lib/games/core/benchmark";
import {
  connectFourMatchToGenericGameMatchRecord,
  isRecoverableConnectFourAIError,
} from "../lib/games/connect-four/benchmark";
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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
