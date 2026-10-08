import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import {
  NativeBuildFactory,
  snapshotNativeBuildAmbientEnvironment,
} from "../src/native-build-factory.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { captureGitBaseline } from "./support/git-fixture.js";
import {
  CLOCK,
  provider,
  safeSegment,
  seedEvent,
  UnusedModel,
} from "./support/handoff-snapshot-harness.js";

/**
 * T8 G2 factory policy initialization regressions.
 *
 * The factory must initialize a fresh legacy run legitimately before any
 * consumer reads the projection, activate lane-B guards only during fresh
 * explicit-policy construction, and never restamp a recovered log: pending
 * user guidance and open Architect questions correctly deny mid-log
 * advancement, so factory creation must append nothing under those gates.
 */

const POLICY_OBJECTIVE = "Prove factory policy recovery leaves history untouched.";

const SIX_NEW_POLICY_GUARDS = {
  testIntegrityPolicyVersion: 1,
  submissionScopePolicyVersion: 1,
  reviewIntegrityPolicyVersion: 1,
  encodingSafetyPolicyVersion: 1,
  reviewEvidencePolicyVersion: 1,
  validationScopePolicyVersion: 1,
} as const;

function newPolicyPrefix(runId: string): NewSchedulerEvent[] {
  return [
    seedEvent(runId, "project_docs.policy_configured", "project-docs-policy", "runner", "build-runtime", { version: 2 }),
    seedEvent(runId, "run.initialized", "run-initialized", "runner", "build-runtime", {
      ...SIX_NEW_POLICY_GUARDS,
      objective: POLICY_OBJECTIVE,
    }),
    seedEvent(runId, "planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
  ];
}

function preconfiguredPolicies(runId: string): NewSchedulerEvent[] {
  return [
    seedEvent(runId, "run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }),
    // Pre-configured so factory creation appends nothing under the gates.
    seedEvent(runId, "repair.policy_configured", "repair-policy", "runner", "build-runtime", {
      repairPlanLimit: 1,
      explicit: true,
    }),
    seedEvent(runId, "plan_critique.policy_configured", "critique-policy", "runner", "build-runtime", {
      mode: "off",
    }),
  ];
}

function pendingGuidanceSeed(runId: string): NewSchedulerEvent[] {
  return [
    ...newPolicyPrefix(runId),
    ...preconfiguredPolicies(runId),
    seedEvent(runId, "user.guidance_submitted", "guidance:gate", "user", "local-user", {
      guidanceId: "guidance-gate",
      text: "Hold the value module while the owner decides.",
      version: 1,
      interruptionProtocolVersion: 1,
    }),
    seedEvent(runId, "run.paused", "pause:user", "user", "local-user", { reason: "user" }),
  ];
}

function openQuestionSeed(runId: string): NewSchedulerEvent[] {
  return [
    ...newPolicyPrefix(runId),
    ...preconfiguredPolicies(runId),
    seedEvent(runId, "architect.question_requested", "question:gate", "architect", "architect", {
      questionId: "question-gate",
      question: "Should the value module keep its current export?",
      version: 1,
    }),
    seedEvent(runId, "run.paused", "pause:user", "user", "local-user", { reason: "user" }),
  ];
}

function crashBetweenEvidenceAndIntegritySeed(runId: string): NewSchedulerEvent[] {
  return [
    ...newPolicyPrefix(runId),
    seedEvent(runId, "run.evidence_policy_activated", "evidence-content-policy:v1", "runner", "build-runtime", {
      version: 1,
    }),
  ];
}

interface FactorySetup {
  baselineRevision: string;
  eventsBeforeCreate: SchedulerEvent[];
  factory: NativeBuildFactory;
  spec: Parameters<NativeBuildFactory["create"]>[0];
  readEvents: () => SchedulerEvent[];
  close: (built?: Awaited<ReturnType<NativeBuildFactory["create"]>>) => Promise<void>;
}

async function openFactorySetup(
  label: string,
  runId: string,
  seed: NewSchedulerEvent[] | null,
  planningPolicy: boolean,
): Promise<FactorySetup> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-t8g2-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "shared.txt"), "baseline\n");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: `t8g2-${label}-fixture`, version: "1.0.0", type: "module" }, null, 2),
  );
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const runRoot = join(state, "builds", safeSegment(runId));
  let eventsBeforeCreate: SchedulerEvent[] = [];
  if (seed !== null) {
    mkdirSync(runRoot, { recursive: true });
    const seeder = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
    try {
      for (const input of seed) seeder.append(input);
      eventsBeforeCreate = seeder.readRun(runId);
    } finally {
      seeder.close();
    }
  }
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const factory = new NativeBuildFactory({
    projectRoot: project,
    stateDirectory: state,
    providerConfigs: {
      load: () => [provider("arch:architect", 1), provider("work:worker", 2), provider("rev:reviewer", 3)],
      save: () => undefined,
      close: () => undefined,
    },
    executionHost,
    baselineFor: () => baseline.revision,
    providerModelFactory: () => new UnusedModel(),
  });
  const spec = await factory.prepareSpec({
    version: 2,
    runId,
    projectId: "t8g2-policy-fixture",
    objective: POLICY_OBJECTIVE,
    architectRuntimeId: "arch:architect",
    workerRuntimeIds: ["work:worker"],
    verifierRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy: "plan_only",
    ...(planningPolicy ? { planningPolicy: { version: 1 as const } } : {}),
    budgetLimits: {},
    createdAt: CLOCK,
    idempotencyKey: `t8g2-${label}`,
  });
  return {
    baselineRevision: baseline.revision,
    eventsBeforeCreate,
    factory,
    spec,
    readEvents: () => {
      const reader = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
      try {
        return reader.readRun(runId);
      } finally {
        reader.close();
      }
    },
    close: async (built) => {
      if (built) {
        await built.cleanup();
        await built.close();
      }
      await factory.close();
      await executionHost.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("T8-G2: fresh legacy factory creation initializes the run and stays policy-free", async () => {
  const runId = "run-t8g2-fresh-legacy";
  const setup = await openFactorySetup("fresh-legacy", runId, null, false);
  let built: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    built = await setup.factory.create(setup.spec);
    const events = setup.readEvents();
    assert.ok(events.length >= 2, "creation persists at least the legacy prefix");
    const [docs, init] = events;
    assert.equal(docs!.sequence, 1);
    assert.equal(docs!.type, "project_docs.policy_configured");
    assert.equal(docs!.idempotencyKey, "project-docs-policy");
    assert.deepEqual(docs!.actor, { role: "runner", id: "build-runtime" });
    assert.deepEqual(docs!.payload, { version: 1 });
    assert.equal(init!.sequence, 2);
    assert.equal(init!.type, "run.initialized");
    assert.equal(init!.idempotencyKey, "run-initialized");
    assert.deepEqual(init!.actor, { role: "runner", id: "build-runtime" });
    assert.deepEqual(init!.payload, { objective: POLICY_OBJECTIVE });
    assert.equal(
      events.filter((event) => event.type === "run.evidence_policy_activated").length,
      0,
      "a fresh legacy run carries no evidence policy stamp",
    );
    assert.equal(
      events.filter((event) => event.type === "delivery.test_integrity_initialized").length,
      0,
      "a fresh legacy run carries no integrity stamp",
    );
    const projection = built.runtime.projection();
    assert.equal(projection.runId, runId);
    assert.equal(projection.projectDocsPolicyVersion, 1);
    assert.equal(projection.initialObjective, POLICY_OBJECTIVE);
    assert.equal(projection.planningPolicyVersion, undefined);
    assert.equal(projection.evidenceContentPolicyVersion, undefined);
    assert.equal(projection.testIntegrity, undefined);
  } finally {
    await setup.close(built);
  }
});

test("T8-G2: fresh new-policy factory creation activates evidence and integrity policies", async () => {
  const runId = "run-t8g2-fresh-policy";
  const setup = await openFactorySetup("fresh-policy", runId, null, true);
  let built: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    built = await setup.factory.create(setup.spec);
    const events = setup.readEvents();
    assert.deepEqual(
      events.slice(0, 5).map((event) => event.type),
      [
        "project_docs.policy_configured",
        "run.initialized",
        "planning.policy_configured",
        "run.evidence_policy_activated",
        "delivery.test_integrity_initialized",
      ],
    );
    assert.deepEqual(events.slice(0, 5).map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.slice(0, 5).map((event) => event.idempotencyKey), [
      "project-docs-policy",
      "run-initialized",
      "planning-policy",
      "evidence-content-policy:v1",
      "test-integrity-initial-revision:v1",
    ]);
    for (const event of events.slice(0, 5)) {
      assert.deepEqual(event.actor, { role: "runner", id: "build-runtime" });
    }
    assert.deepEqual(events[0]!.payload, { version: 2 });
    assert.deepEqual(events[1]!.payload, { ...SIX_NEW_POLICY_GUARDS, objective: POLICY_OBJECTIVE });
    assert.deepEqual(events[2]!.payload, { version: 1 });
    assert.deepEqual(events[3]!.payload, { version: 1 });
    assert.deepEqual(events[4]!.payload, {
      revision: setup.baselineRevision,
      architectActorId: "architect_1",
    });
    assert.equal(
      events.filter((event) => event.type === "run.evidence_policy_activated").length,
      1,
      "exactly one evidence activation",
    );
    assert.equal(
      events.filter((event) => event.type === "delivery.test_integrity_initialized").length,
      1,
      "exactly one integrity initialization",
    );
    const projection = built.runtime.projection();
    assert.equal(projection.projectDocsPolicyVersion, 2);
    assert.equal(projection.planningPolicyVersion, 1);
    assert.equal(projection.evidenceContentPolicyVersion, 1);
    assert.equal(projection.testIntegrity?.initialRevision, setup.baselineRevision);
  } finally {
    await setup.close(built);
  }
});

test("T8-G2: paused recovery with pending guidance neither fails nor mutates history", async () => {
  const runId = "run-t8g2-pending-guidance";
  const setup = await openFactorySetup("pending-guidance", runId, pendingGuidanceSeed(runId), true);
  let built: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const before = rebuildSchedulerProjection(setup.eventsBeforeCreate);
    assert.ok(
      Object.values(before.userGuidance).some((item) => item.status === "submitted"),
      "the guidance item pends before recovery",
    );
    built = await setup.factory.create(setup.spec);
    const events = setup.readEvents();
    assert.deepEqual(events, setup.eventsBeforeCreate, "factory creation appends nothing under pending guidance");
    assert.equal(
      events.filter((event) => event.type === "run.evidence_policy_activated").length,
      0,
      "recovery never restamps the evidence policy",
    );
    assert.equal(
      events.filter((event) => event.type === "delivery.test_integrity_initialized").length,
      0,
      "recovery never restamps the integrity baseline",
    );
    const projection = built.runtime.projection();
    assert.equal(projection.status, "paused");
    assert.ok(
      Object.values(projection.userGuidance).some((item) => item.status === "submitted"),
      "the guidance item still pends after recovery",
    );
    assert.equal(projection.evidenceContentPolicyVersion, undefined);
    assert.equal(projection.testIntegrity?.initialRevision, undefined);
  } finally {
    await setup.close(built);
  }
});

test("T8-G2: paused recovery with an open Architect question neither fails nor mutates history", async () => {
  const runId = "run-t8g2-open-question";
  const setup = await openFactorySetup("open-question", runId, openQuestionSeed(runId), true);
  let built: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    const before = rebuildSchedulerProjection(setup.eventsBeforeCreate);
    assert.equal(before.blockingArchitectQuestionId, "question-gate", "the question blocks before recovery");
    built = await setup.factory.create(setup.spec);
    const events = setup.readEvents();
    assert.deepEqual(events, setup.eventsBeforeCreate, "factory creation appends nothing under the open question");
    assert.equal(
      events.filter((event) => event.type === "run.evidence_policy_activated").length,
      0,
      "recovery never restamps the evidence policy",
    );
    assert.equal(
      events.filter((event) => event.type === "delivery.test_integrity_initialized").length,
      0,
      "recovery never restamps the integrity baseline",
    );
    const projection = built.runtime.projection();
    assert.equal(projection.status, "paused");
    assert.equal(projection.blockingArchitectQuestionId, "question-gate", "the question still blocks after recovery");
    assert.equal(projection.evidenceContentPolicyVersion, undefined);
    assert.equal(projection.testIntegrity?.initialRevision, undefined);
  } finally {
    await setup.close(built);
  }
});

test("T8-G2: legacy recovery against a new-policy prefix still refuses the downgrade", async () => {
  const runId = "run-t8g2-downgrade";
  const setup = await openFactorySetup("downgrade", runId, newPolicyPrefix(runId), false);
  try {
    await assert.rejects(() => setup.factory.create(setup.spec), /policy downgrade/);
    assert.deepEqual(
      setup.readEvents(),
      setup.eventsBeforeCreate,
      "the refused recovery mutates nothing",
    );
  } finally {
    await setup.close(undefined);
  }
});

test("T8-G2: crash between evidence activation and integrity init completes integrity once at seq5", async () => {
  const runId = "run-t8g2-crash-evidence-integrity";
  const setup = await openFactorySetup("crash-evidence-integrity", runId, crashBetweenEvidenceAndIntegritySeed(runId), true);
  let built: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
    assert.equal(setup.eventsBeforeCreate.length, 4, "the crash seed carries the bare prefix plus the evidence stamp");
    assert.deepEqual(
      setup.eventsBeforeCreate.map((event) => event.type),
      [
        "project_docs.policy_configured",
        "run.initialized",
        "planning.policy_configured",
        "run.evidence_policy_activated",
      ],
    );
    assert.deepEqual(
      setup.eventsBeforeCreate.map((event) => event.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      setup.eventsBeforeCreate.map((event) => event.idempotencyKey),
      ["project-docs-policy", "run-initialized", "planning-policy", "evidence-content-policy:v1"],
    );
    for (const event of setup.eventsBeforeCreate) {
      assert.deepEqual(event.actor, { role: "runner", id: "build-runtime" });
    }
    assert.deepEqual(setup.eventsBeforeCreate[0]!.payload, { version: 2 });
    assert.deepEqual(setup.eventsBeforeCreate[1]!.payload, { ...SIX_NEW_POLICY_GUARDS, objective: POLICY_OBJECTIVE });
    assert.deepEqual(setup.eventsBeforeCreate[2]!.payload, { version: 1 });
    assert.deepEqual(setup.eventsBeforeCreate[3]!.payload, { version: 1 });
    const before = rebuildSchedulerProjection(setup.eventsBeforeCreate);
    assert.equal(before.evidenceContentPolicyVersion, 1, "the evidence stamp is already durable before recovery");
    assert.ok(before.testIntegrity, "the six-flag prefix already activates the integrity policy");
    assert.equal(before.testIntegrity!.initialRevision, undefined, "the integrity baseline is still missing before recovery");

    built = await setup.factory.create(setup.spec);
    const events = setup.readEvents();
    assert.ok(events.length >= 5, "recovery persists the missing integrity baseline at seq5");
    assert.deepEqual(events.slice(0, 4), setup.eventsBeforeCreate, "the original seq1-4 prefix is preserved exact");
    assert.deepEqual(
      events.slice(0, 5).map((event) => event.type),
      [
        "project_docs.policy_configured",
        "run.initialized",
        "planning.policy_configured",
        "run.evidence_policy_activated",
        "delivery.test_integrity_initialized",
      ],
    );
    assert.deepEqual(
      events.slice(0, 5).map((event) => event.sequence),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      events.slice(0, 5).map((event) => event.idempotencyKey),
      [
        "project-docs-policy",
        "run-initialized",
        "planning-policy",
        "evidence-content-policy:v1",
        "test-integrity-initial-revision:v1",
      ],
    );
    for (const event of events.slice(0, 5)) {
      assert.deepEqual(event.actor, { role: "runner", id: "build-runtime" });
    }
    assert.deepEqual(events[0]!.payload, { version: 2 });
    assert.deepEqual(events[1]!.payload, { ...SIX_NEW_POLICY_GUARDS, objective: POLICY_OBJECTIVE });
    assert.deepEqual(events[2]!.payload, { version: 1 });
    assert.deepEqual(events[3]!.payload, { version: 1 });
    assert.deepEqual(events[4]!.payload, {
      revision: setup.baselineRevision,
      architectActorId: "architect_1",
    });
    assert.equal(
      events.filter((event) => event.type === "run.evidence_policy_activated").length,
      1,
      "recovery never duplicates the evidence stamp",
    );
    assert.equal(
      events.filter((event) => event.type === "delivery.test_integrity_initialized").length,
      1,
      "exactly one integrity initialization",
    );
    const projection = built.runtime.projection();
    assert.equal(projection.projectDocsPolicyVersion, 2);
    assert.equal(projection.planningPolicyVersion, 1);
    assert.equal(projection.evidenceContentPolicyVersion, 1);
    assert.equal(projection.testIntegrity?.initialRevision, setup.baselineRevision);

    await built.cleanup();
    await built.close();
    built = await setup.factory.create(setup.spec);
    const recreated = setup.readEvents();
    assert.deepEqual(recreated, events, "closing and recreating appends nothing");
    assert.equal(
      recreated.filter((event) => event.type === "run.evidence_policy_activated").length,
      1,
      "recreation still carries exactly one evidence stamp",
    );
    assert.equal(
      recreated.filter((event) => event.type === "delivery.test_integrity_initialized").length,
      1,
      "recreation still carries exactly one integrity baseline",
    );
    const recreatedProjection = built.runtime.projection();
    assert.equal(recreatedProjection.evidenceContentPolicyVersion, 1);
    assert.equal(recreatedProjection.testIntegrity?.initialRevision, setup.baselineRevision);
  } finally {
    await setup.close(built);
  }
});
