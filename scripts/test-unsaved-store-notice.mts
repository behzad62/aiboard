/*
 * An open encrypted store is written only after the user chooses (OD-28), so the choice must be
 * impossible to miss: an app-wide notice, and a prompt before leaving with unsaved changes (HM4b).
 * Run: npx tsx scripts/test-unsaved-store-notice.mts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UnsavedStoreNoticeView } from "../components/UnsavedStoreNotice";
import { wrap } from "../lib/client/crypto-box";
import type { StorageAdapter } from "../lib/client/storage-adapter";
import {
  __loadClientStoreFromAdapterForTests,
  __resetClientStoreForTests,
  __setClientStorePassphraseForTests,
  flush,
  hasUnsavedEncryptedStoreChanges,
  insertDiscussion,
  isEncryptedStorePendingPlainSave,
  onEncryptedStoreChange,
  saveStoreWithoutEncryption,
} from "../lib/client/store";
import {
  ENCRYPTED_STORE_CHOICE_HREF,
  installUnsavedStoreGuard,
  warnBeforeUnloadIfUnsaved,
} from "../lib/client/unsaved-store-guard";

// A deterministic IndexedDB double: saving without encryption records the storage choice there.
const idb = new Map<string, unknown>();
Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
  open() {
    const request: { result?: unknown; onsuccess?: () => void } = {};
    queueMicrotask(() => {
      request.result = { close() {}, objectStoreNames: { contains: () => true }, createObjectStore() {}, transaction() {
        const transaction: { oncomplete?: () => void; objectStore?: () => unknown } = {};
        transaction.objectStore = () => ({
          get(key: string) {
            const read: { result?: unknown; onsuccess?: () => void } = {};
            queueMicrotask(() => { read.result = idb.get(key); read.onsuccess?.(); });
            return read;
          },
          put(value: unknown, key: string) { idb.set(key, value); queueMicrotask(() => transaction.oncomplete?.()); return {}; },
          delete(key: string) { idb.delete(key); queueMicrotask(() => transaction.oncomplete?.()); return {}; },
        });
        return transaction;
      } };
      request.onsuccess?.();
    });
    return request;
  },
} });

class MemoryAdapter implements StorageAdapter {
  readonly kind = "indexeddb" as const;
  saves = 0;
  constructor(public main: string | null) {}
  async load() { return this.main; }
  async save(blob: string) { this.saves += 1; this.main = blob; }
  async listDiscussionIds() { return []; }
  async loadDiscussionFile() { return null; }
  async saveDiscussionFile() { this.saves += 1; }
  async deleteDiscussionFile() {}
  async deleteDiscussion() {}
  async listBenchmarkRunIds() { return []; }
  async loadBenchmarkRun() { return null; }
  async saveBenchmarkRun() {}
  async deleteBenchmarkRun() {}
  label() { return "memory"; }
}

const NOW = "2026-11-12T00:00:00.000Z";
const newChat = (id: string) => ({ id, topic: "work since the unlock", mode: "chat", status: "pending", modelIds: "[]", createdAt: NOW, updatedAt: NOW }) as never;
let checks = 0;
const pass = (name: string) => { checks += 1; console.log(`PASS ${name}`); };

function beforeUnload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  return event;
}

// ---------------------------------------------------------------- the notice
{
  __resetClientStoreForTests();
  let changes = 0;
  const stop = onEncryptedStoreChange(() => { changes += 1; });
  await __setClientStorePassphraseForTests("test-passphrase-only");
  const adapter = new MemoryAdapter(JSON.stringify(await wrap(JSON.stringify({ discussions: [] }), true)));
  await __loadClientStoreFromAdapterForTests(adapter);
  assert.equal(isEncryptedStorePendingPlainSave(), true);
  assert.ok(changes > 0, "opening the encrypted store tells the notice");

  const shown = renderToStaticMarkup(React.createElement(UnsavedStoreNoticeView, { pending: true }));
  assert.match(shown, /role="alert"/);
  assert.match(shown, /not being saved/);
  assert.match(shown, /nothing is written until you choose/);
  assert.ok(shown.includes(`href="${ENCRYPTED_STORE_CHOICE_HREF}"`), "the notice links to Settings > Storage");
  assert.equal(ENCRYPTED_STORE_CHOICE_HREF, "/settings?tab=storage");
  assert.equal(renderToStaticMarkup(React.createElement(UnsavedStoreNoticeView, { pending: false })), "", "no notice otherwise");

  // App-wide: the layout renders it above every page's content, not only on Settings.
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /<UnsavedStoreNotice \/>\s*<main/, "the notice sits in the layout, above <main>");
  const settings = readFileSync(new URL("../app/settings/settings-client.tsx", import.meta.url), "utf8");
  assert.ok(!settings.includes("UnsavedStoreNotice"), "not a Settings-only notice");

  const before = changes;
  await saveStoreWithoutEncryption();
  assert.equal(isEncryptedStorePendingPlainSave(), false);
  assert.ok(changes > before, "saving without encryption hides the notice");
  stop();
  pass("while an open encrypted store waits for the user's choice, every page shows a notice linking to Settings > Storage; it goes once they choose");
}

// ---------------------------------------------------------------- leaving the page
{
  __resetClientStoreForTests();
  await __setClientStorePassphraseForTests("test-passphrase-only");
  const adapter = new MemoryAdapter(JSON.stringify(await wrap(JSON.stringify({ discussions: [] }), true)));
  await __loadClientStoreFromAdapterForTests(adapter);
  const target = new EventTarget();
  const uninstall = installUnsavedStoreGuard(target as unknown as Window);

  let event = beforeUnload();
  target.dispatchEvent(event);
  assert.equal(hasUnsavedEncryptedStoreChanges(), false);
  assert.equal(event.defaultPrevented, false, "no prompt while nothing is unsaved");

  insertDiscussion(newChat("since-unlock"));
  await flush();
  assert.equal(adapter.saves, 0, "nothing is written before the choice (OD-28)");
  assert.equal(hasUnsavedEncryptedStoreChanges(), true);
  event = beforeUnload();
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, "leaving with unsaved changes asks first");
  const legacy = { preventDefault() {}, returnValue: undefined as unknown };
  warnBeforeUnloadIfUnsaved(legacy);
  assert.equal(legacy.returnValue, "", "returnValue is set for browsers that need it");

  await saveStoreWithoutEncryption();
  assert.ok(adapter.saves > 0 && adapter.main!.includes("since-unlock"), "the work since the unlock is saved");
  event = beforeUnload();
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, "no prompt once saved");

  uninstall();
  __resetClientStoreForTests();
  await __setClientStorePassphraseForTests("test-passphrase-only");
  await __loadClientStoreFromAdapterForTests(new MemoryAdapter(JSON.stringify(await wrap(JSON.stringify({ discussions: [] }), true))));
  insertDiscussion(newChat("after-uninstall"));
  await flush();
  event = beforeUnload();
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, "the uninstalled guard no longer asks");
  pass("leaving the page with unsaved changes in the open encrypted store asks first; with none, or once saved, it does not");
}

console.log(`PASS unsaved store notice (${checks} checks)`);
process.exit(0);
