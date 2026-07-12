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

// Authoring note for the pure hunt-mode scenarios below (pruned-end,
// parity-hunt, sunk-neighbor-confusion, late-game-density). Each board
// carries a PARTIAL SEARCH PATTERN -- a period-2 checkerboard or a period-3
// diagonal lattice -- with deliberate unfired gaps where the live ships
// actually hide, rather than open water or a solid fence. Two rejected
// alternatives, kept as authoring evidence:
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
// (38-55 shots), boards whose structure makes most open cells provably
// placement-dead -- recognizing THAT is the measured skill -- and the same
// oracle-computed keys.
//
// Gate-iteration note (rounds 1-3): the live difficulty gate showed the
// frontier model computes PLAIN open-region density perfectly, counts
// single-region pinned families correctly every time (all four round-1
// boards whose argmax rested on one wall-pinned corridor/junction were
// re-aced at 1.0), and -- per the round-2 delta probe -- ALSO fully
// enumerates small boards: every round-2 local trap (4-5 shots, and even a
// 54-shot two-pocket parity board whose regions sat close together) was
// re-aced with the exact argmax. What has actually survived it across all
// three probes is BIG-TEXTURE CROSS-REGION comparison: two-plus DISTANT
// rival regions of different geometry, the argmax in the poorer-LOOKING one
// because the remaining-size multiset stacks there, with a quiet
// propagation shot (a lone probe miss or a wreck's exclusion zone) trimming
// the rival's count non-obviously -- that is the shape of late-game-density
// (0.667), hunt1-s1 (0.6), and orientation-disambiguation (0.5). Every
// round-3 rework below is built in that mold, with margins engineered wide
// (argmax count >= 1.4x the rival region's best cell), heuristic picks
// (center-bias, biggest-region, hit-adjacency) parked in the sub-bar
// 0.4-0.7 band, keyed size 1, and no ratio-1 keyed ties anywhere -- the
// round-2 probe showed a tie state (old hunt1-s3) stalling a reasoning
// model into timeouts. Multi-region dead-water structure keeps the boards
// discriminating mid-tier models (which failed region-finding at 0.0).

// -----------------------------------------------------------------------------
// Standalone: miss-pruned line end (round-3 rework: the round-2 cross-axis
// version was a 4-shot local board the frontier model fully enumerated).
// Now a big-texture hunt board: battleship/cruiser/destroyer sunk
// mid-lattice, leaving carrier(5) + submarine(3) -- the {5,3} multiset.
// Two DISTANT rival regions survive the period-3 lattice: the top-wall
// corridor A2..A6 (omitted lattice cell A4; the carrier's ONLY home on the
// whole board, hosting it) and a bottom-right L-pocket around omitted I8
// (hosting the submarine at I8..I10). The L-pocket LOOKS at least as rich
// -- a 2-D elbow of ~7 unfired cells vs a thin 5-cell line -- but the I7
// probe miss prunes the row-8 line's west end, quietly deleting the
// pocket's five-run and half its three-runs (without I7, I8 would count 6
// and top the board); what remains is submarine-only mass. Oracle result:
// keyed = {A4} alone (1.0, count 5 = the corridor's L5 + all three L3s +
// the column-4 leak); margin 1.67x over the rival's best. Sub-bar decoys:
// I8=0.6 (the pocket junction -- biggest-region bait), A3/A5=0.6, then
// A2/A6/H8=0.4 and a 0.2 tail -- four distinct ratio tiers.
// -----------------------------------------------------------------------------
const PRUNED_END_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-pruned-end",
  title: "Battleship v2: miss-pruned line end",
  difficulty: "medium",
  orangeShips: [
    shipFor("carrier", { row: 0, column: 1 }, "horizontal"), // A2..A6 -- live
    shipFor("submarine", { row: 8, column: 7 }, "horizontal"), // I8,I9,I10 -- live
    shipFor("battleship", { row: 3, column: 1 }, "horizontal"), // D2..D5, sunk
    shipFor("cruiser", { row: 4, column: 6 }, "vertical"), // E7,F7,G7, sunk
    shipFor("destroyer", { row: 7, column: 1 }, "horizontal"), // H2,H3, sunk
  ],
  shots: [
    // Lattice sweep, row A: A4 left unfired (top-wall corridor).
    "A1", "A7", "A10",
    // Row B.
    "B3", "B6", "B9",
    // Row C.
    "C2", "C5", "C8",
    // Row D: D4 finds the battleship; kill D2, D3, D5, then resume.
    "D1", "D4", "D2", "D3", "D5", "D7", "D10",
    // Row E.
    "E3", "E6", "E9",
    // Row F.
    "F2", "F5", "F8",
    // Row G: G7 finds the cruiser; kill E7, F7, then resume.
    "G1", "G4", "G7", "E7", "F7", "G10",
    // Row H: H3 finds the destroyer; kill H2, then resume.
    "H3", "H2", "H6", "H9",
    // Row I: I8 left unfired (bottom-right pocket); I7 probe miss prunes
    // the row-8 line's west end.
    "I2", "I5", "I7",
    // Row J.
    "J1", "J4", "J7", "J10",
  ],
  tags: ["hunt-mode", "pruned-end"],
});

// -----------------------------------------------------------------------------
// Recipe 1: parity hunt (round-3 rework: the round-2 two-pocket version put
// its rival regions close enough together that the frontier model
// enumerated both and re-aced it). Carrier/battleship/cruiser sunk
// mid-pattern, leaving submarine(3) + destroyer(2) -- the {3,2} multiset.
// The checkerboard omits four even cells forming two DISTANT rival regions
// in opposite board corners: a fat mid-left diagonal blob (omitted C3 and
// D4 -- two full odd-cell pluses, ~8 unfired cells, hosting the destroyer
// at C3,C4) and a skinny bottom-right column-9 pocket (omitted G9 and I9,
// hosting the submarine at G9..I9). The blob LOOKS richer; three quiet
// probe misses invert the count. C2 and D5 each delete one sub line AND one
// destroyer edge from a blob junction (C3 and D4 drop to 4); G8 trims the
// pocket's second junction (G9 to 5); but I9 keeps BOTH vertical sub lines
// (rows 6-8 and 7-9, the latter through the edge odd cell J9) plus the
// row-8 line I8..I10 and four destroyer edges: count 7. Oracle result:
// keyed = {I9} alone (1.0); margin 1.75x over the blob's best. Sub-bar
// decoys: G9/H9=0.714 (in-pocket), C3/D4=0.571 (the blob's visual centers
// -- biggest-region bait), C4/D3=0.429, then a 0.286 tail -- six distinct
// ratio tiers.
// -----------------------------------------------------------------------------
const PARITY_HUNT_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-parity-hunt",
  title: "Battleship v2: parity hunt with two ships left",
  difficulty: "hard",
  orangeShips: [
    shipFor("carrier", { row: 4, column: 4 }, "horizontal"), // E5..E9, sunk
    shipFor("battleship", { row: 7, column: 1 }, "horizontal"), // H2..H5, sunk
    shipFor("cruiser", { row: 1, column: 6 }, "horizontal"), // B7,B8,B9, sunk
    shipFor("submarine", { row: 6, column: 8 }, "vertical"), // G9,H9,I9 -- live
    shipFor("destroyer", { row: 2, column: 2 }, "horizontal"), // C3,C4 -- live
  ],
  shots: [
    // Checkerboard sweep, row A (even-parity cells; all misses).
    "A1", "A3", "A5", "A7", "A9",
    // Row B: B8 finds the cruiser; kill B7, B9, then resume.
    "B2", "B4", "B6", "B8", "B7", "B9", "B10",
    // Row C: C3 left unfired (mid-left blob); C2 off-parity probe.
    "C1", "C2", "C5", "C7", "C9",
    // Row D: D4 left unfired (mid-left blob); D5 off-parity probe.
    "D2", "D5", "D6", "D8", "D10",
    // Row E: E5 finds the carrier; kill E6..E9, then resume.
    "E1", "E3", "E5", "E6", "E7", "E8", "E9",
    // Row F.
    "F2", "F4", "F6", "F8", "F10",
    // Row G: G9 left unfired (bottom-right pocket); G8 off-parity probe.
    "G1", "G3", "G5", "G7", "G8",
    // Row H: H2 finds the battleship; kill H3, H4, H5, then resume.
    "H2", "H3", "H4", "H5", "H6", "H8", "H10",
    // Row I: I9 left unfired (bottom-right pocket).
    "I1", "I3", "I5", "I7",
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
// Recipe 3: sunk-neighbor confusion (round-3 rework: the round-2 wreck-flank
// board was a 5-shot local state the frontier model fully enumerated). Now a
// big-texture hunt board: carrier + battleship sunk mid-lattice, leaving
// cruiser(3) + submarine(3) + destroyer(2) -- the {3,3,2} multiset. Two
// DISTANT rival regions survive the period-3 lattice: a top-right SHELF
// (omitted B6 and B9 plus the unfired A-row odds above -- ~10 unfired cells,
// the board's visually richest area, hosting the cruiser at B4..B6 and the
// destroyer at A8,A9) and a thin right-wall corridor E10..I10 (omitted G10,
// hosting the submarine at F10..H10). The SUNK CARRIER at C4..C8 is the
// quiet trim this scenario is named for: its exclusion zone runs directly
// beneath the shelf and severs every column family the shelf would feed
// (C5..C8 all blocked), so the shelf's junctions are horizontal-only; the
// B8 probe splits its long row. The corridor's center G10 keeps three
// vertical three-runs (both 3-ships) plus the row-6 leak G8..G10 and three
// destroyer edges: count 11. Oracle result: keyed = {G10} alone (1.0);
// margin 1.57x over the rival's best. Sub-bar decoys: B5/B6/B9/C9=0.636
// (the shelf -- biggest-region bait) and F10=0.636, H10=0.545, G9=0.455,
// then 0.364 and below -- eight distinct ratio tiers.
// -----------------------------------------------------------------------------
const SUNK_NEIGHBOR_SCENARIO = makeV2Scenario({
  id: "gameiq-v0.2-battleship-sunk-neighbor-confusion",
  title: "Battleship v2: retarget around a sunk neighbor",
  difficulty: "hard",
  orangeShips: [
    shipFor("carrier", { row: 2, column: 3 }, "horizontal"), // C4..C8, sunk
    shipFor("battleship", { row: 7, column: 1 }, "horizontal"), // H2..H5, sunk
    shipFor("cruiser", { row: 1, column: 3 }, "horizontal"), // B4,B5,B6 -- live
    shipFor("submarine", { row: 5, column: 9 }, "vertical"), // F10,G10,H10 -- live
    shipFor("destroyer", { row: 0, column: 7 }, "horizontal"), // A8,A9 -- live
  ],
  shots: [
    // Lattice sweep, row A.
    "A1", "A4", "A7", "A10",
    // Row B: B6 and B9 left unfired (top-right shelf); B8 probe miss
    // splits the shelf's long row.
    "B3", "B8",
    // Row C: C5 finds the carrier; kill C4, C6, C7, C8, then resume.
    "C2", "C5", "C4", "C6", "C7", "C8",
    // Row D.
    "D1", "D4", "D7", "D10",
    // Row E.
    "E3", "E6", "E9",
    // Row F.
    "F2", "F5", "F8",
    // Row G: G10 left unfired (right-wall corridor).
    "G1", "G4", "G7",
    // Row H: H3 finds the battleship; kill H2, H4, H5, then resume.
    "H3", "H2", "H4", "H5", "H6", "H9",
    // Row I.
    "I2", "I5", "I8",
    // Row J.
    "J1", "J4", "J7", "J10",
  ],
  tags: ["hunt-mode", "sunk-neighbor"],
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
