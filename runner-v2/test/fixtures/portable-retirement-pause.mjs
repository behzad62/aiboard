// The portable supervisor's output-ACK retirement, in its own process, paused with the lock held at the "output"
// boundary (the output file is gone, the checkpoint not yet advanced) until `resumePath` exists.
// argv: lockPath fencePath retirementJson resumePath. Reports "paused", then "retired" with the effect's status.
import { existsSync, readFileSync } from "node:fs";

import { retirePortableOutputAcknowledgement, runPortableFenceEffectSync } from "../../src/portable-process-protocol.mjs";

const [lockPath, fencePath, retirementJson, resumePath] = process.argv.slice(2);
const retirement = JSON.parse(retirementJson);
const waiter = new Int32Array(new SharedArrayBuffer(4));
const report = (message) => process.stdout.write(`${JSON.stringify({ pid: process.pid, ...message })}\n`);

const result = runPortableFenceEffectSync({
  lockPath,
  expectedFence: retirement.fence,
  readCurrentFence: () => {
    const value = JSON.parse(readFileSync(fencePath, "utf8"));
    return { ownerId: value.ownerId, fencingToken: value.fencingToken };
  },
  effect: () => retirePortableOutputAcknowledgement({
    ...retirement,
    afterBoundary: (boundary) => {
      if (boundary !== "output") return;
      report({ state: "paused" });
      const deadline = Date.now() + 30_000;
      while (!existsSync(resumePath) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 5);
    },
  }),
});
report({ state: "retired", status: result.status, error: result.error === undefined ? undefined : String(result.error) });
