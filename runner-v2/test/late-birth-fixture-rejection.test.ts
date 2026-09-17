import assert from "node:assert/strict";
import test from "node:test";
import { NativeProcessLaunchBlockedError } from "../src/native-process-backend.js";
import { runLateBirthFixture } from "./support/late-birth-fixture.js";

const launchResult = { opaqueIdentity: "synthetic-exact-capability", birthFingerprint: { observedAt: "2026-09-11T00:00:00.000Z", discriminator: "synthetic-birth" }, rootPid: 42, startedAt: "2026-09-11T00:00:00.000Z" };
const settle = (operation: Promise<void>) => operation.then(
  () => ({ status: "fulfilled" as const }),
  (reason: unknown) => ({ status: "rejected" as const, reason }),
);

// These are pure helper tests: no process, native operation or filesystem root.
for (const [label, reason] of [["undefined", undefined], ["null", null], ["false", false], ["zero", 0], ["empty string", ""]] as const) {
  test(`C5 round9 retains a verification rejection of ${label} after certified cleanup`, async () => {
    const calls: string[] = [];
    const result = await settle(runLateBirthFixture({
      launch: async () => launchResult,
      verify: async () => { throw reason; },
      cleanup: async (actual) => { assert.equal(actual, launchResult); calls.push("cleanup"); },
      certify: async () => { calls.push("certify"); },
      removeRoot: () => { calls.push("remove"); },
    }));
    assert.equal(result.status, "rejected", "rejection presence is independent of its value");
    if (result.status !== "rejected") assert.fail("verification failure was swallowed");
    assert.equal(result.reason, reason);
    assert.deepEqual(calls, ["cleanup", "certify"], "certified cleanup cannot erase verification failure evidence");
  });
}

test("C5 round9 preserves undefined launch, verification and certification reasons in order", async () => {
  let removed = false; let certified = false;
  const result = await settle(runLateBirthFixture({
    launch: async () => { throw undefined; },
    verify: async () => { throw undefined; },
    cleanup: async () => assert.fail("no exact launch capability was returned"),
    certify: async () => { certified = true; throw undefined; },
    removeRoot: () => { removed = true; },
  }));
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") assert.fail("three rejections were swallowed");
  assert.ok(result.reason instanceof AggregateError);
  assert.deepEqual(result.reason.errors, [undefined, undefined, undefined]);
  assert.equal(certified, true); assert.equal(removed, false);
});

test("C5 round9 retains undefined verification alongside the authenticated blocked-launch error", async () => {
  const blocked = new NativeProcessLaunchBlockedError([new Error("launch deadline")], "synthetic-root/owned", launchResult, "synthetic blocked launch");
  let removed = false; let cleanups = 0;
  const result = await settle(runLateBirthFixture({
    launch: async () => { throw blocked; },
    verify: async () => { throw undefined; },
    cleanup: async (actual) => { assert.equal(actual, launchResult); cleanups++; },
    certify: async () => undefined,
    removeRoot: () => { removed = true; },
  }));
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") assert.fail("undefined verification was swallowed");
  assert.ok(result.reason instanceof AggregateError);
  assert.deepEqual(result.reason.errors, [blocked, undefined]);
  assert.equal(cleanups, 1); assert.equal(removed, false);
});

test("C5 round9 retains an undefined cleanup rejection even with no earlier failure", async () => {
  let removed = false;
  const result = await settle(runLateBirthFixture({
    launch: async () => launchResult,
    verify: async () => undefined,
    cleanup: async () => { throw undefined; },
    certify: async () => assert.fail("failed cleanup cannot be certified"),
    removeRoot: () => { removed = true; },
  }));
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") assert.fail("cleanup rejection was swallowed");
  assert.ok(result.reason instanceof AggregateError);
  assert.deepEqual(result.reason.errors, [undefined]); assert.equal(removed, false);
});

test("C5 round9 distinguishes an expected undefined launch rejection from launch success", async () => {
  let removed = false;
  const result = await settle(runLateBirthFixture({
    launch: async () => { throw undefined; },
    verify: async (outcome) => {
      assert.equal(outcome.launchRejected, true);
      assert.equal(Object.hasOwn(outcome, "rejection"), true);
      assert.equal(outcome.rejection, undefined); assert.equal(outcome.result, undefined);
    },
    cleanup: async () => assert.fail("no launch capability exists"),
    certify: async () => undefined,
    removeRoot: () => { removed = true; },
  }));
  assert.deepEqual(result, { status: "fulfilled" });
  assert.equal(removed, true, "only successfully verified and certified expected failure may remove its root");
});

test("C5 round9 retains an undefined verification before a later cleanup Error", async () => {
  const cleanupError = new Error("cleanup uncertainty");
  let removed = false;
  const result = await settle(runLateBirthFixture({
    launch: async () => launchResult,
    verify: async () => { throw undefined; },
    cleanup: async () => { throw cleanupError; },
    certify: async () => assert.fail("uncertain cleanup cannot be certified"),
    removeRoot: () => { removed = true; },
  }));
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") assert.fail("failures were swallowed");
  assert.ok(result.reason instanceof AggregateError);
  assert.deepEqual(result.reason.errors, [undefined, cleanupError]); assert.equal(removed, false);
});
