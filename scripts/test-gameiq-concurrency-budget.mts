/* GameIQ aggregate provider-concurrency guard
 * (run: npx tsx scripts/test-gameiq-concurrency-budget.mts).
 *
 * Three ModelIQ models must never exceed eight simultaneous GameIQ calls:
 * two admitted model jobs, each fanning out to four scenario calls.
 */
import assert from "node:assert/strict";
import {
  MAX_PARALLEL_GAMEIQ_MODELS,
  mapWithConcurrency,
} from "../lib/benchmark/certified/run-execution";

const executionModule = (await import(
  "../lib/benchmark/certified/run-execution"
)) as typeof import("../lib/benchmark/certified/run-execution") & {
  MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL: number;
};
const { MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL } = executionModule;

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for the GameIQ concurrency batch.");
}

const modelIds = ["model-a", "model-b", "model-c"];
const scenarioCount = MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL ?? 4;
const modelGates = new Map<string, Deferred[]>();
let activePhysicalCalls = 0;
let peakPhysicalCalls = 0;
let startedModelJobs = 0;
let completedModelJobs = 0;

const runs = mapWithConcurrency(
  modelIds,
  MAX_PARALLEL_GAMEIQ_MODELS,
  async (modelId) => {
    startedModelJobs++;
    const gates = Array.from({ length: scenarioCount }, () => deferred());
    modelGates.set(modelId, gates);
    const scenarioCalls = gates.map(async (gate) => {
      activePhysicalCalls++;
      peakPhysicalCalls = Math.max(peakPhysicalCalls, activePhysicalCalls);
      await gate.promise;
      activePhysicalCalls--;
    });
    await Promise.all(scenarioCalls);
    completedModelJobs++;
  }
);

await waitFor(
  () => startedModelJobs === Math.min(MAX_PARALLEL_GAMEIQ_MODELS, modelIds.length)
);
const startedModelJobsBeforeFirstRelease = startedModelJobs;

for (const modelId of modelIds.slice(0, startedModelJobsBeforeFirstRelease)) {
  modelGates.get(modelId)!.forEach((gate) => gate.release());
}

await waitFor(() => completedModelJobs === startedModelJobsBeforeFirstRelease);
await waitFor(() => startedModelJobs === modelIds.length);

for (const modelId of modelIds.slice(startedModelJobsBeforeFirstRelease)) {
  modelGates.get(modelId)!.forEach((gate) => gate.release());
}
await runs;

assert.ok(
  peakPhysicalCalls <= 8,
  `three ModelIQ models opened ${peakPhysicalCalls} simultaneous GameIQ calls`
);
assert.equal(
  startedModelJobsBeforeFirstRelease,
  2,
  `expected two admitted models before release, got ${startedModelJobsBeforeFirstRelease}`
);
assert.equal(MAX_PARALLEL_GAMEIQ_SCENARIOS_PER_MODEL, 4);
assert.equal(completedModelJobs, 3);
console.log("PASS three ModelIQ models never exceed eight simultaneous GameIQ calls");
