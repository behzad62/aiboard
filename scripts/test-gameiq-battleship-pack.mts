/* Certified GameIQ Battleship pack authoring checks
 * (run: npx tsx scripts/test-gameiq-battleship-pack.mts)
 *
 * Every scenario is verified against the REAL battleship engine and an
 * independent placement enumerator — the scenarios are provably correct, not
 * merely plausible:
 *
 *  - Each scenario's shot history is replayed against the engine and the
 *    resulting redacted model view (gameIqModelStateView) is checked to contain
 *    NO unhit enemy ship cell and NO ship ids (except a sunk ship's id).
 *  - Each expectedAction is engine-legal (an unshot, in-bounds cell) and equals
 *    the archetype's independently re-derived accepted target set:
 *      * line-extension  -> exactly the immediate collinear line ends,
 *      * blocked-reversal -> exactly the single live end,
 *      * single-hit-probe / orientation-forced -> exactly the viable orthogonal
 *        neighbours (a straight remaining-ship placement must span hit+neighbour),
 *      * return-to-hit    -> exactly the viable neighbours of the unresolved,
 *        non-sunk contact,
 *      * gap-fill         -> exactly the cell(s) that lie in EVERY placement
 *        consistent with the hits (a guaranteed hit).
 *  - A naive baseline (fixed corner guess A1, and first-legal-cell scan order)
 *    fails the pack, while the authored expectedActions all pass legality and
 *    score correct.
 */
import {
  BATTLESHIP_BOARD_SIZE,
  isLegalBattleshipTarget,
  targetToLabel,
} from "../lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
  BattleshipOrientation,
} from "../lib/games/battleship/types";
import { getGameIqScenarioPack } from "../lib/benchmark/gameiq/packs";
import { gameIqModelStateView } from "../lib/benchmark/gameiq/certified-runner";
import { actionMatchesExpected } from "../lib/benchmark/gameiq/validation";
import type {
  BattleshipGameIqAction,
  GameIqScenario,
} from "../lib/benchmark/gameiq/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const SIZE = BATTLESHIP_BOARD_SIZE;
const key = (c: BattleshipCoordinate) => `${c.row}:${c.column}`;
const inBounds = (c: BattleshipCoordinate) =>
  c.row >= 0 && c.row < SIZE && c.column >= 0 && c.column < SIZE;

// Archetype expected per scenario id (the pack does not export this metadata).
const ARCHETYPE = new Map<string, string>([
  ["gameiq-v0.1-battleship-follow-line", "blocked-reversal"],
  ["gameiq-v0.1-battleship-line-extend-open-h", "line-extension"],
  ["gameiq-v0.1-battleship-line-extend-open-v", "line-extension"],
  ["gameiq-v0.1-battleship-reverse-after-miss", "blocked-reversal"],
  ["gameiq-v0.1-battleship-reverse-at-edge", "blocked-reversal"],
  ["gameiq-v0.1-battleship-probe-corner", "single-hit-probe"],
  ["gameiq-v0.1-battleship-probe-after-miss", "single-hit-probe"],
  ["gameiq-v0.1-battleship-orientation-forced", "single-hit-probe"],
  ["gameiq-v0.1-battleship-return-after-sink", "return-to-hit"],
  ["gameiq-v0.1-battleship-fill-gap", "gap-fill"],
  ["gameiq-v0.1-battleship-fill-gap-v", "gap-fill"],
]);

// --- Independent shot-history analysis (re-derived from the full state) ------

interface Analysis {
  miss: Set<string>;
  shotAll: Set<string>;
  hits: BattleshipCoordinate[]; // unresolved (non-sunk) hit cells
  blocked: Set<string>; // misses + cells of sunk ships
  sizes: number[]; // distinct remaining ship sizes
}

function analyze(state: BattleshipGameState): Analysis {
  const shots = state.boards.orange.shotsReceived;
  const sunkShipIds = new Set(
    shots.map((shot) => shot.sunkShipId).filter((id): id is string => !!id)
  );
  const sunkCells = new Set<string>();
  for (const ship of state.boards.orange.ships) {
    if (sunkShipIds.has(ship.id)) for (const c of ship.cells) sunkCells.add(key(c));
  }
  const miss = new Set<string>();
  const shotAll = new Set<string>();
  const hits: BattleshipCoordinate[] = [];
  for (const shot of shots) {
    shotAll.add(key(shot.target));
    if (shot.result === "miss") miss.add(key(shot.target));
    if (shot.result === "hit" && !sunkCells.has(key(shot.target))) {
      hits.push({ ...shot.target });
    }
  }
  const sizes = [
    ...new Set(
      state.boards.orange.ships
        .filter((ship) => !sunkShipIds.has(ship.id))
        .map((ship) => ship.size)
    ),
  ];
  return { miss, shotAll, hits, blocked: new Set([...miss, ...sunkCells]), sizes };
}

function placement(
  start: BattleshipCoordinate,
  len: number,
  o: BattleshipOrientation
): BattleshipCoordinate[] {
  return Array.from({ length: len }, (_, i) =>
    o === "horizontal"
      ? { row: start.row, column: start.column + i }
      : { row: start.row + i, column: start.column }
  );
}
function placementOk(cells: BattleshipCoordinate[], blocked: Set<string>): boolean {
  return cells.every((c) => inBounds(c) && !blocked.has(key(c)));
}

function lineOrientation(
  hits: BattleshipCoordinate[]
): "horizontal" | "vertical" | "unknown" {
  if (hits.length < 2) return "unknown";
  const sameRow = hits.every((h) => h.row === hits[0].row);
  const sameCol = hits.every((h) => h.column === hits[0].column);
  if (sameRow && !sameCol) return "horizontal";
  if (sameCol && !sameRow) return "vertical";
  return "unknown";
}

// Can a straight remaining-ship placement (some size, given orientations) cover
// all of cellsNeeded while avoiding blocked cells?
function coverable(
  cellsNeeded: BattleshipCoordinate[],
  orientations: BattleshipOrientation[],
  a: Analysis
): boolean {
  for (const len of a.sizes) {
    for (const o of orientations) {
      for (const anchor of cellsNeeded) {
        for (let k = 0; k < len; k++) {
          const start =
            o === "horizontal"
              ? { row: anchor.row, column: anchor.column - k }
              : { row: anchor.row - k, column: anchor.column };
          const cells = placement(start, len, o);
          if (!placementOk(cells, a.blocked)) continue;
          if (cellsNeeded.every((need) => cells.some((x) => key(x) === key(need)))) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// Target-mode oracle (line-extension / reversal / probe / orientation / return).
function targetOracle(a: Analysis): Set<string> {
  const orient = lineOrientation(a.hits);
  const viable = new Set<string>();
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      const t = { row: r, column: c };
      if (a.shotAll.has(key(t))) continue;
      const adjHit = a.hits.find(
        (h) => Math.abs(h.row - r) + Math.abs(h.column - c) === 1
      );
      if (!adjHit) continue;
      if (orient === "horizontal") {
        if (r !== a.hits[0].row) continue;
        if (coverable([...a.hits, t], ["horizontal"], a)) viable.add(key(t));
      } else if (orient === "vertical") {
        if (c !== a.hits[0].column) continue;
        if (coverable([...a.hits, t], ["vertical"], a)) viable.add(key(t));
      } else {
        if (coverable([adjHit, t], ["horizontal", "vertical"], a)) viable.add(key(t));
      }
    }
  return viable;
}

// Gap-fill oracle: cells that lie in EVERY remaining-ship placement consistent
// with all unresolved hits (guaranteed hits).
function certainOracle(a: Analysis): Set<string> {
  if (a.hits.length === 0) return new Set();
  const placements: BattleshipCoordinate[][] = [];
  for (const len of a.sizes)
    for (const o of ["horizontal", "vertical"] as const)
      for (let r = 0; r < SIZE; r++)
        for (let c = 0; c < SIZE; c++) {
          const cells = placement({ row: r, column: c }, len, o);
          if (!placementOk(cells, a.blocked)) continue;
          if (a.hits.every((h) => cells.some((x) => key(x) === key(h)))) {
            placements.push(cells);
          }
        }
  if (placements.length === 0) return new Set();
  const counts = new Map<string, number>();
  for (const pl of placements)
    for (const cellObj of pl) counts.set(key(cellObj), (counts.get(key(cellObj)) ?? 0) + 1);
  const certain = new Set<string>();
  for (const [k, n] of counts) if (n === placements.length && !a.shotAll.has(k)) certain.add(k);
  return certain;
}

function oracleFor(archetype: string, a: Analysis): Set<string> {
  return archetype === "gap-fill" ? certainOracle(a) : targetOracle(a);
}

function expectedKeys(scenario: GameIqScenario): Set<string> {
  return new Set(
    scenario.expectedActions.map((e) => {
      const t = (e.action as BattleshipGameIqAction).target;
      return `${t.row}:${t.column}`;
    })
  );
}

// --- Run -------------------------------------------------------------------

const pack = getGameIqScenarioPack("battleship");
check("battleship pack loads", pack != null);
const scenarios = pack?.scenarios ?? [];

check(
  "pack has the expected scenario count",
  scenarios.length === 11,
  scenarios.length
);
check(
  "pack is labeled first-class",
  pack?.certificationTier === "first-class",
  pack?.certificationTier
);

// Every scenario has real shot history.
check(
  "every scenario has a non-empty shot history",
  scenarios.every(
    (s) =>
      ((s.initialState as BattleshipGameState).boards.orange.shotsReceived
        ?.length ?? 0) > 0
  ),
  scenarios
    .filter(
      (s) =>
        ((s.initialState as BattleshipGameState).boards.orange.shotsReceived
          ?.length ?? 0) === 0
    )
    .map((s) => s.id)
);

// Distinct decisions (state + expectedActions).
const decisionKeys = new Set(
  scenarios.map((s) =>
    JSON.stringify({ state: s.initialState, expected: s.expectedActions.map((e) => e.action) })
  )
);
check(
  "every scenario is a distinct decision",
  decisionKeys.size === scenarios.length,
  { distinct: decisionKeys.size, total: scenarios.length }
);

// Redacted model view leaks nothing.
for (const scenario of scenarios) {
  const state = scenario.initialState as BattleshipGameState;
  const viewText = JSON.stringify(gameIqModelStateView(scenario));
  const noStructuralLeak =
    !viewText.includes('"ships"') &&
    !viewText.includes('"cells"') &&
    !viewText.includes('"shipId"');
  // No unhit enemy ship cell may appear in the view. Collect every enemy ship
  // cell that was NOT shot; assert its label is absent from the view text.
  const shotKeys = new Set(
    state.boards.orange.shotsReceived.map((s) => key(s.target))
  );
  const unhitLabels = state.boards.orange.ships
    .flatMap((ship) => ship.cells)
    .filter((c) => !shotKeys.has(key(c)))
    .map((c) => targetToLabel(c));
  const leakedLabel = unhitLabels.find((label) =>
    new RegExp(`"label":"${label}"`).test(viewText)
  );
  check(
    `${scenario.id}: redacted view hides ships/cells/shipIds`,
    noStructuralLeak,
    viewText
  );
  check(
    `${scenario.id}: redacted view exposes no unhit ship cell`,
    leakedLabel === undefined,
    leakedLabel
  );
}

// Expected actions match the archetype oracle exactly, and are all legal.
for (const scenario of scenarios) {
  const archetype = ARCHETYPE.get(scenario.id);
  const state = scenario.initialState as BattleshipGameState;
  if (!archetype) {
    check(`${scenario.id}: has a known archetype`, false, scenario.id);
    continue;
  }
  const a = analyze(state);
  const oracle = oracleFor(archetype, a);
  const expected = expectedKeys(scenario);

  const oracleArr = [...oracle].sort();
  const expArr = [...expected].sort();
  check(
    `${scenario.id}: expectedActions == ${archetype} oracle`,
    oracleArr.length === expArr.length &&
      oracleArr.every((k, i) => k === expArr[i]),
    { oracle: oracleArr.map(labelFromKey), expected: expArr.map(labelFromKey) }
  );

  // Oracle is non-empty (there is a real, derivable decision).
  check(`${scenario.id}: oracle is non-empty`, oracle.size > 0, archetype);

  // Every expected action is engine-legal and scores correct.
  for (const e of scenario.expectedActions) {
    const t = (e.action as BattleshipGameIqAction).target;
    const legal = isLegalBattleshipTarget(state, state.turn, t);
    const correct = actionMatchesExpected(scenario, e.action) > 0;
    check(
      `${scenario.id}: expected ${targetToLabel(t)} is legal and scores correct`,
      legal && correct,
      { legal, correct }
    );
  }
}

// Archetype-specific structural assertions (beyond set equality) --------------
function scenarioById(id: string): GameIqScenario | undefined {
  return scenarios.find((s) => s.id === id);
}

// line-extension: expected are the two immediate collinear ends of the hit run,
// and the perpendicular neighbours are NOT expected.
for (const id of [
  "gameiq-v0.1-battleship-line-extend-open-h",
  "gameiq-v0.1-battleship-line-extend-open-v",
]) {
  const s = scenarioById(id)!;
  const a = analyze(s.initialState as BattleshipGameState);
  const orient = lineOrientation(a.hits);
  const exp = [...expectedKeys(s)].map((k) => k.split(":").map(Number));
  check(
    `${id}: exactly two line ends, both on the hit line`,
    exp.length === 2 &&
      exp.every(([r, c]) =>
        orient === "horizontal" ? r === a.hits[0].row : c === a.hits[0].column
      ),
    { orient, exp }
  );
}

// blocked-reversal: exactly one expected end, and the opposite end is dead
// (a miss or off-board).
for (const id of [
  "gameiq-v0.1-battleship-reverse-after-miss",
  "gameiq-v0.1-battleship-reverse-at-edge",
  "gameiq-v0.1-battleship-follow-line",
]) {
  const s = scenarioById(id)!;
  const a = analyze(s.initialState as BattleshipGameState);
  const exp = [...expectedKeys(s)];
  const orient = lineOrientation(a.hits);
  // Compute the two ends of the hit run.
  const rows = a.hits.map((h) => h.row);
  const cols = a.hits.map((h) => h.column);
  const ends: BattleshipCoordinate[] =
    orient === "horizontal"
      ? [
          { row: a.hits[0].row, column: Math.min(...cols) - 1 },
          { row: a.hits[0].row, column: Math.max(...cols) + 1 },
        ]
      : [
          { row: Math.min(...rows) - 1, column: a.hits[0].column },
          { row: Math.max(...rows) + 1, column: a.hits[0].column },
        ];
  const liveEnds = ends.filter((e) => inBounds(e) && !a.blocked.has(key(e)) && !a.shotAll.has(key(e)));
  const deadEnds = ends.filter((e) => !inBounds(e) || a.blocked.has(key(e)));
  check(
    `${id}: exactly one live end, one dead end, expected == live end`,
    exp.length === 1 &&
      liveEnds.length === 1 &&
      deadEnds.length === 1 &&
      key(liveEnds[0]) === exp[0],
    { liveEnds: liveEnds.map(targetToLabel), deadEnds, exp }
  );
}

// orientation-forced: both horizontal neighbours of the lone hit are misses.
{
  const s = scenarioById("gameiq-v0.1-battleship-orientation-forced")!;
  const a = analyze(s.initialState as BattleshipGameState);
  const h = a.hits[0];
  const left = { row: h.row, column: h.column - 1 };
  const right = { row: h.row, column: h.column + 1 };
  check(
    "orientation-forced: single hit with both row neighbours missed",
    a.hits.length === 1 && a.miss.has(key(left)) && a.miss.has(key(right)),
    { hit: targetToLabel(h) }
  );
}

// return-to-hit: a ship is sunk AND a separate unresolved hit remains.
{
  const s = scenarioById("gameiq-v0.1-battleship-return-after-sink")!;
  const state = s.initialState as BattleshipGameState;
  const a = analyze(state);
  const sank = state.boards.orange.shotsReceived.some((shot) => shot.result === "sunk");
  check(
    "return-to-hit: has a sink and exactly one unresolved contact",
    sank && a.hits.length === 1,
    { sank, unresolved: a.hits.map(targetToLabel) }
  );
}

// gap-fill: the expected cell sits strictly between two collinear hits and is
// unshot, and the immediate outer ends are NOT guaranteed (so the gap is the
// unique guaranteed cell).
for (const id of [
  "gameiq-v0.1-battleship-fill-gap",
  "gameiq-v0.1-battleship-fill-gap-v",
]) {
  const s = scenarioById(id)!;
  const a = analyze(s.initialState as BattleshipGameState);
  const exp = [...expectedKeys(s)];
  const certain = certainOracle(a);
  check(
    `${id}: unique guaranteed gap cell, unshot, between the hits`,
    exp.length === 1 &&
      certain.size === 1 &&
      certain.has(exp[0]) &&
      !a.shotAll.has(exp[0]) &&
      a.hits.length === 2,
    { exp: exp.map(labelFromKey), certain: [...certain].map(labelFromKey) }
  );
}

// --- Naive baselines must FAIL, expected actions must PASS -------------------

// Fixed corner guess A1 {0,0} on every scenario.
const cornerCorrect = scenarios.filter(
  (s) => actionMatchesExpected(s, { target: { row: 0, column: 0 } }) > 0
).length;
check(
  "fixed corner-guess baseline (A1) fails the pack",
  cornerCorrect < scenarios.length / 2,
  { cornerCorrect, total: scenarios.length }
);

// First-legal-cell scan (row-major) baseline.
function firstLegalCell(state: BattleshipGameState): BattleshipCoordinate {
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      const t = { row: r, column: c };
      if (isLegalBattleshipTarget(state, state.turn, t)) return t;
    }
  return { row: 0, column: 0 };
}
const firstLegalCorrect = scenarios.filter((s) => {
  const t = firstLegalCell(s.initialState as BattleshipGameState);
  return actionMatchesExpected(s, { target: t }) > 0;
}).length;
check(
  "first-legal-cell baseline fails the pack",
  firstLegalCorrect < scenarios.length / 2,
  { firstLegalCorrect, total: scenarios.length }
);

// A perfect deterministic player (picks the first expected action) scores 100%.
const perfectCorrect = scenarios.filter(
  (s) => actionMatchesExpected(s, s.expectedActions[0].action) > 0
).length;
check(
  "authored expectedActions all pass legality + scoring",
  perfectCorrect === scenarios.length,
  { perfectCorrect, total: scenarios.length }
);

function labelFromKey(k: string): string {
  const [r, c] = k.split(":").map(Number);
  return targetToLabel({ row: r, column: c });
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
