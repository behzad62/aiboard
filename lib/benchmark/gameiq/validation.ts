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
  getPiece,
  isLegalMove,
  makeMove,
} from "@/lib/games/chess/engine";
import type { Move } from "@/lib/games/chess/types";
import {
  isLegalBattleshipTarget,
} from "@/lib/games/battleship/engine";
import type {
  BattleshipCoordinate,
  BattleshipGameState,
} from "@/lib/games/battleship/types";
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
  ChessGameIqAction,
  CodenamesGameIqAction,
  ConnectFourGameIqAction,
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
      return (
        typeof action.from === "string" &&
        typeof action.to === "string" &&
        (action.promotion == null || typeof action.promotion === "string")
      );
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
  if (scenario.gameId === "chess" && scenario.category === "legal-tactic") {
    return validateChessLegalTactic(scenario);
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

function validateChessLegalTactic(
  scenario: GameIqScenario
): GameIqValidationResult {
  const state = fromFEN((scenario.initialState as { fen: string }).fen);
  const results = scenario.expectedActions.map((expectedAction) => {
    const action = expectedAction.action as ChessGameIqAction;
    const targetPiece = getPiece(state, action.to);
    const isCapture =
      targetPiece != null && targetPiece.color !== state.turn;
    const isPromotion = action.promotion != null;
    return isCapture || isPromotion
      ? ok()
      : fail(
          `Expected legal tactic neither captures nor promotes: ${expectedAction.label}`
        );
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

  let bestWeight = 0;
  for (const expectedAction of scenario.expectedActions) {
    if (actionsEqual(scenario.gameId, action, expectedAction.action)) {
      bestWeight = Math.max(bestWeight, expectedAction.weight);
    }
  }
  return Math.min(1, Math.max(0, bestWeight));
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
