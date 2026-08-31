import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs, { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectGenericPosixProcessBirth, recoverRevokedOwnedFenceLock, retryRetiredOwnedFenceCleanup, withOwnedFenceLock, withOwnedFenceLockSync } from "../src/owned-fence-lock.mjs";

const fixture = fileURLToPath(new URL("./fixtures/owned-fence-lock-holder.mjs", import.meta.url));
const contendedInitializerFixture = fileURLToPath(new URL("./fixtures/owned-fence-lock-contended-initializer.mjs", import.meta.url));

test("generic POSIX holder inspection distinguishes exact absence from uncertain process-tool outcomes", () => {
  const cases = [
    { name: "ESRCH absent", existence: ["absent"], births: [], expected: { state: "absent" } },
    { name: "exact live", existence: ["live", "live", "live"], births: ["birth-a", "birth-a"], expected: { state: "same", fingerprint: "birth-a" } },
    { name: "birth mismatch", existence: ["live", "live", "live"], births: ["birth-b", "birth-b"], expected: { state: "same", fingerprint: "birth-b" } },
    { name: "EPERM", existence: ["permission"], births: [], expected: { state: "unknown" } },
    { name: "timeout", existence: ["live", "live"], births: ["timeout"], expected: { state: "unknown" } },
    { name: "malformed", existence: ["live", "live"], births: ["malformed"], expected: { state: "unknown" } },
    { name: "generic failure", existence: ["live", "live"], births: ["failure"], expected: { state: "unknown" } },
    { name: "exit after second birth inspection failure", existence: ["live", "live", "absent"], births: ["birth-a", "failure"], expected: { state: "absent" } },
    { name: "unresolved exit/reuse race", existence: ["live", "live", "live"], births: ["birth-a", "birth-b"], expected: { state: "unknown" } },
  ] as const;
  for (const fixtureCase of cases) {
    let existenceIndex = 0;
    let birthIndex = 0;
    const result = inspectGenericPosixProcessBirth(4242, {
      probeExistence: () => fixtureCase.existence[Math.min(existenceIndex++, fixtureCase.existence.length - 1)]!,
      inspectBirth: () => {
        const value = fixtureCase.births[Math.min(birthIndex++, fixtureCase.births.length - 1)];
        if (value === "birth-a" || value === "birth-b") return { outcome: "ok" as const, fingerprint: value };
        return { outcome: (value ?? "failure") as "timeout" | "malformed" | "failure" };
      },
    });
    assert.deepEqual(result, fixtureCase.expected, fixtureCase.name);
  }
});

test("a single-link legacy coordination database migrates to immutable exact-path authority", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-legacy-authority-"));
  const lockPath = join(root, "effect.sqlite");
  try {
    const legacy = new DatabaseSync(lockPath);
    legacy.exec(`
      CREATE TABLE owned_fence_protocol(version INTEGER NOT NULL, retired INTEGER NOT NULL CHECK(retired IN (0, 1)));
      CREATE TABLE owned_fence_acquisition(acquisition_id TEXT PRIMARY KEY NOT NULL, holder_pid INTEGER NOT NULL, holder_birth TEXT NOT NULL);
      CREATE TABLE owned_fence_holder(lock_key TEXT PRIMARY KEY NOT NULL, acquisition_id TEXT UNIQUE NOT NULL, holder_pid INTEGER NOT NULL, holder_birth TEXT NOT NULL);
      CREATE TRIGGER owned_fence_acquisition_immutable BEFORE UPDATE ON owned_fence_acquisition BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      INSERT INTO owned_fence_protocol(version, retired) VALUES (1, 0);
    `);
    legacy.close();
    let effects = 0;
    withOwnedFenceLockSync(lockPath, () => { effects += 1; });
    assert.equal(effects, 1);
    const migrated = new DatabaseSync(lockPath, { readOnly: true });
    assert.deepEqual(migrated.prepare("PRAGMA table_info(owned_fence_protocol)").all().map((row) => row.name),
      ["version", "retired", "authority_id"]);
    const protocol = migrated.prepare("SELECT authority_id AS authorityId FROM owned_fence_protocol").get();
    assert.match(String(protocol?.authorityId), /^[0-9a-f]{64}$/);
    const triggers = new Set(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all().map((row) => row.name));
    assert.equal(triggers.has("owned_fence_authority_immutable"), true);
    assert.equal(triggers.has("owned_fence_authority_delete_immutable"), true);
    migrated.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-empty legacy coordination remains unbound when its original hard-link name disappears", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-legacy-alias-"));
  const targetPath = join(root, "target.sqlite");
  const requestedPath = join(root, "requested.sqlite");
  try {
    const legacy = new DatabaseSync(targetPath);
    legacy.exec(`
      CREATE TABLE owned_fence_protocol(version INTEGER NOT NULL, retired INTEGER NOT NULL CHECK(retired IN (0, 1)));
      CREATE TABLE owned_fence_acquisition(acquisition_id TEXT PRIMARY KEY NOT NULL, holder_pid INTEGER NOT NULL, holder_birth TEXT NOT NULL);
      CREATE TABLE owned_fence_holder(lock_key TEXT PRIMARY KEY NOT NULL, acquisition_id TEXT UNIQUE NOT NULL, holder_pid INTEGER NOT NULL, holder_birth TEXT NOT NULL);
      CREATE TRIGGER owned_fence_acquisition_immutable BEFORE UPDATE ON owned_fence_acquisition BEGIN SELECT RAISE(ABORT, 'immutable'); END;
      INSERT INTO owned_fence_protocol(version, retired) VALUES (1, 0);
      INSERT INTO owned_fence_acquisition(acquisition_id, holder_pid, holder_birth) VALUES ('11111111-1111-4111-8111-111111111111', ${process.pid}, 'unbound-target-birth');
      INSERT INTO owned_fence_holder(lock_key, acquisition_id, holder_pid, holder_birth) VALUES ('owned', '11111111-1111-4111-8111-111111111111', ${process.pid}, 'unbound-target-birth');
    `);
    legacy.close();
    linkSync(targetPath, requestedPath);
    rmSync(targetPath);
    let effects = 0;
    assert.throws(() => withOwnedFenceLockSync(requestedPath, () => { effects += 1; }), /legacy|unbound|authority|ownership/i);
    assert.equal(effects, 0);
    const preserved = new DatabaseSync(requestedPath, { readOnly: true });
    assert.deepEqual(preserved.prepare("PRAGMA table_info(owned_fence_protocol)").all().map((row) => row.name),
      ["version", "retired"]);
    assert.equal(preserved.prepare("SELECT retired FROM owned_fence_protocol").get()!.retired, 0);
    assert.equal(Number(preserved.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()!.count), 1);
    preserved.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a crashed real holder leaves exact identity and a higher contender reclaims it once", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-crash-"));
  const lockPath = join(root, "effect.sqlite");
  const holder = startHolder(lockPath, undefined, 2_000, 60_000);
  try {
    const acquired = await nextMessage(holder);
    assert.equal(acquired.state, "acquired");
    const durable = readDurableHolder(lockPath);
    assert.equal(durable.holderPid, holder.pid);
    assert.match(durable.holderBirth, /\S/);
    assert.match(durable.acquisitionId, /^[0-9a-f-]{36}$/i);
    holder.kill("SIGKILL");
    await exited(holder);

    let effects = 0;
    withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { deadlineMs: 2_000 });
    assert.equal(effects, 1);
  } finally {
    await stop(holder);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("an exact live holder is never stolen through the full contention window", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-live-"));
  const lockPath = join(root, "effect.sqlite");
  const holder = startHolder(lockPath, undefined, 2_000, 60_000);
  try {
    assert.equal((await nextMessage(holder)).state, "acquired");
    let effects = 0;
    const startedAt = Date.now();
    assert.throws(
      () => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { deadlineMs: 150 }),
      /live holder|unavailable/i,
    );
    assert.ok(Date.now() - startedAt >= 100, "live contention must remain protected through the bounded wait");
    assert.equal(effects, 0);
    assert.equal(readDurableHolder(lockPath).holderPid, holder.pid);
  } finally {
    await stop(holder);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("concurrent reclaimers elect one authoritative stale-lock effect", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-election-"));
  const lockPath = join(root, "effect.sqlite");
  const effectPath = join(root, "effects.txt");
  const stale = startHolder(lockPath, undefined, 2_000, 60_000);
  let first: ChildProcess | undefined;
  let second: ChildProcess | undefined;
  try {
    assert.equal((await nextMessage(stale)).state, "acquired");
    stale.kill("SIGKILL");
    await exited(stale);
    first = startHolder(lockPath, effectPath, 200, 500, "contend");
    second = startHolder(lockPath, effectPath, 200, 500, "contend");
    const [firstResult, secondResult] = await Promise.all([nextMessage(first), nextMessage(second)]);
    assert.deepEqual([firstResult.state, secondResult.state].sort(), ["acquired", "refused"]);
    assert.equal(readFileSync(effectPath, "utf8").trim().split(/\r?\n/).filter(Boolean).length, 1);
  } finally {
    await stop(stale);
    if (first) await stop(first);
    if (second) await stop(second);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("corrupt or uncertain holder evidence fails closed without an effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-corrupt-"));
  const corruptPath = join(root, "corrupt.sqlite");
  const partialPath = join(root, "partial.sqlite");
  const uncertainPath = join(root, "uncertain.sqlite");
  const holder = startHolder(uncertainPath, undefined, 2_000, 60_000);
  try {
    writeFileSync(corruptPath, "not a sqlite lock protocol");
    assert.throws(() => withOwnedFenceLockSync(corruptPath, () => assert.fail("corrupt lock performed effect")), /unavailable|invalid|sqlite/i);
    writeFileSync(partialPath, "");
    assert.throws(
      () => withOwnedFenceLockSync(partialPath, () => assert.fail("partial lock performed effect"), { deadlineMs: 50 }),
      /unavailable|invalid|metadata|protocol/i,
    );
    assert.equal((await nextMessage(holder)).state, "acquired");
    holder.kill("SIGKILL");
    await exited(holder);
    assert.throws(
      () => withOwnedFenceLockSync(uncertainPath, () => assert.fail("unknown holder performed effect"), {
        inspectHolder: () => "unknown",
        deadlineMs: 100,
      }),
      /inspection.*unavailable|uncertain/i,
    );
    assert.equal(existsSync(uncertainPath), true);
  } finally {
    await stop(holder);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("an exact PID with a different birth is reclaimed rather than treated as the recorded holder", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-birth-"));
  const lockPath = join(root, "effect.sqlite");
  const holder = startHolder(lockPath, undefined, 2_000, 60_000);
  try {
    assert.equal((await nextMessage(holder)).state, "acquired");
    holder.kill("SIGKILL");
    await exited(holder);
    let effects = 0;
    let inspected = 0;
    withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      inspectHolder: (pid, birth) => {
        inspected += 1;
        assert.equal(pid, holder.pid);
        assert.match(birth, /\S/);
        return "birth_mismatch";
      },
    });
    assert.equal(effects, 1);
    assert.equal(inspected, 1);
  } finally {
    await stop(holder);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("a persistent finalization failure never reports an effect as successfully committed", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-finalize-"));
  const lockPath = join(root, "effect.sqlite");
  try {
    withOwnedFenceLockSync(lockPath, () => undefined);
    const database = new DatabaseSync(lockPath);
    try { database.exec("CREATE TRIGGER refuse_holder_delete BEFORE DELETE ON owned_fence_holder BEGIN SELECT RAISE(ABORT, 'persistent finalization fault'); END;"); }
    finally { database.close(); }
    let effects = 0;
    assert.throws(
      () => withOwnedFenceLockSync(lockPath, () => { effects += 1; }),
      /finalization|unavailable|persistent/i,
    );
    assert.equal(effects, 1, "the caller must see uncertainty when the external effect ran but lock commit failed");
    assert.ok(readDurableHolder(lockPath));
    assert.throws(
      () => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { deadlineMs: 75 }),
      /live holder|unavailable/i,
    );
    assert.equal(effects, 1, "an exact live holder retained after ambiguous finalization must not be stolen");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("a replacement between claim and effect is rejected by the final acquisition identity check", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-replacement-"));
  const lockPath = join(root, "effect.sqlite");
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      afterClaim: () => {
        const database = new DatabaseSync(lockPath);
        try {
          const replacement = "00000000-0000-4000-8000-000000000001";
          database.prepare("INSERT INTO owned_fence_acquisition(acquisition_id, holder_pid, holder_birth) VALUES (?, ?, ?)").run(replacement, process.pid, "replacement-birth");
          database.prepare("UPDATE owned_fence_holder SET acquisition_id = ?, holder_pid = ?, holder_birth = ? WHERE lock_key = 'owned'").run(replacement, process.pid, "replacement-birth");
        } finally { database.close(); }
      },
    } as Parameters<typeof withOwnedFenceLockSync>[2] & { afterClaim: () => void }), /identity changed|acquisition/i);
    assert.equal(effects, 0);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("a hard link added after claim is rejected before the external effect", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-post-claim-alias-"));
  const lockPath = join(root, "effect.sqlite");
  const aliasPath = join(root, "late-alias.sqlite");
  let effects = 0;
  try {
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      afterClaim: () => linkSync(lockPath, aliasPath),
    } as Parameters<typeof withOwnedFenceLockSync>[2] & { afterClaim: () => void }), /alias|linked|coordination path/i);
    assert.equal(effects, 0);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("durable acquisition identity is immutable after it becomes authoritative", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-immutable-"));
  const lockPath = join(root, "effect.sqlite");
  try {
    withOwnedFenceLockSync(lockPath, () => undefined);
    const database = new DatabaseSync(lockPath);
    try {
      database.prepare("INSERT INTO owned_fence_acquisition(acquisition_id, holder_pid, holder_birth) VALUES (?, ?, ?)").run("00000000-0000-4000-8000-000000000002", process.pid, "immutable-birth");
      assert.throws(() => database.prepare("UPDATE owned_fence_acquisition SET holder_birth = 'mutated'").run(), /immutable|constraint|abort/i);
    } finally { database.close(); }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("retirement rejects a proposal queued before release without resurrection or database residue", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retire-race-"));
  const lockPath = join(root, "effect.sqlite");
  const effectPath = join(root, "effects.txt");
  const gatePath = join(root, "retire.go");
  const retiring = spawn(process.execPath, [fixture, "retire-gated", lockPath, effectPath, "2000", "5000", gatePath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let retiringOutput = ""; retiring.stdout?.on("data", (chunk) => { retiringOutput += chunk.toString("utf8"); }); retiring.stderr?.on("data", (chunk) => { retiringOutput += chunk.toString("utf8"); });
  let contender: ChildProcess | undefined;
  try {
    await waitForPath(`${gatePath}.claimed`);
    contender = startHolder(lockPath, effectPath, 1_000, 1, "contend");
    await waitForProposalCount(lockPath, 2);
    writeFileSync(gatePath, "go");
    await Promise.all([exited(retiring), exited(contender)]);
    assert.equal(retiring.exitCode, 0, retiringOutput);
    assert.equal(contender.exitCode, 2);
    assert.equal(readFileSync(effectPath, "utf8").trim().split(/\r?\n/).filter(Boolean).length, 1);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) assert.equal(existsSync(`${lockPath}${suffix}`), false);
  } finally {
    await stop(retiring);
    if (contender) await stop(contender);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("retirement removes its enclosing authority before stale sync async and concurrent arrivals", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-authority-retire-"));
  const lockPath = join(root, ".fence.lock");
  let effects = 0;
  await withOwnedFenceLock(lockPath, () => { effects += 1; }, {
    retireAfterEffect: true,
    retireAuthority: () => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }),
  } as Parameters<typeof withOwnedFenceLock>[2] & { retireAuthority: () => void });
  assert.equal(effects, 1);
  assert.equal(existsSync(root), false);

  assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }), /unavailable|open|authority/i);
  const late = await Promise.allSettled([
    withOwnedFenceLock(lockPath, () => { effects += 1; }),
    withOwnedFenceLock(lockPath, () => { effects += 1; }),
    withOwnedFenceLock(lockPath, () => { effects += 1; }),
  ]);
  assert.ok(late.every((result) => result.status === "rejected"));
  assert.equal(effects, 1, "no stale arrival may recreate authority or perform an effect");
  assert.equal(existsSync(root), false);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) assert.equal(existsSync(`${lockPath}${suffix}`), false);
});

test("a failed post-commit authority removal is recoverable only through the exact retired cleanup path", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retired-recovery-"));
  const lockPath = join(root, ".fence.lock");
  let effects = 0;
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => { effects += 1; }, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("injected authority removal failure"); },
    }), /authority retirement failed after its durable commit/);
    assert.equal(effects, 1);
    assert.equal(existsSync(root), true);
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }), /retired|invalid|unavailable/i);
    assert.equal(effects, 1);
    await retryRetiredOwnedFenceCleanup(lockPath, () => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
    assert.equal(existsSync(root), false);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) assert.equal(existsSync(`${lockPath}${suffix}`), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("revoked-lock recovery rejects a hard link added inside its transaction", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-revoked-alias-"));
  const lockPath = join(root, ".fence.lock");
  const aliasPath = join(root, "late-alias.lock");
  const holder = startHolder(lockPath, undefined, 2_000, 60_000);
  try {
    assert.equal((await nextMessage(holder)).state, "acquired");
    holder.kill("SIGKILL");
    await exited(holder);
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 2) linkSync(lockPath, aliasPath);
      },
    }), /alias|linked|coordination path/i);
    assert.equal(assertions, 2);
    assert.equal(existsSync(lockPath), true, "failed recovery must preserve the requested coordination path");
    assert.equal(existsSync(aliasPath), true, "failed recovery must not unlink either hard-link name");
    const database = new DatabaseSync(lockPath, { readOnly: true });
    try {
      const protocol = database.prepare("SELECT retired FROM owned_fence_protocol").get() as { retired: number };
      assert.equal(protocol.retired, 0, "the hard-link race must roll back retirement");
      assert.ok(readDurableHolder(lockPath), "the active holder evidence must remain intact");
    } finally { database.close(); }
  } finally {
    await stop(holder);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("provisional initialization never removes a foreign file that wins the missing-path race", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-init-race-"));
  const lockPath = join(root, "fence.sqlite");
  const sentinel = "foreign-preexisting-content";
  const originalOpenSync = fs.openSync;
  let injected = false;
  let authorityChecks = 0;
  try {
    fs.openSync = ((candidate, flags, mode) => {
      if (!injected && candidate === lockPath && flags === "wx") {
        writeFileSync(lockPath, sentinel);
        injected = true;
      }
      return originalOpenSync(candidate, flags, mode);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    const moduleUrl = new URL("../src/owned-fence-lock.mjs", import.meta.url);
    moduleUrl.searchParams.set("init-race", `${Date.now()}-${Math.random()}`);
    const isolated = await import(moduleUrl.href) as typeof import("../src/owned-fence-lock.mjs");
    assert.throws(() => isolated.withOwnedFenceLockSync(lockPath, () => undefined, {
      holderBirth: "review-birth",
      assertAuthority: () => { authorityChecks += 1; throw new Error("authority-refused"); },
    }), /database|metadata|unavailable/i);
    assert.equal(injected, true);
    assert.equal(authorityChecks, 0, "a foreign race winner is an existing path, never a provisional initialization");
    assert.equal(existsSync(lockPath), true, "a foreign race winner must remain present");
    assert.equal(readFileSync(lockPath, "utf8"), sentinel, "a foreign race winner must remain byte-identical");
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("provisional authority refusal preserves an in-place mutation of its reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-init-mutation-"));
  const lockPath = join(root, "fence.sqlite");
  const sentinel = "foreign-provisional-mutation-must-remain";
  try {
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => undefined, {
      holderBirth: "review-birth",
      assertAuthority: () => {
        writeFileSync(lockPath, sentinel);
        throw new Error("authority-refused-after-mutation");
      },
    }), /cleanup both failed|changed|unavailable/i);
    assert.equal(readFileSync(lockPath, "utf8"), sentinel, "mutation must revoke provisional deletion authority");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("revoked-lock recovery preserves an unowned sidecar when the main authority is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-absent-main-sidecar-"));
  const lockPath = join(root, ".fence.lock");
  const sidecarPath = `${lockPath}-wal`;
  const sentinel = "foreign-sidecar-must-remain";
  try {
    writeFileSync(sidecarPath, sentinel);
    await recoverRevokedOwnedFenceLock(lockPath, { assertRevoked: () => undefined });
    assert.equal(existsSync(lockPath), false, "absent recovery must not create a coordination database");
    assert.equal(readFileSync(sidecarPath, "utf8"), sentinel, "an absent main path cannot authorize sidecar deletion");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("physical retirement rejects a replaced captured main identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retired-replacement-"));
  const lockPath = join(root, ".fence.lock");
  const foreignMain = "foreign-main-must-remain";
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("retain retired protocol"); },
    }), /authority retirement failed after its durable commit/);
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 3) {
          rmSync(lockPath, { force: true });
          writeFileSync(lockPath, foreignMain);
        }
      },
    }), /identity|replacement|coordination path|unavailable/i);
    assert.equal(assertions, 3, "physical cleanup must reassert revocation after capturing retired authority");
    assert.equal(readFileSync(lockPath, "utf8"), foreignMain, "cleanup must preserve a replacement main path");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("physical retirement rejects an in-place main rewrite across final revocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retired-main-rewrite-"));
  const lockPath = join(root, ".fence.lock");
  const foreignMain = "foreign-main-rewrite-must-remain";
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("retain retired protocol"); },
    }), /authority retirement failed after its durable commit/);
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 3) writeFileSync(lockPath, foreignMain);
      },
    }), /changed|mutation|coordination path|unavailable/i);
    assert.equal(assertions, 3);
    assert.equal(readFileSync(lockPath, "utf8"), foreignMain, "cleanup must preserve an in-place rewritten main path");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("physical retirement rejects a linked sidecar under the captured main authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retired-linked-sidecar-"));
  const lockPath = join(root, ".fence.lock");
  const foreignPath = join(root, "foreign.bin");
  const sidecarPath = `${lockPath}-wal`;
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("retain retired protocol"); },
    }), /authority retirement failed after its durable commit/);
    writeFileSync(foreignPath, "foreign-linked-sidecar");
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 2) linkSync(foreignPath, sidecarPath);
      },
    }), /sidecar|alias|linked|unavailable/i);
    assert.equal(assertions, 2);
    assert.equal(readFileSync(foreignPath, "utf8"), "foreign-linked-sidecar");
    assert.equal(readFileSync(sidecarPath, "utf8"), "foreign-linked-sidecar");
    assert.equal(existsSync(lockPath), true, "uncertain sidecar identity must preserve the retired main authority");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("physical retirement rejects a sidecar that appears after authority capture", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retired-new-sidecar-"));
  const lockPath = join(root, ".fence.lock");
  const sidecarPath = `${lockPath}-wal`;
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("retain retired protocol"); },
    }), /authority retirement failed after its durable commit/);
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 3) writeFileSync(sidecarPath, "late-foreign-sidecar");
      },
    }), /sidecar|appeared|changed|unavailable/i);
    assert.equal(assertions, 3);
    assert.equal(readFileSync(sidecarPath, "utf8"), "late-foreign-sidecar");
    assert.equal(existsSync(lockPath), true, "a post-capture sidecar must preserve the retired main authority");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("physical retirement rejects a sidecar before final revocation can rewrite it in place", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retired-sidecar-rewrite-"));
  const lockPath = join(root, ".fence.lock");
  const sidecarPath = `${lockPath}-wal`;
  const foreignSidecar = "foreign-sidecar-rewrite-must-remain";
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("retain retired protocol"); },
    }), /authority retirement failed after its durable commit/);
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 2) writeFileSync(sidecarPath, "captured-sidecar");
        if (assertions === 3) writeFileSync(sidecarPath, foreignSidecar);
      },
    }), /sidecar|changed|mutation|unavailable/i);
    assert.equal(assertions, 2, "a remaining sidecar must block cleanup before the final external callback");
    assert.equal(readFileSync(sidecarPath, "utf8"), "captured-sidecar", "cleanup must preserve sidecar bytes without authorizing a rewrite boundary");
    assert.equal(existsSync(lockPath), true, "uncertain sidecar bytes must preserve the retired main authority");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("a sidecar made uncertain by one recovery remains uncertain on every later recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-retired-durable-uncertainty-"));
  const lockPath = join(root, ".fence.lock");
  const sidecarPath = `${lockPath}-wal`;
  const sentinel = "uncertain-sidecar-must-never-be-laundered";
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("retain retired protocol"); },
    }), /authority retirement failed after its durable commit/);
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 3) writeFileSync(sidecarPath, sentinel);
      },
    }), /sidecar|appeared|changed|unavailable/i);
    assert.equal(readFileSync(sidecarPath, "utf8"), sentinel);
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => undefined,
    }), /sidecar|uncertain|unavailable/i);
    assert.equal(readFileSync(sidecarPath, "utf8"), sentinel, "a later attempt must not promote uncertainty into deletion authority");
    assert.equal(existsSync(lockPath), true, "durable sidecar uncertainty must preserve the retired main authority");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("ordinary acquisition cannot launder a sidecar preserved by revoked recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-ordinary-laundering-"));
  const lockPath = join(root, ".fence.lock");
  const sidecarPath = `${lockPath}-wal`;
  const sentinel = Buffer.from("revoked-recovery-sidecar-must-remain-byte-identical");
  let effects = 0;
  try {
    await assert.rejects(withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => { throw new Error("retain retired protocol"); },
    }), /authority retirement failed after its durable commit/);
    let assertions = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {
      assertRevoked: () => {
        assertions += 1;
        if (assertions === 3) writeFileSync(sidecarPath, sentinel);
      },
    }), /sidecar|appeared|changed|unavailable/i);
    assert.equal(assertions, 3);
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      deadlineMs: 75,
      retryDelayMs: 5,
      holderBirth: "ordinary-laundering-test",
    }), /sidecar|retired|unavailable|invalid/i);
    assert.equal(effects, 0, "ordinary acquisition must not cross preserved recovery uncertainty");
    assert.deepEqual(readFileSync(sidecarPath), sentinel, "ordinary acquisition must preserve the uncertain sidecar bytes");
    assert.equal(existsSync(lockPath), true, "ordinary acquisition must preserve the retired main database");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("ordinary acquisition preserves an active protocol sidecar and performs no effect", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-active-sidecar-"));
  const lockPath = join(root, "active.sqlite");
  const sidecarPath = `${lockPath}-journal`;
  const sentinel = Buffer.alloc(512);
  sentinel.write("foreign-inactive-rollback-journal-must-remain-byte-identical", 64);
  let effects = 0;
  try {
    withOwnedFenceLockSync(lockPath, () => undefined, { holderBirth: "active-sidecar-creator" });
    const mainBefore = readFileSync(lockPath);
    writeFileSync(sidecarPath, sentinel);
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      deadlineMs: 75,
      retryDelayMs: 5,
      holderBirth: "active-sidecar-contender",
    }), /sidecar|unavailable|invalid|database/i);
    assert.equal(effects, 0);
    assert.deepEqual(readFileSync(sidecarPath), sentinel, "the foreign sidecar must never be consumed or removed");
    assert.deepEqual(readFileSync(lockPath), mainBefore, "a sidecar-blocked acquisition must not mutate the main database");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("ordinary acquisition rejects a foreign WAL-mode database without changing its bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-foreign-wal-"));
  const lockPath = join(root, "foreign.sqlite");
  let effects = 0;
  try {
    const foreign = new DatabaseSync(lockPath);
    try {
      foreign.exec("PRAGMA journal_mode=WAL; CREATE TABLE foreign_owner(value TEXT NOT NULL); INSERT INTO foreign_owner(value) VALUES ('sentinel'); PRAGMA wal_checkpoint(TRUNCATE);");
    } finally { foreign.close(); }
    assert.equal(existsSync(`${lockPath}-wal`), false, "closed fixture must exercise read-only preflight rather than the sidecar guard");
    assert.equal(existsSync(`${lockPath}-shm`), false, "closed fixture must exercise read-only preflight rather than the sidecar guard");
    const before = readFileSync(lockPath);
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      deadlineMs: 100,
      retryDelayMs: 5,
      holderBirth: "foreign-wal-contender",
    }), /metadata|protocol|foreign|unavailable|invalid/i);
    assert.equal(effects, 0);
    assert.deepEqual(readFileSync(lockPath), before, "rejecting foreign WAL-mode metadata must be byte-for-byte read-only");
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("ordinary acquisition revalidates an in-place rewrite after read-only preflight", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-post-preflight-rewrite-"));
  const lockPath = join(root, "active.sqlite");
  const foreignPath = join(root, "foreign.sqlite");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let protocolReads = 0;
  let injected = false;
  let effects = 0;
  try {
    withOwnedFenceLockSync(lockPath, () => undefined, { holderBirth: "post-preflight-creator" });
    const foreign = new DatabaseSync(foreignPath);
    try {
      foreign.exec("PRAGMA journal_mode=WAL; CREATE TABLE foreign_owner(value TEXT NOT NULL); INSERT INTO foreign_owner(value) VALUES ('sentinel'); PRAGMA wal_checkpoint(TRUNCATE);");
    } finally { foreign.close(); }
    const foreignBytes = readFileSync(foreignPath);

    DatabaseSync.prototype.prepare = (function prepare(this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (sql !== "SELECT version, retired, authority_id AS authorityId FROM owned_fence_protocol") return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property === "all") return () => {
            const rows = target.all();
            protocolReads += 1;
            if (protocolReads === 2) {
              writeFileSync(lockPath, foreignBytes);
              injected = true;
            }
            return rows;
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof DatabaseSync.prototype.prepare;

    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      deadlineMs: 100,
      retryDelayMs: 5,
      holderBirth: "post-preflight-contender",
    }), /changed|foreign|metadata|protocol|unavailable|invalid/i);
    assert.equal(injected, true, "the fixture must rewrite the same path after read-only validation");
    assert.equal(effects, 0);
    assert.deepEqual(readFileSync(lockPath), foreignBytes,
      "post-validation foreign bytes must be rejected before any read-write open or journal-mode change");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("a contender retains its caller deadline while an exclusive winner initializes", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-lock-contended-init-"));
  const lockPath = join(root, "contended.sqlite");
  const gatePath = join(root, "reserve.go");
  const initializer = spawn(process.execPath, [contendedInitializerFixture, lockPath, "300", gatePath], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  initializer.stderr?.on("data", (chunk) => { diagnostics += chunk.toString("utf8"); });
  let effects = 0;
  const originalOpenSync = fs.openSync;
  let injected = false;
  try {
    assert.equal((await nextMessage(initializer)).state, "armed");
    fs.openSync = ((candidate, flags, mode) => {
      if (!injected && candidate === lockPath && flags === "wx") {
        injected = true;
        writeFileSync(gatePath, "reserve");
        const reserveDeadline = Date.now() + 1_000;
        while (!existsSync(lockPath) && Date.now() < reserveDeadline)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        assert.equal(existsSync(lockPath), true, "the real winner did not reserve before the contender's exclusive create");
      }
      return originalOpenSync(candidate, flags, mode);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    const moduleUrl = new URL("../src/owned-fence-lock.mjs", import.meta.url);
    moduleUrl.searchParams.set("contended-init", `${Date.now()}-${Math.random()}`);
    const isolated = await import(moduleUrl.href) as typeof import("../src/owned-fence-lock.mjs");
    const startedAt = Date.now();
    isolated.withOwnedFenceLockSync(lockPath, () => { effects += 1; }, {
      deadlineMs: 1_500,
      retryDelayMs: 10,
      holderBirth: "contended-initializer-test",
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(injected, true, "the regression must force the real winner to win the contender's EEXIST race");
    assert.equal(effects, 1, "the contender must acquire exactly once after valid initialization completes");
    assert.ok(elapsedMs >= 200, `the contender returned before the 300ms winner could initialize (${elapsedMs}ms)`);
    assert.ok(elapsedMs < 1_500, `the contender exceeded its original caller deadline (${elapsedMs}ms)`);
    await exited(initializer);
    assert.equal(initializer.exitCode, 0, diagnostics);
  } finally {
    fs.openSync = originalOpenSync;
    syncBuiltinESMExports();
    await stop(initializer);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

function startHolder(lockPath: string, effectPath?: string, deadlineMs = 2_000, holdMs = 60_000, mode = "hold"): ChildProcess {
  return spawn(process.execPath, [fixture, mode, lockPath, effectPath ?? "", String(deadlineMs), String(holdMs)], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function nextMessage(child: ChildProcess): Promise<{ state: string; pid?: number; message?: string }> {
  return await new Promise((resolvePromise, reject) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolvePromise(JSON.parse(text.slice(0, newline))); } catch (error) { reject(error); }
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Fence holder exited before a message (${String(code)}): ${text}`)); };
    const cleanup = () => { child.stdout?.off("data", onData); child.off("error", onError); child.off("exit", onExit); };
    child.stdout?.on("data", onData); child.once("error", onError); child.once("exit", onExit);
  });
}

function readDurableHolder(path: string): { acquisitionId: string; holderPid: number; holderBirth: string } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT acquisition_id AS acquisitionId, holder_pid AS holderPid, holder_birth AS holderBirth FROM owned_fence_holder WHERE lock_key = 'owned'").get();
    assert.ok(row);
    return row as { acquisitionId: string; holderPid: number; holderBirth: string };
  } finally { database.close(); }
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited(child);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProposalCount(path: string, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        const row = database.prepare("SELECT COUNT(*) AS count FROM owned_fence_acquisition").get() as { count: number };
        if (Number(row.count) >= expected) return;
      } finally { database.close(); }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for the queued fence proposal");
}
