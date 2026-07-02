import type { ChatMessage } from "@/lib/providers/base";
import { getFireworksPlayerView } from "@/lib/games/fireworks/hidden-view";
import type {
  FireworksColor,
  FireworksPlayerView,
} from "@/lib/games/fireworks/types";
import type { FireworksScenario } from "./types";

/**
 * Multi-turn "memory episode" delivery for Fireworks memory scenarios.
 *
 * Single-turn delivery handed the model every clue fact in the SAME prompt as
 * the decision (the seeded `events` array plus the resolved-by-clue
 * `ownHand.knowledge` channels — clueHistory / notColors / notRanks). That made
 * the "memory" packs pure transcription: read a JSON field, answer.
 *
 * This module replays the clue/history facts as EARLIER conversation turns
 * (each seeded clue as it happened, interleaved with neutral distractor turns
 * drawn deterministically from the scenario's own fixture) and then presents a
 * final decision turn whose observable state carries ONLY currently-visible
 * facts — the clue-identity channels are stripped, so the model must RECALL the
 * clue information from the conversation to act correctly.
 *
 * The core is view-driven so both benchmark paths share it:
 * - TeamIQ passes the redacted player view it computes from scenario.state.
 * - GameIQ passes the already-redacted scenario.initialState (same view shape).
 *
 * Scoring is unchanged: validation/scoring always run against the full
 * scenario.state / scenario.initialState, never this stripped view.
 */

export interface FireworksMemoryEpisode {
  messages: ChatMessage[];
  /** The player view shown in the final decision turn (identity-stripped). */
  decisionView: FireworksPlayerView;
  /**
   * The clue-identity facts (color/rank strings, notX statements) that were
   * moved into earlier turns. Exposed so tests can assert the decision turn
   * contains none of them and the earlier turns contain them.
   */
  recalledFacts: string[];
}

export interface FireworksMemoryEpisodeInput {
  /** System prompt reused from the single-turn path (kept identical). */
  system: string;
  /**
   * The redacted player view (own color/rank nulled, but clue events and
   * clueHistory/notColors/notRanks still present). The recall facts are mined
   * from this view, then stripped from the decision turn.
   */
  view: FireworksPlayerView;
  /** Hand slot the scenario decides about (used for negative-knowledge recall). */
  decisionSlot: number;
  /** Stable id used only to derive deterministic distractor ordering. */
  episodeId: string;
}

/**
 * True when a scenario is a memory-category scenario whose clue history must be
 * delivered as a recall episode rather than in the decision prompt.
 */
export function isFireworksMemoryScenario(scenario: FireworksScenario): boolean {
  return scenario.suite === "fireworks-memory-v0.1";
}

/**
 * The hand slot the scenario's weight-1 expected action decides about
 * (play/discard). Clue and non-card actions default to slot 0. Accepts any
 * expected-action list (the GameIQ union type included) and narrows at runtime.
 */
export function fireworksDecisionSlot(scenario: {
  expectedActions: Array<{ action: unknown; weight: number }>;
}): number {
  const primary =
    scenario.expectedActions.find((expected) => expected.weight === 1) ??
    scenario.expectedActions[0];
  const action = primary?.action as
    | { action?: string; cardIndex?: number }
    | undefined;
  if (
    action &&
    (action.action === "play" || action.action === "discard") &&
    typeof action.cardIndex === "number"
  ) {
    return action.cardIndex;
  }
  return 0;
}

/**
 * Convenience wrapper for the TeamIQ path: build the redacted view from the raw
 * scenario state and delegate to the view-driven builder.
 */
export function buildFireworksMemoryEpisodeForScenario(
  scenario: FireworksScenario,
  options: { system: string; playerId: string }
): FireworksMemoryEpisode {
  const view = getFireworksPlayerView(scenario.state, options.playerId, {
    omitRecommendations: true,
    redactOwnIdentity: true,
  });
  return buildFireworksMemoryEpisode({
    system: options.system,
    view,
    decisionSlot: fireworksDecisionSlot(scenario),
    episodeId: scenario.id,
  });
}

/**
 * Build the multi-turn conversation for a memory scenario view. The returned
 * `messages` are the full ChatMessage[] to send in one model CALL (more
 * messages, not more calls).
 */
export function buildFireworksMemoryEpisode(
  input: FireworksMemoryEpisodeInput
): FireworksMemoryEpisode {
  const view = input.view;
  const playerId = view.playerId;

  const clueTurns = buildClueRecallTurns(view, playerId, input.decisionSlot);
  const distractorTurns = buildDistractorTurns(view, playerId, input.episodeId);
  const orderedHistory = interleave(clueTurns, distractorTurns);

  const decisionView = stripRecalledClueChannels(view, playerId);
  const recalledFacts = clueTurns.flatMap((turn) => turn.facts);

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${input.system}

This is a multi-turn recall exercise. Clue information and table events are narrated to you as they happen over several turns and are NOT repeated in the final position. Track your own cards' colors and ranks from what you are told; your own hand in the final view will show no resolved identity or clue history.`,
    },
    {
      role: "user",
      content: `You are ${playerId}. The game is in progress. I will narrate what happens at the table turn by turn. Acknowledge each event; you will be asked to act only when it is your turn.`,
    },
    { role: "assistant", content: "Understood. I am tracking the table." },
  ];

  for (const turn of orderedHistory) {
    messages.push({ role: "user", content: turn.narration });
    messages.push({ role: "assistant", content: turn.acknowledgment });
  }

  messages.push({
    role: "user",
    content: buildDecisionTurn(decisionView, playerId),
  });

  return { messages, decisionView, recalledFacts };
}

interface RecallTurn {
  narration: string;
  acknowledgment: string;
  /** Identity facts this turn establishes (color/rank strings, notX lines). */
  facts: string[];
  turnNumber: number;
}

/**
 * One recall turn per seeded clue event that targeted the acting player, plus
 * one turn for the decision card's eliminations (negative_information records
 * them only as prior knowledge). Ordered by the turn the fact was established.
 *
 * Each clue turn narrates the clue's PER-SLOT effect (which of your cards it
 * marked and which it ruled out), reconstructed from the own-hand knowledge
 * channels the redacted view still carries (clueHistory for positives,
 * notColors/notRanks for negatives). That is exactly the recall content the
 * single-turn prompt used to hand over in a JSON field; here it is delivered as
 * an earlier turn and then stripped from the decision position, so the model
 * must remember which card each clue touched.
 */
function buildClueRecallTurns(
  view: FireworksPlayerView,
  playerId: string,
  decisionSlot: number
): RecallTurn[] {
  const turns: RecallTurn[] = [];
  const slotCount = view.ownHand.knowledge.length;

  for (const event of view.events) {
    const action = event.action;
    if (action.action !== "clue_color" && action.action !== "clue_rank") {
      continue;
    }
    if (action.targetPlayerId !== playerId) continue;
    const clueSubject =
      action.action === "clue_color"
        ? colorWord(action.color)
        : `rank ${action.rank}`;
    const marker =
      action.action === "clue_color"
        ? `Turn ${event.turn}: ${clueSubject}`
        : `Turn ${event.turn}: rank ${action.rank}`;
    const touched: number[] = [];
    for (let slot = 0; slot < slotCount; slot++) {
      const knowledge = view.ownHand.knowledge[slot];
      if (knowledge?.clueHistory.includes(marker)) touched.push(slot);
    }
    // Narrate each touched card individually ("card N is <subject>") so the
    // per-slot attribution is unambiguous even when a clue marks several cards.
    const touchedLabel = touched.length
      ? touched.map((slot) => `card ${slot + 1} is ${clueSubject}`).join("; ")
      : `none of your cards are ${clueSubject}`;
    const untouched = Array.from({ length: slotCount }, (_, slot) => slot).filter(
      (slot) => !touched.includes(slot)
    );
    const untouchedLabel = untouched.length
      ? ` Your other cards (${untouched
          .map((slot) => `card ${slot + 1}`)
          .join(", ")}) are not ${clueSubject}.`
      : "";
    turns.push({
      turnNumber: event.turn,
      narration: `Turn ${event.turn}: ${event.playerId} clues you "${clueSubject}": ${touchedLabel}.${untouchedLabel}`,
      acknowledgment: `Noted turn ${event.turn}: ${touchedLabel}.`,
      facts: [
        clueSubject,
        `Turn ${event.turn}`,
        ...touched.map((slot) => `card ${slot + 1} is ${clueSubject}`),
      ],
    });
  }

  turns.push(...buildKnowledgeDeductionTurns(view, decisionSlot));

  return turns.sort((a, b) => a.turnNumber - b.turnNumber);
}

/**
 * Turns for the DECISION card's negative knowledge (notColors / notRanks) —
 * facts that were seeded as prior knowledge / eliminations rather than as
 * positive clue events. Narrated as an earlier deduction so the decision turn
 * need not carry them. Only the decision slot is narrated: other slots' engine
 * bookkeeping negatives are not part of the decision and would add noise.
 */
function buildKnowledgeDeductionTurns(
  view: FireworksPlayerView,
  decisionSlot: number
): RecallTurn[] {
  const knowledge = view.ownHand.knowledge[decisionSlot];
  if (!knowledge) return [];
  const facts: string[] = [];
  for (const color of knowledge.notColors) {
    facts.push(`your decision card is not ${colorWord(color)}`);
  }
  for (const rank of knowledge.notRanks) {
    facts.push(`your decision card is not rank ${rank}`);
  }
  if (facts.length === 0) return [];
  return [
    {
      turnNumber: 0,
      narration: `Earlier in the game you had already eliminated possibilities for the card you will decide about: ${facts.join("; ")}.`,
      acknowledgment: "Noted those eliminations.",
      facts,
    },
  ];
}

/**
 * Deterministic neutral distractor turns: other players' unrelated table moves.
 * Drawn from the acting player's own visible information (the partner's actual
 * hand) — never from the acting player's hidden decision card — so they add
 * context pressure without leaking the answer. No runtime randomness: the
 * content is a pure function of the view + episode id.
 */
function buildDistractorTurns(
  view: FireworksPlayerView,
  playerId: string,
  episodeId: string
): RecallTurn[] {
  const partnerHand = view.otherHands.find((hand) => hand.playerId !== playerId);
  const partner = partnerHand?.playerId ?? (playerId === "P1" ? "P2" : "P1");
  const partnerCards = partnerHand?.cards ?? [];
  const turns: RecallTurn[] = [];
  const base = scenarioHash(episodeId);
  const distractorCount = Math.min(2, Math.max(1, partnerCards.length));
  for (let index = 0; index < distractorCount; index++) {
    const card =
      partnerCards.length > 0
        ? partnerCards[(base + index) % partnerCards.length]
        : undefined;
    const clueSubject =
      card && card.color != null && card.rank != null
        ? index % 2 === 0
          ? colorWord(card.color)
          : `rank ${card.rank}`
        : "rank 3";
    turns.push({
      turnNumber: base + index * 2 + 1,
      narration: `Meanwhile ${partner} received a clue about "${clueSubject}" for THEIR hand. This does not concern your cards.`,
      acknowledgment: `Noted ${partner}'s clue; it is about their hand, not mine.`,
      facts: [],
    });
  }
  return turns;
}

/**
 * Interleave clue turns with distractors so a real clue is never adjacent to
 * the next real clue, adding recall pressure. Deterministic: distractors are
 * consumed in order between clue turns.
 */
function interleave(
  clueTurns: RecallTurn[],
  distractors: RecallTurn[]
): RecallTurn[] {
  const ordered: RecallTurn[] = [];
  let distractorIndex = 0;
  clueTurns.forEach((turn, index) => {
    ordered.push(turn);
    if (index < clueTurns.length - 1 && distractorIndex < distractors.length) {
      ordered.push(distractors[distractorIndex]);
      distractorIndex += 1;
    }
  });
  // Any remaining distractors go before the final decision, still separated
  // from the last real clue.
  while (distractorIndex < distractors.length) {
    ordered.push(distractors[distractorIndex]);
    distractorIndex += 1;
  }
  return ordered;
}

/**
 * Remove the clue-identity channels from the view shown in the decision turn:
 * the seeded clue events (delivered as earlier turns) and the own-hand
 * clueHistory / notColors / notRanks (recalled from earlier turns). The
 * resolved color/rank are already null from redactOwnIdentity.
 */
export function stripRecalledClueChannels(
  view: FireworksPlayerView,
  playerId: string
): FireworksPlayerView {
  return {
    ...view,
    // Drop seeded clue events targeting the acting player — those are the recall
    // history now delivered turn by turn. Keep any unrelated events untouched.
    events: view.events.filter(
      (event) =>
        !(
          (event.action.action === "clue_color" ||
            event.action.action === "clue_rank") &&
          event.action.targetPlayerId === playerId &&
          event.seeded === true
        )
    ),
    ownHand: {
      ...view.ownHand,
      cards: view.ownHand.cards.map((card) => ({
        ...card,
        knowledge: card.knowledge
          ? {
              ...card.knowledge,
              notColors: [],
              notRanks: [],
              clueHistory: [],
            }
          : card.knowledge,
      })),
      knowledge: view.ownHand.knowledge.map((knowledge) => ({
        ...knowledge,
        notColors: [],
        notRanks: [],
        clueHistory: [],
      })),
    },
  };
}

function buildDecisionTurn(view: FireworksPlayerView, playerId: string): string {
  return `It is now your turn (${playerId}). Here is the current position. Your own hand shows no colors, ranks, or clue history — use what you were told over the previous turns to decide.

Current position JSON:
${JSON.stringify(view)}

Choose exactly one legal action.`;
}

function colorWord(color: FireworksColor): string {
  return color;
}

function scenarioHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 97;
}
