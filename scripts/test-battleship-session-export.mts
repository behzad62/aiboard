import {
  createInitialBattleshipState,
  fireBattleshipShot,
} from "../lib/games/battleship/engine";
import {
  BATTLESHIP_ACTIVE_SESSION_ID,
  createBattleshipSessionRecord,
  parseBattleshipSessionRecord,
  type BattleshipSessionSnapshot,
} from "../lib/games/battleship/session";
import {
  exportBattleshipJson,
  exportBattleshipMoveList,
  parseBattleshipJsonExport,
} from "../lib/games/battleship/export";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const gameState = fireBattleshipShot(
  createInitialBattleshipState(),
  { row: 0, column: 9 },
  1_000
);
const snapshot: BattleshipSessionSnapshot = {
  gameState,
  gameMode: "pvai",
  humanPlayer: "blue",
  blueAI: { modelId: "openai:gpt-4.1", reasoningEffort: "medium" },
  orangeAI: { modelId: "google:gemini-3.5-flash", reasoningEffort: "low" },
  isPaused: false,
  lastAiInteraction: null,
  aiWarning: null,
  aiError: null,
};
const now = "2026-06-24T10:00:00.000Z";
const record = createBattleshipSessionRecord(snapshot, now);

check("session record has stable id", record.id === BATTLESHIP_ACTIVE_SESSION_ID, record);
check("session record has battleship game id", record.gameId === "battleship", record);
check("playing session is active", record.status === "active", record);
check("session record parses", parseBattleshipSessionRecord(record) !== null, record);
check(
  "parsed session restores snapshot",
  JSON.stringify(parseBattleshipSessionRecord(record)) === JSON.stringify(snapshot),
  parseBattleshipSessionRecord(record)
);

const moveList = exportBattleshipMoveList(gameState);
check("move list export includes shot result", moveList.content.includes("Blue A10 miss"), moveList.content);

const jsonExport = exportBattleshipJson(snapshot);
const importResult = parseBattleshipJsonExport(jsonExport.content);
check("json export restores snapshot", importResult.ok && JSON.stringify(importResult.snapshot) === JSON.stringify(snapshot), importResult);
check("json import rejects wrong game", !parseBattleshipJsonExport('{"game":"chess"}').ok);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
