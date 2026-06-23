/* Game session store regression checks (run: npx tsx scripts/test-game-session-store.mts) */
import type {
  GameParticipant,
  GameSessionRecord,
  GenericGameMatchRecord,
} from "../lib/games/core/types";
import type { GameMatchRecord } from "../lib/games/chess/types";
import {
  __clearGameSessionStoreForTests,
  __exportGameSessionStoreForTests,
  __flushGameSessionStoreForTests,
  __initGameSessionStoreForTests,
  __lockGameSessionStoreForTests,
  __replaceGameSessionStoreForTests,
  __resetGameSessionStoreForTests,
  __setGameSessionStorePassphraseForTests,
  __unlockGameSessionStoreForTests,
  deleteGameSession,
  listGameSessions,
  listGenericGameMatchRecords,
  saveGameSession,
  saveGenericGameMatchRecord,
} from "../lib/games/core/session-store";
import {
  getAIvsAIAggregateStats,
  getAIvsAIMatches,
  getAIvsAIModelStats,
  getMatchRecords,
  resetGameStats,
  saveMatchRecord,
} from "../lib/games/stats";

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

function legacyMatch(id: string): GameMatchRecord {
  return {
    id,
    timestamp: "2026-06-23T02:00:00.000Z",
    mode: "aivai",
    whiteModel: "openai:white-test",
    blackModel: "anthropic:black-test",
    whiteReasoningEffort: "low",
    blackReasoningEffort: "high",
    result: "white",
    moves: 36,
    durationMs: 12_000,
    whiteMoveMs: 4_000,
    blackMoveMs: 8_000,
  };
}

function installIndexedDbStore(
  rawStore: string,
  rawConfig?: unknown
): {
  getStoredRaw: () => string | undefined;
  setStoredRaw: (raw: string) => void;
} {
  const values = new Map<string, unknown>([["store", rawStore]]);
  if (rawConfig !== undefined) values.set("config", rawConfig);
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null,
        objectStore: () => ({
          get: (key: string) => {
            const req = {
              result: values.get(key),
              onsuccess: null as (() => void) | null,
              onerror: null as (() => void) | null,
              error: null,
            };
            queueMicrotask(() => req.onsuccess?.());
            return req;
          },
          put: (value: unknown, key: string) => {
            values.set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
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

  return {
    getStoredRaw: () =>
      typeof values.get("store") === "string"
        ? (values.get("store") as string)
        : undefined,
    setStoredRaw: (raw: string) => {
      values.set("store", raw);
    },
  };
}

function installControlledIndexedDbStore(rawStore: string): {
  getPendingStoreLoads: () => number;
  resolveStoreLoad: (index: number) => void;
} {
  const values = new Map<string, unknown>([["store", rawStore]]);
  const pendingStoreLoads: Array<{ result: unknown; onsuccess: (() => void) | null }> = [];
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null,
        objectStore: () => ({
          get: (key: string) => {
            const req = {
              result: values.get(key),
              onsuccess: null as (() => void) | null,
              onerror: null as (() => void) | null,
              error: null,
            };
            if (key === "store") pendingStoreLoads.push(req);
            else queueMicrotask(() => req.onsuccess?.());
            return req;
          },
          put: (value: unknown, key: string) => {
            values.set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
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

  return {
    getPendingStoreLoads: () => pendingStoreLoads.length,
    resolveStoreLoad: (index: number) => {
      pendingStoreLoads.splice(index, 1)[0]?.onsuccess?.();
    },
  };
}

function installAdapterDelayedIndexedDbStore(rawStore: string): {
  getPendingConfigLoads: () => number;
  resolveConfigLoad: (index: number) => void;
  getPendingStoreLoads: () => number;
  resolveStoreLoad: (index: number) => void;
  getStoredRaw: () => string | undefined;
} {
  const values = new Map<string, unknown>([["store", rawStore]]);
  const pendingConfigLoads: Array<{ result: unknown; onsuccess: (() => void) | null }> = [];
  const pendingStoreLoads: Array<{ result: unknown; onsuccess: (() => void) | null }> = [];
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        error: null,
        objectStore: () => ({
          get: (key: string) => {
            const req = {
              result: values.get(key),
              onsuccess: null as (() => void) | null,
              onerror: null as (() => void) | null,
              error: null,
            };
            if (key === "config") pendingConfigLoads.push(req);
            else if (key === "store") pendingStoreLoads.push(req);
            else queueMicrotask(() => req.onsuccess?.());
            return req;
          },
          put: (value: unknown, key: string) => {
            values.set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
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

  return {
    getPendingConfigLoads: () => pendingConfigLoads.length,
    resolveConfigLoad: (index: number) => {
      pendingConfigLoads.splice(index, 1)[0]?.onsuccess?.();
    },
    getPendingStoreLoads: () => pendingStoreLoads.length,
    resolveStoreLoad: (index: number) => {
      pendingStoreLoads.splice(index, 1)[0]?.onsuccess?.();
    },
    getStoredRaw: () =>
      typeof values.get("store") === "string"
        ? (values.get("store") as string)
        : undefined,
  };
}

function installFailingLocalStorageStore(): void {
  const fakeLocalStorage = {
    get length() {
      return 0;
    },
    clear: () => {},
    getItem: () => {
      throw new Error("localStorage unavailable");
    },
    key: () => null,
    removeItem: () => {},
    setItem: () => {},
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    fakeLocalStorage as Storage;
}

function installLocalStorageStore(values: Record<string, string>): void {
  const items = new Map<string, string>(Object.entries(values));
  const fakeLocalStorage = {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    key: (index: number) => Array.from(items.keys())[index] ?? null,
    removeItem: (key: string) => {
      items.delete(key);
    },
    setItem: (key: string, value: string) => {
      items.set(key, value);
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage =
    fakeLocalStorage as Storage;
}

async function settleAsyncReadiness(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitForCondition(
  description: string,
  predicate: () => boolean
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check(description, false);
}

__clearGameSessionStoreForTests();
const raceIndexedDb = installControlledIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({});
const initialReadiness = __initGameSessionStoreForTests();
await waitForCondition(
  "first readiness call reaches store load",
  () => raceIndexedDb.getPendingStoreLoads() === 1
);
saveMatchRecord(legacyMatch("queued-during-concurrent-init"));
await settleAsyncReadiness();
const concurrentPendingLoads = raceIndexedDb.getPendingStoreLoads();
check(
  "concurrent initStore calls share one in-flight store load",
  concurrentPendingLoads === 1,
  concurrentPendingLoads
);
if (concurrentPendingLoads > 1) {
  raceIndexedDb.resolveStoreLoad(1);
  await settleAsyncReadiness();
}
raceIndexedDb.resolveStoreLoad(0);
await initialReadiness;
await settleAsyncReadiness();
const concurrentInitRecords = getMatchRecords();
check(
  "concurrent initStore calls do not lose queued stats saves",
  concurrentInitRecords.length === 1 &&
    concurrentInitRecords[0]?.id === "queued-during-concurrent-init",
  concurrentInitRecords
);

__clearGameSessionStoreForTests();
const staleInitIndexedDb = installControlledIndexedDbStore(
  JSON.stringify({
    gameMatchRecords: [match("stale-init-record")],
    gameStatsLegacyImportAttempted: true,
  })
);
const staleInit = __initGameSessionStoreForTests();
await waitForCondition(
  "stale init reaches store load",
  () => staleInitIndexedDb.getPendingStoreLoads() === 1
);
__replaceGameSessionStoreForTests({
  gameMatchRecords: [match("replacement-survives-stale-init")],
  gameStatsLegacyImportAttempted: true,
});
staleInitIndexedDb.resolveStoreLoad(0);
await staleInit;
const storeAfterStaleInit = __exportGameSessionStoreForTests();
check(
  "replaceStore survives older in-flight init completion",
  storeAfterStaleInit.gameMatchRecords.length === 1 &&
    storeAfterStaleInit.gameMatchRecords[0]?.id === "replacement-survives-stale-init",
  storeAfterStaleInit.gameMatchRecords
);

__clearGameSessionStoreForTests();
const delayedAdapterIndexedDb = installAdapterDelayedIndexedDbStore(
  JSON.stringify({
    gameMatchRecords: [match("old-before-adapter-replace")],
    gameStatsLegacyImportAttempted: true,
  })
);
const delayedAdapterInit = __initGameSessionStoreForTests();
await waitForCondition(
  "replace-before-adapter init reaches config load",
  () => delayedAdapterIndexedDb.getPendingConfigLoads() === 1
);
__replaceGameSessionStoreForTests({
  gameMatchRecords: [match("replacement-persists-before-adapter")],
  gameStatsLegacyImportAttempted: true,
});
await new Promise((resolve) => setTimeout(resolve, 180));
delayedAdapterIndexedDb.resolveConfigLoad(0);
await waitForCondition(
  "replace-before-adapter init reaches store load",
  () => delayedAdapterIndexedDb.getPendingStoreLoads() === 1
);
delayedAdapterIndexedDb.resolveStoreLoad(0);
await delayedAdapterInit;
await new Promise((resolve) => setTimeout(resolve, 200));
const persistedDelayedReplacementRaw = delayedAdapterIndexedDb.getStoredRaw();
__clearGameSessionStoreForTests();
installIndexedDbStore(persistedDelayedReplacementRaw ?? JSON.stringify({}));
await __initGameSessionStoreForTests();
const reloadedDelayedReplacement = __exportGameSessionStoreForTests();
check(
  "replaceStore persists after init later assigns adapter",
  reloadedDelayedReplacement.gameMatchRecords.length === 1 &&
    reloadedDelayedReplacement.gameMatchRecords[0]?.id ===
      "replacement-persists-before-adapter",
  { persistedDelayedReplacementRaw, reloadedDelayedReplacement }
);

__clearGameSessionStoreForTests();
const preInitReplaceIndexedDb = installIndexedDbStore(JSON.stringify({}));
__replaceGameSessionStoreForTests({
  gameMatchRecords: [match("replacement-before-any-adapter")],
  gameStatsLegacyImportAttempted: true,
});
await new Promise((resolve) => setTimeout(resolve, 180));
await __initGameSessionStoreForTests();
await __flushGameSessionStoreForTests();
const persistedPreInitReplacementRaw = preInitReplaceIndexedDb.getStoredRaw();
__clearGameSessionStoreForTests();
installIndexedDbStore(persistedPreInitReplacementRaw ?? JSON.stringify({}));
await __initGameSessionStoreForTests();
const reloadedPreInitReplacement = __exportGameSessionStoreForTests();
check(
  "replaceStore before any adapter persists after later init",
  reloadedPreInitReplacement.gameMatchRecords.length === 1 &&
    reloadedPreInitReplacement.gameMatchRecords[0]?.id ===
      "replacement-before-any-adapter",
  { persistedPreInitReplacementRaw, reloadedPreInitReplacement }
);

__clearGameSessionStoreForTests();
const encryptedPreInitSalt = await __setGameSessionStorePassphraseForTests(
  "pre-init-replace-passphrase"
);
__lockGameSessionStoreForTests();
const encryptedPreInitReplaceIndexedDb = installIndexedDbStore(JSON.stringify({}), {
  kind: "indexeddb",
  encryptionEnabled: true,
  salt: encryptedPreInitSalt,
});
__replaceGameSessionStoreForTests({
  gameMatchRecords: [match("encrypted-replacement-before-unlock")],
  gameStatsLegacyImportAttempted: true,
});
await new Promise((resolve) => setTimeout(resolve, 180));
const lockedEncryptedPreInitReadiness = await __initGameSessionStoreForTests();
check(
  "encrypted pre-init replace reports locked before dirty flush",
  lockedEncryptedPreInitReadiness.needsPassphrase === true,
  lockedEncryptedPreInitReadiness
);
await __unlockGameSessionStoreForTests(
  "pre-init-replace-passphrase",
  encryptedPreInitSalt
);
const unlockedEncryptedPreInitReadiness = await __initGameSessionStoreForTests();
const persistedEncryptedPreInitReplacementRaw =
  encryptedPreInitReplaceIndexedDb.getStoredRaw();
__clearGameSessionStoreForTests();
await __initGameSessionStoreForTests();
const reloadedEncryptedPreInitReplacement = __exportGameSessionStoreForTests();
__lockGameSessionStoreForTests();
check(
  "encrypted dirty replace flushes after later unlock readiness",
  unlockedEncryptedPreInitReadiness.needsPassphrase === false &&
    reloadedEncryptedPreInitReplacement.gameMatchRecords.length === 1 &&
    reloadedEncryptedPreInitReplacement.gameMatchRecords[0]?.id ===
      "encrypted-replacement-before-unlock",
  {
    unlockedEncryptedPreInitReadiness,
    persistedEncryptedPreInitReplacementRaw,
    reloadedEncryptedPreInitReplacement,
  }
);

__clearGameSessionStoreForTests();
const lockedEnvelope = JSON.stringify({ v: 1, encrypted: true, data: "locked" });
const lockedThenReadyIndexedDb = installIndexedDbStore(lockedEnvelope);
installLocalStorageStore({});
saveMatchRecord(legacyMatch("queued-while-locked"));
await settleAsyncReadiness();
lockedThenReadyIndexedDb.setStoredRaw(JSON.stringify({}));
await __initGameSessionStoreForTests();
await settleAsyncReadiness();
const recordsAfterReadyNotification = await listGenericGameMatchRecords();
check(
  "queued stats saves flush after later successful store readiness",
  recordsAfterReadyNotification.length === 1 &&
    recordsAfterReadyNotification[0]?.id === "queued-while-locked",
  recordsAfterReadyNotification
);

__clearGameSessionStoreForTests();
const resetPendingIndexedDb = installControlledIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({});
saveMatchRecord(legacyMatch("pending-reset-all"));
await waitForCondition(
  "pending reset save reaches store load",
  () => resetPendingIndexedDb.getPendingStoreLoads() === 1
);
resetGameStats();
resetPendingIndexedDb.resolveStoreLoad(0);
await settleAsyncReadiness();
const recordsAfterPendingReset = await listGenericGameMatchRecords();
check(
  "resetGameStats clears pending queued chess records",
  recordsAfterPendingReset.length === 0,
  recordsAfterPendingReset
);

__clearGameSessionStoreForTests();
const resetModelPendingIndexedDb = installControlledIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({});
saveMatchRecord(legacyMatch("pending-reset-target-model"));
saveMatchRecord({
  ...legacyMatch("pending-reset-other-model"),
  whiteModel: "openai:other-test",
  blackModel: "anthropic:other-test",
});
await waitForCondition(
  "pending model reset save reaches store load",
  () => resetModelPendingIndexedDb.getPendingStoreLoads() === 1
);
resetGameStats("openai:white-test");
resetModelPendingIndexedDb.resolveStoreLoad(0);
await settleAsyncReadiness();
const recordsAfterPendingModelReset = await listGenericGameMatchRecords();
check(
  "model reset filters matching pending queued records",
  recordsAfterPendingModelReset.length === 1 &&
    recordsAfterPendingModelReset[0]?.id === "pending-reset-other-model",
  recordsAfterPendingModelReset
);

__clearGameSessionStoreForTests();
installIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({});
saveMatchRecord(legacyMatch("queued-before-ready"));
await settleAsyncReadiness();
const queuedRecordsAfterReadiness = getMatchRecords();
check(
  "saveMatchRecord queues records before store readiness",
  queuedRecordsAfterReadiness.length === 1 &&
    queuedRecordsAfterReadiness[0]?.id === "queued-before-ready",
  queuedRecordsAfterReadiness
);
await __flushGameSessionStoreForTests();

__clearGameSessionStoreForTests();
installIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({ "aiboard-game-stats": "{not json" });
await __initGameSessionStoreForTests();
const malformedRecords = getMatchRecords();
check(
  "malformed legacy stats return no records",
  malformedRecords.length === 0,
  malformedRecords
);
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([legacyMatch("legacy-after-malformed")]),
});
const recordsAfterMalformedRecovery = getMatchRecords();
check(
  "malformed legacy stats do not mark migration attempted",
  recordsAfterMalformedRecovery.length === 1 &&
    recordsAfterMalformedRecovery[0]?.id === "legacy-after-malformed",
  recordsAfterMalformedRecovery
);

__clearGameSessionStoreForTests();
installIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({ "aiboard-game-stats": "{not json" });
await __initGameSessionStoreForTests();
getMatchRecords();
saveMatchRecord(legacyMatch("new-after-malformed-legacy"));
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([legacyMatch("legacy-after-new-save")]),
});
const recordsAfterNewSaveThenValidLegacy = getMatchRecords();
const recordsAfterNewSaveThenValidLegacyAgain = getMatchRecords();
const recoveredIds = recordsAfterNewSaveThenValidLegacy
  .map((record) => record.id)
  .sort();
check(
  "legacy stats retry still imports after new generic match save",
  recoveredIds.length === 2 &&
    recoveredIds[0] === "legacy-after-new-save" &&
    recoveredIds[1] === "new-after-malformed-legacy" &&
    recordsAfterNewSaveThenValidLegacyAgain.length === 2,
  {
    recordsAfterNewSaveThenValidLegacy,
    recordsAfterNewSaveThenValidLegacyAgain,
  }
);

__clearGameSessionStoreForTests();
installIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({ "aiboard-game-stats": JSON.stringify({}) });
await __initGameSessionStoreForTests();
const nonArrayRecords = getMatchRecords();
check(
  "non-array legacy stats return no records",
  nonArrayRecords.length === 0,
  nonArrayRecords
);
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([legacyMatch("legacy-after-non-array")]),
});
const recordsAfterNonArrayRecovery = getMatchRecords();
check(
  "non-array legacy stats do not mark migration attempted",
  recordsAfterNonArrayRecovery.length === 1 &&
    recordsAfterNonArrayRecovery[0]?.id === "legacy-after-non-array",
  recordsAfterNonArrayRecovery
);

__clearGameSessionStoreForTests();
installIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([
    legacyMatch("legacy-array-valid"),
    { id: "legacy-array-invalid" },
  ]),
});
await __initGameSessionStoreForTests();
const malformedArrayRecords = getMatchRecords();
check(
  "malformed legacy stats arrays import no partial records",
  malformedArrayRecords.length === 0,
  malformedArrayRecords
);
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([legacyMatch("legacy-after-malformed-array")]),
});
const recordsAfterMalformedArrayRecovery = getMatchRecords();
check(
  "malformed legacy stats arrays do not mark migration attempted",
  recordsAfterMalformedArrayRecovery.length === 1 &&
    recordsAfterMalformedArrayRecovery[0]?.id === "legacy-after-malformed-array",
  recordsAfterMalformedArrayRecovery
);

__clearGameSessionStoreForTests();
installIndexedDbStore(JSON.stringify({}));
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([
    legacyMatch("legacy-before-bad-optionals"),
    {
      ...legacyMatch("legacy-bad-optionals"),
      whiteModel: 123,
      blackReasoningEffort: { value: "high" },
    },
  ]),
});
await __initGameSessionStoreForTests();
const malformedOptionalRecords = getMatchRecords();
check(
  "malformed legacy optional fields import no partial records",
  malformedOptionalRecords.length === 0,
  malformedOptionalRecords
);
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([legacyMatch("legacy-after-bad-optionals")]),
});
const recordsAfterMalformedOptionalRecovery = getMatchRecords();
check(
  "malformed legacy optional fields do not mark migration attempted",
  recordsAfterMalformedOptionalRecovery.length === 1 &&
    recordsAfterMalformedOptionalRecovery[0]?.id === "legacy-after-bad-optionals",
  recordsAfterMalformedOptionalRecovery
);

__clearGameSessionStoreForTests();
installIndexedDbStore(JSON.stringify({}));
installFailingLocalStorageStore();
await __initGameSessionStoreForTests();
const transientFailureRecords = getMatchRecords();
check(
  "transient legacy stats read failure returns no records",
  transientFailureRecords.length === 0,
  transientFailureRecords
);
installLocalStorageStore({
  "aiboard-game-stats": JSON.stringify([legacyMatch("legacy-after-transient")]),
});
const recordsAfterTransientRecovery = getMatchRecords();
check(
  "transient legacy stats read failure does not mark migration attempted",
  recordsAfterTransientRecovery.length === 1 &&
    recordsAfterTransientRecovery[0]?.id === "legacy-after-transient",
  recordsAfterTransientRecovery
);

__clearGameSessionStoreForTests();
const durableIndexedDb = installIndexedDbStore(JSON.stringify({}));
const durableLegacyRawStats = JSON.stringify([legacyMatch("durable-legacy-match")]);
installLocalStorageStore({ "aiboard-game-stats": durableLegacyRawStats });
await __initGameSessionStoreForTests();
const durableImportedRecords = getMatchRecords();
await __flushGameSessionStoreForTests();
const persistedRawStore = durableIndexedDb.getStoredRaw();
__clearGameSessionStoreForTests();
await __initGameSessionStoreForTests();
const reloadedDurableStore = __exportGameSessionStoreForTests();
check(
  "legacy stats migration persists marker and records together",
  durableImportedRecords.length === 1 &&
    persistedRawStore !== undefined &&
    reloadedDurableStore.gameStatsLegacyImportAttempted === true &&
    reloadedDurableStore.gameMatchRecords.length === 1 &&
    reloadedDurableStore.gameMatchRecords[0]?.id === "durable-legacy-match",
  { durableImportedRecords, persistedRawStore, reloadedDurableStore }
);

__clearGameSessionStoreForTests();
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

__resetGameSessionStoreForTests();
const legacyRawStats = JSON.stringify([legacyMatch("legacy-match-1")]);
installLocalStorageStore({ "aiboard-game-stats": legacyRawStats });
const importedLegacyRecords = getMatchRecords();
const genericRecordsAfterLegacyImport = await listGenericGameMatchRecords();
check(
  "legacy game stats import returns chess match records",
  importedLegacyRecords.length === 1 &&
    importedLegacyRecords[0]?.id === "legacy-match-1" &&
    importedLegacyRecords[0]?.mode === "aivai" &&
    importedLegacyRecords[0]?.whiteModel === "openai:white-test" &&
    importedLegacyRecords[0]?.blackModel === "anthropic:black-test",
  importedLegacyRecords
);
check(
  "legacy game stats import writes generic chess match records",
  genericRecordsAfterLegacyImport.length === 1 &&
    genericRecordsAfterLegacyImport[0]?.id === "legacy-match-1" &&
    genericRecordsAfterLegacyImport[0]?.gameId === "chess",
  genericRecordsAfterLegacyImport
);
check(
  "legacy game stats import preserves legacy localStorage key",
  localStorage.getItem("aiboard-game-stats") === legacyRawStats,
  localStorage.getItem("aiboard-game-stats")
);
resetGameStats();
const recordsAfterLegacyReset = getMatchRecords();
const genericRecordsAfterLegacyReset = await listGenericGameMatchRecords();
check(
  "legacy game stats import is not repeated after reset",
  recordsAfterLegacyReset.length === 0 && genericRecordsAfterLegacyReset.length === 0,
  { recordsAfterLegacyReset, genericRecordsAfterLegacyReset }
);

__resetGameSessionStoreForTests();
installLocalStorageStore({
  "aiboard-game-stats": legacyRawStats,
  "aiboard-game-stats-generic-import-v1": "done",
});
const recordsAfterOldMarkerSplitBrain = getMatchRecords();
check(
  "old localStorage migration marker alone does not suppress import",
  recordsAfterOldMarkerSplitBrain.length === 1 &&
    recordsAfterOldMarkerSplitBrain[0]?.id === "legacy-match-1",
  recordsAfterOldMarkerSplitBrain
);

__resetGameSessionStoreForTests();
installLocalStorageStore({});
saveMatchRecord(legacyMatch("public-api-match-1"));
const genericRecordsAfterPublicSave = await listGenericGameMatchRecords();
const publicAIvsAIMatches = getAIvsAIMatches();
const publicAIvsAIStats = getAIvsAIModelStats();
const publicAggregateStats = getAIvsAIAggregateStats();
const whitePublicStat = publicAIvsAIStats.find(
  (stat) => stat.modelId === "openai:white-test"
);
const blackPublicStat = publicAIvsAIStats.find(
  (stat) => stat.modelId === "anthropic:black-test"
);
check(
  "saveMatchRecord writes generic chess records",
  genericRecordsAfterPublicSave.length === 1 &&
    genericRecordsAfterPublicSave[0]?.id === "public-api-match-1" &&
    genericRecordsAfterPublicSave[0]?.gameId === "chess",
  genericRecordsAfterPublicSave
);
check(
  "AI vs AI public stats read generic chess records",
  publicAIvsAIMatches.length === 1 &&
    publicAIvsAIMatches[0]?.id === "public-api-match-1" &&
    whitePublicStat?.games === 1 &&
    whitePublicStat?.wins === 1 &&
    blackPublicStat?.games === 1 &&
    blackPublicStat?.losses === 1 &&
    publicAggregateStats.totalGames === 1 &&
    publicAggregateStats.whiteWins === 1 &&
    publicAggregateStats.avgMoves === 36,
  { publicAIvsAIMatches, publicAIvsAIStats, publicAggregateStats }
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
