/* Certified GameIQ v0.1 scenario pack checks (run: npx tsx scripts/test-gameiq-scenarios.mts) */
import {
  getGameIqScenarioPack,
  listGameIqScenarioPacks,
  listGameIqScenarios,
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

const packKeys = firstListing.map((pack) => pack.gameId);
check(
  "GameIQ v0.1 exposes shipped game packs",
  ["connect-four", "chess", "battleship", "codenames"].every((gameId) =>
    packKeys.includes(gameId)
  ),
  packKeys
);

const connectFourPack = getGameIqScenarioPack("connect-four");
const chessPack = getGameIqScenarioPack("chess");
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
  "Connect Four covers required v0.1 categories",
  ["win-in-one", "block-win", "trap-setup", "avoid-losing-move"].every(
    (category) => connectFourCategories.has(category)
  ),
  Array.from(connectFourCategories)
);

const chessCategories = new Set(
  chessPack?.scenarios.map((scenario) => scenario.category) ?? []
);
check(
  "Chess covers mate-in-one plus legal tactics",
  chessCategories.has("mate-in-one") && chessCategories.has("legal-tactic"),
  Array.from(chessCategories)
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
    `${pack.gameId} digest is stable`,
    digestA === digestB && digestA.startsWith("gameiq-v0.1:"),
    { digestA, digestB }
  );

  const scenarioIds = pack.scenarios.map((scenario) => scenario.id);
  check(
    `${pack.gameId} scenario ids are unique`,
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

const allScenarios = listGameIqScenarios();
check(
  "flattened scenario list is deterministic",
  JSON.stringify(allScenarios) === JSON.stringify(listGameIqScenarios()),
  allScenarios.map((scenario) => scenario.id)
);
check(
  "flattened scenario list has no duplicate ids",
  new Set(allScenarios.map((scenario) => scenario.id)).size ===
    allScenarios.length,
  allScenarios.map((scenario) => scenario.id)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
