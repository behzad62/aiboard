import assert from "node:assert/strict";
import childProcess from "node:child_process";
import test from "node:test";
import { NativeProcessLaunchBlockedError } from "../src/native-process-backend.js";
import { runLateBirthFixture, inspectWindowsFixtureBirth } from "./support/late-birth-fixture.js";

const result = { opaqueIdentity: "exact-test-authority", birthFingerprint: { observedAt: "2026-09-08T00:00:00Z", discriminator: "birth" }, rootPid: 42, startedAt: "2026-09-08T00:00:00Z" };

for (const reason of ["identity_mismatch", "identity_unknown", "release_rejected"] as const) {
  test(`late-birth fixture retains blocked launch authority and both failures on ${reason}`, async () => {
    const primary = new NativeProcessLaunchBlockedError([new Error("deadline")], "exact-evidence", result, "blocked");
    const cleanup = new Error(reason);
    let removed = false;
    let retained: unknown;
    const failure = await runLateBirthFixture({
      launch: async () => { throw primary; },
      verify: async (outcome) => { assert.equal(outcome.evidenceDirectory, "exact-evidence"); },
      cleanup: async (authority) => { retained = authority; throw cleanup; },
      certify: async () => {}, removeRoot: () => { removed = true; },
    }).catch((error: unknown) => error);
    assert.equal(removed, false, "uncertain cleanup retains evidence");
    assert.equal(retained, result, "cleanup receives original capability, never a PID substitute");
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [primary, cleanup]);
  });
}

test("late-birth fixture refuses missing authority despite nominal deadline rejection and process absence", async () => {
  const primary = new Error("startup deadline is exhausted");
  const uncertain = new Error("owned state is still retained");
  let removed = false;
  const failure = await runLateBirthFixture({
    launch: async () => { throw primary; }, verify: async () => {},
    cleanup: async () => assert.fail("no exact launch capability exists"),
    certify: async () => { throw uncertain; }, removeRoot: () => { removed = true; },
  }).catch((error: unknown) => error);
  assert.equal(removed, false);
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [primary, uncertain]);
});

test("late-birth fixture joins delayed cleanup before certifying and deleting", async () => {
  const events: string[] = [];
  let complete!: () => void;
  const waiting = new Promise<void>((resolve) => { complete = resolve; });
  const running = runLateBirthFixture({
    launch: async () => result, verify: async () => {},
    cleanup: async () => { events.push("cleanup"); await waiting; events.push("released"); },
    certify: async () => { events.push("certified"); }, removeRoot: () => { events.push("removed"); },
  });
  await new Promise((resolve) => setImmediate(resolve));
  try { assert.deepEqual(events, ["cleanup"]); }
  finally { complete(); await running; }
  assert.deepEqual(events, ["cleanup", "released", "certified", "removed"]);
});

test("late-birth fixture retains evidence after an assertion fails even if cleanup releases", async () => {
  const primary = new Error("assertion failure");
  let released = false;
  let removed = false;
  const failure = await runLateBirthFixture({
    launch: async () => result, verify: async () => { throw primary; },
    cleanup: async () => { released = true; }, certify: async () => {}, removeRoot: () => { removed = true; },
  }).catch((error: unknown) => error);
  assert.equal(released, true);
  assert.equal(removed, false);
  assert.equal(failure, primary);
});

test("late-birth fixture preserves blocked-launch evidence when verification and finalization both fail", async () => {
  const blocked = new NativeProcessLaunchBlockedError([new Error("deadline")], "exact-evidence", result, "blocked");
  const primary = new Error("verification failed");
  const cleanup = new Error("release failed");
  const failure = await runLateBirthFixture({
    launch: async () => { throw blocked; }, verify: async () => { throw primary; },
    cleanup: async () => { throw cleanup; }, certify: async () => {},
    removeRoot: () => assert.fail("uncertain evidence cannot be removed"),
  }).catch((error: unknown) => error);
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [blocked, primary, cleanup]);
});

test("Windows fixture birth observer preserves real present absent and unknown observations", (t) => {
  let output = "PRESENT:2026-09-08T00:00:00.1234567Z";
  t.mock.method(childProcess, "execFileSync", () => { if (output === "throw") throw new Error("unavailable"); return output; });
  assert.deepEqual(inspectWindowsFixtureBirth(42, "windows", 50), { state: "present", fingerprint: "2026-09-08T00:00:00.123456Z" });
  output = "ABSENT";
  assert.deepEqual(inspectWindowsFixtureBirth(42, "windows", 50), { state: "absent" });
  output = "throw";
  assert.deepEqual(inspectWindowsFixtureBirth(42, "windows", 50), { state: "unknown" });
});
