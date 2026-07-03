import type {
  BenchmarkAttemptV2,
  CertifiedAttemptStatus,
} from "@/lib/benchmark/types";
import type { GameIqScoreInput } from "@/lib/benchmark/scoring/types";
import type { BattleshipCoordinate } from "@/lib/games/battleship/types";
import type { CodenamesClue } from "@/lib/games/codenames/types";
import type { ConnectFourGameState } from "@/lib/games/connect-four/types";
import type {
  FireworksAction,
  FireworksPlayerView,
} from "@/lib/games/fireworks/types";
import type { Move, PieceType } from "@/lib/games/chess/types";

export const GAMEIQ_SCORING_VERSION = "certified-gameiq-v0.3";
// v0.2: model prompt no longer includes scenario titles/notes (answer-leak
// scrub), adds per-game rules/answer conventions, redacts hidden-information
// state (battleship), and uses non-scoreable shape-example placeholders.
// v0.3: fireworks actionQuality is graded (keyed weight / forbidden 0 /
// dead-card clue 0.1 / other legal 0.3) instead of binary exact-match against
// expectedActions; `correct` now requires actionQuality >=
// GAMEIQ_CORRECT_QUALITY_BAR so the 0.3 neutral floor never counts as
// correct; and the score reweights to outcome 0.6 / moveQuality 0.4 / legality
// 0 / structure 0 (legality and structure are enforced by the
// statusFromScore failed_tool_use gate, not score points).
export const GAMEIQ_PROMPT_SET_VERSION = "gameiq-v0.2";
// v0.2: distinct-group metric key now includes the canonical initial state and
// ignores expected-action label/note prose, changing metric aggregation.
// v0.3: transport-failed scenarios (transient provider errors surviving
// retries) are excluded from scoring (unscored:"transport") instead of
// counted as wrong; >GAMEIQ_MAX_UNSCORED_RATE unscored, or zero scored,
// invalidates the attempt (provider_unavailable).
export const GAMEIQ_HARNESS_VERSION = "gameiq-runner-v0.3";
// Minimum actionQuality that counts as a CORRECT outcome. Graded fireworks
// quality can award sub-bar partial credit (0.1 dead clue / 0.3 neutral) that
// feeds moveQuality without ever counting as correct.
export const GAMEIQ_CORRECT_QUALITY_BAR = 0.75;
// Fraction of a pack's scenarios that may fail transport (after retries)
// before the attempt is invalid for scoring; at/under this, the attempt
// scores on the scenarios that ran.
export const GAMEIQ_MAX_UNSCORED_RATE = 0.1;

export type GameIqGameId =
  | "connect-four"
  | "chess"
  | "battleship"
  | "codenames"
  | "fireworks";

export type GameIqCertificationTier = "first-class" | "lightweight";

export type GameIqScenarioCategory =
  | "win-in-one"
  | "block-win"
  | "trap-setup"
  | "avoid-losing-move"
  | "mate-in-one"
  | "legal-tactic"
  | "target-priority"
  | "clue-selection"
  | "hidden-cooperation";

export interface GameIqExpectedAction<TAction = GameIqAction> {
  action: TAction;
  label: string;
  weight: number;
  note?: string;
}

export interface GameIqScenario<TState = unknown, TAction = GameIqAction> {
  id: string;
  gameId: GameIqGameId;
  title: string;
  category: GameIqScenarioCategory;
  difficulty: "easy" | "medium" | "hard";
  // String (not a literal) so ported scenarios can carry their own content
  // version; forbiddenActions carry-through widened this from "0.1.0".
  version: string;
  prompt: string;
  initialState: TState;
  expectedActions: Array<GameIqExpectedAction<TAction>>;
  // Actions that are specifically wrong for this scenario (e.g. falling into a
  // trap state), distinct from any ordinary legal-but-suboptimal move. A match
  // scores 0 AND raises a distinct blunder flag on the result so a trap failure
  // is visible as a trap failure, not a generic miss.
  forbiddenActions?: TAction[];
  tags: string[];
  maxResponseMs: number;
}

export interface GameIqScenarioPack {
  id: string;
  gameId: GameIqGameId;
  label: string;
  // Bumped whenever pack content (scenarios or certification tier) changes.
  version: string;
  certificationTier: GameIqCertificationTier;
  scenarios: GameIqScenario[];
}

export interface GameIqValidationResult {
  ok: boolean;
  messages: string[];
}

export interface GameIqMoveProviderRequest {
  scenario: GameIqScenario;
  scenarioIndex: number;
  totalScenarios: number;
}

export interface GameIqProviderResult {
  action: unknown;
  rawResponse?: string;
  latencyMs?: number;
  fallbackUsed?: boolean;
}

export type GameIqMoveProvider = (
  request: GameIqMoveProviderRequest
) => Promise<GameIqProviderResult | unknown> | GameIqProviderResult | unknown;

export interface GameIqScenarioResult {
  scenarioId: string;
  gameId: GameIqGameId;
  category: GameIqScenarioCategory;
  // Canonical scenario state, carried so metric de-duplication can key on the
  // actual decision (game + state + expected action content), not on prose.
  initialState: unknown;
  expectedActions: Array<GameIqExpectedAction>;
  action: unknown;
  rawResponse?: string;
  structured: boolean;
  legal: boolean;
  correct: boolean;
  actionQuality: number;
  latencyMs: number;
  // True when the chosen action matched one of the scenario's forbiddenActions
  // (e.g. fell into a trap). Distinct from a generic wrong move: correct is
  // false and actionQuality is forced to 0, but this flag lets the verifier
  // surface a trap failure as a trap failure.
  forbiddenBlunder: boolean;
  fallbackUsed: boolean;
  messages: string[];
  // Set when this scenario could not be scored because the provider call
  // failed transport (transient error surviving B1's retries). Excluded from
  // every scoring metric denominator; distinct from a scored-but-wrong result.
  unscored?: "transport";
}

export interface GameIqRunMetrics extends GameIqScoreInput {
  scenarioCount: number;
  // Scenarios actually scored, i.e. scenarioCount minus unscoredTransport.
  // All rate metrics below (outcomeScore, moveQuality, legalActionRate,
  // structuredReliability, fallbackRate) and the informational counts are
  // computed over this subset only.
  scoredScenarioCount: number;
  // Count of scenarios excluded from scoring due to a transient transport
  // failure surviving retries (GameIqScenarioResult.unscored === "transport").
  unscoredTransport: number;
  structuredActions: number;
  legalActions: number;
  correctActions: number;
  fallbackActions: number;
  // Count of scenarios where the model matched a forbiddenAction (trap). These
  // also count as wrong (not correct) but are surfaced separately so a pack
  // with trap states can report how often models fell into the trap.
  forbiddenBlunders: number;
}

export interface GameIqRunResult {
  score: number;
  metrics: GameIqRunMetrics;
  caseResults: GameIqScenarioResult[];
  attempt: BenchmarkAttemptV2;
}

export interface RunGameIqScenariosInput {
  runId: string;
  modelId: string;
  teamCompositionId: string;
  scenarios: GameIqScenario[];
  moveProvider: GameIqMoveProvider;
  caseId?: string;
  startedAt?: string;
  harnessProfile?: BenchmarkAttemptV2["harnessProfile"];
}

export type ConnectFourGameIqAction = { column: number };
export type ChessGameIqAction = Move & { promotion?: PieceType };
export type BattleshipGameIqAction = { target: BattleshipCoordinate };
export type CodenamesGameIqAction =
  | { type: "clue"; clue: CodenamesClue }
  | { type: "guess"; cardId: string };

export type GameIqAction =
  | ConnectFourGameIqAction
  | ChessGameIqAction
  | BattleshipGameIqAction
  | CodenamesGameIqAction
  | FireworksAction;

export type ConnectFourGameIqScenario = GameIqScenario<
  ConnectFourGameState,
  ConnectFourGameIqAction
>;

export type ChessGameIqScenario = GameIqScenario<
  { fen: string },
  ChessGameIqAction
>;

export type BattleshipGameIqScenario = GameIqScenario<
  unknown,
  BattleshipGameIqAction
>;

export type CodenamesGameIqScenario = GameIqScenario<
  unknown,
  CodenamesGameIqAction
>;

export type FireworksGameIqScenario = GameIqScenario<
  FireworksPlayerView,
  FireworksAction
>;

export function statusFromScore(
  score: number,
  metrics?: Pick<GameIqRunMetrics, "structuredReliability" | "legalActionRate">
): CertifiedAttemptStatus {
  if (
    metrics &&
    (metrics.structuredReliability < 1 || metrics.legalActionRate < 1)
  ) {
    return "failed_tool_use";
  }
  return score >= 70 ? "passed" : "failed_model";
}
