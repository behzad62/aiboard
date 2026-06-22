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

async function expectReject(
  name: string,
  action: () => Promise<void>,
  messagePattern: RegExp
): Promise<void> {
  try {
    await action();
    check(name, false, "resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, messagePattern.test(message), message);
  }
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

function installIndexedDbStore(rawStore: string): void {
  const values = new Map<string, unknown>([["store", rawStore]]);
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({
      objectStore: () => ({
        get: (key: string) => {
          const req = { result: values.get(key), onsuccess: null as (() => void) | null };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        },
        put: (value: unknown, key: string) => {
          values.set(key, value);
        },
      }),
    }),
    close: () => {},
  };
  const fakeIndexedDb = {
    open: () => {
      const req = {
        result: db,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB =
    fakeIndexedDb as unknown as IDBFactory;
}

installIndexedDbStore(JSON.stringify({}));
check("old store hydrates with no game sessions", (await listGameSessions()).length === 0);
await saveGameSession(session("default-leak-check", "Default leak check"));
__resetGameSessionStoreForTests();
const afterOldStoreReset = await listGameSessions();
check(
  "old-store default game session arrays are isolated",
  afterOldStoreReset.length === 0,
  afterOldStoreReset
);

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

afterDelete.push(session("session-mutated", "Mutated outside facade"));
const afterSessionArrayMutation = await listGameSessions();
check(
  "session list returns a shallow copy",
  afterSessionArrayMutation.length === 1 &&
    afterSessionArrayMutation.every((record) => record.id !== "session-mutated"),
  afterSessionArrayMutation
);

await saveGenericGameMatchRecord(match("match-1"));
await saveGenericGameMatchRecord(match("match-1"));
const records = await listGenericGameMatchRecords();
check(
  "match records are append-only",
  records.length === 2 && records.every((record) => record.id === "match-1"),
  records
);

records.push(match("match-mutated"));
const afterMatchArrayMutation = await listGenericGameMatchRecords();
check(
  "match record list returns a shallow copy",
  afterMatchArrayMutation.length === 2 &&
    afterMatchArrayMutation.every((record) => record.id !== "match-mutated"),
  afterMatchArrayMutation
);

__resetGameSessionStoreForTests({ needsPassphrase: true });
check("locked session list returns empty", (await listGameSessions()).length === 0);
check(
  "locked match record list returns empty",
  (await listGenericGameMatchRecords()).length === 0
);
await expectReject(
  "locked save session rejects",
  () => saveGameSession(session("locked-session", "Locked session")),
  /unlock/i
);
await expectReject(
  "locked delete session rejects",
  () => deleteGameSession("locked-session"),
  /unlock/i
);
await expectReject(
  "locked save match record rejects",
  () => saveGenericGameMatchRecord(match("locked-match")),
  /unlock/i
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
