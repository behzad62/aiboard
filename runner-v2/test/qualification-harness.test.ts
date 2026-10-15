import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  qualificationFixtureRootsFromEvidence,
  runIsolatedScenario,
  writeQualificationDiagnostics,
} from "./support/qualification-harness.js";

const probe = new URL("./support/qualification-harness-probe.ts", import.meta.url);

test("qualification diagnostics retain a bounded runtime database and WAL without widening unrelated capture", () => {
  const root = evidenceRoot();
  let database: DatabaseSync | undefined;
  let copied: DatabaseSync | undefined;
  try {
    const fixture = join(root, "fixture");
    const state = join(fixture, "state", "builds", "owned-run");
    mkdirSync(state, { recursive: true });
    const databasePath = join(state, "subprocess-runtime.sqlite");
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE facts (value BLOB)");
    const payload = Buffer.alloc(3 * 1024 * 1024, 42);
    database.prepare("INSERT INTO facts VALUES (?)").run(payload);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.prepare("INSERT INTO facts VALUES (?)").run(payload);
    assert.ok(readFileSync(databasePath).length > 2 * 1024 * 1024);
    assert.ok(readFileSync(`${databasePath}-wal`).length > 2 * 1024 * 1024);
    writeFileSync(join(state, "unrelated.sqlite"), payload);
    const oversized = join(root, "oversized");
    const oversizedState = join(oversized, "state", "builds", "owned-run");
    mkdirSync(oversizedState, { recursive: true });
    writeFileSync(join(oversizedState, "subprocess-runtime.sqlite"), Buffer.alloc(9 * 1024 * 1024));
    // Simulate a live WAL/database growing after its metadata was sampled.
    const originalStat = fs.statSync;
    let capture: string;
    try {
      fs.statSync = ((...args: Parameters<typeof fs.statSync>) => {
        const observed = Reflect.apply(originalStat, fs, args);
        return String(args[0]) === join(oversizedState, "subprocess-runtime.sqlite")
          ? { ...observed, size: 4 * 1024 * 1024 } : observed;
      }) as typeof fs.statSync;
      syncBuiltinESMExports();
      capture = writeQualificationDiagnostics({ evidenceRoot: join(root, "evidence"), scenario: "bounded-runtime-db", fixtureRoots: [fixture, oversized] });
    } finally {
      fs.statSync = originalStat;
      syncBuiltinESMExports();
    }
    const main = findNamedFile(capture, "subprocess-runtime.sqlite");
    const wal = findNamedFile(capture, "subprocess-runtime.sqlite-wal");
    assert.ok(main, "runtime database within the bounded evidence allowance must be retained");
    assert.ok(wal, "the associated runtime WAL must also be retained");
    assert.deepEqual(readFileSync(main), readFileSync(databasePath));
    assert.deepEqual(readFileSync(wal), readFileSync(`${databasePath}-wal`));
    assert.ok(findNamedFile(capture, "unrelated.sqlite.omitted.txt"), "unrelated files keep their original bound");
    assert.ok(findNamedFile(capture, "subprocess-runtime.sqlite.omitted.txt"), "runtime evidence remains finitely bounded");
    const outside = join(root, "outside-role");
    mkdirSync(outside);
    writeFileSync(join(outside, "subprocess-runtime.sqlite"), payload);
    const outsideCapture = writeQualificationDiagnostics({ evidenceRoot: join(root, "evidence"), scenario: "outside-runtime-role", fixtureRoots: [outside] });
    assert.equal(findNamedFile(outsideCapture, "subprocess-runtime.sqlite"), undefined, "the filename alone never widens capture outside the owned build-state role");
    assert.ok(findNamedFile(outsideCapture, "subprocess-runtime.sqlite.omitted.txt"));
    // SQLite itself needs a short pathname on Windows; preserve captured files.
    const readRoot = join(root, "read");
    mkdirSync(readRoot);
    const readPath = join(readRoot, "subprocess-runtime.sqlite");
    copyFileSync(main, readPath);
    copyFileSync(wal, `${readPath}-wal`);
    const shm = findNamedFile(capture, "subprocess-runtime.sqlite-shm");
    if (shm) copyFileSync(shm, `${readPath}-shm`);
    copied = new DatabaseSync(readPath, { readOnly: true });
    assert.equal(copied.prepare("SELECT count(*) AS count FROM facts").get()!.count, 2, "both main database and WAL facts survive capture");
  } finally {
    copied?.close();
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function evidenceRoot(): string {
  return mkdtempSync(join(tmpdir(), "runner-v2-qualification-harness-test-"));
}

function findNamedFile(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = findNamedFile(candidate, name);
      if (nested) return nested;
    }
  }
  return undefined;
}
test("qualification harness captures durable fixture evidence on child failure", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-failure",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "fail" },
    }), /failed|synthetic harness probe failure/i);

    const fixtures = qualificationFixtureRootsFromEvidence(root, "harness-failure");
    assert.equal(fixtures.length, 1);
    assert.equal(existsSync(fixtures[0]!), true, "failed fixture must remain for exact postmortem cleanup");
    const diagnostics = join(root, "diagnostics", "harness-failure");
    const captured = findNamedFile(diagnostics, "state.json");
    assert.ok(captured, "failure diagnostics must copy state.json into the artifact tree");
    assert.match(readFileSync(captured, "utf8"), /durable-state/);
    const output = findNamedFile(diagnostics, "stdout-000000000001.json");
    assert.ok(output, "failure diagnostics must retain portable channel output records");
    assert.match(readFileSync(output, "utf8"), /retained-output/);
    const ack = findNamedFile(diagnostics, "stderr-000000000002.json");
    assert.ok(ack, "failure diagnostics must retain portable channel acknowledgement records");
    assert.match(readFileSync(ack, "utf8"), /retained-ack/);
  } finally {
    for (const fixture of qualificationFixtureRootsFromEvidence(root, "harness-failure")) {
      rmSync(fixture, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness captures durable fixture evidence before timeout termination", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-timeout",
      timeoutMs: process.platform === "win32" ? 10_000 : 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "timeout" },
    }), /timed out/i);

    const fixtures = qualificationFixtureRootsFromEvidence(root, "harness-timeout");
    assert.equal(fixtures.length, 1);
    const diagnostics = join(root, "diagnostics", "harness-timeout");
    const captured = findNamedFile(diagnostics, "state.json");
    assert.ok(captured, "timeout diagnostics must copy state.json before terminating the child");
    assert.match(readFileSync(captured, "utf8"), /durable-state/);
    const preKillSummary = readFileSync(join(diagnostics, "summary.json"), "utf8");
    assert.match(preKillSummary, /before-timeout-termination/);
    writeQualificationDiagnostics({
      evidenceRoot: root,
      scenario: "harness-timeout",
      error: new Error("synthetic outer entrypoint catch"),
    });
    assert.equal(
      readFileSync(join(diagnostics, "summary.json"), "utf8"),
      preKillSummary,
      "later entrypoint diagnostics must not overwrite the pre-kill timeout summary",
    );
  } finally {
    for (const fixture of qualificationFixtureRootsFromEvidence(root, "harness-timeout")) {
      rmSync(fixture, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness fails closed on unapproved child skip", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-skip-refused",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "skip" },
    }), /unapproved skip/i);
    assert.equal(existsSync(join(root, "diagnostics", "harness-skip-refused", "summary.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualification harness permits only an explicitly approved skip", async () => {
  const root = evidenceRoot();
  try {
    assert.equal(await runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-skip-approved",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "skip" },
      allowSkip: true,
    }), "skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness removes deferred fixture only after successful scenario completion", async () => {
  const root = evidenceRoot();
  try {
    assert.equal(await runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-pass",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "pass" },
    }), "passed");
    const fixtures = qualificationFixtureRootsFromEvidence(root, "harness-pass");
    assert.equal(fixtures.length, 1);
    assert.equal(existsSync(fixtures[0]!), false, "successful scenario must flush its deferred fixture removal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness never treats stdout-only SKIP text as skip authority", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-text-skip-only",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "text-skip-only" },
      allowSkip: true,
    }), /skip.*marker|unstructured skip/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
