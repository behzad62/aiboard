import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectGenericPosixProcessBirth, retryRetiredOwnedFenceCleanup, withOwnedFenceLock, withOwnedFenceLockSync } from "../src/owned-fence-lock.mjs";

const fixture = fileURLToPath(new URL("./fixtures/owned-fence-lock-holder.mjs", import.meta.url));

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
