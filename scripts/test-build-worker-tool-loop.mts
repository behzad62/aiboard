/** Build worker tool-loop guard checks (run: npx tsx scripts/test-build-worker-tool-loop.mts) */
import { readFileSync } from "node:fs";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const source = readFileSync("lib/client/build-engine.ts", "utf8");

const workerBatchStart = source.indexOf("const dispatchWorkerToolBatch = async");
const workerLoopStart = source.indexOf("const batch = await dispatchWorkerToolBatch", workerBatchStart);
const workerBatchBlock =
  workerBatchStart >= 0 && workerLoopStart > workerBatchStart
    ? source.slice(workerBatchStart, workerLoopStart)
    : "";
const workerLoopBlock =
  workerLoopStart >= 0
    ? source.slice(workerLoopStart, source.indexOf("const declaredOutputPaths", workerLoopStart))
    : "";

check(
  "worker tool batch returns replayedCount separately from servedCount",
  /replayedCount:\s*number/.test(workerBatchBlock) &&
    /let replayedCount = 0;/.test(workerBatchBlock) &&
    /replayedCount \+= 1;/.test(workerBatchBlock) &&
    /replayedCount,/.test(workerBatchBlock),
  workerBatchBlock.slice(0, 1200)
);

check(
  "replay-only worker batches count as repeated tool loops",
  /const replayOnlyBatch =\s*batch\.servedCount > 0 &&\s*batch\.replayedCount === batch\.servedCount;/.test(
    workerLoopBlock
  ) &&
    /if \(batch\.servedCount > 0 && !replayOnlyBatch\)/.test(workerLoopBlock) &&
    /if \(batch\.servedCount === 0 \|\| replayOnlyBatch\)/.test(workerLoopBlock),
  workerLoopBlock.slice(0, 1800)
);

process.exit(failed === 0 ? 0 : 1);
