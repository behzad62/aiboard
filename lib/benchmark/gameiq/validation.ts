import {
  dropDisc,
  getLegalColumns,
} from "@/lib/games/connect-four/engine";
import type {
  ConnectFourGameState,
  ConnectFourPlayer,
} from "@/lib/games/connect-four/types";
import {
  fromFEN,
  isLegalMove,
  makeMove,
} from "@/lib/games/chess/engine";
import type { Move, PieceType } from "@/lib/games/chess/types";
import {
  isLegalBattleshipTarget,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
} from "@/lib/games/battleship/types";
import { battleshipCellRatios } from "./battleship-oracle";
import { classifyConnectFourColumns } from "./connect-four-solver";
import {
  submitCodenamesGuess,
  validateCodenamesClue,
} from "@/lib/games/codenames/engine";
import type { CodenamesGameState } from "@/lib/games/codenames/types";
import { fireworksActionsEqual } from "@/lib/games/fireworks/engine";
import type {
  FireworksAction,
  FireworksPlayerView,
} from "@/lib/games/fireworks/types";
import type {
  BattleshipGameIqAction,
  BattleshipGameIqScenario,
  ChessGameIqAction,
  CodenamesGameIqAction,
  ConnectFourGameIqAction,
  ConnectFourGameIqScenario,
  FireworksGameIqScenario,
  GameIqAction,
  GameIqScenario,
  GameIqValidationResult,
} from "./types";

// Reserved codenames clue word used by the prompt's JSON shape example
// (certified-runner.ts). Because clue-selection scenarios score bare legality,
// the literal example word must never be a legal clue, or echoing the format
// example would earn full credit.
export const GAMEIQ_PLACEHOLDER_CLUE_WORD = "example";

function ok(): GameIqValidationResult {
  return { ok: true, messages: [] };
}

function fail(message: string): GameIqValidationResult {
  return { ok: false, messages: [message] };
}

function combine(results: GameIqValidationResult[]): GameIqValidationResult {
  const messages = results.flatMap((result) => result.messages);
  return {
    ok: results.every((result) => result.ok),
    messages,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Canonical chess promotion vocabulary (matches the engine's PieceType and the
// model-visible prompt) mapped from every accepted synonym: single-letter UCI
// style (q/r/b/n) and the full words, any case. Expected actions already use
// the canonical strings; this only rescues a chess-correct candidate whose
// promotion piece is spelled differently on providers without schema
// enforcement.
const CHESS_PROMOTION_SYNONYMS: Record<string, PieceType> = {
  q: "queen",
  queen: "queen",
  r: "rook",
  rook: "rook",
  b: "bishop",
  bishop: "bishop",
  n: "knight",
  knight: "knight",
};

// Normalize a candidate chess action's promotion field to the canonical piece
// string, in place. Runs candidate-side only (at the isStructuredGameIqAction
// gate that every scoring path shares) so downstream legality
// (validateChessAction) and equality (actionsEqual) see one canonical value.
// A no-op for already-canonical values and for unrecognized strings (those
// stay as-is and correctly fail legality).
function normalizeChessPromotion(action: Record<string, unknown>): void {
  if (typeof action.promotion !== "string") return;
  const canonical = CHESS_PROMOTION_SYNONYMS[action.promotion.trim().toLowerCase()];
  if (canonical) action.promotion = canonical;
}

function nextConnectFourPlayer(
  player: ConnectFourPlayer
): ConnectFourPlayer {
  return player === "red" ? "yellow" : "red";
}

function hasImmediateConnectFourWin(
  state: ConnectFourGameState,
  player: ConnectFourPlayer
): boolean {
  const testState = { ...state, turn: player };
  return getLegalColumns(testState).some((column) => {
    try {
      return dropDisc(testState, column, 0).winner === player;
    } catch {
      return false;
    }
  });
}

function countImmediateConnectFourWins(
  state: ConnectFourGameState,
  player: ConnectFourPlayer
): number {
  const testState = { ...state, turn: player };
  return getLegalColumns(testState).filter((column) => {
    try {
      return dropDisc(testState, column, 0).winner === player;
    } catch {
      return false;
    }
  }).length;
}

export function isStructuredGameIqAction(
  scenario: GameIqScenario,
  action: unknown
): action is GameIqAction {
  if (!isRecord(action)) return false;

  switch (scenario.gameId) {
    case "connect-four":
      return Number.isInteger(action.column);
    case "chess":
      if (
        typeof action.from === "string" &&
        typeof action.to === "string" &&
        (action.promotion == null || typeof action.promotion === "string")
      ) {
        // Canonicalize promotion synonyms once here, at the gate every scoring
        // path shares, so legality and equality checks see canonical strings.
        normalizeChessPromotion(action);
        return true;
      }
      return false;
    case "battleship":
      return (
        isRecord(action.target) &&
        Number.isInteger(action.target.row) &&
        Number.isInteger(action.target.column)
      );
    case "codenames":
      if (action.type === "guess") return typeof action.cardId === "string";
      return (
        action.type === "clue" &&
        isRecord(action.clue) &&
        typeof action.clue.word === "string" &&
        Number.isInteger(action.clue.count)
      );
    case "fireworks":
      return isStructuredFireworksAction(action);
    default:
      return false;
  }
}

export function validateGameIqAction(
  scenario: GameIqScenario,
  action: unknown
): GameIqValidationResult {
  if (!isStructuredGameIqAction(scenario, action)) {
    return fail("Action does not match the expected GameIQ action shape.");
  }

  switch (scenario.gameId) {
    case "connect-four":
      return validateConnectFourAction(
        scenario.initialState as ConnectFourGameState,
        action as ConnectFourGameIqAction
      );
    case "chess":
      return validateChessAction(
        scenario.initialState as { fen: string },
        action as ChessGameIqAction
      );
    case "battleship":
      return validateBattleshipAction(
        scenario.initialState as BattleshipGameState,
        action as BattleshipGameIqAction
      );
    case "codenames":
      return validateCodenamesAction(
        scenario.initialState as CodenamesGameState,
        action as CodenamesGameIqAction
      );
    case "fireworks":
      return validateFireworksAction(
        scenario as FireworksGameIqScenario,
        action as FireworksAction
      );
    default:
      return fail(`Unsupported GameIQ game: ${scenario.gameId}`);
  }
}

export function validateGameIqScenario(
  scenario: GameIqScenario
): GameIqValidationResult {
  if (scenario.expectedActions.length === 0) {
    return fail("Scenario has no expected actions.");
  }

  const expectedResults = scenario.expectedActions.map((expectedAction) =>
    validateGameIqAction(scenario, expectedAction.action)
  );
  const categoryResult = validateScenarioCategory(scenario);
  return combine([...expectedResults, categoryResult]);
}

function validateConnectFourAction(
  state: ConnectFourGameState,
  action: ConnectFourGameIqAction
): GameIqValidationResult {
  if (!getLegalColumns(state).includes(action.column)) {
    return fail(`Illegal Connect Four column: ${action.column}.`);
  }
  return ok();
}

function validateChessAction(
  initialState: { fen: string },
  action: ChessGameIqAction
): GameIqValidationResult {
  try {
    const state = fromFEN(initialState.fen);
    const move: Move = {
      from: action.from,
      to: action.to,
      ...(action.promotion ? { promotion: action.promotion } : {}),
    };
    return isLegalMove(state, move)
      ? ok()
      : fail(`Illegal chess move: ${action.from}${action.to}.`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function validateBattleshipAction(
  state: BattleshipGameState,
  action: BattleshipGameIqAction
): GameIqValidationResult {
  const target: BattleshipCoordinate = action.target;
  return isLegalBattleshipTarget(state, state.turn, target)
    ? ok()
    : fail(`Illegal Battleship target: ${target.row}:${target.column}.`);
}

function validateCodenamesAction(
  state: CodenamesGameState,
  action: CodenamesGameIqAction
): GameIqValidationResult {
  try {
    if (action.type === "clue") {
      if (
        action.clue.word.trim().toUpperCase() ===
        GAMEIQ_PLACEHOLDER_CLUE_WORD.toUpperCase()
      ) {
        return fail(
          `Clue word "${GAMEIQ_PLACEHOLDER_CLUE_WORD}" is the reserved format placeholder and is not a legal clue.`
        );
      }
      const validation = validateCodenamesClue(state, action.clue);
      return validation.ok ? ok() : fail(validation.error);
    }
    submitCodenamesGuess(state, action.cardId, 0);
    return ok();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function validateFireworksAction(
  scenario: FireworksGameIqScenario,
  action: FireworksAction
): GameIqValidationResult {
  const view = scenario.initialState as FireworksPlayerView;
  return view.legalActions.some((legalAction) =>
    fireworksActionsEqual(legalAction, action)
  )
    ? ok()
    : fail(`Illegal Fireworks action: ${JSON.stringify(action)}.`);
}

function validateScenarioCategory(
  scenario: GameIqScenario
): GameIqValidationResult {
  if (scenario.gameId === "connect-four") {
    return validateConnectFourCategory(scenario);
  }
  if (scenario.gameId === "chess" && scenario.category === "mate-in-one") {
    return validateChessMateInOne(scenario);
  }
  return ok();
}

function validateConnectFourCategory(
  scenario: GameIqScenario
): GameIqValidationResult {
  const state = scenario.initialState as ConnectFourGameState;
  const expected = scenario.expectedActions[0]?.action as
    | ConnectFourGameIqAction
    | undefined;
  if (!expected) return fail("Connect Four scenario has no expected action.");

  if (scenario.category === "win-in-one") {
    const nextState = dropDisc(state, expected.column, 0);
    return nextState.status === "win" && nextState.winner === state.turn
      ? ok()
      : fail("Connect Four win-in-one action does not win immediately.");
  }

  if (
    scenario.category === "block-win" ||
    scenario.category === "avoid-losing-move"
  ) {
    const opponent = nextConnectFourPlayer(state.turn);
    if (!hasImmediateConnectFourWin(state, opponent)) {
      return fail("Connect Four defense scenario has no immediate threat.");
    }
    const nextState = dropDisc(state, expected.column, 0);
    return hasImmediateConnectFourWin(nextState, opponent)
      ? fail("Connect Four expected action does not stop the immediate threat.")
      : ok();
  }

  if (scenario.category === "trap-setup") {
    // A genuine trap creates a DOUBLE threat: after the expected drop, the
    // mover must have two or more columns that win immediately, so the
    // opponent can only block one. Re-derive this from the engine rather than
    // trusting the hand-authored expected column.
    const player = state.turn;
    const nextState = dropDisc(state, expected.column, 0);
    const winningContinuations = countImmediateConnectFourWins(nextState, player);
    return winningContinuations >= 2
      ? ok()
      : fail(
          `Connect Four trap-setup creates ${winningContinuations} winning follow-up(s); a double threat needs at least 2.`
        );
  }

  return ok();
}

function validateChessMateInOne(
  scenario: GameIqScenario
): GameIqValidationResult {
  const state = fromFEN((scenario.initialState as { fen: string }).fen);
  const results = scenario.expectedActions.map((expectedAction) => {
    const action = expectedAction.action as ChessGameIqAction;
    const nextState = makeMove(state, action);
    return nextState.status === "checkmate"
      ? ok()
      : fail(`Expected mate-in-one did not checkmate: ${expectedAction.label}`);
  });
  return combine(results);
}

export function actionMatchesExpected(
  scenario: GameIqScenario,
  action: unknown
): number {
  if (!isStructuredGameIqAction(scenario, action)) return 0;

  if (scenario.gameId === "codenames" && scenario.category === "clue-selection") {
    return validateGameIqAction(scenario, action).ok ? 1 : 0;
  }

  if (scenario.gameId === "fireworks") {
    return gradeFireworksAction(scenario as FireworksGameIqScenario, action);
  }

  if (scenario.gameId === "battleship") {
    return gradeBattleshipAction(scenario as BattleshipGameIqScenario, action);
  }

  if (scenario.gameId === "connect-four" && scenario.category === "depth-only-move") {
    return gradeConnectFourDepthAction(
      scenario as ConnectFourGameIqScenario,
      action
    );
  }

  let bestWeight = 0;
  for (const expectedAction of scenario.expectedActions) {
    if (actionsEqual(scenario.gameId, action, expectedAction.action)) {
      bestWeight = Math.max(bestWeight, expectedAction.weight);
    }
  }
  return Math.min(1, Math.max(0, bestWeight));
}

// Depth scenarios: quality = solver class distance. Keyed column = 1.0;
// a legal column exactly one class-step worse = 0.3; two steps = 0.0.
// Illegality stays a gate upstream (statusFromScore), mirroring battleship.
function gradeConnectFourDepthAction(
  scenario: ConnectFourGameIqScenario,
  action: GameIqAction
): number {
  const column = Number((action as { column?: unknown }).column);
  if (!Number.isInteger(column)) return 0;
  const board = scenario.initialState.board;
  const turn = scenario.initialState.turn;
  let classes;
  try {
    classes = classifyConnectFourColumns(board, turn);
  } catch {
    return 0;
  }
  const rank = (moveClass: string) =>
    moveClass === "win" ? 2 : moveClass === "draw" ? 1 : 0;
  const bestRank = Math.max(...classes.map((entry) => rank(entry.moveClass)));
  const chosen = classes.find((entry) => entry.column === column);
  if (!chosen) return 0;
  const gap = bestRank - rank(chosen.moveClass);
  return gap === 0 ? 1 : gap === 1 ? 0.3 : 0;
}

// Sub-bar partial-credit grades for fireworks actions. Both values must stay
// in lockstep with TeamIQ's scoreFireworksScenarioAction
// (lib/benchmark/fireworks/scenario-packs.ts), which grades the same
// decisions on the TeamIQ track — a drift would score the identical action
// differently across tracks.
export const FIREWORKS_DEAD_CLUE_GRADE = 0.1;
export const FIREWORKS_NEUTRAL_LEGAL_GRADE = 0.3;

// Graded quality for fireworks actions (GameIQ port of TeamIQ's
// scoreFireworksScenarioAction). Keyed match earns the keyed weight; a
// forbidden action earns 0; a clue that touches only already-played cards
// earns FIREWORKS_DEAD_CLUE_GRADE; any other legal action earns the
// FIREWORKS_NEUTRAL_LEGAL_GRADE floor. The neutral floor is deliberately
// below GAMEIQ_CORRECT_QUALITY_BAR so it feeds moveQuality without ever
// counting as a correct outcome.
export function gradeFireworksAction(
  scenario: FireworksGameIqScenario,
  action: unknown
): number {
  if (!isStructuredGameIqAction(scenario, action)) return 0;
  const candidate = action as FireworksAction;
  const view = scenario.initialState;

  if (
    (scenario.forbiddenActions ?? []).some((forbidden) =>
      fireworksActionsEqual(forbidden, candidate)
    )
  ) {
    return 0;
  }
  let bestWeight = 0;
  for (const expected of scenario.expectedActions) {
    if (fireworksActionsEqual(expected.action, candidate)) {
      bestWeight = Math.max(bestWeight, expected.weight);
    }
  }
  if (bestWeight > 0) return Math.min(1, bestWeight);

  if (!view.legalActions.some((legal) => fireworksActionsEqual(legal, candidate))) {
    return 0;
  }
  if (candidate.action === "clue_color" || candidate.action === "clue_rank") {
    const target = view.otherHands.find(
      (hand) => hand.playerId === candidate.targetPlayerId
    );
    const touched = (target?.cards ?? []).filter((card) =>
      candidate.action === "clue_color"
        ? card.color === candidate.color
        : card.rank === candidate.rank
    );
    if (
      touched.length > 0 &&
      touched.every(
        (card) =>
          card.color !== null &&
          card.rank !== null &&
          view.stacks[card.color] >= card.rank
      )
    ) {
      return FIREWORKS_DEAD_CLUE_GRADE;
    }
  }
  return FIREWORKS_NEUTRAL_LEGAL_GRADE;
}

// Graded quality for battleship shots (v2 rubric): keyed cells earn their
// authored weight (the oracle ratio, >= the correct bar by key-completeness);
// any other legal unshot cell earns its recomputed oracle ratio — sub-bar by
// construction, so it feeds moveQuality without ever counting correct.
// Already-shot or out-of-bounds targets earn 0 (absent from the oracle's
// map). Recomputing at grade time keeps ONE source of truth (the oracle
// module); the pack guard cross-checks it against an independent enumerator.
// The recompute is wrapped in try/catch: the oracle throws on a degenerate
// state (zero consistent placements, or zero coverable unshot cells), which
// must never crash scoring — the pack guard is what keeps such states from
// shipping.
export function gradeBattleshipAction(
  scenario: BattleshipGameIqScenario,
  action: unknown
): number {
  if (!isStructuredGameIqAction(scenario, action)) return 0;
  const target = (action as BattleshipGameIqAction).target;
  let best = 0;
  for (const expected of scenario.expectedActions) {
    const e = expected.action as BattleshipGameIqAction;
    if (e.target.row === target.row && e.target.column === target.column) {
      best = Math.max(best, expected.weight);
    }
  }
  if (best > 0) return Math.min(1, best);
  try {
    const entry = battleshipCellRatios(
      scenario.initialState as BattleshipGameState
    ).get(`${target.row},${target.column}`);
    return entry ? entry.ratio : 0;
  } catch {
    return 0;
  }
}

// Exact per-game action equality (candidate vs reference), exported for the
// runner's forbidden-action membership test. Membership in a list must be
// answered by direct equality — never by actionMatchesExpected or
// gradeFireworksAction, which are graded/legality-scoring functions:
// gradeFireworksAction returns the nonzero neutral floor for any unrelated
// legal action, and codenames clue-selection scores bare legality while
// ignoring expectedActions entirely.
export function gameIqActionsEqual(
  gameId: GameIqScenario["gameId"],
  left: GameIqAction,
  right: unknown
): boolean {
  return actionsEqual(gameId, left, right);
}

function actionsEqual(
  gameId: GameIqScenario["gameId"],
  left: GameIqAction,
  right: unknown
): boolean {
  if (!isRecord(right)) return false;

  switch (gameId) {
    case "connect-four":
      return "column" in left && left.column === right.column;
    case "chess":
      return (
        "from" in left &&
        left.from === right.from &&
        left.to === right.to &&
        (left.promotion ?? null) ===
          ((right as { promotion?: unknown }).promotion ?? null)
      );
    case "battleship":
      return (
        "target" in left &&
        isRecord(right.target) &&
        left.target.row === right.target.row &&
        left.target.column === right.target.column
      );
    case "codenames":
      if (!("type" in left) || left.type !== right.type) return false;
      if (left.type === "guess") return left.cardId === right.cardId;
      return (
        isRecord(right.clue) &&
        left.clue.word.toUpperCase() ===
          String(right.clue.word ?? "").toUpperCase() &&
        left.clue.count === right.clue.count
      );
    case "fireworks":
      return isStructuredFireworksAction(left) && isStructuredFireworksAction(right)
        ? fireworksActionsEqual(left, right)
        : false;
    default:
      return false;
  }
}

function isStructuredFireworksAction(action: unknown): action is FireworksAction {
  if (!isRecord(action)) return false;
  if (action.action === "play" || action.action === "discard") {
    return Number.isInteger(action.cardIndex);
  }
  if (action.action === "clue_color") {
    return (
      typeof action.targetPlayerId === "string" &&
      (action.color === "red" || action.color === "blue" || action.color === "green")
    );
  }
  if (action.action === "clue_rank") {
    return (
      typeof action.targetPlayerId === "string" &&
      (action.rank === 1 ||
        action.rank === 2 ||
        action.rank === 3 ||
        action.rank === 4 ||
        action.rank === 5)
    );
  }
  return false;
}
