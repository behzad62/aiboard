import assert from "node:assert/strict";
import {
  benchmarkEffortForModel,
  benchmarkVariantKey,
  benchmarkVariantLabel,
  normalizeBenchmarkEffortForModel,
  normalizeBenchmarkReasoningEffort,
  supportedBenchmarkReasoningEfforts,
  type BenchmarkModelEffortMap,
} from "../lib/benchmark/model-effort";

assert.equal(normalizeBenchmarkReasoningEffort(undefined), "default");
assert.equal(normalizeBenchmarkReasoningEffort("xhigh"), "xhigh");
assert.equal(normalizeBenchmarkReasoningEffort("bogus"), "default");
assert.equal(
  benchmarkVariantKey("anthropic:claude-opus-5", "high"),
  "anthropic:claude-opus-5\u0000high"
);
assert.equal(
  benchmarkVariantLabel("Claude Opus 5", "xhigh"),
  "Claude Opus 5 · Extra high"
);
assert.equal(
  benchmarkVariantLabel("Claude Opus 5", undefined),
  "Claude Opus 5 · Default"
);
assert.deepEqual(
  supportedBenchmarkReasoningEfforts({
    modelId: "custom:plain-model",
    providerId: "custom",
  }),
  ["default"]
);
assert.equal(
  normalizeBenchmarkEffortForModel(
    { modelId: "google:gemini-3.6-flash", providerId: "google" },
    "max"
  ),
  "default"
);

const effortMap: BenchmarkModelEffortMap = {
  "openai:gpt-5.6-sol": "max",
  "openai:gpt-5.4": "xhigh",
};
assert.equal(benchmarkEffortForModel(effortMap, "openai:gpt-5.6-sol"), "max");
assert.equal(benchmarkEffortForModel(effortMap, "openai:gpt-5.5"), "default");

console.log("PASS");
