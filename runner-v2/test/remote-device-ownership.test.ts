import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import fsSync, { type PathLike } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import { RemoteDeviceStore } from "../src/remote-device-store.js";

function encodedKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
}

test("device initialization adopts an orphan key and its identity verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "device-owner-"));
  try {
    const key = encodedKey();
    await writeFile(join(root, "remote-device-key"), key);
    const store = new RemoteDeviceStore(root);
    const identity = store.ensure();
    assert.equal(await readFile(join(root, "remote-device-key"), "utf8"), key);
    const message = Buffer.from("device ownership");
    assert.equal(verify(null, message, store.publicKeyObject(), store.sign(message)), true);
    assert.equal(new RemoteDeviceStore(root).ensure().publicKey, identity.publicKey);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed device identity publication preserves an orphan key", async () => {
  const root = await mkdtemp(join(tmpdir(), "device-owner-"));
  const key = encodedKey();
  try {
    await writeFile(join(root, "remote-device-key"), key);
    const rename = fsSync.renameSync;
    const stub = mock.method(fsSync, "renameSync", (from: PathLike, to: PathLike) => {
      if (String(to) === join(root, "remote-device.json")) throw new Error("identity publication failed");
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => new RemoteDeviceStore(root).ensure(), /identity publication failed/); }
    finally { stub.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(await readFile(join(root, "remote-device-key"), "utf8"), key);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("first device initialization respects the owner fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "device-owner-"));
  try {
    const first = new RemoteDeviceStore(root);
    const second = new RemoteDeviceStore(root);
    const release = first.acquireOwnerLock();
    assert.ok(release);
    try {
      assert.throws(() => second.ensure(), /remote_active/);
      const identity = first.ensure();
      assert.deepEqual(second.ensure(), identity);
      const message = Buffer.from("shared identity");
      assert.equal(verify(null, message, second.publicKeyObject(), second.sign(message)), true);
    } finally { release(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("device owner release leaves a replacement owner record intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "device-owner-"));
  try {
    const store = new RemoteDeviceStore(root);
    const release = store.acquireOwnerLock("first");
    assert.ok(release);
    const replacement = JSON.stringify({ projectPath: "second", pid: 123, ownerToken: "different" });
    await writeFile(join(root, "remote-device-owner.json"), replacement);
    release();
    assert.equal(await readFile(join(root, "remote-device-owner.json"), "utf8"), replacement);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("device rotation preserves a key that no longer matches the old record", async () => {
  const root = await mkdtemp(join(tmpdir(), "device-owner-"));
  try {
    const store = new RemoteDeviceStore(root);
    store.ensure();
    store.revoke();
    const replacement = encodedKey();
    await writeFile(join(root, "remote-device-key"), replacement);
    const rotated = store.rotateIdentity();
    assert.ok(rotated.keyFile);
    assert.equal(await readFile(join(root, "remote-device-key"), "utf8"), replacement);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("device rotation refuses a session belonging to another account", async () => {
  const root = await mkdtemp(join(tmpdir(), "device-owner-"));
  try {
    const store = new RemoteDeviceStore(root);
    store.ensure("first");
    store.revoke();
    store.saveSession({ accountId: "second", clientId: "client", scope: "scope", issuedAt: "2026-01-01T00:00:00Z", relayKeys: [], authorizedScopes: [] });
    const session = await readFile(join(root, "remote-device-session.json"), "utf8");
    assert.throws(() => store.rotateIdentity(), /does not belong/);
    assert.equal(await readFile(join(root, "remote-device-session.json"), "utf8"), session);
    assert.equal(store.load()!.accountId, "first");
  } finally { await rm(root, { recursive: true, force: true }); }
});
