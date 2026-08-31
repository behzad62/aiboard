import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { cleanProvenB2Residue, inventoryB2Residue, registerCurrentB2TestRoot } from "./support/b2-residue.js";

test("the exact B2 residue inventory removes only a closed-prefix proven-absent root", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-residue-"));
  const nearMiss = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-near-miss-"));
  try {
    registerCurrentB2TestRoot(root);
    const inventory = inventoryB2Residue();
    assert.ok(inventory.some((entry) => entry.path === root));
    assert.ok(!inventory.some((entry) => entry.path === nearMiss));
    assert.deepEqual(cleanProvenB2Residue(inventory.filter((entry) => entry.path === root)), [root]);
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(nearMiss), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(nearMiss, { recursive: true, force: true });
  }
});

test("an empty exact fence coordination database is removed but corrupt lock evidence is preserved", () => {
  const safe = join(tmpdir(), `aiboard-windows-residue-${process.pid}.fence.lock`);
  const corrupt = join(tmpdir(), `aiboard-windows-residue-corrupt-${process.pid}.fence.lock`);
  try {
    const database = new DatabaseSync(safe);
    database.exec(`
      CREATE TABLE owned_fence_protocol(version INTEGER NOT NULL, retired INTEGER NOT NULL);
      CREATE TABLE owned_fence_acquisition(acquisition_id TEXT PRIMARY KEY, holder_pid INTEGER, holder_birth TEXT);
      CREATE TABLE owned_fence_holder(lock_key TEXT PRIMARY KEY, acquisition_id TEXT, holder_pid INTEGER, holder_birth TEXT);
      CREATE TRIGGER owned_fence_acquisition_immutable BEFORE UPDATE ON owned_fence_acquisition BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      INSERT INTO owned_fence_protocol(version, retired) VALUES (1, 0);
    `);
    database.close();
    writeFileSync(corrupt, "not coordination evidence");
    const inventory = inventoryB2Residue();
    const candidates = inventory.filter((entry) => entry.path === safe || entry.path === corrupt);
    assert.deepEqual(cleanProvenB2Residue(candidates), [safe]);
    assert.equal(existsSync(safe), false);
    assert.equal(existsSync(corrupt), true);
  } finally {
    rmSync(safe, { force: true });
    rmSync(corrupt, { force: true });
  }
});

test("malformed durable identity preserves exact B2 residue", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-uncertain-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: 42, supervisorPid: process.pid }));
    const entry = inventoryB2Residue().find((candidate) => candidate.path === root);
    assert.ok(entry);
    assert.deepEqual(cleanProvenB2Residue([entry]), []);
    assert.equal(existsSync(root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the production-default portable root is never classified as disposable fixture residue", () => {
  const root = join(tmpdir(), "aiboard-portable-processes");
  const entry = inventoryB2Residue().find((candidate) => candidate.path === root);
  assert.equal(entry, undefined);
  if (existsSync(root)) assert.equal(existsSync(root), true);
});

test("detection never grants deletion authority to unrelated empty malformed unregistered linked or live roots", (t) => {
  if (process.platform !== "win32") { t.skip("The live-owner refusal uses exact Windows birth inventory."); return; }
  const unrelated = mkdtempSync(join(tmpdir(), "aiboard-windows-unrelated-review-"));
  const empty = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-duplex-"));
  const malformed = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-duplex-"));
  const unregistered = mkdtempSync(join(tmpdir(), "aiboard-windows-unregistered-review-"));
  const live = mkdtempSync(join(tmpdir(), "aiboard-windows-semantic-duplex-"));
  const linkTarget = mkdtempSync(join(tmpdir(), "aiboard-review-link-target-"));
  const link = join(tmpdir(), `aiboard-windows-semantic-duplex-link-${process.pid}`);
  try {
    writeFileSync(join(unrelated, "keep.txt"), "unrelated");
    writeFileSync(join(malformed, "state.json"), "{not-json");
    writeFileSync(join(unregistered, "state.json"), JSON.stringify({
      protocol: "aiboard-portable-process/v1", nonce: "unregistered", supervisorPid: 2_147_483_646,
      launchEffect: "not_started", rootProcess: null, knownProcesses: [],
    }));
    writeFileSync(join(live, "state.json"), JSON.stringify({
      protocol: "aiboard-portable-process/v1", nonce: "live-owner", supervisorPid: process.pid,
      supervisorBirth: windowsBirth(process.pid), launchEffect: "not_started", rootProcess: null, knownProcesses: [],
    }));
    symlinkSync(linkTarget, link, "junction");
    const inventory = inventoryB2Residue();
    assert.ok(inventory.some((entry) => entry.path === unrelated), "broad-prefix detection may report the unrelated review root");
    const candidates = inventory.filter((entry) => [unrelated, empty, malformed, unregistered, live, link].includes(entry.path));
    assert.deepEqual(cleanProvenB2Residue(candidates), []);
    for (const path of [unrelated, empty, malformed, unregistered, live, link]) assert.equal(existsSync(path), true, path);
    assert.equal(existsSync(join(unrelated, "keep.txt")), true);
  } finally {
    rmSync(link, { recursive: true, force: true });
    for (const path of [unrelated, empty, malformed, unregistered, live, linkTarget]) rmSync(path, { recursive: true, force: true });
  }
});

test("an exact-live enumerated PID born before the recorded root is proven unrelated", (t) => {
  if (process.platform !== "win32") { t.skip("Temporal CIM proof fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-temporal-enumeration-"));
  const currentBirth = windowsBirth(process.pid);
  const rootBirth = new Date(Date.parse(currentBirth) + 1_000).toISOString();
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({
      protocol: "aiboard-portable-process/v1", nonce: "temporal-enumeration", supervisorPid: 2_147_483_646, updatedAt: new Date().toISOString(),
      launchEffect: "started", rootProcess: { pid: 2_147_483_645, birth: rootBirth },
      knownProcesses: [{ pid: process.pid, birth: currentBirth }],
    }));
    const entry = inventoryB2Residue().find((candidate) => candidate.path === root); assert.ok(entry);
    assert.deepEqual(cleanProvenB2Residue([entry]), [root]);
    assert.equal(existsSync(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a reused birthless PID born after the durable state update is proven unrelated", (t) => {
  if (process.platform !== "win32") { t.skip("Temporal CIM proof fixture requires Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-windows-temporal-reuse-"));
  const currentBirth = windowsBirth(process.pid);
  const recordedAt = new Date(Date.parse(currentBirth) - 1_000).toISOString();
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({
      protocol: "aiboard-portable-process/v1", nonce: "temporal-reuse", supervisorPid: process.pid, updatedAt: recordedAt,
      launchEffect: "unknown", rootProcess: null, knownProcesses: [],
    }));
    const entry = inventoryB2Residue().find((candidate) => candidate.path === root); assert.ok(entry);
    assert.deepEqual(cleanProvenB2Residue([entry]), [root]);
    assert.equal(existsSync(root), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function windowsBirth(pid: number): string {
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop';(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
  ], { encoding: "utf8", windowsHide: true, timeout: 2_000 }).trim();
}
