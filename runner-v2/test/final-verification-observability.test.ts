import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadFinalVerificationDiagnostics,
  projectFinalVerificationObservability,
} from "../src/build-observability.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";

const categories = ["build", "tests", "runtime_smoke", "browser"] as const;

test("projects all four current categories from durable scheduler state without treating evidence as approval", () => {
  const projection = fixtureProjection();
  const view = projectFinalVerificationObservability(projection);
  assert.equal(view.canonicalRevision, "revision-current");
  assert.equal(view.current?.revisionStatus, "current");
  assert.deepEqual(view.current?.categories.map((item) => [item.category, item.status]), [
    ["build", "passed"], ["tests", "passed"], ["runtime_smoke", "not_applicable"], ["browser", "pending"],
  ]);
  assert.equal(view.current?.submission.status, "pending");
  assert.equal(view.current?.review.status, "pending");
  assert.deepEqual(view.current?.categories[0]?.evidenceIds, ["evidence-build"]);
});

test("projects mechanical failure, cleanup, repairs, and bounded stale history separately", () => {
  const projection = fixtureProjection();
  const current = projection.finalVerification!.current!;
  current.completedChecks![3] = { ...current.completedChecks![0], category: "browser", green: false, evidenceIds: ["evidence-browser"], issues: ["console error"] };
  current.failure = {
    failureId: "failure-1", generationId: "generation-1", taskId: "verify-1", targetRevision: "revision-current",
    attempt: 1, failedCategories: ["browser"], issueIds: ["issue-1"], factIds: ["fact-1"], evidenceIds: ["evidence-browser"], reportedAt: "2026-08-26T00:00:00.000Z",
  };
  current.cleanup = { generationId: "generation-1", taskId: "verify-1", targetRevision: "revision-current", attempt: 1, status: "succeeded", startedAt: "2026-08-26T00:00:01.000Z", finishedAt: "2026-08-26T00:00:02.000Z", diagnosticsPath: "C:/private/diagnostics.json" };
  current.repairTaskIds = ["repair-browser"];
  projection.tasks["repair-browser"] = {
    id: "repair-browser", kind: "verification_repair", objective: "Repair browser", dependencies: [],
    status: "running", requiredCapabilities: [], acceptanceCriteria: [{ id: "repair", text: "Fix browser" }],
    acceptanceCriteriaVersion: 1, attempt: 1,
    verificationRepair: {
      sourceGenerationId: "generation-1", finalVerificationTaskId: "verify-1", targetRevision: "revision-current",
      categories: ["browser"], evidenceIds: ["evidence-browser"],
      source: { type: "mechanical_failure", failureId: "failure-1", issueIds: ["issue-1"], factIds: ["fact-1"] },
    },
  };
  projection.finalVerification!.history = Array.from({ length: 12 }, (_, index) => ({ ...current, generationId: `old-${index}`, state: "invalidated", invalidatedByRevision: "revision-current" }));
  const view = projectFinalVerificationObservability(projection);
  assert.equal(view.current?.mechanicalFailure?.failedCategories[0], "browser");
  assert.equal(view.current?.cleanup.diagnosticsAvailable, true);
  assert.equal(view.current?.cleanup.diagnosticsPath, undefined);
  assert.deepEqual(view.current?.repairs, [{ taskId: "repair-browser", status: "running" }]);
  assert.equal(view.history.length, 8);
});

test("loads only bounded redacted diagnostics from the exact Runner-owned run directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-observability-"));
  try {
    const runRoot = join(root, "builds", "run-segment", "audit", "final-verification-diagnostics");
    await mkdir(runRoot, { recursive: true });
    const path = join(runRoot, "generation.json");
    await writeFile(path, JSON.stringify({
      version: 1,
      kind: "final-verification-diagnostics",
      runId: "run-1",
      generationId: "generation-1",
      taskId: "verify-1",
      targetRevision: "revision-current",
      changedPaths: ["src/app.ts"],
      checks: [{
        authorization: "object-secret",
        args: ["--token", "argv-secret"],
        endpoint: "https://user:url-secret@example.test/?api_key=query-secret",
      }],
      evidenceReferences: ["Authorization: Bearer evidence-secret"],
      logs: [
        "API_KEY whitespace-secret",
        "Bearer standalone-secret",
        '{"access_token":"json-observability-secret","clientSecret":"json-client-secret"}',
        'diagnostic "access_token":["json-array-observability-secret"] tail',
        `${"{".repeat(65)} diagnostic "clientSecret":{"value":"json-late-observability-secret"} tail`,
      ],
    }));
    const loaded = await loadFinalVerificationDiagnostics({ stateDirectory: root, runId: "run-1", expectedRunSegment: "run-segment", diagnosticsPath: path, generationId: "generation-1", taskId: "verify-1", targetRevision: "revision-current" });
    assert.deepEqual(loaded?.changedPaths, ["src/app.ts"]);
    assert.doesNotMatch(
      JSON.stringify(loaded),
      /C:\\|runner-observability|object-secret|argv-secret|url-secret|query-secret|evidence-secret|whitespace-secret|standalone-secret|json-observability-secret|json-client-secret|json-array-observability-secret|json-late-observability-secret/,
    );
    assert.match(JSON.stringify(loaded), /\[REDACTED\]/);
    const foreign = join(root, "foreign.json");
    await writeFile(foreign, JSON.stringify({ logs: ["secret-value"] }));
    assert.equal(await loadFinalVerificationDiagnostics({ stateDirectory: root, runId: "run-1", expectedRunSegment: "run-segment", diagnosticsPath: foreign, generationId: "generation-1", taskId: "verify-1", targetRevision: "revision-current" }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function fixtureProjection(): SchedulerProjection {
  const plan = { checks: categories.map((category) => category === "runtime_smoke" ? { category, status: "not_applicable" as const, rationale: "No server", repositoryInspection: { paths: ["package.json"], summary: "No server entry point" } } : { category, status: "required" as const }) };
  return {
    runId: "run-1", status: "running", planRevision: 1, guidance: {}, reviews: {}, runtime: { providerHealth: {}, workerAssignments: {}, architect: {} }, integrationRevision: "revision-current", lastSequence: 1,
    tasks: { "verify-1": { id: "verify-1", kind: "final_verification", objective: "Verify integrated revision", dependencies: [], status: "planned", requiredCapabilities: [], acceptanceCriteria: [], acceptanceCriteriaVersion: 1, attempt: 1, generationId: "generation-1", targetRevision: "revision-current", planVersion: 1, verificationPlan: plan } },
    finalVerification: { history: [], current: { taskId: "verify-1", generationId: "generation-1", targetRevision: "revision-current", planVersion: 1, plan, state: "current", completedChecks: [
      { ...plan.checks[0], green: true, evidenceIds: ["evidence-build"], facts: [{ kind: "command", label: "build" }], issues: [], attempt: 1, workspacePath: "C:/private", startedAt: "x", finishedAt: "y" },
      { ...plan.checks[1], green: true, evidenceIds: ["evidence-tests"], facts: [{ kind: "command", label: "tests" }], issues: [], attempt: 1, workspacePath: "C:/private", startedAt: "x", finishedAt: "y" },
      { ...plan.checks[2], green: true, evidenceIds: [], facts: [], issues: [], attempt: 1, workspacePath: "C:/private", startedAt: "x", finishedAt: "y" },
    ] } },
  } as unknown as SchedulerProjection;
}
