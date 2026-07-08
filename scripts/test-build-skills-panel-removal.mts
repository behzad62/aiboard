/** Build skills debug panel removal checks (run: npx tsx scripts/test-build-skills-panel-removal.mts) */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const discussionClient = readFileSync("app/discussion/discussion-client.tsx", "utf8");

assert.ok(
  discussionClient.includes('case "skill_evidence"'),
  "discussion client should continue accepting skill_evidence events"
);
assert.ok(
  discussionClient.includes("setBuildSkillEvents"),
  "discussion client should preserve skill event state for resumed checkpoints"
);
assert.ok(
  !discussionClient.includes("BuildSkillsPanel"),
  "discussion client should not import or render the Build skills debug panel"
);

console.log("PASS build skills panel removal tests");
