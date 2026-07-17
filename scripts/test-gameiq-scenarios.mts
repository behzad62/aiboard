/* Certified GameIQ scenario pack checks (run: npx tsx scripts/test-gameiq-scenarios.mts) */
import {
  getGameIqScenarioPack,
  listGameIqScenarioPacks,
  stableStringify,
  stableGameIqScenarioPackDigest,
  validateGameIqScenario,
} from "../lib/benchmark/gameiq";
import { FIREWORKS_TACTICS_SCENARIOS } from "../lib/benchmark/fireworks/scenario-packs";
import { toGameIqScenario } from "../lib/benchmark/gameiq/fireworks";

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
    "gameiq-v0.2-connect-four",
    "gameiq-v0.2-chess",
    "gameiq-v0.2-battleship",
    "gameiq-v0.1-codenames",
    "gameiq-fireworks-basic-v1",
    "gameiq-fireworks-hard-v1",
    "gameiq-fireworks-memory-v1",
  ].every((packId) => packIds.includes(packId)),
  packIds
);

const expectedPackCounts = new Map([
  ["gameiq-v0.2-connect-four", 12],
  ["gameiq-v0.2-chess", 12],
  ["gameiq-v0.2-battleship", 15],
  ["gameiq-v0.1-codenames", 10],
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

const distinctFloor = new Map([
  ["gameiq-v0.1-codenames", 10],
]);
for (const pack of firstListing) {
  const floor = distinctFloor.get(pack.id);
  if (floor === undefined) continue;
  const tuples = new Set(
    pack.scenarios.map((scenario) =>
      stableStringify({
        initialState: scenario.initialState,
        expectedActions: scenario.expectedActions,
      })
    )
  );
  check(
    `${pack.id} has distinct (initialState, expectedActions) tuples`,
    tuples.size === pack.scenarios.length && tuples.size >= floor,
    { distinct: tuples.size, scenarios: pack.scenarios.length }
  );
}

const connectFourPack = getGameIqScenarioPack("connect-four");
const chessPack = getGameIqScenarioPack("chess");
const battleshipPack = getGameIqScenarioPack("battleship");
const fireworksPack = firstListing.find((pack) => pack.id === "gameiq-fireworks-basic-v1");
check(
  "Connect Four, Chess, and Battleship (the sole v0.2 pack per game) are all first-class",
  connectFourPack?.certificationTier === "first-class" &&
    chessPack?.certificationTier === "first-class" &&
    battleshipPack?.certificationTier === "first-class",
  {
    connectFour: connectFourPack?.certificationTier,
    chess: chessPack?.certificationTier,
    battleship: battleshipPack?.certificationTier,
  }
);

const connectFourCategories = new Set(
  connectFourPack?.scenarios.map((scenario) => scenario.category) ?? []
);
check(
  "Connect Four v2 uses the solver-keyed depth-only-move category",
  connectFourCategories.has("depth-only-move") && connectFourCategories.size === 1,
  Array.from(connectFourCategories)
);

const chessCategories = new Set(
  chessPack?.scenarios.map((scenario) => scenario.category) ?? []
);
check(
  "Chess v2 uses the prover-keyed quiet-mate category",
  chessCategories.has("quiet-mate") && chessCategories.size === 1,
  Array.from(chessCategories)
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

const fireworksMemoryPack = firstListing.find(
  (pack) => pack.id === "gameiq-fireworks-memory-v1"
);
check(
  "Fireworks GameIQ views do not leak optimal-move recommendations",
  firstListing
    .filter((pack) => pack.gameId === "fireworks")
    .every((pack) =>
      pack.scenarios.every((scenario) => {
        const recommendations = (
          scenario.initialState as {
            recommendations?: {
              knownPlayableCards?: unknown[];
              visiblePlayableClues?: unknown[];
            };
          }
        ).recommendations;
        return (
          (recommendations?.knownPlayableCards?.length ?? 0) === 0 &&
          (recommendations?.visiblePlayableClues?.length ?? 0) === 0
        );
      })
    ) === true,
  "model-facing recommendations must be empty"
);
check(
  "Fireworks memory scenarios hide the player's own resolved identity",
  fireworksMemoryPack?.scenarios.every((scenario) => {
    const ownHand = (
      scenario.initialState as {
        ownHand?: {
          cards?: Array<{
            color?: unknown;
            rank?: unknown;
            knowledge?: { color?: unknown; rank?: unknown };
          }>;
        };
      }
    ).ownHand;
    return (ownHand?.cards ?? []).every(
      (card) =>
        card.color == null &&
        card.rank == null &&
        card.knowledge?.color == null &&
        card.knowledge?.rank == null
    );
  }) === true,
  fireworksMemoryPack?.scenarios.map((scenario) => scenario.initialState)
);

const fireworksTwoActionSource = FIREWORKS_TACTICS_SCENARIOS[0];
if (fireworksTwoActionSource) {
  const firstExpected = fireworksTwoActionSource.expectedActions[0];
  const ported = toGameIqScenario({
    scenario: {
      ...fireworksTwoActionSource,
      expectedActions: [
        firstExpected,
        {
          ...firstExpected,
          label: `${firstExpected.label} alternative`,
          weight: firstExpected.weight / 2,
        },
      ],
    },
    index: 0,
    idPrefix: "test-fireworks-port",
    titlePrefix: "Fireworks Port Test",
    difficulty: "medium",
    tags: ["test"],
  });
  check(
    "Fireworks GameIQ port keeps every expected action",
    ported.expectedActions.length === 2 &&
      ported.expectedActions[1]?.label.endsWith("alternative") &&
      ported.expectedActions[1]?.weight === firstExpected.weight / 2,
    ported.expectedActions
  );
}

// The v0.1 connect-four trap-setup / chess knight-wins-queen scenarios these
// checks used to exercise were hard-deleted 2026-07-17; the "trap-setup"
// validator itself is untouched (lib/benchmark/gameiq/validation.ts) but no
// live pack uses that category anymore, so there is no scenario left to
// spot-check it against.

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
