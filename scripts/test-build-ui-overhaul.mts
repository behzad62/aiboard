/** Focused build workspace feed + event classification checks. Run: npx tsx scripts/test-build-ui-overhaul.mts */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildTranscriptFeed, buildActorRole, buildModelDisplayName, buildDisplayText, buildModelIdentityParts, sortedBuildFeed } from "../components/build/BuildTranscriptFeed";
import { BuildWorkspace } from "../components/build/BuildWorkspace";
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

// The A/W/V timeline marker conveys the role once; don't repeat it visibly
// in the card heading or a provider-generated speaker prefix.
assert.equal(buildModelDisplayName({ modelId: "native:architect:1", modelName: "Architect · deepseek-flash" }), "deepseek-flash");
assert.equal(buildModelDisplayName({ modelId: "native:worker:1", modelName: "Worker worker_1 · gpt-6" }), "gpt-6");
assert.equal(buildModelDisplayName({ modelId: "native:verifier:1", modelName: "Verifier · claude" }), "claude");
assert.equal(buildDisplayText("**Architect**: Reviewed the change", "architect"), "Reviewed the change");
assert.equal(buildDisplayText("Worker: Implementing tests", "worker"), "Implementing tests");
assert.equal(buildDisplayText("**Worker:** Implementing tests", "worker"), "Implementing tests");
assert.equal(buildDisplayText("### Worker\n\nImplementing tests", "worker"), "Implementing tests");
assert.equal(buildDisplayText("Verifier — Tests passed", "verifier"), "Tests passed");
assert.equal(buildDisplayText("Architectural changes are needed", "architect"), "Architectural changes are needed");
const cleaned = renderToStaticMarkup(createElement(BuildTranscriptFeed, {
  messages: [{ id: "role-clean", round: 1, modelId: "native:architect:1", modelName: "Architect · deepseek-flash", content: "**Architect**: Updated the plan" }],
  active: false, onDownload() {},
}));
assert.ok(cleaned.includes("deepseek-flash"));
assert.ok(cleaned.includes("Updated the plan"));
assert.ok(!cleaned.includes("**Architect**:"));
assert.ok(!cleaned.includes('font-semibold uppercase tracking-wider">architect</span>'));

const qualifiedFeed = renderToStaticMarkup(createElement(BuildTranscriptFeed, {
  messages: [
    { id: "role-task", round: 1, modelId: "openrouter-runtime",
      modelName: "Worker worker-task · openrouter / deepseek/flash",
      taskId: "task-auth", taskTitle: "Implement OAuth session persistence", content: "Implementing now" },
  ],
  active: true,
  activeActors: [
    { id: "active-worker", role: "worker", name: "deepseek / deepseek/flash",
      taskId: "task-api", taskTitle: "Build MCP relay API" },
  ],
  onDownload() {},
}));
assert.deepEqual(buildModelIdentityParts("openrouter / deepseek/flash"), { provider: "OpenRouter", model: "deepseek/flash" });
assert.deepEqual(buildModelIdentityParts("deepseek / deepseek/deepseek-chat"), { provider: "DeepSeek", model: "deepseek/deepseek-chat" });
assert.deepEqual(buildModelIdentityParts("GPT-6"), { provider: null, model: "GPT-6" });
assert.ok(qualifiedFeed.includes("openrouter / deepseek/flash"));
assert.ok(qualifiedFeed.includes("border-sky-400/25 bg-sky-500/10"), "Model identity is in a filled blue chip");
assert.ok(qualifiedFeed.includes("bg-violet-500/15"), "Task is in a filled purple chip");
assert.ok(qualifiedFeed.includes("flex-nowrap"), "Model and task must stay on the same header row");
assert.ok(qualifiedFeed.indexOf(">OpenRouter</span>") < qualifiedFeed.indexOf(">deepseek/flash</span>"), "Provider precedes model in chip");
assert.ok(qualifiedFeed.indexOf(">deepseek/flash</span>") < qualifiedFeed.indexOf(">task-auth</span>"), "Task chip follows model on the same row");
assert.ok(qualifiedFeed.includes("task-auth"));
assert.ok(qualifiedFeed.includes("Implement OAuth session persistence"));
assert.ok(qualifiedFeed.includes("deepseek / deepseek/flash"));
assert.ok(qualifiedFeed.includes("task-api"));
assert.ok(qualifiedFeed.includes("Build MCP relay API"));
assert.ok(!qualifiedFeed.includes(">worker-task<"), "Internal worker actor ID is not the card heading");

// Build header stays underneath the app navbar (h-14) and above the transcript.
const workspace = renderToStaticMarkup(createElement(BuildWorkspace, {
  topic: "Build test project", statusPill: "Building", crew: { workers: [], verifiers: [] }, runnerChip: "Runner",
  actions: null, notifications: null, tasks: [], view: { kind: "overview" as const },
  onViewChange() {}, overview: "Transcript body", files: null, transcript: null,
  activity: null, settings: null, decisions: [], composer: null, details: null,
}));
assert.ok(workspace.includes("glass-bar sticky top-14 z-30"), "Build summary must use the glass surface and stay below global navigation");
assert.ok(workspace.includes("font-sans text-base font-semibold"), "Build title must use compact typography");
assert.ok(!workspace.includes("xl:text-[1.75rem]"), "Build title must not use the oversized display font");
assert.ok(workspace.includes("Build test project"));
assert.ok(workspace.includes("Transcript body"));

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
