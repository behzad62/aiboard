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

export const GAMEIQ_SCORING_VERSION = "certified-gameiq-v0.1";
export const GAMEIQ_PROMPT_SET_VERSION = "gameiq-v0.1";
export const GAMEIQ_HARNESS_VERSION = "gameiq-runner-v0.1";

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
  version: "0.1.0";
  prompt: string;
  initialState: TState;
  expectedActions: Array<GameIqExpectedAction<TAction>>;
  tags: string[];
  maxResponseMs: number;
}

export interface GameIqScenarioPack {
  id: string;
  gameId: GameIqGameId;
  label: string;
  version: "0.1.0";
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
  expectedActions: Array<GameIqExpectedAction>;
  action: unknown;
  rawResponse?: string;
  structured: boolean;
  legal: boolean;
  correct: boolean;
  actionQuality: number;
  latencyMs: number;
  latencyFactor: number;
  fallbackUsed: boolean;
  messages: string[];
}

export interface GameIqRunMetrics extends GameIqScoreInput {
  scenarioCount: number;
  structuredActions: number;
  legalActions: number;
  correctActions: number;
  fallbackActions: number;
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

export function statusFromScore(score: number): CertifiedAttemptStatus {
  return score >= 70 ? "passed" : "failed_model";
}
