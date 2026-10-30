import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireRegistryLock } from "../src/extension-registry.js";

/** A pid that existed and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  return child.pid;
}

function lockHome(t: test.TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "aiboard-registry-lock-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return join(home, ".lock");
}

function plantLock(lock: string, entry: string, pid: number): string {
  mkdirSync(lock, { recursive: true });
  const marker = join(lock, entry);
  writeFileSync(marker, `${pid}\n`);
  return marker;
}

test("a stale lock whose owner exited is reclaimed, in both marker formats", async (t) => {
  for (const entry of [`owner-${randomUUID()}`, "owner"]) {
    const lock = lockHome(t);
    plantLock(lock, entry, deadPid());
    const release = await acquireRegistryLock(lock, { staleMs: 0, waitMs: 2_000 });
    assert.equal(existsSync(join(lock, entry)), false);
    await release();
    assert.equal(existsSync(lock), false);
  }
});

test("a live owner's lock is never reclaimed, however old", async (t) => {
  const lock = lockHome(t);
  const marker = plantLock(lock, `owner-${randomUUID()}`, process.pid);
  await assert.rejects(acquireRegistryLock(lock, { staleMs: 0, waitMs: 100 }), /registry_busy|locked by another Runner/);
  assert.equal(existsSync(marker), true);
});

test("a reclaimer that loses the race never removes the successor's lock", async (t) => {
  const lock = lockHome(t);
  plantLock(lock, `owner-${randomUUID()}`, deadPid());
  let successor = "";
  let raced = false;
  const attempt = acquireRegistryLock(lock, {
    staleMs: 0, waitMs: 200,
    // Another Runner reclaims the same stale lock first and takes it.
    beforeReclaim: () => {
      if (raced) return;
      raced = true;
      rmSync(lock, { recursive: true, force: true });
      successor = plantLock(lock, `owner-${randomUUID()}`, process.pid);
    },
  });
  await assert.rejects(attempt, /registry_busy|locked by another Runner/);
  assert.ok(raced);
  assert.equal(existsSync(successor), true, "the successor's lock must survive the losing reclaimer");
});

test("release after the lock was reclaimed leaves the successor's lock alone", async (t) => {
  const lock = lockHome(t);
  const release = await acquireRegistryLock(lock, { waitMs: 200 });
  // This owner's lock is taken away (e.g. judged stale) and a successor now holds it.
  rmSync(lock, { recursive: true, force: true });
  const successor = plantLock(lock, `owner-${randomUUID()}`, process.pid);
  await release();
  assert.equal(existsSync(successor), true);
});

test("concurrent acquirers hold the lock one at a time", async (t) => {
  const lock = lockHome(t);
  let holders = 0;
  let maxHolders = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    const release = await acquireRegistryLock(lock, { waitMs: 10_000 });
    holders += 1; maxHolders = Math.max(maxHolders, holders);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    holders -= 1;
    await release();
  }));
  assert.equal(maxHolders, 1);
  assert.equal(existsSync(lock), false);
});
