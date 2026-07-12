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
// (54 / 39 shots), boards whose structure makes most open cells provably
// placement-dead -- recognizing THAT is the measured skill -- and the same
// oracle-computed keys.
//
// Gate-iteration note (rounds 1-2): the live difficulty gate showed the
// frontier model computes PLAIN open-region density perfectly, and -- per
// the round-1 delta probe -- ALSO counts single-region pinned families
// correctly every time (all four round-1 boards whose argmax rested on one
// wall-pinned corridor/junction were re-aced at 1.0). What it demonstrably
// gets wrong is CROSS-REGION comparison and quiet constraint propagation:
// it lost late-game-density (0.667) by mispricing two visually similar wall
// corridors against the {4,3} multiset, orientation-disambiguation (0.5) by
// failing to propagate a distant miss that starved a whole axis, hunt2-s1
// (0.364) on wreck-flank direction bias, and edge-gap (0.20) on
// mixed-multiset edge-gap arithmetic. Every round-2 rework below therefore
// makes the argmax hinge on comparing TWO live regions/axes (with the
// visually richer one losing) and/or on propagating an unassuming miss,
// parks the heuristic picks (center-bias, hit-adjacency, flee-the-wreck,
// gap-fill) in the sub-bar 0.4-0.7 band, and avoids ratio-1 keyed ties
// everywhere -- the probe showed a tie state (old hunt1-s3) stalling a
// reasoning model into timeouts. Multi-region dead-water structure is
// preserved so the boards keep discriminating mid-tier models (which failed
// region-finding at 0.0).

// -----------------------------------------------------------------------------
// Standalone: miss-pruned line end (round-2 rework: the round-1 wall-corridor
// version was a single-region pinning argument the frontier model re-aced at
// 1.0). Now a CROSS-AXIS propagation trap: a hit at B4 with the full 5-ship
// multiset. The row axis is capped by the wall (west) and a B6 miss (east);
// the column axis is quietly starved by TWO propagating misses -- A4
// directly above kills every up-start, and F4 four cells below kills the
// vertical carrier family entirely, so the visible three-cell southward gap
// (C4,D4,E4) carries only 4 hit-covering placements while the horizontal
// corridor carries 9. Oracle result: keyed = {B3} alone (1.0, count 8);
// sub-bar decoys B5=0.625 (gap-fill between hit and miss -- the proven
// edge-gap bias), B2=0.625, C4=0.5 (the roomiest-LOOKING run, the flee-south
// pick), D4=0.375, B1=0.25, E4=0.125 -- six distinct ratio tiers.
// -----------------------------------------------------------------------------
const PRUNED_END_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-pruned-end",
  title: "Battleship v2: miss-pruned line end",
  difficulty: "medium",
  orangeShips: [
    shipFor("battleship", { row: 1, column: 0 }, "horizontal"), // B1..B4 -- hit at B4
    shipFor("carrier", { row: 7, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 3, column: 6 }, "horizontal"),
    shipFor("submarine", { row: 9, column: 7 }, "horizontal"),
    shipFor("destroyer", { row: 5, column: 6 }, "horizontal"),
  ],
  shots: ["A4", "B6", "F4", "B4"],
  tags: ["target-mode", "pruned-end"],
});

// -----------------------------------------------------------------------------
// Recipe 1: parity hunt (round-2 rework: the round-1 wall-junction version
// was a single-region argument the frontier model re-aced at 1.0). Carrier/
// battleship/cruiser sunk mid-pattern, leaving destroyer(2) + submarine(3)
// afloat (pure hunt mode). Blue's period-2 checkerboard omits four even
// cells forming TWO rival regions: a skinny column-2 pocket in the top-left
// (omitted B2 and D2, hosting the destroyer at B2,C2) and a fat central
// row-F blob (omitted F6 and F8, hosting the submarine at F6..F8), with
// probe misses D1, F5, F9 woven in. The blob LOOKS richer -- wider, central,
// symmetric, more unfired cells -- but the probes and the battleship wreck
// clip each blob junction to one sub line per axis (count 5), while the
// paired column omissions DOUBLE the vertical sub family through B2 (rows
// 0-2 AND 1-3 live via the edge odd cell A2) on top of four destroyer
// edges: count 7. Pricing the {3,2} multiset across two regions is exactly
// what the round-1 probe showed the frontier model getting wrong. Oracle
// result: keyed = {B2=1.0} alone; sub-bar decoys F6/F8/C2/D2=0.714,
// F7=0.429, then a 0.286 tail -- five distinct ratio tiers.
// -----------------------------------------------------------------------------
const PARITY_HUNT_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-parity-hunt",
  title: "Battleship v2: parity hunt with two ships left",
  difficulty: "hard",
  orangeShips: [
    shipFor("carrier", { row: 7, column: 1 }, "horizontal"), // H2..H6, sunk
    shipFor("battleship", { row: 3, column: 4 }, "horizontal"), // D5..D8, sunk
    shipFor("cruiser", { row: 3, column: 9 }, "vertical"), // D10,E10,F10, sunk
    shipFor("submarine", { row: 5, column: 5 }, "horizontal"), // F6,F7,F8 -- live
    shipFor("destroyer", { row: 1, column: 1 }, "vertical"), // B2,C2 -- live
  ],
  shots: [
    // Checkerboard sweep, row A (even-parity cells; all misses).
    "A1", "A3", "A5", "A7", "A9",
    // Row B: B2 left unfired (top-left pocket).
    "B4", "B6", "B8", "B10",
    // Row C.
    "C1", "C3", "C5", "C7", "C9",
    // Row D: D1 off-parity probe; D2 left unfired (top-left pocket);
    // D6 finds the battleship (kill D5, D7, D8); D10 finds the cruiser
    // (kill E10, F10).
    "D1", "D4", "D6", "D5", "D7", "D8", "D10", "E10", "F10",
    // Row E.
    "E1", "E3", "E5", "E7", "E9",
    // Row F: F6 and F8 left unfired (central blob); F5 and F9 off-parity
    // probes.
    "F2", "F4", "F5", "F9",
    // Row G.
    "G1", "G3", "G5", "G7", "G9",
    // Row H: H2 finds the carrier; kill H3..H6, then resume the pattern.
    "H2", "H3", "H4", "H5", "H6", "H8", "H10",
    // Row I.
    "I1", "I3", "I5", "I7", "I9",
    // Row J.
    "J2", "J4", "J6", "J8", "J10",
  ],
  tags: ["hunt-mode", "parity"],
});

// -----------------------------------------------------------------------------
// Recipe 2: orientation disambiguation (gate rework: the original
// flanking-miss board forced the axis outright and the frontier model aced
// it). Now the hit sits ON the top wall at A5, flanked ALONG the row by
// misses A3 and A8, with a third miss at D5 capping the southward column.
// The naive disambiguation reads the clipped row segments plus the open
// south as "the ship must run down" -- but the edge-pinned row families
// (including both size-3 ships) still dominate: the corridor A4..A7 is one
// cell deeper east of the hit. Oracle result: keyed = {A6} alone (1.0);
// sub-bar decoys A4=0.667 (fill the tighter west gap), B5=0.5 (flee the
// wall southward -- the gate's demonstrated frontier blind spot), A7=0.5,
// C5=0.333.
// -----------------------------------------------------------------------------
const ORIENTATION_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-orientation-disambiguation",
  title: "Battleship v2: disambiguate orientation from flanking misses",
  difficulty: "medium",
  orangeShips: [
    shipFor("cruiser", { row: 0, column: 4 }, "horizontal"), // A5,A6,A7 -- hit at A5
    shipFor("carrier", { row: 3, column: 5 }, "horizontal"),
    shipFor("battleship", { row: 5, column: 2 }, "horizontal"),
    shipFor("submarine", { row: 8, column: 0 }, "horizontal"),
    shipFor("destroyer", { row: 8, column: 8 }, "horizontal"),
  ],
  shots: ["A3", "A8", "D5", "A5"],
  tags: ["target-mode", "orientation"],
});

// -----------------------------------------------------------------------------
// Recipe 3: sunk-neighbor confusion (round-2 rework: the round-1 wreck+wall
// corner corridor was a single-region argument the frontier model re-aced at
// 1.0). Now the proven wreck-FLANK direction-bias shape with cross-axis
// pricing: the destroyer wreck runs vertically at D6,E6 and a fresh hit
// lands at E5, orthogonally beside the wreck's lower cell. The wreck kills
// the eastward row entirely; the remaining decision compares the westward
// row family (capped by the wreck, max count 4) against the column family,
// whose asymmetry only appears after propagating two quiet misses: A5 (four
// above) and G5 (two below) leave up-room 3 vs down-room 1. "Retreat from
// the wreck" points west (E4), the no-touch-the-wreck instinct avoids D5
// (which hugs the wreck diagonal), and the {5,4,3,3} multiset actually
// stacks on D5. Oracle result: keyed = {D5} alone (1.0, count 7); sub-bar
// decoys C5=0.714, E4/E3/F5=0.571 (flee-west and the coin-flip south),
// B5/E2=0.286, E1=0.143 -- five distinct ratio tiers.
// -----------------------------------------------------------------------------
const SUNK_NEIGHBOR_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-sunk-neighbor-confusion",
  title: "Battleship v2: retarget around a sunk neighbor",
  difficulty: "hard",
  orangeShips: [
    shipFor("destroyer", { row: 3, column: 5 }, "vertical"), // D6,E6 -- sunk
    shipFor("battleship", { row: 1, column: 4 }, "vertical"), // B5..E5 -- hit at E5
    shipFor("carrier", { row: 8, column: 0 }, "horizontal"),
    shipFor("cruiser", { row: 0, column: 6 }, "horizontal"),
    shipFor("submarine", { row: 6, column: 6 }, "horizontal"),
  ],
  shots: ["A5", "G5", "D6", "E6", "E5"],
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
// diagonal cell fired -- EXCEPT two deliberate gaps (gate rework: the old
// interior-corridor board was plain density the frontier model computed
// perfectly): J4 opens a five-cell corridor J2..J6 along the BOTTOM WALL
// (hosting the battleship at J3..J6), and D1 opens a four-cell corridor
// B1..E1 down the LEFT WALL (hosting the submarine at B1..D1; the F1 probe
// miss caps it). The two wall corridors LOOK symmetric -- each is a gap
// around one omitted lattice cell -- but the {4,3} multiset prices them
// apart: the bottom corridor is five wide, so it carries battleship AND
// submarine families plus the column-4 leak H4..J4, while the left corridor
// is four tall and carries only one battleship run. Mixed-multiset-near-edge
// counting is exactly what the gate showed the frontier model getting wrong.
// Oracle result: keyed = {J4=1.0} alone; sub-bar decoys J3/J5/D1=0.667
// (D1 is the rival corridor's center), C1=0.5, then a 0.333 band -- five
// distinct ratio tiers.
// -----------------------------------------------------------------------------
const LATE_GAME_DENSITY_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-late-game-density",
  title: "Battleship v2: late-game density with two ships left",
  difficulty: "hard",
  orangeShips: [
    shipFor("carrier", { row: 0, column: 0 }, "horizontal"), // A1..A5, sunk
    shipFor("cruiser", { row: 2, column: 6 }, "horizontal"), // C7..C9, sunk
    shipFor("destroyer", { row: 8, column: 1 }, "horizontal"), // I2,I3, sunk
    shipFor("battleship", { row: 9, column: 2 }, "horizontal"), // J3..J6 -- live
    shipFor("submarine", { row: 1, column: 0 }, "vertical"), // B1,C1,D1 -- live
  ],
  shots: [
    // Lattice sweep, row A: A1 finds the carrier; kill A2..A5, then resume.
    "A1", "A2", "A3", "A4", "A5", "A7", "A10",
    // Row B.
    "B3", "B6", "B9",
    // Row C: C8 finds the cruiser; kill C7, C9.
    "C2", "C5", "C8", "C7", "C9",
    // Row D: D1 left unfired (left-wall corridor).
    "D4", "D7", "D10",
    // Row E.
    "E3", "E6", "E9",
    // Row F: F1 probe miss caps the left-wall corridor.
    "F1", "F2", "F5", "F8",
    // Row G.
    "G1", "G4", "G7", "G10",
    // Row H.
    "H3", "H6", "H9",
    // Row I: I2 finds the destroyer; kill I3, then resume.
    "I2", "I3", "I5", "I8",
    // Row J: J4 left unfired (bottom-wall corridor).
    "J1", "J7", "J10",
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
// Hunt chain 1 (round-2 re-seed: the round-1 wall-corridor carrier hunt keyed
// s1 on a single-region pinning argument -- re-aced -- and its s3 was the
// {A1,A5} ratio-1 END-PAIR TIE that stalled a reasoning model into timeouts
// on the probe; ties are now banned in every state). Now: hunt the carrier
// down the LEFT WALL with nothing sunk. Three hunting misses -- C1 above,
// I1 below, and the quiet D4 east -- box the first hit at D1, and the
// carrier runs D1..H1, flush under the C1 bound. Because the corridor is
// closed at the top, every later state has exactly one live end: no ties
// anywhere, and s4 stays the forced kill approach. s1 is the cross-region
// decision: the boxed vertical family (5 placements, incl. the destroyer
// pair that separates E1 from F1 -- nothing is sunk, so the full multiset
// counts) against the D4-capped horizontal family. Oracle-argmax progression
// (measured, not scripted): s1 keys {E1}=1.0 with F1=0.8 an honest second
// key, D2=0.6 (flee-the-wall east -- the proven frontier bait), G1/D3=0.4,
// H1=0.2; s2 keys {F1}=1.0 alone (G1=0.5); s3 keys {G1}=1.0 alone (H1=0.5);
// s4 is the forced {H1}, whose argmax lands the sink.
// -----------------------------------------------------------------------------
const HUNT_CHAIN_1_SCENARIOS = buildHuntChain({
  idPrefix: "gameiq-v0.2-battleship-hunt1",
  titlePrefix: "Battleship v2: hunt the carrier",
  orangeShips: [
    shipFor("carrier", { row: 3, column: 0 }, "vertical"), // D1..H1 -- hit at D1
    shipFor("battleship", { row: 1, column: 3 }, "horizontal"),
    shipFor("cruiser", { row: 9, column: 4 }, "horizontal"),
    shipFor("submarine", { row: 1, column: 8 }, "vertical"),
    shipFor("destroyer", { row: 6, column: 4 }, "horizontal"),
  ],
  openingShots: ["C1", "I1", "D4", "D1"], // three hunt misses box the first hit
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
