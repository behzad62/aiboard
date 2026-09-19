import { createLinkedTestOutputSpillStorage } from "./support/linked-output-spill-storage.js";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  BoundedOutputSpool,
  attestPrivateDirectoryForPrincipal,
  cleanupOutputSpillRoot,
  createNodeOutputSpillStorage,
  type BoundedOutputSpoolOptions,
  type BoundedOutputStreamResult,
  type OutputSpillFile,
  type OutputSpillStorage,
  type OutputSpillStorageAttestation,
} from "../src/bounded-output-spool.js";

const KIB = 1024;
const MIB = 1024 * KIB;

async function temporaryRoot(t: test.TestContext): Promise<string> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const parent = await mkdtemp(join(tmpdir(), "runner-v2-output-spool-test-"));
  t.after(async () => await rm(parent, { recursive: true, force: true }));
  return join(parent, "owned-spills");
}

function spoolOptions(
  spillRoot: string,
  overrides: Partial<BoundedOutputSpoolOptions> = {}
): BoundedOutputSpoolOptions {
  const storage = overrides.storage ?? createLinkedTestOutputSpillStorage();
  return {
    spillRoot,
    projectRoot: process.cwd(),
    ownershipId: "runner-test-owner",
    ...overrides,
    storage: {
      ...storage,
      attest: async () => ({
        currentPrincipalPrivacy: true,
        identityStableDeletion: true,
        unlinkedEntries: false,
      }),
      removeIdentityStable: async (path, identity) => {
        const entry = await lstat(path);
        if (`${entry.dev.toString()}:${entry.ino.toString()}` !== identity) {
          throw new Error("Output spill entry identity changed.");
        }
        await unlink(path);
      },
    },
  };
}

function stream(result: Awaited<ReturnType<BoundedOutputSpool["finalize"]>>, name: "stdout" | "stderr") {
  return result.streams.find((candidate) => candidate.stream === name)!;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("principal privacy attestation rejects owner mismatch independently of restrictive mode", () => {
  assert.equal(attestPrivateDirectoryForPrincipal({ ownerIdentity: "1001", mode: 0o700 }, "1001"), true);
  assert.equal(attestPrivateDirectoryForPrincipal({ ownerIdentity: "1002", mode: 0o700 }, "1001"), false);
});

test("principal privacy attestation rejects permissive mode independently of owner", () => {
  assert.equal(attestPrivateDirectoryForPrincipal({ ownerIdentity: "1001", mode: 0o755 }, "1001"), false);
  assert.equal(attestPrivateDirectoryForPrincipal({ ownerIdentity: "1001", mode: 0o707 }, "1001"), false);
});

for (const [name, attestation] of [
  ["privacy unavailable", { currentPrincipalPrivacy: false, identityStableDeletion: true, unlinkedEntries: false }],
  ["stable deletion unavailable", { currentPrincipalPrivacy: true, identityStableDeletion: false, unlinkedEntries: false }],
] as const) {
  test(`continues tail-only without disk writes when ${name}`, async (t) => {
    const root = await temporaryRoot(t);
    const nodeStorage = createLinkedTestOutputSpillStorage();
    let rootPreparations = 0;
    let opens = 0;
    const storage: OutputSpillStorage = {
      ...nodeStorage,
      attest: async (): Promise<OutputSpillStorageAttestation> => attestation,
      prepareRoot: async () => { rootPreparations += 1; },
      openExclusive: async (path) => { opens += 1; return await nodeStorage.openExclusive(path); },
    };
    const spool = new BoundedOutputSpool({ ...spoolOptions(root), tailBytes: 64, storage });

    await spool.write("stdout", Buffer.from("first private spill unavailable chunk"));
    await spool.write("stdout", Buffer.from(" and draining continues"));
    const output = stream(await spool.finalize(), "stdout");

    assert.equal(rootPreparations, 0);
    assert.equal(opens, 0);
    assert.equal(output.totalBytes, 60);
    assert.equal(output.spillBytes, 0);
    assert.equal(output.lossyBytes, 60);
    assert.equal(output.lossyOutput, true);
    assert.equal(output.lossReason?.code, "private_spill_unavailable");
    await assert.rejects(stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  });
}

for (const [name, attestation] of [
  ["truthy string guarantees", {
    currentPrincipalPrivacy: "unverified",
    identityStableDeletion: "partial",
    unlinkedEntries: false,
  }],
  ["an unknown key", {
    currentPrincipalPrivacy: true,
    identityStableDeletion: true,
    unlinkedEntries: false,
    unexpected: "accepted by an open parser",
  }],
  ["a partial guarantee", {
    currentPrincipalPrivacy: true,
    identityStableDeletion: "unavailable",
    unlinkedEntries: false,
  }],
  ["a missing guarantee", {
    currentPrincipalPrivacy: true,
    unlinkedEntries: false,
  }],
  ["a malformed non-object", "enforced"],
] as const) {
  test(`strictly rejects ${name} before spill filesystem access`, async (t) => {
    const root = await temporaryRoot(t);
    const nodeStorage = createLinkedTestOutputSpillStorage();
    let opens = 0;
    const storage: OutputSpillStorage = {
      ...nodeStorage,
      attest: async () => attestation as unknown as OutputSpillStorageAttestation,
      openExclusive: async () => {
        opens += 1;
        throw new Error("malformed attestation reached disk");
      },
    };
    const spool = new BoundedOutputSpool({ ...spoolOptions(root), storage });

    await spool.write("stdout", Buffer.from("tail only"));
    await assert.rejects(stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    const output = stream(await spool.finalize(), "stdout");

    assert.equal(opens, 0);
    assert.equal(output.lossReason?.code, "private_spill_unavailable");
    assert.equal(output.lossyBytes, 9);
  });
}

test("rejects accessor attestation fields without evaluating or rereading them", async (t) => {
  const root = await temporaryRoot(t);
  let getterReads = 0;
  const attestation = {
    get currentPrincipalPrivacy() { getterReads += 1; return true; },
    get identityStableDeletion() { getterReads += 1; return true; },
    get unlinkedEntries() { getterReads += 1; return false; },
  };
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => attestation,
  };
  const spool = new BoundedOutputSpool({ ...spoolOptions(root), storage });

  await spool.write("stdout", Buffer.from("tail only"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(getterReads, 0);
  assert.equal(output.lossReason?.code, "private_spill_unavailable");
  await assert.rejects(stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("rejects proxy attestations before traps can supply changing guarantees", async (t) => {
  const root = await temporaryRoot(t);
  let trapReads = 0;
  const attestation = new Proxy({
    currentPrincipalPrivacy: true,
    identityStableDeletion: true,
    unlinkedEntries: false,
  }, {
    get(target, property, receiver) {
      if (property !== "then") trapReads += 1;
      return Reflect.get(target, property, receiver);
    },
    ownKeys(target) {
      trapReads += 1;
      return Reflect.ownKeys(target);
    },
  });
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => attestation,
  };
  const spool = new BoundedOutputSpool({ ...spoolOptions(root), storage });

  await spool.write("stdout", Buffer.from("tail only"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(trapReads, 0);
  assert.equal(output.lossReason?.code, "private_spill_unavailable");
  await assert.rejects(stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

for (const [name, attestation] of [
  ["truthy strings", {
    currentPrincipalPrivacy: "unverified",
    identityStableDeletion: "partial",
    unlinkedEntries: false,
  }],
  ["unknown fields", {
    currentPrincipalPrivacy: true,
    identityStableDeletion: true,
    unlinkedEntries: false,
    unexpected: true,
  }],
] as const) {
  test(`restart cleanup rejects ${name} before inspecting the spill path`, async (t) => {
    const root = await temporaryRoot(t);
    await writeFile(root, "foreign regular file");
    const storage: OutputSpillStorage = {
      ...createLinkedTestOutputSpillStorage(),
      attest: async () => attestation as unknown as OutputSpillStorageAttestation,
    };

    await cleanupOutputSpillRoot({
      spillRoot: root,
      projectRoot: process.cwd(),
      ownershipId: "runner-test-owner",
      storage,
    });

    assert.equal(await readFile(root, "utf8"), "foreign regular file");
  });
}

test("treats unavailable attestation as tail-only without trying disk", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let opens = 0;
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => { throw new Error("capability unavailable"); },
    openExclusive: async (path) => { opens += 1; return await nodeStorage.openExclusive(path); },
  };
  const spool = new BoundedOutputSpool({ ...spoolOptions(root), storage });

  await spool.write("stdout", Buffer.from("tail only"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(opens, 0);
  assert.equal(output.lossReason?.code, "private_spill_unavailable");
  assert.equal(output.lossyBytes, 9);
});

test("built-in backend creates no spill when it cannot attest current-principal privacy", async (t) => {
  if (process.platform !== "win32") return;
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool({
    spillRoot: root,
    projectRoot: process.cwd(),
    ownershipId: "runner-test-owner",
  });

  await spool.write("stdout", Buffer.from("tail only"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.lossReason?.code, "private_spill_unavailable");
  assert.equal(output.spillBytes, 0);
  await assert.rejects(stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("rejects an attested principal mismatch before opening a spill entry", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let opens = 0;
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => ({
      currentPrincipalPrivacy: true,
      identityStableDeletion: true,
      unlinkedEntries: false,
      currentPrincipalIdentity: "principal-that-cannot-own-the-test-root",
    }),
    openExclusive: async (path) => { opens += 1; return await nodeStorage.openExclusive(path); },
  };
  const spool = new BoundedOutputSpool({ ...spoolOptions(root), storage });

  await spool.write("stdout", Buffer.from("tail only"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(opens, 0);
  assert.equal(output.lossReason?.code, "spill_root_invalid");
  assert.equal(output.lossyOutput, true);
});

test("built-in descriptor-stable backend leaves no linked spill entry", async (t) => {
  if (process.platform === "win32") return;
  const root = await temporaryRoot(t);
  let artifactBytes = "";
  const spool = new BoundedOutputSpool({
    spillRoot: root,
    projectRoot: process.cwd(),
    ownershipId: "runner-test-owner",
    artifactStore: {
      put: async (bytes) => {
        artifactBytes = Buffer.from(bytes).toString();
        return { hash: "descriptor-artifact" };
      },
    },
  });

  await spool.write("stdout", Buffer.from("descriptor bytes"));
  assert.deepEqual(await createNodeOutputSpillStorage().list(root), [".output-spool-owner.json"]);
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(artifactBytes, "descriptor bytes");
  assert.equal(output.spillArtifactId, "descriptor-artifact");
  assert.deepEqual(await createNodeOutputSpillStorage().list(root), []);
});

test("an attested descriptor-only spill is artifact-ingested without a linked path", async (t) => {
  const root = await temporaryRoot(t);
  let retained = Buffer.alloc(0);
  let artifactBytes = Buffer.alloc(0);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => ({
      currentPrincipalPrivacy: true,
      identityStableDeletion: true,
      unlinkedEntries: true,
    }),
    openExclusive: async () => ({
      identity: "descriptor-only",
      write: async (bytes) => {
        retained = Buffer.concat([retained, Buffer.from(bytes)]);
        return bytes.byteLength;
      },
      sealAndRead: async () => Buffer.from(retained),
      close: async () => undefined,
    }),
  };
  const spool = new BoundedOutputSpool({
    ...spoolOptions(root),
    storage,
    artifactStore: {
      put: async (bytes) => {
        artifactBytes = Buffer.from(bytes);
        return { hash: "descriptor-only-artifact" };
      },
    },
  });

  await spool.write("stdout", Buffer.from("descriptor bytes"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(artifactBytes.toString(), "descriptor bytes");
  assert.equal(output.spillArtifactId, "descriptor-only-artifact");
  assert.equal(output.spillState, "artifact_ingested");
});

test("finalize seals synchronously, drains accepted writes, and rejects later writes before queueing", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      const file = await nodeStorage.openExclusive(path);
      return {
        ...file,
        write: async (bytes) => {
          writeStarted.resolve();
          await releaseWrite.promise;
          return await file.write(bytes);
        },
      };
    },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, { storage }));
  const accepted = spool.write("stdout", Buffer.from("accepted"));
  await writeStarted.promise;

  const finalizing = spool.finalize();
  const rejected = assert.rejects(spool.write("stdout", Buffer.from("too late")), /sealed/);
  releaseWrite.resolve();

  await accepted;
  await rejected;
  assert.equal(stream(await finalizing, "stdout").totalBytes, 8);
});

test("cleanup seals synchronously, drains accepted writes, and cannot leak a later spill", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const writeStarted = deferred<void>();
  const releaseWrite = deferred<void>();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      const file = await nodeStorage.openExclusive(path);
      return {
        ...file,
        write: async (bytes) => {
          writeStarted.resolve();
          await releaseWrite.promise;
          return await file.write(bytes);
        },
      };
    },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, { storage }));
  const accepted = spool.write("stdout", Buffer.from("accepted"));
  await writeStarted.promise;

  const cleaning = spool.cleanup();
  const rejected = assert.rejects(spool.write("stdout", Buffer.from("too late")), /sealed/);
  releaseWrite.resolve();

  await accepted;
  await cleaning;
  await rejected;
  assert.deepEqual(await nodeStorage.list(root), []);
});

test("cleanup propagates a terminal close failure after still removing the spill", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      const file = await nodeStorage.openExclusive(path);
      return { ...file, close: async () => { await file.close(); throw new Error("terminal close failure"); } };
    },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, { storage }));
  await spool.write("stdout", Buffer.from("output"));

  await assert.rejects(spool.cleanup(), /terminal close failure/);
  assert.deepEqual(await nodeStorage.list(root), []);
  await assert.rejects(spool.write("stdout", Buffer.from("too late")), /sealed/);
  await assert.rejects(spool.cleanup(), /terminal close failure/);
  await assert.rejects(spool.finalize(), /terminal close failure/);
});

test("keeps independent default 128 KiB byte tails across multibyte and interleaved chunks", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool(spoolOptions(root));
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

test("preserves an unfavorably aligned exact default byte tail independently from display text", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool(spoolOptions(root));
  const bytes = Buffer.concat([Buffer.from("🙂"), Buffer.alloc(128 * KIB - 1, 0x61)]);

  await spool.write("stdout", bytes);
  const output = stream(await spool.finalize(), "stdout");
  const exactTail = bytes.subarray(3);

  assert.equal(output.tailByteLength, 128 * KIB);
  assert.deepEqual(Buffer.from(output.tailBytesBase64, "base64"), exactTail);
  assert.equal(output.tail, "a".repeat(128 * KIB - 1));
  assert.equal(output.tail.includes("�"), false);
  assert.equal(output.tailDisplayTruncated, true);
  assert.equal(output.truncated, true);
});

test("preserves incomplete trailing UTF-8 bytes without expanding the display tail", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool(spoolOptions(root));
  const bytes = Buffer.from([0x61, 0xf0, 0x9f]);

  await spool.write("stdout", bytes);
  const output = stream(await spool.finalize(), "stdout");

  assert.deepEqual(Buffer.from(output.tailBytesBase64, "base64"), bytes);
  assert.equal(output.tailByteLength, 3);
  assert.equal(output.tail, "a");
  assert.equal(output.tailDisplayTruncated, true);
  assert.ok(Buffer.byteLength(output.tail) <= 128 * KIB);
});

test("returns a deeply immutable cached result", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool(spoolOptions(root, { spillBytes: 4 }));
  await spool.write("stdout", Buffer.from("overflow"));
  const result = await spool.finalize();
  const output = stream(result, "stdout");

  assert.throws(() => (result.streams as BoundedOutputStreamResult[]).push(output), TypeError);
  assert.throws(() => { (output as { tail: string }).tail = "mutated"; }, TypeError);
  assert.throws(() => { (output.lossReasons[0] as { lostBytes: number }).lostBytes = 999; }, TypeError);
  assert.strictEqual(await spool.finalize(), result);
  assert.equal(stream(await spool.finalize(), "stdout").lossReasons[0]?.lostBytes, 4);
});

test("spills exactly 64 MiB per stream and continues lossily with bounded marked tails", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool(spoolOptions(root));
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
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      paths.push(path);
      return await nodeStorage.openExclusive(path);
    },
  };
  const collisionRoot = `${root}-collision`;
  const collisionPath = join(collisionRoot, "collision.tmp");
  await nodeStorage.prepareRoot(collisionRoot);
  const collisionFile = await nodeStorage.openExclusive(collisionPath);
  await assert.rejects(nodeStorage.openExclusive(collisionPath), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  await collisionFile.close();
  await nodeStorage.remove(collisionPath);
  const artifacts = new ArtifactStore(artifactRoot);
  const spool = new BoundedOutputSpool(spoolOptions(root, { artifactStore: artifacts, storage }));

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
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async () => { throw new Error("permission denied"); },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, { tailBytes: 64, spillBytes: 64, storage }));

  await assert.doesNotReject(spool.write("stdout", Buffer.from("open failure still drains")));
  await assert.doesNotReject(spool.write("stdout", Buffer.from(" and continues")));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.totalBytes, 39);
  assert.equal(output.spillBytes, 0);
  assert.equal(output.lossyBytes, 39);
  assert.equal(output.lossReason?.code, "spill_open_failed");
  assert.equal(output.truncated, false);
  assert.equal(output.tailDisplayTruncated, true);
  assert.match(output.tail, /^\[runner output lossy: spill_open_failed\]\n/);
});

test("keeps a marked lossy UTF-8 tail on a complete code-point boundary", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    tailBytes: 64,
    spillBytes: 64,
    storage: { ...nodeStorage, openExclusive: async () => { throw new Error("denied"); } },
  }));

  await spool.write("stdout", Buffer.from("🙂".repeat(20)));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.tail.includes("�"), false);
  assert.match(output.tail, /🙂+$/);
  assert.ok(Buffer.byteLength(output.tail) <= 64);
});

test("converts spill write failure into typed lossy continuation", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path): Promise<OutputSpillFile> => {
      const file = await nodeStorage.openExclusive(path);
      return { ...file, write: async () => { throw new Error("disk full"); } };
    },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, { tailBytes: 64, spillBytes: 64, storage }));

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
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path): Promise<OutputSpillFile> => {
      const file = await nodeStorage.openExclusive(path);
      return { ...file, close: async () => { await file.close(); throw new Error("close failed"); } };
    },
  };
  let ingestions = 0;
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    spillBytes: 8,
    storage,
    artifactStore: { put: async () => { ingestions += 1; return { hash: "unexpected" }; } },
  }));

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
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    artifactStore: { put: async () => { throw new Error("artifact unavailable"); } },
  }));

  await spool.write("stdout", Buffer.from("artifact failure"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.lossReason?.code, "artifact_ingestion_failed");
  assert.equal(output.lossyBytes, Buffer.byteLength("artifact failure"));
  await assert.doesNotReject(spool.cleanup());
  await assert.doesNotReject(spool.cleanup());
  assert.deepEqual(await nodeStorage.list(root), []);
});

test("ingests bounded bytes from the identity-bound owned handle rather than the path", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let artifactBytes = "";
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    storage: nodeStorage,
    artifactStore: {
      put: async (bytes) => {
        artifactBytes = Buffer.from(bytes).toString();
        return { hash: "owned-handle-artifact" };
      },
    },
  }));

  await spool.write("stdout", Buffer.from("owned bytes"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(artifactBytes, "owned bytes");
  assert.equal(output.spillArtifactId, "owned-handle-artifact");
});

test("rejects an oversized sealed spill before artifact ingestion", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      const file = await nodeStorage.openExclusive(path);
      return { ...file, sealAndRead: async () => Buffer.alloc(9, 0x78) };
    },
  };
  let ingestions = 0;
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    spillBytes: 8,
    storage,
    artifactStore: { put: async () => { ingestions += 1; return { hash: "unexpected" }; } },
  }));

  await spool.write("stdout", Buffer.alloc(8, 0x78));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(ingestions, 0);
  assert.equal(output.lossReasons.at(-1)?.code, "spill_identity_failed");
  assert.equal(output.lossyBytes, 8);
});

test("composes disjoint cap and artifact losses without hiding or undercounting either", async (t) => {
  const root = await temporaryRoot(t);
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    spillBytes: 8,
    artifactStore: { put: async () => { throw new Error("artifact unavailable"); } },
  }));

  await spool.write("stdout", Buffer.from("12345678abcde"));
  const output = stream(await spool.finalize(), "stdout");

  assert.deepEqual(output.lossReasons.map(({ code, lostBytes }) => [code, lostBytes]), [
    ["spill_cap_exceeded", 5],
    ["artifact_ingestion_failed", 8],
  ]);
  assert.equal(output.lossyBytes, 13);
  assert.equal(output.lossyOutput, true);
});

test("restart cleanup removes only private spill entries and is idempotent", async (t) => {
  const root = await temporaryRoot(t);
  const owner = new BoundedOutputSpool(spoolOptions(root));
  await owner.write("stdout", Buffer.from("abandoned"));
  const entries = await createNodeOutputSpillStorage().list(root);
  const spillName = entries.find((name) => name.endsWith(".tmp"))!;
  const markerName = ".output-spool-owner.json";
  const proofName = `${spillName}.owner.json`;
  const marker = await readFile(join(root, markerName));
  const proof = await readFile(join(root, proofName));
  await owner.cleanup();
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, markerName), marker, { mode: 0o600 });
  await writeFile(join(root, proofName), proof, { mode: 0o600 });
  const spill = join(root, spillName);
  const unrelated = join(root, "keep.txt");
  const unprovenName = `${spillName.slice(0, spillName.indexOf("stdout-"))}stdout-00000000-0000-4000-8000-000000000000.tmp`;
  await writeFile(spill, "abandoned", { mode: 0o600 });
  await writeFile(join(root, unprovenName), "foreign", { mode: 0o600 });
  await writeFile(unrelated, "keep");
  await rename(spill, `${spill}.saved`);
  await symlink(unrelated, spill, "file");

  await cleanupOutputSpillRoot(spoolOptions(root));
  await cleanupOutputSpillRoot(spoolOptions(root));

  assert.deepEqual(
    (await createNodeOutputSpillStorage().list(root)).sort(),
    ["keep.txt", markerName, proofName, `${spillName}.saved`, spillName, unprovenName].sort()
  );
});

test("restart cleanup removes an identity-proven abandoned spill and its owned root", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let opened!: OutputSpillFile;
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    storage: {
      ...nodeStorage,
      openExclusive: async (path) => {
        opened = await nodeStorage.openExclusive(path);
        return opened;
      },
    },
  }));
  await spool.write("stdout", Buffer.from("abandoned"));
  await opened.close();

  await cleanupOutputSpillRoot(spoolOptions(root));
  await cleanupOutputSpillRoot(spoolOptions(root));

  assert.deepEqual(await nodeStorage.list(root), []);
});

test("rejects a spill root inside the project boundary", async (t) => {
  const root = join(process.cwd(), `.runner-v2-forbidden-spill-${process.pid}`);
  const { rm } = await import("node:fs/promises");
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const spool = new BoundedOutputSpool(spoolOptions(root));

  await spool.write("stdout", Buffer.from("output"));
  assert.equal(stream(await spool.finalize(), "stdout").lossReason?.code, "spill_root_invalid");
  await assert.rejects(stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("rejects a pre-existing unowned root without deleting it", async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(root);
  await writeFile(join(root, "keep.txt"), "foreign");
  const spool = new BoundedOutputSpool(spoolOptions(root));

  await spool.write("stdout", Buffer.from("output"));
  const output = stream(await spool.finalize(), "stdout");

  assert.equal(output.lossReason?.code, "spill_root_invalid");
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "foreign");
});

test("rejects a spill root aliased through a symlink or reparse point", async (t) => {
  const root = await temporaryRoot(t);
  const victim = `${root}-victim`;
  await mkdir(victim);
  await writeFile(join(victim, "keep.txt"), "victim");
  await symlink(victim, root, process.platform === "win32" ? "junction" : "dir");
  const spool = new BoundedOutputSpool(spoolOptions(root));

  await spool.write("stdout", Buffer.from("output"));
  assert.equal(stream(await spool.finalize(), "stdout").lossReason?.code, "spill_root_invalid");
  assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "victim");
});

test("rejects a permissive or differently owned existing private root", async (t) => {
  const root = await temporaryRoot(t);
  const first = new BoundedOutputSpool(spoolOptions(root, { ownershipId: "owner-a" }));
  await first.write("stdout", Buffer.from("first"));
  if (process.platform !== "win32") await chmod(root, 0o777);
  const second = new BoundedOutputSpool(spoolOptions(root, { ownershipId: "owner-b" }));

  await second.write("stdout", Buffer.from("second"));
  assert.equal(stream(await second.finalize(), "stdout").lossReason?.code, "spill_root_invalid");

  if (process.platform !== "win32") await chmod(root, 0o700);
  await first.cleanup();
});

test("an open failure never unlinks a candidate the spool did not create", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let foreignPath = "";
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      foreignPath = path;
      await writeFile(path, "foreign", { flag: "wx" });
      throw new Error("exclusive collision");
    },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, { storage }));

  await spool.write("stdout", Buffer.from("output"));
  assert.equal(stream(await spool.finalize(), "stdout").lossReason?.code, "spill_open_failed");
  assert.equal(await readFile(foreignPath, "utf8"), "foreign");
});

test("C3 shared spool cleanup is idempotent after a replacement removes the exact empty owned root", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let openAttempts = 0;
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => ({
      currentPrincipalPrivacy: true,
      identityStableDeletion: true,
      unlinkedEntries: false,
    }),
    openExclusive: async () => {
      openAttempts += 1;
      throw new Error("deliberate spill-open failure");
    },
  };
  const options = spoolOptions(root, { storage, tailBytes: 64, spillBytes: 64 });
  const original = new BoundedOutputSpool(options);
  const replacement = new BoundedOutputSpool(options);

  await original.write("stdout", Buffer.from("original"));
  await replacement.write("stdout", Buffer.from("replacement"));
  const replacementOutput = stream(await replacement.finalize(), "stdout");

  assert.equal(openAttempts, 2, "both real spools establish and use the shared owned root");
  assert.equal(replacementOutput.lossReason?.code, "spill_open_failed");
  await assert.rejects(lstat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await original.cleanup();
});

test("C3 cached spool cleanup still refuses a missing ownership marker inside an existing root", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => ({
      currentPrincipalPrivacy: true,
      identityStableDeletion: true,
      unlinkedEntries: false,
    }),
    openExclusive: async () => { throw new Error("deliberate spill-open failure"); },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, { storage }));
  await spool.write("stdout", Buffer.from("owned"));
  await unlink(join(root, ".output-spool-owner.json"));

  await assert.rejects(
    spool.cleanup(),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal((await lstat(root)).isDirectory(), true, "cleanup must not remove an unverifiable root");
});

test("cleanup refuses a foreign regular file swapped over an owned spill identity", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let spillPath = "";
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    openExclusive: async (path) => {
      spillPath = path;
      return await nodeStorage.openExclusive(path);
    },
  };
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    storage,
    artifactStore: {
      put: async () => {
        await rename(spillPath, `${spillPath}.owned`);
        await writeFile(spillPath, "foreign", { flag: "wx" });
        return { hash: "sealed-artifact" };
      },
    },
  }));
  await spool.write("stdout", Buffer.from("owned"));

  await assert.rejects(spool.finalize(), /identity changed/);
  assert.equal(await readFile(spillPath, "utf8"), "foreign");
});

test("linked-entry cleanup is enforced by the attested identity-stable adapter operation", async (t) => {
  const root = await temporaryRoot(t);
  const nodeStorage = createLinkedTestOutputSpillStorage();
  let spillPath = "";
  const storage: OutputSpillStorage = {
    ...nodeStorage,
    attest: async () => ({
      currentPrincipalPrivacy: true,
      identityStableDeletion: true,
      unlinkedEntries: false,
    }),
    openExclusive: async (path) => {
      spillPath = path;
      return await nodeStorage.openExclusive(path);
    },
    removeIdentityStable: async () => { throw new Error("stable deletion refusal"); },
  };
  const spool = new BoundedOutputSpool({ ...spoolOptions(root), storage });
  await spool.write("stdout", Buffer.from("owned"));

  await assert.rejects(spool.finalize(), /stable deletion refusal/);
  assert.equal(await readFile(spillPath, "utf8"), "owned");
});

test("cleanup revalidates the root after it is replaced by an alias", async (t) => {
  const root = await temporaryRoot(t);
  const movedRoot = `${root}-moved`;
  const victim = `${root}-victim`;
  await mkdir(victim);
  await writeFile(join(victim, "keep.txt"), "victim");
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    artifactStore: {
      put: async () => {
        await rename(root, movedRoot);
        await symlink(victim, root, process.platform === "win32" ? "junction" : "dir");
        return { hash: "sealed-artifact" };
      },
    },
  }));
  await spool.write("stdout", Buffer.from("owned"));

  await assert.rejects(spool.finalize(), /private directory|aliases/);
  assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "victim");
});

test("cleanup rejects a replacement directory even when its ownership marker is cloned", async (t) => {
  const root = await temporaryRoot(t);
  const movedRoot = `${root}-moved`;
  const spool = new BoundedOutputSpool(spoolOptions(root, {
    artifactStore: {
      put: async () => {
        await rename(root, movedRoot);
        const marker = await readFile(join(movedRoot, ".output-spool-owner.json"));
        await mkdir(root, { mode: 0o700 });
        await writeFile(join(root, ".output-spool-owner.json"), marker, { mode: 0o600 });
        await writeFile(join(root, "keep.txt"), "foreign");
        return { hash: "sealed-artifact" };
      },
    },
  }));
  await spool.write("stdout", Buffer.from("owned"));

  await assert.rejects(spool.finalize(), /root identity changed/);
  assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "foreign");
});
