/* Chess session serialization checks (run: npx tsx scripts/test-chess-session.mts) */
import { createInitialState, makeMove } from "../lib/games/chess/engine";
import {
  createChessSessionRecord,
  isChessActiveStatus,
  parseChessSessionRecord,
  type ChessSessionSnapshot,
} from "../lib/games/chess/session";
import type { GameSessionRecord } from "../lib/games/core/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function snapshot(): ChessSessionSnapshot {
  return {
    gameMode: "pvp",
    humanColor: "white",
    whiteAI: { modelId: "", reasoningEffort: "default" },
    blackAI: { modelId: "", reasoningEffort: "default" },
    gameState: makeMove(createInitialState(), { from: "e2", to: "e4" }),
    whiteTimeMs: 1234,
    blackTimeMs: 0,
    gameStartTime: 1_767_000_000_000,
    isPaused: false,
    lastAiInteraction: null,
  };
}

function withMutatedState(
  record: GameSessionRecord,
  mutate: (state: Record<string, unknown>) => void
): GameSessionRecord {
  const payload = JSON.parse(record.stateJson) as Record<string, unknown>;
  const gameState = payload.gameState as Record<string, unknown>;
  mutate(gameState);
  return { ...record, stateJson: JSON.stringify(payload) };
}

const record = createChessSessionRecord(snapshot());
const parsed = parseChessSessionRecord(record);

check("valid chess session round-trips", parsed?.gameState.moveHistory[0]?.san === "e4", parsed);
check("playing and check are active", isChessActiveStatus("playing") && isChessActiveStatus("check"));
check("checkmate is not active", !isChessActiveStatus("checkmate"));

const malformedBoard = withMutatedState(record, (state) => {
  state.board = Array(7).fill(Array(8).fill(null));
});
check(
  "malformed board row count is rejected",
  parseChessSessionRecord(malformedBoard) === null
);

const malformedPiece = withMutatedState(record, (state) => {
  const board = state.board as unknown[][];
  board[0][0] = { color: "white", type: "dragon" };
});
check("malformed board piece is rejected", parseChessSessionRecord(malformedPiece) === null);

const malformedCastling = withMutatedState(record, (state) => {
  state.castlingRights = { whiteKingside: true };
});
check(
  "malformed castling rights are rejected",
  parseChessSessionRecord(malformedCastling) === null
);

const malformedMoveHistory = withMutatedState(record, (state) => {
  state.moveHistory = [
    {
      move: { from: "e2" },
      san: "e4",
      fenBefore: "before",
      fenAfter: "after",
      timestamp: Date.now(),
    },
  ];
});
check(
  "malformed move history is rejected",
  parseChessSessionRecord(malformedMoveHistory) === null
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
