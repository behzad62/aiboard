/** Build context manager checks (run: npx tsx scripts/test-build-context-manager.mts) */
import assert from "node:assert/strict";

import {
  BuildContextManager,
  renderAssembledContext,
  type ContextPack,
} from "../lib/build-context";
import {
  buildArchitectPlanPrompt,
  buildArchitectReviewPrompt,
  buildArchitectSummaryPrompt,
  buildWorkerTaskPrompt,
  type BuildTask,
} from "../lib/orchestrator/build";
import { buildMemoryRecord } from "../lib/build-context/memory-store";
import type { ModelContextProfile } from "../lib/providers/model-context";

const text = (label: string, words: number) =>
  Array.from({ length: words }, (_, index) => `${label}_${index}`).join(" ");

function profileFor(
  fullModelId: string,
  contextWindowTokens: number,
  effectiveBuildInputCeilingTokens: number
): ModelContextProfile {
  const [providerId, modelId] = fullModelId.split(":");
  return {
    providerId,
    modelId,
    fullModelId,
    contextWindowTokens,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: Math.min(128_000, contextWindowTokens / 4),
    effectiveBuildInputCeilingTokens,
    longContextQuality: contextWindowTokens >= 1_000_000 ? "excellent" : "good",
    promptCaching: true,
    recommendedBuildRoles: ["architect", "worker", "reviewer", "summary"],
    source: "default",
  };
}

const standardProfile = profileFor("openai:standard-64k", 64_000, 56_000);
const hugeProfile = profileFor("openai:frontier-1m", 1_048_576, 920_000);

const manager = new BuildContextManager();
const sharedPacks: ContextPack[] = Array.from({ length: 24 }, (_, index) => ({
  id: `history-${index}`,
  title: `Design history ${index}`,
  kind: "history",
  content: text(`history${index}`, 1_100),
  digest: `Digest for history ${index}`,
  priority: 24 - index,
  createdAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
}));

const planStandard = manager.buildPlanContext({
  modelContextProfile: standardProfile,
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  fileContext: `Key project files:\n--- package.json ---\n${text("package", 250)}`,
  previousSummary: text("previous", 180),
  userNotes: "Prefer small targeted edits.",
  contextPacks: sharedPacks,
});
const planHuge = manager.buildPlanContext({
  modelContextProfile: hugeProfile,
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  fileContext: `Key project files:\n--- package.json ---\n${text("package", 250)}`,
  previousSummary: text("previous", 180),
  userNotes: "Prefer small targeted edits.",
  contextPacks: sharedPacks,
});

assert.equal(planStandard.budget.tier, "standard");
assert.equal(planHuge.budget.tier, "huge");
assert.ok(
  planHuge.rendered.contentTokenTotal > planStandard.rendered.contentTokenTotal &&
    planHuge.rendered.assembly.selected.filter((pack) => pack.mode === "full").length >
      planStandard.rendered.assembly.selected.filter((pack) => pack.mode === "full").length,
  "1M Architect plan context should include richer pack content than a 64K Architect"
);
assert.match(renderAssembledContext(planHuge), /Context tier: huge/);

const reviewStandard = manager.buildReviewContext({
  modelContextProfile: standardProfile,
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  fileContext: text("read_file", 600),
  executedText: text("executed", 500),
  outstandingTasks: "T3 (planned): add parser edge cases",
  verificationText: "npx tsc --noEmit failed: parser return type is too wide.",
  contextPacks: sharedPacks,
});
const reviewHuge = manager.buildReviewContext({
  modelContextProfile: hugeProfile,
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  fileContext: text("read_file", 600),
  executedText: text("executed", 500),
  outstandingTasks: "T3 (planned): add parser edge cases",
  verificationText: "npx tsc --noEmit failed: parser return type is too wide.",
  contextPacks: sharedPacks,
});
assert.ok(
  reviewHuge.rendered.contentTokenTotal > reviewStandard.rendered.contentTokenTotal &&
    reviewHuge.rendered.assembly.selected.filter((pack) => pack.mode === "full").length >
      reviewStandard.rendered.assembly.selected.filter((pack) => pack.mode === "full").length,
  "1M Architect review context should include richer pack content than a 64K review context"
);

const task: BuildTask = {
  id: "T1",
  title: "Implement parser",
  instructions: "Modify only src/parser.ts.",
  contextFiles: ["src/parser.ts"],
  outputPaths: ["src/parser.ts"],
  expectedOutputs: "Parser code and focused notes",
  status: "planned",
};
const workerHuge = manager.buildWorkerContext({
  modelContextProfile: hugeProfile,
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts\ndocs/unrelated.md",
  task,
  architectNotes: "Keep edits narrow.",
  contextFileText: `Context files:\n--- src/parser.ts ---\n${text("parser", 240)}`,
  contextPacks: [
    {
      id: "task-source",
      title: "Parser source",
      kind: "source",
      sourcePath: "src/parser.ts",
      content: "export function parse(input: string) { return input; }",
      priority: 10,
    },
    {
      id: "unrelated-source",
      title: "Unrelated large source",
      kind: "source",
      sourcePath: "docs/unrelated.md",
      content: `SECRET_UNRELATED_CONTEXT ${text("unrelated", 2_000)}`,
      priority: 10_000,
    },
  ],
});
const workerHugeText = renderAssembledContext(workerHuge);
assert.match(workerHugeText, /src\/parser\.ts/);
assert.doesNotMatch(workerHugeText, /SECRET_UNRELATED_CONTEXT/);

const planPrompt = buildArchitectPlanPrompt({
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["Worker A"],
  readHopsLeft: 0,
  assembledContext: planHuge,
});
assert.match(planPrompt, /Assembled build context/);
assert.match(planPrompt, /Context tier: huge/);

const workerPrompt = buildWorkerTaskPrompt({
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  task,
  contextFileText: "",
  architectNotes: "",
  assembledContext: workerHuge,
});
assert.match(workerPrompt, /Assembled build context/);
assert.match(workerPrompt, /YOUR TASK.*T1/);
assert.doesNotMatch(workerPrompt, /SECRET_UNRELATED_CONTEXT/);

const reviewPrompt = buildArchitectReviewPrompt({
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  executedText: "",
  maxNewTasks: 2,
  cyclesLeft: 1,
  assembledContext: reviewHuge,
});
assert.match(reviewPrompt, /npx tsc --noEmit failed/);
assert.match(reviewPrompt, /Required tasks still not done/);

const memory = buildMemoryRecord({
  projectKey: "repo:example/parser",
  kind: "decision",
  summary: "Keep parser diagnostics explicit and avoid claiming unrun browser tests.",
  evidence: [{ kind: "review", ref: "wave-2" }],
  createdAt: "2026-06-26T00:00:00.000Z",
});
const summaryContext = manager.buildSummaryContext({
  modelContextProfile: hugeProfile,
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  filesChanged: "src/parser.ts",
  historyText: "T1 approved after parser diagnostics were fixed.",
  verificationText: "Verification performed: npx tsc --noEmit PASS.",
  knownGaps: "Browser smoke testing was not performed.",
  memoryRecords: [memory],
});
const summaryPrompt = buildArchitectSummaryPrompt({
  request: "Build a typed parser",
  treeText: "package.json\nsrc/parser.ts",
  filesChanged: "src/parser.ts",
  historyText: "",
  assembledContext: summaryContext,
});
assert.match(summaryPrompt, /Build memory/);
assert.match(summaryPrompt, /Verification performed: npx tsc --noEmit PASS/);
assert.match(summaryPrompt, /Browser smoke testing was not performed/);
assert.match(summaryPrompt, /do NOT claim changes to any file not listed/i);

console.log("PASS build context manager tests");
