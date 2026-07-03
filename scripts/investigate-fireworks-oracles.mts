/* Oracle investigation for disputed GameIQ fireworks scenarios.
 * For each disputed scenario: print the full ground-truth state, then simulate
 * every candidate action (keyed expected actions + model consensus answers +
 * every legal action) through the real engine and report the outcome.
 * Run: npx tsx scripts/investigate-fireworks-oracles.mts
 */
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "../lib/benchmark/fireworks/scenario-packs";
import type { FireworksScenario } from "../lib/benchmark/fireworks/types";
import {
  applyFireworksAction,
  cloneFireworksState,
  getLegalFireworksActions,
  isCriticalCard,
  isPlayableCard,
  scoreFireworksState,
} from "../lib/games/fireworks/engine";
import type {
  FireworksAction,
  FireworksColor,
  FireworksGameState,
  FireworksRank,
} from "../lib/games/fireworks/types";

const HARD_FIREWORKS_SOURCE = FIREWORKS_TACTICS_SCENARIOS.filter(
  (scenario) =>
    scenario.category === "avoid_bad_play" ||
    scenario.category === "safe_discard" ||
    scenario.category === "critical_discard_avoidance" ||
    scenario.category === "endgame_play"
);
const MEMORY_STRESS_SOURCE = FIREWORKS_MEMORY_SCENARIOS.filter(
  (scenario) =>
    scenario.category === "old_clue_recall" ||
    scenario.category === "negative_information" ||
    scenario.category === "timing_inference"
);

// Benchmark-recorded answers use {action, targetPlayerId, color, rank, cardIndex}
// with nulls for unused channels; the engine uses exact discriminated shapes.
function toEngineAction(raw: unknown): FireworksAction {
  const r = raw as Record<string, unknown>;
  const kind = (r.action ?? r.type) as string;
  if (kind === "play" || kind === "discard") {
    return { action: kind, cardIndex: r.cardIndex as number };
  }
  if (kind === "clue_color") {
    return {
      action: "clue_color",
      targetPlayerId: r.targetPlayerId as string,
      color: r.color as FireworksColor,
    };
  }
  return {
    action: "clue_rank",
    targetPlayerId: r.targetPlayerId as string,
    rank: r.rank as FireworksRank,
  };
}

interface Disputed {
  gameIqId: string;
  source: FireworksScenario;
  modelAnswers: Array<{ model: string; action: unknown }>;
}

const disputed: Disputed[] = [
  {
    gameIqId: "gameiq-fireworks-hard-v1-14",
    source: HARD_FIREWORKS_SOURCE[13],
    modelAnswers: [
      { model: "gemini-3.5-flash", action: { action: "clue_color", targetPlayerId: "P1", color: "blue" } },
      { model: "gpt-5.5", action: { action: "clue_color", targetPlayerId: "P1", color: "blue" } },
      { model: "opus-4.5", action: { action: "play", cardIndex: 3 } },
    ],
  },
  {
    gameIqId: "gameiq-fireworks-hard-v1-20",
    source: HARD_FIREWORKS_SOURCE[19],
    modelAnswers: [
      { model: "spark", action: { action: "clue_color", targetPlayerId: "P1", color: "blue" } },
      { model: "gemini-3.5-flash", action: { action: "clue_color", targetPlayerId: "P1", color: "blue" } },
      { model: "gpt-5.5", action: { action: "clue_color", targetPlayerId: "P1", color: "blue" } },
      { model: "opus-4.5", action: { action: "play", cardIndex: 2 } },
    ],
  },
  {
    gameIqId: "gameiq-fireworks-hard-v1-27",
    source: HARD_FIREWORKS_SOURCE[26],
    modelAnswers: [
      { model: "gemini-3.5-flash", action: { action: "play", cardIndex: 2 } },
      { model: "gpt-5.5", action: { action: "play", cardIndex: 2 } },
      { model: "opus-4.5", action: { action: "play", cardIndex: 2 } },
    ],
  },
  {
    gameIqId: "gameiq-fireworks-memory-v1-29",
    source: MEMORY_STRESS_SOURCE[28],
    modelAnswers: [
      { model: "spark", action: { action: "play", cardIndex: 0 } },
      { model: "opus-4.5", action: { action: "play", cardIndex: 0 } },
    ],
  },
];

function prepared(source: FireworksScenario): FireworksGameState {
  const state = cloneFireworksState(source.state);
  const idx = state.players.findIndex((p) => p.id === source.actingPlayerId);
  if (idx >= 0) state.currentPlayerIndex = idx;
  state.status = "playing";
  return state;
}

function describeState(s: FireworksGameState, actingPlayerId: string): void {
  console.log(
    `  stacks: ${JSON.stringify(s.stacks)} | clues=${s.clueTokens}/${s.maxClueTokens} mistakes=${s.mistakeTokens}/${s.maxMistakeTokens} deck=${s.deck.length} score=${scoreFireworksState(s)}`
  );
  console.log(
    `  discard: ${s.discardPile.map((d) => `${d.card.color}${d.card.rank}`).join(",") || "(empty)"}`
  );
  for (const hand of s.hands) {
    const cards = hand.cards
      .map((c, i) => {
        const flags = [
          isPlayableCard(s, c) ? "PLAYABLE" : "",
          isCriticalCard(s, c) ? "CRITICAL" : "",
        ]
          .filter(Boolean)
          .join("/");
        const known = `${c.knowledge?.knownColor ?? "?"},${c.knowledge?.knownRank ?? "?"}`;
        return `[${i}]${c.color}${c.rank}(knows:${known})${flags ? " " + flags : ""}`;
      })
      .join("  ");
    console.log(`  ${hand.playerId}${hand.playerId === actingPlayerId ? " (ACTING)" : ""}: ${cards}`);
  }
}

function describeOutcome(
  state: FireworksGameState,
  playerId: string,
  action: FireworksAction
): string {
  try {
    const next = applyFireworksAction(cloneFireworksState(state), playerId, action);
    const dScore = scoreFireworksState(next) - scoreFireworksState(state);
    const dMistake = next.mistakeTokens - state.mistakeTokens;
    const dClue = next.clueTokens - state.clueTokens;
    let detail = "";
    if (action.action === "play" || action.action === "discard") {
      const hand = state.hands.find((h) => h.playerId === playerId);
      const card = hand?.cards[action.cardIndex];
      if (card) {
        detail = ` card=${card.color}${card.rank}${isPlayableCard(state, card) ? " (PLAYABLE)" : ""}${isCriticalCard(state, card) ? " (CRITICAL)" : ""}`;
      }
    } else {
      const target = state.hands.find((h) => h.playerId === action.targetPlayerId);
      const touched =
        target?.cards.filter((c) =>
          action.action === "clue_color" ? c.color === action.color : c.rank === action.rank
        ) ?? [];
      const newInfo = touched.filter((c) =>
        action.action === "clue_color"
          ? c.knowledge?.knownColor !== action.color
          : c.knowledge?.knownRank !== action.rank
      );
      detail = ` touches=${touched.map((c) => `${c.color}${c.rank}`).join(",") || "none"} newInfo=${newInfo.length}`;
    }
    return `legal dScore=${dScore} dMistake=${dMistake} dClue=${dClue}${detail}`;
  } catch (error) {
    return `ILLEGAL: ${error instanceof Error ? error.message : String(error)}`;
  }
}

for (const d of disputed) {
  const s = d.source;
  if (!s) {
    console.log(`\n### ${d.gameIqId}: SOURCE NOT FOUND (index shift?)`);
    continue;
  }
  console.log(`\n### ${d.gameIqId}  <-  ${s.id} (${s.category})`);
  console.log(`  title: ${s.title}`);
  if (s.description) console.log(`  desc: ${s.description}`);
  const state = prepared(s);
  describeState(state, s.actingPlayerId);
  console.log(`  KEYED expected:`);
  for (const e of s.expectedActions) {
    console.log(
      `    w=${e.weight} ${JSON.stringify(e.action)} -> ${describeOutcome(state, s.actingPlayerId, toEngineAction(e.action))}${e.note ? `  note: ${e.note}` : ""}`
    );
  }
  if (s.forbiddenActions?.length) {
    console.log(`  FORBIDDEN:`);
    for (const f of s.forbiddenActions) {
      console.log(
        `    ${JSON.stringify(f)} -> ${describeOutcome(state, s.actingPlayerId, toEngineAction(f))}`
      );
    }
  }
  console.log(`  MODEL answers:`);
  for (const m of d.modelAnswers) {
    console.log(
      `    ${m.model}: ${JSON.stringify(m.action)} -> ${describeOutcome(state, s.actingPlayerId, toEngineAction(m.action))}`
    );
  }
  console.log(`  ALL legal actions (engine):`);
  for (const a of getLegalFireworksActions(state, s.actingPlayerId)) {
    console.log(`    ${JSON.stringify(a)} -> ${describeOutcome(state, s.actingPlayerId, a)}`);
  }
}
