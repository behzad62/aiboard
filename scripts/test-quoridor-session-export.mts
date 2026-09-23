/** Quoridor session/export checks (run: npx tsx scripts/test-quoridor-session-export.mts) */
import {
  applyQuoridorAction,
  createInitialQuoridorState,
} from "../lib/games/quoridor/engine";
import type { QuoridorGameState } from "../lib/games/quoridor/types";
import {
  QUORIDOR_ACTIVE_SESSION_ID,
  createQuoridorSessionRecord,
  parseQuoridorSessionRecord,
  type QuoridorSessionSnapshot,
} from "../lib/games/quoridor/session";
import {
  exportQuoridorJson,
  exportQuoridorMoveList,
  parseQuoridorJsonExport,
} from "../lib/games/quoridor/export";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function createTwoMoveState(): QuoridorGameState {
  const first = applyQuoridorAction(
    createInitialQuoridorState(1_700_000_000_000),
    { type: "move", row: 7, col: 4 },
    1_700_000_000_001
  );
  return applyQuoridorAction(
    first,
    { type: "wall", row: 3, col: 3, orientation: "H" },
    1_700_000_000_002
  );
}

function createSnapshot(): QuoridorSessionSnapshot {
  return {
    gameState: createTwoMoveState(),
    gameMode: "pvai",
    humanPlayer: "south",
    southAI: { modelId: "openai:gpt-4.1", reasoningEffort: "medium" },
    northAI: { modelId: "anthropic:claude-sonnet-4", reasoningEffort: "high" },
    isPaused: false,
    lastAiInteraction: null,
    aiWarning: null,
    aiError: null,
  };
}

const now = "2026-09-18T08:00:00.000Z";
const snapshot = createSnapshot();

check(
  "snapshot uses two explicit timestamped actions",
  snapshot.gameState.moveHistory.length === 2 &&
    snapshot.gameState.moveHistory[0].timestamp === 1_700_000_000_001 &&
    snapshot.gameState.moveHistory[1].timestamp === 1_700_000_000_002,
  snapshot.gameState.moveHistory
);

const record = createQuoridorSessionRecord(snapshot, now);
check("session record has stable active id", record.id === QUORIDOR_ACTIVE_SESSION_ID, record);
check("session record has quoridor game id", record.gameId === "quoridor", record);
check("playing session record is active", record.status === "active", record);
check(
  "session metadata stores move count",
  JSON.parse(record.metadataJson).moves === 2,
  record.metadataJson
);

const parsed = parseQuoridorSessionRecord(record);
check("session record parses", parsed !== null, parsed);
check(
  "parsed session restores snapshot and move count",
  parsed !== null &&
    JSON.stringify(parsed) === JSON.stringify(snapshot) &&
    parsed.gameState.moveHistory.length === 2,
  parsed
);

const diagnosticSnapshot: QuoridorSessionSnapshot = {
  ...snapshot,
  aiError: "Failed to parse AI response after multiple attempts",
  aiDiagnostics: [
    {
      attempt: 1,
      type: "parse",
      message: "Response could not be parsed as Quoridor JSON.",
      legalActions: ["e2", "c4h"],
      rawResponse: "I jump the pawn.",
    },
  ],
};
const diagnosticRecord = createQuoridorSessionRecord(diagnosticSnapshot, now);
const parsedDiagnosticRecord = parseQuoridorSessionRecord(diagnosticRecord);
check(
  "session parser preserves AI diagnostics",
  parsedDiagnosticRecord !== null &&
    JSON.stringify(parsedDiagnosticRecord.aiDiagnostics) ===
      JSON.stringify(diagnosticSnapshot.aiDiagnostics),
  parsedDiagnosticRecord?.aiDiagnostics
);

const moveList = exportQuoridorMoveList(snapshot.gameState);
check(
  "move list export names both actions",
  moveList.content.includes("South: e2") &&
    moveList.content.toLowerCase().includes("h"),
  moveList.content
);

const jsonExport = exportQuoridorJson(snapshot);
const imported = parseQuoridorJsonExport(jsonExport.content);
check("json export round-trips", imported.ok === true, imported);
if (imported.ok) {
  check(
    "imported snapshot matches game state",
    JSON.stringify(imported.snapshot.gameState) ===
      JSON.stringify(snapshot.gameState),
    imported.snapshot.gameState
  );
}

check(
  "foreign json is rejected",
  parseQuoridorJsonExport('{"export":{"game":"chess"}}').ok === false
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
