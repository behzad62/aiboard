import {
  BATTLESHIP_FLEET,
  createBattleshipShip,
  createBattleshipStateWithBoards,
  fireBattleshipShot,
  targetToLabel,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipOrientation,
  BattleshipPlayerBoard,
  BattleshipShip,
} from "@/lib/games/battleship/types";
import type {
  BattleshipGameIqAction,
  BattleshipGameIqScenario,
} from "./types";

// -----------------------------------------------------------------------------
// GameIQ Battleship targeting pack.
//
// Every scenario is authored against the REDACTED model view produced by
// gameIqModelStateView (certified-runner.ts): the model sees only its own shot
// history (target + label + result, ship id disclosed only on a sink) and the
// sizes of enemy ships still afloat — never enemy ship cells. So each decision
// below must be derivable from the shot history alone, under real hidden
// information. The scenario states are built by firing real Blue shots through
// fireBattleshipShot against hand-placed Orange fleets, so the shot history and
// hit/miss/sunk results are engine-truth, and expectedActions list EVERY
// equally-optimal target (a deterministic perfect player scores 100).
//
// Coordinate convention (matches the engine's targetToLabel and the shared
// prompt rules text): the label is the ROW letter A-J (row 0-9) followed by the
// COLUMN number 1-10 (column 0-9). So {row:2,column:3} is "C4".
//
// The paired authoring test (scripts/test-gameiq-battleship-pack.mts) replays
// each shot history against the real engine and re-derives the accepted target
// set with an independent placement enumerator, so these scenarios are provably
// correct, not merely plausible.
// -----------------------------------------------------------------------------

type ExpectedAction = {
  action: BattleshipGameIqAction;
  label: string;
  weight: number;
  note?: string;
};

function shipFor(
  id: string,
  start: BattleshipCoordinate,
  orientation: BattleshipOrientation
): BattleshipShip {
  const definition = BATTLESHIP_FLEET.find((ship) => ship.id === id);
  if (!definition) throw new Error(`Unknown ship id: ${id}`);
  return createBattleshipShip(definition, start, orientation);
}

function orangeBoard(ships: BattleshipShip[]): BattleshipPlayerBoard {
  return { ships, shotsReceived: [] };
}

// A valid, fixed Blue fleet. Blue's board is never fired upon in these
// scenarios (Blue is always the mover), so its placement is irrelevant to the
// model view; it exists only to satisfy fleet validation.
function blueBoard(): BattleshipPlayerBoard {
  return orangeBoard([
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
    shipFor("battleship", { row: 2, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 4, column: 0 }, "horizontal"),
    shipFor("submarine", { row: 6, column: 0 }, "horizontal"),
    shipFor("destroyer", { row: 8, column: 0 }, "horizontal"),
  ]);
}

// Fire an ordered list of Blue shots against the given Orange fleet, keeping the
// turn on Blue between shots so the whole history accrues to one player's view.
function blueShotHistory(
  orangeShips: BattleshipShip[],
  shots: BattleshipCoordinate[]
): BattleshipGameState {
  let state = createBattleshipStateWithBoards(blueBoard(), orangeBoard(orangeShips));
  let timestamp = 1;
  for (const shot of shots) {
    const next = fireBattleshipShot({ ...state, turn: "blue" }, shot, timestamp++);
    state = { ...next, turn: "blue" as const };
  }
  return state;
}

function cell(label: string): BattleshipCoordinate {
  const match = /^([A-J])(10|[1-9])$/.exec(label);
  if (!match) throw new Error(`Bad label: ${label}`);
  return {
    row: "ABCDEFGHIJ".indexOf(match[1]),
    column: Number(match[2]) - 1,
  };
}

function target(label: string, weight = 1, note?: string): ExpectedAction {
  const coordinate = cell(label);
  return {
    action: { target: coordinate },
    label: targetToLabel(coordinate),
    weight,
    note,
  };
}

interface ScenarioSpec {
  id: string;
  title: string;
  prompt: string;
  difficulty: BattleshipGameIqScenario["difficulty"];
  // The archetype the scenario measures; consumed by the authoring test to pick
  // the right oracle. Not sent to the model.
  archetype: string;
  orangeShips: BattleshipShip[];
  shots: string[];
  expected: ExpectedAction[];
  tags: string[];
}

function makeScenario(spec: ScenarioSpec): BattleshipGameIqScenario {
  return {
    id: spec.id,
    gameId: "battleship",
    title: spec.title,
    category: "target-priority",
    difficulty: spec.difficulty,
    version: "0.1.0",
    prompt: spec.prompt,
    initialState: blueShotHistory(spec.orangeShips, spec.shots.map(cell)),
    expectedActions: spec.expected,
    tags: ["battleship", ...spec.tags],
  };
}

// Task-neutral prompts: they describe the situation abstractly and never name
// the tactic, the answer, or a ship location. (Scenario titles/notes never
// reach the model — see gameIqScenarioPrompt — but the prompt strings do.)
const CONTINUE_PROMPT =
  "Blue to move. Study your shot history and choose the single target coordinate that most efficiently develops your attack against the hidden enemy fleet.";

// -----------------------------------------------------------------------------
// Kept legacy scenario. Its id and state are referenced by the shared-layer
// guard test (scripts/test-gameiq-shared-guards.mts), so it stays stable. It is
// a legitimate edge-blocked line continuation: two collinear hits at A1,A2 sit
// on the top edge, so the only live end is A3.
// -----------------------------------------------------------------------------
const firstCarrierHitState = fireBattleshipShot(
  createBattleshipStateWithBoards(blueBoard(), orangeBoard([
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
    shipFor("battleship", { row: 2, column: 1 }, "vertical"),
    shipFor("cruiser", { row: 4, column: 5 }, "horizontal"),
    shipFor("submarine", { row: 6, column: 8 }, "vertical"),
    shipFor("destroyer", { row: 8, column: 2 }, "horizontal"),
  ])),
  { row: 0, column: 0 },
  0
);
const followCarrierLineState: BattleshipGameState = {
  ...fireBattleshipShot(
    { ...firstCarrierHitState, turn: "blue" },
    { row: 0, column: 1 },
    1
  ),
  turn: "blue",
};

const FOLLOW_LINE_SCENARIO: BattleshipGameIqScenario = {
  id: "gameiq-v0.1-battleship-follow-line",
  gameId: "battleship",
  title: "Battleship: continue an edge-blocked hit line",
  category: "target-priority",
  difficulty: "easy",
  version: "0.1.0",
  prompt: CONTINUE_PROMPT,
  initialState: followCarrierLineState,
  expectedActions: [
    target(
      "A3",
      1,
      "Two collinear hits on the top edge; the only open end continues the line."
    ),
  ],
  tags: ["battleship", "line-extension"],
};

// -----------------------------------------------------------------------------
// Distinct targeting decisions under hidden information.
// -----------------------------------------------------------------------------
const AUTHORED_SCENARIOS: BattleshipGameIqScenario[] = [
  // (1) Line extension — two collinear hits, both ends open water: extend either
  // end. Horizontal run.
  makeScenario({
    id: "gameiq-v0.1-battleship-line-extend-open-h",
    title: "Battleship: extend an open two-hit line (horizontal)",
    prompt: CONTINUE_PROMPT,
    difficulty: "easy",
    archetype: "line-extension",
    orangeShips: [
      shipFor("battleship", { row: 2, column: 2 }, "horizontal"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("cruiser", { row: 5, column: 5 }, "horizontal"),
      shipFor("submarine", { row: 7, column: 8 }, "vertical"),
      shipFor("destroyer", { row: 9, column: 0 }, "horizontal"),
    ],
    shots: ["C5", "C6"],
    expected: [
      target("C4", 1, "Extend the horizontal hit line to the left end."),
      target("C7", 1, "Extend the horizontal hit line to the right end."),
    ],
    tags: ["line-extension", "target-mode"],
  }),
  // (1b) Line extension — vertical run, both ends open.
  makeScenario({
    id: "gameiq-v0.1-battleship-line-extend-open-v",
    title: "Battleship: extend an open two-hit line (vertical)",
    prompt: CONTINUE_PROMPT,
    difficulty: "easy",
    archetype: "line-extension",
    orangeShips: [
      shipFor("submarine", { row: 3, column: 6 }, "vertical"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("battleship", { row: 8, column: 2 }, "horizontal"),
      shipFor("cruiser", { row: 0, column: 7 }, "horizontal"),
      shipFor("destroyer", { row: 6, column: 0 }, "horizontal"),
    ],
    shots: ["D7", "E7"],
    expected: [
      target("C7", 1, "Extend the vertical hit line upward."),
      target("F7", 1, "Extend the vertical hit line downward."),
    ],
    tags: ["line-extension", "target-mode"],
  }),
  // (2) Blocked-line reversal — one end dead by a miss; reverse to the live end.
  makeScenario({
    id: "gameiq-v0.1-battleship-reverse-after-miss",
    title: "Battleship: reverse a hit line blocked by a miss",
    prompt: CONTINUE_PROMPT,
    difficulty: "medium",
    archetype: "blocked-reversal",
    orangeShips: [
      shipFor("battleship", { row: 2, column: 2 }, "horizontal"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("cruiser", { row: 5, column: 5 }, "horizontal"),
      shipFor("submarine", { row: 7, column: 8 }, "vertical"),
      shipFor("destroyer", { row: 9, column: 0 }, "horizontal"),
    ],
    shots: ["C5", "C6", "C7"],
    expected: [
      target("C4", 1, "The right end missed; the only live end is to the left."),
    ],
    tags: ["blocked-reversal", "target-mode"],
  }),
  // (2b) Blocked-line reversal — one end dead by the board edge.
  makeScenario({
    id: "gameiq-v0.1-battleship-reverse-at-edge",
    title: "Battleship: reverse a hit line blocked by the edge",
    prompt: CONTINUE_PROMPT,
    difficulty: "medium",
    archetype: "blocked-reversal",
    orangeShips: [
      shipFor("battleship", { row: 6, column: 0 }, "vertical"),
      shipFor("carrier", { row: 0, column: 4 }, "horizontal"),
      shipFor("cruiser", { row: 2, column: 7 }, "horizontal"),
      shipFor("submarine", { row: 4, column: 4 }, "horizontal"),
      shipFor("destroyer", { row: 0, column: 0 }, "horizontal"),
    ],
    shots: ["I1", "J1"],
    expected: [
      target("H1", 1, "The line hits the bottom edge; the only live end is upward."),
    ],
    tags: ["blocked-reversal", "target-mode"],
  }),
  // (3) Single-hit orientation probe — lone hit in a corner; only two on-board
  // orthogonal neighbours are viable.
  makeScenario({
    id: "gameiq-v0.1-battleship-probe-corner",
    title: "Battleship: probe a single hit in the corner",
    prompt: CONTINUE_PROMPT,
    difficulty: "easy",
    archetype: "single-hit-probe",
    orangeShips: [
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("battleship", { row: 2, column: 2 }, "vertical"),
      shipFor("cruiser", { row: 5, column: 5 }, "horizontal"),
      shipFor("submarine", { row: 7, column: 8 }, "vertical"),
      shipFor("destroyer", { row: 9, column: 0 }, "horizontal"),
    ],
    shots: ["A1"],
    expected: [
      target("A2", 1, "Corner hit: probe along the row."),
      target("B1", 1, "Corner hit: probe down the column."),
    ],
    tags: ["single-hit-probe", "target-mode"],
  }),
  // (3b) Single-hit orientation probe — lone hit with one neighbour already a
  // miss; the three remaining orthogonal neighbours are viable.
  makeScenario({
    id: "gameiq-v0.1-battleship-probe-after-miss",
    title: "Battleship: probe a single hit with one miss nearby",
    prompt: CONTINUE_PROMPT,
    difficulty: "medium",
    archetype: "single-hit-probe",
    orangeShips: [
      shipFor("cruiser", { row: 4, column: 4 }, "horizontal"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("battleship", { row: 2, column: 2 }, "vertical"),
      shipFor("submarine", { row: 7, column: 8 }, "vertical"),
      shipFor("destroyer", { row: 9, column: 0 }, "horizontal"),
    ],
    shots: ["E4", "E5"],
    expected: [
      target("D5", 1, "Probe upward from the hit."),
      target("F5", 1, "Probe downward from the hit."),
      target("E6", 1, "Probe along the row away from the miss."),
    ],
    tags: ["single-hit-probe", "target-mode"],
  }),
  // (5) Remaining-ship-size / orientation constraint — a lone hit whose two
  // horizontal neighbours are BOTH misses, so no ship can lie horizontally
  // through it: the orientation is forced vertical.
  makeScenario({
    id: "gameiq-v0.1-battleship-orientation-forced",
    title: "Battleship: forced orientation from flanking misses",
    prompt: CONTINUE_PROMPT,
    difficulty: "hard",
    archetype: "orientation-forced",
    orangeShips: [
      shipFor("battleship", { row: 3, column: 4 }, "vertical"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("cruiser", { row: 0, column: 6 }, "horizontal"),
      shipFor("submarine", { row: 8, column: 0 }, "horizontal"),
      shipFor("destroyer", { row: 9, column: 8 }, "horizontal"),
    ],
    shots: ["E5", "E4", "E6"],
    expected: [
      target("D5", 1, "Both row neighbours missed; the ship must run vertically (up)."),
      target("F5", 1, "Both row neighbours missed; the ship must run vertically (down)."),
    ],
    tags: ["size-constraint", "orientation-forced", "target-mode"],
  }),
  // (4) Sunk-to-hunt transition — a two-cell ship is sunk (fully resolved by two
  // adjacent hits), while a separate isolated hit remains: return to targeting
  // the still-afloat contact, not the resolved wreck.
  makeScenario({
    id: "gameiq-v0.1-battleship-return-after-sink",
    title: "Battleship: return to an open hit after a sink",
    prompt: CONTINUE_PROMPT,
    difficulty: "hard",
    archetype: "return-to-hit",
    orangeShips: [
      shipFor("destroyer", { row: 6, column: 2 }, "horizontal"),
      shipFor("cruiser", { row: 5, column: 3 }, "horizontal"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("battleship", { row: 8, column: 3 }, "horizontal"),
      shipFor("submarine", { row: 4, column: 9 }, "vertical"),
    ],
    shots: ["G3", "G4", "F5"],
    expected: [
      target("E5", 1, "Probe the unresolved contact (up)."),
      target("F4", 1, "Probe the unresolved contact (left)."),
      target("F6", 1, "Probe the unresolved contact (right)."),
      target("G5", 1, "Probe the unresolved contact (down)."),
    ],
    tags: ["sunk-transition", "return-to-hit", "target-mode"],
  }),
  // (6) Constraining history — two collinear hits with exactly one unshot cell
  // between them: any ship covering both must cover the gap, so the sandwiched
  // cell is a guaranteed hit and uniquely optimal.
  makeScenario({
    id: "gameiq-v0.1-battleship-fill-gap",
    title: "Battleship: fill the guaranteed gap between two hits",
    prompt: CONTINUE_PROMPT,
    difficulty: "hard",
    archetype: "gap-fill",
    orangeShips: [
      shipFor("cruiser", { row: 4, column: 4 }, "horizontal"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("battleship", { row: 2, column: 7 }, "vertical"),
      shipFor("submarine", { row: 7, column: 1 }, "horizontal"),
      shipFor("destroyer", { row: 9, column: 8 }, "horizontal"),
    ],
    shots: ["E5", "E7"],
    expected: [
      target("E6", 1, "The gap between two collinear hits must be part of the ship."),
    ],
    tags: ["gap-fill", "guaranteed-hit", "target-mode"],
  }),
  // (6b) Constraining history — vertical gap variant, so the guaranteed-gap
  // decision is exercised on both axes.
  makeScenario({
    id: "gameiq-v0.1-battleship-fill-gap-v",
    title: "Battleship: fill the guaranteed vertical gap",
    prompt: CONTINUE_PROMPT,
    difficulty: "hard",
    archetype: "gap-fill",
    orangeShips: [
      shipFor("cruiser", { row: 3, column: 3 }, "vertical"),
      shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
      shipFor("battleship", { row: 7, column: 6 }, "horizontal"),
      shipFor("submarine", { row: 0, column: 8 }, "vertical"),
      shipFor("destroyer", { row: 9, column: 0 }, "horizontal"),
    ],
    shots: ["D4", "F4"],
    expected: [
      target("E4", 1, "The gap between two collinear vertical hits must be part of the ship."),
    ],
    tags: ["gap-fill", "guaranteed-hit", "target-mode"],
  }),
];

export const BATTLESHIP_GAMEIQ_SCENARIOS: BattleshipGameIqScenario[] = [
  FOLLOW_LINE_SCENARIO,
  ...AUTHORED_SCENARIOS,
];
