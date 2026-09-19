import assert from "node:assert/strict";
import test from "node:test";
import { createLateBirthFixtureClock } from "./support/late-birth-clock.js";

test("C5 late-birth clock captures actual identity before expiring its result boundary", () => {
  let wall = 1_000;
  const clock = createLateBirthFixtureClock(100, 150, () => wall);
  assert.equal(clock.now(), 100, "unrelated runner startup cannot consume the causal observation window");
  const birth = { state: "present" as const, fingerprint: "exact-observed-birth" };
  const observed = clock.observeBeforeExpiry(() => clock.now() < 150 ? birth : { state: "absent" as const });
  assert.equal(observed, birth, "expiring before observation reproduces an absent identity, not a late birth result");
  assert.equal(clock.now(), 1_000);
  wall = 1_020; assert.equal(clock.now(), 1_020, "cleanup deadlines keep advancing after observation");
  clock.restore(); assert.equal(clock.now(), wall);
});

test("C5 late-birth clock expires a fast observation without a guessed sleep", () => {
  const clock = createLateBirthFixtureClock(100, 150, () => 105);
  clock.observeBeforeExpiry(() => ({ state: "present", fingerprint: "genuine-test-observation" }));
  assert.equal(clock.now(), 151);
  clock.restore(); assert.equal(clock.now(), 105, "finalization resumes the caller's real clock");
});

for (const state of ["absent", "unknown"] as const) {
  test(`C5 late-birth clock never manufactures identity from an ${state} observation`, () => {
    const clock = createLateBirthFixtureClock(100, 150, () => 200);
    const observed = { state };
    assert.equal(clock.observeBeforeExpiry(() => observed), observed);
    clock.restore(); assert.equal(clock.now(), 200);
  });
}

test("C5 late-birth clock restores after an undefined observation rejection", () => {
  const clock = createLateBirthFixtureClock(100, 150, () => 200);
  let rejected = false;
  try { clock.observeBeforeExpiry(() => { throw undefined; }); }
  catch (error) { rejected = true; assert.equal(error, undefined); }
  finally { clock.restore(); }
  assert.equal(rejected, true); assert.equal(clock.now(), 200);
});
