import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finalizeRealStreamingFixture } from "./support/real-streaming-fixture-finalizer.js";

test("real-streaming fixture finalizer retains its exact root and aggregates primary plus cleanup failure", async () => {
  await withExactFixtureRoot(async (root) => {
    const evidencePath = join(root, "fixture-evidence.txt");
    const primaryFailure = new Error("synthetic primary failure");
    const cleanupFailure = new Error("synthetic cleanup failure");
    await writeFile(evidencePath, "owned fixture evidence", { flag: "wx" });

    await assert.rejects(
      () => finalizeRealStreamingFixture({
        fixtureName: "synthetic real-streaming",
        root,
        owner: {
          cleanupOutstandingForTest: async () => { throw cleanupFailure; },
          kernel: { store: { close: () => undefined } },
        },
        primaryFailure,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.includes(primaryFailure), true);
        assert.equal(error.errors.includes(cleanupFailure), true);
        assert.equal(existsSync(root), true);
        return true;
      },
    );
    assert.equal(await readFile(evidencePath, "utf8"), "owned fixture evidence");
  });
});

test("real-streaming fixture finalizer retains its exact root after a primary failure even when cleanup succeeds", async () => {
  await withExactFixtureRoot(async (root) => {
    const evidencePath = join(root, "primary-failure-evidence.txt");
    const primaryFailure = new Error("synthetic primary failure after successful cleanup");
    let cleanupCalls = 0;
    let closeCalls = 0;
    await writeFile(evidencePath, "primary failure evidence", { flag: "wx" });

    await assert.rejects(
      () => finalizeRealStreamingFixture({
        fixtureName: "synthetic primary retention",
        root,
        owner: {
          cleanupOutstandingForTest: async () => { cleanupCalls += 1; },
          kernel: { store: { close: () => { closeCalls += 1; } } },
        },
        primaryFailure,
      }),
      (error: unknown) => {
        assert.equal(error, primaryFailure);
        assert.equal(existsSync(root), true);
        return true;
      },
    );
    assert.equal(cleanupCalls, 1);
    assert.equal(closeCalls, 1);
    assert.equal(await readFile(evidencePath, "utf8"), "primary failure evidence");
  });
});

test("real-streaming fixture finalizer fails an otherwise-green cleanup error and preserves its exact root", async () => {
  await withExactFixtureRoot(async (root) => {
    const evidencePath = join(root, "cleanup-failure-evidence.txt");
    const cleanupFailure = new Error("synthetic otherwise-green cleanup failure");
    await writeFile(evidencePath, "owned cleanup evidence", { flag: "wx" });

    await assert.rejects(
      () => finalizeRealStreamingFixture({
        fixtureName: "synthetic otherwise-green cleanup",
        root,
        owner: {
          cleanupOutstandingForTest: async () => { throw cleanupFailure; },
          kernel: { store: { close: () => undefined } },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.includes(cleanupFailure), true);
        assert.equal(existsSync(root), true);
        return true;
      },
    );
    assert.equal(await readFile(evidencePath, "utf8"), "owned cleanup evidence");
  });
});

test("real-streaming fixture finalizer preserves authority evidence when no cleanup owner exists", async () => {
  await withExactFixtureRoot(async (root) => {
    const evidencePath = join(root, "unrecovered-authority.txt");
    await writeFile(evidencePath, "unrecovered authority", { flag: "wx" });

    await assert.rejects(
      () => finalizeRealStreamingFixture({
        fixtureName: "synthetic crash-before-recovery",
        root,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.some((cause) => cause instanceof Error && /cleanup owner is unavailable/i.test(cause.message)), true);
        return true;
      },
    );
    assert.equal(existsSync(root), true);
    assert.equal(await readFile(evidencePath, "utf8"), "unrecovered authority");
  });
});

test("real-streaming fixture finalizer removes only a successfully cleaned exact root", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-c5-finalizer-"));
  console.log(JSON.stringify({ c5r6: "acquired", root }));
  let cleanupCalls = 0;
  let closeCalls = 0;
  try {
    await finalizeRealStreamingFixture({
      fixtureName: "synthetic successful cleanup",
      root,
      owner: {
        cleanupOutstandingForTest: async () => { cleanupCalls += 1; },
        kernel: { store: { close: () => { closeCalls += 1; } } },
      },
    });
    assert.equal(cleanupCalls, 1);
    assert.equal(closeCalls, 1);
    assert.equal(existsSync(root), false);
  } finally {
    console.log(JSON.stringify({ c5r6: existsSync(root) ? "retained-by-fixture" : "removed-by-fixture", root }));
    if (existsSync(root)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    assert.equal(existsSync(root), false);
    console.log(JSON.stringify({ c5r6: "disposed", root }));
  }
});

async function withExactFixtureRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "runner-c5-finalizer-"));
  console.log(JSON.stringify({ c5r6: "acquired", root }));
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    await body(root);
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      console.log(JSON.stringify({ c5r6: existsSync(root) ? "retained-by-fixture" : "removed-by-fixture", root }));
      if (existsSync(root)) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      if (existsSync(root)) throw new Error("Synthetic finalizer root remained after exact test cleanup.");
      console.log(JSON.stringify({ c5r6: "disposed", root }));
    } catch (error) {
      cleanupFailure = error;
    }
  }
  if (cleanupFailure) {
    throw new AggregateError(
      primaryFailure ? [primaryFailure, cleanupFailure] : [cleanupFailure],
      "Synthetic real-streaming finalizer test cleanup failed.",
    );
  }
  if (primaryFailure) throw primaryFailure;
}
