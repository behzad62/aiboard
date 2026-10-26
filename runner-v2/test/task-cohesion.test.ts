import assert from "node:assert/strict";
import test from "node:test";

import {
  buildArchitectSystemPrompt,
  coverageReviewerSystemPrompt,
  PLAN_CRITIC_INVARIANTS,
} from "../src/agent-prompts.js";
import { TASK_CONTRACT_SCHEMA } from "../src/planning-tool-schemas.js";
import { TASK_COHESION_GUIDELINE, TASK_COHESION_REVIEW_INSTRUCTIONS } from "../src/task-cohesion.js";

test("current Architect prompts carry the same outcome-based task rule with planning on and off", () => {
  for (const planningPolicyVersion of [undefined, 1]) {
    const prompt = buildArchitectSystemPrompt({ projectDocsPolicyVersion: 2, planningPolicyVersion });
    assert.ok(prompt.includes(TASK_COHESION_GUIDELINE));
  }
  // Contracts carry the rule even for runs using the older, byte-frozen system prompt.
  assert.ok(String(TASK_CONTRACT_SCHEMA.description).includes(TASK_COHESION_GUIDELINE));
});

test("both plan reviewers check cohesion, including correction reviews, without contaminating blind derivation", () => {
  assert.ok(PLAN_CRITIC_INVARIANTS.includes(TASK_COHESION_REVIEW_INSTRUCTIONS));
  for (const mode of ["verdict", "rereview-verdict"] as const) {
    const prompt = coverageReviewerSystemPrompt(mode);
    assert.ok(prompt.includes(TASK_COHESION_REVIEW_INSTRUCTIONS));
    assert.ok(prompt.includes("undersized_task"));
    assert.ok(prompt.includes("incoherent_task"));
  }
  assert.ok(!coverageReviewerSystemPrompt("derive").includes(TASK_COHESION_REVIEW_INSTRUCTIONS));
});
