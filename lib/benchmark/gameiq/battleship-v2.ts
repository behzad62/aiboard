import { targetToLabel } from "@/lib/games/battleship/engine";
import type { BattleshipShip } from "@/lib/games/battleship/types";
import { GAMEIQ_CORRECT_QUALITY_BAR } from "./types";
import type { BattleshipGameIqScenario } from "./types";
import { battleshipKeyedCells } from "./battleship-oracle";
import { blueShotHistory, cell, shipFor } from "./battleship-builders";

// -----------------------------------------------------------------------------
// GameIQ Battleship v2: oracle-graded targeting pack.
//
// Unlike v1 (hand-listed expectedActions, verified after the fact by an
// independent test enumerator), every v2 key is ORACLE OUTPUT: makeV2Scenario
// calls battleshipKeyedCells at module init and stores the exact ratios it
// returns, rounded to 4dp. There is no hand-authored answer key anywhere in
// this file -- only boards and shot histories. See battleship-oracle.ts for
// the placement-enumeration probability model and docs/superpowers/specs/
// 2026-07-05-battleship-v2-design.md for the composition rationale.
//
// Every scenario is built by firing real Blue shots (blueShotHistory) against
// a hand-placed, fully-valid 5-ship Orange fleet, so shot history and
// hit/miss/sunk results are engine-truth. makeV2Scenario THROWS if a board's
// keyed set (ratio >= GAMEIQ_CORRECT_QUALITY_BAR) is empty or larger than 6
// cells -- a >6-key state is too flat to discriminate models, so an
// out-of-range board fails loudly at import time instead of shipping quietly.
// -----------------------------------------------------------------------------

const HUNT_PROMPT =
  "You are firing at the hidden enemy fleet. Choose the single best next target cell.";

interface V2Spec {
  id: string;
  title: string;
  difficulty: BattleshipGameIqScenario["difficulty"];
  orangeShips: BattleshipShip[];
  shots: string[];
  tags: string[];
}

function makeV2Scenario(spec: V2Spec): BattleshipGameIqScenario {
  const state = blueShotHistory(spec.orangeShips, spec.shots.map(cell));
  const keyed = battleshipKeyedCells(state, GAMEIQ_CORRECT_QUALITY_BAR);
  if (keyed.length === 0 || keyed.length > 6) {
    throw new Error(`${spec.id}: keyed set size ${keyed.length} — rework the board`);
  }
  return {
    id: spec.id,
    gameId: "battleship",
    title: spec.title,
    category: "target-priority",
    difficulty: spec.difficulty,
    version: "0.1.0",
    prompt: HUNT_PROMPT,
    initialState: state,
    expectedActions: keyed.map((r) => ({
      action: { target: r.cell },
      label: targetToLabel(r.cell),
      weight: Math.round(r.ratio * 10000) / 10000,
    })),
    tags: ["battleship-v2", ...spec.tags],
  };
}

// Build a hunt chain: from a seeded fleet + opening shots, repeatedly fire the
// deterministic oracle argmax (lowest row, then column, among ratio-1 cells)
// and emit each pre-shot state as its own scenario. Every state is engine-true
// -- the chain fires each argmax through the real engine (blueShotHistory) and
// carries forward whatever hit/miss/sunk result the seeded fleet actually
// produces, so later states are not scripted, only the fleet and opening are.
function buildHuntChain(input: {
  idPrefix: string;
  titlePrefix: string;
  orangeShips: BattleshipShip[];
  openingShots: string[];
  states: number;
  tags: string[];
}): BattleshipGameIqScenario[] {
  const scenarios: BattleshipGameIqScenario[] = [];
  let shots = input.openingShots.map(cell);
  for (let k = 1; k <= input.states; k++) {
    const spec: V2Spec = {
      id: `${input.idPrefix}-s${k}`,
      title: `${input.titlePrefix} (step ${k})`,
      difficulty: "hard",
      orangeShips: input.orangeShips,
      shots: shots.map(targetToLabel),
      tags: [...input.tags, "hunt-chain"],
    };
    scenarios.push(makeV2Scenario(spec));
    const state = blueShotHistory(input.orangeShips, shots);
    const argmax = battleshipKeyedCells(state, 1)[0]; // ratio-1 cells, sorted; take first
    shots = [...shots, argmax.cell];
  }
  return scenarios;
}

// Authoring note for the two pure hunt-mode scenarios below (parity-hunt,
// late-game-density). Both boards carry PARTIAL SEARCH PATTERNS -- a period-2
// checkerboard / a period-3 diagonal lattice -- with deliberate unfired gaps
// where the live ships actually hide, rather than open water or a solid
// fence. Two rejected alternatives, kept as authoring evidence:
// - A bare local ring of misses around the intended pocket was measured
//   first: the rest of the open 10x10 board swamps the pocket's placement
//   density (the un-fenced draft of the parity board produced a 39-cell
//   keyed set with the argmax nowhere near the pocket).
// - Fencing the ENTIRE board minus the pocket (~90 misses) fixes the math
//   but failed review: with exactly one open region, region identification
//   -- the actual hunt-mode skill -- is done by the constructor, not the
//   model, and the ~6x-oversized shot history dominated the pack's prompt
//   payload on every certified attempt.
// The partial patterns are the honest middle: realistic hunt histories
// (53 / 39 shots), boards whose structure makes most open cells provably
// placement-dead -- recognizing THAT is the measured skill -- and the same
// oracle-computed keys.

// -----------------------------------------------------------------------------
// Standalone: miss-pruned line end (plan exemplar, verified against the
// oracle as written -- no substitution needed). battleship at E4..E7
// horizontal; hits at E5,E6 leave it unresolved (2/4); a miss at E8 prunes
// placements that would extend past the right end. Oracle result: keyed =
// {E4} only (ratio 1.0); E7 -- the "obviously symmetric" other extension --
// is a sub-bar decoy at ratio 0.667, and E3 (extend further left) sits at
// 0.333. The miss does not just narrow the field symmetrically; it breaks
// the tie entirely in E4's favor.
// -----------------------------------------------------------------------------
const PRUNED_END_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-pruned-end",
  title: "Battleship v2: miss-pruned line end",
  difficulty: "medium",
  orangeShips: [
    shipFor("battleship", { row: 4, column: 3 }, "horizontal"),
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 9, column: 6 }, "horizontal"),
    shipFor("submarine", { row: 7, column: 0 }, "horizontal"),
    shipFor("destroyer", { row: 2, column: 8 }, "horizontal"),
  ],
  shots: ["A1", "A2", "A3", "A4", "A5", "H1", "H2", "H3", "C9", "C10", "E5", "E6", "E8"],
  tags: ["target-mode", "pruned-end"],
});

// -----------------------------------------------------------------------------
// Recipe 1: parity hunt. Carrier/battleship/cruiser sunk mid-pattern, leaving
// destroyer(2) + submarine(3) afloat (pure hunt mode, zero unresolved hits).
// Blue has laid a partial period-2 checkerboard: every (row+col)-EVEN cell is
// fired EXCEPT a contiguous six-cell hole {E6,E7,E8,F6,F7,F8} where both live
// ships actually hide (submarine E6..E8, destroyer F6,F7). Because orthogonal
// neighbours alternate parity, every odd cell outside the hole has all of its
// neighbours fired -- placement-dead for any 2+ ship even though it was never
// shot -- so the surviving placement mass funnels through the hole's three
// unfired even cells. RECOGNIZING that parity-dead structure (instead of
// firing into blank-looking but dead water) is the scenario's skill. Oracle
// result: keyed = {F6=1.0, E7=0.8571, F7=0.8571}; sub-bar decoys F8=0.7143,
// E6/E8=0.5714, then 0.2857 -- five distinct ratio tiers.
// -----------------------------------------------------------------------------
const PARITY_HUNT_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-parity-hunt",
  title: "Battleship v2: parity hunt with two ships left",
  difficulty: "hard",
  orangeShips: [
    shipFor("carrier", { row: 1, column: 1 }, "horizontal"), // B2..B6, sunk
    shipFor("battleship", { row: 7, column: 2 }, "horizontal"), // H3..H6, sunk
    shipFor("cruiser", { row: 3, column: 8 }, "vertical"), // D9,E9,F9, sunk
    shipFor("submarine", { row: 4, column: 5 }, "horizontal"), // E6..E8 -- live
    shipFor("destroyer", { row: 5, column: 5 }, "horizontal"), // F6,F7 -- live
  ],
  shots: [
    // Checkerboard sweep, row A (even-parity cells; all misses).
    "A1", "A3", "A5", "A7", "A9",
    // Row B: B2 finds the carrier; kill B3..B6, then resume the pattern.
    "B2", "B3", "B4", "B5", "B6", "B8", "B10",
    // Row C.
    "C1", "C3", "C5", "C7", "C9",
    // Row D.
    "D2", "D4", "D6", "D8", "D10",
    // Row E: E7 left unfired (hole); E9 finds the cruiser; kill D9, F9.
    "E1", "E3", "E5", "E9", "D9", "F9",
    // Row F: F6 and F8 left unfired (hole).
    "F2", "F4", "F10",
    // Row G.
    "G1", "G3", "G5", "G7", "G9",
    // Row H: H4 finds the battleship; kill H5, H6, H3, then resume.
    "H2", "H4", "H5", "H6", "H3", "H8", "H10",
    // Row I.
    "I1", "I3", "I5", "I7", "I9",
    // Row J.
    "J2", "J4", "J6", "J8", "J10",
  ],
  tags: ["hunt-mode", "parity"],
});

// -----------------------------------------------------------------------------
// Recipe 2: orientation disambiguation. A fresh hit with BOTH lateral (row)
// neighbours pre-fired as misses forces the ship vertical; the full 5-ship
// multiset still remains (nothing sunk). Oracle result: keyed = {D5,F5} --
// exactly the two vertical neighbours, ratio 1.0 each -- with the next ring
// out (C5,G5) as sub-bar decoys at 0.583.
// -----------------------------------------------------------------------------
const ORIENTATION_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-orientation-disambiguation",
  title: "Battleship v2: disambiguate orientation from flanking misses",
  difficulty: "medium",
  orangeShips: [
    shipFor("battleship", { row: 1, column: 4 }, "vertical"), // B5..E5
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 9, column: 0 }, "horizontal"),
    shipFor("submarine", { row: 7, column: 7 }, "vertical"),
    shipFor("destroyer", { row: 9, column: 8 }, "horizontal"),
  ],
  shots: ["E4", "E5", "E6"],
  tags: ["target-mode", "orientation"],
});

// -----------------------------------------------------------------------------
// Recipe 3: sunk-neighbor confusion. A destroyer is sunk directly to the LEFT
// of an unresolved hit on a second ship (cruiser); misses above/below the hit
// also rule out the vertical axis entirely, so every vertical placement is
// blocked by one of those two misses. Oracle result: keyed = {D8,D9} (extend
// right, away from the sunk wreck); D10 (one cell further) is a sub-bar decoy
// at 0.333, viable only under the length-4 hypothesis.
// -----------------------------------------------------------------------------
const SUNK_NEIGHBOR_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-sunk-neighbor-confusion",
  title: "Battleship v2: retarget around a sunk neighbor",
  difficulty: "hard",
  orangeShips: [
    shipFor("destroyer", { row: 3, column: 4 }, "horizontal"), // D5,D6 -- sunk
    shipFor("cruiser", { row: 3, column: 6 }, "horizontal"), // D7,D8,D9
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"),
    shipFor("battleship", { row: 6, column: 0 }, "horizontal"),
    shipFor("submarine", { row: 8, column: 0 }, "horizontal"),
  ],
  shots: ["D5", "D6", "C7", "E7", "D7"],
  tags: ["target-mode", "sunk-neighbor"],
});

// -----------------------------------------------------------------------------
// Recipe 4: edge gap. A hit sits in the board corner (no up, no left); a miss
// two cells to the right prunes every horizontal placement except the
// shortest (destroyer). The full 5-ship multiset remains. Oracle result:
// keyed = {B1,C1} (the open, unpruned vertical axis) at ratio 1.0/0.8; the
// pruned horizontal survivor (A2, viable only for the destroyer) sits at just
// 0.2 -- a plausible but weak decoy, since "short placements dominate" the
// pruned direction rather than eliminating it outright.
// -----------------------------------------------------------------------------
const EDGE_GAP_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-edge-gap",
  title: "Battleship v2: edge hit pruned by a distant miss",
  difficulty: "hard",
  orangeShips: [
    shipFor("destroyer", { row: 0, column: 0 }, "horizontal"), // A1,A2
    shipFor("carrier", { row: 5, column: 0 }, "horizontal"),
    shipFor("battleship", { row: 7, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 9, column: 0 }, "horizontal"),
    shipFor("submarine", { row: 3, column: 6 }, "vertical"),
  ],
  shots: ["A1", "A3"],
  tags: ["target-mode", "edge-gap"],
});

// -----------------------------------------------------------------------------
// Recipe 5: late-game density. Carrier/cruiser/destroyer sunk mid-pattern,
// leaving battleship(4) + submarine(3) afloat (pure hunt mode). Blue has laid
// the canonical smallest-remaining-ship-3 hunt lattice -- every (row+col)%3==0
// diagonal cell fired -- EXCEPT three deliberate gaps: F5+F8 open a six-cell
// corridor F3..F8 (bounded by the F2 lattice shot and shaping misses F9,F10)
// hosting the battleship at F4..F7, and G10 opens a small corner pocket
// hosting the submarine at G10..I10. Any straight 3+ placement must cross a
// lattice-class cell, so every surviving placement funnels through F5, F8, or
// G10; the corridor gaps also open vertical runs (D5..H5 through F5, D8..H8
// through F8). F5 sits at the intersection of the two largest placement
// families (the row-F corridor AND the column-5 run) and is the sole keyed
// argmax. Oracle result: keyed = {F5=1.0}; top sub-bar decoys F8=0.6364,
// F6=0.5455, G8=0.4545, then a 0.3636 band -- seven distinct ratio tiers.
// -----------------------------------------------------------------------------
const LATE_GAME_DENSITY_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-late-game-density",
  title: "Battleship v2: late-game density with two ships left",
  difficulty: "hard",
  orangeShips: [
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"), // A1..A5, sunk
    shipFor("cruiser", { row: 2, column: 6 }, "horizontal"), // C7..C9, sunk
    shipFor("destroyer", { row: 8, column: 1 }, "horizontal"), // I2,I3, sunk
    shipFor("battleship", { row: 5, column: 3 }, "horizontal"), // F4..F7 -- live
    shipFor("submarine", { row: 6, column: 9 }, "vertical"), // G10,H10,I10 -- live
  ],
  shots: [
    // Lattice sweep, row A: A1 finds the carrier; kill A2..A5, then resume.
    "A1", "A2", "A3", "A4", "A5", "A7", "A10",
    // Row B.
    "B3", "B6", "B9",
    // Row C: C8 finds the cruiser; kill C7, C9.
    "C2", "C5", "C8", "C7", "C9",
    // Row D.
    "D1", "D4", "D7", "D10",
    // Row E.
    "E3", "E6", "E9",
    // Row F: F5 and F8 left unfired (corridor); F9/F10 shape its right end.
    "F2", "F9", "F10",
    // Row G: G10 left unfired (corner pocket).
    "G1", "G4", "G7",
    // Row H.
    "H3", "H6", "H9",
    // Row I: I2 finds the destroyer; kill I3, then resume.
    "I2", "I3", "I5", "I8",
    // Row J.
    "J1", "J4", "J7", "J10",
  ],
  tags: ["hunt-mode", "density"],
});

// -----------------------------------------------------------------------------
// Author's own design: edge-pinned orientation. A fresh hit sits on the top
// edge (no "up"), with both lateral cells still open water (unlike recipe 2,
// neither axis is pre-pruned by misses). The naive read is that "down" is
// forced and therefore safest; the oracle disagrees: an edge-pinned vertical
// placement is anchored to a single start row (only one placement per ship
// size), while the horizontal axis keeps its full range of starting
// positions for every size. Oracle result: keyed = {A5,A7} (extend left or
// right along the row) at ratio 1.0; "down" (B6) is a clear sub-bar decoy at
// only 0.417, well behind even the 2-cells-away horizontal cells (0.583).
// -----------------------------------------------------------------------------
const EDGE_PINNED_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-edge-pinned-orientation",
  title: "Battleship v2: weigh an edge-pinned hit against open water",
  difficulty: "hard",
  orangeShips: [
    shipFor("battleship", { row: 0, column: 5 }, "horizontal"), // A6..A9 -- hidden ship at the hit
    shipFor("carrier", { row: 4, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 6, column: 0 }, "horizontal"),
    shipFor("submarine", { row: 8, column: 0 }, "horizontal"),
    shipFor("destroyer", { row: 9, column: 5 }, "horizontal"),
  ],
  shots: ["A6"],
  tags: ["target-mode", "edge-pinned"],
});

// -----------------------------------------------------------------------------
// Hunt chain 1: hunt the cruiser from an isolated first hit. Oracle-argmax
// progression (measured, not scripted): s1 is a clean 4-way probe tie
// (all four orthogonal neighbours); s2 narrows to 2 after the "up" probe
// misses; s3 re-opens to 4 as a fresh axis becomes relevant after the second
// miss; s4 keeps two keyed cells down the line ({G5}=1.0, {H5}=0.8) -- the
// argmax G5 lands the cruiser's second hit, not yet the sink.
// -----------------------------------------------------------------------------
const HUNT_CHAIN_1_SCENARIOS = buildHuntChain({
  idPrefix: "gameiq-v0.2-battleship-hunt1",
  titlePrefix: "Battleship v2: hunt the cruiser",
  orangeShips: [
    shipFor("cruiser", { row: 5, column: 4 }, "vertical"), // F5,G5,H5
    shipFor("carrier", { row: 0, column: 2 }, "horizontal"),
    shipFor("battleship", { row: 2, column: 0 }, "vertical"),
    shipFor("submarine", { row: 0, column: 8 }, "vertical"),
    shipFor("destroyer", { row: 9, column: 0 }, "horizontal"),
  ],
  openingShots: ["F5"], // first hit on the cruiser
  states: 4,
  tags: ["hunt-chain-1"],
});

// -----------------------------------------------------------------------------
// Hunt chain 2: hunt the battleship from a first hit adjacent to a sunk
// ship's cells. The opener sinks a destroyer, then lands the chain's only
// unresolved hit directly against the sunk wreck (E5 touches the destroyer's
// F5 cell). Oracle-argmax progression: s1 keys the two HORIZONTAL neighbours
// (not "away from the wreck" vertically, which is the naive read -- vertical
// is starved because the sunk cell pins it to a single placement per size);
// s2 re-opens to 4 once the horizontal probe misses; s3 collapses to the
// unique gap-fill cell after a second hit lands two rows away; s4 collapses
// to the single remaining approach to the kill.
// -----------------------------------------------------------------------------
const HUNT_CHAIN_2_SCENARIOS = buildHuntChain({
  idPrefix: "gameiq-v0.2-battleship-hunt2",
  titlePrefix: "Battleship v2: hunt the battleship from a sunk neighbor",
  orangeShips: [
    shipFor("battleship", { row: 1, column: 4 }, "vertical"), // B5,C5,D5,E5
    shipFor("destroyer", { row: 5, column: 4 }, "horizontal"), // F5,F6 -- sunk
    shipFor("carrier", { row: 8, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 9, column: 0 }, "horizontal"),
    shipFor("submarine", { row: 9, column: 4 }, "horizontal"),
  ],
  openingShots: ["F5", "F6", "E5"], // sink the destroyer, then hit the battleship next to it
  states: 4,
  tags: ["hunt-chain-2"],
});

export const BATTLESHIP_V2_GAMEIQ_SCENARIOS: BattleshipGameIqScenario[] = [
  PRUNED_END_SCENARIO,
  PARITY_HUNT_SCENARIO,
  ORIENTATION_SCENARIO,
  SUNK_NEIGHBOR_SCENARIO,
  EDGE_GAP_SCENARIO,
  LATE_GAME_DENSITY_SCENARIO,
  EDGE_PINNED_SCENARIO,
  ...HUNT_CHAIN_1_SCENARIOS,
  ...HUNT_CHAIN_2_SCENARIOS,
];
