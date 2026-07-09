/** Build live-checkpoint integration checks (run: npx tsx scripts/test-build-live-checkpoint.mts) */
import { readFileSync } from "node:fs";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const source = readFileSync("lib/client/build-engine.ts", "utf8");

check(
  "build engine marker advertises live-checkpoint durability behavior",
  /const BUILD_ENGINE_VERSION = "build-contracts-v1-live-checkpoint-v3"/.test(source)
);

const messageInsertIndex = source.indexOf("insertMessage({");
const messageCompleteIndex = source.indexOf('emit({ type: "message_complete"', messageInsertIndex);
const messagePersistenceBlock =
  messageInsertIndex >= 0 && messageCompleteIndex > messageInsertIndex
    ? source.slice(messageInsertIndex, messageCompleteIndex)
    : "";

check(
  "persisted model messages touch the live checkpoint before message_complete",
  /touchLiveCheckpoint\(\{\s*reason:\s*`\$\{opts\.label\} message persisted`/.test(
    messagePersistenceBlock
  ),
  {
    messageInsertIndex,
    messageCompleteIndex,
    messagePersistenceBlock: messagePersistenceBlock.slice(0, 800),
  }
);

const workerBatchStart = source.indexOf("const dispatchWorkerToolBatch = async");
const workerBatchTelemetry = source.indexOf('type: "tool_batch"', workerBatchStart);
const workerBatchReturn = source.indexOf("return {", workerBatchTelemetry);
const workerBatchBlock =
  workerBatchTelemetry >= 0 && workerBatchReturn > workerBatchTelemetry
    ? source.slice(workerBatchTelemetry, workerBatchReturn)
    : "";

check(
  "worker tool batches touch the live checkpoint after emitting batch telemetry",
  /touchLiveCheckpoint\(\{\s*reason:\s*`\$\{actor\} tool batch`/.test(workerBatchBlock),
  {
    workerBatchStart,
    workerBatchTelemetry,
    workerBatchReturn,
    workerBatchBlock: workerBatchBlock.slice(-900),
  }
);

process.exit(failed === 0 ? 0 : 1);
