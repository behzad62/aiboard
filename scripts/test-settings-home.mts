/*
 * Settings on the AIBoard home (HM4b; plan §5.8, §6.1, §9 "Old Runners" and "Testing a key").
 * Run: npx tsx scripts/test-settings-home.mts
 *
 * The page reads and writes the home only through the connected Runner. A stub Runner serves
 * `/v2/home` from the Runner's real home store (applyHomeBatch, readAiboardHome) in a temp folder,
 * so the conflict rules are the real ones. Stub keys and a stub upstream only.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { applyHomeBatch, readAiboardHome } from "../runner-v2/src/aiboard-home-store";
import type { AiboardHomeLocation } from "../runner-v2/src/aiboard-home-paths";

import {
  __loadClientStoreFromAdapterForTests,
  __resetClientStoreForTests,
  __setClientStorePassphraseForTests,
  declineEncryptedStore,
  exportStore,
  flush,
  getCustomModels,
  getProviderKey,
  getUserSettings,
  insertDiscussion,
  isEncryptedStorePendingPlainSave,
  saveStoreWithoutEncryption,
} from "../lib/client/store";
import { parseEnvelope, wrap } from "../lib/client/crypto-box";
import type { StorageAdapter } from "../lib/client/storage-adapter";
import {
  HomeSaveError,
  __resetHomeClientForTests,
  getHomeState,
  loadHome,
  providerOps,
  saveHome,
  saveHomeSettings,
  type HomeOp,
} from "../lib/client/home-client";
import {
  addCustomModel,
  savePricingOverride,
  saveProviderKey,
  testSavedCustomModel,
  validateProvider,
} from "../lib/client/settings-api";
import { saveRemoteMcpServer } from "../lib/client/tool-runtime";
import { clearLauncherSession } from "../lib/client/local-runner-handoff";
import { modelProxyClient } from "../lib/client/model-proxy-client";
import { json, STUB_PROXY_URL } from "./model-proxy-test-support.mts";
import { installHomeRunner, makeHome, removeStubHomes } from "./home-test-support.mts";

let checks = 0;
function pass(name: string): void {
  checks += 1;
  console.log(`PASS ${name}`);
}

/** Another tab (or `aiboard config`) writing the same home at the revision it read. */
async function otherTabWrites(location: AiboardHomeLocation, ops: HomeOp[]): Promise<void> {
  const snapshot = await readAiboardHome(location, { credentials: false });
  await applyHomeBatch(location, { baseRevision: snapshot.revision, ops });
}

class MemoryAdapter implements StorageAdapter {
  main: string | null;
  saves = 0;
  readonly files = new Map<string, string>();
  constructor(readonly kind: "indexeddb" | "filesystem", initial: string | null = null) {
    this.main = initial;
  }
  async load() { return this.main; }
  async save(blob: string) { this.saves += 1; this.main = blob; }
  async listDiscussionIds() { return [...new Set([...this.files.keys()].map((key) => key.split("/")[0]!))]; }
  async loadDiscussionFile(id: string, path: string) { return this.files.get(`${id}/${path}`) ?? null; }
  async saveDiscussionFile(id: string, path: string, blob: string) { this.saves += 1; this.files.set(`${id}/${path}`, blob); }
  async deleteDiscussionFile(id: string, path: string) { this.files.delete(`${id}/${path}`); }
  async deleteDiscussion(id: string) { for (const key of [...this.files.keys()]) if (key.startsWith(`${id}/`)) this.files.delete(key); }
  async listBenchmarkRunIds() { return []; }
  async loadBenchmarkRun() { return null; }
  async saveBenchmarkRun() {}
  async deleteBenchmarkRun() {}
  label() { return `memory (${this.kind})`; }
}

function persistedStore(adapter: MemoryAdapter): Record<string, unknown> {
  assert.ok(adapter.main, "the store was saved");
  const envelope = parseEnvelope(adapter.main);
  return JSON.parse(envelope ? envelope.data : adapter.main) as Record<string, unknown>;
}

function freshPage(store: Record<string, unknown> = {}): void {
  __resetHomeClientForTests();
  modelProxyClient.reset();
  __resetClientStoreForTests(store as never);
}

// A deterministic IndexedDB double (declining an encrypted folder starts a new IndexedDB store).
const idb = new Map<string, unknown>();
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
  open() {
    const request: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = {};
    queueMicrotask(() => {
      request.result = { close() {}, objectStoreNames: { contains: () => true }, createObjectStore() {}, transaction() {
        const transaction: { oncomplete?: () => void; onerror?: () => void; objectStore?: () => unknown } = {};
        transaction.objectStore = () => ({
          get(key: string) {
            const read: { result?: unknown; onsuccess?: () => void } = {};
            queueMicrotask(() => { read.result = idb.get(key); read.onsuccess?.(); });
            return read;
          },
          put(value: unknown, key: string) { idb.set(key, value); queueMicrotask(() => transaction.oncomplete?.()); return {}; },
          delete(key: string) { idb.delete(key); queueMicrotask(() => transaction.oncomplete?.()); return {}; },
          getAllKeys() {
            const read: { result?: unknown; onsuccess?: () => void } = {};
            queueMicrotask(() => { read.result = [...idb.keys()]; read.onsuccess?.(); });
            return read;
          },
        });
        return transaction;
      } };
      request.onsuccess?.();
    });
    return request;
  },
} });

const OLD = {
  providerKey: "sk-old-browser-key-000000000001",
  peerToken: "old-account-peer-token-0002",
  customKey: "custom-old-browser-key-0003",
  mcpToken: "mcp-old-browser-token-0004",
  runnerToken: "runner-connection-token-0005",
  benchToken: "benchmark-runner-token-0006",
};
const NOW = "2026-11-12T00:00:00.000Z";

function oldBrowserStore(): Record<string, unknown> {
  return {
    userSettings: {
      id: "default", defaultEffort: "low", defaultMode: "chat", chatDefaultApplied: true, judgeModelId: null,
      benchmarkRunner: { url: "http://127.0.0.1:47900", token: OLD.benchToken },
      toolRuntime: {
        runner: { url: "http://127.0.0.1:47901", token: OLD.runnerToken, access: "ask" },
        remoteMcpServer: { enabled: true, name: "docs", url: "https://mcp.example.test/sse", authorizationToken: OLD.mcpToken },
      },
    },
    providerKeys: [
      { providerId: "openai", apiKey: OLD.providerKey, keyHint: "sk-o...0001", enabled: true, defaultModel: "gpt-5.5", updatedAt: NOW },
      { providerId: "chatgpt", baseURL: "http://127.0.0.1:1455", runnerToken: OLD.peerToken, apiKey: OLD.peerToken, keyHint: null, enabled: true, defaultModel: null, updatedAt: NOW },
    ],
    customModels: [{ id: "old-custom", label: "Old", baseURL: "http://127.0.0.1:11434/v1", model: "gemma", apiKey: OLD.customKey, hasKey: true, createdAt: NOW }],
    discussions: [],
  };
}

try {
  // ------------------------------------------------------------ old secrets: only after the first home read
  {
    const adapter = new MemoryAdapter("indexeddb", JSON.stringify(oldBrowserStore()));
    __resetHomeClientForTests();
    modelProxyClient.reset();
    await __loadClientStoreFromAdapterForTests(adapter);

    // A Runner without capabilities.home: nothing is deleted.
    let runner = installHomeRunner({ capabilities: { modelProxy: true } });
    try {
      const state = await loadHome();
      assert.equal(state.status, "update_required");
      insertDiscussion({ id: "keep-me", topic: "kept", mode: "chat", status: "pending", modelIds: "[]", createdAt: NOW, updatedAt: NOW } as never);
      await flush();
      const saved = JSON.stringify(persistedStore(adapter));
      for (const secret of Object.values(OLD)) assert.ok(saved.includes(secret), "before a home read, no old value is deleted");
      assert.equal(runner.posts.length, 0);
    } finally {
      runner.restore();
    }

    // A home-capable Runner, whose home already holds a key and a default.
    const location = makeHome();
    await applyHomeBatch(location, { baseRevision: 0, ops: [
      { path: "providers.anthropic", op: "set", value: { enabled: true, defaultModel: "claude-sonnet-4-6" } },
      { path: "credentials.providers.anthropic", op: "set", value: { secret: "sk-ant-home-key-0000000000007" } },
      { path: "settings.defaultEffort", op: "set", value: "high" },
    ] });
    __resetHomeClientForTests();
    modelProxyClient.reset();
    runner = installHomeRunner({ location });
    try {
      const state = await loadHome();
      assert.equal(state.status, "ready");
      await flush();
      const persisted = persistedStore(adapter);
      const saved = JSON.stringify(persisted);
      for (const secret of [OLD.providerKey, OLD.peerToken, OLD.customKey, OLD.mcpToken]) {
        assert.ok(!saved.includes(secret), "after the first home read, the old secrets are gone from the saved store");
      }
      assert.ok(saved.includes(OLD.runnerToken) && saved.includes(OLD.benchToken), "the Runner connection tokens stay");
      assert.deepEqual(persisted.providerKeys, [], "the browser's provider rows go, manual account-peer connections included");
      assert.equal((persisted.customModels as Array<{ hasKey: boolean }>)[0]?.hasKey, false);
      // The mirror shows the home, and is never persisted.
      assert.equal(getProviderKey("anthropic")?.enabled, true);
      assert.ok(getProviderKey("anthropic")?.keyHint, "the home's key shows as a hint");
      assert.equal(getUserSettings().defaultEffort, "high");
      assert.ok(!(persisted.providerKeys as unknown[]).length && (persisted.userSettings as { defaultEffort?: string }).defaultEffort !== "high",
        "the home mirror is kept out of the saved store");
      assert.ok(!JSON.stringify(exportStore()).includes("sk-ant-home-key"), "no key from the home ever reaches the page");
      assert.deepEqual(getCustomModels(), [], "custom models come from the home");
    } finally {
      runner.restore();
    }
    pass("after the first GET from a home-capable Runner the saved store holds no provider key, custom-model key or remote MCP token, the Runner connection tokens stay, and the mirror is never saved; before it, nothing is deleted");
  }

  // ------------------------------------------------------------ no write before the first read
  {
    freshPage();
    const unconnected = await saveHomeSettings({ defaultEffort: "high" }).then(() => null, (error: unknown) => error);
    assert.ok(unconnected instanceof HomeSaveError && unconnected.code === "home_loading", "a save before any read refuses");

    const runner = installHomeRunner();
    let release!: () => void;
    runner.holdGet = new Promise((resolve) => { release = resolve; });
    try {
      const loading = loadHome();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(getHomeState().status, "loading");
      const early = await saveHomeSettings({ defaultEffort: "high" }).then(() => null, (error: unknown) => error);
      assert.ok(early instanceof HomeSaveError && early.code === "home_loading");
      const earlyKey = await saveProviderKey({ providerId: "openai", apiKey: "sk-early-key-00000000000008" }).then(() => null, (error: unknown) => error);
      assert.ok(earlyKey instanceof HomeSaveError);
      assert.equal(runner.posts.length, 0, "no settings write is sent before the first GET completes");
      release();
      assert.equal((await loading).status, "ready");
      await saveHomeSettings({ defaultEffort: "high" });
      assert.equal(runner.posts.length, 1);
    } finally {
      runner.restore();
    }

    // Not connected: every writer refuses with the connect message, and nothing is sent.
    freshPage();
    clearLauncherSession(null);
    const state = await loadHome();
    assert.equal(state.status, "not_connected");
    const refused = await saveHomeSettings({ defaultEffort: "low" }).then(() => null, (error: unknown) => error);
    assert.ok(refused instanceof HomeSaveError && /Connect AI Board/.test(refused.message));
    pass("no settings write is sent before the first GET completes, or with no Runner");
  }

  // ------------------------------------------------------------ two tabs, one map
  {
    freshPage();
    const runner = installHomeRunner();
    try {
      await loadHome();
      // The other tab saves model-b's price after this tab read the home.
      await otherTabWrites(runner.location, [{ path: "settings.modelPricingOverrides.openai:model-b", op: "set", value: { inputUsdPer1M: 2, outputUsdPer1M: 4, cachedInputUsdPer1M: null, updatedAt: NOW } }]);
      await savePricingOverride({ fullModelId: "openai:model-a", inputUsdPer1M: 1, outputUsdPer1M: 3 });
      let home = await readAiboardHome(runner.location, { credentials: false });
      const prices = home.config.settings.modelPricingOverrides as Record<string, { inputUsdPer1M: number }>;
      assert.equal(prices["openai:model-a"]?.inputUsdPer1M, 1);
      assert.equal(prices["openai:model-b"]?.inputUsdPer1M, 2, "the other tab's entry is kept");
      assert.equal(runner.posts.length, 1, "different entries of one map do not conflict");
      assert.deepEqual(runner.posts[0]!.ops.map((op) => op.path), ["settings.modelPricingOverrides.openai:model-a"], "only the changed entry is sent");
      assert.deepEqual(Object.keys(getUserSettings().modelPricingOverrides ?? {}).sort(), ["openai:model-a", "openai:model-b"], "this tab re-reads after its save");

      // The same section: the later write is refused, rebuilt on fresh data and retried once.
      await otherTabWrites(runner.location, [{ path: "settings.defaultStyleNote", op: "set", value: "from the other tab" }]);
      const seen: string[] = [];
      await saveHomeSettings((settings) => {
        seen.push(settings.defaultStyleNote ?? "");
        return { defaultStyleNote: `${settings.defaultStyleNote ?? ""} + this tab` };
      });
      home = await readAiboardHome(runner.location, { credentials: false });
      assert.equal(home.config.settings.defaultStyleNote, "from the other tab + this tab", "the retry re-applied the change to the fresh copy");
      assert.equal(seen.length, 2, "the change was built once, then once more on fresh data");
      assert.equal(seen[1], "from the other tab");
      assert.equal(runner.posts.length, 3, "one refused batch, one retry");

      // A second conflict is not retried again: the save fails, says why, and reverts.
      runner.conflictPosts = 2;
      let builds = 0;
      const postsBefore = runner.posts.length;
      const second = await saveHome(() => {
        builds += 1;
        return [{ path: "settings.defaultStyleNote", op: "set", value: "this tab again" }];
      }).then(() => null, (error: unknown) => error);
      assert.ok(second instanceof HomeSaveError && second.code === "home_conflict");
      assert.equal(builds, 2, "built once, retried once");
      assert.equal(runner.posts.length - postsBefore, 2, "no third attempt");
      assert.equal(getUserSettings().defaultStyleNote, "from the other tab + this tab", "the shown change is reverted");
    } finally {
      runner.restore();
    }
    pass("two tabs editing different entries of one map both keep their edits; a same-section conflict retries once on fresh data");
  }

  // ------------------------------------------------------------ a failed save shows an error and reverts
  {
    freshPage();
    const runner = installHomeRunner();
    try {
      await loadHome();
      await saveHomeSettings({ defaultVerbosity: "concise" });
      const before = getUserSettings().defaultVerbosity;
      runner.failNextPost = { status: 503, code: "home_busy", error: "Another AI Board is saving settings; try again." };
      const error = await saveHomeSettings({ defaultVerbosity: "detailed" }).then(() => null, (caught: unknown) => caught);
      assert.ok(error instanceof HomeSaveError && error.code === "home_busy" && /try again/.test(error.message), "the error carries the Runner's message");
      assert.equal(getUserSettings().defaultVerbosity, before, "the change it showed is reverted");
      const home = await readAiboardHome(runner.location, { credentials: false });
      assert.equal(home.config.settings.defaultVerbosity, "concise");

      runner.failNextPost = { status: 400, code: "home_invalid_op", error: "That value is not allowed." };
      const keyError = await saveProviderKey({ providerId: "openai", apiKey: "sk-refused-key-000000000009" }).then(() => null, (caught: unknown) => caught);
      assert.ok(keyError instanceof HomeSaveError);
      assert.equal(getProviderKey("openai"), undefined, "a refused provider save leaves no row behind");
    } finally {
      runner.restore();
    }
    pass("a failed save shows an error and reverts");
  }

  // ------------------------------------------------------------ keys: typed once, tested after saving
  {
    freshPage();
    let upstreamStatus = 401;
    const runner = installHomeRunner({
      upstream: (request) => {
        if (!request.url.startsWith(`${STUB_PROXY_URL}/v2/model-proxy/`)) return json({ error: "unexpected" }, 500);
        if (upstreamStatus !== 200) return json({ error: { message: "Incorrect API key provided." } }, upstreamStatus);
        return new Response(
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "AIBOARD_TEXT_OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      await loadHome();
      const typed = "sk-typed-provider-key-0000000010";
      await saveProviderKey({ providerId: "deepseek", apiKey: typed });
      const keyPost = runner.posts.at(-1)!;
      assert.ok(keyPost.ops.some((op) => op.path === "credentials.providers.deepseek"), "the key goes in the request body");
      assert.ok(!JSON.stringify(exportStore()).includes(typed), "the page keeps no copy of the key");
      assert.ok(getProviderKey("deepseek")?.keyHint, "only the hint is shown");
      const home = await readAiboardHome(runner.location);
      assert.equal(home.secret("credentials.providers.deepseek"), typed);

      // Test after saving: a failed test leaves the key saved and marked not validated.
      const result = await validateProvider({ providerId: "deepseek", modelId: "deepseek-chat" });
      assert.equal(result.valid, false);
      let after = await readAiboardHome(runner.location);
      assert.equal(after.config.providers.deepseek?.lastValidationSucceeded, false, "marked not validated");
      assert.equal(after.secret("credentials.providers.deepseek"), typed, "and still saved, to correct or remove");
      upstreamStatus = 200;
      assert.equal((await validateProvider({ providerId: "deepseek", modelId: "deepseek-chat" })).valid, true);
      after = await readAiboardHome(runner.location);
      assert.equal(after.config.providers.deepseek?.lastValidationSucceeded, true);

      // An unsaved custom endpoint is saved, with its key, before it is tested.
      upstreamStatus = 500;
      const custom = await addCustomModel({ label: "Local", baseURL: "http://127.0.0.1:11434/v1", model: "gemma", apiKey: "custom-typed-key-000000011" });
      const tested = await testSavedCustomModel(custom.id);
      assert.equal(tested.valid, false);
      const customHome = await readAiboardHome(runner.location);
      assert.equal(customHome.secret(`credentials.customModels.${custom.id}`), "custom-typed-key-000000011");
      assert.equal(customHome.config.customModels.find((entry) => entry.id === custom.id)?.lastValidationSucceeded, false);
      assert.ok(!JSON.stringify(exportStore()).includes("custom-typed-key"), "no custom key in the page");

      // The remote MCP token: typed, saved as a credential, never in config.json or the page.
      await saveRemoteMcpServer({ enabled: true, name: "docs", url: "https://mcp.example.test/sse", authorizationToken: "mcp-typed-token-0000000012" });
      const mcpHome = await readAiboardHome(runner.location);
      assert.equal(mcpHome.secret("credentials.remoteMcpAuthorizationToken"), "mcp-typed-token-0000000012");
      assert.ok(!JSON.stringify(mcpHome.config).includes("mcp-typed-token"));
      assert.ok(!JSON.stringify(exportStore()).includes("mcp-typed-token"));
    } finally {
      runner.restore();
    }
    pass("a key is typed once and sent in a request body; Test saves it first, and a failed test leaves it saved and marked not validated");
  }

  // ------------------------------------------------------------ account providers: never a credential
  {
    freshPage();
    const runner = installHomeRunner();
    try {
      await loadHome();
      await saveProviderKey({ providerId: "chatgpt", apiKey: "account-peer-token-0000000013", runnerToken: "account-peer-token-0000000013", enabled: true });
      await saveProviderKey({ providerId: "github-copilot", apiKey: "account-peer-token-0000000013", enabled: true });
      assert.ok(runner.rawPosts.every((body) => !body.includes("account-peer-token")), "no peer token is ever sent to the home");
      assert.ok(runner.posts.every((batch) => batch.ops.every((op) => !op.path.startsWith("credentials."))));
      assert.throws(() => providerOps("chatgpt", {}, "account-peer-token-0000000013"), HomeSaveError);
      const home = await readAiboardHome(runner.location);
      assert.equal(home.config.providers.chatgpt?.enabled, true, "the row is saved");
    } finally {
      runner.restore();
    }
    pass("ChatGPT and Copilot rows are saved without any credential: the page never sends an account peer's token");
  }

  // ------------------------------------------------------------ the encrypted store (OD-27, OD-28)
  {
    const secretStore = JSON.stringify({ ...oldBrowserStore(), discussions: [{ id: "old-chat", topic: "history", mode: "chat", status: "done", modelIds: "[]", createdAt: NOW, updatedAt: NOW }] });
    const salt = await __setClientStorePassphraseForTests("test-passphrase-only");
    assert.ok(salt);

    // A picked folder, declined: left untouched, and the page starts a new IndexedDB store.
    const folder = new MemoryAdapter("filesystem", JSON.stringify(await wrap(secretStore, true)));
    const folderBefore = folder.main;
    __resetHomeClientForTests();
    await __loadClientStoreFromAdapterForTests(folder);
    assert.equal(isEncryptedStorePendingPlainSave(), true, "the encrypted store opens once with its passphrase");
    insertDiscussion({ id: "new-chat", topic: "new", mode: "chat", status: "pending", modelIds: "[]", createdAt: NOW, updatedAt: NOW } as never);
    await flush();
    assert.equal(folder.saves, 0, "nothing is written before the user decides");
    const declined = await declineEncryptedStore();
    assert.equal(declined.startedNewBrowserStore, true);
    assert.equal(folder.main, folderBefore, "a declined picked folder stays untouched");
    assert.equal(folder.saves, 0);
    assert.ok(typeof idb.get("store") === "string" && !String(idb.get("store")).includes("old-chat"), "a new IndexedDB store, empty");

    // Confirmed: saved without encryption, history kept.
    await __setClientStorePassphraseForTests("test-passphrase-only");
    const browser = new MemoryAdapter("indexeddb", JSON.stringify(await wrap(secretStore, true)));
    __resetHomeClientForTests();
    await __loadClientStoreFromAdapterForTests(browser);
    assert.equal(browser.saves, 0);
    await saveStoreWithoutEncryption();
    const plain = parseEnvelope(browser.main!);
    assert.equal(plain?.encrypted ?? false, false, "saved plain only after the user confirms");
    assert.ok(browser.main!.includes("old-chat"), "the history survives");
    pass("an encrypted store opens once with its passphrase and is saved plain only after the user confirms; a declined picked folder stays untouched");
  }

  // ------------------------------------------------------------ only the home client writes settings fields
  {
    const root = process.cwd();
    const SETTINGS_WRITERS = ["updateUserSettings", "upsertProviderKey", "updateProviderKey", "addCustomModel", "updateCustomModel", "deleteCustomModel", "applyHomeMirror", "removeOldBrowserSecrets"];
    const HOME_CLIENT_ONLY = new Set(["applyHomeMirror", "removeOldBrowserSecrets"]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ["lib", "app", "components"]) walk(join(root, dir));
    const DEAD = new Set(["lib/db/index.ts", "lib/providers/index.ts", "lib/providers/custom.ts"]);
    const offenders: string[] = [];
    const scan = (file: string, source: string): string[] => {
      const found: string[] = [];
      const rel = relative(root, file).replace(/\\/g, "/");
      if (rel === "lib/client/store.ts" || DEAD.has(rel)) return found;
      const storeImport = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](?:\.\/store|@\/lib\/client\/store|(?:\.\.\/)+(?:lib\/)?client\/store|\.\.\/client\/store)["']/g;
      for (const match of source.matchAll(storeImport)) {
        for (const raw of match[1]!.split(",")) {
          const name = raw.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, "");
          if (!SETTINGS_WRITERS.includes(name)) continue;
          if (rel === "lib/client/home-client.ts" && HOME_CLIENT_ONLY.has(name)) continue;
          found.push(`${rel} imports ${name} from the store`);
        }
      }
      if (/getUserSettings\(\)\s*\.\s*\w+\s*=(?!=)/.test(source)) found.push(`${rel} assigns to a settings field`);
      // Allowed: the load-time model-selection migration rewrites the loaded blob before the
      // home mirror is applied, and the import parser fills a local object, not the store.
      const USER_SETTINGS_ASSIGN_ALLOWED = new Set(["lib/client/model-selection-migration.ts", "lib/client/storage-import.ts"]);
      if (!USER_SETTINGS_ASSIGN_ALLOWED.has(rel) && /\.userSettings\s*=(?!=)/.test(source)) found.push(`${rel} replaces userSettings`);
      return found;
    };
    // Self-test: the scan catches each way of writing a settings field.
    assert.equal(scan(join(root, "lib/client/x.ts"), 'import { updateUserSettings } from "./store";').length, 1);
    assert.equal(scan(join(root, "components/x.tsx"), 'import { getUserSettings, addCustomModel as add } from "@/lib/client/store";').length, 1);
    assert.equal(scan(join(root, "lib/client/x.ts"), "getUserSettings().judgeModelId = null;").length, 1);
    assert.equal(scan(join(root, "lib/client/x.ts"), 'import { applyHomeMirror } from "./store";').length, 1);
    assert.equal(scan(join(root, "lib/client/home-client.ts"), 'import { applyHomeMirror } from "./store";').length, 0);
    for (const file of files) offenders.push(...scan(file, readFileSync(file, "utf8")));
    assert.deepEqual(offenders, [], "no code outside the home client writes a settings field of the store");
    pass(`no code outside the home client writes a settings field of the store (${files.length} files scanned)`);
  }
} finally {
  removeStubHomes();
}

console.log(`PASS settings home (${checks} checks)`);
process.exit(0);
