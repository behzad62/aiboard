/** Connect Four session/export checks (run: npx tsx scripts/test-connect-four-session-export.mts) */
import { createInitialConnectFourState, dropDisc } from "../lib/games/connect-four/engine";
import type { ConnectFourGameState } from "../lib/games/connect-four/types";
import {
  CONNECT_FOUR_ACTIVE_SESSION_ID,
  createConnectFourSessionRecord,
  isConnectFourActiveStatus,
  parseConnectFourSessionRecord,
  type ConnectFourSessionSnapshot,
} from "../lib/games/connect-four/session";
import {
  exportConnectFourJson,
  exportConnectFourMoveList,
  parseConnectFourJsonExport,
} from "../lib/games/connect-four/export";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function createTwoMoveState(): ConnectFourGameState {
  const first = dropDisc(createInitialConnectFourState(), 3, 1_700_000_000_001);
  return dropDisc(first, 2, 1_700_000_000_002);
}

function createSnapshot(): ConnectFourSessionSnapshot {
  return {
    gameState: createTwoMoveState(),
    gameMode: "pvai",
    humanPlayer: "red",
    redAI: { modelId: "openai:gpt-4.1", reasoningEffort: "medium" },
    yellowAI: { modelId: "anthropic:claude-sonnet-4", reasoningEffort: "high" },
    isPaused: false,
    lastAiInteraction: null,
    aiWarning: null,
    aiError: null,
  };
}

const now = "2026-06-24T08:00:00.000Z";
const snapshot = createSnapshot();

check(
  "snapshot uses two explicit timestamped moves",
  snapshot.gameState.moveHistory.length === 2 &&
    snapshot.gameState.moveHistory[0].timestamp === 1_700_000_000_001 &&
    snapshot.gameState.moveHistory[1].timestamp === 1_700_000_000_002,
  snapshot.gameState.moveHistory
);

const record = createConnectFourSessionRecord(snapshot, now);
check("session record has stable active id", record.id === CONNECT_FOUR_ACTIVE_SESSION_ID, record);
check("session record has connect-four game id", record.gameId === "connect-four", record);
check("playing session record is active", record.status === "active", record);
check(
  "session metadata stores move count",
  JSON.parse(record.metadataJson).moves === 2,
  record.metadataJson
);

const parsed = parseConnectFourSessionRecord(record);
check("session record parses", parsed !== null, parsed);
check(
  "parsed session restores snapshot and move count",
  parsed !== null &&
    JSON.stringify(parsed) === JSON.stringify(snapshot) &&
    parsed.gameState.moveHistory.length === 2,
  parsed
);

check("playing status is active", isConnectFourActiveStatus("playing") === true);
check("draw status is not active", isConnectFourActiveStatus("draw") === false);

const moveList = exportConnectFourMoveList(snapshot.gameState);
check("move list export is text/plain", moveList.mimeType === "text/plain", moveList);
check(
  "move list export includes one-based columns",
  moveList.content.includes("1. Red: 4") && moveList.content.includes("2. Yellow: 3"),
  moveList.content
);

const emptyMoveList = exportConnectFourMoveList(createInitialConnectFourState());
check("empty move list says no moves", emptyMoveList.content === "(no moves)", emptyMoveList);

const json = exportConnectFourJson(snapshot);
check("json export has expected filename", json.filename === "ai-board-connect-four.json", json);

const parsedJson = parseConnectFourJsonExport(json.content);
check("json export parses", parsedJson.ok === true, parsedJson);
check(
  "json export restores snapshot",
  parsedJson.ok && JSON.stringify(parsedJson.snapshot) === JSON.stringify(snapshot),
  parsedJson
);

const wrongGame = parseConnectFourJsonExport(JSON.stringify({ game: "chess" }));
check(
  "json export rejects wrong game",
  wrongGame.ok === false,
  wrongGame
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
