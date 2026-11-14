// A process that takes the owned fence lock for a test. argv: mode lockPath effectPath deadlineMs holdMs [count]
//   hold        sync claim; appends this PID to effectPath (when given), reports "acquired", holds for holdMs
//   hold-async  the same through the async driver
//   retain      a claim whose release fails (the beforeRelease seam): reports "retained", then keeps the lock held
//               until it is killed, and reports what a later claim in this process got
//   count       `count` claims, each a read-modify-write of the counter in effectPath; reports "counted"
// A mode prefixed "v1:" runs the pre-FL2 module (fixtures/owned-fence-lock-v1.mjs) instead, as a Runner or supervisor
// of the earlier version would: it records a holder row and probes nothing (inspectHolder answers "same", which is
// true of every holder in these tests: they are alive while they hold).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [modeArgument, lockPath, effectPath, deadlineText, holdText, countText] = process.argv.slice(2);
const v1 = modeArgument.startsWith("v1:");
const mode = v1 ? modeArgument.slice(3) : modeArgument;
const lock = await import(v1 ? "./owned-fence-lock-v1.mjs" : "../../src/owned-fence-lock.mjs");
const deadlineMs = Number(deadlineText || 2_000);
const holdMs = Number(holdText || 60_000);
const waiter = new Int32Array(new SharedArrayBuffer(4));
const options = v1
  ? { deadlineMs, holderPid: process.pid, holderBirth: `fixture-${process.pid}`, inspectHolder: () => "same" }
  : { deadlineMs };
const report = (message) => process.stdout.write(`${JSON.stringify({ pid: process.pid, ...message })}\n`);

try {
  if (mode === "hold") {
    lock.withOwnedFenceLockSync(lockPath, () => {
      if (effectPath) appendFileSync(effectPath, `${process.pid}\n`);
      report({ state: "acquired" });
      Atomics.wait(waiter, 0, 0, holdMs);
    }, options);
    report({ state: "released" });
  } else if (mode === "hold-async") {
    await lock.withOwnedFenceLock(lockPath, async () => {
      report({ state: "acquired" });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, holdMs));
    }, options);
    report({ state: "released" });
  } else if (mode === "retain") {
    let failure;
    try {
      lock.withOwnedFenceLockSync(lockPath, () => undefined, { ...options, beforeRelease: () => { throw new Error("injected release fault"); } });
    } catch (error) { failure = error; }
    let later;
    try { lock.withOwnedFenceLockSync(lockPath, () => undefined, { deadlineMs: 5_000 }); }
    catch (error) { later = error; }
    report({ state: "retained", failure: String(failure?.message), later: String(later?.message), laterName: later?.name });
    Atomics.wait(waiter, 0, 0, holdMs);
  } else if (mode === "count") {
    const count = Number(countText);
    for (let index = 0; index < count; index += 1) {
      lock.withOwnedFenceLockSync(lockPath, () => {
        const value = existsSync(effectPath) ? Number(readFileSync(effectPath, "utf8") || "0") : 0;
        Atomics.wait(waiter, 0, 0, 1);
        writeFileSync(effectPath, String(value + 1));
      }, { ...options, deadlineMs: 15_000 });
    }
    report({ state: "counted", count });
  } else throw new Error(`unknown mode ${modeArgument}`);
} catch (error) {
  report({ state: "refused", message: String(error?.message ?? error), name: error?.name });
  process.exitCode = 1;
}
