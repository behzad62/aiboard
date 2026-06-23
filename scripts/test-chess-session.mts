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
    whiteRemainingMs: 300_000,
    blackRemainingMs: 290_000,
    timeControl: {
      mode: "blitz-5-0",
      initialMs: 300_000,
      incrementMs: 0,
      label: "5+0 blitz",
    },
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
check(
  "clock values round-trip",
  parsed?.whiteTimeMs === 1234 && parsed.blackTimeMs === 0,
  parsed
);
check(
  "timed clock settings and remaining time round-trip",
  parsed?.timeControl?.mode === "blitz-5-0" &&
    parsed.whiteRemainingMs === 300_000 &&
    parsed.blackRemainingMs === 290_000,
  parsed
);

const legacyPayload = JSON.parse(record.stateJson) as Record<string, unknown>;
delete legacyPayload.timeControl;
delete legacyPayload.whiteRemainingMs;
delete legacyPayload.blackRemainingMs;
const legacyParsed = parseChessSessionRecord({
  ...record,
  stateJson: JSON.stringify(legacyPayload),
});
check(
  "legacy sessions default to untimed elapsed clocks",
  legacyParsed?.timeControl?.mode === "untimed" &&
    legacyParsed.whiteRemainingMs === null &&
    legacyParsed.blackRemainingMs === null,
  legacyParsed
);
check("playing and check are active", isChessActiveStatus("playing") && isChessActiveStatus("check"));
check("checkmate is not active", !isChessActiveStatus("checkmate"));
check("timeout is not active", !isChessActiveStatus("timeout"));

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
