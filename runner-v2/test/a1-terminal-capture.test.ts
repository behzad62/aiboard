import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ArtifactStore } from "../src/artifact-store.js";
import { buildSourceManifest } from "../src/source-manifest.js";
import { runGitBytes } from "./support/git-fixture.js";
import { A1_DATABASES, captureA1Terminal, finishA1Capture, readA1Database, writeA1File, type A1CaptureInput } from "./support/a1-terminal-capture.js";
import { a1NestedReferences } from "./support/a1-terminal-references.js";

for (const location of ["inside", "outside", "parent", "retry"] as const) test(`A1 fixture cleanup canonical temporary alias ${location}`, () => {
  const source = fs.readFileSync(new URL(import.meta.url), "utf8");
  const ast = ts.createSourceFile("capture.ts", source, ts.ScriptTarget.Latest, true);
  let cleanup: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "fixture") {
      const find = (child: ts.Node): void => {
        if (ts.isVariableDeclaration(child) && child.name.getText(ast) === "cleanup" && child.initializer && ts.isArrowFunction(child.initializer)) cleanup = child.initializer;
        ts.forEachChild(child, find);
      };
      find(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(cleanup);
  const shortParent = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp";
  const canonicalParent = "C:\\Users\\runneradmin\\AppData\\Local\\Temp";
  const root = location === "inside" || location === "retry" ? win32.join(canonicalParent, "owned-control") : location === "parent" ? canonicalParent : "C:\\unrelated\\owned-control";
  const removed: string[] = []; let closes = 0;
  let removeAttempts = 0; const removalFailure = new Error("first removal failed");
  const realpath = Object.assign((value: string) => value, { native: (value: string) => value === shortParent ? canonicalParent : value });
  const expression = ts.createPrinter().printNode(ts.EmitHint.Expression, cleanup, ast);
  const js = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const actual = runInNewContext(js, { fs: { realpathSync: realpath, rmSync: (target: string) => { removeAttempts++; if (location === "retry" && removeAttempts === 1) throw removalFailure; removed.push(target); } }, dbs: { db: { close: () => { closes++; if (closes > 1) throw new Error("database already closed"); } } }, closedDatabases: new Set(), root, tmpdir: () => shortParent, relative: win32.relative, isAbsolute: win32.isAbsolute, assert }) as () => void;
  if (location === "inside") { actual(); assert.deepEqual(removed, [root]); }
  else if (location === "retry") { assert.throws(actual, (error) => error === removalFailure); actual(); assert.deepEqual(removed, [root]); }
  else { assert.throws(actual, assert.AssertionError); assert.deepEqual(removed, []); }
  assert.equal(closes, 1);
});

async function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "aiboard-a1-capture-control-")));
  const fixtureRoot = join(root, "fixture"); fs.mkdirSync(fixtureRoot);
  const project = join(fixtureRoot, "project"); const state = join(fixtureRoot, "state"); const runRoot = join(state, "run");
  fs.mkdirSync(project); fs.mkdirSync(runRoot, { recursive: true });
  await runGitBytes({ cwd: project, args: ["init", "--quiet"] });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const binary = Buffer.from([0, 255, 13, 10, 65]); const raw = await artifacts.put(binary, "application/octet-stream");
  const src = Buffer.from("source one\n"); const amended = Buffer.from("source two\r\n");
  const source = buildSourceManifest(src, [{ id: "s1", startByte: 0, endByte: src.length }], { manifestId: "manifest1", sourceId: "source", mediaType: "text/plain", encoding: "utf8", authority: "user", createdAt: "2026-10-13T00:00:00Z" });
  const amendment = buildSourceManifest(amended, [{ id: "s1", startByte: 0, endByte: amended.length }], { manifestId: "manifest2", sourceId: "source", mediaType: "text/plain", encoding: "utf8", authority: "user", createdAt: "2026-10-13T00:00:01Z", amendment: { id: "amend1", priorManifestId: source.manifestId, priorArtifactDigest: source.artifactDigest, authorizedBy: "user", rationale: "amended source" } });
  await artifacts.put(src, "text/plain"); await artifacts.put(amended, "text/plain");
  const nested = await artifacts.put(Buffer.from([0, 254, 13, 10]), "application/octet-stream");
  const changeDiff = await artifacts.put(Buffer.from("unique nested diff\n"), "text/plain");
  const checkpoint = await artifacts.put(Buffer.from(JSON.stringify({ turns: 1, seenCallIds: [], messages: [
    { role: "assistant", content: [{ type: "text", text: "f".repeat(64) }, { type: "tool_call", callId: "c", name: "artifact.read", arguments: { hash: "e".repeat(64) } }] },
    { role: "tool", content: { toolName: "opaque", isError: false, content: [{ type: "artifact", hash: nested.hash, mediaType: "application/octet-stream" }, { type: "json", value: { hash: "d".repeat(64) } }] } },
  ] })), "application/json");
  const changeset = await artifacts.put(Buffer.from(JSON.stringify({ diffArtifactHash: changeDiff.hash, evidenceArtifactHashes: [raw.hash], criterionEvidenceLinks: [{ artifactHashes: [raw.hash] }], externalEffects: [{ artifactHash: raw.hash }] })), "application/json");
  const dbs = Object.fromEntries(A1_DATABASES.map((name) => [name, new DatabaseSync(join(runRoot, name))]));
  for (const db of Object.values(dbs)) db.exec("PRAGMA journal_mode=WAL");
  dbs["scheduler.sqlite"]!.exec("CREATE TABLE scheduler_events(event_id TEXT, run_id TEXT, sequence INTEGER, event_type TEXT, occurred_at TEXT, actor_json TEXT, idempotency_key TEXT, payload_json TEXT)");
  const add = dbs["scheduler.sqlite"]!.prepare("INSERT INTO scheduler_events VALUES (?, 'run_t8_spine', ?, ?, '2026-10-13T00:00:00Z', '{\"role\":\"user\",\"id\":\"test\"}', ?, ?)");
  add.run("event1", 1, "planning.source_registered", "first", JSON.stringify({ manifest: source }));
  add.run("event2", 2, "planning.source_amended", "second", JSON.stringify({ manifest: amendment }));
  dbs["context-manifests.sqlite"]!.exec("CREATE TABLE context_manifests(manifest_id TEXT,run_id TEXT,session_id TEXT,recorded_at TEXT,payload_json TEXT)");
  dbs["evidence.sqlite"]!.exec("CREATE TABLE evidence_records(evidence_id TEXT,run_id TEXT,fact_json TEXT); CREATE TABLE validation_observations(observation_id TEXT,run_id TEXT,artifact_hashes_json TEXT)");
  dbs["evidence.sqlite"]!.prepare("INSERT INTO evidence_records VALUES ('evidence1','run_t8_spine',?)").run(JSON.stringify({ kind: "command", stdoutArtifactHash: raw.hash, stderrArtifactHash: raw.hash, executionSnapshot: { process: { output: [{ spillArtifactId: raw.hash }] } }, workingTreeIdentity: { digest: "c".repeat(64) } }));
  dbs["budget.sqlite"]!.exec("CREATE TABLE budget_events(payload_json TEXT)");
  dbs["budget.sqlite"]!.prepare("INSERT INTO budget_events VALUES (?)").run(JSON.stringify({ digest: "b".repeat(64), artifactBytes: 4 }));
  dbs["sessions.sqlite"]!.exec("CREATE TABLE agent_session_events(sequence INTEGER, session_id TEXT,event_type TEXT,artifact_hash TEXT,payload_json TEXT); CREATE TABLE agent_compacted_checkpoint_idempotency(session_id TEXT,idempotency_key TEXT,artifact_hash TEXT); CREATE TABLE agent_artifact_cleanup(hash TEXT); CREATE TABLE agent_transcript_turns(text TEXT); CREATE TABLE agent_transcript_checkpoints(sequence INTEGER)");
  dbs["sessions.sqlite"]!.prepare("INSERT INTO agent_session_events VALUES (1,'session','session.submitted',?,'{}')").run(changeset.hash);
  dbs["sessions.sqlite"]!.prepare("INSERT INTO agent_session_events VALUES (0,'session','session.created',NULL,?)").run(JSON.stringify({ runId: "run_t8_spine", actor: { role: "worker", id: "worker" } }));
  dbs["sessions.sqlite"]!.prepare("INSERT INTO agent_compacted_checkpoint_idempotency VALUES ('session','checkpoint',?)").run(checkpoint.hash);
  dbs["sessions.sqlite"]!.prepare("INSERT INTO agent_artifact_cleanup VALUES (?)").run("a".repeat(64));
  const input: A1CaptureInput = { destination: join(root, "external-capture"), fixtureRoot, project, state, runRoot, runId: "run_t8_spine", phase: "failed-body" };
  const closedDatabases = new Set<DatabaseSync>();
  const cleanup = () => {
    for (const db of Object.values(dbs)) {
      if (closedDatabases.has(db)) continue;
      db.close(); closedDatabases.add(db);
    }
    const target = fs.realpathSync.native(root); const rel = relative(fs.realpathSync.native(tmpdir()), target);
    assert.ok(rel && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel));
    fs.rmSync(target, { recursive: true, force: true });
  };
  return { root, input, binary, raw, nested, changeDiff, checkpoint, artifacts, dbs, cleanup };
}

test("A1 copies actual WAL rows, required nested/historical bytes and binary payloads, preserving opaque digests", async () => {
  const f = await fixture();
  try {
    const receipt = await captureA1Terminal(f.input);
    assert.deepEqual(fs.readFileSync(join(f.input.destination, "artifacts", f.raw.hash)), f.binary);
    assert.ok(receipt.references.some((r) => r.origin.startsWith("agent_compacted_checkpoint_idempotency")));
    assert.ok(receipt.references.some((r) => r.origin.includes("/messages/")));
    assert.equal(receipt.sources.length, 2); assert.equal(receipt.databaseFiles.length, 5);
    assert.equal(receipt.beforeDigest, receipt.afterDigest);
    assert.ok(fs.existsSync(join(f.input.destination, "failed-body.json")));
    assert.ok(!fs.existsSync(join(f.input.destination, "complete.json")), "diagnostics cannot publish successful terminal receipt");
    const actual = JSON.parse(fs.readFileSync(join(f.input.destination, "sessions.sqlite.json"), "utf8"));
    assert.equal(actual.tables.agent_artifact_cleanup.length, 1);
  } finally { f.cleanup(); }
});
for (const missing of ["nested-raw", "compacted-checkpoint", "nested-diff"] as const) test("A1 refuses missing required " + missing + " bytes", async () => {
  const f = await fixture();
  try {
    const hash = missing === "nested-raw" ? f.nested.hash : missing === "nested-diff" ? f.changeDiff.hash : f.checkpoint.hash;
    fs.unlinkSync(join(f.input.state, "artifacts", hash.slice(0, 2), hash));
    await assert.rejects(captureA1Terminal(f.input), /Missing required A1 artifact/);
    assert.ok(!fs.existsSync(join(f.input.destination, "complete.json")));
    assert.ok(!fs.existsSync(join(f.input.destination, "failed-body.json")));
  } finally { f.cleanup(); }
});
test("A1 rejects corrupted original bytes instead of trusting the hash filename", async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(join(f.input.state, "artifacts", f.raw.hash.slice(0, 2), f.raw.hash), "corrupt");
    await assert.rejects(captureA1Terminal(f.input), /original payload hash mismatch/);
  } finally { f.cleanup(); }
});
test("A1 refuses changed store watermarks after copying", async () => {
  const f = await fixture();
  try {
    await assert.rejects(captureA1Terminal(f.input, { afterRead: () => f.dbs["budget.sqlite"]!.exec("INSERT INTO budget_events VALUES ('changed')") }), /stores changed/);
    assert.ok(!fs.existsSync(join(f.input.destination, "failed-body.json")));
  } finally { f.cleanup(); }
});
test("A1 refuses stale partial destination without overwriting it", async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(f.input.destination); const marker = join(f.input.destination, "sentinel"); fs.writeFileSync(marker, f.binary);
    await assert.rejects(captureA1Terminal(f.input), { code: "EEXIST" });
    assert.deepEqual(fs.readFileSync(marker), f.binary); assert.equal(fs.readdirSync(f.input.destination).length, 1);
  } finally { f.cleanup(); }
});
test("A1 refuses destination under state and canonical parent junction aliases", async () => {
  const f = await fixture();
  try {
    await assert.rejects(captureA1Terminal({ ...f.input, destination: join(f.input.state, "capture") }), /overlaps/);
    const alias = join(f.root, "alias"); fs.symlinkSync(f.input.state, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(captureA1Terminal({ ...f.input, destination: join(alias, "capture") }), /aliases|overlaps/);
  } finally { f.cleanup(); }
});
test("A1 missing read-only database cannot become an empty successful store", async () => {
  const f = await fixture();
  try {
    await assert.rejects(captureA1Terminal({ ...f.input, runRoot: f.input.project }));
    assert.ok(fs.existsSync(join(f.input.destination, "incomplete.json")));
    assert.ok(!fs.existsSync(join(f.input.project, "scheduler.sqlite")));
  } finally { f.cleanup(); }
});
test("A1 publication failure preserves partial facts and issues no completion receipt", async () => {
  const f = await fixture(); const sentinel = new Error("publication sentinel");
  try {
    await assert.rejects(captureA1Terminal(f.input, { beforeWrite: (name) => { if (name === "failed-body.json") throw sentinel; } }), (e) => e === sentinel);
    assert.ok(fs.existsSync(join(f.input.destination, "incomplete.json")));
    assert.ok(!fs.existsSync(join(f.input.destination, "failed-body.json")));
  } finally { f.cleanup(); }
});
test("A1 reader preserves query and close error identities", () => {
  const query = new Error("query"); const close = new Error("close");
  assert.throws(() => readA1Database("inert", () => ({ exec() {}, prepare() { throw query; }, close() { throw close; } }) as unknown as DatabaseSync), (e) => e instanceof AggregateError && e.errors[0] === query && e.errors[1] === close);
});
test("A1 external writer completes short writes and preserves flush/close failures", () => {
  const bytes = Buffer.from([0, 255, 13, 10]); const output = Buffer.alloc(4); let closed = 0;
  const io = { openSync: () => 1, writeSync: (_fd: number, b: Uint8Array, offset: number) => { output[offset] = b[offset]!; return 1; }, fsyncSync() {}, closeSync() { closed++; }, readFileSync: () => output } as unknown as Pick<typeof fs, "openSync" | "writeSync" | "fsyncSync" | "closeSync" | "readFileSync">;
  writeA1File("inert", bytes, io); assert.deepEqual(output, bytes); assert.equal(closed, 1);
  const flush = new Error("flush"); const close = new Error("close");
  assert.throws(() => writeA1File("inert", bytes, { ...io, fsyncSync() { throw flush; }, closeSync() { throw close; } }), (e) => e instanceof AggregateError && e.errors[0] === flush && e.errors[1] === close);
  assert.throws(() => writeA1File("inert", bytes, { ...io, writeSync: (() => 0) as typeof fs.writeSync }), /incomplete write/);
});
for (const failClose of [false, true]) test("A1 teardown preserves body/capture/close identities and removal eligibility: close failure=" + failClose, async () => {
  const body = new Error("body"); const capture = new Error("capture"); const close = new Error("close"); const order: string[] = [];
  await assert.rejects(finishA1Capture({ bodyFailed: true, bodyError: body, capture: async () => { order.push("capture"); throw capture; }, close: async () => { order.push("close"); if (failClose) throw close; }, remove: () => { order.push("remove"); } }), (e) => e instanceof AggregateError && e.errors.length === (failClose ? 3 : 2) && e.errors[0] === body && e.errors[1] === capture && (!failClose || e.errors[2] === close));
  assert.deepEqual(order, failClose ? ["capture", "close"] : ["capture", "close", "remove"]);
});
test("A1 sole body throw undefined and sole removal failure are preserved exactly", async () => {
  let caught = false;
  try { await finishA1Capture({ bodyFailed: true, bodyError: undefined, capture: async () => {}, close: async () => {}, remove() {} }); }
  catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true);
  const remove = new Error("remove");
  await assert.rejects(finishA1Capture({ bodyFailed: false, capture: async () => {}, close: async () => {}, remove() { throw remove; } }), (e) => e === remove);
});
test("A1 awaited barrier settles before close/removal and disabled actual finally performs no capture I/O", async () => {
  const order: string[] = []; let release!: () => void; const barrier = new Promise<void>((r) => { release = r; });
  const finishing = finishA1Capture({ bodyFailed: false, capture: async () => { order.push("capture"); await barrier; }, close: async () => { order.push("close"); }, remove() { order.push("remove"); } });
  await Promise.resolve(); assert.deepEqual(order, ["capture"]); release(); await finishing; assert.deepEqual(order, ["capture", "close", "remove"]);
  const sourcePath = new URL("./t8-final-qualification.test.ts", import.meta.url);
  const source = ts.createSourceFile("a1.ts", fs.readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
  const node = source.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && ts.isStringLiteral(s.expression.arguments[0]!) && s.expression.arguments[0].text.startsWith("T8-A1 synthetic"));
  assert.ok(node && ts.isExpressionStatement(node) && ts.isCallExpression(node.expression));
  const callback = node.expression.arguments[1]!; assert.ok(ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const bodyTry = callback.body.statements.find(ts.isTryStatement)!; assert.ok(bodyTry.finallyBlock);
  const disabledOrder: string[] = [];
  await runInNewContext("(async()=> " + bodyTry.finallyBlock.getText(source) + ")()", { a1CaptureDestination: undefined, served: { close: async () => disabledOrder.push("close") }, rmSync: () => disabledOrder.push("remove"), root: "inert", finishA1Capture: () => assert.fail("disabled capture I/O") });
  assert.deepEqual(disabledOrder, ["close", "remove"]);
});
test("A1 known successful artifact.read is a required edge while failed requests and opaque JSON are not", () => {
  const original = { turns: 1, seenCallIds: [], messages: [{ role: "tool", content: { toolName: "artifact.read", isError: false, content: [{ type: "json", value: { hash: "f".repeat(64) } }] } }] };
  assert.equal(a1NestedReferences("checkpoint", Buffer.from(JSON.stringify(original)), "control")[0]?.hash, "f".repeat(64));
  original.messages[0]!.content.isError = true;
  assert.equal(a1NestedReferences("checkpoint", Buffer.from(JSON.stringify(original)), "control").length, 0);

});

test("A1 retains original binary Git commit/tree/blob objects after fixture cleanup", async () => {
  const f = await fixture();
  const destination = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "aiboard-a1-retained-control-"))); fs.rmdirSync(destination);
  try {
    fs.writeFileSync(join(f.input.project, "binary.dat"), f.binary);
    await runGitBytes({ cwd: f.input.project, args: ["add", "binary.dat"] });
    await runGitBytes({ cwd: f.input.project, args: ["commit", "--quiet", "-m", "fixture"] });
    const commit = (await runGitBytes({ cwd: f.input.project, args: ["rev-parse", "HEAD"] })).stdout.toString("utf8").trim();
    f.dbs["scheduler.sqlite"]!.prepare("INSERT INTO scheduler_events VALUES ('snapshot','run_t8_spine',3,'project_docs.handoff_snapshot_committed','2026-10-13T00:00:00Z','{\"role\":\"runner\",\"id\":\"test\"}','snapshot',?)").run(JSON.stringify({ commit, stopKind: "paused" }));
    const receipt = await captureA1Terminal({ ...f.input, destination });
    const blob = receipt.snapshots[0]!.entries.find((e) => e.path === "binary.dat")!;
    assert.deepEqual(fs.readFileSync(join(destination, "git", blob.oid!)), f.binary);
    f.cleanup();
    assert.ok(!fs.existsSync(f.input.fixtureRoot));
    assert.deepEqual(fs.readFileSync(join(destination, "git", blob.oid!)), f.binary);
    assert.ok(receipt.gitObjects.some((o) => o.type === "commit") && receipt.gitObjects.some((o) => o.type === "tree"));
  } finally {
    if (fs.existsSync(f.root)) f.cleanup();
    const rel = relative(fs.realpathSync.native(tmpdir()), fs.realpathSync.native(destination));
    assert.ok(rel && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../") && !isAbsolute(rel));
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test("A1 rechecks external corpus bytes before publishing the receipt", async () => {
  const f = await fixture();
  try {
    await assert.rejects(captureA1Terminal(f.input, { beforeWrite: (name) => {
      if (name === "failed-body.json") fs.writeFileSync(join(f.input.destination, "artifacts", f.raw.hash), "changed after copy");
    } }), /external corpus changed/);
    assert.ok(!fs.existsSync(join(f.input.destination, "failed-body.json")));
  } finally { f.cleanup(); }
});

function captureWithFs(io: typeof fs): typeof captureA1Terminal {
  const url = new URL("./support/a1-terminal-capture.ts", import.meta.url);
  const source = fs.readFileSync(url, "utf8").replaceAll("import.meta.url", JSON.stringify(url.href));
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  const actualRequire = createRequire(url);
  runInNewContext(compiled, { exports, require: (name: string) => name === "node:fs" ? io : actualRequire(name), Buffer, TextDecoder, URL, performance, process, console, __filename: fileURLToPath(url) });
  return exports.captureA1Terminal as typeof captureA1Terminal;
}
for (const failure of ["flush", "close", "read-back"] as const) test("A1 actual receipt " + failure + " failure leaves no success-named marker", async () => {
  const f = await fixture(); const sentinel = new Error("actual receipt " + failure); const receiptFds = new Set<number>();
  try {
    const io = { ...fs,
      openSync: ((path: fs.PathLike, flags: string) => { const fd = fs.openSync(path, flags); if (/receipt\.pending\.json$|failed-body\.json$/.test(String(path))) receiptFds.add(fd); return fd; }) as typeof fs.openSync,
      fsyncSync: (fd: number) => { if (failure === "flush" && receiptFds.has(fd)) throw sentinel; fs.fsyncSync(fd); },
      closeSync: (fd: number) => { fs.closeSync(fd); if (failure === "close" && receiptFds.has(fd)) throw sentinel; },
      readFileSync: ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => { if (failure === "read-back" && /receipt\.pending\.json$|failed-body\.json$/.test(String(path))) throw sentinel; return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...args); }) as typeof fs.readFileSync,
    };
    await assert.rejects(captureWithFs(io)(f.input));
    assert.ok(!fs.existsSync(join(f.input.destination, "complete.json")) && !fs.existsSync(join(f.input.destination, "failed-body.json")), "failed publication must not expose a successful marker");
  } finally { f.cleanup(); }
});
test("A1 rejects primary-checkout capture destination before any write", async () => {
  const f = await fixture(); let attempted = false;
  try {
    const checkout = fileURLToPath(new URL("../../", import.meta.url));
    const primary = checkout.replace(/[\\/]\.worktrees[\\/][^\\/]+[\\/]?$/, "");
    const destination = join(primary, "a1-capture-must-never-be-created-" + process.pid);
    assert.ok(!fs.existsSync(destination));
    const io = { ...fs, mkdirSync: ((path: fs.PathLike, ...args: unknown[]) => { if (String(path) === destination) { attempted = true; throw new Error("write inside primary was attempted"); } return (fs.mkdirSync as (...args: unknown[]) => unknown)(path, ...args); }) as typeof fs.mkdirSync };
    await assert.rejects(captureWithFs(io)({ ...f.input, destination }), /overlaps/);
    assert.equal(attempted, false); assert.ok(!fs.existsSync(destination));
  } finally { f.cleanup(); }
});
test("A1 rejects context row key that disagrees with payload manifest identity", async () => {
  const f = await fixture();
  try {
    const manifest = { manifestId: "payload-id", runId: "run_t8_spine", sessionId: "session", recordedAt: "now", purpose: "worker", estimatedTokens: 1, sections: [], omissions: [] };
    f.dbs["context-manifests.sqlite"]!.prepare("INSERT INTO context_manifests VALUES ('row-id','run_t8_spine','session','now',?)").run(JSON.stringify(manifest));
    await assert.rejects(captureA1Terminal(f.input), /manifest.*identity|manifest_id|payload-id|row-id/);
  } finally { f.cleanup(); }
});
test("A1 returned and persisted receipt indexes are identical and omit self-entry", async () => {
  const f = await fixture();
  try {
    const receipt = await captureA1Terminal(f.input);
    const stored = JSON.parse(fs.readFileSync(join(f.input.destination, "failed-body.json"), "utf8"));
    assert.deepEqual(receipt.files, stored.files);
    assert.ok(!receipt.files.some((file) => /complete\.json|failed-body\.json|receipt\.pending\.json/.test(file.path)));
  } finally { f.cleanup(); }
});

for (const association of ["foreign", "missing"] as const) test("A1 refuses " + association + " actual session run association", async () => {
  const f = await fixture();
  try {
    f.dbs["sessions.sqlite"]!.exec(association === "missing" ? "DELETE FROM agent_session_events WHERE event_type='session.created'" : "UPDATE agent_session_events SET payload_json='{\"runId\":\"foreign\"}' WHERE event_type='session.created'");
    await assert.rejects(captureA1Terminal(f.input), /session.*association|session.*run|run.*session/);
  } finally { f.cleanup(); }
});
test("A1 refuses validation observation with foreign actual run_id", async () => {
  const f = await fixture();
  try {
    f.dbs["evidence.sqlite"]!.exec("INSERT INTO validation_observations VALUES ('observation','foreign','[]')");
    await assert.rejects(captureA1Terminal(f.input), /observation.*run|run.*observation/);
  } finally { f.cleanup(); }
});
