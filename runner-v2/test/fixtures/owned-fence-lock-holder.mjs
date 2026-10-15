import { appendFileSync, existsSync, writeFileSync } from "node:fs";

import { withOwnedFenceLockSync } from "../../src/owned-fence-lock.mjs";

const [mode, lockPath, effectPath, deadlineText, holdText, gatePath] = process.argv.slice(2);
const deadlineMs = Number(deadlineText ?? 2_000);
const holdMs = Number(holdText ?? 60_000);
const waiter = new Int32Array(new SharedArrayBuffer(4));

let failure;
let closeInspection;
let owner;
let inspectionCleanupFailed = false;
try {
  if (mode === "election-prepared") {
    const { WindowsBirthInspectionOwner } = await import("../../src/windows-birth-inspection.mjs");
    owner = new WindowsBirthInspectionOwner();
    owner.registerCleanup(cleanup => { closeInspection = cleanup; });
    await owner.prepareInspection(Date.now() + 2_000);
    owner.fenceOptions(Date.now() + 2_000); // Genuine self identity before coordination begins.
    writeFileSync(`${gatePath}.${process.pid}.ready`, "ready");
    const readyDeadline = Date.now() + 5_000;
    while (!existsSync(gatePath) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (!existsSync(gatePath)) throw new Error("election readiness gate timed out");
  }
  const gatedRetirement = mode === "retire-gated";
  withOwnedFenceLockSync(lockPath, () => {
    if (effectPath) appendFileSync(effectPath, `${process.pid}\n`);
    process.stdout.write(`${JSON.stringify({ state: "acquired", pid: process.pid })}\n`);
    if (!gatedRetirement) Atomics.wait(waiter, 0, 0, holdMs);
  }, {
    deadlineMs,
    ...(owner ? owner.fenceOptions(Date.now() + deadlineMs) : {}),
    retireAfterEffect: gatedRetirement,
    ...(gatedRetirement ? { afterClaim: () => {
      writeFileSync(`${gatePath}.claimed`, "claimed");
      const deadline = Date.now() + holdMs;
      while (!existsSync(gatePath) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 5);
      if (!existsSync(gatePath)) throw new Error("retirement gate timed out");
    } } : {}),
  });
  process.stdout.write(`${JSON.stringify({ state: "released", pid: process.pid })}\n`);
} catch (error) {
  failure = error;
} finally {
  if (closeInspection) {
    try { await closeInspection(Date.now() + 5_000); }
    catch (error) { inspectionCleanupFailed = true; failure = failure ? new AggregateError([failure, error], "Election and inspection cleanup failed", { cause: failure }) : error; }
  }
}
if (failure) {
  process.stdout.write(`${JSON.stringify({ state: "refused", message: String(failure), stack: failure.stack, errors: failure instanceof AggregateError ? failure.errors.map(String) : undefined })}\n`);
  process.exitCode = inspectionCleanupFailed ? 3 : mode === "contend" || mode === "election-prepared" ? 2 : 1;
}
