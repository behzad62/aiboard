import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { CREDENTIAL_MIGRATION_STEPS, prepareCredentialStores } from "../src/credential-migration.js";
import { EncryptedProviderConfigStore, openEncryptedJson, writeEncryptedJson } from "../src/encrypted-provider-config-store.js";
import { ExtensionCredentialStore } from "../src/extension-credentials.js";
import { deriveCredentialStoreKey, FileStorageKeyProvider } from "../src/storage-key.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";

const OLD_TOKEN = "old-runner-token-for-migration";
const OTHER_TOKEN = "changed-runner-token-after-migration";
const PROVIDERS: RunnerProviderConfig[] = [{
  runtimeId: "example:model",
  providerId: "example",
  modelId: "model",
  secret: "provider-secret-for-test",
  transport: "openai-compatible",
  capabilities: ["code"],
  priority: 0,
}];
const CREDENTIALS = [{
  ref: "cred_0123456789abcdef01234567",
  extensionId: "ext_abcdefgh",
  name: "API_KEY",
  kind: "env",
  value: "extension-secret-for-test",
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
}];

function fixture(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(process.cwd(), ".credential-migration-test-"));
  t.after(() => {
    const target = relative(process.cwd(), root);
    assert.match(target, /^\.credential-migration-test-[^\\/]+$/);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function legacy(root: string, stores: readonly ("provider" | "extension")[] = ["provider", "extension"]): void {
  const token = Buffer.from(OLD_TOKEN);
  try {
    if (stores.includes("provider")) writeEncryptedJson(join(root, "provider-configs.enc"), token, PROVIDERS);
    if (stores.includes("extension")) writeEncryptedJson(join(root, "extension-credentials.enc"), token, CREDENTIALS);
  } finally {
    token.fill(0);
  }
}

function legacyBytes(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ["provider-configs.enc", "extension-credentials.enc"]) {
    if (existsSync(join(root, name))) result[name] = readFileSync(join(root, name), "base64");
  }
  return result;
}

function openStores(root: string, token?: string) {
  const prepared = prepareCredentialStores({ stateDirectory: root, legacyToken: token });
  try {
    const options = { requireExisting: true, beforeAccess: prepared.assertLegacyUnchanged };
    return {
      prepared,
      provider: new EncryptedProviderConfigStore(prepared.providerPath, prepared.providerKey, options),
      extension: new ExtensionCredentialStore(prepared.extensionPath, prepared.extensionKey, options),
    };
  } finally {
    prepared.providerKey.fill(0);
    prepared.extensionKey.fill(0);
  }
}

function closeStores(stores: ReturnType<typeof openStores>): void {
  stores.provider.close();
  stores.extension.close();
}

function assertLegacyValues(stores: ReturnType<typeof openStores>): void {
  assert.deepEqual(stores.provider.load(), PROVIDERS);
  assert.equal(stores.extension.reveal(CREDENTIALS[0].ref).value, CREDENTIALS[0].value);
}

test("fresh state uses independent storage keys and survives control-token changes", (t) => {
  const root = fixture(t);
  const first = openStores(root);
  assert.deepEqual(first.provider.load(), []);
  assert.deepEqual(first.extension.list(), []);
  first.provider.save(PROVIDERS);
  const credential = first.extension.put({
    extensionId: "ext_abcdefgh", name: "API_KEY", kind: "env", value: CREDENTIALS[0].value,
  });
  const providerPath = first.prepared.providerPath;
  const extensionPath = first.prepared.extensionPath;
  closeStores(first);

  const restarted = openStores(root, OTHER_TOKEN);
  assert.deepEqual(restarted.provider.load(), PROVIDERS);
  assert.equal(restarted.extension.reveal(credential.ref).value, CREDENTIALS[0].value);
  assert.equal(restarted.prepared.providerPath, providerPath);
  assert.equal(restarted.prepared.extensionPath, extensionPath);
  closeStores(restarted);

  const storageKey = new FileStorageKeyProvider(root).getKey({ createIfMissing: false });
  const providerKey = deriveCredentialStoreKey(storageKey, "provider");
  const extensionKey = deriveCredentialStoreKey(storageKey, "extension");
  try {
    assert.notDeepEqual(providerKey, extensionKey);
    assert.throws(() => openEncryptedJson(extensionKey, readFileSync(providerPath, "utf8")));
    assert.throws(() => openEncryptedJson(providerKey, readFileSync(extensionPath, "utf8")));
  } finally {
    storageKey.fill(0);
    providerKey.fill(0);
    extensionKey.fill(0);
  }
});

test("legacy stores migrate together, retain rollback data, and remain usable after token rotation", (t) => {
  const root = fixture(t);
  legacy(root);
  const originals = legacyBytes(root);
  const migrated = openStores(root, OLD_TOKEN);
  assertLegacyValues(migrated);
  assert.deepEqual(legacyBytes(root), originals);
  const pointer = readFileSync(join(root, "credential-stores.json"), "utf8");
  closeStores(migrated);

  const restarted = openStores(root, OTHER_TOKEN);
  assertLegacyValues(restarted);
  const updated = [{ ...PROVIDERS[0], secret: "new-provider-secret" }];
  restarted.provider.save(updated);
  restarted.extension.put({ extensionId: "ext_abcdefgh", name: "API_KEY", kind: "env", value: "new-extension-secret" });
  closeStores(restarted);
  const again = openStores(root);
  assert.deepEqual(again.provider.load(), updated);
  assert.equal(again.extension.reveal(CREDENTIALS[0].ref).value, "new-extension-secret");
  assert.equal(readFileSync(join(root, "credential-stores.json"), "utf8"), pointer);
  assert.deepEqual(legacyBytes(root), originals);
  closeStores(again);
});

for (const present of ["provider", "extension"] as const) {
  test("migration supports a legacy " + present + " store without the other store", (t) => {
    const root = fixture(t);
    legacy(root, [present]);
    const originals = legacyBytes(root);
    const stores = openStores(root, OLD_TOKEN);
    assert.deepEqual(stores.provider.load(), present === "provider" ? PROVIDERS : []);
    assert.equal(stores.extension.list().length, present === "extension" ? 1 : 0);
    assert.deepEqual(legacyBytes(root), originals);
    closeStores(stores);
  });
}

for (const token of [undefined, "wrong-runner-token-for-migration"] as const) {
  test("missing or wrong legacy token fails before any writes: " + String(token !== undefined), (t) => {
    const root = fixture(t);
    legacy(root);
    const names = readdirSync(root).sort();
    const originals = legacyBytes(root);
    assert.throws(() => prepareCredentialStores({ stateDirectory: root, legacyToken: token }), /previous Runner token|locked or corrupt/i);
    assert.deepEqual(readdirSync(root).sort(), names);
    assert.deepEqual(legacyBytes(root), originals);
  });
}

test("a corrupt legacy envelope fails closed without creating a key or journal", (t) => {
  const root = fixture(t);
  legacy(root);
  writeFileSync(join(root, "extension-credentials.enc"), "{\"version\":1,\"tag\":\"bad\"}");
  const names = readdirSync(root).sort();
  const originals = legacyBytes(root);
  assert.throws(() => prepareCredentialStores({ stateDirectory: root, legacyToken: OLD_TOKEN }), /locked or corrupt/i);
  assert.deepEqual(readdirSync(root).sort(), names);
  assert.deepEqual(legacyBytes(root), originals);
});

test("a corrupt committed envelope, missing key, or missing pointer cannot replace credentials", (t) => {
  const root = fixture(t);
  legacy(root);
  const originals = legacyBytes(root);
  const stores = openStores(root, OLD_TOKEN);
  const providerPath = stores.prepared.providerPath;
  closeStores(stores);
  const providerBytes = readFileSync(providerPath);
  const envelope = JSON.parse(providerBytes.toString("utf8")) as { tag: string };
  envelope.tag = Buffer.from(envelope.tag, "base64").subarray(0, 4).toString("base64");
  writeFileSync(providerPath, JSON.stringify(envelope));
  const corrupt = readFileSync(providerPath);
  assert.throws(() => openStores(root, OTHER_TOKEN), /corrupt|decrypt/i);
  assert.deepEqual(readFileSync(providerPath), corrupt);
  assert.deepEqual(legacyBytes(root), originals);
  writeFileSync(providerPath, providerBytes);

  const keyPath = join(root, "storage-key");
  const key = readFileSync(keyPath);
  rmSync(keyPath);
  assert.throws(() => openStores(root), /ENOENT|storage key/i);
  assert.equal(existsSync(keyPath), false);
  writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
  const pointerPath = join(root, "credential-stores.json");
  const pointer = readFileSync(pointerPath);
  rmSync(pointerPath);
  assert.throws(() => openStores(root, OLD_TOKEN), /metadata is missing/i);
  assert.equal(existsSync(pointerPath), false);
  assert.deepEqual(readFileSync(providerPath), providerBytes);
  assert.deepEqual(legacyBytes(root), originals);
  writeFileSync(pointerPath, pointer, { flag: "wx", mode: 0o600 });
});

for (const step of CREDENTIAL_MIGRATION_STEPS) {
  test("crash recovery preserves both stores after " + step, (t) => {
    const root = fixture(t);
    legacy(root);
    const originals = legacyBytes(root);
    assert.throws(() => prepareCredentialStores({
      stateDirectory: root,
      legacyToken: OLD_TOKEN,
      onStep: (current) => { if (current === step) throw new Error("simulated crash"); },
    }), /simulated crash/);
    assert.deepEqual(legacyBytes(root), originals);
    const token = ["pointer-committed", "commit-verified", "journal-removed"].includes(step) ? OTHER_TOKEN : OLD_TOKEN;
    const recovered = openStores(root, token);
    assertLegacyValues(recovered);
    assert.equal(existsSync(join(root, "credential-migration.json")), false);
    closeStores(recovered);
    const rerun = openStores(root, OTHER_TOKEN);
    assertLegacyValues(rerun);
    assert.deepEqual(legacyBytes(root), originals);
    closeStores(rerun);
  });
}

test("a concurrent launcher cannot enter an active credential migration", (t) => {
  const root = fixture(t);
  legacy(root);
  let attempted = false;
  const prepared = prepareCredentialStores({
    stateDirectory: root,
    legacyToken: OLD_TOKEN,
    onStep: (step) => {
      if (step !== "journal-created") return;
      attempted = true;
      assert.throws(() => prepareCredentialStores({ stateDirectory: root, legacyToken: OLD_TOKEN }), /another Runner/i);
    },
  });
  prepared.providerKey.fill(0);
  prepared.extensionKey.fill(0);
  assert.equal(attempted, true);
  const stores = openStores(root, OTHER_TOKEN);
  assertLegacyValues(stores);
  closeStores(stores);
});

test("changes to rollback files block reads and writes until explicitly reconciled", (t) => {
  const root = fixture(t);
  legacy(root);
  const original = readFileSync(join(root, "provider-configs.enc"));
  const stores = openStores(root, OLD_TOKEN);
  const current = readFileSync(stores.prepared.providerPath);
  writeEncryptedJson(join(root, "provider-configs.enc"), Buffer.from(OLD_TOKEN), [{ ...PROVIDERS[0], secret: "older-runner-update" }]);
  const changed = readFileSync(join(root, "provider-configs.enc"));
  assert.throws(() => stores.provider.load(), /rollback files changed/i);
  assert.throws(() => stores.provider.save(PROVIDERS), /rollback files changed/i);
  assert.throws(() => stores.extension.list(), /rollback files changed/i);
  assert.throws(() => openStores(root, OTHER_TOKEN), /rollback files changed/i);
  assert.deepEqual(readFileSync(join(root, "provider-configs.enc")), changed);
  assert.deepEqual(readFileSync(stores.prepared.providerPath), current);
  writeFileSync(join(root, "provider-configs.enc"), original);
  assertLegacyValues(stores);
  closeStores(stores);
});

test("the file key is protected, exclusively published, and never overwritten", (t) => {
  const root = fixture(t);
  const provider = new FileStorageKeyProvider(root);
  const key = provider.getKey({ createIfMissing: true });
  assert.equal(key.length, 32);
  if (process.platform !== "win32") assert.equal(statSync(provider.path).mode & 0o777, 0o600);
  assert.throws(() => {
    const fd = openSync(provider.path, "wx", 0o600);
    closeSync(fd);
  }, /EEXIST/);
  const next = provider.getKey({ createIfMissing: true });
  assert.deepEqual(next, key);
  key.fill(0);
  next.fill(0);

  const other = join(root, "existing");
  mkdirSync(other);
  const existing = new FileStorageKeyProvider(other);
  const corrupt = randomBytes(7);
  writeFileSync(existing.path, corrupt, { flag: "wx", mode: 0o600 });
  assert.throws(() => existing.getKey({ createIfMissing: true }), /corrupt/i);
  assert.deepEqual(readFileSync(existing.path), corrupt);
});

test("journal and encrypted state do not contain plaintext credentials or the storage key", (t) => {
  const root = fixture(t);
  legacy(root);
  assert.throws(() => prepareCredentialStores({
    stateDirectory: root,
    legacyToken: OLD_TOKEN,
    onStep: (step) => { if (step === "staging-verified") throw new Error("stop before commit"); },
  }), /stop before commit/);
  const key = readFileSync(join(root, "storage-key"));
  function inspect(directory: string): void {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) inspect(path);
      else if (path !== join(root, "storage-key")) {
        const bytes = readFileSync(path);
        for (const secret of [OLD_TOKEN, PROVIDERS[0].secret, CREDENTIALS[0].value]) {
          assert.equal(bytes.includes(Buffer.from(secret)), false, path);
        }
        assert.equal(bytes.includes(key), false, path);
      }
    }
  }
  inspect(root);
  key.fill(0);
});
