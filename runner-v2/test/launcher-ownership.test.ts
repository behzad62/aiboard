import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearStaleInstance, controlKeyHash, type LauncherIdentity, type LauncherInstance } from "../src/launcher-instance.js";
import { removePeerInstance, type PeerInstance } from "../src/launcher.js";

const identity: LauncherIdentity = { projectPath: "/project", projectKey: "/project", owner: "owner" };
const instance = (id: string, key: Buffer): LauncherInstance => ({
  ...identity, schemaVersion: 1, pid: 1, startedAt: 1, port: 1234, controlPort: 1235,
  instanceId: id.repeat(32), version: "1", controlKeyHash: controlKeyHash(key),
});

// clearStaleInstance runs only while the launcher holds the project's lifetime and discovery locks, so no Runner owns
// the state. Leftovers must be cleared, or the project could never start again after a crash or an upgrade.
test("stale launcher cleanup clears a key orphaned before its record was published", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-owner-"));
  try {
    await writeFile(join(root, "launcher-control.key"), Buffer.alloc(32, 1), { mode: 0o600 });
    await clearStaleInstance(root, identity);
    assert.equal(existsSync(join(root, "launcher-control.key")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale launcher cleanup clears a pre-hash record and its key from an older launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-owner-"));
  try {
    const key = Buffer.alloc(32, 1);
    const { controlKeyHash: _omitted, ...legacy } = instance("a", key);
    await writeFile(join(root, "launcher-instance.json"), JSON.stringify(legacy), { mode: 0o600 });
    await writeFile(join(root, "launcher-control.key"), key, { mode: 0o600 });
    await clearStaleInstance(root, identity);
    assert.equal(existsSync(join(root, "launcher-control.key")), false);
    assert.equal(existsSync(join(root, "launcher-instance.json")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stale launcher cleanup clears a key and record left by two interrupted launches", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-owner-"));
  try {
    await writeFile(join(root, "launcher-instance.json"), JSON.stringify(instance("a", Buffer.alloc(32, 1))), { mode: 0o600 });
    await writeFile(join(root, "launcher-control.key"), Buffer.alloc(32, 2), { mode: 0o600 });
    await clearStaleInstance(root, identity);
    assert.equal(existsSync(join(root, "launcher-control.key")), false);
    assert.equal(existsSync(join(root, "launcher-instance.json")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("old peer exit leaves the replacement peer record and key", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-owner-"));
  try {
    const old: PeerInstance = { ...instance("a", Buffer.alloc(32, 1)), kind: "accounts" };
    const replacementKey = Buffer.alloc(32, 2);
    const replacement: PeerInstance = { ...instance("b", replacementKey), kind: "accounts" };
    await writeFile(join(root, "launcher-peers.json"), JSON.stringify({ schemaVersion: 1, peers: [replacement] }), { mode: 0o600 });
    await writeFile(join(root, "launcher-control-accounts.key"), replacementKey, { mode: 0o600 });
    await removePeerInstance(root, old, identity);
    assert.deepEqual(await readFile(join(root, "launcher-control-accounts.key")), replacementKey);
    assert.equal(JSON.parse(await readFile(join(root, "launcher-peers.json"), "utf8")).peers[0].instanceId, replacement.instanceId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("peer exit cleanup refuses a recorded key that changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-owner-"));
  try {
    const recorded: PeerInstance = { ...instance("a", Buffer.alloc(32, 1)), kind: "accounts" };
    const changed = Buffer.alloc(32, 2);
    await writeFile(join(root, "launcher-peers.json"), JSON.stringify({ schemaVersion: 1, peers: [recorded] }), { mode: 0o600 });
    await writeFile(join(root, "launcher-control-accounts.key"), changed, { mode: 0o600 });
    await assert.rejects(removePeerInstance(root, recorded, identity), /instance_unverified/);
    assert.deepEqual(await readFile(join(root, "launcher-control-accounts.key")), changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});
