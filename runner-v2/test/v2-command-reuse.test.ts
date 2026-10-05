import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ArtifactStore} from "../src/artifact-store.js";
import {SqliteEvidenceStore} from "../src/sqlite-evidence-store.js";
import {fingerprintChildEnvironment} from "../src/command-evidence-identity.js";
import {commandReuseKey, findReusableCommand} from "../src/command-evidence-reuse.js";
import type {CommandEvidenceFact} from "../src/evidence-store.js";

test("V2 exact reuse API refuses any unknown tree or environment", async () => {
  const { commandReuseKey } = await import("../src/command-evidence-reuse.js");
  const request = {executable: process.execPath, arguments: ["--test", "test/x.mjs"], workingDirectory: "C:/fixture", timeoutMs: 1000};
  assert.equal(commandReuseKey(request, {status: "unknown", reason: "capture_unavailable"}, {version: 1, status: "unknown", unavailable: ["runtime"]}), undefined);
});

test("V2 literal tree argv cwd env lock runtime and backend context invalidate exact tuples", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-key-"));
  try {
    const request = {executable: process.execPath, arguments: ["--test", "x.mjs"], workingDirectory: root, timeoutMs: 1000};
    const tree = {status: "known" as const, treeId: "a".repeat(40)};
    const env = await fingerprintChildEnvironment({environment: {V2: "one"}, executable: process.execPath, cwd: root});
    const context = {requiredLifecycleScope: "process_group", implementationDigest: "b".repeat(64), configDigest: "c".repeat(64)};
    const key = commandReuseKey(request, tree, env, context); assert.ok(key);
    assert.equal(commandReuseKey({...request}, {...tree}, {...env}, {...context}), key);
    assert.notEqual(commandReuseKey(request, {...tree, treeId: "d".repeat(40)}, env, context), key);
    assert.notEqual(commandReuseKey({...request, arguments: ["--test", "./x.mjs"]}, tree, env, context), key);
    assert.notEqual(commandReuseKey({...request, workingDirectory: `${root}/.`}, tree, env, context), key);
    assert.notEqual(commandReuseKey({...request, timeoutMs: 1001}, tree, env, context), key);
    assert.notEqual(commandReuseKey(request, tree, env, {...context, requiredLifecycleScope: "contained_workload"}), key);
    assert.notEqual(commandReuseKey(request, tree, env, {...context, implementationDigest: "e".repeat(64)}), key);
    assert.notEqual(commandReuseKey(request, tree, env, {...context, configDigest: "f".repeat(64)}), key);
    assert.notEqual(commandReuseKey(request, tree, {...env, runtime: {...env.runtime!, version: "different actual runtime"}}, context), key);
    const changedEnv = await fingerprintChildEnvironment({environment: {V2: "two"}, executable: process.execPath, cwd: root});
    assert.notEqual(commandReuseKey(request, tree, changedEnv, context), key);
    writeFileSync(join(root, "package-lock.json"), "changed lock bytes");
    const changedLock = await fingerprintChildEnvironment({environment: {V2: "one"}, executable: process.execPath, cwd: root});
    assert.notEqual(commandReuseKey(request, tree, changedLock, context), key);
    assert.equal(commandReuseKey(request, tree, {...env, runtime: undefined}, context), undefined);
    assert.equal(commandReuseKey(request, tree, {...env, lockfileDigest: undefined}, context), undefined);
    assert.equal(commandReuseKey(request, tree, {...env, environmentDigest: undefined}, context), undefined);
    assert.equal(commandReuseKey(request, tree, {...env, fingerprint: undefined}, context), undefined);
    assert.equal(commandReuseKey(request, tree, {...env, status: "unknown"}, context), undefined);
    assert.equal(commandReuseKey(request, tree, env), undefined);
  } finally {rmSync(root, {recursive: true, force: true});}
});

test("V2 SQLite same-run reopen resolves original facts and refuses unhealthy or substituted artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-reuse-store-")); const project = join(root, "project"); mkdirSync(project);
  const artifacts = new ArtifactStore(join(root, "artifacts")); const path = join(root, "evidence.sqlite");
  let store = new SqliteEvidenceStore(path);
  try {
    const stdout = await artifacts.put(Buffer.from("tests 1\npass 1\n"), "text/plain"); const stderr = await artifacts.put(Buffer.alloc(0), "text/plain");
    const environment = await fingerprintChildEnvironment({environment: {}, executable: process.execPath, cwd: project});
    const tree = {status: "known" as const, treeId: "a".repeat(40)};
    const request = {executable: process.execPath, arguments: ["--test", "x.mjs"], workingDirectory: project, timeoutMs: 1000};
    const key = commandReuseKey(request, tree, environment, {requiredLifecycleScope: "process_group", implementationDigest: "b".repeat(64), configDigest: "c".repeat(64)})!;
    const startedAt = "2026-10-04T00:00:00.000Z"; const finishedAt = "2026-10-04T00:00:01.000Z";
    const fact: CommandEvidenceFact = {kind: "command", label: "original", command: request.executable, args: [...request.arguments], cwd: project, startedAt, finishedAt, exitCode: 0, signal: null, timedOut: false, cancelled: false, outputTruncated: false, outputLossy: false, cleanup: {state: "verified_empty", verifiedAt: finishedAt}, workingTreeIdentity: tree, childEnvironmentIdentity: environment, stdoutArtifactHash: stdout.hash, stderrArtifactHash: stderr.hash,
      executionSnapshot: {key, process: {logicalProcessId: "real-original-result-fixture", outcome: "exited", exitCode: 0, startedAt, finishedAt, cleanup: {state: "verified_empty", verifiedAt: finishedAt}, output: [
        {stream: "stdout", tail: "tests 1\npass 1\n", totalBytes: 15, truncated: false, spillBytes: 0, lossyBytes: 0},
        {stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0}]}}};
    const record = store.record({runId: "run", taskId: "task", actor: {role: "worker", id: "worker"}, fact, createdAt: finishedAt, idempotencyKey: "original"});
    assert.equal((await findReusableCommand(store, artifacts, "run", key))?.id, record.id, "actual SQLite lookup respects its supported bounded limit");
    assert.equal(await findReusableCommand(store, artifacts, "foreign-run", key), undefined);
    assert.equal(await findReusableCommand(store, artifacts, "run", "d".repeat(64)), undefined, "a changed actual tuple cannot reuse original execution");
    store.close(); store = new SqliteEvidenceStore(path);
    assert.deepEqual(await findReusableCommand(store, artifacts, "run", key), record);
    writeFileSync(stdout.path, "substitution"); assert.equal(await findReusableCommand(store, artifacts, "run", key), undefined);
    writeFileSync(stdout.path, "tests 1\npass 1\n");
    for (const [name, patch] of Object.entries({failure: {exitCode: 1}, cancellation: {cancelled: true}, timeout: {timedOut: true}, lossy: {outputLossy: true}, truncated: {outputTruncated: true}, unknownCleanup: {cleanup: {state: "pending"}}, reused: {reused_from: record.id}})) {
      const changedKey = `${key}-${name}`;
      const changed = {...fact, ...patch, executionSnapshot: {...fact.executionSnapshot!, key: changedKey}} as CommandEvidenceFact;
      store.record({runId: "run", taskId: "task", actor: {role: "worker", id: "worker"}, fact: changed, createdAt: finishedAt, idempotencyKey: name});
      assert.equal(await findReusableCommand(store, artifacts, "run", changedKey), undefined, name);
    }
    await artifacts.remove(stdout.hash); assert.equal(await findReusableCommand(store, artifacts, "run", key), undefined);
  } finally {store.close(); rmSync(root, {recursive: true, force: true});}
});
