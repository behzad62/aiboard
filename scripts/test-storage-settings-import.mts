import assert from "node:assert/strict";
import { mergeSettingsImport, parseSettingsImport } from "../lib/client/storage-import";
import { IndexedDBAdapter, createAdapter } from "../lib/client/storage-adapter";
import {
  __clearClientStoreForTests, __resetClientStoreForTests, __setAdapterForTests,
  exportStore, flush, getConfig, replaceStore, switchStorageLocation,
} from "../lib/client/store";

const kv = new Map<string, unknown>();
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
// A deterministic IndexedDB double; no real browser profile or user files.
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
  open() {
    const request: { result?: unknown; onsuccess?: () => void } = {};
    queueMicrotask(() => {
      request.result = { close() {}, transaction() {
        const transaction: { oncomplete?: () => void; objectStore?: () => unknown } = {};
        transaction.objectStore = () => ({
          get(key: string) {
            const read: { result?: unknown; onsuccess?: () => void } = {};
            queueMicrotask(() => { read.result = kv.get(key); read.onsuccess?.(); });
            return read;
          },
          put(value: unknown, key: string) { kv.set(key, value); queueMicrotask(() => transaction.oncomplete?.()); },
          delete(key: string) { kv.delete(key); queueMicrotask(() => transaction.oncomplete?.()); },
        });
        return transaction;
      } };
      request.onsuccess?.();
    });
    return request;
  },
} });

try {
  __resetClientStoreForTests();
  const initial = exportStore();
  const current = {
    ...initial,
    userSettings: { ...initial.userSettings, defaultVerbosity: "concise" as const },
    providerKeys: [{ providerId: "keep", enabled: true }, { providerId: "replace", apiKey: "old-test-key" }],
    customModels: [{ id: "existing-custom", label: "Existing" }],
    discussions: [{ id: "keep-chat", topic: "Existing work" }],
    messages: [{ id: "keep-message", discussionId: "keep-chat", content: "Keep this" }],
    benchmarkRuns: [{ id: "keep-benchmark" }],
    benchmarkResultSets: [{ id: "keep-result" }],
  } as unknown as typeof initial;
  const source = {
    userSettings: { defaultMode: "chat", defaultStyleNote: "Imported defaults" },
    providerKeys: [{ providerId: "replace", apiKey: "new-test-key" }, { providerId: "new-provider", enabled: true }],
    customModels: [{ id: "new-custom", label: "Imported" }],
    discussions: [{ id: "source-chat-metadata-only" }],
    benchmarkRuns: [{ id: "source-benchmark" }],
  };
  const snapshot = JSON.stringify(current);
  const folderFile = JSON.stringify({ v: 1, encrypted: false, data: JSON.stringify(source) });
  const parsed = parseSettingsImport(folderFile);
  assert.deepEqual(Object.keys(parsed).sort(), ["customModels", "providerKeys", "userSettings"]);
  const merged = mergeSettingsImport(current, parsed);
  assert.equal(merged.userSettings.defaultStyleNote, "Imported defaults");
  assert.equal(merged.userSettings.defaultVerbosity, "concise");
  assert.deepEqual(merged.providerKeys.map(item => item.providerId), ["keep", "replace", "new-provider"]);
  assert.equal(merged.providerKeys.find(item => item.providerId === "replace")?.apiKey, "new-test-key");
  assert.deepEqual(merged.customModels.map(item => item.id), ["existing-custom", "new-custom"]);
  for (const field of ["discussions", "messages", "benchmarkRuns", "benchmarkResultSets"] as const) {
    assert.deepEqual(merged[field], current[field], `${field} survives settings-only import`);
  }
  assert.equal(JSON.stringify(current), snapshot, "merging does not mutate active data before commit");
  assert.deepEqual(parseSettingsImport(JSON.stringify(source)), parsed);
  assert.deepEqual(parseSettingsImport(JSON.stringify({ store: source })), parsed);
  for (const invalid of ["null", "[]", "{}", '{"providerKeys":{}}', '{"customModels":[{"id":null}]}', '{"userSettings":[]}']) {
    assert.throws(() => parseSettingsImport(invalid));
  }
  assert.throws(() => parseSettingsImport('{"encrypted":true,"data":"ciphertext"}'), /Unlock it in the original browser/);

  // The real store commits imported settings and persists them in this browser.
  __resetClientStoreForTests();
  __setAdapterForTests(new IndexedDBAdapter());
  replaceStore(mergeSettingsImport(exportStore(), parsed));
  await flush();
  const persisted = JSON.parse(JSON.parse(kv.get("store") as string).data);
  assert.equal(persisted.providerKeys[0].apiKey, "new-test-key");
  assert.equal(persisted.customModels[0].id, "new-custom");

  // Startup can fall back quietly, but an explicit folder switch must refuse
  // permission failure without changing the selected storage or settings.
  kv.set("dirHandle", { queryPermission: async () => "prompt" });
  const desired = { kind: "filesystem" as const, encryptionEnabled: false };
  assert.equal((await createAdapter(desired)).kind, "indexeddb");
  await assert.rejects(switchStorageLocation(desired), /storage location has not changed/);
  assert.equal(getConfig().kind, "indexeddb");
  assert.equal(exportStore().providerKeys[0].apiKey, "new-test-key");
  assert.equal(kv.has("config"), false);
  console.log("PASS local-folder envelope and backup settings imports, preserved work, browser persistence, and refused folder-switch fallback");
} finally {
  __clearClientStoreForTests();
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
}
