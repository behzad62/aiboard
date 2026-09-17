import assert from "node:assert/strict";
import test from "node:test";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const settle = (promise: Promise<void>) => promise.then(
  () => ({ rejected: false as const }), (reason: unknown) => ({ rejected: true as const, reason }),
);
for (const phase of ["cleanup", "certification"] as const) {
  for (const primary of [false, true]) {
    test(`C5 certified finalizer retains undefined ${phase} failure with primary=${primary}`, async () => {
      const calls: string[] = [];
      const result = await settle(finalizeCertifiedFixture({
        fixtureName: "synthetic finalizer", root: "synthetic/exact-root", hasPrimaryFailure: primary, primaryFailure: undefined,
        cleanup: async () => { calls.push("cleanup"); if (phase === "cleanup") throw undefined; },
        certify: async () => { calls.push("certify"); throw undefined; },
        removeRoot: async () => { calls.push("remove"); },
      }));
      assert.equal(result.rejected, true);
      if (!result.rejected) assert.fail("uncertain cleanup was accepted");
      assert.ok(result.reason instanceof AggregateError);
      assert.deepEqual(result.reason.errors, primary ? [undefined, undefined] : [undefined]);
      assert.deepEqual(calls, phase === "cleanup" ? ["cleanup"] : ["cleanup", "certify"]);
      assert.match(result.reason.message, /exact-root/);
    });
  }
}

test("C5 certified finalizer preserves a failed assertion after successful owned cleanup", async () => {
  const primary = new Error("failed assertion"); const calls: string[] = [];
  const result = await settle(finalizeCertifiedFixture({
    fixtureName: "synthetic", root: "exact-root", hasPrimaryFailure: true, primaryFailure: primary,
    cleanup: async () => { calls.push("cleanup"); }, certify: async () => { calls.push("certify"); },
    removeRoot: async () => { calls.push("remove"); },
  }));
  assert.deepEqual(result, { rejected: true, reason: primary });
  assert.deepEqual(calls, ["cleanup", "certify"]);
});

test("C5 certified finalizer joins the exact pending cleanup before certification and removal", async () => {
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const finalizing = finalizeCertifiedFixture({
    fixtureName: "synthetic", root: "exact-root", hasPrimaryFailure: false,
    cleanup: async () => { calls.push("cleanup"); await pending; calls.push("released"); },
    certify: async () => { calls.push("certify"); }, removeRoot: async () => { calls.push("remove"); },
  });
  try { await Promise.resolve(); assert.deepEqual(calls, ["cleanup"]); }
  finally { release(); await finalizing; }
  assert.deepEqual(calls, ["cleanup", "released", "certify", "remove"]);
});

test("C5 certified finalizer does not infer absent primary failure from its undefined value", async () => {
  let removed = false;
  const result = await settle(finalizeCertifiedFixture({
    fixtureName: "synthetic", root: "exact-root", hasPrimaryFailure: true, primaryFailure: undefined,
    cleanup: async () => undefined, certify: async () => undefined, removeRoot: async () => { removed = true; },
  }));
  assert.deepEqual(result, { rejected: true, reason: undefined }); assert.equal(removed, false);
});

test("C5 certified finalizer preserves a root-removal failure after verified resource release", async () => {
  const reason = new Error("cannot remove exact owned root");
  const result = await settle(finalizeCertifiedFixture({
    fixtureName: "synthetic", root: "exact-root", hasPrimaryFailure: false,
    cleanup: async () => undefined, certify: async () => undefined, removeRoot: async () => { throw reason; },
  }));
  assert.deepEqual(result, { rejected: true, reason });
});
