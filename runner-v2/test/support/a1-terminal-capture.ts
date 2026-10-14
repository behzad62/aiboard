import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { rebuildSchedulerProjection } from "../../src/scheduler-store.js";
import { assertApprovedSourceManifest, assertManifestMatchesBytes, verifyAmendmentReferencesPredecessor } from "../../src/source-manifest.js";
import { a1NestedReferences, a1Roots, type A1Row, type A1Stores, type A1Tables } from "./a1-terminal-references.js";

import { runGitBytes } from "./git-fixture.js";

export const A1_CAPTURE_ENV = "RUNNER_V2_T8_A1_TERMINAL_CAPTURE_DIR";
export const A1_DATABASES = ["scheduler.sqlite", "context-manifests.sqlite", "evidence.sqlite", "budget.sqlite", "sessions.sqlite"] as const;
const checkoutRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (value: unknown) => Buffer.from(JSON.stringify(value, (_key, v: unknown) =>
  typeof v === "bigint" ? { sqliteInteger: v.toString() } : v instanceof Uint8Array ? { sqliteBlobBase64: Buffer.from(v).toString("base64") } : v) + "\n");
const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r)); };
function throwErrors(errors: unknown[], label: string): void { if (errors.length === 1) throw errors[0]; if (errors.length > 1) throw new AggregateError(errors, label); }


/** Resolve the real primary checkout from this checkout's trusted Git metadata, without spawning. */
export function a1ProtectedCheckouts(): string[] {
  const checkout = fs.realpathSync(checkoutRoot);
  const marker = join(checkout, ".git");
  const details = fs.lstatSync(marker);
  let gitDirectory: string;
  if (details.isDirectory()) gitDirectory = fs.realpathSync(marker);
  else {
    assert.ok(details.isFile(), "A1 checkout Git metadata is unavailable");
    const parsed = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(marker, "utf8"));
    assert.ok(parsed, "A1 checkout Git directory is malformed");
    gitDirectory = fs.realpathSync(resolve(checkout, parsed[1]!));
  }
  const commonFile = join(gitDirectory, "commondir");
  const common = fs.existsSync(commonFile)
    ? fs.realpathSync(resolve(gitDirectory, fs.readFileSync(commonFile, "utf8").trim())) : gitDirectory;
  assert.equal(basename(common), ".git", "A1 primary checkout identity cannot be established");
  const primary = fs.realpathSync(dirname(common));
  assert.equal(fs.realpathSync(join(primary, ".git")), common, "A1 primary checkout metadata identity mismatch");
  return [...new Set([checkout, primary])];
}

/** A passive copy barrier. It never changes runtime, cleanup authority, or semantic completeness. */
export interface A1CaptureInput {
  destination: string; fixtureRoot: string; project: string; state: string; runRoot: string; runId: string;
  phase: "terminal-success" | "failed-body";
  expectedManifestIds?: readonly string[];
  observedRollup?: readonly [string, { passes: number; tokens: number }][];
}
export interface A1CaptureHooks {
  afterRead?: () => void;
  beforeWrite?: (relativePath: string) => void;
  openDatabase?: (path: string) => Pick<DatabaseSync, "exec" | "prepare" | "close">;
}
export async function finishA1Capture(input: {
  bodyFailed: boolean; bodyError?: unknown; capture: () => Promise<unknown>;
  close: () => Promise<void>; remove: () => void;
}): Promise<void> {
  const errors: unknown[] = input.bodyFailed ? [input.bodyError] : [];
  try { await input.capture(); } catch (error) { errors.push(error); }
  let closed = false;
  try { await input.close(); closed = true; } catch (error) { errors.push(error); }
  if (closed) { try { input.remove(); } catch (error) { errors.push(error); } }
  throwErrors(errors, "A1 body, terminal capture and original teardown failures");
}

export function readA1Database(path: string, openDatabase = (p: string): Pick<DatabaseSync, "exec" | "prepare" | "close"> => new DatabaseSync(p, { readOnly: true })): A1Tables {
  const db = openDatabase(path);
  const errors: unknown[] = [];
  const tables: A1Tables = {};
  let begun = false;
  try {
    db.exec("BEGIN"); begun = true;
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    tables.__schema = schema as A1Row[];
    for (const row of schema) {
      const name = String(row.name);
      const quote = '"' + name.replace(/"/g, '""') + '"';
      const rows = db.prepare("SELECT * FROM " + quote).all() as A1Row[];
      tables[name] = rows.sort((a, b) => Buffer.compare(bytesOf(a), bytesOf(b)));
    }
  } catch (error) { errors.push(error); }
  if (begun) { try { db.exec("ROLLBACK"); } catch (error) { errors.push(error); } }
  try { db.close(); } catch (error) { errors.push(error); }
  throwErrors(errors, "A1 read-only SQLite collection/transaction/close failures");
  return tables;
}

/** Exclusive, complete, flushed and read-back verified; a failed close remains a failure. */
export function writeA1File(path: string, bytes: Buffer, io: Pick<typeof fs, "openSync" | "writeSync" | "fsyncSync" | "closeSync" | "readFileSync"> = fs): void {
  const fd = io.openSync(path, "wx"); const errors: unknown[] = [];
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.writeSync(fd, bytes, offset, bytes.length - offset, null);
      assert.ok(Number.isInteger(count) && count > 0 && count <= bytes.length - offset, "A1 incomplete write");
      offset += count;
    }
    io.fsyncSync(fd);
  } catch (error) { errors.push(error); }
  try { io.closeSync(fd); } catch (error) { errors.push(error); }
  throwErrors(errors, "A1 external write/flush/close failures");
  const actual = io.readFileSync(path);
  assert.ok(actual.equals(bytes), "A1 publication read-back byte mismatch");
}

export async function captureA1Terminal(input: A1CaptureInput, hooks: A1CaptureHooks = {}) {
  const started = performance.now(); const startedUtc = new Date().toISOString();
  assert.ok(isAbsolute(input.destination), "A1 destination must be absolute");
  const forbidden = [...a1ProtectedCheckouts(), input.fixtureRoot, input.project, input.state, input.runRoot].map((p) => fs.realpathSync(p));
  const parent = fs.realpathSync(dirname(input.destination));
  const equivalent = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  assert.ok(equivalent(parent, resolve(dirname(input.destination))), "A1 destination parent aliases are refused");
  const destination = join(parent, relative(dirname(input.destination), input.destination));
  for (const root of forbidden) assert.ok(!inside(destination, root) && !inside(root, destination), "A1 destination overlaps a protected root");
  fs.mkdirSync(destination); // Exclusive new attempt: existing directories, files and links are refused.
  assert.ok(equivalent(fs.realpathSync(destination), destination), "A1 claimed destination identity changed");
  const files: { path: string; sha256: string; bytes: number }[] = [];
  let totalBytes = 0;
  const publish = (name: string, bytes: Buffer) => {
    totalBytes += bytes.length;
    assert.ok(totalBytes <= 1024 * 1024 * 1024 && files.length < 250_000, "A1 finite fixture corpus budget exhausted");
    hooks.beforeWrite?.(name);
    if (name === "receipt.pending.json") {
      for (const file of files) {
        const path = join(destination, file.path);
        assert.ok(fs.lstatSync(path).isFile() && !fs.lstatSync(path).isSymbolicLink(), "A1 external corpus entry identity changed");
        const actual = fs.readFileSync(path);
        assert.ok(actual.length === file.bytes && sha(actual) === file.sha256, "A1 external corpus changed before receipt publication");
      }
    }
    writeA1File(join(destination, name), bytes);
    const entry = { path: name, sha256: sha(bytes), bytes: bytes.length }; files.push(entry); return entry;
  };
  try {
    const readStores = () => Object.fromEntries(A1_DATABASES.map((name) => [name, readA1Database(join(input.runRoot, name), hooks.openDatabase)])) as A1Stores;
    const stores = readStores();
    hooks.afterRead?.();
    const beforeDigest = sha(bytesOf(stores));
    const { refs, events, manifests, sources } = a1Roots(stores, input.runId);
    const dbFiles = A1_DATABASES.map((name) => publish(name + ".json", bytesOf({ database: name, tables: stores[name] })));
    fs.mkdirSync(join(destination, "artifacts")); fs.mkdirSync(join(destination, "git"));
    const payloads = new Map<string, { path: string; sha256: string; bytes: number }>();
    const artifactRoot = join(input.state, "artifacts");
    for (const prefix of fs.readdirSync(artifactRoot).sort()) {
      assert.ok(/^[a-f0-9]{2}$/.test(prefix), "Unexpected A1 ArtifactStore directory");
      const folder = join(artifactRoot, prefix);
      assert.ok(fs.lstatSync(folder).isDirectory() && !fs.lstatSync(folder).isSymbolicLink(), "A1 artifact directory alias refused");
      for (const name of fs.readdirSync(folder).sort()) {
        if (/^[a-f0-9]{64}\.json$/.test(name)) continue; // Sidecars are explicitly not retained/claimed.
        assert.ok(/^[a-f0-9]{64}$/.test(name) && name.startsWith(prefix), "Unexpected A1 payload name");
        const source = join(folder, name);
        assert.ok(fs.lstatSync(source).isFile() && !fs.lstatSync(source).isSymbolicLink(), "A1 payload alias refused");
        const bytes = fs.readFileSync(source); assert.equal(sha(bytes), name, "A1 original payload hash mismatch");
        payloads.set(name, publish("artifacts/" + name, bytes));
      }
    }
    const visited = new Set<string>();
    for (let i = 0; i < refs.length; i++) {
      assert.ok(i < 1_000_000, "A1 reference corpus budget exhausted");
      const ref = refs[i]!;
      assert.ok(payloads.has(ref.hash), "Missing required A1 artifact " + ref.hash + " at " + ref.origin);
      const key = ref.kind + ":" + ref.hash;
      if (visited.has(key)) continue;
      visited.add(key);
      refs.push(...a1NestedReferences(ref.kind, fs.readFileSync(join(destination, "artifacts", ref.hash)), "artifact/" + ref.hash));
    }
    for (const source of sources) {
      assertApprovedSourceManifest(source);
      assertManifestMatchesBytes(source, fs.readFileSync(join(destination, "artifacts", source.artifactDigest)));
      if (source.amendment) {
        const prior = sources.find((entry) => entry.manifestId === source.amendment!.priorManifestId);
        assert.ok(prior, "A1 source amendment predecessor is absent"); verifyAmendmentReferencesPredecessor(source, prior);
      }
    }
    const rollupMap = new Map<string, { passes: number; tokens: number }>();
    for (const manifest of manifests) {
      const row = rollupMap.get(manifest.purpose) ?? { passes: 0, tokens: 0 };
      row.passes++; row.tokens += manifest.estimatedTokens; rollupMap.set(manifest.purpose, row);
      if (manifest.packArtifactHash) {
        const pack = payloads.get(manifest.packArtifactHash)!;
        assert.equal(pack.sha256, manifest.packDigest); assert.equal(pack.bytes, manifest.byteLength);
      }
    }
    const manifestIds = manifests.map((m) => m.manifestId).sort();
    const rollup = [...rollupMap.entries()].sort();
    if (input.expectedManifestIds) assert.deepEqual(manifestIds, [...input.expectedManifestIds].sort(), "A1 terminal manifest set differs from observed console facts");
    if (input.observedRollup) assert.deepEqual(rollup, input.observedRollup, "A1 terminal estimated-token rollup differs from original console facts");
    const snapshots = events.filter((e) => e.type === "project_docs.handoff_snapshot_committed");
    const gitObjects = new Map<string, { oid: string; type: string; path: string; sha256: string; bytes: number }>();
    const git = async (args: string[]) => (await runGitBytes({ cwd: input.project, args })).stdout;
    const objectFormat = (await git(["rev-parse", "--show-object-format"])).toString("utf8").trim();
    assert.ok(objectFormat === "sha1" || objectFormat === "sha256");
    const gitObject = async (oid: unknown, type: string) => {
      assert.ok(typeof oid === "string" && (objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(oid), "Invalid A1 Git object identity");
      if (gitObjects.has(oid)) { assert.equal(gitObjects.get(oid)!.type, type); return; }
      const bytes = await git(["cat-file", type, oid]);
      assert.equal(createHash(objectFormat).update(Buffer.from(type + " " + bytes.length + "\0")).update(bytes).digest("hex"), oid, "Git raw object identity mismatch");
      gitObjects.set(oid, { oid, type, ...publish("git/" + oid, bytes) });
    };
    const snapshotEntries = [];
    for (const event of snapshots) {
      const commit = String(event.payload.commit); await gitObject(commit, "commit");
      const rawCommit = fs.readFileSync(join(destination, "git", commit)).toString("utf8");
      const rootTree = /^tree ([a-f0-9]+)$/m.exec(rawCommit)?.[1]; await gitObject(rootTree, "tree");
      for (const parent of rawCommit.matchAll(/^parent ([a-f0-9]+)$/gm)) await gitObject(parent[1], "commit");
      const treeBytes = await git(["ls-tree", "-r", "-t", "-z", commit]);
      const entries = [];
      for (const line of new TextDecoder("utf-8", { fatal: true }).decode(treeBytes).split("\0").filter(Boolean)) {
        const match = /^(\d+) (blob|tree) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        assert.ok(match, "Unsupported A1 snapshot tree entry");
        await gitObject(match[3], match[2]!); entries.push({ mode: match[1], type: match[2], oid: match[3], path: match[4] });
      }
      snapshotEntries.push({ eventId: event.eventId, sequence: event.sequence, payload: event.payload, commit, rootTree, entries });
    }
    if (input.phase === "terminal-success") {
      const projection = rebuildSchedulerProjection(events);
      assert.equal(projection.status, "completed"); assert.equal(projection.projectHandoff?.choice, "keep_integration_branch");
      assert.ok(events.some((e) => e.type === "project.handoff_selected" && e.payload.choice === "keep_integration_branch"));
      assert.ok(sources.length >= 2 && snapshots.some((e) => e.payload.stopKind === "paused") && snapshots.some((e) => e.payload.stopKind === "completed"), "A1 terminal source/snapshot corpus is incomplete");
      assert.ok(input.expectedManifestIds && input.observedRollup && manifests.length > 0, "A1 successful body manifest facts are required");
    }
    const afterDigest = sha(bytesOf(readStores()));
    assert.equal(afterDigest, beforeDigest, "A1 stores changed during sequential terminal collection");
    const identities = Object.fromEntries(["runner-v2/test/t8-final-qualification.test.ts", "runner-v2/test/support/a1-terminal-capture.ts", "runner-v2/test/support/a1-terminal-references.ts"].map((p) => [p, sha(fs.readFileSync(join(checkoutRoot, p)))]));
    const watermark = events.length ? { count: events.length, first: events[0]!.sequence, last: events.at(-1)!.sequence, eventId: events.at(-1)!.eventId, eventType: events.at(-1)!.type } : { count: 0 };
    const receipt = { schema: 1, phase: input.phase, runId: input.runId, fixtureRoot: fs.realpathSync(input.fixtureRoot), project: fs.realpathSync(input.project), state: fs.realpathSync(input.state), runRoot: fs.realpathSync(input.runRoot), destination,
      identities, startedUtc, elapsedMs: performance.now() - started,
      collection: "sequential read-only transactions; all five store bundles identical before/after, not a cross-database atomicity claim", beforeDigest, afterDigest, watermark,
      databaseFiles: dbFiles, manifestIds, rollup, sources, references: refs, snapshots: snapshotEntries, gitObjects: [...gitObjects.values()], files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
      limitations: ["ArtifactStore sidecar metadata not copied", "Optional absent rendered packs not reconstructed", "Fixture estimates/reported usage are not paid-provider invoices", "No streaming-session authority/universal cleanup claim", "Collection receipt is not semantic acceptance"],
    };
    const marker = input.phase === "terminal-success" ? "complete.json" : "failed-body.json";
    hooks.beforeWrite?.(marker);
    // Flush, close and verify a nonsuccess stage before the final name can exist.
    publish("receipt.pending.json", bytesOf(receipt));
    // Same-directory hardlink is atomic and exclusive: never overwrites a prior marker.
    fs.linkSync(join(destination, "receipt.pending.json"), join(destination, marker));
    return receipt;
  } catch (error) {
    const failures = [error];
    try { writeA1File(join(destination, "incomplete.json"), bytesOf({ phase: input.phase, runId: input.runId, error: String(error), files, elapsedMs: performance.now() - started })); }
    catch (secondary) { failures.push(secondary); }
    throwErrors(failures, "A1 capture and failure-publication errors"); throw error;
  }
}
