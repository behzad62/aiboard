/** Build activity layout order check (run: npx tsx scripts/test-build-activity-layout.mts) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "app", "discussion", "discussion-client.tsx"),
  "utf8"
);

const noteIndex = source.indexOf("Note to the Architect");
const statsIndex = source.indexOf("<BuildRunStats");
const budgetPanelIndex = source.indexOf("<BuildContextPanel");

assert.notEqual(noteIndex, -1, "discussion page renders the Architect note panel");
assert.notEqual(statsIndex, -1, "discussion page renders Build run stats");
assert.ok(
  noteIndex < statsIndex,
  "Architect note panel should render above Build run stats"
);
assert.equal(
  budgetPanelIndex,
  -1,
  "Build activity should not render the budget/context panel for now"
);

console.log("PASS build activity layout order");
