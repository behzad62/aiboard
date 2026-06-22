/* Game session store regression checks (run: npx tsx scripts/test-game-session-store.mts) */
import type {
  GameParticipant,
  GameSessionRecord,
  GenericGameMatchRecord,
} from "../lib/games/core/types";
import {
  __resetGameSessionStoreForTests,
  deleteGameSession,
  listGameSessions,
  listGenericGameMatchRecords,
  saveGameSession,
  saveGenericGameMatchRecord,
} from "../lib/games/core/session-store";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const participants: GameParticipant[] = [
  { id: "white", kind: "human", label: "White" },
  { id: "black", kind: "ai", label: "Black", modelId: "openai:gpt-test" },
];

function session(id: string, title: string): GameSessionRecord {
  return {
    id,
    gameId: "chess",
    title,
    status: "active",
    participants,
    stateJson: JSON.stringify({ fen: "start" }),
    metadataJson: JSON.stringify({ round: 1 }),
    createdAt: "2026-06-23T00:00:00.000Z",
    updatedAt: "2026-06-23T00:00:00.000Z",
  };
}

function match(id: string): GenericGameMatchRecord {
  return {
    id,
    gameId: "chess",
    timestamp: "2026-06-23T00:00:00.000Z",
    participants,
    resultJson: JSON.stringify({ winner: "white" }),
    statsJson: JSON.stringify({ moves: 24 }),
  };
}

__resetGameSessionStoreForTests();

await saveGameSession(session("session-1", "Original title"));
check("saved session is listed", (await listGameSessions()).length === 1);

await saveGameSession({
  ...session("session-1", "Updated title"),
  status: "paused",
  updatedAt: "2026-06-23T01:00:00.000Z",
});
const afterUpdate = await listGameSessions();
check(
  "saving the same session id updates instead of duplicating",
  afterUpdate.length === 1 &&
    afterUpdate[0]?.title === "Updated title" &&
    afterUpdate[0]?.status === "paused",
  afterUpdate
);

await saveGameSession(session("session-2", "Second session"));
await deleteGameSession("session-1");
const afterDelete = await listGameSessions();
check(
  "deleting removes only the requested session",
  afterDelete.length === 1 && afterDelete[0]?.id === "session-2",
  afterDelete
);

await saveGenericGameMatchRecord(match("match-1"));
await saveGenericGameMatchRecord(match("match-1"));
const records = await listGenericGameMatchRecords();
check(
  "match records are append-only",
  records.length === 2 && records.every((record) => record.id === "match-1"),
  records
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
