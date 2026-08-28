import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  BoundedOutputSpool,
  cleanupOutputSpillRoot,
  createNodeOutputSpillStorage,
  type OutputSpillFile,
  type OutputSpillStorage,
} from "../src/bounded-output-spool.js";

const KIB = 1024;
const MIB = 1024 * KIB;

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "runner-v2-output-spool-test-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

function stream(result: Awaited<ReturnType<BoundedOutputSpool["finalize"]>>, name: "stdout" | "stderr") {
  return result.streams.find((candidate) => candidate.stream === name)!;
}

test("keeps independent default 128 KiB byte tails across multibyte and interleaved chunks", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool({ spillRoot: root });
  const stdout = Buffer.concat([
    Buffer.alloc(128 * KIB - 2, 0x61),
    Buffer.from("🙂"),
  ]);

  await spool.write("stdout", stdout.subarray(0, stdout.length - 1));
  await spool.write("stderr", Buffer.from("err-one"));
  await spool.write("stdout", stdout.subarray(stdout.length - 1));
  await spool.write("stderr", Buffer.from("-err-two"));
  await spool.write("stdout", Buffer.from("Z"));
  const result = await spool.finalize();

  const out = stream(result, "stdout");
  assert.equal(Buffer.byteLength(out.tail), 128 * KIB);
  assert.equal(out.tail, `${"a".repeat(128 * KIB - 5)}🙂Z`);
  assert.equal(out.totalBytes, 128 * KIB + 3);
  assert.equal(out.truncated, true);
  assert.equal(out.lossyOutput, false);
  assert.equal(stream(result, "stderr").tail, "err-one-err-two");
  assert.equal(JSON.stringify(result).includes(root), false);
});

test("spills exactly 64 MiB per stream and continues lossily with bounded marked tails", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool({ spillRoot: root });
  const cap = Buffer.alloc(64 * MIB, 0x78);

  await spool.write("stdout", cap);
  await spool.write("stdout", Buffer.from("after-cap"));
  await spool.write("stderr", Buffer.concat([cap, Buffer.from("stderr-overflow")]));
  const result = await spool.finalize();

  for (const [name, overflow] of [["stdout", 9], ["stderr", 15]] as const) {
    const output = stream(result, name);
    assert.equal(output.spillBytes, 64 * MIB);
    assert.equal(output.totalBytes, 64 * MIB + overflow);
    assert.equal(output.lossyBytes, overflow);
    assert.equal(output.lossyOutput, true);
    assert.equal(output.lossReason?.code, "spill_cap_exceeded");
    assert.equal(output.spillState, "lossy");
    assert.match(output.tail, /^\[runner output lossy: spill_cap_exceeded\]\n/);
    assert.ok(Buffer.byteLength(output.tail) <= 128 * KIB);
  }
  await assert.doesNotReject(spool.cleanup());
  await assert.doesNotReject(spool.cleanup());
  assert.deepEqual(await createNodeOutputSpillStorage().list(root), []);
});

test("uses create-exclusive private spill files and finalizes them through ArtifactStore", async (t) => {
  const root = await temporaryRoot(t);
  const artifactRoot = await temporaryRoot(t);
  const paths: string[] = [];
  const nodeStorage = createNodeOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      paths.push(path);
      return await nodeStorage.openExclusive(path);
    },
  };
  const collisionPath = join(root, "collision.tmp");
  await nodeStorage.prepareRoot(root);
  const collisionFile = await nodeStorage.openExclusive(collisionPath);
  await assert.rejects(nodeStorage.openExclusive(collisionPath), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  await collisionFile.close();
  await nodeStorage.remove(collisionPath);
  const artifacts = new ArtifactStore(artifactRoot);
  const spool = new BoundedOutputSpool({ spillRoot: root, artifactStore: artifacts, storage });

  await spool.write("stdout", Buffer.from("artifact stdout"));
  if (process.platform !== "win32") {
    assert.equal((await stat(paths[0]!)).mode & 0o077, 0);
  }
  const result = await spool.finalize();
  const output = stream(result, "stdout");

  assert.equal(output.spillState, "artifact_ingested");
  assert.equal((await artifacts.get(output.spillArtifactId!)).toString(), "artifact stdout");
  assert.equal(Object.hasOwn(output, "spillPath"), false);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.deepEqual(await nodeStorage.list(root), []);
});

test("converts spill open failure into typed lossy continuation", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createNodeOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async () => { throw new Error("permission denied"); },
  };
  const spool = new BoundedOutputSpool({ spillRoot: root, tailBytes: 64, spillBytes: 64, storage });

  await assert.doesNotReject(spool.write("stdout", Buffer.from("open failure still drains")));
  await assert.doesNotReject(spool.write("stdout", Buffer.from(" and continues")));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.totalBytes, 39);
  assert.equal(output.spillBytes, 0);
  assert.equal(output.lossyBytes, 39);
  assert.equal(output.lossReason?.code, "spill_open_failed");
  assert.equal(output.truncated, true);
  assert.match(output.tail, /^\[runner output lossy: spill_open_failed\]\n/);
});

test("keeps a marked lossy UTF-8 tail on a complete code-point boundary", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createNodeOutputSpillStorage();
  const spool = new BoundedOutputSpool({
    spillRoot: root,
    tailBytes: 64,
    spillBytes: 64,
    storage: { ...nodeStorage, openExclusive: async () => { throw new Error("denied"); } },
  });

  await spool.write("stdout", Buffer.from("🙂".repeat(20)));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.tail.includes("�"), false);
  assert.match(output.tail, /🙂+$/);
  assert.ok(Buffer.byteLength(output.tail) <= 64);
});

test("converts spill write failure into typed lossy continuation", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createNodeOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path): Promise<OutputSpillFile> => {
      const file = await nodeStorage.openExclusive(path);
      return { ...file, write: async () => { throw new Error("disk full"); } };
    },
  };
  const spool = new BoundedOutputSpool({ spillRoot: root, tailBytes: 64, spillBytes: 64, storage });

  await assert.doesNotReject(spool.write("stderr", Buffer.from("write failure still drains")));
  await assert.doesNotReject(spool.write("stderr", Buffer.from(" and continues")));
  const output = stream(await spool.finalize(), "stderr");

  assert.equal(output.totalBytes, 40);
  assert.equal(output.spillBytes, 0);
  assert.equal(output.lossyBytes, 40);
  assert.equal(output.lossReason?.code, "spill_write_failed");
  assert.deepEqual(await nodeStorage.list(root), []);
});

test("converts spill close failure into typed loss and skips artifact ingestion", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createNodeOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path): Promise<OutputSpillFile> => {
      const file = await nodeStorage.openExclusive(path);
      return { ...file, close: async () => { await file.close(); throw new Error("close failed"); } };
    },
  };
  let ingestions = 0;
  const spool = new BoundedOutputSpool({
    spillRoot: root,
    spillBytes: 8,
    storage,
    artifactStore: { put: async () => { ingestions += 1; return { hash: "unexpected" }; } },
  });

  await spool.write("stdout", Buffer.from("close failure"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.lossyOutput, true);
  assert.equal(output.lossReason?.code, "spill_close_failed");
  assert.equal(output.lossyBytes, Buffer.byteLength("close failure"));
  assert.equal(ingestions, 0);
  assert.deepEqual(await nodeStorage.list(root), []);
});

test("marks artifact ingestion faults lossy and leaves cleanup repeatable", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createNodeOutputSpillStorage();
  const spool = new BoundedOutputSpool({
    spillRoot: root,
    artifactStore: { put: async () => { throw new Error("artifact unavailable"); } },
  });

  await spool.write("stdout", Buffer.from("artifact failure"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.lossReason?.code, "artifact_ingestion_failed");
  assert.equal(output.lossyBytes, Buffer.byteLength("artifact failure"));
  await assert.doesNotReject(spool.cleanup());
  await assert.doesNotReject(spool.cleanup());
  assert.deepEqual(await nodeStorage.list(root), []);
});

test("restart cleanup removes only private spill entries and is idempotent", async (t) => {
  const root = await temporaryRoot(t);
  const storage = createNodeOutputSpillStorage();
  await storage.prepareRoot(root);
  const spill = join(root, "output-spill-abandoned.tmp");
  const unrelated = join(root, "keep.txt");
  await (await storage.openExclusive(spill)).close();
  await (await storage.openExclusive(unrelated)).close();

  await cleanupOutputSpillRoot(root, storage);
  await cleanupOutputSpillRoot(root, storage);

  assert.deepEqual(await storage.list(root), ["keep.txt"]);
});
