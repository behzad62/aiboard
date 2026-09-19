import { appendFileSync, existsSync, writeFileSync } from "node:fs";

import { withOwnedFenceLockSync } from "../../src/owned-fence-lock.mjs";

const [mode, lockPath, effectPath, deadlineText, holdText, gatePath] = process.argv.slice(2);
const deadlineMs = Number(deadlineText ?? 2_000);
const holdMs = Number(holdText ?? 60_000);
const waiter = new Int32Array(new SharedArrayBuffer(4));

try {
  const gatedRetirement = mode === "retire-gated";
  withOwnedFenceLockSync(lockPath, () => {
    if (effectPath) appendFileSync(effectPath, `${process.pid}\n`);
    process.stdout.write(`${JSON.stringify({ state: "acquired", pid: process.pid })}\n`);
    if (!gatedRetirement) Atomics.wait(waiter, 0, 0, holdMs);
  }, {
    deadlineMs,
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
  process.stdout.write(`${JSON.stringify({ state: "refused", message: String(error) })}\n`);
  process.exitCode = mode === "contend" ? 2 : 1;
}
