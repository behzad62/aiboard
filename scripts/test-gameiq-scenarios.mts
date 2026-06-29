/* Certified GameIQ scenario pack checks (run: npx tsx scripts/test-gameiq-scenarios.mts) */
import {
  getGameIqScenarioPack,
  listGameIqScenarioPacks,
  stableGameIqScenarioPackDigest,
  validateGameIqScenario,
} from "../lib/benchmark/gameiq";
import { fromFEN, getPiece } from "../lib/games/chess/engine";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const firstListing = listGameIqScenarioPacks();
const secondListing = listGameIqScenarioPacks();
check(
  "scenario packs load deterministically",
  JSON.stringify(firstListing) === JSON.stringify(secondListing),
  { firstListing, secondListing }
);

const packIds = firstListing.map((pack) => pack.id);
check(
  "GameIQ exposes shipped game packs",
  [
    "gameiq-v0.1-connect-four",
    "gameiq-v0.1-chess",
    "gameiq-v0.1-battleship",
    "gameiq-v0.1-codenames",
    "gameiq-fireworks-basic-v1",
    "gameiq-fireworks-hard-v1",
    "gameiq-fireworks-memory-v1",
  ].every((packId) => packIds.includes(packId)),
  packIds
);

const expectedPackCounts = new Map([
  ["gameiq-v0.1-connect-four", 40],
  ["gameiq-v0.1-chess", 60],
  ["gameiq-v0.1-battleship", 25],
  ["gameiq-v0.1-codenames", 25],
  ["gameiq-fireworks-basic-v1", 20],
  ["gameiq-fireworks-hard-v1", 40],
  ["gameiq-fireworks-memory-v1", 30],
]);
for (const pack of firstListing) {
  check(
    `${pack.id} meets expected scenario count`,
    pack.scenarios.length === expectedPackCounts.get(pack.id),
    { actual: pack.scenarios.length, expected: expectedPackCounts.get(pack.id) }
  );
}

const connectFourPack = getGameIqScenarioPack("connect-four");
const chessPack = getGameIqScenarioPack("chess");
const fireworksPack = firstListing.find((pack) => pack.id === "gameiq-fireworks-basic-v1");
check(
  "Connect Four and Chess are first-class packs",
  connectFourPack?.certificationTier === "first-class" &&
    chessPack?.certificationTier === "first-class",
  { connectFourPack, chessPack }
);

const connectFourCategories = new Set(
  connectFourPack?.scenarios.map((scenario) => scenario.category) ?? []
);
check(
  "Connect Four covers required categories",
  ["win-in-one", "block-win", "trap-setup", "avoid-losing-move"].every(
    (category) => connectFourCategories.has(category)
  ),
  Array.from(connectFourCategories)
);
for (const category of [
  "win-in-one",
  "block-win",
  "trap-setup",
  "avoid-losing-move",
]) {
  check(
    `Connect Four has 10 ${category} scenarios`,
    connectFourPack?.scenarios.filter((scenario) => scenario.category === category)
      .length === 10,
    connectFourPack?.scenarios.map((scenario) => scenario.category)
  );
}

const chessCategories = new Set(
  chessPack?.scenarios.map((scenario) => scenario.category) ?? []
);
check(
  "Chess covers mate-in-one plus legal tactics",
  chessCategories.has("mate-in-one") && chessCategories.has("legal-tactic"),
  Array.from(chessCategories)
);
check(
  "Chess has at least 15 mate-in-one scenarios",
  (chessPack?.scenarios.filter((scenario) => scenario.category === "mate-in-one")
    .length ?? 0) >= 15,
  chessPack?.scenarios.map((scenario) => scenario.category)
);

check(
  "Fireworks basic GameIQ pack uses hidden-safe player views",
  fireworksPack?.scenarios.every((scenario) => {
    const text = JSON.stringify(scenario.initialState);
    return (
      text.includes("ownHand") &&
      text.includes("otherHands") &&
      !text.includes("\"deck\"") &&
      !text.includes("own-play")
    );
  }) === true,
  fireworksPack?.scenarios.map((scenario) => scenario.initialState)
);

check(
  "Fireworks has hard trap and memory stress packs",
  firstListing.some((pack) => pack.id === "gameiq-fireworks-hard-v1" && pack.scenarios.every((scenario) => scenario.difficulty !== "easy")) &&
    firstListing.some((pack) => pack.id === "gameiq-fireworks-memory-v1" && pack.scenarios.every((scenario) => scenario.difficulty === "hard")),
  firstListing.filter((pack) => pack.gameId === "fireworks").map((pack) => ({ id: pack.id, count: pack.scenarios.length }))
);

const knightQueenTactic = chessPack?.scenarios.find(
  (scenario) => scenario.id === "gameiq-v0.1-chess-knight-wins-queen"
);
if (!knightQueenTactic) {
  check("Chess knight tactic scenario is present", false);
} else {
  const expectedAction = knightQueenTactic.expectedActions[0]?.action;
  const targetPiece =
    expectedAction && "to" in expectedAction
      ? getPiece(
          fromFEN((knightQueenTactic.initialState as { fen: string }).fen),
          expectedAction.to
        )
      : null;
  check(
    "Chess knight tactic expected action captures the loose queen",
    targetPiece?.color === "black" && targetPiece.type === "queen",
    { expectedAction, targetPiece }
  );
}

for (const pack of firstListing) {
  const digestA = stableGameIqScenarioPackDigest(pack);
  const digestB = stableGameIqScenarioPackDigest(pack);
  check(
    `${pack.id} digest is stable`,
    digestA === digestB && digestA.startsWith("gameiq-v1:"),
    { digestA, digestB }
  );

  const scenarioIds = pack.scenarios.map((scenario) => scenario.id);
  check(
    `${pack.id} scenario ids are unique`,
    new Set(scenarioIds).size === scenarioIds.length,
    scenarioIds
  );

  for (const scenario of pack.scenarios) {
    const validation = validateGameIqScenario(scenario);
    check(
      `${scenario.id} validates against its game engine`,
      validation.ok,
      validation
    );
  }
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
