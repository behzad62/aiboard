import assert from "node:assert/strict";

import { buildSkillContext } from "../lib/skills/render";
import { createSkillEvidence } from "../lib/skills/evidence";
import { resolveSkillSet, selectSkills } from "../lib/skills/router";

const baseInput = {
  userRequest: "Add skill-aware Build mode orchestration.",
  runnerAvailable: true,
  repoAvailable: true,
  riskFlags: [],
};

const plan = selectSkills({
  ...baseInput,
  phase: "plan",
  actor: "architect",
});

assert.deepEqual(
  plan.overlays,
  [
    "agent:planning-and-task-breakdown",
    "superpowers:writing-plans",
    "agent:context-engineering",
  ],
  "planning should load lifecycle planning, exact-plan, and context skills"
);
assert.ok(
  plan.always.includes("aiboard:build-os") &&
    plan.always.includes("aiboard:tool-protocol"),
  "AIBoard native rules should always be active"
);
assert.ok(plan.index.length >= 10, "compact skill index should be available");

const uiWorker = selectSkills({
  ...baseInput,
  phase: "worker",
  actor: "worker",
  task: {
    id: "T1",
    title: "Add a Build skills panel",
    instructions: "Render active skills and warnings in the discussion page.",
    contextFiles: ["app/discussion/discussion-client.tsx"],
    outputPaths: ["components/BuildSkillsPanel.tsx"],
    expectedOutputs: "Panel displays active skills and evidence.",
    status: "planned",
  },
});

assert.deepEqual(
  uiWorker.overlays,
  [
    "agent:incremental-implementation",
    "agent:test-driven-development",
    "agent:frontend-ui-engineering",
  ],
  "UI behavior tasks should receive incremental, TDD, and UI skills"
);
assert.ok(
  uiWorker.evidenceRequired.some((item) => item.includes("RED")),
  "TDD worker tasks should require red/green evidence"
);

const bugWorker = selectSkills({
  ...baseInput,
  phase: "worker",
  actor: "worker",
  task: {
    id: "T2",
    title: "Fix failing parser test",
    instructions: "Investigate the regression and fix the bug.",
    contextFiles: ["lib/orchestrator/build.ts"],
    outputPaths: ["lib/orchestrator/build.ts", "scripts/test-parse-action.mts"],
    expectedOutputs: "The parser regression test passes.",
    status: "fixing",
  },
});

assert.ok(
  bugWorker.overlays.includes("superpowers:systematic-debugging"),
  "bug fixes should load systematic debugging"
);
assert.ok(
  bugWorker.overlays.includes("agent:test-driven-development"),
  "bug fixes should keep TDD active"
);

const strictBugWorker = selectSkills({
  ...baseInput,
  phase: "worker",
  actor: "worker",
  skillMode: "strict",
  task: {
    id: "T2",
    title: "Fix failing parser test",
    instructions: "Investigate the regression and fix the bug.",
    contextFiles: ["lib/orchestrator/build.ts"],
    outputPaths: ["lib/orchestrator/build.ts", "scripts/test-parse-action.mts"],
    expectedOutputs: "The parser regression test passes.",
    status: "fixing",
  },
});

assert.ok(
  strictBugWorker.overlays.includes("superpowers:strict-test-driven-development"),
  "strict mode should use the Superpowers strict TDD card"
);
assert.ok(
  !strictBugWorker.overlays.includes("agent:test-driven-development"),
  "strict mode should resolve the regular TDD conflict"
);

const docsWorker = selectSkills({
  ...baseInput,
  phase: "worker",
  actor: "worker",
  task: {
    id: "T3",
    title: "Document skill routing",
    instructions: "Update documentation only.",
    contextFiles: ["README.md"],
    outputPaths: ["docs/skills.md"],
    expectedOutputs: "Markdown documentation.",
    status: "planned",
  },
});

assert.deepEqual(
  docsWorker.overlays,
  ["agent:incremental-implementation", "agent:documentation-and-adrs"],
  "docs-only tasks should be TDD-exempt and load documentation guidance"
);
assert.ok(
  docsWorker.evidenceRequired.some((item) => item.includes("TDD exemption")),
  "docs-only task should record a TDD exemption reason"
);

const securityWorker = selectSkills({
  ...baseInput,
  phase: "worker",
  actor: "worker",
  task: {
    id: "T4",
    title: "Harden runner path validation",
    instructions: "Validate untrusted file paths before shell access.",
    contextFiles: ["lib/client/runner.ts"],
    outputPaths: ["lib/client/runner.ts"],
    expectedOutputs: "Unsafe paths are rejected.",
    status: "planned",
  },
});

assert.ok(
  securityWorker.overlays.includes("agent:security-and-hardening"),
  "trust-boundary tasks should load security guidance"
);

const safeUiWorker = selectSkills({
  ...baseInput,
  phase: "worker",
  actor: "worker",
  skillMode: "safe",
  task: {
    id: "T5",
    title: "Update dashboard copy",
    instructions: "Change visible UI copy.",
    contextFiles: ["components/DashboardPage.tsx"],
    outputPaths: ["components/DashboardPage.tsx"],
    expectedOutputs: "Updated page copy.",
    status: "planned",
  },
});

assert.ok(
  safeUiWorker.overlays.includes("agent:security-and-hardening"),
  "safe mode should keep security active for runner/repo-enabled builds"
);

const browserAcceptanceWorker = selectSkills({
  ...baseInput,
  phase: "worker",
  actor: "worker",
  mcpServers: ["playwright"],
  task: {
    id: "T6",
    title: "Verify web app workflow in browser",
    instructions:
      "Start the local web app and use Playwright to verify the main UI workflow.",
    contextFiles: ["public/app.js", "public/index.html"],
    outputPaths: [],
    expectedOutputs: "Browser acceptance evidence.",
    status: "planned",
  },
});

assert.ok(
  browserAcceptanceWorker.overlays.includes("aiboard:browser-acceptance"),
  "web/UI worker tasks with Playwright MCP should load browser-acceptance guidance"
);
assert.ok(
  browserAcceptanceWorker.evidenceRequired.some((item) =>
    item.includes("Browser action evidence")
  ),
  "browser-acceptance tasks should require explicit browser evidence"
);

const resolved = resolveSkillSet(
  ["agent:test-driven-development", "superpowers:strict-test-driven-development"],
  { skillMode: "strict" }
);
assert.deepEqual(
  resolved.ids,
  ["superpowers:strict-test-driven-development"],
  "resolver should keep the strict TDD winner"
);
assert.ok(resolved.warnings.some((warning) => warning.includes("conflict")));

const rendered = buildSkillContext({
  ...baseInput,
  phase: "plan",
  actor: "architect",
});
assert.match(rendered, /AIBoard Build OS/);
assert.match(rendered, /Compact Skill Index/);
assert.match(rendered, /planning-and-task-breakdown/);
assert.doesNotMatch(rendered, /fullMarkdown/);

const evidence = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: uiWorker.overlays,
  workerOutput:
    "Done.\n\nSkill evidence:\n- RED: npx tsx scripts/test-skill-router.mts failed before implementation.\n- GREEN: npx tsx scripts/test-skill-router.mts passed after implementation.",
});

assert.equal(evidence.length, 1, "only evidence-requiring skills should be recorded");
assert.equal(evidence[0].skillId, "agent:test-driven-development");
assert.deepEqual(evidence[0].missingEvidence, []);
assert.equal(evidence[0].violations.length, 0);

const missing = createSkillEvidence({
  taskId: "T1",
  actor: "worker",
  activeSkillIds: uiWorker.overlays,
  workerOutput: "Done with no evidence section.",
});
assert.ok(
  missing[0].missingEvidence.length > 0,
  "missing evidence should be visible to the Architect/UI"
);

const missingBrowserEvidence = createSkillEvidence({
  taskId: "T6",
  actor: "worker",
  activeSkillIds: ["aiboard:browser-acceptance"],
  workerOutput:
    "Done.\n\nSkill evidence:\n- Browser acceptance attempted but not completed.",
});
assert.ok(
  missingBrowserEvidence[0].missingEvidence.length >= 2,
  "vague browser acceptance claims should not satisfy the browser evidence gate"
);

const completeBrowserEvidence = createSkillEvidence({
  taskId: "T6",
  actor: "worker",
  activeSkillIds: ["aiboard:browser-acceptance"],
  workerOutput:
    [
      "Done.",
      "",
      "Skill evidence:",
      "- Browser action evidence: browser_navigate opened http://localhost:3001 and browser_snapshot captured the app.",
      "- Post-action settled evidence: expected content visible, no visible stuck loading, no error banner, no blank screen, no blocking overlay.",
      "- Console evidence: browser_console_messages level error returned no console errors.",
    ].join("\n"),
});
assert.deepEqual(
  completeBrowserEvidence[0].missingEvidence,
  [],
  "concrete browser acceptance evidence should satisfy the browser gate"
);

console.log("PASS skill router tests");
