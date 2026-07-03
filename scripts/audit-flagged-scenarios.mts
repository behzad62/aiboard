/* Engine adjudication for the remaining convergence-flagged scenarios:
 * - connect-four: which columns actually win / which create how many threats
 * - fireworks: model-facing knowledge + engine outcome of the consensus action
 * Run: npx tsx scripts/audit-flagged-scenarios.mts
 */
import { CONNECT_FOUR_GAMEIQ_SCENARIOS } from "../lib/benchmark/gameiq/connect-four";
import {
  dropDisc,
  getLegalColumns,
} from "../lib/games/connect-four/engine";
import type { ConnectFourGameState } from "../lib/games/connect-four/types";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "../lib/benchmark/fireworks/scenario-packs";
import { getFireworksPlayerView } from "../lib/games/fireworks/hidden-view";
import {
  applyFireworksAction,
  cloneFireworksState,
  isCriticalCard,
  isPlayableCard,
} from "../lib/games/fireworks/engine";
import type { FireworksAction, FireworksGameState } from "../lib/games/fireworks/types";
import type { FireworksScenario } from "../lib/benchmark/fireworks/types";

// ---------- connect four ----------
function winningColumns(state: ConnectFourGameState): number[] {
  const wins: number[] = [];
  for (const column of getLegalColumns(state)) {
    const next = dropDisc(structuredClone(state), column, 0);
    if (next.status === "win" && next.winner === state.turn) wins.push(column);
  }
  return wins;
}

// count immediate winning replies available to `player` in `state` (threat count)
function threatCount(state: ConnectFourGameState, player: string): number {
  if (state.status !== "playing") return 0;
  const probe = structuredClone(state);
  probe.turn = player as ConnectFourGameState["turn"];
  return winningColumns(probe).length;
}

for (const id of [
  "gameiq-v0.1-connect-four-win-diagonal-up",
  "gameiq-v0.1-connect-four-trap-fork-horizontal-diagonal",
]) {
  const scenario = CONNECT_FOUR_GAMEIQ_SCENARIOS.find((s) => s.id === id);
  if (!scenario) {
    console.log(`${id}: NOT FOUND`);
    continue;
  }
  const state = scenario.initialState as ConnectFourGameState;
  console.log(`\n### ${id} (${scenario.category}) — mover: ${state.turn}`);
  console.log(
    `  keyed: ${scenario.expectedActions.map((e) => JSON.stringify(e.action) + "@" + e.weight).join(" | ")}`
  );
  if (scenario.category === "win-in-one") {
    console.log(`  engine winning columns for mover: [${winningColumns(state).join(", ")}]`);
  } else {
    // trap-setup: for each legal move, report (a) does it win outright, (b) how
    // many immediate winning threats the mover has afterwards, (c) can the
    // opponent then win immediately
    for (const column of getLegalColumns(state)) {
      const next = dropDisc(structuredClone(state), column, 0);
      if (next.status === "win") {
        console.log(`  col ${column}: WINS OUTRIGHT`);
        continue;
      }
      const myThreats = threatCount(next, state.turn);
      const oppWins = winningColumns(next); // next.turn is opponent
      console.log(
        `  col ${column}: my-threats-after=${myThreats} opponent-immediate-wins=[${oppWins.join(",")}]`
      );
    }
  }
}

// ---------- fireworks ----------
const HARD = FIREWORKS_TACTICS_SCENARIOS.filter((s) =>
  ["avoid_bad_play", "safe_discard", "critical_discard_avoidance", "endgame_play"].includes(s.category)
);
const MEM = FIREWORKS_MEMORY_SCENARIOS.filter((s) =>
  ["old_clue_recall", "negative_information", "timing_inference"].includes(s.category)
);

const cases: Array<{ name: string; source: FireworksScenario; redact: boolean; consensus: FireworksAction }> = [
  { name: "hard-23", source: HARD[22], redact: false, consensus: { action: "play", cardIndex: 2 } },
  { name: "hard-28", source: HARD[27], redact: false, consensus: { action: "play", cardIndex: 2 } },
  { name: "memory-13", source: MEM[12], redact: true, consensus: { action: "play", cardIndex: 3 } },
  { name: "memory-16", source: MEM[15], redact: true, consensus: { action: "play", cardIndex: 2 } },
  { name: "memory-19", source: MEM[18], redact: true, consensus: { action: "play", cardIndex: 1 } },
];

function prepared(source: FireworksScenario): FireworksGameState {
  const state = cloneFireworksState(source.state);
  const idx = state.players.findIndex((p) => p.id === source.actingPlayerId);
  if (idx >= 0) state.currentPlayerIndex = idx;
  state.status = "playing";
  return state;
}

for (const c of cases) {
  const s = c.source;
  console.log(`\n### ${c.name} (${s.id}, ${s.category}) acting=${s.actingPlayerId}`);
  const state = prepared(s);
  const hand = state.hands.find((h) => h.playerId === s.actingPlayerId);
  console.log(
    `  stacks=${JSON.stringify(state.stacks)} clues=${state.clueTokens} deck=${state.deck.length}`
  );
  console.log(
    `  truth hand: ${hand?.cards.map((card, i) => `[${i}]${card.color}${card.rank}${isPlayableCard(state, card) ? " PLAYABLE" : ""}${isCriticalCard(state, card) ? " CRITICAL" : ""}`).join("  ")}`
  );
  const view = getFireworksPlayerView(s.state, s.actingPlayerId, {
    omitRecommendations: true,
    redactOwnIdentity: c.redact,
  });
  view.ownHand.knowledge.forEach((k, i) => {
    console.log(
      `  view[${i}]: color=${k.color ?? "?"} rank=${k.rank ?? "?"} notColors=[${k.notColors}] notRanks=[${k.notRanks}] history=${JSON.stringify(k.clueHistory)}`
    );
  });
  console.log(
    `  keyed: ${s.expectedActions.map((e) => JSON.stringify(e.action) + "@" + e.weight).join(" | ")}${s.forbiddenActions?.length ? `  forbidden: ${s.forbiddenActions.map((f) => JSON.stringify(f)).join(" | ")}` : ""}`
  );
  const target = hand?.cards[(c.consensus as { cardIndex?: number }).cardIndex ?? -1];
  try {
    applyFireworksAction(cloneFireworksState(state), s.actingPlayerId, c.consensus);
    console.log(
      `  consensus ${JSON.stringify(c.consensus)} -> legal; card=${target ? `${target.color}${target.rank}` : "?"}; ${target && isPlayableCard(state, target) ? "PLAYS SUCCESSFULLY (+1 score)" : "MISPLAY (burns fuse)"}`
    );
  } catch (error) {
    console.log(`  consensus ILLEGAL: ${error instanceof Error ? error.message : String(error)}`);
  }
}
