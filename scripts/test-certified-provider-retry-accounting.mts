import assert from "node:assert/strict";
import fs from "node:fs";
import {
  expandCertifiedPhysicalUsages,
  type CertifiedModelCallResult,
} from "../lib/benchmark/certified/model-call";

const result: CertifiedModelCallResult = {
  rawResponse: "{}",
  traceId: "success-physical",
  latencyMs: 30,
  inputTokens: 120,
  outputTokens: 20,
  estimatedUsd: 0.02,
  usageSource: "reported",
  retryAttempts: [{
    traceId: "failed-physical",
    latencyMs: 20,
    inputTokens: 100,
    outputTokens: 10,
    estimatedUsd: 0.01,
  }],
};

const usages = expandCertifiedPhysicalUsages(result);
assert.deepEqual(
  usages.map((usage) => usage.traceId),
  ["failed-physical", "success-physical"]
);
assert.equal(usages.length, 2);
assert.equal(usages.reduce((sum, usage) => sum + usage.inputTokens, 0), 220);
assert.equal(usages.reduce((sum, usage) => sum + usage.outputTokens, 0), 30);
assert.equal(usages.reduce((sum, usage) => sum + usage.latencyMs, 0), 50);
assert.equal(usages.reduce((sum, usage) => sum + (usage.estimatedUsd ?? 0), 0), 0.03);

for (const path of [
  "lib/benchmark/gameiq/certified-runner.ts",
  "lib/benchmark/toolreliability/certified-runner.ts",
  "lib/benchmark/teamiq/certified-runner.ts",
  "lib/benchmark/fireworks/certified-runner.ts",
]) {
  const source = fs.readFileSync(path, "utf8");
  assert.match(
    source,
    /expandCertifiedPhysicalUsages/,
    `${path} must expand every logical result into physical usages`
  );
}
assert.doesNotMatch(
  fs.readFileSync("lib/benchmark/toolreliability/certified-runner.ts", "utf8"),
  /call\.retryAttempts/,
  "Tool Reliability must not retain a one-off retry expansion"
);
console.log("PASS");
