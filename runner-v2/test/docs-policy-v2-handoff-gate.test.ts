import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sanitizeSpecSourceId } from "../src/build-runtime.js";
import { validateBuildSpec } from "../src/build-spec.js";
import {
  assertHandoffSnapshotGate,
  assertProjectHandoffSelectionAccepted,
  buildCompletionReadiness,
  handoffSnapshotCoversRevision,
  rebuildSchedulerProjection,
  specCopyOf,
  handoffFilesOf,
  type NewSchedulerEvent,
  type SchedulerActorRole,
} from "../src/scheduler-store.js";
import type { ProjectDocsPort } from "../src/build-runtime.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { runGit } from "./support/git-fixture.js";
import {
  CLOCK,
  COMPLETION_SUMMARY,
  advancingClock,
  selectHandoffOwner,
  buildRuntimeForHandoff,
  driveHandoff,
  managerSpec,
  openFactoryPort,
  seedEvent,
  silentArchitect,
  v2AnsweredSeed,
  v2PlanOnlySeed,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 handoff suite, file 1 of 8: gate and reducer units.
 *
 * Pure scheduler-store units plus the answered-run harness test. No
 * NativeBuildManager pump anywhere in this file.
 */

test("C2a: an answered docs-v2 run writes nothing and completes", async () => {
  const RUN = "run-c2a-answered";
  const fixture = await openFactoryPort("answered", RUN, (runId) => v2AnsweredSeed(runId), "finish");
  try {
    // Call counters on the factory's own integration (the port keeps
    // delegating to it): an answered run must never touch the docs port.
    let snapshotCalls = 0;
    let readCalls = 0;
    const origCommit = fixture.integration.commitHandoffSnapshot.bind(fixture.integration);
    fixture.integration.commitHandoffSnapshot = async (input) => {
      snapshotCalls += 1;
      return origCommit(input);
    };
    const origRead = fixture.integration.readHandoffSnapshotFile.bind(fixture.integration);
    fixture.integration.readHandoffSnapshotFile = async (input) => {
      readCalls += 1;
      return origRead(input);
    };
    // The answered run still needs its single answer-path Architect turn;
    // the assertion is that it never touches the snapshot port.
    const architect = silentArchitect("The value module must export 2.");
    const { events, projection } = await driveHandoff(fixture, RUN, { runPolicy: "finish", architect });
    assert.equal(architect.calls(), 1);
    assert.equal(projection.projectHandoff?.status, "requested");
    // The manager's automatic handoff applies afterwards with a stub
    // result (as in the original pump); the answered gate needs no
    // snapshot, so the run completes.
    const selected = await selectHandoffOwner(fixture, RUN, "apply_to_project", "handoff:c2a-answered", {
      runPolicy: "finish",
      stubResult: true,
    });
    assert.equal(selected.status, "completed");
    assert.equal(events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.equal(snapshotCalls, 0, "an answered run makes no snapshot commit call");
    assert.equal(readCalls, 0, "an answered run makes no snapshot read call");
    assert.equal(projection.status, "paused");
    const count = await runGit({ cwd: fixture.integration.path, args: ["rev-list", "--count", `${fixture.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "0", "an answered run writes no project file");
  } finally {
    await fixture.close();
  }
});

test("C2a M1: the gate binds to the latest handoff request, not an earlier snapshot", async () => {
  const RUN = "run-c2a-stale-stop";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a stale "));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence });
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    store.append(e("project.handoff_requested", "handoff-1", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop1 = store.readRun(RUN).find((event) => event.type === "project.handoff_requested")!;
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).projectHandoff?.requestedSequence, stop1.sequence);
    const snapshotPayload = (stopSequence: number) => ({
      stopSequence,
      stopKind: "plan_only",
      revision: "revision_value",
      commit: "c".repeat(40),
      parent: "p".repeat(40),
      head: "c".repeat(40),
      bodyDigest: "d".repeat(64),
      paths: ["docs/project/STATE.md"],
      // C2b: the reducer requires the commit-tree proof for the v2 entries.
      previousSnapshotEdited: false,
      agentsSectionCommitted: true,
      claudeLineCommitted: true,
    });
    store.append(e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop1.sequence}`, "runner", "build-runtime", snapshotPayload(stop1.sequence)));
    // Guidance withdraws the handoff; the Architect requests again (stop 2).
    store.append(e("user.guidance_submitted", "guidance-1", "user", "local-user", {
      guidanceId: "guidance-1",
      text: "Hold the handoff and re-verify the plan.",
      version: 1,
      interruptionProtocolVersion: 1,
    }));
    store.append(e("user.guidance_interruption_completed", "guidance-1:interruption", "runner", "build-manager", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
    }));
    const acknowledgementEvidence = evidence.record({
      runId: RUN,
      taskId: "architect",
      actor: { role: "architect", id: "architect" },
      fact: {
        kind: "browser_screenshot",
        label: "the plan already incorporates the withdrawing guidance",
        capturedAt: CLOCK,
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: CLOCK,
      idempotencyKey: "guidance-stale-stop:evidence",
    });
    store.append(e("user.guidance_acknowledged", "guidance-1:ack", "architect", "architect", {
      guidanceId: "guidance-1",
      expectedVersion: 1,
      resolution: {
        type: "no_plan_change",
        rationale: "The initial plan already incorporates the durable guidance.",
        evidenceIds: [acknowledgementEvidence.id],
      },
    }));
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).projectHandoff, undefined);
    store.append(e("project.handoff_requested", "handoff-2", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop2 = [...store.readRun(RUN)].reverse().find((event) => event.type === "project.handoff_requested")!;
    assert.notEqual(stop2.sequence, stop1.sequence);
    // The stop-1 snapshot no longer satisfies the gate.
    const unusedPort: ProjectDocsPort = {
      commit: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      commitHandoffSnapshot: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      readHandoffSnapshotFile: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      readIntegrationTipFile: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      findTrackedFileWithDigest: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      findHandoffSnapshotCommit: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      readIntegrationBaselineRevision: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      canStageSpecPath: async () => {
        throw new Error("the stale-stop test never touches the docs port");
      },
      relateRevision: async () => "strict_descendant" as const,
    };
    const runtime = buildRuntimeForHandoff({
      runId: RUN,
      store,
      projectDocs: unusedPort,
      architect: silentArchitect(),
      clock: advancingClock(),
      runPolicy: "plan_only",
    });
    assert.throws(
      () => runtime.selectProjectHandoff(
        "keep_integration_branch",
        { integrationRevision: "revision_value", integrationBranch: "aiboard/integration/c2a-stale", appliedToProject: false },
        "handoff:c2a-stale-early",
      ),
      /kernel handoff snapshot/,
    );
    store.append(e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop2.sequence}`, "runner", "build-runtime", snapshotPayload(stop2.sequence)));
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      { integrationRevision: "revision_value", integrationBranch: "aiboard/integration/c2a-stale", appliedToProject: false },
      "handoff:c2a-stale",
    );
    assert.equal(selected.status, "completed");
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a: a seeded docs-v1 run still requires the model-written STATE.md exactly as before", async () => {
  const RUN = "run-c2a-v1";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a v1 "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 1 }));
    store.append(e("run.initialized", "run-initialized", "runner", "build-runtime", {}));
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }));
    store.append(e("plan.created", "plan", "architect", "architect", { revision: 1, tasks: [] }));
    assert.equal(store.readRun(RUN).length, 4);
    let projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(projection.projectDocsPolicyVersion, 1);
    const before = buildCompletionReadiness(projection);
    assert.equal(before.ready, false);
    assert.ok(before.issues.some((issue) => issue.includes("docs/project/STATE.md has not been committed.")), before.issues.join(" | "));
    store.append(e("project_doc.requested", "req-state", "architect", "architect", {
      requestId: "req-state",
      path: "docs/project/STATE.md",
      contentArtifactHash: "a".repeat(64),
      contentBytes: 10,
      summary: "Write the project state",
    }));
    store.append(e("project_doc.committed", "commit-state", "runner", "integration-manager", {
      requestId: "req-state",
      path: "docs/project/STATE.md",
      commit: "c".repeat(40),
      parent: "p".repeat(40),
      head: "c".repeat(40),
      readme: true,
      agentsMarkedSection: true,
      claudePointer: true,
    }));
    projection = rebuildSchedulerProjection(store.readRun(RUN));
    const after = buildCompletionReadiness(projection);
    assert.deepEqual(after.issues, [], after.issues.join(" | "));
    assert.equal(after.ready, true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a: run.completed is refused before the kernel event and accepted after it", () => {
  const RUN = "run-c2a-completed";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a completed "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop = store.readRun(RUN).find((event) => event.type === "project.handoff_requested")!;
    assert.throws(
      () => store.append(e("run.completed", "completed-early", "architect", "architect", {})),
      /kernel handoff snapshot/,
    );
    store.append(e("run.paused", "paused-failure", "runner", "build-runtime", { reason: "handoff_snapshot_failed" }));
    store.append(e("project_docs.handoff_snapshot_committed", `handoff-snapshot:${stop.sequence}`, "runner", "build-runtime", {
      stopSequence: stop.sequence,
      stopKind: "plan_only",
      revision: "revision_value",
      commit: "c".repeat(40),
      parent: "p".repeat(40),
      head: "c".repeat(40),
      bodyDigest: "d".repeat(64),
      paths: ["docs/project/STATE.md"],
      // C2b: the reducer requires the commit-tree proof for the v2 entries.
      previousSnapshotEdited: false,
      agentsSectionCommitted: true,
      claudeLineCommitted: true,
    }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(projection.pauseReason, undefined, "the snapshot event clears its failure pause");
    assert.equal(projection.projectDocs?.snapshots?.length, 1);
    store.append(e("run.completed", "completed", "architect", "architect", {}));
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).status, "completed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a: the snapshot gate only fires for non-answered docs-v2 runs", () => {
  const RUN = "run-c2a-gate";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a gate "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }));
    const v2 = () => rebuildSchedulerProjection(store.readRun(RUN));
  const snapshotRecord = {
    stopSequence: 10,
    stopKind: "completed",
    revision: "rev-1",
    commit: "c1",
    parent: "p",
    head: "h1",
    bodyDigest: "d".repeat(64),
    paths: ["docs/project/STATE.md"],
    sequence: 11,
    // C2b: the full AR-R05 gate needs the commit-tree proof for the entries.
    previousSnapshotEdited: false,
    agentsSectionCommitted: true,
    claudeLineCommitted: true,
  };
  // C2b repair N-7: the gate binds to a requested stop, so every
  // snapshot-bearing fixture below carries the matching request (stop 10).
  const withStop10Request = (projection: ReturnType<typeof v2>): ReturnType<typeof v2> => {
    projection.projectHandoff = {
      status: "requested",
      summary: "ready",
      requestedSequence: 10,
      options: ["keep_integration_branch", "apply_to_project"],
    };
    return projection;
  };
  assert.throws(() => assertHandoffSnapshotGate(v2(), "rev-1"), /kernel handoff snapshot/);
  const covered = withStop10Request(v2());
  covered.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord }] };
  assertHandoffSnapshotGate(covered, "rev-1");
  assertHandoffSnapshotGate(covered, "c1");
  assertHandoffSnapshotGate(covered, "h1");
  assert.throws(() => assertHandoffSnapshotGate(covered, "rev-2"), /kernel handoff snapshot/);
  // M1: the gate binds to the latest request stop, never an earlier snapshot.
  const requested = v2();
  requested.projectHandoff = {
    status: "requested",
    summary: "ready",
    requestedSequence: 10,
    options: ["keep_integration_branch", "apply_to_project"],
  };
  requested.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 9 }] };
  assert.throws(() => assertHandoffSnapshotGate(requested, "rev-1"), /kernel handoff snapshot/);
  requested.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 10 }] };
  assertHandoffSnapshotGate(requested, "rev-1");
  const requestedPlanOnly = v2();
  requestedPlanOnly.runPolicy = "plan_only";
  requestedPlanOnly.projectHandoff = {
    status: "requested",
    summary: "ready",
    requestedSequence: 10,
    options: ["keep_integration_branch", "apply_to_project"],
  };
  requestedPlanOnly.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 9 }] };
  assert.throws(() => assertHandoffSnapshotGate(requestedPlanOnly, undefined), /kernel handoff snapshot/);
  requestedPlanOnly.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, stopSequence: 10 }] };
  assertHandoffSnapshotGate(requestedPlanOnly, undefined);
  const noState = withStop10Request(v2());
  noState.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, paths: ["docs/project/AGENTS.md"] }] };
  assert.throws(() => assertHandoffSnapshotGate(noState, "rev-1"), /kernel handoff snapshot/);
  // C2c repair CD-17: a recorded STATE.md link reason satisfies STATE.md
  // the way export_only satisfies the whole gate.
  const linkedState = withStop10Request(v2());
  linkedState.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, paths: ["AGENTS.md", "CLAUDE.md"], bodyDigest: "", stateSkippedReason: "docs/project/STATE.md is not written: docs/project is a symbolic link or junction; the handoff proceeds without it." }] };
  assertHandoffSnapshotGate(linkedState, "rev-1");
  // C2b (AR-R05): the gate refuses when the committed tree lacks the v2
  // AGENTS.md section or the marked CLAUDE.md line.
  const noAgents = withStop10Request(v2());
  noAgents.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, agentsSectionCommitted: false }] };
  assert.throws(() => assertHandoffSnapshotGate(noAgents, "rev-1"), /kernel handoff snapshot/);
  const noClaude = withStop10Request(v2());
  noClaude.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord, claudeLineCommitted: false }] };
  assert.throws(() => assertHandoffSnapshotGate(noClaude, "rev-1"), /kernel handoff snapshot/);
  // C2b (CD-5): export_only satisfies the gate by the recorded run option,
  // with no snapshot at all.
  const exportOnly = v2();
  exportOnly.handoffFiles = "export_only";
  assertHandoffSnapshotGate(exportOnly, "rev-1");
  assert.equal(handoffSnapshotCoversRevision(covered, "rev-1"), true);
  assert.equal(handoffSnapshotCoversRevision(covered, "rev-2"), false);
  const planOnly = withStop10Request(v2());
  planOnly.runPolicy = "plan_only";
  assert.throws(() => assertHandoffSnapshotGate(planOnly, undefined), /kernel handoff snapshot/);
  planOnly.projectDocs = { pending: [], snapshots: [{ ...snapshotRecord }] };
  assertHandoffSnapshotGate(planOnly, undefined);
  const v1 = v2();
  v1.projectDocsPolicyVersion = 1;
  assertHandoffSnapshotGate(v1, "rev-1");
  const answered = v2();
  answered.planningPolicyVersion = 1;
  answered.planningTriageDecision = "answer";
  assertHandoffSnapshotGate(answered, "rev-1");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2b CD-14: the reducer does not pair docs v2 with planning v1; run options parse", () => {
  const RUN = "run-c2b-m9";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b m9 "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }));
    // CD-14 (review probe I): a docs-v2 stamp without planning policy v1
    // is accepted -- the reducer does not enforce the pairing; T7a owns
    // production stamping and stamps both together at creation.
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    assert.equal(rebuildSchedulerProjection(store.readRun(RUN)).projectDocsPolicyVersion, 2);
    // Invalid run options are refused.
    assert.throws(
      () => store.append(e("run.policy_configured", "policy-bad", "runner", "build-runtime", { runPolicy: "finish", handoffFiles: "bogus" })),
      /handoffFiles/,
    );
    assert.throws(
      () => store.append(e("run.policy_configured", "policy-bad2", "runner", "build-runtime", { runPolicy: "finish", specCopy: "yes" })),
      /specCopy/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
  // Legacy-planning runs keep docs v1.
  const legacyRoot = mkdtempSync(join(tmpdir(), "aiboard c2b legacy "));
  const legacy = new SqliteSchedulerStore(join(legacyRoot, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    legacy.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }));
    legacy.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 1 }));
    assert.equal(rebuildSchedulerProjection(legacy.readRun(RUN)).projectDocsPolicyVersion, 1);
  } finally {
    legacy.close();
    rmSync(legacyRoot, { recursive: true, force: true });
  }
  // The creation-first docs-v2 stamp (sequence 1, the seed path) stays valid.
  const seedRoot = mkdtempSync(join(tmpdir(), "aiboard c2b seedfirst "));
  const seeded = new SqliteSchedulerStore(join(seedRoot, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    seeded.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    assert.equal(rebuildSchedulerProjection(seeded.readRun(RUN)).projectDocsPolicyVersion, 2);
  } finally {
    seeded.close();
    rmSync(seedRoot, { recursive: true, force: true });
  }
  // The spec parser accepts the new options and refuses invalid ones.
  const spec = managerSpec(RUN, "plan_only");
  validateBuildSpec({ ...spec, handoffFiles: "export_only", specCopy: false });
  validateBuildSpec(spec);
  assert.throws(() => validateBuildSpec({ ...spec, handoffFiles: "bogus" as "commit" }), /handoffFiles/);
  assert.throws(() => validateBuildSpec({ ...spec, specCopy: "yes" as unknown as boolean }), /specCopy/);
  // The spec-copy file stem never escapes its directory.
  assert.equal(sanitizeSpecSourceId("source_value"), "source_value");
  assert.equal(sanitizeSpecSourceId("a/b"), "a_b");
  assert.equal(sanitizeSpecSourceId(""), undefined);
  // C2b repair m4: Windows reserved stems fall back to a digest name, and
  // long stems are capped -- the copy never fails the snapshot commit.
  const reservedDigest = "b".repeat(64);
  assert.equal(sanitizeSpecSourceId("NUL", reservedDigest), `spec-${"b".repeat(16)}`);
  assert.equal(sanitizeSpecSourceId("NUL"), undefined);
  assert.equal(sanitizeSpecSourceId("CON.txt", reservedDigest), `spec-${"b".repeat(16)}`);
  assert.equal(sanitizeSpecSourceId("com1"), undefined);
  assert.equal(sanitizeSpecSourceId("aux.md", reservedDigest), `spec-${"b".repeat(16)}`);
  assert.equal(sanitizeSpecSourceId("x".repeat(300), reservedDigest), "x".repeat(100));
});

test("C2b: run options are recorded in run.policy_configured with durable defaults", () => {
  const throwingPort: ProjectDocsPort = {
    commit: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    commitHandoffSnapshot: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    readHandoffSnapshotFile: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    readIntegrationTipFile: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    findTrackedFileWithDigest: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    findHandoffSnapshotCommit: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    readIntegrationBaselineRevision: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    canStageSpecPath: async () => {
      throw new Error("the recording test never touches the docs port");
    },
    relateRevision: async () => "strict_descendant" as const,
  };
  const RUN = "run-c2b-options";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b options "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    buildRuntimeForHandoff({
      runId: RUN, store, projectDocs: throwingPort,
      architect: silentArchitect(), clock: advancingClock(), runPolicy: "plan_only",
      specCopy: false, handoffFiles: "export_only",
    });
    const policy = store.readRun(RUN).find((event) => event.type === "run.policy_configured")!;
    assert.equal((policy.payload as Record<string, unknown>).specCopy, false);
    assert.equal((policy.payload as Record<string, unknown>).handoffFiles, "export_only");
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(specCopyOf(projection), false);
    assert.equal(handoffFilesOf(projection), "export_only");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
  const defaultRoot = mkdtempSync(join(tmpdir(), "aiboard c2b defaults "));
  const defaults = new SqliteSchedulerStore(join(defaultRoot, "scheduler.sqlite"));
  try {
    buildRuntimeForHandoff({
      runId: RUN, store: defaults, projectDocs: throwingPort,
      architect: silentArchitect(), clock: advancingClock(), runPolicy: "plan_only",
    });
    const policy = defaults.readRun(RUN).find((event) => event.type === "run.policy_configured")!;
    assert.equal((policy.payload as Record<string, unknown>).specCopy, true);
    assert.equal((policy.payload as Record<string, unknown>).handoffFiles, "commit");
  } finally {
    defaults.close();
    rmSync(defaultRoot, { recursive: true, force: true });
  }
});

test("C2b repair m6: the shared selection predicate refuses an unresolved context note", () => {
  const RUN = "run-c2b-m6-note";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b m6note "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    store.append(e("project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    store.append(e("context_manifest.recording_failed", "note-m6", "runner", "build-runtime", {
      purpose: "worker:task",
      attempts: 3,
      reason: "disk full",
      taskId: "task_a",
      attempt: 1,
      revision: "rev-1",
    }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    // The shared rule refuses first: without the m6 move the predicate falls
    // through to the revision mismatch instead.
    assert.throws(
      () => assertProjectHandoffSelectionAccepted(projection, "a".repeat(40)),
      /Context recording failure must be resolved before completion or handoff/,
    );
    // The reducer case refuses with the same whole rule.
    assert.throws(
      () => store.append(e("project.handoff_selected", "handoff-select-m6", "user", "local-user", {
        choice: "keep_integration_branch",
        integrationRevision: "a".repeat(40),
        integrationBranch: "aiboard/run/integration",
        appliedToProject: false,
      })),
      /Context recording failure must be resolved before completion or handoff/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2b repair m6: the shared selection predicate refuses an acceptance-contract upgrade", () => {
  const RUN = "run-c2b-m6-upgrade";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b m6upgrade "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    // Legacy planning: a plan revision but no planning policy v1. The task
    // carries no acceptance criteria, so the upgrade gate is required.
    store.append(e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }));
    store.append(e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }));
    store.append(e("plan.created", "plan", "architect", "architect", {
      revision: 1,
      tasks: [{
        id: "task_raw_legacy",
        objective: "Recover a raw pre-P1 task.",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        attempt: 1,
      }],
    }));
    store.append(e("acceptance_contract.upgrade_required", "upgrade-gate", "runner", "build-runtime", {
      taskIds: ["task_raw_legacy"],
    }));
    store.append(e("project.handoff_requested", "handoff-requested", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const projection = rebuildSchedulerProjection(store.readRun(RUN));
    assert.equal(projection.projectHandoff?.status, "requested");
    // The shared rule refuses first: without the m6 move the predicate falls
    // through to the revision mismatch instead.
    assert.throws(
      () => assertProjectHandoffSelectionAccepted(projection, "a".repeat(40)),
      /upgrades acceptance criteria/,
    );
    // The reducer case refuses with the same whole rule.
    assert.throws(
      () => store.append(e("project.handoff_selected", "handoff-select-m6", "user", "local-user", {
        choice: "keep_integration_branch",
        integrationRevision: "a".repeat(40),
        integrationBranch: "aiboard/run/integration",
        appliedToProject: false,
      })),
      /upgrades acceptance criteria/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2b repair B1-R/P1: the factory-built docs port wires both reconciliation methods", async () => {
  const RUN = "run-c2b-p1";
  const fixture = await openFactoryPort("p1", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    // Probe P1: the runtime that NativeBuildFactory.create builds must
    // carry every required method on its docs port -- not just the six
    // cycle-0 keys. C2c adds the pre-render spec stageability check.
    for (const key of ["commit", "commitHandoffSnapshot", "findHandoffSnapshotCommit", "readHandoffSnapshotFile", "readIntegrationBaselineRevision", "readIntegrationTipFile", "findTrackedFileWithDigest", "relateRevision", "canStageSpecPath"]) {
      assert.equal(typeof (fixture.port as unknown as Record<string, unknown>)[key], "function", `the factory port wires ${key}`);
    }
    const baseline = await fixture.port.readIntegrationBaselineRevision();
    assert.equal(baseline.revision, fixture.baselineRevision);
    assert.equal(await fixture.port.findHandoffSnapshotCommit({ snapshotKey: "handoff-snapshot:1" }), null);
    assert.equal((await fixture.port.canStageSpecPath({ path: "docs/project/specs/source_value.md", content: "preview\n" })).stageable, true);
  } finally {
    await fixture.close();
  }
});

test("C2b repair N-3/probe R: the reducer refuses a snapshot record for a sequence that is no stop", () => {
  const RUN = "run-c2b-r";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2b r "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(RUN, type, key, role, id, payload);
    for (const input of v2PlanOnlySeed(RUN)) store.append(input);
    store.append(e("project.handoff_requested", "handoff-1", "architect", "architect", { summary: COMPLETION_SUMMARY }));
    const stop = store.readRun(RUN).find((event) => event.type === "project.handoff_requested")!;
    // A record for a sequence that is neither the requested stop nor a
    // withdrawn stop's requestedSequence: the reducer refuses it, and the
    // tip never moves to it.
    assert.throws(
      () => store.append(e("project_docs.handoff_snapshot_committed", "handoff-snapshot:bogus", "runner", "build-runtime", {
        stopSequence: stop.sequence + 100,
        stopKind: "plan_only",
        revision: "revision_value",
        commit: "b".repeat(40),
        parent: "p".repeat(40),
        head: "b".repeat(40),
        bodyDigest: "d".repeat(64),
        paths: ["docs/project/STATE.md"],
        previousSnapshotEdited: false,
        agentsSectionCommitted: true,
        claudeLineCommitted: true,
      })),
      /Handoff snapshots require a requested project handoff\./,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
