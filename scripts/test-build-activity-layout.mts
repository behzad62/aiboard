/** Build workspace layout contract (run: npx tsx scripts/test-build-activity-layout.mts) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "app", "discussion", "discussion-client.tsx"),
  "utf8"
);
const workspace = readFileSync(
  join(process.cwd(), "components", "build", "BuildWorkspace.tsx"),
  "utf8"
);

function slice(from: string, to: string): string {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `missing ${from}`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `missing ${to} after ${from}`);
  return source.slice(start, end);
}

assert.match(source, /<BuildWorkspace\b/, "Build sessions render the workspace layout");

// Every owner gate is a dock decision, not a panel buried in the page.
const gates = slice("const decisions: WorkspaceDecision[] = [];", "const banner = (");
for (const id of [
  "architect-question",
  "command-approval",
  "permission-",
  "verifier-selection",
  "architect-handoff",
  "project-handoff",
]) {
  assert.ok(gates.includes(`id: "${id}`) || gates.includes(`id: \`${id}`), `${id} is a dock decision`);
}
assert.ok(gates.includes("The Architect has finished"), "final project handoff is a dock decision");

// Guidance goes through the pinned composer.
const composer = slice("const composer = (", "const overview = (");
assert.ok(composer.includes("<BuildNoteDraftField"), "composer holds the guidance field");
assert.ok(composer.includes("submitNote()"), "composer sends durable guidance");

// Run-level progress lives in the Activity view (moved from Overview in 36a6b03a); budget and
// stats in Run details.
const activity = slice("        activity={", "        settings={");
assert.ok(activity.includes("<RunnerV2ObservabilityPanel"), "Activity shows build activity");
assert.ok(activity.includes("<NativePlanningPanel"), "Activity shows planning");
assert.ok(activity.includes('section="ledger"'), "Activity shows the steering ledger");
const details = slice("details={", "\n      />");
assert.ok(details.includes("<BuildRunStats"), "Run details show build stats");

assert.equal(source.indexOf("<BuildContextPanel"), -1, "the budget/context panel stays retired");
assert.ok(workspace.includes('aria-labelledby="needs-you-title"'), "dock labels the decisions it holds");
assert.ok(workspace.includes('role="dialog"'), "Run details become a dialog sheet on narrow screens");

console.log("PASS build workspace layout");
