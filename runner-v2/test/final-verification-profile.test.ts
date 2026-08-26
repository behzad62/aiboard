import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArchitectTools } from "../src/architect-tools.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { IntegrationManager } from "../src/integration-manager.js";
import {
  inspectFinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("runner-owned exact-revision signals reject an Architect all-not-applicable plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-profile-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    scripts: {
      build: "node build.mjs",
      test: "node --test",
      preview: "node server.mjs",
    },
    devDependencies: { vite: "latest" },
  }, null, 2));
  writeFileSync(join(project, "index.html"), "<main>fixture</main>\n");
  const runId = "profile-run";
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    await integration.initialize();
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: integration.path,
      targetRevision: integration.revision,
    });
    assert.deepEqual(profile.detectedSignals.map((signal) => signal.category), [
      "build", "tests", "runtime_smoke", "browser",
    ]);
    assert.equal(profile.commands.build?.[0]?.executable, process.execPath);
    assert.deepEqual(profile.commands.build?.[0]?.args.slice(-2), ["run", "build"]);
    assert.deepEqual(profile.commands.tests?.[0]?.args.slice(-2), ["run", "test"]);
    assert.equal(profile.runtimeSmoke?.endpoint, "http://127.0.0.1:4173/");
    assert.equal(profile.browser?.url, "http://127.0.0.1:4173/");

    const rawStore = new SqliteSchedulerStore(join(root, "raw-scheduler.sqlite"));
    try {
      seedPlanningState(rawStore, `${runId}-raw`, integration.revision);
      assert.throws(() => rawStore.append({
        runId: `${runId}-raw`,
        type: "final_verification.generation_created",
        occurredAt: "2026-08-26T00:00:03.000Z",
        actor: { role: "runner", id: "forged-runner" },
        idempotencyKey: "forged-all-na",
        payload: {
          taskId: "verification-forged",
          generationId: "generation-forged",
          targetRevision: integration.revision,
          planVersion: 1,
          plan: allNotApplicablePlan(),
          executionProfile: profile,
        },
      }), /detected signal|must remain required/i);
    } finally {
      rawStore.close();
    }

    seedPlanningState(store, runId, integration.revision);
    const tools = new ToolRegistry();
    for (const tool of createArchitectTools({
      store,
      finalVerificationPlanAvailable: true,
      finalVerificationProfileFor: async () => profile,
    })) tools.register(tool);
    const result = await tools.invoke({
      type: "tool_call",
      callId: "false-all-na",
      name: "plan_final_verification",
      arguments: { plan: allNotApplicablePlan() },
    }, {
      runId,
      sessionId: "architect:profile",
      actor: { role: "architect", id: "architect-profile" },
    });
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /detected signal|must remain required/i);
    assert.equal(rebuildSchedulerProjection(store.readRun(runId)).finalVerification?.current, undefined);

    const accepted = await tools.invoke({
      type: "tool_call",
      callId: "required-plan",
      name: "plan_final_verification",
      arguments: {
        plan: {
          checks: ["build", "tests", "runtime_smoke", "browser"]
            .map((category) => ({ category, status: "required" })),
        },
      },
    }, {
      runId,
      sessionId: "architect:profile",
      actor: { role: "architect", id: "architect-profile" },
    });
    assert.equal(accepted.isError, false, accepted.error?.message ?? "required plan failed");
    assert.deepEqual(
      rebuildSchedulerProjection(store.readRun(runId)).finalVerification?.current?.executionProfile,
      profile,
    );
  } finally {
    store.close();
    await integration.cleanup().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

function seedPlanningState(store: SqliteSchedulerStore, runId: string, revision: string): void {
  store.append({ runId, type: "run.initialized", occurredAt: "2026-08-26T00:00:00.000Z", actor: { role: "runner", id: "runner" }, idempotencyKey: "run", payload: {} });
  store.append({ runId, type: "plan.created", occurredAt: "2026-08-26T00:00:01.000Z", actor: { role: "architect", id: "architect" }, idempotencyKey: "plan", payload: { revision: 1, tasks: [] } });
  store.append({ runId, type: "integration.revision_advanced", occurredAt: "2026-08-26T00:00:02.000Z", actor: { role: "runner", id: "integration" }, idempotencyKey: "revision", payload: { integrationRevision: revision } });
}

function allNotApplicablePlan() {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category,
      status: "not_applicable",
      rationale: `Architect claims ${category} is absent.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `Architect claims ${category} is absent.`,
      },
    })),
  };
}
