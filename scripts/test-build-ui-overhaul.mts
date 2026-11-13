/** Focused build workspace feed + event classification checks. Run: npx tsx scripts/test-build-ui-overhaul.mts */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BuildTranscriptFeed, buildActorRole, buildModelDisplayName, buildDisplayText, buildModelIdentityParts, buildRuntimeEffortLabel, sortedBuildFeed } from "../components/build/BuildTranscriptFeed";
import { buildCrewFromDiscussion, selectBuildCrewRuntimes } from "../lib/client/build-crew";
import { BuildWorkspace } from "../components/build/BuildWorkspace";
import { BuildEventCenter, alertsFromDiagnostics } from "../components/build/BuildEventCenter";
import { EnvironmentInventoryPanel } from "../components/build/EnvironmentInventoryPanel";
import { VerificationSummary } from "../components/build/VerificationSummary";
import { FinalVerificationManifest } from "../components/RunnerV2ObservabilityPanel";
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
  runtimeEfforts: { "openrouter-runtime": "high", "direct-runtime": "max" },
  activeActors: [
    { id: "active-worker", role: "worker", name: "deepseek / deepseek/flash", modelId: "direct-runtime",
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
assert.ok(qualifiedFeed.includes(">(High)</span>"), "Reasoning effort appears after the model in parentheses");
assert.ok(qualifiedFeed.includes(">(Max)</span>"), "Active worker uses its configured runtime effort");
assert.ok(qualifiedFeed.includes('aria-label="Reasoning effort: High"'), "The displayed effort has an accessible label");
assert.ok(qualifiedFeed.indexOf(">deepseek/flash</span>") < qualifiedFeed.indexOf(">(High)</span>"), "Effort follows the model");
assert.ok(qualifiedFeed.indexOf(">(High)</span>") < qualifiedFeed.indexOf(">task-auth</span>"), "Task chip still follows the effort on the same row");
assert.equal(buildRuntimeEffortLabel("openrouter-runtime", { "openrouter-runtime": "default" }), "Default");
assert.equal(buildRuntimeEffortLabel("model#xhigh", {}), "Extra High");
assert.equal(buildRuntimeEffortLabel("model#max", {}), "Max");
assert.equal(buildRuntimeEffortLabel("unknown", {}), null, "Never invent effort without runtime metadata");
const effortCrew = buildCrewFromDiscussion({
  modelIds: JSON.stringify(["openrouter:deepseek/flash"]),
  judgeModelId: "openrouter:deepseek/flash",
  reviewerModelId: null,
  reasoningEffort: "medium",
  buildArchitectReasoningEffort: "high",
  buildReviewerReasoningEffort: null,
  buildWorkers: JSON.stringify([{ modelId: "openrouter:deepseek/flash", reasoningEffort: "max" }]),
} as never);
assert.ok(effortCrew);
assert.deepEqual(selectBuildCrewRuntimes(effortCrew!).runtimes.map(
  (runtime) => [runtime.runtimeId, runtime.reasoningEffort]
), [
  ["openrouter:deepseek/flash", "high"],
  ["openrouter:deepseek/flash#max", "max"],
], "Same model under different reasoning effort must retain distinct runtime identities");
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

// VF1: Run details lists the tools the Runner recorded; a run from before VF1 renders nothing.
assert.equal(renderToStaticMarkup(createElement(EnvironmentInventoryPanel, { projection: {} })), "");
const inventoryPanel = renderToStaticMarkup(createElement(EnvironmentInventoryPanel, { projection: { environmentInventory: {
  version: 1, trigger: "resume", platform: "linux", arch: "x64", runnerNode: "v24.21.0",
  tools: [
    { name: "git", status: "found", path: "/usr/bin/git", version: "git version 2.39.5", usedBy: ["runner"] },
    { name: "pytest", status: "missing", usedBy: ["tests: pytest"] },
  ],
  toolsOmitted: 0,
  browsers: [{ id: "chrome", status: "missing" }, { id: "msedge", status: "missing" }, { id: "chromium", status: "found", path: "/c/chrome", version: "149.0" }],
  playwrightBrowser: "chromium",
  notes: [],
  sequence: 9,
  recordedAt: "2026-11-13T10:00:00.000Z",
} } }));
assert.ok(inventoryPanel.includes("Tools on this machine"));
assert.ok(inventoryPanel.includes("Recorded on resume · linux x64 · Node v24.21.0"));
assert.ok(inventoryPanel.includes("git version 2.39.5"));
assert.ok(inventoryPanel.includes("pytest") && inventoryPanel.includes(": Missing.") && inventoryPanel.includes("not found on PATH"));
assert.ok(inventoryPanel.includes("Used by tests: pytest"));
assert.ok(inventoryPanel.includes("Playwright&#x27;s Chromium 149.0"));
console.log("PASS build UI overhaul: Run details tool inventory");

// VF8: Run details says how many checks passed and lists what was not verified; a not-run check
// reads "Not run" and a check that failed at its repair limit reads "Known defect", never "Failed".
{
  const generation = {
    generationId: "g-vf8", taskId: "fv", targetRevision: "a".repeat(40), revisionStatus: "current" as const, categories: [],
    checks: [
      { checkId: "build", label: "package build", kind: "build" as const, origin: "detected" as const, mandatory: true, status: "passed" as const, evidenceIds: ["ev"], issues: [] },
      { checkId: "lint", label: "lint", kind: "other" as const, origin: "architect" as const, mandatory: false, status: "failed" as const, evidenceIds: [], issues: ["lint exited 1"], knownDefect: { reason: "still failing at the repair limit: issue final-verification:lint used 3/3 repair cycles" } },
      { checkId: "cargo", label: "cargo tests", kind: "tests" as const, origin: "detected" as const, mandatory: false, status: "not_run" as const, evidenceIds: [], issues: [], notRun: { reason: "tool_missing" as const, tool: "cargo", detail: "" } },
      { checkId: "start", label: "package start", kind: "start" as const, origin: "detected" as const, mandatory: false, status: "not_run" as const, evidenceIds: [], issues: [], notRun: { reason: "skipped" as const, detail: "A static export has no server." } },
    ],
    submission: { status: "submitted" as const, green: true }, cleanup: { status: "succeeded" as const, diagnosticsAvailable: true },
    review: { status: "approved" as const }, repairs: [],
  };
  const manifest = renderToStaticMarkup(createElement(FinalVerificationManifest, { verification: { current: generation, history: [] } }));
  assert.ok(manifest.includes("1 of 3 final-verification checks passed."), manifest);
  assert.ok(manifest.includes("Not verified (3):"));
  assert.ok(manifest.includes("Known defect") && manifest.includes("issue final-verification:lint used 3/3 repair cycles"));
  assert.ok(manifest.includes("Not run: cargo is not installed on this machine"));
  assert.ok(manifest.includes("Skipped: A static export has no server."));
  assert.equal(manifest.includes(">Failed<"), false, "neither a not-run check nor a known defect reads as failed");

  // A run started before VF3 renders its four categories the same way.
  const v1 = renderToStaticMarkup(createElement(FinalVerificationManifest, { verification: { current: {
    ...generation, checks: undefined,
    categories: [
      { category: "build" as const, applicability: "required" as const, status: "passed" as const, evidenceIds: ["ev"], issues: [] },
      { category: "tests" as const, applicability: "required" as const, status: "failed" as const, evidenceIds: [], issues: [], notRun: { reason: "tool_missing" as const, tool: "pytest", detail: "" } },
      { category: "runtime_smoke" as const, applicability: "not_applicable" as const, rationale: "A library.", status: "not_applicable" as const, evidenceIds: [], issues: [] },
      { category: "browser" as const, applicability: "not_applicable" as const, rationale: "No UI.", status: "not_applicable" as const, evidenceIds: [], issues: [] },
    ],
  }, history: [] } }));
  assert.ok(v1.includes("1 of 2 final-verification checks passed."), v1);
  assert.ok(v1.includes("Not run: pytest is not installed"));
  assert.ok(v1.includes("Not applicable: A library."));

  const clean = renderToStaticMarkup(createElement(VerificationSummary, { summary: { total: 2, passed: 2, notVerified: [] } }));
  assert.ok(clean.includes("2 of 2 final-verification checks passed.") && clean.includes("Nothing was left unverified."));
  console.log("PASS build UI overhaul: Run details verification summary (VF8)");
}
