import { readFileSync } from "node:fs";

const source = readFileSync("app/games/codenames-game-client.tsx", "utf8");

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  }
}

const seatAssignment = source.match(
  /const neededSeat = useMemo\(\(\) =>\s*requiredSeat\(gameState\),\s*\[gameState\]\s*\);/
);
assert(
  Boolean(seatAssignment),
  "Codenames AI turn seat should be memoized so state-only renders do not restart the AI effect."
);

const effectStart = source.indexOf("async function makeAIMove()");
assert(effectStart !== -1, "Codenames AI turn effect should include makeAIMove.");

const dependencyStart = source.indexOf("  }, [", effectStart);
const dependencyEnd = source.indexOf("  ]);", dependencyStart);
assert(
  dependencyStart !== -1 && dependencyEnd !== -1,
  "Codenames AI turn effect dependency list should be discoverable."
);

const dependencyList =
  dependencyStart === -1 || dependencyEnd === -1
    ? ""
    : source.slice(dependencyStart, dependencyEnd);

assert(
  !/\baiThinking\b/.test(dependencyList),
  "Codenames AI turn effect should not depend on aiThinking because it sets that state while starting a request."
);

const makeMoveBody = source.slice(effectStart, dependencyStart);
const activeFlagIndex = makeMoveBody.indexOf("aiRequestActiveRef.current = true;");
const thinkingIndex = makeMoveBody.indexOf("setAiThinking(true);");
assert(
  activeFlagIndex !== -1 && thinkingIndex !== -1 && activeFlagIndex < thinkingIndex,
  "Codenames AI turn effect should mark the request active before setting UI thinking state."
);

if (process.exitCode) process.exit(process.exitCode);
console.log("PASS codenames AI turn effect regression");
