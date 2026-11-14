// The owned fence lock: SQLite's own file lock and nothing else (docs/plans/2026-11-14-fence-lock-design.md, FL2).
// Runs in PR CI on Windows, Linux and macOS (the portable contract job), so every test here stays fast.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  isOwnedFenceLockContention, OwnedFenceAuthorityRetirementError, OwnedFenceContentionError,
  OwnedFenceLockUnavailableError, recoverRevokedOwnedFenceLock, retiredOwnedFenceCleanupAvailable, retryRetiredOwnedFenceCleanup,
  withOwnedFenceLock, withOwnedFenceLockSync,
} from "../src/owned-fence-lock.mjs";
import * as v1 from "./fixtures/owned-fence-lock-v1.mjs";

const fixture = fileURLToPath(new URL("./fixtures/owned-fence-lock-holder.mjs", import.meta.url));
const SOURCE = readFileSync(new URL("../src/owned-fence-lock.mjs", import.meta.url), "utf8");
// The pre-FL2 module, as a Runner of that version calls it: no self-birth probe, no holder probe.
const V1_OPTIONS = { holderPid: process.pid, holderBirth: "fixture-birth", inspectHolder: () => "same" as const };

test("a claim never writes the lock file: it stays empty and unchanged, with nothing beside it, while held and after", async () => {
  await withRoot("empty", async (root) => {
    const lockPath = join(root, ".fence.lock");
    const seen: string[][] = [];
    withOwnedFenceLockSync(lockPath, () => { seen.push(readdirSync(root)); });
    const created = lstatSync(lockPath, { bigint: true });
    for (let index = 0; index < 20; index += 1) withOwnedFenceLockSync(lockPath, () => { seen.push(readdirSync(root)); });
    for (let index = 0; index < 20; index += 1) {
      await withOwnedFenceLock(lockPath, async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
        seen.push(readdirSync(root));
      });
    }
    const after = lstatSync(lockPath, { bigint: true });
    assert.equal(after.size, 0n);
    assert.equal(after.mtimeNs, created.mtimeNs, "never written");
    assert.equal(after.ino, created.ino);
    for (const entries of seen) assert.deepEqual(entries, [".fence.lock"], "no -journal, -wal or -shm, even while held");
    assert.deepEqual(readdirSync(root), [".fence.lock"]);
  });
});

// Acceptance: a claim never spawns a process, never probes a PID and never writes the lock file. Every function a
// claim, a revoked recovery or a retired cleanup can reach in the module is collected from the source; none of them
// starts a process, signals or inspects one, or writes a file, and the lock file is opened only to create it or to
// read a header.
test("no claim path can reach a process spawn, a PID probe or a file write", () => {
  const file = ts.createSourceFile("owned-fence-lock.mjs", SOURCE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of file.statements)
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
  const reached = new Set<string>();
  const called = new Set<string>();
  const openFlags: string[] = [];
  const reads: string[] = [];
  const pending = ["withOwnedFenceLockSync", "withOwnedFenceLock", "recoverRevokedOwnedFenceLock", "retryRetiredOwnedFenceCleanup",
    "retiredOwnedFenceCleanupAvailable", "isOwnedFenceLockContention"];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reached.has(name)) continue;
    const declaration = functions.get(name);
    assert.ok(declaration, `missing function ${name}`);
    reached.add(name);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && functions.has(node.text) && !reached.has(node.text)) pending.push(node.text);
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const calleeName = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.getText(file) : "";
        called.add(calleeName);
        if (calleeName === "openSync") openFlags.push(node.arguments[1]?.getText(file) ?? "");
        if (calleeName === "readFileSync") reads.push(node.arguments[0]?.getText(file) ?? "");
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
  }
  for (const forbidden of ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "fork", "process.kill", "writeFileSync", "writeSync",
    "appendFileSync", "truncateSync", "renameSync", "copyFileSync", "createWriteStream"])
    assert.equal(called.has(forbidden), false, `a claim path calls ${forbidden}`);
  assert.deepEqual([...new Set(openFlags)].sort(), ['"r"', '"wx"'], "the lock file is opened only to create it or to read its header");
  // The one other file a claim reads: /proc/locks, for a contention message on Linux.
  assert.deepEqual([...new Set(reads)], ['"/proc/locks"']);
  assert.ok(reached.has("tryLockOnce") && reached.has("releaseConnection") && reached.has("assertRollbackJournalDatabase"), "the walk saw the claim");
});

// FL4 acceptance: the module starts no process on any path, claim or not. Self-birth, its Windows prestart and the
// holder probes are gone, and nothing in it imports child_process or names powershell.exe or ps.
test("the lock module imports no process API and starts no powershell.exe or ps", () => {
  const file = ts.createSourceFile("owned-fence-lock.mjs", SOURCE, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  // Code only: identifiers, property accesses and string literals (comments may say what the module never does).
  const imports: string[] = [];
  const identifiers = new Set<string>();
  const accesses = new Set<string>();
  const strings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) imports.push(node.arguments[0]?.getText(file) ?? "");
    // A bare name, not a member name such as SQLite's database.exec(...).
    if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) identifiers.add(node.text);
    if (ts.isPropertyAccessExpression(node)) accesses.add(node.getText(file));
    if (ts.isStringLiteralLike(node)) strings.push(node.text);
    if (ts.isTemplateExpression(node)) strings.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(identifiers.has("withOwnedFenceLockSync") && strings.length > 0, "the walk saw the module");
  for (const specifier of imports)
    assert.doesNotMatch(specifier, /child_process|worker_threads|^(node:)?cluster$/, `the lock module imports ${specifier}`);
  for (const name of ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync", "fork"])
    assert.equal(identifiers.has(name), false, `the lock module names ${name}`);
  assert.equal(accesses.has("process.kill"), false, "the lock module signals or probes a PID");
  for (const text of strings) {
    assert.doesNotMatch(text, /powershell|pwsh/i, `a powershell start: ${text}`);
    assert.doesNotMatch(text, /^(?:\/bin\/|\/usr\/bin\/)?ps$/, `a ps start: ${text}`);
  }
  assert.doesNotMatch(SOURCE, /RUNNER_RAW_PROCESS_BOUNDARY/, "the module is no raw process boundary any more");
});

test("a live holder in another process is never displaced: sync and async claims wait, then fail closed as contention", { timeout: 20_000 }, async () => {
  await withRoot("live", async (root) => {
    const lockPath = join(root, ".fence.lock");
    const holder = startHolder("hold", lockPath);
    try {
      assert.equal((await nextMessage(holder)).state, "acquired");
      let effects = 0;
      const startedAt = Date.now();
      let contention: unknown;
      try { withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { deadlineMs: 150 }); }
      catch (error) { contention = error; }
      assert.ok(Date.now() - startedAt >= 140, "it waited out its whole deadline");
      assert.ok(contention instanceof OwnedFenceContentionError, String(contention));
      assert.equal(isOwnedFenceLockContention(contention), true);
      assert.match((contention as Error).message, /held by another holder/);
      if (process.platform === "linux") assert.match((contention as Error).message, new RegExp(`held by PID ${holder.pid}\\b`));

      let ticks = 0;
      const ticker = setInterval(() => { ticks += 1; }, 10);
      try {
        await assert.rejects(withOwnedFenceLock(lockPath, () => { effects += 1; }, { deadlineMs: 400 }), OwnedFenceContentionError);
      } finally { clearInterval(ticker); }
      assert.ok(ticks >= 5, `timers ran while the async claim waited (${ticks} ticks in 400 ms)`);
      assert.equal(effects, 0);

      // Contention never hides a terminal failure, and an effect's own errors are not contention.
      const terminal = new OwnedFenceLockUnavailableError("Owned fence lock file is foreign or a WAL database; it is left unchanged.");
      assert.equal(isOwnedFenceLockContention(new AggregateError([contention, terminal])), false);
      assert.equal(isOwnedFenceLockContention(new OwnedFenceLockUnavailableError("effect failed", {
        cause: Object.assign(new Error("busy"), { code: "EBUSY" }),
      })), false);
      assert.throws(() => withOwnedFenceLockSync(lockPath, () => undefined, { deadlineAt: Date.now() - 1 }),
        (error: Error) => error instanceof OwnedFenceContentionError && /deadline is exhausted/.test(error.message));
      for (const options of [{ retryDelayMs: 0 }, { deadlineMs: 0 }, { deadlineAt: Number.NaN }])
        assert.throws(() => withOwnedFenceLockSync(lockPath, () => undefined, options), /bounds are invalid|absolute deadline is invalid/);
    } finally { await stop(holder); }
  });
});

// The kernel releases a dead holder's lock at exit, before the zombie stage. This sync claim blocks the event loop, so
// the killed child cannot be reaped while it runs: on POSIX it reclaims a lock whose holder is still an unreaped zombie.
test("a killed holder's lock is reclaimed at once, by a sync claim in its unreaped parent too", { timeout: 20_000 }, async (t) => {
  await withRoot("killed", async (root) => {
    const lockPath = join(root, ".fence.lock");
    for (const mode of ["hold", "hold-async"]) {
      const holder = startHolder(mode, lockPath);
      try {
        assert.equal((await nextMessage(holder)).state, "acquired");
        holder.kill("SIGKILL");
        const startedAt = performance.now();
        const ran = withOwnedFenceLockSync(lockPath, () => "reclaimed", { deadlineMs: 10_000 });
        const elapsedMs = performance.now() - startedAt;
        const zombie = process.platform === "linux" ? procState(holder.pid!) : undefined;
        assert.equal(ran, "reclaimed");
        assert.equal(holder.exitCode, null, "not reaped yet: the event loop has not run since the kill");
        if (zombie !== undefined) assert.equal(zombie, "Z", "the holder is an unreaped zombie on Linux");
        t.diagnostic(`${process.platform} ${mode}: reclaimed ${elapsedMs.toFixed(1)} ms after the kill${zombie ? `, holder state ${zombie}` : ""}`);
      } finally { await stop(holder); }
    }
  });
});

test("Linux /proc/locks shows this process holding the lock while a claim holds it, and not after", { skip: process.platform !== "linux" }, async () => {
  await withRoot("proc-locks", async (root) => {
    const lockPath = join(root, ".fence.lock");
    withOwnedFenceLockSync(lockPath, () => undefined);
    const inode = lstatSync(lockPath).ino;
    const holders = () => readFileSync("/proc/locks", "utf8").split("\n").map((line) => line.trim().split(/\s+/))
      .map((fields) => fields[0] === "->" ? fields.slice(1) : fields)
      .filter((fields) => fields[1] === "POSIX" && fields[5]?.split(":")[2] === String(inode)).map((fields) => Number(fields[4]));
    let during: number[] = [];
    withOwnedFenceLockSync(lockPath, () => { during = holders(); });
    assert.ok(during.includes(process.pid), `this PID holds a POSIX lock on the lock file: ${during.join(", ")}`);
    let duringAsync: number[] = [];
    await withOwnedFenceLock(lockPath, async () => { await Promise.resolve(); duringAsync = holders(); });
    assert.ok(duringAsync.includes(process.pid));
    assert.deepEqual(holders(), [], "released");
  });
});

// A sync wait blocks the thread, so it can never outlast a lock this same thread holds through a live async
// acquisition (or a nested claim): it fails at once instead of stalling the event loop until its own deadline. The
// file is matched by identity, so another spelling of it (a case difference on Windows, a linked parent directory on
// POSIX) is refused at once too.
test("a sync claim on a lock this thread holds through a live async acquisition fails at once, under any spelling", async () => {
  await withRoot("self-held", async (root) => {
    const lockPath = join(root, ".fence.lock");
    let alternate: string;
    if (process.platform === "win32") alternate = lockPath.toUpperCase();
    else { symlinkSync(root, join(root, "link"), "dir"); alternate = join(root, "link", ".fence.lock"); }
    for (const spelling of [lockPath, alternate]) {
      let inner: unknown;
      let elapsedMs = 0;
      await withOwnedFenceLock(lockPath, async () => {
        await new Promise<void>((resolvePromise) => setTimeout(() => {
          const startedAt = Date.now();
          try { withOwnedFenceLockSync(spelling, () => assert.fail("the nested sync effect must not run"), { deadlineMs: 5_000 }); }
          catch (error) { inner = error; }
          elapsedMs = Date.now() - startedAt;
          resolvePromise();
        }, 10));
      });
      assert.ok(isOwnedFenceLockContention(inner), `contention, not another failure: ${String(inner)}`);
      assert.match(String((inner as Error).message), /another live acquisition of this thread/, spelling);
      assert.ok(elapsedMs < 2_000, `it failed at once, not at its 5 s deadline (${elapsedMs} ms, ${spelling})`);
      let effects = 0;
      withOwnedFenceLockSync(spelling, () => { effects += 1; });
      assert.equal(effects, 1, "once the async holder released, a sync claim succeeds");
    }
  });
});

// The async queue waits behind every earlier turn on a path without a deadline, so an async claim from inside this
// context's own claim of the same lock would wait for itself forever (FL3 review). It fails at once, as a nested sync
// claim does; work the effect leaves running claims normally once the effect is over.
test("an async claim nested in this context's own async claim of the same lock fails at once", { timeout: 10_000 }, async () => {
  await withRoot("nested-async", async (root) => {
    const lockPath = join(root, ".fence.lock");
    let nested: unknown;
    let background: Promise<string> | undefined;
    const startedAt = Date.now();
    await withOwnedFenceLock(lockPath, async () => {
      try { await withOwnedFenceLock(lockPath, () => assert.fail("the nested effect must not run")); }
      catch (error) { nested = error; }
      background = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20))
        .then(() => withOwnedFenceLock(lockPath, () => "background claimed"));
    });
    assert.ok(isOwnedFenceLockContention(nested), `contention, not another failure: ${String(nested)}`);
    assert.match(String((nested as Error).message), /would wait for itself/);
    assert.ok(Date.now() - startedAt < 2_000, "it failed at once");
    assert.equal(await background, "background claimed", "work the effect left running claims once the effect is over");
    // Another lock inside a held one is not nested.
    assert.equal(await withOwnedFenceLock(lockPath, async () => await withOwnedFenceLock(join(root, "other.lock"), () => "other")), "other");
  });
});

// A POSIX name may hold a backslash. The URI SQLite opens must name that same file, not one with a separator there.
test("a lock path is opened as itself: a POSIX backslash stays part of the name", async (t) => {
  const { sqliteDatabaseLocation } = await import("../src/windows-path-limits.mjs");
  assert.equal(sqliteDatabaseLocation("/home/u/a\\b/x%#?.lock", "linux", { mode: "rw" }), "file:///home/u/a%5Cb/x%25%23%3F.lock?mode=rw");
  assert.equal(sqliteDatabaseLocation("C:\\a\\b.lock", "win32", { mode: "rw" }), "file:///C:/a/b.lock?mode=rw");
  if (process.platform === "win32") { t.diagnostic("the on-disk half needs a POSIX file system"); return; }
  await withRoot("backslash", async (root) => {
    mkdirSync(join(root, "a\\b"));
    const lockPath = join(root, "a\\b", ".fence.lock");
    const holder = startHolder("hold", lockPath);
    try {
      assert.equal((await nextMessage(holder)).state, "acquired");
      assert.throws(() => withOwnedFenceLockSync(lockPath, () => assert.fail("a held lock must not be claimed"), { deadlineMs: 200 }),
        (error: unknown) => isOwnedFenceLockContention(error), "the claim saw the holder's lock: the same file");
      assert.equal(existsSync(join(root, "a", "b")), false, "no file at the separator spelling");
    } finally { await stop(holder); }
  });
});

// Acceptance: old and new code on one existing file lose 0 updates. A Runner update leaves supervisors of the earlier
// version running on lock files that version created; both take the same lock bytes.
test("old and new code on one pre-FL2 lock file exclude each other and lose no update", { timeout: 60_000 }, async () => {
  await withRoot("mixed", async (root) => {
    const lockPath = join(root, ".fence.lock");
    const counterPath = join(root, "counter");
    v1.withOwnedFenceLockSync(lockPath, () => undefined, V1_OPTIONS);
    const oldBytes = digest(lockPath);
    withOwnedFenceLockSync(lockPath, () => undefined);
    assert.equal(digest(lockPath), oldBytes, "a new claim leaves the old file's bytes as they were");
    const perProcess = 20;
    const workers = ["v1:count", "v1:count", "count", "count"].map((mode) => startHolder(mode, lockPath, counterPath, perProcess));
    try {
      const messages = workers.map((worker) => nextMessage(worker));
      for (const [index, message] of (await Promise.all(messages)).entries())
        assert.deepEqual(message, { pid: workers[index]!.pid, state: "counted", count: perProcess });
    } finally { for (const worker of workers) await stop(worker); }
    assert.equal(Number(readFileSync(counterPath, "utf8")), workers.length * perProcess, "no update lost");
    const database = new DatabaseSync(lockPath, { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT retired FROM owned_fence_protocol").get()?.retired, 0);
      assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM owned_fence_holder").get()?.count), 0, "the old code's own state is intact");
    } finally { database.close(); }
  });
});

// Acceptance: an old-format retired file stays retired (until FL5, one release later).
test("a pre-FL2 lock file that says retired stays retired: claims refuse it, and only the retired cleanup takes it", async () => {
  await withRoot("retired", async (root) => {
    const lockPath = join(root, ".fence.lock");
    v1.withOwnedFenceLockSync(lockPath, () => undefined, V1_OPTIONS);
    assert.equal(retiredOwnedFenceCleanupAvailable(lockPath), false, "an active old file is not retired");
    await assert.rejects(retryRetiredOwnedFenceCleanup(lockPath, () => assert.fail("not retired")), /not a retired/);
    v1.withOwnedFenceLockSync(lockPath, () => undefined, { ...V1_OPTIONS, retireAfterEffect: true, retireAuthority: () => undefined });
    const retiredBytes = digest(lockPath);
    let effects = 0;
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }), /Owned fence lock protocol is retired\./);
    await assert.rejects(withOwnedFenceLock(lockPath, () => { effects += 1; }), /retired/);
    assert.equal(effects, 0);
    assert.equal(retiredOwnedFenceCleanupAvailable(lockPath), true);
    let cleaned = 0;
    await retryRetiredOwnedFenceCleanup(lockPath, () => { cleaned += 1; });
    assert.equal(cleaned, 1);
    assert.equal(digest(lockPath), retiredBytes, "nothing rewrote it");

    const emptyPath = join(root, "empty.lock");
    withOwnedFenceLockSync(emptyPath, () => undefined);
    assert.equal(retiredOwnedFenceCleanupAvailable(emptyPath), false, "an empty lock file is never retired");
    await assert.rejects(retryRetiredOwnedFenceCleanup(emptyPath, () => assert.fail("not retired")), /not a retired/);
    await assert.rejects(retryRetiredOwnedFenceCleanup(join(root, "missing.lock"), () => assert.fail("missing")), /missing/);
  });
});

// The old protocol's holder rows are left alone: a row whose process is alive (here: this process, under a birth it
// never had) blocked a pre-FL2 claim for its whole deadline, or sent it to a powershell.exe probe. Now only the OS lock counts.
test("a pre-FL2 holder row is neither probed nor waited for, and stays as it was", () => {
  withRootSync("old-row", (root) => {
    const lockPath = join(root, ".fence.lock");
    v1.withOwnedFenceLockSync(lockPath, () => undefined, V1_OPTIONS);
    const database = new DatabaseSync(lockPath);
    database.exec(`
      INSERT INTO owned_fence_acquisition(acquisition_id, holder_pid, holder_birth) VALUES ('11111111-1111-4111-8111-111111111111', ${process.pid}, 'another-birth');
      INSERT INTO owned_fence_holder(lock_key, acquisition_id, holder_pid, holder_birth) VALUES ('owned', '11111111-1111-4111-8111-111111111111', ${process.pid}, 'another-birth');
    `);
    database.close();
    const before = digest(lockPath);
    const startedAt = Date.now();
    assert.equal(withOwnedFenceLockSync(lockPath, () => "ran", { deadlineMs: 5_000 }), "ran");
    assert.ok(Date.now() - startedAt < 1_000, "no wait for the row's deadline");
    assert.equal(digest(lockPath), before);
  });
});

// Acceptance: a foreign WAL file is refused. SQLite would create -wal and -shm files beside it and lock elsewhere, so
// a non-empty lock file is read (its header) before any SQLite open.
test("a foreign WAL database, a foreign database and a non-SQLite file are refused without changing a byte", () => {
  withRootSync("foreign", (root) => {
    const wal = join(root, "wal.lock");
    const foreign = join(root, "foreign.lock");
    const text = join(root, "text.lock");
    const walDatabase = new DatabaseSync(wal);
    walDatabase.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    walDatabase.close();
    const foreignDatabase = new DatabaseSync(foreign);
    foreignDatabase.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1);");
    foreignDatabase.close();
    writeFileSync(text, "not a database at all, but longer than one hundred bytes ".repeat(4));
    const entries = readdirSync(root).sort();
    for (const [path, message] of [[wal, /foreign or a WAL database/], [foreign, /foreign database/], [text, /foreign or a WAL database/]] as const) {
      const before = digest(path);
      let effects = 0;
      assert.throws(() => withOwnedFenceLockSync(path, () => { effects += 1; }), (error: Error) =>
        error instanceof OwnedFenceLockUnavailableError && !isOwnedFenceLockContention(error) && message.test(error.message));
      assert.equal(effects, 0);
      assert.equal(digest(path), before, path);
      assert.equal(retiredOwnedFenceCleanupAvailable(path), false);
    }
    assert.deepEqual(readdirSync(root).sort(), entries, "no -wal or -shm file appeared");
  });
});

test("a hard link, a symbolic link or a replacement of the lock file is refused before the effect", () => {
  withRootSync("aliases", (root) => {
    const lockPath = join(root, ".fence.lock");
    withOwnedFenceLockSync(lockPath, () => undefined);
    let effects = 0;
    const alias = join(root, "alias");
    linkSync(lockPath, alias);
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }), /aliased, linked/);
    rmSync(alias);
    // Planted while the claim holds the lock, before its effect.
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { afterClaim: () => linkSync(lockPath, alias) }), /aliased, linked/);
    rmSync(alias);
    // On Windows the held file cannot be replaced or removed at all (SQLite opens it without FILE_SHARE_DELETE).
    if (process.platform !== "win32") {
      const replacement = join(root, "replacement");
      writeFileSync(replacement, "");
      assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { afterClaim: () => renameSync(replacement, lockPath) }),
        /replaced or removed while it was held/);
      assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { afterClaim: () => rmSync(lockPath) }), /unavailable/);

      const target = join(root, "target");
      writeFileSync(target, "");
      const linked = join(root, "linked.lock");
      symlinkSync(target, linked);
      assert.throws(() => withOwnedFenceLockSync(linked, () => { effects += 1; }), /aliased, linked/);
    }
    assert.equal(effects, 0);
  });
});

// Acceptance: a failed release keeps the lock until the process exits.
test("a failed release keeps the lock held until its process exits", { timeout: 20_000 }, async () => {
  await withRoot("retained", async (root) => {
    const lockPath = join(root, ".fence.lock");
    const holder = startHolder("retain", lockPath);
    try {
      const retained = await nextMessage(holder);
      assert.equal(retained.state, "retained");
      assert.match(String(retained.failure), /release failed; this process keeps the lock until it exits/);
      assert.equal(retained.laterName, "OwnedFenceContentionError", "a later claim in that process fails at once");
      assert.match(String(retained.later), /kept by this process after its release failed[\s\S]*injected release fault/);
      assert.throws(() => withOwnedFenceLockSync(lockPath, () => undefined, { deadlineMs: 200 }), OwnedFenceContentionError);
      holder.kill("SIGKILL");
      await exited(holder);
      assert.equal(withOwnedFenceLockSync(lockPath, () => "after exit", { deadlineMs: 5_000 }), "after exit");
    } finally { await stop(holder); }
  });
});

test("an acquisition whose effect never started gives the lock back", async () => {
  await withRoot("unstarted", async (root) => {
    const lockPath = join(root, ".fence.lock");
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => assert.fail("not started"), { afterClaim: () => { throw new Error("before the effect"); } }),
      /before the effect/);
    await assert.rejects(withOwnedFenceLock(lockPath, () => assert.fail("not started"), { afterClaim: () => { throw new Error("async, before the effect"); } }),
      /async, before the effect/);
    const startedAt = Date.now();
    assert.equal(withOwnedFenceLockSync(lockPath, () => "next", { deadlineMs: 5_000 }), "next");
    assert.ok(Date.now() - startedAt < 1_000);
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { throw new Error("effect failed"); }), /effect failed/);
    assert.equal(withOwnedFenceLockSync(lockPath, () => "after a failed effect"), "after a failed effect");
  });
});

test("retirement removes the lock file after the lock is given back, retries a busy removal, and reports a failed one", async () => {
  await withRoot("retire", async (root) => {
    const lockPath = join(root, ".fence.lock");
    assert.equal(await withOwnedFenceLock(lockPath, () => "released", { retireAfterEffect: true }), "released");
    assert.equal(existsSync(lockPath), false);

    let busy = 0;
    let claimedInside = false;
    await withOwnedFenceLock(lockPath, () => undefined, {
      retireAfterEffect: true,
      retireAuthority: () => {
        if (busy < 2) { busy += 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
        claimedInside = withOwnedFenceLockSync(lockPath, () => true, { deadlineMs: 1_000 });
        rmSync(lockPath);
      },
    });
    assert.equal(busy, 2, "a busy removal is tried again");
    assert.equal(claimedInside, true, "the lock is given back before the authority is removed");
    assert.equal(existsSync(lockPath), false);

    let effects = 0;
    await assert.rejects(withOwnedFenceLock(lockPath, () => { effects += 1; }, {
      retireAfterEffect: true, retireAuthority: () => { throw new Error("removal fault"); },
    }), (error: Error) => error instanceof OwnedFenceAuthorityRetirementError && /removal fault/.test(String((error.cause as Error)?.message)));
    assert.equal(effects, 1);
    // A replaced file is never removed in the holder's name. (On Windows the held file cannot be replaced at all: SQLite
    // opens it without FILE_SHARE_DELETE.)
    if (process.platform !== "win32") {
      const replaced = join(root, "replaced.lock");
      await assert.rejects(withOwnedFenceLock(replaced, () => {
        rmSync(replaced);
        writeFileSync(replaced, "");
      }, { retireAfterEffect: true }), OwnedFenceAuthorityRetirementError);
      assert.equal(existsSync(replaced), true);
    }
  });
});

test("revoked recovery removes a lock only while its authority stays revoked", async () => {
  await withRoot("revoked", async (root) => {
    const lockPath = join(root, ".fence.lock");
    withOwnedFenceLockSync(lockPath, () => undefined);
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, {} as never), /revocation authority is unavailable/);
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, { assertRevoked: () => { throw new Error("still active"); } }), /still active/);
    let calls = 0;
    await assert.rejects(recoverRevokedOwnedFenceLock(lockPath, { assertRevoked: () => { calls += 1; if (calls === 2) throw new Error("changed under the lock"); } }),
      /changed under the lock/);
    assert.equal(existsSync(lockPath), true, "kept while its authority is not revoked");
    await recoverRevokedOwnedFenceLock(lockPath, { assertRevoked: () => undefined });
    assert.equal(existsSync(lockPath), false);
    await recoverRevokedOwnedFenceLock(lockPath, { assertRevoked: () => undefined });
    assert.equal(existsSync(lockPath), false, "a missing lock is already recovered and never recreated");

    v1.withOwnedFenceLockSync(lockPath, () => undefined, { ...V1_OPTIONS, retireAfterEffect: true, retireAuthority: () => undefined });
    await recoverRevokedOwnedFenceLock(lockPath, { assertRevoked: () => undefined });
    assert.equal(existsSync(lockPath), false, "a retired pre-FL2 lock is recovered too");
  });
});

test("a claim that creates the lock file asks its authority first, and a refusal removes only that file", () => {
  withRootSync("authority", (root) => {
    const lockPath = join(root, ".fence.lock");
    let effects = 0;
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { assertAuthority: () => { throw new Error("authority released"); } }),
      /authority released/);
    assert.equal(existsSync(lockPath), false, "the file it created is gone again");
    assert.equal(effects, 0);
    // A file that won the race is not this claim's to remove.
    assert.throws(() => withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { assertAuthority: () => {
      rmSync(lockPath);
      writeFileSync(lockPath, "");
      throw new Error("refused after a replacement");
    } }), /refused after a replacement/);
    assert.equal(existsSync(lockPath), true);
    let asked = 0;
    withOwnedFenceLockSync(lockPath, () => { effects += 1; }, { assertAuthority: () => { asked += 1; } });
    assert.equal(asked, 0, "an existing lock file needs no creation authority");
    assert.equal(effects, 1);
  });
});

// Acceptance: uncontended claim p95 is measured and reported on all three CI OSes (the portable contract job).
test("uncontended claim cost (reported)", async (t) => {
  await withRoot("cost", async (root) => {
    const lockPath = join(root, ".fence.lock");
    withOwnedFenceLockSync(lockPath, () => undefined);
    const measure = async (label: string, claims: number, claim: () => unknown) => {
      const samples: number[] = [];
      for (let index = 0; index < claims; index += 1) {
        const startedAt = performance.now();
        await claim();
        samples.push(performance.now() - startedAt);
      }
      samples.sort((left, right) => left - right);
      const at = (quantile: number) => samples[Math.min(samples.length - 1, Math.ceil(quantile * samples.length) - 1)]!.toFixed(2);
      t.diagnostic(`${process.platform} ${label}, n=${claims}: p50 ${at(0.5)} / p95 ${at(0.95)} / p99 ${at(0.99)} / max ${at(1)} ms`);
    };
    await measure("sync claim", 200, () => withOwnedFenceLockSync(lockPath, () => undefined));
    await measure("async claim", 200, () => withOwnedFenceLock(lockPath, () => undefined));
  });
});

function startHolder(mode: string, lockPath: string, effectPath = "", count = 0): ChildProcess {
  return spawn(process.execPath, [fixture, mode, lockPath, effectPath, "2000", "60000", String(count)], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function nextMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  return await new Promise((resolvePromise, reject) => {
    let text = "";
    let errors = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolvePromise(JSON.parse(text.slice(0, newline))); } catch (error) { reject(error); }
    };
    const onError = (chunk: Buffer) => { errors += chunk.toString("utf8"); };
    // "close", not "exit": it comes after the child's output, so a message is never lost to an early exit.
    const onClose = (code: number | null) => { cleanup(); reject(new Error(`Fence holder exited before a message (${String(code)}): ${text}${errors}`)); };
    const cleanup = () => { child.stdout?.off("data", onData); child.stderr?.off("data", onError); child.off("close", onClose); };
    child.stdout?.on("data", onData); child.stderr?.on("data", onError); child.once("close", onClose);
  });
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited(child);
}

function procState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch { return undefined; }
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function withRoot(name: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-owned-fence-lock-${name}-`));
  try { await body(root); }
  finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
}

function withRootSync(name: string, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), `aiboard-owned-fence-lock-${name}-`));
  try { body(root); }
  finally { rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
}
