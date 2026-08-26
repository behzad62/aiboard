import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import test from "node:test";

import { createArchitectTools } from "../src/architect-tools.js";
import type { FinalVerificationBrowserPolicy } from "../src/final-verification-browser-policy.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { IntegrationManager } from "../src/integration-manager.js";
import {
  assertFinalVerificationExecutionProfile,
  cloneFinalVerificationExecutionProfile,
  finalVerificationProfileDigest,
  FinalVerificationProfileAuthority,
} from "../src/final-verification-profile.js";
import { FinalVerificationPortAuthority } from "../src/final-verification-port-authority.js";
import { rebuildSchedulerProjection, type SchedulerStore } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("runner-owned exact-revision signals reject an Architect all-not-applicable plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-profile-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    packageManager: "npm@11.0.0",
    scripts: {
      build: "node build.mjs",
      test: "node --test",
      preview: "node server.mjs",
    },
    devDependencies: { vite: "latest" },
  }, null, 2));
  writeFileSync(join(project, "package-lock.json"), JSON.stringify({
    name: "profile-fixture",
    lockfileVersion: 3,
    packages: {},
  }));
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
    assert.equal(profile.provisioning?.manager, "npm");
    assert.equal(profile.provisioning?.lockfile, "package-lock.json");
    assert.deepEqual(profile.provisioning?.command.args.slice(-3), ["ci", "--no-audit", "--no-fund"]);
    assert.ok(profile.portLease);
    assert.equal(profile.runtimeSmoke?.endpoint, `http://127.0.0.1:${profile.portLease.port}/`);
    assert.equal(profile.browser?.url, profile.runtimeSmoke?.endpoint);

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

test("browser policy shape is rejected before profile clone can normalize malformed allowlists", () => {
  const revision = "b".repeat(40);
  const valid = browserProfile(revision, {
    consoleErrors: "fail",
    pageErrors: "allow",
    failedNetworkEvents: "fail",
    allowedConsoleErrorPatterns: ["expected console noise"],
    allowedPageErrorPatterns: [],
    allowedNetworkFailurePatterns: ["expected endpoint"],
  });
  assert.doesNotThrow(() => assertFinalVerificationExecutionProfile(valid, revision));
  const clone = cloneFinalVerificationExecutionProfile(valid);
  assert.deepEqual(clone.browser?.policy, valid.browser?.policy);
  assert.notEqual(clone.browser?.policy.allowedConsoleErrorPatterns, valid.browser?.policy.allowedConsoleErrorPatterns);

  for (const policy of [
    { allowedConsoleErrorPatterns: "e" },
    { allowedConsoleErrorPatterns: { 0: "e" } },
    { allowedConsoleErrorPatterns: ["ok", 42] },
    { allowedConsoleErrorPatterns: Array.from({ length: 33 }, () => "bounded") },
    { allowedConsoleErrorPatterns: [""] },
    { allowedConsoleErrorPatterns: ["x".repeat(257)] },
    { consoleErrors: "ignore" },
    { allowedUnexpectedErrors: ["unknown"] },
  ]) {
    const malformed = browserProfile(revision, policy as never);
    assert.throws(
      () => assertFinalVerificationExecutionProfile(malformed, revision),
      /browser policy|allowlist|browser profile/i,
    );
    assert.throws(
      () => cloneFinalVerificationExecutionProfile(malformed),
      /browser policy|allowlist|browser profile/i,
    );
  }
});

test("runner-owned profile authority rejects malformed browser policy at append and replay", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-policy-authority-"));
  const state = join(root, "state");
  const revision = "b".repeat(40);
  mkdirSync(state, { recursive: true });

  for (const mode of ["append", "replay"] as const) {
    const runId = `profile-policy-${mode}`;
    const valid = browserProfile(revision, { allowedConsoleErrorPatterns: ["e"] });
    writeProfileArchive(state, runId, valid);
    const authority = new FinalVerificationProfileAuthority({ stateDirectory: state, runId });
    const database = join(root, `${mode}.sqlite`);
    const store = new SqliteSchedulerStore(database, {
      validateExecutionProfile: (input) => authority.validate(input.profile, input.targetRevision),
    });
    try {
      seedPlanningState(store, runId, revision);
      if (mode === "append") {
        const malformed = browserProfile(revision, { allowedConsoleErrorPatterns: "e" } as never);
        assert.throws(
          () => store.append(generationEvent(runId, revision, malformed)),
          /browser policy|allowlist/i,
        );
      } else {
        store.append(generationEvent(runId, revision, valid));
        const raw = new DatabaseSync(database);
        const row = raw.prepare(
          "SELECT payload_json FROM scheduler_events WHERE event_type = 'final_verification.generation_created'",
        ).get() as { payload_json: string };
        const payload = JSON.parse(row.payload_json) as {
          executionProfile: { browser: { policy: Record<string, unknown> } };
        };
        payload.executionProfile.browser.policy.allowedConsoleErrorPatterns = "e";
        raw.prepare(
          "UPDATE scheduler_events SET payload_json = ? WHERE event_type = 'final_verification.generation_created'",
        ).run(JSON.stringify(payload));
        raw.close();
        assert.throws(() => store.readRun(runId), /browser policy|allowlist/i);
      }
    } finally {
      store.close();
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test("exact-revision package-manager inspection binds npm, pnpm, and yarn provisioning argv", async () => {
  for (const fixtureCase of [
    { manager: "npm@11.0.0", lockfile: "package-lock.json", suffix: ["ci", "--no-audit", "--no-fund"] },
    { manager: "pnpm@10.0.0", lockfile: "pnpm-lock.yaml", suffix: ["install", "--frozen-lockfile"] },
    { manager: "yarn@4.0.0", lockfile: "yarn.lock", suffix: ["install", "--immutable"] },
  ] as const) {
    const fixture = await createManagerFixture(fixtureCase.manager, [fixtureCase.lockfile]);
    try {
      const profile = await new FinalVerificationProfileAuthority({
        stateDirectory: fixture.state,
        runId: fixture.runId,
      }).inspectAndPersist({
        repositoryRoot: fixture.integration.path,
        targetRevision: fixture.integration.revision,
      });
      assert.equal(profile.provisioning?.manager, fixtureCase.manager.split("@")[0]);
      assert.equal(profile.provisioning?.lockfile, fixtureCase.lockfile);
      assert.deepEqual(profile.provisioning?.command.args.slice(-fixtureCase.suffix.length), fixtureCase.suffix);
      assert.deepEqual(profile.commands.build?.[0]?.args.slice(-2), ["run", "build"]);
    } finally {
      await fixture.close();
    }
  }
});

test("package-manager inspection fails closed on declaration/lock conflict", async () => {
  const fixture = await createManagerFixture("pnpm@10.0.0", ["package-lock.json"]);
  try {
    await assert.rejects(
      () => new FinalVerificationProfileAuthority({
        stateDirectory: fixture.state,
        runId: fixture.runId,
      }).inspectAndPersist({
        repositoryRoot: fixture.integration.path,
        targetRevision: fixture.integration.revision,
      }),
      /packageManager.*lockfile disagree|refuses to guess/i,
    );
  } finally {
    await fixture.close();
  }
});

test("lockfile-only workspaces are provisioned and unlocked dependencies fail closed", async () => {
  const lockOnly = await createManagerFixture("npm@11.0.0", ["package-lock.json"], false);
  try {
    const profile = await new FinalVerificationProfileAuthority({
      stateDirectory: lockOnly.state,
      runId: lockOnly.runId,
    }).inspectAndPersist({
      repositoryRoot: lockOnly.integration.path,
      targetRevision: lockOnly.integration.revision,
    });
    assert.equal(profile.provisioning?.manager, "npm");
  } finally {
    await lockOnly.close();
  }

  const unlocked = await createManagerFixture("npm@11.0.0", []);
  try {
    await assert.rejects(
      () => new FinalVerificationProfileAuthority({
        stateDirectory: unlocked.state,
        runId: unlocked.runId,
      }).inspectAndPersist({
        repositoryRoot: unlocked.integration.path,
        targetRevision: unlocked.integration.revision,
      }),
      /requires one matching lockfile/i,
    );
  } finally {
    await unlocked.close();
  }
});

test("runner-owned application ports isolate concurrent profiles and release cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-ports-"));
  const authority = new FinalVerificationPortAuthority(root);
  const revision = "d".repeat(40);
  try {
    const [first, second] = await Promise.all([
      authority.reserve("port-run-a", revision),
      authority.reserve("port-run-b", revision),
    ]);
    assert.notEqual(first.port, second.port);
    await authority.validate(first, "port-run-a", revision);
    await authority.validate(second, "port-run-b", revision);
    await authority.releaseRun("port-run-a");
    await assertPortBindable(first.port);
    await assert.rejects(
      () => authority.validate(first, "port-run-a", revision),
      /lease is missing|invalid/i,
    );
    await authority.validate(second, "port-run-b", revision);
  } finally {
    await authority.releaseRun("port-run-a").catch(() => undefined);
    await authority.releaseRun("port-run-b").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("port leases survive restart and rotate across integration revisions without stale conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-port-revision-"));
  const firstAuthority = new FinalVerificationPortAuthority(root);
  const oldRevision = "e".repeat(40);
  const newRevision = "f".repeat(40);
  try {
    const oldLease = await firstAuthority.reserve("repair-run", oldRevision);
    const newLease = await firstAuthority.reserve("repair-run", newRevision);
    assert.notEqual(oldLease.port, newLease.port);

    const restarted = new FinalVerificationPortAuthority(root);
    await restarted.validate(oldLease, "repair-run", oldRevision);
    await restarted.validate(newLease, "repair-run", newRevision);
    restarted.validateDurable(oldLease, "repair-run", oldRevision);
    restarted.validateDurable(newLease, "repair-run", newRevision);

    await restarted.release(oldLease, "repair-run", oldRevision);
    await assertPortBindable(oldLease.port);
    await assert.rejects(
      () => restarted.validate(oldLease, "repair-run", oldRevision),
      /lease is missing|invalid/i,
    );
    await restarted.validate(newLease, "repair-run", newRevision);
    restarted.validateDurable(oldLease, "repair-run", oldRevision);
    await restarted.release(newLease, "repair-run", newRevision);
  } finally {
    await firstAuthority.releaseRun("repair-run").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed profile persistence releases only its newly created active port lease", async () => {
  const fixture = await createServerManagerFixture("profile-persist-failure");
  const ports = new FinalVerificationPortAuthority(fixture.state);
  try {
    writeFileSync(join(fixture.state, "builds"), "blocks profile archive directory\n");
    await assert.rejects(
      () => new FinalVerificationProfileAuthority({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        portAuthority: ports,
      }).inspectAndPersist({
        repositoryRoot: fixture.integration.path,
        targetRevision: fixture.integration.revision,
      }),
      /ENOTDIR|directory|archive/i,
    );
    assert.deepEqual(
      readdirSync(join(fixture.state, "final-verification-ports", "active")),
      [],
    );
  } finally {
    await ports.releaseRun(fixture.runId).catch(() => undefined);
    await fixture.close();
  }
});

test("failed profile replay preserves a pre-existing active port lease", async () => {
  const fixture = await createServerManagerFixture("profile-replay-failure");
  const ports = new FinalVerificationPortAuthority(fixture.state);
  try {
    const existing = await ports.reserve(fixture.runId, fixture.integration.revision);
    writeFileSync(join(fixture.state, "builds"), "blocks profile archive directory\n");
    await assert.rejects(
      () => new FinalVerificationProfileAuthority({
        stateDirectory: fixture.state,
        runId: fixture.runId,
        portAuthority: ports,
      }).inspectAndPersist({
        repositoryRoot: fixture.integration.path,
        targetRevision: fixture.integration.revision,
      }),
      /ENOTDIR|directory|archive/i,
    );
    await ports.validate(existing, fixture.runId, fixture.integration.revision);
  } finally {
    await ports.releaseRun(fixture.runId).catch(() => undefined);
    await fixture.close();
  }
});

test("rejected Architect planning releases its inspected port before a later valid plan", async () => {
  const fixture = await createServerManagerFixture("rejected-plan-release");
  const ports = new FinalVerificationPortAuthority(fixture.state);
  const authority = new FinalVerificationProfileAuthority({
    stateDirectory: fixture.state,
    runId: fixture.runId,
    portAuthority: ports,
  });
  const store = new SqliteSchedulerStore(join(fixture.root, "scheduler.sqlite"), {
    validateExecutionProfile: (input) => authority.validate(input.profile, input.targetRevision),
  });
  try {
    seedPlanningState(store, fixture.runId, fixture.integration.revision);
    const tools = new ToolRegistry();
    for (const tool of createArchitectTools({
      store,
      finalVerificationPlanAvailable: true,
      finalVerificationProfileFor: async (revision) => await authority.inspectAndPersist({
        repositoryRoot: fixture.integration.path,
        targetRevision: revision,
      }),
      discardFinalVerificationProfile: async (profile) => {
        if (profile.portLease) await ports.release(profile.portLease, fixture.runId, profile.targetRevision);
      },
    })) tools.register(tool);
    const context = {
      runId: fixture.runId,
      sessionId: "architect:rejected-plan",
      actor: { role: "architect" as const, id: "architect" },
    };
    const rejected = await tools.invoke({
      type: "tool_call",
      callId: "rejected-plan",
      name: "plan_final_verification",
      arguments: { plan: allNotApplicablePlan() },
    }, context);
    assert.equal(rejected.isError, true);
    assert.deepEqual(readdirSync(join(fixture.state, "final-verification-ports", "active")), []);

    const accepted = await tools.invoke({
      type: "tool_call",
      callId: "accepted-plan",
      name: "plan_final_verification",
      arguments: { plan: allRequiredPlan() },
    }, context);
    assert.equal(accepted.isError, false, accepted.error?.message ?? "valid final-verification plan failed");
    const current = rebuildSchedulerProjection(store.readRun(fixture.runId)).finalVerification?.current;
    assert.ok(current?.executionProfile.portLease);
    await ports.validate(current.executionProfile.portLease, fixture.runId, fixture.integration.revision);
  } finally {
    store.close();
    await ports.releaseRun(fixture.runId).catch(() => undefined);
    await fixture.close();
  }
});

test("mechanically rejected generation append releases the inspected port lease", async () => {
  const fixture = await createServerManagerFixture("append-rejection-release");
  const ports = new FinalVerificationPortAuthority(fixture.state);
  const authority = new FinalVerificationProfileAuthority({ stateDirectory: fixture.state, runId: fixture.runId, portAuthority: ports });
  const durableStore = new SqliteSchedulerStore(join(fixture.root, "scheduler.sqlite"), {
    validateExecutionProfile: (input) => authority.validate(input.profile, input.targetRevision),
  });
  try {
    seedPlanningState(durableStore, fixture.runId, fixture.integration.revision);
    const rejectingStore: SchedulerStore = {
      append: (event) => {
        if (event.type === "final_verification.generation_created") {
          throw new Error("mechanical transition rejected");
        }
        return durableStore.append(event);
      },
      readRun: (runId, afterSequence) => durableStore.readRun(runId, afterSequence),
      close: () => undefined,
    };
    const tools = new ToolRegistry();
    for (const tool of createArchitectTools({
      store: rejectingStore,
      finalVerificationPlanAvailable: true,
      finalVerificationProfileFor: async (revision) => await authority.inspectAndPersist({
        repositoryRoot: fixture.integration.path,
        targetRevision: revision,
      }),
      discardFinalVerificationProfile: async (profile) => {
        if (profile.portLease) await ports.release(profile.portLease, fixture.runId, profile.targetRevision);
      },
    })) tools.register(tool);
    const result = await tools.invoke({
      type: "tool_call",
      callId: "mechanically-rejected-plan",
      name: "plan_final_verification",
      arguments: { plan: allRequiredPlan() },
    }, {
      runId: fixture.runId,
      sessionId: "architect:mechanical-rejection",
      actor: { role: "architect", id: "architect" },
    });
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /mechanical transition rejected/i);
    assert.deepEqual(readdirSync(join(fixture.state, "final-verification-ports", "active")), []);
  } finally {
    durableStore.close();
    await ports.releaseRun(fixture.runId).catch(() => undefined);
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

function browserProfile(targetRevision: string, policy: FinalVerificationBrowserPolicy) {
  return {
    version: 1 as const,
    targetRevision,
    inspectedPaths: ["package.json"],
    detectedSignals: [{ category: "browser" as const, source: "fixture", detail: "browser" }],
    commands: {},
    browser: {
      label: "browser",
      url: "http://127.0.0.1:4173/",
      policy,
    },
  };
}

function writeProfileArchive(
  stateDirectory: string,
  runId: string,
  profile: ReturnType<typeof browserProfile>,
): void {
  const digest = finalVerificationProfileDigest(runId, profile);
  const runSegment = createHash("sha256").update(runId).digest("hex").slice(0, 32);
  const directory = join(
    stateDirectory,
    "builds",
    runSegment,
    "audit",
    "final-verification-profiles",
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${digest}.json`), `${JSON.stringify({
    version: 1,
    kind: "final-verification-execution-profile",
    runId,
    targetRevision: profile.targetRevision,
    digest,
    profile,
  }, null, 2)}\n`);
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

async function createManagerFixture(
  packageManager: string,
  lockfiles: readonly string[],
  includeDependencies = true,
) {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-manager-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const runId = `manager-${packageManager.replaceAll(/[^a-z0-9]/gi, "-")}-${lockfiles.length}`;
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: "manager-fixture",
    packageManager,
    scripts: { build: "node build.mjs" },
    ...(includeDependencies ? { dependencies: { "local-package": "file:./local-package" } } : {}),
  }, null, 2));
  writeFileSync(join(project, "build.mjs"), "console.log('build')\n");
  mkdirSync(join(project, "local-package"), { recursive: true });
  writeFileSync(join(project, "local-package", "package.json"), JSON.stringify({ name: "local-package", version: "1.0.0" }));
  for (const lockfile of lockfiles) writeFileSync(join(project, lockfile), `${lockfile}\n`);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({
    repositoryRoot: project,
    stateDirectory: state,
    runId,
    baselineRevision: baseline.revision,
  });
  await integration.initialize();
  return {
    root,
    state,
    runId,
    integration,
    close: async () => {
      await integration.cleanup().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function createServerManagerFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), "aiboard-verification-server-manager-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const runId = `server-manager-${name}`;
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({
    name: "server-manager-fixture",
    packageManager: "npm@11.0.0",
    scripts: { preview: "node server.mjs" },
    devDependencies: { vite: "file:./local-vite" },
  }, null, 2));
  writeFileSync(join(project, "package-lock.json"), JSON.stringify({
    name: "server-manager-fixture",
    lockfileVersion: 3,
    packages: {},
  }));
  mkdirSync(join(project, "local-vite"), { recursive: true });
  writeFileSync(join(project, "local-vite", "package.json"), JSON.stringify({ name: "vite", version: "1.0.0" }));
  writeFileSync(join(project, "server.mjs"), "setInterval(() => {}, 1000)\n");
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
  await integration.initialize();
  return {
    root,
    state,
    runId,
    integration,
    close: async () => {
      await integration.cleanup().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function assertPortBindable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolveListen);
  });
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}
