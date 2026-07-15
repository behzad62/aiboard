import assert from "node:assert/strict";
import { EFFORT_CONFIG, clampJudgeMaxTokens } from "../lib/orchestrator/config";
import { assessJudgeOutput } from "../lib/orchestrator/parse";

const completeAnswer = [
  "# Complete answer",
  "",
  "---",
  "<!--meta",
  "confidence: 8",
  "dissent:",
  "-->",
].join("\n");

assert.equal(EFFORT_CONFIG.low.judgeMaxTokens, 24_576);
assert.equal(EFFORT_CONFIG.medium.judgeMaxTokens, 49_152);
assert.equal(EFFORT_CONFIG.high.judgeMaxTokens, 65_536);
assert.equal(clampJudgeMaxTokens(49_152, 32_768), 32_768);
assert.equal(clampJudgeMaxTokens(49_152, undefined), 49_152);

assert.deepEqual(assessJudgeOutput(completeAnswer, "end_turn"), {
  complete: true,
});
assert.deepEqual(assessJudgeOutput("# Cut off answer", "end_turn"), {
  complete: false,
  reason: "missing_metadata_footer",
});
assert.deepEqual(assessJudgeOutput(completeAnswer, "max_tokens"), {
  complete: false,
  reason: "provider_length_limit",
});

console.log("PASS judge truncation checks");
