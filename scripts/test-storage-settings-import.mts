import assert from "node:assert/strict";
import { homeOpsFromSettingsImport, parseSettingsImport } from "../lib/client/storage-import";
import { KEYS_NOT_IMPORTED_MESSAGE } from "../lib/client/home-client";
import { IndexedDBAdapter, createAdapter } from "../lib/client/storage-adapter";
import {
  __clearClientStoreForTests, __resetClientStoreForTests, __setAdapterForTests,
  exportStore, flush, getConfig, replaceStore, switchStorageLocation, withoutSecrets,
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
    userSettings: {
      defaultMode: "chat", defaultStyleNote: "Imported defaults",
      modelPricingOverrides: { "openai:model-a": { inputUsdPer1M: 1, outputUsdPer1M: 2, cachedInputUsdPer1M: null, updatedAt: "2026-11-12T00:00:00.000Z" } },
      toolRuntime: { remoteMcpServer: { enabled: true, name: "docs", url: "https://mcp.example.test/sse", authorizationToken: "mcp-test-token" } },
    },
    providerKeys: [{ providerId: "replace", apiKey: "new-test-key" }, { providerId: "new-provider", enabled: true }],
    customModels: [{ id: "new-custom", label: "Imported", baseURL: "http://127.0.0.1:11434/v1", model: "gemma", apiKey: "custom-test-key" }],
    discussions: [{ id: "source-chat-metadata-only" }],
    benchmarkRuns: [{ id: "source-benchmark" }],
  };
  const snapshot = JSON.stringify(current);
  const folderFile = JSON.stringify({ v: 1, encrypted: false, data: JSON.stringify(source) });
  const parsed = parseSettingsImport(folderFile);
  assert.deepEqual(Object.keys(parsed).sort(), ["customModels", "providerKeys", "userSettings"]);
  assert.deepEqual(parseSettingsImport(JSON.stringify(source)), parsed);
  assert.deepEqual(parseSettingsImport(JSON.stringify({ store: source })), parsed);
  for (const invalid of ["null", "[]", "{}", '{"providerKeys":{}}', '{"customModels":[{"id":null}]}', '{"userSettings":[]}']) {
    assert.throws(() => parseSettingsImport(invalid));
  }
  assert.throws(() => parseSettingsImport('{"encrypted":true,"data":"ciphertext"}'), /Unlock it in the original browser/);

  // HM4b: imported settings become AIBoard home ops; every key is skipped and named.
  const plan = homeOpsFromSettingsImport(parsed);
  const sent = JSON.stringify(plan.ops);
  assert.ok(!sent.includes("new-test-key") && !sent.includes("custom-test-key") && !sent.includes("mcp-test-token"), "no key is imported");
  assert.ok(plan.ops.every((op) => !op.path.startsWith("credentials.")), "no credential op");
  assert.deepEqual([...plan.skippedKeys].sort(), ["Imported", "remote MCP server", "replace"]);
  assert.ok(plan.ops.some((op) => op.path === "settings.defaultStyleNote" && op.value === "Imported defaults"));
  assert.ok(plan.ops.some((op) => op.path === "providers.new-provider" && op.op === "merge"));
  assert.ok(plan.ops.some((op) => op.path === "customModels.new-custom" && op.op === "set"));
  assert.ok(plan.ops.some((op) => op.path === "settings.toolRuntime" && JSON.stringify(op.value) === JSON.stringify({ remoteMcpServer: { enabled: true, name: "docs", url: "https://mcp.example.test/sse" } })));
  assert.ok(plan.ops.some((op) => op.path === "settings.modelPricingOverrides.openai:model-a"), "map settings import entry by entry");
  assert.ok(!plan.ops.some((op) => op.path === "settings.discussions" || op.path.startsWith("discussions")), "work is never part of a settings import");
  assert.match(KEYS_NOT_IMPORTED_MESSAGE, /aiboard keys set/, "the import says how to set keys");
  assert.equal(JSON.stringify(current), snapshot, "building the import does not touch active data");

  // Export and full restore never carry a key.
  const exported = JSON.stringify(withoutSecrets(current));
  assert.ok(!exported.includes("old-test-key"), "an export has no key");
  for (const field of ["discussions", "messages", "benchmarkRuns", "benchmarkResultSets"] as const) {
    assert.deepEqual(withoutSecrets(current)[field], current[field], `${field} survive in an export`);
  }
  __resetClientStoreForTests();
  __setAdapterForTests(new IndexedDBAdapter());
  replaceStore(withoutSecrets({ ...exportStore(), ...source, providerKeys: [{ providerId: "replace", apiKey: "new-test-key", runnerToken: "peer-test-token" }] } as never));
  await flush();
  const persisted = JSON.parse(JSON.parse(kv.get("store") as string).data);
  assert.ok(!JSON.stringify(persisted).includes("new-test-key") && !JSON.stringify(persisted).includes("peer-test-token"), "a restored backup holds no key");
  assert.equal(persisted.customModels[0].id, "new-custom");

  // Startup can fall back quietly, but an explicit folder switch must refuse
  // permission failure without changing the selected storage or settings.
  kv.set("dirHandle", { queryPermission: async () => "prompt" });
  const desired = { kind: "filesystem" as const, encryptionEnabled: false };
  assert.equal((await createAdapter(desired)).kind, "indexeddb");
  await assert.rejects(switchStorageLocation(desired), /storage location has not changed/);
  assert.equal(getConfig().kind, "indexeddb");
  assert.ok(!JSON.stringify(exportStore()).includes("new-test-key"));
  assert.equal(kv.has("config"), false);
  console.log("PASS settings import builds home ops and skips keys with a message; export and restore carry no key; refused folder-switch fallback");
} finally {
  __clearClientStoreForTests();
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
}
