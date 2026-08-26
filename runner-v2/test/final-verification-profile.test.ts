import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createArchitectTools } from "../src/architect-tools.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { IntegrationManager } from "../src/integration-manager.js";
import {
  FinalVerificationProfileAuthority,
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
  const authority = new FinalVerificationProfileAuthority({ stateDirectory: state, runId });
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    validateExecutionProfile: (input) => authority.validate(input.profile, input.targetRevision),
  });
  try {
    await integration.initialize();
    const profile = await authority.inspectAndPersist({
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

    const rawRunId = `${runId}-raw`;
    const rawAuthority = new FinalVerificationProfileAuthority({ stateDirectory: state, runId: rawRunId });
    const rawProfile = await rawAuthority.inspectAndPersist({
      repositoryRoot: integration.path,
      targetRevision: integration.revision,
    });
    const rawStore = new SqliteSchedulerStore(join(root, "raw-scheduler.sqlite"), {
      validateExecutionProfile: (input) => rawAuthority.validate(input.profile, input.targetRevision),
    });
    try {
      seedPlanningState(rawStore, rawRunId, integration.revision);
      assert.throws(() => rawStore.append({
        runId: rawRunId,
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
          executionProfile: rawProfile,
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

test("SQLite generation append fails closed without runner-owned profile authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-profile-authority-"));
  const runId = "profile-authority-required";
  const revision = "a".repeat(40);
  const profile = emptyProfile(revision);
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    seedPlanningState(store, runId, revision);
    assert.throws(
      () => store.append(generationEvent(runId, revision, profile)),
      /runner-owned execution-profile authority is required/i,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing, stale, or uninspected execution profiles cannot create a generation", async () => {
  const runId = "profile-invalid";
  const fixture = await createProfileFixture("aiboard-verification-profile-invalid-", runId);
  const authority = new FinalVerificationProfileAuthority({ stateDirectory: fixture.state, runId });
  const store = new SqliteSchedulerStore(join(fixture.root, "scheduler.sqlite"), {
    validateExecutionProfile: (input) => authority.validate(input.profile, input.targetRevision),
  });
  try {
    seedPlanningState(store, runId, fixture.revision);
    const missing = generationEvent(runId, fixture.revision, undefined);
    assert.throws(() => store.append(missing), /execution profile is required/i);
    assert.throws(
      () => store.append(generationEvent(runId, fixture.revision, {
        ...emptyProfile(fixture.revision),
        inspectedPaths: ["forged.json"],
      })),
      /profile archive is missing/i,
    );
    assert.throws(
      () => store.append(generationEvent(runId, "c".repeat(40), fixture.profile)),
      /stale integration revision|profile is stale/i,
    );
  } finally {
    store.close();
    await fixture.close();
  }
});

test("durable execution profile is idempotent and rejects append and replay tampering", async () => {
  const runId = "profile-replay";
  const fixture = await createProfileFixture("aiboard-verification-profile-replay-", runId);
  const database = join(fixture.root, "scheduler.sqlite");
  const authority = new FinalVerificationProfileAuthority({ stateDirectory: fixture.state, runId });
  const profile = fixture.profile;
  const options = {
    validateExecutionProfile: (input: { targetRevision: string; profile: typeof profile }) =>
      authority.validate(input.profile, input.targetRevision),
  };
  const store = new SqliteSchedulerStore(database, options);
  try {
    seedPlanningState(store, runId, fixture.revision);
    const first = store.append(generationEvent(runId, fixture.revision, profile));
    const duplicate = store.append({
      ...generationEvent(runId, fixture.revision, profile),
      idempotencyKey: "generation-duplicate",
    });
    assert.equal(duplicate.eventId, first.eventId);

    const raw = new DatabaseSync(database);
    const row = raw.prepare(
      "SELECT payload_json FROM scheduler_events WHERE event_type = 'final_verification.generation_created'",
    ).get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.executionProfile = {
      ...(payload.executionProfile as Record<string, unknown>),
      inspectedPaths: ["package.json", "tampered.json"],
    };
    raw.prepare(
      "UPDATE scheduler_events SET payload_json = ? WHERE event_type = 'final_verification.generation_created'",
    ).run(JSON.stringify(payload));
    raw.close();
    assert.throws(() => store.readRun(runId), /profile archive is missing|conflicts/i);
  } finally {
    store.close();
    await fixture.close();
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

function allRequiredPlan() {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category,
      status: "required",
    })),
  };
}

function emptyProfile(targetRevision: string) {
  return {
    version: 1 as const,
    targetRevision,
    inspectedPaths: ["package.json"],
    detectedSignals: [],
    commands: {},
  };
}

function generationEvent(runId: string, revision: string, executionProfile: unknown) {
  return {
    runId,
    type: "final_verification.generation_created" as const,
    occurredAt: "2026-08-26T00:00:03.000Z",
    actor: { role: "runner" as const, id: "runner-profile" },
    idempotencyKey: "generation",
    payload: {
      taskId: "verification-profile",
      generationId: "generation-profile",
      targetRevision: revision,
      planVersion: 1,
      plan: allRequiredPlan(),
      executionProfile,
    },
  };
}

async function createProfileFixture(prefix: string, runId: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "profile-fixture" }));
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  const authority = new FinalVerificationProfileAuthority({ stateDirectory: state, runId });
  const profile = await authority.inspectAndPersist({
    repositoryRoot: integration.path,
    targetRevision: integration.revision,
  });
  return {
    root,
    state,
    revision: integration.revision,
    profile,
    close: async () => {
      await integration.cleanup().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
