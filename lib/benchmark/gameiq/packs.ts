import { BATTLESHIP_V2_GAMEIQ_SCENARIOS } from "./battleship-v2";
import { CHESS_V2_GAMEIQ_SCENARIOS } from "./chess-v2";
import { CONNECT_FOUR_V2_GAMEIQ_SCENARIOS } from "./connect-four-v2";
import {
  FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
} from "./fireworks";
import {
  GAMEIQ_CORRECT_QUALITY_BAR,
  type GameIqGameId,
  type GameIqScenario,
  type GameIqScenarioPack,
} from "./types";
import { actionMatchesExpected } from "./validation";

// Certification tiers are honest labels, not decoration. A pack may only be
// marked "first-class" when it passes gameIqPackFirstClassFloor (a mechanical
// necessary-but-not-sufficient rigor check defined below and enforced by
// scripts/test-gameiq-shared-guards.mts) AND the pack's scenarios have been
// review-verified to measure the labeled skill. Tier history (2026-07 review):
// - fireworks-memory / fireworks-basic: before the 2026-07-02 regeneration a
//   single constant answer scored correct on 100% of scenarios.
// - codenames: RE-AUTHORED 2026-07-02 and PROMOTED to first-class — the old
//   25 legality clones were replaced with 10 distinct skill-binding decisions
//   (deduced guesses + binding clues); it now passes the rigor floor and a
//   constant baseline scores zero.
// - fireworks-hard: a single constant clue action aces half the pack.
// - 2026-07-02: all three fireworks packs regenerated (decision-slot variance,
//   needed_clue reachable, dead-card clue oracles fixed); they stay lightweight
//   pending a fresh discrimination review.
// - 2026-07-17: the saturated v0.1 battleship/chess/connect-four packs were
//   hard-deleted (their v0.2 depth/quiet-mate/hunt packs are the sole surviving
//   pack per game); historical run files that reference the old v0.1 pack ids
//   skip their traces gracefully on replay/recovery instead of resolving them.
const GAMEIQ_SCENARIO_PACKS: GameIqScenarioPack[] = [
  {
    id: "gameiq-v0.2-connect-four",
    gameId: "connect-four",
    label: "Certified GameIQ v2: Connect Four Depth",
    version: "0.1.0",
    certificationTier: "first-class",
    scenarios: CONNECT_FOUR_V2_GAMEIQ_SCENARIOS,
  },
  {
    id: "gameiq-v0.2-chess",
    gameId: "chess",
    label: "Certified GameIQ v2: Chess Quiet Mates",
    version: "0.1.0",
    certificationTier: "first-class",
    scenarios: CHESS_V2_GAMEIQ_SCENARIOS,
  },
  {
    id: "gameiq-v0.2-battleship",
    gameId: "battleship",
    label: "Certified GameIQ v2: Battleship Hunt",
    // 0.1.0: oracle-graded targeting pack (probability-ratio keys, hunt chains);
    // difficulty-gated against live frontier probes before shipping.
    version: "0.1.0",
    certificationTier: "first-class",
    scenarios: BATTLESHIP_V2_GAMEIQ_SCENARIOS,
  },
  // codenames was DROPPED from the benchmark entirely 2026-07-20 (user
  // decision): its hand-judged v0.1 keys violated the exact-key standard, and
  // the CSP-deduction v2 replacement (archived unmerged on branch
  // gameiq-codenames-deduction) proved frontier-saturated across two live-gated
  // difficulty iterations — GPT-5.5 solved 12/12 then 11/12. Bounded formal
  // deduction cannot challenge frontier models, so running it wastes benchmark
  // tokens. The playable codenames game (lib/games/codenames/) is unaffected.
  {
    id: "gameiq-fireworks-basic-v1",
    gameId: "fireworks",
    label: "Certified GameIQ v1: Fireworks Solo Control Basic",
    // 0.3.0: port now carries TeamIQ forbiddenActions (trap-blunder detection).
    // 0.4.0: its combine_color_and_rank memory scenarios are now delivered as
    // multi-turn recall episodes (clue history as earlier turns; decision turn
    // stripped of clue-identity channels). Content unchanged; scoring identical.
    // 0.4.1: equivalent-information clue widening pass now applies (no content
    // change in this pack; oracle-narrowness fix, 2026-07-03)
    // 0.4.2: removed dead maxResponseMs field (never enforced, never model-visible)
    version: "0.4.2",
    certificationTier: "lightweight",
    scenarios: FIREWORKS_GAMEIQ_BASIC_SCENARIOS,
  },
  {
    id: "gameiq-fireworks-hard-v1",
    gameId: "fireworks",
    label: "Certified GameIQ v1: Fireworks Trap States",
    // 0.3.0: port now carries TeamIQ forbiddenActions (trap-blunder detection).
    // 0.4.0: equivalent-information clues auto-keyed (oracle-narrowness fix, 2026-07-03)
    // 0.4.1: removed dead maxResponseMs field (never enforced, never model-visible)
    version: "0.4.1",
    certificationTier: "lightweight",
    scenarios: FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  },
  {
    id: "gameiq-fireworks-memory-v1",
    gameId: "fireworks",
    label: "Certified GameIQ v1: Fireworks Memory Stress",
    // 0.3.0: port now carries TeamIQ forbiddenActions (trap-blunder detection).
    // 0.4.0: memory scenarios are now delivered as genuine multi-turn recall
    // episodes — the seeded clue history is replayed as earlier conversation
    // turns and the decision turn carries no clue-identity channels, so the
    // model must RECALL. Content unchanged; scoring identical.
    // 0.4.1: equivalent-information clue widening pass now applies (no content
    // change in this pack; oracle-narrowness fix, 2026-07-03)
    // 0.4.2: removed dead maxResponseMs field (never enforced, never model-visible)
    version: "0.4.2",
    certificationTier: "lightweight",
    scenarios: FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function listGameIqScenarioPacks(): GameIqScenarioPack[] {
  return GAMEIQ_SCENARIO_PACKS.map(clone);
}

export function getGameIqScenarioPack(
  gameId: GameIqGameId
): GameIqScenarioPack | null {
  const pack = GAMEIQ_SCENARIO_PACKS.find(
    (candidate) => candidate.gameId === gameId
  );
  return pack ? clone(pack) : null;
}

export function getGameIqScenarioPackById(packId: string): GameIqScenarioPack | null {
  const pack = GAMEIQ_SCENARIO_PACKS.find((candidate) => candidate.id === packId);
  return pack ? clone(pack) : null;
}

export function listGameIqScenarios(): GameIqScenario[] {
  return GAMEIQ_SCENARIO_PACKS.flatMap((pack) => pack.scenarios).map(clone);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

// Shared "same decision" identity used by runner metric de-duplication and by
// the first-class rigor floor: two scenarios are the same decision only when
// the game, the canonical initial state, and the expected-action CONTENT
// (action + weight) all match. Label/note prose is deliberately excluded so
// duplicate boards cannot dodge collapse by rewording a note, and genuinely
// different boards that happen to share an expected action never merge.
export function gameIqDecisionKey(input: {
  gameId: GameIqGameId;
  initialState: unknown;
  expectedActions: Array<{ action: unknown; weight: number }>;
}): string {
  return stableStringify({
    gameId: input.gameId,
    initialState: input.initialState,
    expectedActions: input.expectedActions.map((expected) => ({
      action: expected.action,
      weight: expected.weight,
    })),
  });
}

export interface GameIqPackRigorFloor {
  ok: boolean;
  distinctDecisions: number;
  maxConstantAnswerRate: number;
  messages: string[];
}

export const GAMEIQ_FIRST_CLASS_MIN_DISTINCT_DECISIONS = 10;
export const GAMEIQ_FIRST_CLASS_MAX_CONSTANT_ANSWER_RATE = 0.5;

// Mechanical, necessary-but-not-sufficient rigor floor for the "first-class"
// certification tier (see the tier comment above GAMEIQ_SCENARIO_PACKS):
// 1. The pack must encode enough DISTINCT decisions (gameIqDecisionKey) that
//    its score carries real signal — re-skinned clones do not count.
// 2. No single constant answer may score correct on half or more of the
//    pack's scenarios; otherwise a board-blind baseline passes, violating the
//    "a naive baseline must fail" authoring rule. Candidate constants are the
//    pack's own expected actions (the strongest constants available), scored
//    through the real actionMatchesExpected path so legality-scored
//    categories (e.g. codenames clue-selection) are measured honestly.
// Passing this floor is required for first-class but does not grant it: a
// pack can pass mechanically and still be review-demoted (e.g. battleship's
// scenarios were authored against a leaked full-information state).
export function gameIqPackFirstClassFloor(
  pack: GameIqScenarioPack
): GameIqPackRigorFloor {
  const messages: string[] = [];
  const distinctDecisions = new Set(
    pack.scenarios.map((scenario) => gameIqDecisionKey(scenario))
  ).size;
  if (distinctDecisions < GAMEIQ_FIRST_CLASS_MIN_DISTINCT_DECISIONS) {
    messages.push(
      `Pack ${pack.id} has ${distinctDecisions} distinct decision(s); first-class needs at least ${GAMEIQ_FIRST_CLASS_MIN_DISTINCT_DECISIONS}.`
    );
  }

  const candidates = new Map<string, unknown>();
  for (const scenario of pack.scenarios) {
    for (const expected of scenario.expectedActions) {
      candidates.set(stableStringify(expected.action), expected.action);
    }
  }
  let maxConstantAnswerRate = 0;
  if (pack.scenarios.length > 0) {
    for (const candidate of candidates.values()) {
      const matched = pack.scenarios.filter(
        (scenario) =>
          actionMatchesExpected(scenario, candidate) >= GAMEIQ_CORRECT_QUALITY_BAR
      ).length;
      maxConstantAnswerRate = Math.max(
        maxConstantAnswerRate,
        matched / pack.scenarios.length
      );
    }
  }
  if (maxConstantAnswerRate >= GAMEIQ_FIRST_CLASS_MAX_CONSTANT_ANSWER_RATE) {
    messages.push(
      `Pack ${pack.id}: a single constant answer scores correct on ${Math.round(maxConstantAnswerRate * 100)}% of scenarios; first-class requires under ${Math.round(GAMEIQ_FIRST_CLASS_MAX_CONSTANT_ANSWER_RATE * 100)}%.`
    );
  }

  return {
    ok: messages.length === 0,
    distinctDecisions,
    maxConstantAnswerRate,
    messages,
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stableGameIqScenarioPackDigest(
  pack: GameIqScenarioPack
): string {
  return `gameiq-v1:${pack.id}:${hashString(stableStringify(pack))}`;
}
