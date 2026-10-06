import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  ToolCallBlock,
  ToolExecutionOutput,
} from "../src/agent-contracts.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
} from "../src/build-runtime.js";
import {
  cloneBuildSpec,
  type NativeBuildSpec,
} from "../src/build-spec.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import {
  NativeBuildFactory,
  snapshotNativeBuildAmbientEnvironment,
} from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import {
  buildExecutionPlanRevision,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../src/planning-contracts.js";
import {
  NativeBuildFactory as FixtureNativeBuildFactory,
  captureGitBaseline,
  runGit,
} from "./support/git-fixture.js";
import {
  assertSupportedInitialSourceBytes,
  buildApprovedSourceManifest,
  deriveApprovedSourceIdentities,
  ensurePlanningProvisioningPrefix,
  parseApprovedSourceAuthority,
  registerApprovedSource,
  stableProvisioningRequestIdentity,
  stableProvisioningRequestsMatch,
  validateApproverName,
  validateApprovedSourceInput,
  validateProvisioningPrepareOptions,
  verifyPreparedApprovedSource,
  type ApprovedSourceInputV1,
} from "../src/native-planning-provisioner.js";
import {
  currentExplicitStartIdentity,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import {
  buildSourceManifest,
  computeArtifactDigest,
  type ApprovedSourceManifest,
} from "../src/source-manifest.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type {
  WorkerAssignment,
  WorkerOutcome,
  WorkerRuntimeDriver,
} from "../src/task-scheduler.js";

/**
 * T7a production planning provisioning (opt-in only, owner decision
 * 2026-10-03): explicit planningPolicy.version 1 plus kernel-derived
 * approved-source provisioning. Fresh requests without planningPolicy keep
 * their current default; a source without the opt-in is refused.
 */

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

const BASE_MS = Date.parse("2026-10-02T00:00:00.000Z");

function advancingClock() {
  let now = BASE_MS;
  return () => new Date((now += 1000)).toISOString();
}

function openScheduler(root: string): SqliteSchedulerStore {
  return new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
}

function baseSpec(runId: string, overrides: Partial<NativeBuildSpec> = {}): NativeBuildSpec {
  return {
    version: 2,
    runId,
    projectId: `project_${runId}`,
    objective: "Deliver the value module.",
    architectRuntimeId: "arch:architect",
    workerRuntimeIds: ["work:worker"],
    verifierRuntimeIds: ["rev:reviewer"],
    alwaysRequireIndependentVerifier: false,
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy: "finish",
    budgetLimits: {},
    createdAt: "2026-10-02T00:00:00.000Z",
    idempotencyKey: `build:${runId}`,
    ...overrides,
  };
}

function sourceBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function sourceInput(
  text: string,
  sections?: ApprovedSourceInputV1["sections"],
  extra?: Record<string, unknown>,
): ApprovedSourceInputV1 {
  return {
    version: 1,
    approval: "approved_spec",
    bytesBase64: Buffer.from(text, "utf8").toString("base64"),
    mediaType: "text/plain",
    encoding: "utf-8",
    ...(sections !== undefined ? { sections } : {}),
    ...(extra ?? {}),
  } as ApprovedSourceInputV1;
}

const T7A_TEXT = "SECTION s1: MANDATORY. The value module must export the value 2.\nSECTION s2: OPERATIONAL. Keep the change to src/value.mjs only.\n";

function t7aSections(text: string): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(text.split("\n")[0]! + "\n", "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(text, "utf8") },
  ];
}

function t7aManifest(runId: string, createdAt: string): { manifest: ApprovedSourceManifest; bytes: Uint8Array } {
  const bytes = sourceBytes(T7A_TEXT);
  const validated = validateApprovedSourceInput(sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(validated.bytes),
    approvedBy: "local-user",
    createdAt,
  });
  return { manifest, bytes };
}

function stubHandle(runId: string) {
  return {
    runtime: {
      id: runId,
      projection: () => ({ status: "running", runId }) as never,
    },
    usage: () => ({}) as never,
    observability: async () => ({}) as never,
    transcript: async () => ({}) as never,
    files: async () => ({}) as never,
    compact: () => undefined,
    projectHandoff: async () => ({}) as never,
    cleanup: () => undefined,
    close: () => undefined,
  } as never;
}

// ---------------------------------------------------------------------------
// F1: fail-closed saved-state lookup.
// ---------------------------------------------------------------------------

test("T7a F1: a corrupt saved spec propagates before any preparation effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f1-corrupt-"));
  try {
    const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
    specs.save(baseSpec("run_t7a_f1"));
    const db = new DatabaseSync(join(root, "builds.sqlite"));
    db.prepare("UPDATE build_specs SET spec_json = ? WHERE run_id = ?").run("{corrupt", "run_t7a_f1");
    db.close();
    let prepareCalls = 0;
    let runtimeCalls = 0;
    const manager = new NativeBuildManager({
      specs,
      createRuntime: async (spec) => {
        runtimeCalls += 1;
        return stubHandle(spec.runId);
      },
      prepareSpec: async (spec) => {
        prepareCalls += 1;
        return cloneBuildSpec(spec);
      },
    });
    try {
      await assert.rejects(
        manager.create(baseSpec("run_t7a_f1")),
        /corrupt|Unexpected token|JSON/i,
      );
      assert.equal(prepareCalls, 0, "corrupt state must not reach preparation");
      assert.equal(runtimeCalls, 0, "corrupt state must not construct a runtime");
    } finally {
      await manager.close().catch(() => undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F1: a missing saved spec creates, and malformed input validates before prepare", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f1-missing-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  try {
    let prepareCalls = 0;
    const manager = new NativeBuildManager({
      specs,
      createRuntime: async (spec) => stubHandle(spec.runId),
      prepareSpec: async (spec) => {
        prepareCalls += 1;
        return cloneBuildSpec(spec);
      },
    });
    try {
      await manager.create(baseSpec("run_t7a_f1_new"));
      assert.equal(prepareCalls, 1);
      await assert.rejects(
        manager.create({ ...baseSpec("run_t7a_f1_bad"), runPolicy: "nope" as never }),
        /run policy is invalid/i,
      );
      assert.equal(prepareCalls, 1, "malformed input must not reach preparation");
    } finally {
      await manager.close().catch(() => undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F1: exact retry reuses the saved authority, changed requests conflict before effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f1-retry-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  try {
    const createdAt = "2026-10-02T00:00:00.000Z";
    const { manifest } = t7aManifest("run_t7a_f1_retry", createdAt);
    const saved = specs.save({
      ...baseSpec("run_t7a_f1_retry", { createdAt }),
      planningPolicy: { version: 1 },
      approvedSource: manifest,
    });
    let prepareCalls = 0;
    let runtimeCalls = 0;
    const manager = new NativeBuildManager({
      specs,
      createRuntime: async (spec) => {
        runtimeCalls += 1;
        return stubHandle(spec.runId);
      },
      prepareSpec: async (spec) => {
        prepareCalls += 1;
        return cloneBuildSpec(spec);
      },
    });
    try {
      // Exact replay carries raw bytes again: digest/layout match reuses saved state.
      await manager.create(
        baseSpec("run_t7a_f1_retry", { createdAt, planningPolicy: { version: 1 } }),
        { approvedSourceInput: sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]), approvedBy: "local-user" },
      );
      assert.equal(prepareCalls, 0, "exact retry must reuse the saved authority without re-preparing");
      assert.equal(runtimeCalls, 1);
      // A prepared-spec replay also reuses without regenerating kernel identity.
      await manager.create({ ...cloneBuildSpec(saved) });
      assert.equal(prepareCalls, 0);
      // Changed bytes conflict before any effect.
      await assert.rejects(
        manager.create(
          baseSpec("run_t7a_f1_retry", { createdAt, planningPolicy: { version: 1 } }),
          { approvedSourceInput: sourceInput(`${T7A_TEXT}extra\n`), approvedBy: "local-user" },
        ),
        /idempotency conflict/i,
      );
      assert.equal(prepareCalls, 0, "changed requests conflict before preparation");
      // Changed objective conflicts too.
      await assert.rejects(
        manager.create(baseSpec("run_t7a_f1_retry", { createdAt, objective: "Something else.", planningPolicy: { version: 1 } })),
        /idempotency conflict/i,
      );
      assert.equal(prepareCalls, 0);
    } finally {
      await manager.close().catch(() => undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F1: legacy saved runs retry without today's defaults and refuse downgrades", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f1-legacy-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  try {
    const saved = specs.save(baseSpec("run_t7a_f1_legacy"));
    assert.equal(saved.planningPolicy, undefined);
    assert.equal(
      stableProvisioningRequestsMatch(saved, baseSpec("run_t7a_f1_legacy")),
      true,
      "an identical legacy retry matches without adding a policy default",
    );
    assert.equal(
      stableProvisioningRequestsMatch(saved, baseSpec("run_t7a_f1_legacy", { planningPolicy: { version: 1 } })),
      false,
      "a newly added policy opt-in conflicts with the saved legacy request",
    );
    assert.equal(
      stableProvisioningRequestIdentity(saved).planningPolicy,
      null,
      "legacy identity records no policy rather than inventing one",
    );
  } finally {
    specs.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F2: strict scheduler prefix matching.
// ---------------------------------------------------------------------------

function t7aSpec(runId: string, objective?: string) {
  return {
    runId,
    ...(objective !== undefined ? { objective } : {}),
    planningPolicy: { version: 1 as const },
  };
}

function prefixTypes(store: SqliteSchedulerStore, runId: string): string[] {
  return store.readRun(runId).map((event) => event.type);
}

const T7A_GENERATED_RUN_INITIALIZED_GUARDS = {
  testIntegrityPolicyVersion: 1,
  submissionScopePolicyVersion: 1,
  reviewIntegrityPolicyVersion: 1,
  encodingSafetyPolicyVersion: 1,
  reviewEvidencePolicyVersion: 1,
  validationScopePolicyVersion: 1,
} as const;

function expectedGeneratedRunInitializedPayload(objective: string) {
  return { ...T7A_GENERATED_RUN_INITIALIZED_GUARDS, objective };
}

test("T7a F2: empty, docs-only, and docs+init prefixes recover in order with exact identity", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f2-recover-"));
  const store = openScheduler(root);
  try {
    const clock = advancingClock();
    const runId = "run_t7a_f2_recover";
    assert.deepEqual(ensurePlanningProvisioningPrefix(store, t7aSpec(runId, "Deliver it."), clock), { mode: "provisioned" });
    const events = store.readRun(runId);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
    assert.deepEqual(prefixTypes(store, runId), [
      "project_docs.policy_configured",
      "run.initialized",
      "planning.policy_configured",
    ]);
    for (const event of events) {
      assert.deepEqual(event.actor, { role: "runner", id: "build-runtime" });
    }
    assert.deepEqual(events.map((event) => event.idempotencyKey), [
      "project-docs-policy",
      "run-initialized",
      "planning-policy",
    ]);
    assert.deepEqual(events[0]!.payload, { version: 2 });
    assert.deepEqual(events[1]!.payload, expectedGeneratedRunInitializedPayload("Deliver it."));
    assert.deepEqual(events[2]!.payload, { version: 1 });
    assert.deepEqual(ensurePlanningProvisioningPrefix(store, t7aSpec(runId, "Deliver it."), clock), { mode: "reused" });
    assert.equal(store.readRun(runId).length, 3, "a full matching prefix appends nothing");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F2: partial prefixes resume at the exact next sequence", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f2-partial-"));
  const store = openScheduler(root);
  try {
    const clock = advancingClock();
    const docsOnly = "run_t7a_f2_docs_only";
    store.append({
      runId: docsOnly,
      type: "project_docs.policy_configured",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "project-docs-policy",
      payload: { version: 2 },
    });
    assert.deepEqual(ensurePlanningProvisioningPrefix(store, t7aSpec(docsOnly, "O."), clock), { mode: "provisioned" });
    const resumed = store.readRun(docsOnly);
    assert.deepEqual(resumed.map((event) => event.sequence), [1, 2, 3]);
    assert.deepEqual(prefixTypes(store, docsOnly), [
      "project_docs.policy_configured",
      "run.initialized",
      "planning.policy_configured",
    ]);
    assert.deepEqual(resumed[1]!.payload, expectedGeneratedRunInitializedPayload("O."));

    const docsInit = "run_t7a_f2_docs_init";
    store.append({
      runId: docsInit,
      type: "project_docs.policy_configured",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "project-docs-policy",
      payload: { version: 2 },
    });
    store.append({
      runId: docsInit,
      type: "run.initialized",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-initialized",
      payload: { objective: "O." },
    });
    assert.deepEqual(ensurePlanningProvisioningPrefix(store, t7aSpec(docsInit, "O."), clock), { mode: "provisioned" });
    assert.deepEqual(store.readRun(docsInit).map((event) => event.sequence), [1, 2, 3]);
    assert.deepEqual(prefixTypes(store, docsInit)[2], "planning.policy_configured");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F2: mismatched policy, actor, key, objective, and foreign prefixes refuse without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f2-refuse-"));
  const store = openScheduler(root);
  try {
    const clock = advancingClock();
    const seed = (
      runId: string,
      type: "project_docs.policy_configured" | "run.initialized" | "run.policy_configured" | "planning.policy_configured",
      actor: { role: "runner"; id: string },
      key: string,
      payload: Record<string, unknown>,
    ) => {
      store.append({ runId, type, occurredAt: clock(), actor, idempotencyKey: key, payload });
    };
    const cases: Array<{ name: string; seed: (runId: string) => void }> = [
      {
        name: "legacy docs version",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 1 });
          seed(runId, "run.initialized", { role: "runner", id: "build-runtime" }, "run-initialized", { objective: "O." });
        },
      },
      {
        name: "wrong docs actor id",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "someone-else" }, "project-docs-policy", { version: 2 });
        },
      },
      {
        name: "wrong docs idempotency key",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "docs:wrong", { version: 2 });
        },
      },
      {
        name: "docs payload with extra keys",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2, extra: true });
        },
      },
      {
        name: "different objective",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2 });
          seed(runId, "run.initialized", { role: "runner", id: "build-runtime" }, "run-initialized", { objective: "Another objective." });
        },
      },
      {
        name: "missing recorded objective",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2 });
          seed(runId, "run.initialized", { role: "runner", id: "build-runtime" }, "run-initialized", {});
        },
      },
      {
        name: "unexpected recorded objective",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2 });
          seed(runId, "run.initialized", { role: "runner", id: "build-runtime" }, "run-initialized", { objective: "Surprise." });
        },
      },
      {
        name: "wrong init actor id",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2 });
          seed(runId, "run.initialized", { role: "runner", id: "runner" }, "run-initialized", { objective: "O." });
        },
      },
      {
        name: "unrelated second event",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2 });
          seed(runId, "run.policy_configured", { role: "runner", id: "build-runtime" }, "run-policy-configured", { runPolicy: "finish" });
        },
      },
      {
        name: "unrelated first event",
        seed: (runId) => {
          seed(runId, "run.policy_configured", { role: "runner", id: "build-runtime" }, "run-policy-configured", { runPolicy: "finish" });
        },
      },
      {
        name: "ambiguous partial prefix with trailing events",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2 });
          seed(runId, "run.initialized", { role: "runner", id: "build-runtime" }, "run-initialized", { objective: "O." });
          seed(runId, "run.policy_configured", { role: "runner", id: "build-runtime" }, "run-policy-configured", { runPolicy: "finish" });
        },
      },
      {
        name: "wrong planning actor id",
        seed: (runId) => {
          seed(runId, "project_docs.policy_configured", { role: "runner", id: "build-runtime" }, "project-docs-policy", { version: 2 });
          seed(runId, "run.initialized", { role: "runner", id: "build-runtime" }, "run-initialized", { objective: "O." });
          seed(runId, "planning.policy_configured", { role: "runner", id: "someone-else" }, "planning-policy", { version: 1 });
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const runId = `run_t7a_f2_case_${index}`;
      item.seed(runId);
      const before = store.readRun(runId).length;
      assert.throws(
        () => ensurePlanningProvisioningPrefix(store, t7aSpec(runId, index === 6 ? undefined : "O."), clock),
        /prefix|downgrade|objective|ambiguous/i,
        item.name,
      );
      assert.equal(store.readRun(runId).length, before, `${item.name}: refusal appends nothing`);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F2: a no-policy spec refuses a recorded planning prefix without restamping", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f2-downgrade-"));
  const store = openScheduler(root);
  try {
    const clock = advancingClock();
    const runId = "run_t7a_f2_downgrade";
    assert.deepEqual(ensurePlanningProvisioningPrefix(store, t7aSpec(runId, "O."), clock), { mode: "provisioned" });
    assert.equal(store.readRun(runId).length, 3);
    assert.throws(
      () => ensurePlanningProvisioningPrefix(store, { runId }),
      /downgrade/i,
    );
    assert.equal(store.readRun(runId).length, 3, "the historical log is preserved, never restamped");
    assert.deepEqual(prefixTypes(store, runId), [
      "project_docs.policy_configured",
      "run.initialized",
      "planning.policy_configured",
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F2: absent-policy recovery refuses every interrupted docs2 prefix without mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f2-partial-downgrade-"));
  const store = openScheduler(root);
  try {
    for (const size of [1, 2, 3]) {
      const runId = `run_t7a_partial_downgrade_${size}`;
      const original = `run_t7a_partial_original_${size}`;
      ensurePlanningProvisioningPrefix(store, t7aSpec(original, "O."), advancingClock());
      for (const event of store.readRun(original).slice(0, size)) {
        store.append({ runId, type: event.type, occurredAt: event.occurredAt,
          actor: event.actor, idempotencyKey: event.idempotencyKey, payload: event.payload });
      }
      const before = store.readRun(runId);
      assert.throws(() => ensurePlanningProvisioningPrefix(store, { runId, objective: "O." }), /downgrade/i);
      assert.deepEqual(store.readRun(runId), before, `size ${size}: rejected recovery appends nothing`);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F2: legacy specs pass through untouched on genuinely historical logs", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f2-legacy-"));
  const store = openScheduler(root);
  try {
    const clock = advancingClock();
    const runId = "run_t7a_f2_legacy";
    store.append({
      runId,
      type: "project_docs.policy_configured",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "project-docs-policy",
      payload: { version: 1 },
    });
    store.append({
      runId,
      type: "run.initialized",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-initialized",
      payload: { objective: "Legacy objective." },
    });
    assert.deepEqual(ensurePlanningProvisioningPrefix(store, { runId }), { mode: "legacy" });
    assert.equal(store.readRun(runId).length, 2, "legacy logs are never restamped");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F3: prepared-source verification.
// ---------------------------------------------------------------------------

test("T7a F3: approved-source input refuses unknown keys and shapes", () => {
  const good = sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]);
  assert.doesNotThrow(() => validateApprovedSourceInput(good));
  assert.throws(
    () => validateApprovedSourceInput({ ...good, manifestId: "manifest-forged" }),
    /unknown field: manifestId/,
  );
  assert.throws(
    () => validateApprovedSourceInput({ ...good, authority: "user:mallory" }),
    /unknown field: authority/,
  );
  assert.throws(
    () => validateApprovedSourceInput({ ...good, artifactDigest: "a".repeat(64) }),
    /unknown field: artifactDigest/,
  );
  const sections = [...t7aSections(T7A_TEXT)];
  assert.throws(
    () => validateApprovedSourceInput(sourceInput(T7A_TEXT, [{ ...sections[0]!, digest: "b".repeat(64) } as never, sections[1]!])),
    /unknown field: digest/,
  );
  assert.throws(
    () => validateApprovedSourceInput(sourceInput(T7A_TEXT, [{ ...sections[0]!, note: "x" } as never, sections[1]!])),
    /unknown field: note/,
  );
  // Intent is explicit: anything but approved_spec refuses.
  assert.throws(
    () => validateApprovedSourceInput({ ...good, approval: "acknowledged" }),
    /explicit approval 'approved_spec'/,
  );
});

test("T7a F3: unicode, BOM, and CRLF survive losslessly; split characters refuse", () => {
  const text = "\uFEFFSECTION 1: cafés export the value 2.\r\nSECTION 2: naïve emoji 🎉 stay byte-exact.\r\n";
  const total = Buffer.byteLength(text, "utf8");
  const mid = Buffer.byteLength(text.split("\n")[0]! + "\n", "utf8");
  const validated = validateApprovedSourceInput(sourceInput(text, [
    { id: "s1", startByte: 0, endByte: mid },
    { id: "s2", startByte: mid, endByte: total },
  ]));
  assert.deepEqual(Buffer.from(validated.bytes).toString("utf8"), text, "BOM/newlines/unicode unchanged");
  assert.equal(validated.bytes.length, total);
  const manifest = buildApprovedSourceManifest({
    runId: "run_t7a_f3_unicode",
    validated,
    artifactDigest: computeArtifactDigest(validated.bytes),
    approvedBy: "local-user",
    createdAt: "2026-10-02T00:00:00.000Z",
  });
  assert.equal(manifest.byteLength, total);
  // A boundary inside a multibyte character refuses.
  const charByte = Buffer.byteLength("\uFEFFSECTION 1: caf\u00e9", "utf8") - 1;
  assert.throws(
    () => validateApprovedSourceInput(sourceInput(text, [
      { id: "s1", startByte: 0, endByte: charByte },
      { id: "s2", startByte: charByte, endByte: total },
    ])),
    /character boundaries/,
  );
});

test("T7a F3: unsupported media, encoding, invalid UTF-8, and size refuse before effects", () => {
  const good = sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]);
  assert.throws(
    () => validateApprovedSourceInput({ ...good, mediaType: "application/pdf" }),
    /mediaType/,
  );
  assert.throws(
    () => validateApprovedSourceInput({ ...good, encoding: "utf-16" }),
    /encoding/,
  );
  assert.throws(
    () => validateApprovedSourceInput({
      ...good,
      bytesBase64: Buffer.from([0xff, 0xfe, 0x41]).toString("base64"),
    }),
    /valid UTF-8/,
  );
  assert.throws(() => validateApprovedSourceInput({ ...good, bytesBase64: "" }), /non-empty/);
  assert.throws(
    () => validateApprovedSourceInput({ ...good, bytesBase64: "!!!" }),
    /canonical base64/,
  );
  // Non-canonical base64 (re-encodes differently) refuses even when decodable.
  assert.throws(
    () => validateApprovedSourceInput({ ...good, bytesBase64: Buffer.from("hi").toString("base64url") }),
    /canonical base64/,
  );
  const big = "x".repeat(512 * 1024 + 1);
  assert.throws(
    () => validateApprovedSourceInput(sourceInput(big)),
    /decoded limit/,
  );
  // Gaps and reordered coverage refuse.
  const [s1, s2] = t7aSections(T7A_TEXT);
  assert.throws(
    () => validateApprovedSourceInput(sourceInput(T7A_TEXT, [{ ...s1, endByte: s1.endByte - 1 }, s2])),
    /contiguously/,
  );
});

test("T7a F3: prepared verification binds bytes, layout, identities, clock, and authority", () => {
  const runId = "run_t7a_f3_verify";
  const createdAt = "2026-10-02T00:00:00.000Z";
  const { manifest, bytes } = t7aManifest(runId, createdAt);
  assert.doesNotThrow(() => verifyPreparedApprovedSource({ runId, manifest, storedBytes: bytes, createdAt }));
  assertSupportedInitialSourceBytes(bytes, manifest);
  assert.deepEqual(deriveApprovedSourceIdentities({
    runId,
    artifactDigest: manifest.artifactDigest,
    mediaType: manifest.mediaType,
    encoding: manifest.encoding,
    sections: manifest.sections.map((section) => ({
      id: section.id,
      ...(section.title !== undefined ? { title: section.title } : {}),
      startByte: section.startByte,
      endByte: section.endByte,
    })),
  }), { sourceId: manifest.sourceId, manifestId: manifest.manifestId });
  // Drifted bytes refuse.
  const drifted = new Uint8Array(bytes);
  drifted[drifted.length - 1] = drifted[drifted.length - 1]! ^ 0xff;
  assert.throws(
    () => verifyPreparedApprovedSource({ runId, manifest, storedBytes: drifted, createdAt }),
    /UTF-8|drift|does not match/i,
  );
  // A regenerated clock refuses: the saved spec creation time governs.
  assert.throws(
    () => verifyPreparedApprovedSource({ runId, manifest, storedBytes: bytes, createdAt: "2026-10-03T00:00:00.000Z" }),
    /creation time/,
  );
  // Non-user provenance refuses instead of falling back.
  assert.throws(
    () => verifyPreparedApprovedSource({
      runId,
      manifest: { ...manifest, authority: "owner:mallory" },
      storedBytes: bytes,
      createdAt,
    }),
    /approval authority/,
  );
  assert.throws(
    () => verifyPreparedApprovedSource({
      runId,
      manifest: { ...manifest, authority: "" },
      storedBytes: bytes,
      createdAt,
    }),
    /authority/i,
  );
  // Forged kernel identities refuse.
  assert.throws(
    () => verifyPreparedApprovedSource({
      runId,
      manifest: { ...manifest, sourceId: "src-forged" },
      storedBytes: bytes,
      createdAt,
    }),
    /kernel identity/,
  );
  assert.throws(
    () => verifyPreparedApprovedSource({
      runId,
      manifest: { ...manifest, manifestId: "manifest-forged" },
      storedBytes: bytes,
      createdAt,
    }),
    /kernel identity/,
  );
  // Unsupported media/encoding on a stored manifest refuses.
  assert.throws(
    () => assertSupportedInitialSourceBytes(bytes, { ...manifest, mediaType: "application/pdf" }),
    /not supported/,
  );
  assert.throws(
    () => parseApprovedSourceAuthority("owner:mallory", manifest.manifestId),
    /approval authority/,
  );
  assert.equal(parseApprovedSourceAuthority(manifest.authority, manifest.manifestId), "local-user");
  assert.throws(() => validateApproverName("not a name"), /approver/);
  assert.throws(() => validateApproverName("user:x"), /approver/);
  assert.equal(validateApproverName("local-user"), "local-user");
});

test("T7a F3: registration binds actor and key, reuses exact repeats, refuses conflicts", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f3-register-"));
  const store = openScheduler(root);
  try {
    const clock = advancingClock();
    const runId = "run_t7a_f3_register";
    const createdAt = "2026-10-02T00:00:00.000Z";
    ensurePlanningProvisioningPrefix(store, t7aSpec(runId, "O."), clock);
    const { manifest, bytes } = t7aManifest(runId, createdAt);
    assert.deepEqual(registerApprovedSource(store, runId, manifest, "local-user"), { mode: "registered" });
    const events = store.readRun(runId);
    const registrations = events.filter((event) => event.type === "planning.source_registered");
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0]!.actor, { role: "user", id: "local-user" });
    assert.equal(registrations[0]!.idempotencyKey, `source-registered:${manifest.manifestId}`);
    assert.deepEqual(registerApprovedSource(store, runId, manifest, "local-user"), { mode: "reused" });
    assert.equal(store.readRun(runId).filter((event) => event.type === "planning.source_registered").length, 1);
    // A mismatched actor never manufactures approval.
    assert.throws(
      () => registerApprovedSource(store, runId, manifest, "mallory"),
      /does not match/,
    );
    // A conflicting manifest is refused: there is no second initial registration.
    const other = buildApprovedSourceManifest({
      runId,
      validated: validateApprovedSourceInput(sourceInput(`${T7A_TEXT}changed\n`)),
      artifactDigest: computeArtifactDigest(sourceBytes(`${T7A_TEXT}changed\n`)),
      approvedBy: "local-user",
      createdAt,
    });
    assert.throws(
      () => registerApprovedSource(store, runId, other, "local-user"),
      /cannot be registered twice/,
    );
    assert.equal(store.readRun(runId).filter((event) => event.type === "planning.source_registered").length, 1);
    // Amendments never travel as the initial registration.
    const amended = buildSourceManifest(bytes, [{ id: "s1", startByte: 0, endByte: bytes.length }], {
      manifestId: "manifest-amendment",
      sourceId: manifest.sourceId,
      mediaType: manifest.mediaType,
      encoding: manifest.encoding,
      authority: manifest.authority,
      createdAt,
      amendment: {
        id: "amend-1",
        priorManifestId: manifest.manifestId,
        priorArtifactDigest: manifest.artifactDigest,
        authorizedBy: "user:local-user",
        rationale: "Test amendment.",
      },
    });
    assert.throws(
      () => registerApprovedSource(store, runId, amended, "local-user"),
      /cannot be an amendment/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a F3: corrupt-source recovery refuses without policy or source mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f3-corrupt-"));
  const store = openScheduler(root);
  try {
    const clock = advancingClock();
    const runId = "run_t7a_f3_corrupt";
    const createdAt = "2026-10-02T00:00:00.000Z";
    ensurePlanningProvisioningPrefix(store, t7aSpec(runId, "O."), clock);
    const before = store.readRun(runId).length;
    const { manifest, bytes } = t7aManifest(runId, createdAt);
    const drifted = new Uint8Array(bytes);
    drifted[0] = drifted[0]! ^ 0xff;
    assert.throws(
      () => verifyPreparedApprovedSource({ runId, manifest, storedBytes: drifted, createdAt }),
      /UTF-8|drift|does not match/i,
    );
    assert.equal(store.readRun(runId).length, before, "refusal mutates neither prefix nor registration");
    assert.equal(
      store.readRun(runId).filter((event) => event.type === "planning.source_registered").length,
      0,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F4: direct native validation before capability/artifact/save effects.
// ---------------------------------------------------------------------------

test("T7a F4: factory preparation validates source, intent, and options before effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f4-prepare-"));
  const factory = new NativeBuildFactory({
    projectRoot: root,
    stateDirectory: join(root, "state"),
    providerConfigs: { load: () => [], save: () => undefined, close: () => undefined },
    baselineFor: () => "a".repeat(40),
  });
  try {
    const createdAt = "2026-10-02T00:00:00.000Z";
    const spec = () => baseSpec("run_t7a_f4", { createdAt, planningPolicy: { version: 1 as const } });
    const artifacts = new ArtifactStore(join(root, "state", "artifacts"));
    const digestOf = (text: string) => computeArtifactDigest(sourceBytes(text));
    // Malformed source: unsupported media refuses with no artifact effect.
    await assert.rejects(
      factory.prepareSpec(spec(), {
        approvedSourceInput: { ...sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]), mediaType: "application/pdf" } as never,
        approvedBy: "local-user",
      }),
      /mediaType/,
    );
    await assert.rejects(artifacts.get(digestOf(T7A_TEXT)), /./, "no artifact is stored for refused input");
    // Source without the explicit opt-in refuses rather than changing the default.
    await assert.rejects(
      factory.prepareSpec(baseSpec("run_t7a_f4_plain", { createdAt }), {
        approvedSourceInput: sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]),
        approvedBy: "local-user",
      }),
      /opt-in/,
    );
    await assert.rejects(artifacts.get(digestOf(T7A_TEXT)), /./);
    // Malformed approver and unknown option keys refuse before effects.
    await assert.rejects(
      factory.prepareSpec(spec(), {
        approvedSourceInput: sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]),
        approvedBy: "not a name",
      }),
      /approver/,
    );
    await assert.rejects(
      factory.prepareSpec(spec(), { approvedSourceInput: sourceInput(T7A_TEXT), manifest: {} } as never),
      /unknown option/,
    );
    assert.throws(
      () => validateProvisioningPrepareOptions({ approvedBy: "user:x" }),
      /approver/,
    );
    // Direct native explicit provisioning derives the kernel manifest and stores exact bytes.
    const prepared = await factory.prepareSpec(spec(), {
      approvedSourceInput: sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]),
      approvedBy: "local-user",
    });
    assert.ok(prepared.approvedSource, "kernel manifest is stamped");
    assert.equal(prepared.approvedSource!.authority, "user:local-user");
    assert.equal(prepared.approvedSource!.createdAt, createdAt);
    assert.equal(prepared.approvedSource!.artifactDigest, digestOf(T7A_TEXT));
    assert.equal(prepared.planningPolicy?.version, 1);
    const stored = await artifacts.get(digestOf(T7A_TEXT));
    assert.deepEqual(Buffer.from(stored).toString("utf8"), T7A_TEXT, "original bytes stored unchanged");
    // The prepared manifest verifies against the stored artifact and the saved clock.
    verifyPreparedApprovedSource({
      runId: prepared.runId,
      manifest: prepared.approvedSource!,
      storedBytes: stored,
      createdAt,
    });
    // A legacy benchmark spec prepares without inferring any current default.
    const legacy = await factory.prepareSpec({
      ...baseSpec("run_t7a_f4_bench", { createdAt }),
      benchmark: { attemptId: "attempt-1", allowedCommands: ["node --test"], hiddenPaths: ["h"], protectedPaths: ["p"] },
    });
    assert.equal(legacy.planningPolicy, undefined);
    assert.equal(legacy.approvedSource, undefined);
    assert.deepEqual(legacy.benchmark?.attemptId, "attempt-1");
  } finally {
    await factory.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source-free policy1 runs: triage first, answer without mutation, clarify
// asks the owner, build pauses for source approval.
// ---------------------------------------------------------------------------

class CountingWorkerDriver implements WorkerRuntimeDriver {
  readonly assignments: string[] = [];
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment.task.id);
    return { type: "failed", reason: "must_not_dispatch" };
  }
}

function stubProjectDocsPort() {
  return {
    commit: async (input: { writes: { path: string; content: string }[]; summary: string; runId: string; requestId: string }) => ({
      commit: createHash("sha256").update(`commit:${input.requestId}`).digest("hex").slice(0, 40),
      parent: createHash("sha256").update(`parent:${input.requestId}`).digest("hex").slice(0, 40),
      head: createHash("sha256").update(`head:${input.requestId}`).digest("hex").slice(0, 40),
      entryPoint: { readme: true, agentsMarkedSection: true, claudePointer: true, agentsMarkedSectionV2: false, claudePointerV2: false },
    }),
    relateRevision: async () => "equal_to_tip" as const,
    readHandoffSnapshotFile: async () => {
      throw new Error("t7a stubs never reach the handoff snapshot read");
    },
    readIntegrationTipFile: async () => {
      throw new Error("t7a stubs never reach the integration tip read");
    },
    findTrackedFileWithDigest: async () => {
      throw new Error("t7a stubs never reach the tracked file search");
    },
    findHandoffSnapshotCommit: async () => {
      throw new Error("t7a stubs never reach the handoff snapshot lookup");
    },
    readIntegrationBaselineRevision: async () => {
      throw new Error("t7a stubs never reach the baseline revision read");
    },
    canStageSpecPath: async () => {
      throw new Error("t7a stubs never reach the spec stageability check");
    },
    commitHandoffSnapshot: async (input: { writes: { path: string; content: string }[]; summary: string; runId: string; snapshotKey: string }) => ({
      commit: createHash("sha256").update(`snapshot:${input.snapshotKey}`).digest("hex").slice(0, 40),
      parent: createHash("sha256").update(`parent:${input.snapshotKey}`).digest("hex").slice(0, 40),
      head: createHash("sha256").update(`head:${input.snapshotKey}`).digest("hex").slice(0, 40),
      entryPoint: { readme: false, agentsMarkedSection: false, claudePointer: false, agentsMarkedSectionV2: false, claudePointerV2: false },
    }),
  };
}

async function invokeTool(request: ArchitectActionRequest, name: string, args: unknown, callId: string): Promise<ToolExecutionOutput> {
  const call: ToolCallBlock = { type: "tool_call", callId, name, arguments: args };
  const output = await request.tools.invoke(call, request.context);
  assert.equal(output.isError, false, `${name}: ${JSON.stringify(output.error)}`);
  return output;
}

class T7aTriageDriver implements ArchitectRuntimeDriver {
  runs = 0;
  constructor(private readonly script: (request: ArchitectActionRequest, step: number) => Promise<void>) {}
  async run(request: ArchitectActionRequest): Promise<void> {
    const step = this.runs++;
    await this.script(request, step);
  }
}

function sourceFreeRuntime(
  root: string,
  runId: string,
  architect: ArchitectRuntimeDriver,
  extra: { workers?: CountingWorkerDriver; integrations?: unknown[] } = {},
) {
  const store = openScheduler(root);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const workers = extra.workers ?? new CountingWorkerDriver();
  const integrations = extra.integrations ?? [];
  const runtime = new BuildRuntime({
    runId,
    initialObjective: "Deliver the value module.",
    store,
    clock: advancingClock(),
    workerDriver: workers,
    architectDriver: architect,
    integrationDriver: {
      integrate: async (input) => {
        (integrations as unknown[]).push(input);
        return { status: "conflict", integrationRevision: "x".repeat(40), conflictPaths: ["must_not_integrate"] };
      },
    },
    maxConcurrency: 1,
    workspaceFor: async () => {
      throw new Error("must_not_allocate");
    },
    artifacts,
    projectDocs: stubProjectDocsPort(),
    planningPolicy: { version: 1 },
    coverageReview: { candidateRuntimeIds: ["google:reviewer"], calls: [], review: async () => { throw new Error("must_not_review"); } } as never,
  });
  return { store, runtime, workers, integrations };
}

test("T7a F4: manager refuses source-without-opt-in before preparation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-f4-manager-"));
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  try {
    let prepareCalls = 0;
    const manager = new NativeBuildManager({
      specs,
      createRuntime: async (spec) => stubHandle(spec.runId),
      prepareSpec: async (spec) => {
        prepareCalls += 1;
        return cloneBuildSpec(spec);
      },
    });
    try {
      await assert.rejects(
        manager.create(baseSpec("run_t7a_f4_noopt"), {
          approvedSourceInput: sourceInput(T7A_TEXT, [...t7aSections(T7A_TEXT)]),
          approvedBy: "local-user",
        }),
        /opt-in/,
      );
      assert.equal(prepareCalls, 0, "inconsistent payloads refuse before preparation");
    } finally {
      await manager.close().catch(() => undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a source-free: triage is first, then build pauses bounded for source approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-sf-build-"));
  const runId = "run_t7a_sf_build";
  const architect = new T7aTriageDriver(async (request, step) => {
    if (step === 0) {
      await invokeTool(request, "record_triage", { decision: "build", rationale: "Change requested, no source yet." }, "triage");
      return;
    }
    throw new Error("source-free build must not spin Architect turns while paused");
  });
  const { store, runtime, workers, integrations } = sourceFreeRuntime(root, runId, architect);
  try {
    const constructed = store.readRun(runId).map((event) => event.type);
    assert.deepEqual(constructed.slice(0, 3), [
      "project_docs.policy_configured",
      "run.initialized",
      "planning.policy_configured",
    ]);
    assert.ok(constructed.indexOf("run.policy_configured") > 2, "factory consumers stamp after the prefix");
    const first = await runtime.step();
    assert.equal(first.status, "progressed");
    assert.equal(architect.runs, 1);
    const second = await runtime.step();
    assert.deepEqual([second.status, second.action], ["paused", "planning_source_missing"]);
    assert.equal(architect.runs, 1, "the pause takes no Architect turn");
    const events = store.readRun(runId);
    const pauses = events.filter((event) => event.type === "run.paused");
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0]!.payload.reason, "planning_source_missing");
    assert.deepEqual(pauses[0]!.actor, { role: "runner", id: "build-runtime" });
    const third = await runtime.step();
    assert.equal(third.status, "paused");
    assert.equal(store.readRun(runId).length, events.length, "the pause is bounded: no further events");
    assert.equal(architect.runs, 1);
    // Triage precedes everything; nothing plans, dispatches, or integrates.
    const types = events.map((event) => event.type);
    assert.ok(types.indexOf("request.triaged") < types.indexOf("run.paused"));
    assert.equal(types.filter((type) => type === "task.transitioned").length, 0);
    assert.equal(types.filter((type) => type.startsWith("planning.") && type !== "planning.policy_configured").length, 0);
    assert.equal(workers.assignments.length, 0);
    assert.equal(integrations.length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a source-free: an answer records with zero project, doc, worker, or coverage mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-sf-answer-"));
  const runId = "run_t7a_sf_answer";
  const architect = new T7aTriageDriver(async (request, step) => {
    if (step === 0) {
      await invokeTool(request, "record_triage", { decision: "answer", rationale: "Pure question." }, "triage");
      return;
    }
    if (step === 1) {
      await invokeTool(request, "record_answer", {
        answerText: "The value module is missing; create it.",
        addressedParts: ["What is missing"],
      }, "answer");
      return;
    }
    throw new Error("answer test drives exactly two turns");
  });
  const coverageCalls: unknown[] = [];
  const store = openScheduler(root);
  const runtime = new BuildRuntime({
    runId,
    initialObjective: "What is missing?",
    store,
    clock: advancingClock(),
    workerDriver: new CountingWorkerDriver(),
    architectDriver: architect,
    integrationDriver: {
      integrate: async () => {
        throw new Error("must_not_integrate");
      },
    },
    maxConcurrency: 1,
    workspaceFor: async () => {
      throw new Error("must_not_allocate");
    },
    artifacts: new ArtifactStore(join(root, "artifacts")),
    projectDocs: stubProjectDocsPort(),
    planningPolicy: { version: 1 },
    coverageReview: { candidateRuntimeIds: ["google:reviewer"], review: async (input: unknown) => { coverageCalls.push(input); throw new Error("must_not_review"); } } as never,
  });
  try {
    await runtime.step();
    await runtime.step();
    const events = store.readRun(runId);
    const types = events.map((event) => event.type);
    assert.ok(types.includes("request.triaged"));
    assert.ok(types.includes("request.answered"));
    const answered = events.find((event) => event.type === "request.answered")!;
    assert.deepEqual((answered.payload as { addressedParts: string[] }).addressedParts, ["What is missing"]);
    assert.equal(types.filter((type) => type === "task.transitioned").length, 0);
    assert.equal(types.filter((type) => type === "plan.created").length, 0);
    assert.equal(types.filter((type) => type.startsWith("planning.") && type !== "planning.policy_configured").length, 0);
    assert.equal(types.filter((type) => type.startsWith("project_doc.")).length, 0);
    assert.equal(types.filter((type) => type.startsWith("integration.")).length, 0);
    assert.equal(coverageCalls.length, 0);
    assert.equal(architect.runs, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T7a source-free: clarify asks the owner a bounded question", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-sf-clarify-"));
  const runId = "run_t7a_sf_clarify";
  const architect = new T7aTriageDriver(async (request, step) => {
    if (step === 0) {
      await invokeTool(request, "record_triage", { decision: "clarify", rationale: "The request is unanswerable as stated." }, "triage");
      return;
    }
    if (step === 1) {
      await invokeTool(request, "ask_user", {
        questionId: "q-source",
        version: 1,
        decisionKind: "authority_decision",
        question: "Which specification bytes approve this change?",
      }, "ask");
      return;
    }
    throw new Error("clarify test drives exactly two turns");
  });
  const { store, runtime } = sourceFreeRuntime(root, runId, architect);
  try {
    await runtime.step();
    await runtime.step();
    const events = store.readRun(runId);
    const question = events.find((event) => event.type === "architect.question_requested");
    assert.ok(question, "clarify asks the owner");
    assert.equal((question!.payload as { questionId: string }).questionId, "q-source");
    assert.deepEqual(question!.actor, { role: "architect", id: "architect_1" });
    const blocked = await runtime.step();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.action, "architect_question_pending");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unseeded product journey: fresh opt-in provisioning through factory,
// planning, coverage, worker, delivery, and owned acceptance.
// ---------------------------------------------------------------------------

const T7A_RUN = "run_t7a_product_journey";
const T7A_CLOCK = "2026-10-02T00:00:00.000Z";
const T7A_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Keep the change to src/value.mjs only; caf\u00e9 stays byte-exact.\r\n";
const T7A_LOW_CONTENT = "export const value = 2;\n";
const T7A_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value', () => assert.equal(value, 2));\n";

function t7aJourneySections(): [{ id: string; startByte: number; endByte: number }, { id: string; startByte: number; endByte: number }] {
  const firstEnd = Buffer.byteLength(`${T7A_SOURCE.split("\n")[0]!}\n`, "utf8");
  return [
    { id: "s1", startByte: 0, endByte: firstEnd },
    { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(T7A_SOURCE, "utf8") },
  ];
}

function t7aJourneyScenario(runId: string) {
  const bytes = sourceBytes(T7A_SOURCE);
  const validated = validateApprovedSourceInput(sourceInput(T7A_SOURCE, [...t7aJourneySections()]));
  const manifest = buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: T7A_CLOCK,
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1", "s2"] },
    purpose: "Export the value 2.",
    observableOutcome: "The value module exports 2.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "value is 2.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the value module.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["src/value.mjs"], excludes: ["docs/project/STATE.md"] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The value module is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const tasks: ExecutionTaskContract[] = [{
    id: "T1",
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: ["REQ-1"],
    outcome: { user: "Create src/value.mjs exporting value = 2.", system: "The value module exports 2." },
    scope: { includes: ["src/value.mjs"], excludes: ["test/value.test.mjs"] },
    writableSurfaces: ["src/value.mjs"],
    forbiddenSurfaces: ["test/value.test.mjs"],
    dependencies: [],
    requiredBase: "accepted plan revision revision_t7a",
    inputs: ["accepted plan revision"],
    outputs: ["src/value.mjs"],
    steps: ["Write the module.", "Run the tests."],
    acceptance: { criteria: [{ id: "c1", text: "src/value.mjs exports value = 2 and the tests pass." }], definitionOfDone: "Tests pass." },
    validation: { targetedRationale: "The value test.", affectedScopeRationale: "The module only." },
    negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
    reviewCriteria: ["Independent review confirms the value."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_t7a",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: T7A_CLOCK,
  });
  return { manifest, requirements, phases, revision };
}

const journeyCall = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

function journeyLastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

function t7aToolResults(request: AgentModelRequest): Array<{ toolName?: string; isError?: boolean }> {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => message.content as { toolName?: string; isError?: boolean });
}

function t7aToolFailed(request: AgentModelRequest, toolName: string): boolean {
  return t7aToolResults(request).some((result) => result.toolName === toolName && result.isError === true);
}

function t7aFailureDetail(request: AgentModelRequest, toolName: string): string {
  const failed = request.messages
    .filter((message) => message.role === "tool")
    .reverse()
    .find((message) => (message.content as { toolName?: string }).toolName === toolName && (message.content as { isError?: boolean }).isError === true);
  return JSON.stringify(failed?.content).slice(0, 1500);
}

function t7aReadText(request: AgentModelRequest, path: string): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    const content = message.content as { toolName?: string; content?: Array<{ type: string; value?: unknown; text?: string }> };
    if (content.toolName !== "fs.read") continue;
    const meta = content.content?.find((item) => item.type === "json")?.value as { path?: string } | undefined;
    if (meta?.path !== path) continue;
    const text = content.content?.find((item) => item.type === "text")?.text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

function t7aLastModelToolError(models: Array<{ requests: AgentModelRequest[] }>): string {
  for (let index = models.length - 1; index >= 0; index--) {
    const requests = models[index]!.requests;
    for (let i = requests.length - 1; i >= 0; i--) {
      const failed = requests[i]!.messages
        .filter((message) => message.role === "tool")
        .reverse()
        .find((message) => (message.content as { isError?: boolean } | undefined)?.isError === true);
      if (failed) return `last failing model tool call: ${JSON.stringify(failed.content).slice(0, 1500)}`;
    }
  }
  return "no failing model tool call recorded";
}

class T7aJourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof t7aJourneyScenario>,
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return journeyCall(name, args, `t7a-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "T7a product: change request with an approved source." });
    }
    const manifestId = planning?.source.currentManifestId;
    assert.ok(manifestId, "the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = this.scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      const seen = this.requests.length;
      if (seen <= 2) return this.call("read_planning_source_section", {});
      return this.call("read_planning_source_section", { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.call("persist_planning_ledger", {
        id: "ledger-1",
        requirements: this.scenario.requirements,
        phases: this.scenario.phases,
        nonNormativeSections: [],
      });
    }
    if (!planning?.plan) {
      const { digest: _digest, runId: _run, createdAt: _created, ...rest } =
        this.scenario.revision as unknown as Record<string, unknown>;
      void _digest;
      void _run;
      void _created;
      return this.call("draft_planning_plan", { revision: rest });
    }
    if (Object.keys(planning?.coverageRequests ?? {}).length === 0) {
      return this.call("request_coverage_review", { reviewId: "coverage_t7a" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      return this.call("review_task", {
        taskId: "T1",
        decision: "approved",
        summary: "The deliverable review is satisfied and the evidence passes.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "Tests pass.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))] }],
      });
    }
    if (task.status === "approved") return this.call("request_integration", { taskId: "T1" });
    throw new Error(`T7a journey script exhausted at T1 ${task.status}.`);
  }
}

class T7aJourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    if (t7aToolFailed(request, "submit_task")) {
      throw new Error(`T7a fixture: submit_task refused: ${t7aFailureDetail(request, "submit_task")}`);
    }
    if (t7aToolFailed(request, "run_evidence_command")) {
      throw new Error(`T7a fixture: run_evidence_command failed: ${t7aFailureDetail(request, "run_evidence_command")}`);
    }
    if (t7aToolFailed(request, "fs.write")) {
      throw new Error(`T7a fixture: fs.write failed: ${t7aFailureDetail(request, "fs.write")}`);
    }
    const toolCount = request.messages.filter((message) => message.role === "tool").length;
    if (toolCount === 0) return journeyCall("fs.write", { path: "src/value.mjs", content: T7A_LOW_CONTENT, createDirectories: true }, "write-1");
    if (toolCount === 1) return journeyCall("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test"] }, "evidence-1");
    const record = journeyLastToolValue(request)!;
    const fact = record.fact as { stdoutArtifactHash: string; exitCode: number | null; timedOut?: boolean; cancelled?: boolean };
    assert.equal(fact.exitCode, 0, `the evidence test run must genuinely succeed before the worker claims it passes: ${JSON.stringify(record).slice(0, 1500)}`);
    assert.equal(fact.timedOut ?? false, false, "the evidence test run must not time out");
    assert.equal(fact.cancelled ?? false, false, "the evidence test run must not be cancelled");
    assert.ok(typeof record.id === "string" && record.id.length > 0, "the evidence test run records an evidence id");
    return journeyCall("submit_task", {
      summary: "Added src/value.mjs exporting value = 2; node --test passes.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: {
        changed: ["src/value.mjs"],
        verified: ["src/value.mjs exports value = 2"],
        testsRun: [{ command: "node --test", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }],
        notRun: [],
      },
    }, "submit-1");
  }
}

class T7aJourneyReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const tools = new Set(request.tools.map((tool) => tool.name));
    const seen = request.messages.filter((message) => message.role === "tool").length;
    // Independent coverage, blind first: obligations before any plan view.
    if (tools.has("record_coverage_obligations")) {
      return journeyCall("record_coverage_obligations", {
        obligations: [{ id: "obl-REQ-1", description: "Export the value 2.", requirementId: "REQ-1" }],
        sectionCoverage: [
          { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
          { sectionId: "s2", obligationIds: ["obl-REQ-1"] },
        ],
      }, `obl-${seen}`);
    }
    if (tools.has("submit_coverage_verdict")) {
      return journeyCall("submit_coverage_verdict", {
        obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
        findings: [],
      }, `verdict-${seen}`);
    }
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    if (pass === "delivery-obligations-system") {
      return journeyCall("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2." }] }, `obl-${seen}`);
    }
    if (pass === "delivery-findings-system") {
      if (t7aToolFailed(request, "fs.read")) {
        throw new Error(`T7a fixture: findings fs.read failed: ${t7aFailureDetail(request, "fs.read")}`);
      }
      if (t7aToolFailed(request, "record_deliverable_findings")) {
        throw new Error(`T7a fixture: record_deliverable_findings refused: ${t7aFailureDetail(request, "record_deliverable_findings")}`);
      }
      if (seen === 0) return journeyCall("fs.read", { path: "src/value.mjs" }, "read-1");
      return journeyCall("record_deliverable_findings", { findings: [] }, `findings-${seen}`);
    }
    if (request.tools.some((tool) => tool.name === "record_verification_expectations")) {
      return journeyCall("record_verification_expectations", {
        expectations: [{
          taskId: "T1",
          criterionId: "c1",
          expectedBehaviors: ["src/value.mjs exports value = 2."],
          edgeCases: ["A new module has no prior-incorrect case."],
          regressionSurfaces: ["src/value.mjs"],
          requiredTests: ["The value test passes."],
        }],
      }, `verifier-expectations-${seen}`);
    }
    if (request.tools.some((tool) => tool.name === "submit_verifier_verdict")) {
      if (seen === 0) {
        return journeyCall("run_evidence_command", { label: "verifier-tests", command: process.execPath, args: ["--test"] }, "verifier-evidence-1");
      }
      const record = journeyLastToolValue(request);
      const evidenceId = (record as { id?: unknown } | undefined)?.id;
      assert.ok(typeof evidenceId === "string" && evidenceId.length > 0, "the verifier test run records evidence");
      return journeyCall("submit_verifier_verdict", {
        criterionVerdicts: [{
          taskId: "T1",
          criterionId: "c1",
          verdict: "satisfied",
          rationale: "The module exports 2 and the cited verifier test run passed.",
          evidenceIds: [evidenceId],
        }],
      }, "verifier-verdict-1");
    }
    if (pass === "delivery-verdict-system") {
      if (t7aToolFailed(request, "submit_deliverable_verdict")) {
        throw new Error(`T7a fixture: submit_deliverable_verdict refused: ${t7aFailureDetail(request, "submit_deliverable_verdict")}`);
      }
      if (t7aToolFailed(request, "fs.read")) {
        throw new Error(`T7a fixture: verdict fs.read failed: ${t7aFailureDetail(request, "fs.read")}`);
      }
      // The verdict pass runs in a fresh session, so the citation read must
      // happen here before the verdict is submitted.
      const inspected = t7aReadText(request, "src/value.mjs");
      if (inspected === undefined) {
        return journeyCall("fs.read", { path: "src/value.mjs" }, `verdict-read-${seen}`);
      }
      assert.ok(inspected.split("\n")[0]!.includes("export const value = 2;"), "the cited line 1 actually exports value = 2");
      const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
      const survivors = [...new Set([...text.matchAll(/"id": "(mutation-survivor:[^"]+)"/g)].map((match) => match[1]!))];
      assert.equal(survivors.length, 0, `unexpected mutation survivors on the value line are real gaps and cannot be blanket-released: ${survivors.join(", ")}`);
      const claimIds = [...new Set([...text.matchAll(/"id": "(claim:[^"]+)"/g)].map((match) => match[1]!))];
      assert.ok(claimIds.includes("claim:c1"), "the verdict context names the criterion claim");
      assert.ok(claimIds.includes("claim:summary"), "the verdict context names the summary claim");
      return journeyCall("submit_deliverable_verdict", {
        summary: "The module exports 2 and the cited test run passed.",
        satisfied: true,
        claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Read src/value.mjs line 1 in this verdict session and confirmed it exports value = 2.", citations: [{ path: "src/value.mjs", line: 1 }] })),
      }, `verdict-${seen}`);
    }
    throw new Error(`Unexpected T7a reviewer system ${pass}.`);
  }
}

function t7aProvider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

test("T7a product: unseeded opt-in provisioning plans, covers, builds, and accepts through the real factory", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-journey-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "t7a-journey-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), T7A_VALUE_TEST);
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: T7A_RUN });
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => T7A_CLOCK });
  let server: ControlServer | undefined;
  let factory: FixtureNativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  try {
    const worker = new T7aJourneyWorker();
    const reviewer = new T7aJourneyReviewer();
    const architect = new T7aJourneyArchitect(() => runtime!.projection(), t7aJourneyScenario(T7A_RUN));
    factory = new FixtureNativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [t7aProvider("arch:architect", 1), t7aProvider("work:worker", 2), t7aProvider("rev:reviewer", 3)],
        save: () => undefined,
        close: () => undefined,
      },
      executionHost,
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) => {
        if (config.runtimeId === "arch:architect") return architect;
        if (config.runtimeId === "work:worker") return worker;
        return reviewer;
      },
    });
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: (spec) => factory!.create(spec).then((handle) => {
        runtime = handle.runtime as typeof runtime;
        return handle;
      }),
      prepareSpec: (spec, options) => factory!.prepareSpec(spec, options),
    });
    // The actual authenticated production route forwards owner input into
    // the real manager, saved spec, factory, scheduler and model transports.
    server = new ControlServer({ supervisor, token: "t7a-control-token",
      builds: manager, buildProvisioner: manager,
      checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }),
      bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }),
    });
    const address = await server.start(0);
    const body = { runId: T7A_RUN, projectPath: project, permissionProfile: "full",
      idempotencyKey: "t7a-journey", build: {
        projectId: "t7a-journey-fixture", objective: "Deliver the value module.",
        architectRuntimeId: "arch:architect", workerRuntimeIds: ["work:worker"], verifierRuntimeIds: ["rev:reviewer"],
        alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {},
        planningPolicy: { version: 1 }, approvedSource: sourceInput(T7A_SOURCE, [...t7aJourneySections()]),
      } };
    const create = () => fetch(`${address.url}/v2/runs`, { method: "POST",
      headers: { Authorization: "Bearer t7a-control-token", "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    const created = await create();
    assert.equal(created.status, 201, await created.text());
    const originalEvents = manager.events(T7A_RUN);
    const retry = await create();
    assert.equal(retry.status, 201, await retry.text());
    assert.deepEqual(manager.events(T7A_RUN), originalEvents, "HTTP retry reuses exact saved approval and policy");
    // The first three scheduler events are the T7a prefix, before factory consumers.
    let events = manager.events(T7A_RUN);
    assert.deepEqual(events.slice(0, 3).map((event) => event.type), [
      "project_docs.policy_configured",
      "run.initialized",
      "planning.policy_configured",
    ]);
    assert.deepEqual(events.slice(0, 3).map((event) => event.sequence), [1, 2, 3]);
    for (const event of events.slice(0, 3)) {
      assert.deepEqual(event.actor, { role: "runner", id: "build-runtime" });
    }
    assert.deepEqual(events.slice(0, 3).map((event) => event.idempotencyKey), [
      "project-docs-policy",
      "run-initialized",
      "planning-policy",
    ]);
    assert.deepEqual(events[0]!.payload, { version: 2 });
    assert.deepEqual(events[1]!.payload, expectedGeneratedRunInitializedPayload("Deliver the value module."));
    assert.deepEqual(events[2]!.payload, { version: 1 });
    // Lane-B guards activate immediately after the T7a prefix, before source registration.
    assert.deepEqual(events.slice(3, 5).map((event) => event.type), [
      "run.evidence_policy_activated",
      "delivery.test_integrity_initialized",
    ]);
    assert.deepEqual(events[3]!.actor, { role: "runner", id: "build-runtime" });
    assert.equal(events[3]!.idempotencyKey, "evidence-content-policy:v1");
    assert.deepEqual(events[3]!.payload, { version: 1 });
    assert.deepEqual(events[4]!.actor, { role: "runner", id: "build-runtime" });
    assert.equal(events[4]!.idempotencyKey, "test-integrity-initial-revision:v1");
    assert.deepEqual(events[4]!.payload, { revision: baseline.revision, architectActorId: "architect_1" });
    const evidenceIndex = events.findIndex((event) => event.type === "run.evidence_policy_activated");
    const integrityIndex = events.findIndex((event) => event.type === "delivery.test_integrity_initialized");
    const sourceIndex = events.findIndex((event) => event.type === "planning.source_registered");
    assert.deepEqual([evidenceIndex, integrityIndex], [3, 4], "lane-B guards activate immediately after the T7a prefix");
    assert.equal(sourceIndex, integrityIndex + 1, "the approved source registers immediately after lane-B guard activation");
    const policyIndex = events.findIndex((event) => event.type === "run.policy_configured");
    assert.ok(policyIndex > sourceIndex, "factory policy consumers stamp after source registration");
    // The kernel registered the explicitly approved source immutably.
    const registered = events.find((event) => event.type === "planning.source_registered")!;
    assert.ok(registered, "the approved source is registered");
    assert.deepEqual(registered.actor, { role: "user", id: "local-user" });
    const manifest = (registered.payload as { manifest: ApprovedSourceManifest }).manifest;
    const expectedDigest = createHash("sha256").update(T7A_SOURCE, "utf8").digest("hex");
    assert.equal(manifest.artifactDigest, expectedDigest);
    assert.equal(manifest.byteLength, Buffer.byteLength(T7A_SOURCE, "utf8"));
    assert.equal(manifest.authority, "user:local-user");
    const storedBytes = await new ArtifactStore(join(state, "artifacts")).get(expectedDigest);
    assert.deepEqual(Buffer.from(storedBytes).toString("utf8"), T7A_SOURCE);
    const stepUntil = async (label: string, done: (projection: SchedulerProjection) => boolean, cap = 200): Promise<SchedulerProjection> => {
      for (let step = 0; step < cap; step += 1) {
        const projection = runtime!.projection();
        if (done(projection)) return projection;
        if (projection.status === "paused" || projection.status === "failed") {
          throw new Error(`${label}: run ${projection.status} unexpectedly (${JSON.stringify(projection.pauseReason)}); ${t7aLastModelToolError([architect, worker, reviewer])}`);
        }
        await runtime!.step();
      }
      throw new Error(`${label}: not reached within ${cap} steps`);
    };
    await stepUntil("ready plan", (projection) => projection.planning?.readiness === "ready");
    assert.equal(worker.requests.length, 0, "no worker activity before the explicit owner start");
    const explicitStartIdentity = currentExplicitStartIdentity(runtime!.projection());
    assert.ok(explicitStartIdentity, "ready plan exposes an explicit start identity");
    const start = await fetch(`${address.url}/v2/runs/${T7A_RUN}/build/plan-start`, { method: "POST",
      headers: { Authorization: "Bearer t7a-control-token", "Content-Type": "application/json" },
      body: JSON.stringify({ ...explicitStartIdentity, version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" }) });
    assert.equal(start.status, 200, await start.text());
    const authorized = manager!.events(T7A_RUN).find((event) => event.type === "planning.execution_authorized");
    assert.ok(authorized, "the explicit owner start is recorded");
    assert.deepEqual(authorized!.actor, { role: "user", id: "local-user" });
    assert.equal(worker.requests.length, 0, "authorizing does not itself dispatch");
    const accepted = await stepUntil(
      "task acceptance",
      () => manager!.events(T7A_RUN).some((event) => event.type === "task.acceptance_recorded"),
    );
    events = manager.events(T7A_RUN);
    const types = events.map((event) => event.type);
    // Triage is the first actual planning action; reads, ledger, and draft follow.
    const triagedAt = types.indexOf("request.triaged");
    assert.ok(triagedAt >= 0);
    for (const later of ["planning.source_section_read", "planning.ledger_persisted", "planning.plan_drafted"] as const) {
      assert.ok(types.indexOf(later) > triagedAt, `${later} follows triage`);
    }
    // Independent coverage, blind first, then ready on the current revision.
    const obligations = events.find((event) => event.type === "planning.coverage_obligations_recorded")!;
    assert.ok(obligations, "coverage obligations recorded");
    assert.equal((obligations.payload as { sourceManifestId: string }).sourceManifestId, manifest.manifestId);
    const review = accepted.planning?.coverageReview;
    assert.ok(review, "coverage review recorded");
    assert.equal(review!.sourceReadManifestId, manifest.manifestId);
    assert.equal(review!.independence, "distinct_model");
    assert.ok(
      review!.derivedObligations.every((obligation) => obligation.recordedBeforePlanOrDiffProvided),
      "obligations derive blind, before the plan",
    );
    assert.ok(review!.obligationVerdicts.length > 0 && review!.obligationVerdicts.every((verdict) => verdict.verdict === "covered"));
    assert.equal(accepted.planning?.readiness, "ready");
    // The worker really wrote, ran evidence, and submitted after the run started.
    const task = accepted.tasks.T1!;
    assert.ok(task.criterionEvidenceLinks && task.criterionEvidenceLinks.length > 0, "submission cites evidence");
    const integrationDirs = readdirSync(join(state, "integration"));
    assert.equal(integrationDirs.length, 1);
    const delivered = (await runGit({ cwd: join(state, "integration", integrationDirs[0]!), args: ["show", "HEAD:src/value.mjs"] })).stdout;
    assert.equal(delivered, T7A_LOW_CONTENT);
    // Delivery review ran post-integration and the boundary accepted the task.
    assert.ok(types.includes("delivery.review_started"), "delivery review started");
    assert.ok(types.includes("delivery.boundary_checked"), "post-integration boundary checked");
    assert.ok(types.includes("task.acceptance_recorded"), "owned acceptance recorded");
    // Real participants throughout, and the journey stops at owned acceptance.
    assert.ok(architect!.requests.length > 0, "the Architect really planned");
    assert.ok(worker.requests.length > 0, "the worker really built");
    assert.ok(reviewer.requests.length > 0, "the independent reviewer really reviewed");
    assert.equal(types.filter((type) => type.startsWith("final_verification.")).length, 0, "no repeated final verification journey");
    assert.equal(accepted.status, "running", "the run stops at acceptance, it does not complete itself");
  } finally {
    await server?.close();
    supervisor.close();
    await manager?.close().catch(() => undefined);
    await factory?.close().catch(() => undefined);
    await executionHost?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});


test("T7a HTTP: invalid or unapproved source refuses before Git bootstrap and durable run creation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t7a-http-refusal-"));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
  let gitChecks = 0;
  let bootstraps = 0;
  const server = new ControlServer({ supervisor, token: "t7a-http-token",
    checkGit: async () => { gitChecks += 1; return { available: true, version: "unused", code: "git_ready", reason: null }; },
    bootstrapRun: async () => { bootstraps += 1; throw new Error("invalid source must not bootstrap"); },
  });
  try {
    const address = await server.start(0);
    const good = sourceInput(T7A_TEXT);
    const cases = [
      { source: good, policy: undefined },
      { source: { ...good, approval: "attached" }, policy: { version: 1 } },
      { source: { ...good, authority: "user:forged" }, policy: { version: 1 } },
      { source: { ...good, manifest: {} }, policy: { version: 1 } },
      { source: { ...good, mediaType: "application/pdf" }, policy: { version: 1 } },
      { source: { ...good, bytesBase64: "/w==" }, policy: { version: 1 } },
      { source: { ...good, bytesBase64: "Zg" }, policy: { version: 1 } },
      { source: { ...good, sections: [{ id: "s", startByte: 1, endByte: 10 }] }, policy: { version: 1 } },
    ];
    for (const [index, item] of cases.entries()) {
      const body = { runId: `run_t7a_http_bad_${index}`, projectPath: join(root, "project"),
        permissionProfile: "full", idempotencyKey: `http-bad-${index}`, build: {
          projectId: "http-refusal", objective: "Build.", architectRuntimeId: "a", workerRuntimeIds: ["w"],
          verifierRuntimeIds: ["v"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1,
          runPolicy: "finish", budgetLimits: {}, planningPolicy: item.policy, approvedSource: item.source,
        } };
      const response = await fetch(`${address.url}/v2/runs`, { method: "POST",
        headers: { Authorization: "Bearer t7a-http-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400, await response.text());
      assert.equal(gitChecks, 0);
      assert.equal(bootstraps, 0);
      assert.deepEqual(supervisor.listRuns(), []);
    }
  } finally {
    await server.close();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
