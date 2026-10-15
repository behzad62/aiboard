import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildWorkerSystemPrompt } from "../src/native-worker-driver.js";

/**
 * IV-1 (CD-23): the worker system prompt and the verification skill pin the
 * exact impact-based widening order, the broadening triggers, the
 * budget-justification guidance, the extend/parameterize preference, the
 * `behaviour proven in X` consolidation wording, and truthful submission
 * reporting. Workers are never told to run the whole suite by default.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = readFileSync(join(HERE, "../skills/verification/SKILL.md"), "utf8");

function assertGuidance(raw: string, label: string): void {
  // Prose may wrap; phrases must survive layout.
  const text = raw.replace(/\s+/g, " ");
  // Exact impact-based widening order.
  assert.ok(text.includes("new or changed tests first"), `${label} runs new/changed tests first`);
  assert.ok(text.includes("owning test file"), `${label} names the owning test file/suite next`);
  assert.ok(text.includes("direct dependents"), `${label} names direct dependents/affected scope third`);
  const first = text.indexOf("new or changed tests first");
  const owning = text.indexOf("owning test file");
  const dependents = text.indexOf("direct dependents");
  assert.ok(first < owning && owning < dependents, `${label} keeps the exact widening order`);
  // Broadening triggers.
  assert.ok(text.includes("only for a failure"), `${label} widens only for a failure`);
  assert.ok(text.includes("shared or public contract change"), `${label} widens for a shared/public contract change`);
  assert.ok(text.includes("reviewer-named risk"), `${label} widens for a reviewer-named risk`);
  // Budget justification (guidance only in IV-1).
  assert.ok(text.includes("validation budget"), `${label} stays near the validation budget`);
  assert.ok(text.includes("justify"), `${label} requires justifying broader work`);
  // Extend/parameterize preference.
  assert.ok(
    text.includes("Extend or parameterize existing tests before adding"),
    `${label} prefers extending/parameterizing existing tests`
  );
  // Consolidation wording E1 recognizes.
  assert.ok(
    text.includes("behaviour proven in <test id or file>"),
    `${label} pins the consolidation wording`
  );
  // Truthful submission reporting.
  assert.ok(text.includes("truthfully report"), `${label} requires truthful reporting`);
  assert.ok(text.includes("what changed"), `${label} reports what changed`);
  assert.ok(text.includes("what was verified"), `${label} reports what was verified`);
  assert.ok(text.includes("tests actually run with counts"), `${label} reports tests run with counts`);
  assert.ok(text.includes("not run and why"), `${label} reports what was not run and why`);
  // Never the whole suite by default.
  assert.ok(
    text.includes("Do not run the whole suite by default"),
    `${label} refuses the whole suite by default`
  );
}

test("IV-1 worker system prompt pins impact-based verification guidance", () => {
  assertGuidance(buildWorkerSystemPrompt(), "worker prompt");
  assertGuidance(buildWorkerSystemPrompt(["c1", "c2"]), "worker prompt with criteria");
});

test("IV-1 verification skill pins the same guidance", () => {
  assertGuidance(SKILL, "verification skill");
});
