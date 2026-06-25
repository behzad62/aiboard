import assert from "node:assert/strict";

import {
  buildArchitectPlanPrompt,
  buildArchitectReviewPrompt,
  buildWorkerTaskPrompt,
} from "../lib/orchestrator/build";

const skillContext = [
  "BUILD SKILL CONTEXT",
  "Active skill overlays:",
  "- agent:test-driven-development",
  "Evidence required:",
  "- RED test failure before implementation; GREEN pass after implementation.",
].join("\n");

const planPrompt = buildArchitectPlanPrompt({
  request: "Build a feature",
  treeText: "package.json",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["Worker A"],
  readHopsLeft: 0,
  skillContext,
});

assert.match(planPrompt, /BUILD SKILL CONTEXT/);
assert.match(planPrompt, /agent:test-driven-development/);
assert.match(planPrompt, /To plan, respond/);

const workerPrompt = buildWorkerTaskPrompt({
  request: "Build a feature",
  treeText: "package.json",
  task: {
    id: "T1",
    title: "Implement feature",
    instructions: "Add behavior.",
    contextFiles: [],
    outputPaths: ["lib/example.ts"],
    expectedOutputs: "Working code",
    status: "planned",
    failCount: 0,
  },
  contextFileText: "",
  architectNotes: "",
  skillContext,
});

assert.match(workerPrompt, /BUILD SKILL CONTEXT/);
assert.match(workerPrompt, /Skill evidence/);
assert.match(workerPrompt, /YOUR TASK.*T1/);

const reviewPrompt = buildArchitectReviewPrompt({
  request: "Build a feature",
  treeText: "package.json",
  executedText: "T1 wrote lib/example.ts",
  maxNewTasks: 2,
  cyclesLeft: 3,
  skillContext,
  skillEvidenceText:
    "Skill evidence gaps:\n- T1 used TDD but did not report RED evidence.",
});

assert.match(reviewPrompt, /BUILD SKILL CONTEXT/);
assert.match(reviewPrompt, /Skill evidence gaps/);
assert.match(reviewPrompt, /End with ONE fenced json block/);

console.log("PASS build skill prompt tests");
