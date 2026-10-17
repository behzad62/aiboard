/** Focused build workspace feed + event classification checks. Run: npx tsx scripts/test-build-ui-overhaul.mts */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildTranscriptFeed, buildActorRole, sortedBuildFeed } from "../components/build/BuildTranscriptFeed";
import { BuildEventCenter, alertsFromDiagnostics } from "../components/build/BuildEventCenter";
import type { DiagnosticEntry } from "../components/DiscussionDiagnostics";

const messages = [
  { id: "worker", round: 3, ordinal: 2, modelId: "native:worker:1", modelName: "Worker 1 · GPT", content: "Worker built tests" },
  { id: "verifier", round: 3, ordinal: 3, modelId: "native:verifier:1", modelName: "Verifier · GPT", content: "Verifier checked tests" },
  { id: "architect", round: 3, ordinal: 1, modelId: "native:architect:1", modelName: "Architect · GPT", content: "Architect assigned work" },
];
assert.deepEqual(sortedBuildFeed(messages).map((message) => message.id), ["architect", "worker", "verifier"]);
assert.deepEqual(messages.map(buildActorRole), ["worker", "verifier", "architect"]);
const feed = renderToStaticMarkup(createElement(BuildTranscriptFeed, {
  messages, active: true, onDownload() {},
}));
assert.ok(feed.includes("Build transcript"));
assert.ok(feed.indexOf("Architect assigned work") < feed.indexOf("Worker built tests"));
assert.ok(feed.indexOf("Worker built tests") < feed.indexOf("Verifier checked tests"));
assert.ok(feed.includes('aria-expanded="true"'));
assert.ok(feed.includes("Export"));

const entries: DiagnosticEntry[] = [
  { id: "e1", at: "10:10", phase: "model_failed", message: "Provider request failed" },
  { id: "e2", at: "10:11", phase: "model_streaming", message: "Retrying after rate limit" },
  { id: "e3", at: "10:12", phase: "model_completed", message: "Model completed successfully" },
];
const alerts = alertsFromDiagnostics(entries);
assert.deepEqual(alerts.map((item) => [item.id, item.kind]), [["e1", "error"], ["e2", "warning"]]);
const icons = renderToStaticMarkup(createElement(BuildEventCenter, {
  scope: "ui-overhaul-test", events: alerts,
}));
assert.ok(icons.includes("View errors, 1 new"));
assert.ok(icons.includes("View warnings, 1 new"));
assert.ok(icons.includes("animate-ping"));
console.log("PASS build UI overhaul: all-role feed, chronology, expansion, alert severity and unread indicators");
