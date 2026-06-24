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
  const first = dropDisc(
    createInitialConnectFourState(1_700_000_000_000),
    3,
    1_700_000_000_001
  );
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

const originalCreatedAt = "2026-06-24T07:30:00.000Z";
const laterSaveAt = "2026-06-24T08:15:00.000Z";
const laterRecord = createConnectFourSessionRecord(snapshot, laterSaveAt, originalCreatedAt);
const laterMetadata = JSON.parse(laterRecord.metadataJson);
check(
  "later session save preserves original createdAt",
  laterRecord.createdAt === originalCreatedAt,
  laterRecord
);
check(
  "later session save updates updatedAt and metadata savedAt",
  laterRecord.updatedAt === laterSaveAt && laterMetadata.savedAt === laterSaveAt,
  { record: laterRecord, metadata: laterMetadata }
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
check(
  "parsed session restores aggregate clock totals",
  parsed?.gameState.clock.redElapsedMs === 1 &&
    parsed.gameState.clock.yellowElapsedMs === 1 &&
    parsed.gameState.clock.turnStartedAt === 1_700_000_000_002,
  parsed?.gameState.clock
);

const diagnosticSnapshot: ConnectFourSessionSnapshot = {
  ...snapshot,
  aiError: "Failed to parse AI response after multiple attempts",
  aiDiagnostics: [
    {
      attempt: 1,
      type: "parse",
      message: "Response could not be parsed as Connect Four JSON.",
      legalColumns: [0, 1, 2, 3, 4, 5, 6],
      rawResponse: "I choose the middle column.",
    },
  ],
};
const diagnosticRecord = createConnectFourSessionRecord(diagnosticSnapshot, now);
const parsedDiagnosticRecord = parseConnectFourSessionRecord(diagnosticRecord);
check(
  "session parser preserves AI diagnostics",
  parsedDiagnosticRecord !== null &&
    JSON.stringify(parsedDiagnosticRecord.aiDiagnostics) ===
      JSON.stringify(diagnosticSnapshot.aiDiagnostics),
  parsedDiagnosticRecord
);

const missingMetadataVersion = parseConnectFourSessionRecord({
  ...record,
  metadataJson: JSON.stringify({ savedAt: now, moves: 2 }),
});
check("session parser rejects missing metadata version", missingMetadataVersion === null, {
  parsed: missingMetadataVersion,
});

const wrongMetadataVersion = parseConnectFourSessionRecord({
  ...record,
  metadataJson: JSON.stringify({ version: 2, savedAt: now, moves: 2 }),
});
check("session parser rejects wrong metadata version", wrongMetadataVersion === null, {
  parsed: wrongMetadataVersion,
});

const invalidLastAiGesture = parseConnectFourSessionRecord({
  ...record,
  stateJson: JSON.stringify({
    ...snapshot,
    lastAiInteraction: { actorId: "yellow", gesture: "not-a-gesture" },
  }),
});
check("session parser rejects invalid last AI gesture", invalidLastAiGesture === null, {
  parsed: invalidLastAiGesture,
});

const invalidMoveAiGesture = parseConnectFourSessionRecord({
  ...record,
  stateJson: JSON.stringify({
    ...snapshot,
    gameState: {
      ...snapshot.gameState,
      moveHistory: snapshot.gameState.moveHistory.map((move, index) =>
        index === 0
          ? {
              ...move,
              aiInteraction: { actorId: "red", gesture: "not-a-gesture" },
            }
          : move
      ),
    },
  }),
});
check("session parser rejects invalid move AI gesture", invalidMoveAiGesture === null, {
  parsed: invalidMoveAiGesture,
});

const invalidAiConfidence = parseConnectFourSessionRecord({
  ...record,
  stateJson: JSON.stringify({
    ...snapshot,
    lastAiInteraction: { actorId: "yellow", confidence: 1.5 },
  }),
});
check("session parser rejects invalid AI confidence", invalidAiConfidence === null, {
  parsed: invalidAiConfidence,
});

const invalidAiDiagnostics = parseConnectFourSessionRecord({
  ...record,
  stateJson: JSON.stringify({
    ...snapshot,
    aiDiagnostics: [{ attempt: "first", type: "parse", message: "bad" }],
  }),
});
check("session parser rejects invalid AI diagnostics", invalidAiDiagnostics === null, {
  parsed: invalidAiDiagnostics,
});

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
const jsonContent = JSON.parse(json.content);
check(
  "json export uses chess-style descriptor envelope",
  jsonContent.export?.game === "connect-four" &&
    jsonContent.export?.format === "ai-board-connect-four-json" &&
    jsonContent.export?.version === 1 &&
    typeof jsonContent.export?.generatedAt === "string" &&
    JSON.stringify(jsonContent.snapshot) === JSON.stringify(snapshot),
  jsonContent
);

const parsedJson = parseConnectFourJsonExport(json.content);
check("json export parses", parsedJson.ok === true, parsedJson);
check(
  "json export restores snapshot",
  parsedJson.ok && JSON.stringify(parsedJson.snapshot) === JSON.stringify(snapshot),
  parsedJson
);

const invalidJson = parseConnectFourJsonExport("{not valid json");
check("json export parser rejects invalid JSON", invalidJson.ok === false, invalidJson);

const missingSnapshot = parseConnectFourJsonExport(
  JSON.stringify({ export: jsonContent.export })
);
check(
  "json export parser rejects missing snapshot",
  missingSnapshot.ok === false,
  missingSnapshot
);

const malformedSnapshot = parseConnectFourJsonExport(
  JSON.stringify({
    export: jsonContent.export,
    snapshot: { ...snapshot, gameMode: "bad-mode" },
  })
);
check(
  "json export parser rejects malformed snapshot",
  malformedSnapshot.ok === false,
  malformedSnapshot
);

const wrongGame = parseConnectFourJsonExport(
  JSON.stringify({
    export: {
      game: "chess",
      format: "ai-board-chess-json",
      version: 1,
      generatedAt: "2026-06-24T08:30:00.000Z",
    },
    snapshot,
  })
);
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
