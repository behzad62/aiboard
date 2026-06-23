import {
  getGameBenchmarkRunner,
  listGameBenchmarkRunners,
  registerGameBenchmark,
} from "../lib/games/core/benchmark";
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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
