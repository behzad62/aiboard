/** Codenames session/export checks (run: npx tsx scripts/test-codenames-session-export.mts) */
import {
  createInitialCodenamesState,
  endCodenamesTurn,
  submitCodenamesClue,
  submitCodenamesGuess,
} from "../lib/games/codenames/engine";
import type { CodenamesGameState } from "../lib/games/codenames/types";
import {
  CODENAMES_ACTIVE_SESSION_ID,
  createCodenamesSessionRecord,
  isCodenamesActiveStatus,
  parseCodenamesSessionRecord,
  type CodenamesSessionSnapshot,
} from "../lib/games/codenames/session";
import {
  exportCodenamesJson,
  exportCodenamesMoveList,
  parseCodenamesJsonExport,
} from "../lib/games/codenames/export";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function createProgressState(): CodenamesGameState {
  const initial = createInitialCodenamesState({
    seed: "session-export",
    startingTeam: "red",
  });
  const redTarget = initial.cards.find((card) => card.role === "red");
  if (!redTarget) throw new Error("test board needs a red target");
  const withClue = submitCodenamesClue(
    initial,
    { word: "signal", count: 1 },
    1_700_000_000_001
  );
  const withGuess = submitCodenamesGuess(withClue, redTarget.id, 1_700_000_000_002);
  return endCodenamesTurn(withGuess, 1_700_000_000_003);
}

function createSnapshot(): CodenamesSessionSnapshot {
  return {
    gameState: createProgressState(),
    seatAssignments: {
      redSpymaster: "human",
      redOperative: "human",
      blueSpymaster: "ai",
      blueOperative: "ai",
    },
    redSpymasterAI: { modelId: "openai:gpt-4.1", reasoningEffort: "medium" },
    redOperativeAI: { modelId: "openai:gpt-4.1", reasoningEffort: "medium" },
    blueSpymasterAI: {
      modelId: "anthropic:claude-sonnet-4",
      reasoningEffort: "high",
    },
    blueOperativeAI: {
      modelId: "anthropic:claude-sonnet-4",
      reasoningEffort: "high",
    },
    isPaused: false,
    currentPrivateView: null,
    lastAiInteraction: null,
    aiWarning: null,
    aiError: null,
  };
}

const now = "2026-06-24T10:00:00.000Z";
const snapshot = createSnapshot();

check(
  "snapshot has clue guess and end-turn records",
  snapshot.gameState.moveHistory.map((move) => move.type).join(",") ===
    "clue,guess,end-turn",
  snapshot.gameState.moveHistory
);

const record = createCodenamesSessionRecord(snapshot, now);
check("session record has stable active id", record.id === CODENAMES_ACTIVE_SESSION_ID, record);
check("session record has codenames game id", record.gameId === "codenames", record);
check("playing session record is active", record.status === "active", record);
check(
  "session metadata stores move count",
  JSON.parse(record.metadataJson).moves === 3,
  record.metadataJson
);
check(
  "session participants include four Codenames role seats",
  record.participants.length === 4 &&
    record.participants.some((participant) => participant.id === "red-spymaster") &&
    record.participants.some((participant) => participant.id === "blue-operative"),
  record.participants
);

const originalCreatedAt = "2026-06-24T09:30:00.000Z";
const laterSaveAt = "2026-06-24T10:15:00.000Z";
const laterRecord = createCodenamesSessionRecord(snapshot, laterSaveAt, originalCreatedAt);
const laterMetadata = JSON.parse(laterRecord.metadataJson);
check("later session save preserves original createdAt", laterRecord.createdAt === originalCreatedAt);
check(
  "later session save updates updatedAt and metadata savedAt",
  laterRecord.updatedAt === laterSaveAt && laterMetadata.savedAt === laterSaveAt,
  { record: laterRecord, metadata: laterMetadata }
);

const parsed = parseCodenamesSessionRecord(record);
check("session record parses", parsed !== null, parsed);
check(
  "parsed session restores snapshot and move count",
  parsed !== null &&
    JSON.stringify(parsed) === JSON.stringify(snapshot) &&
    parsed.gameState.moveHistory.length === 3,
  parsed
);

const legacyRecord = {
  ...record,
  stateJson: JSON.stringify({
    gameState: snapshot.gameState,
    gameMode: "pvai",
    humanTeam: "red",
    redSpymasterAI: snapshot.redSpymasterAI,
    redOperativeAI: snapshot.redOperativeAI,
    blueSpymasterAI: snapshot.blueSpymasterAI,
    blueOperativeAI: snapshot.blueOperativeAI,
    isPaused: false,
    currentPrivateView: null,
    lastAiInteraction: null,
    aiWarning: null,
    aiError: null,
  }),
};
const legacyParsed = parseCodenamesSessionRecord(legacyRecord);
check(
  "legacy gameMode+humanTeam snapshot migrates to seat assignments",
  legacyParsed !== null &&
    JSON.stringify(legacyParsed.seatAssignments) ===
      JSON.stringify({
        redSpymaster: "human",
        redOperative: "human",
        blueSpymaster: "ai",
        blueOperative: "ai",
      }),
  legacyParsed
);

const conflictingRecord = {
  ...record,
  stateJson: JSON.stringify({
    gameState: snapshot.gameState,
    seatAssignments: {
      redSpymaster: "robot",
      redOperative: "human",
      blueSpymaster: "ai",
      blueOperative: "ai",
    },
    gameMode: "pvai",
    humanTeam: "red",
    redSpymasterAI: snapshot.redSpymasterAI,
    redOperativeAI: snapshot.redOperativeAI,
    blueSpymasterAI: snapshot.blueSpymasterAI,
    blueOperativeAI: snapshot.blueOperativeAI,
    isPaused: false,
    currentPrivateView: null,
    lastAiInteraction: null,
    aiWarning: null,
    aiError: null,
  }),
};
check(
  "session parser rejects invalid seatAssignments even with valid legacy fields",
  parseCodenamesSessionRecord(conflictingRecord) === null
);

const legacyBadModeRecord = {
  ...record,
  stateJson: JSON.stringify({
    gameState: snapshot.gameState,
    gameMode: "bad-mode",
    humanTeam: "red",
    redSpymasterAI: snapshot.redSpymasterAI,
    redOperativeAI: snapshot.redOperativeAI,
    blueSpymasterAI: snapshot.blueSpymasterAI,
    blueOperativeAI: snapshot.blueOperativeAI,
    isPaused: false,
    currentPrivateView: null,
    lastAiInteraction: null,
    aiWarning: null,
    aiError: null,
  }),
};
check(
  "session parser rejects legacy record with invalid mode",
  parseCodenamesSessionRecord(legacyBadModeRecord) === null
);

const diagnosticSnapshot: CodenamesSessionSnapshot = {
  ...snapshot,
  aiError: "Failed to parse AI response after multiple attempts",
  aiDiagnostics: [
    {
      attempt: 1,
      type: "parse",
      message: "Response could not be parsed as valid Codenames JSON.",
      rawResponse: "try moon",
    },
  ],
};
const parsedDiagnostic = parseCodenamesSessionRecord(
  createCodenamesSessionRecord(diagnosticSnapshot, now)
);
check(
  "session parser preserves AI diagnostics",
  parsedDiagnostic !== null &&
    JSON.stringify(parsedDiagnostic.aiDiagnostics) ===
      JSON.stringify(diagnosticSnapshot.aiDiagnostics),
  parsedDiagnostic
);

const missingMetadataVersion = parseCodenamesSessionRecord({
  ...record,
  metadataJson: JSON.stringify({ savedAt: now, moves: 3 }),
});
check("session parser rejects missing metadata version", missingMetadataVersion === null);

const wrongMetadataVersion = parseCodenamesSessionRecord({
  ...record,
  metadataJson: JSON.stringify({ version: 2, savedAt: now, moves: 3 }),
});
check("session parser rejects wrong metadata version", wrongMetadataVersion === null);

const invalidRole = parseCodenamesSessionRecord({
  ...record,
  stateJson: JSON.stringify({
    ...snapshot,
    gameState: {
      ...snapshot.gameState,
      cards: snapshot.gameState.cards.map((card, index) =>
        index === 0 ? { ...card, role: "bad-role" } : card
      ),
    },
  }),
});
check("session parser rejects invalid card role", invalidRole === null, invalidRole);

const invalidLastAiGesture = parseCodenamesSessionRecord({
  ...record,
  stateJson: JSON.stringify({
    ...snapshot,
    lastAiInteraction: { actorId: "blue-operative", gesture: "not-a-gesture" },
  }),
});
check("session parser rejects invalid last AI gesture", invalidLastAiGesture === null);

const invalidAiDiagnostics = parseCodenamesSessionRecord({
  ...record,
  stateJson: JSON.stringify({
    ...snapshot,
    aiDiagnostics: [{ attempt: "first", type: "parse", message: "bad" }],
  }),
});
check("session parser rejects invalid AI diagnostics", invalidAiDiagnostics === null);

check("playing status is active", isCodenamesActiveStatus("playing") === true);
check("paused status is active", isCodenamesActiveStatus("paused") === true);
check("win status is not active", isCodenamesActiveStatus("win") === false);

const moveList = exportCodenamesMoveList(snapshot.gameState);
check("move list export is text/plain", moveList.mimeType === "text/plain", moveList);
check(
  "move list export includes clue guess and end turn",
  moveList.content.includes("1. Red clue: signal 1") &&
    moveList.content.includes("2. Red guess:") &&
    moveList.content.includes("3. Red ended turn"),
  moveList.content
);

const emptyMoveList = exportCodenamesMoveList(createInitialCodenamesState());
check("empty move list says no moves", emptyMoveList.content === "(no moves)", emptyMoveList);

const json = exportCodenamesJson(snapshot);
check("json export has expected filename", json.filename === "ai-board-codenames.json", json);
const jsonContent = JSON.parse(json.content);
check(
  "json export uses Codenames descriptor envelope",
  jsonContent.export?.game === "codenames" &&
    jsonContent.export?.format === "ai-board-codenames-json" &&
    jsonContent.export?.version === 1 &&
    typeof jsonContent.export?.generatedAt === "string" &&
    JSON.stringify(jsonContent.snapshot) === JSON.stringify(snapshot),
  jsonContent
);

const parsedJson = parseCodenamesJsonExport(json.content);
check("json export parses", parsedJson.ok === true, parsedJson);
check(
  "json export restores snapshot",
  parsedJson.ok && JSON.stringify(parsedJson.snapshot) === JSON.stringify(snapshot),
  parsedJson
);

const invalidJson = parseCodenamesJsonExport("{not valid json");
check("json export parser rejects invalid JSON", invalidJson.ok === false, invalidJson);

const missingSnapshot = parseCodenamesJsonExport(
  JSON.stringify({ export: jsonContent.export })
);
check("json export parser rejects missing snapshot", missingSnapshot.ok === false, missingSnapshot);

const malformedSnapshot = parseCodenamesJsonExport(
  JSON.stringify({
    export: jsonContent.export,
    snapshot: {
      ...snapshot,
      seatAssignments: {
        redSpymaster: "robot",
        redOperative: "human",
        blueSpymaster: "ai",
        blueOperative: "ai",
      },
    },
  })
);
check("json export parser rejects malformed snapshot", malformedSnapshot.ok === false);

const wrongGame = parseCodenamesJsonExport(
  JSON.stringify({
    export: {
      game: "connect-four",
      format: "ai-board-connect-four-json",
      version: 1,
      generatedAt: "2026-06-24T10:30:00.000Z",
    },
    snapshot,
  })
);
check("json export rejects wrong game", wrongGame.ok === false, wrongGame);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
