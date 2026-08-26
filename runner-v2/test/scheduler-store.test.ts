import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  acceptanceContractAuditProjection,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { readyTaskIds } from "../src/task-graph.js";
import type { BuildTask } from "../src/task-contracts.js";

test("Finish and Budgeted reject forged plan-only handoff payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-policy-forgery-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    for (const runPolicy of ["finish", "budgeted"] as const) {
      const runId = `run_${runPolicy}`;
      store.append(policyEvent(runId, runPolicy));
      store.append(event(runId, "plan.created", "plan:1", {
        revision: 1,
        tasks: [{
          id: "task_1",
          objective: "Plan work",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        }],
      }));
      assert.throws(() => store.append({
        runId,
        type: "project.handoff_requested",
        occurredAt: "2026-07-13T00:00:00.000Z",
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "project-handoff-requested",
        payload: {
          summary: "Forged plan-only handoff",
          runPolicy: "plan_only",
        },
      }), /requires terminal task states/i);
      assert.equal(
        rebuildSchedulerProjection(store.readRun(runId)).projectHandoff,
        undefined
      );
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable plan-only policy requires a plan and survives handoff replay", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-plan-policy-"));
  const database = join(root, "scheduler.sqlite");
  let store = new SqliteSchedulerStore(database);
  try {
    store.append(policyEvent("run_plan_only", "plan_only"));
    assert.throws(() => store.append({
      runId: "run_plan_only",
      type: "project.handoff_requested",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "handoff:before-plan",
      payload: { summary: "No plan exists" },
    }), /requires a valid plan/i);
    store.append(event("run_plan_only", "plan.created", "plan:1", {
      revision: 1,
      tasks: [{
        id: "task_1",
        objective: "Plan work",
        dependencies: [],
        status: "planned",
        requiredCapabilities: [],
        attempt: 0,
      }],
    }));
    store.append({
      runId: "run_plan_only",
      type: "project.handoff_requested",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "project-handoff-requested",
      payload: { summary: "Plan is ready" },
    });
    store.close();

    store = new SqliteSchedulerStore(database);
    const recovered = rebuildSchedulerProjection(store.readRun("run_plan_only"));
    assert.equal(recovered.runPolicy, "plan_only");
    assert.equal(recovered.planRevision, 1);
    assert.equal(recovered.tasks.task_1.status, "planned");
    assert.equal(recovered.projectHandoff?.status, "requested");
    store.append({
      runId: "run_plan_only",
      type: "project.handoff_selected",
      occurredAt: "2026-07-13T00:01:00.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "project-handoff-selected",
      payload: {
        choice: "apply_to_project",
        integrationRevision: "integration_revision",
        integrationBranch: "aiboard/run/integration",
        appliedToProject: true,
        projectRevision: "project_revision",
      },
    });
    store.close();

    store = new SqliteSchedulerStore(database);
    const settled = rebuildSchedulerProjection(store.readRun("run_plan_only"));
    assert.equal(settled.status, "completed");
    assert.equal(settled.projectHandoff?.projectRevision, "project_revision");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduler events recover exact task and blocking-guidance state", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-store-"));
  const database = join(root, "scheduler.sqlite");
  try {
    const first = new SqliteSchedulerStore(database);
    const plan = first.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [
        {
          id: "task_1",
          objective: "Implement feature",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        },
      ],
    }));
    const duplicate = first.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [
        {
          id: "task_1",
          objective: "Implement feature",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        },
      ],
    }));
    assert.equal(duplicate.eventId, plan.eventId);
    first.append(event("run_1", "task.transitioned", "assign:1", {
      taskId: "task_1",
      status: "assigned",
      patch: { assignedWorkerId: "worker_1" },
    }));
    first.append(event("run_1", "task.transitioned", "run:1", {
      taskId: "task_1",
      status: "running",
      patch: { workspacePath: "C:/workspace/task_1" },
    }));
    first.append(event("run_1", "guidance.requested", "guidance:1", {
      requestId: "guidance_1",
      taskId: "task_1",
      blocking: true,
      question: "Which API?",
      evidenceSequence: 4,
    }));
    first.close();

    const recovered = new SqliteSchedulerStore(database);
    const projection = rebuildSchedulerProjection(recovered.readRun("run_1"));
    assert.equal(projection.tasks.task_1.status, "waiting_guidance");
    assert.equal(projection.tasks.task_1.guidanceRequestId, "guidance_1");
    assert.equal(projection.guidance.guidance_1.status, "open");
    assert.equal(projection.lastSequence, 4);
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw pre-P1 scheduler WAL fixtures preserve ordering and one legacy gate across reopens", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-pre-p1-wal-"));
  const database = join(root, "scheduler.sqlite");
  const wal = `${database}-wal`;
  const runId = "run_raw_pre_p1";
  const raw = new DatabaseSync(database);
  let store: SqliteSchedulerStore | undefined;
  try {
    raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE scheduler_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(run_id, sequence),
        UNIQUE(run_id, idempotency_key)
      );
      CREATE INDEX idx_scheduler_events
      ON scheduler_events(run_id, sequence);
    `);
    const insert = raw.prepare(`
      INSERT INTO scheduler_events (
        event_id, run_id, sequence, event_type, occurred_at,
        actor_json, idempotency_key, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "legacy_event_1",
      runId,
      1,
      "run.policy_configured",
      "2026-07-12T00:00:00.000Z",
      JSON.stringify({ role: "runner", id: "legacy-runner" }),
      "run-policy-configured",
      JSON.stringify({ runPolicy: "finish" }),
    );
    insert.run(
      "legacy_event_2",
      runId,
      2,
      "plan.created",
      "2026-07-12T00:00:01.000Z",
      JSON.stringify({ role: "architect", id: "legacy-architect" }),
      "plan:1",
      JSON.stringify({
        revision: 1,
        tasks: [{
          id: "task_raw_legacy",
          objective: "Recover a raw pre-P1 task",
          dependencies: [],
          status: "planned",
          requiredCapabilities: ["code"],
          attempt: 0,
        }],
      }),
    );
    assert.equal(existsSync(wal), true, "raw fixture must retain its WAL sidecar");

    store = new SqliteSchedulerStore(database);
    assert.deepEqual(
      store.readRun(runId).map((event) => [event.sequence, event.eventId, event.type]),
      [
        [1, "legacy_event_1", "run.policy_configured"],
        [2, "legacy_event_2", "plan.created"],
      ],
    );
    assert.equal(
      rebuildSchedulerProjection(store.readRun(runId)).acceptanceContractStatus,
      "acceptance_contract_upgrade_required",
    );

    const gate: NewSchedulerEvent = {
      runId,
      type: "acceptance_contract.upgrade_required",
      occurredAt: "2026-07-12T00:00:02.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "acceptance-contract-upgrade-required",
      payload: { taskIds: ["task_raw_legacy"] },
    };
    const firstGate = store.append(gate);
    assert.equal(firstGate.sequence, 3);
    assert.throws(
      () => store!.append({ ...gate, idempotencyKey: "acceptance-contract-upgrade-required-duplicate" }),
      /already recorded|upgrade gate/i,
    );
    assert.equal(
      store.readRun(runId).filter((event) => event.type === "acceptance_contract.upgrade_required").length,
      1,
    );
    assert.equal(existsSync(wal), true, "WAL sidecar must remain present through current-store append");

    const beforeReopen = store.readRun(runId);
    store.close();
    store = undefined;
    assert.equal(existsSync(wal), true, "raw connection must keep the WAL sidecar for reopen");

    store = new SqliteSchedulerStore(database);
    assert.deepEqual(store.readRun(runId), beforeReopen);
    store.close();
    store = undefined;

    store = new SqliteSchedulerStore(database);
    const secondReopen = store.readRun(runId);
    assert.deepEqual(secondReopen, beforeReopen);
    assert.equal(
      secondReopen.filter((event) => event.type === "acceptance_contract.upgrade_required").length,
      1,
    );
  } finally {
    store?.close();
    raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy active runs require exactly one acceptance-contract upgrade before submission", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-acceptance-upgrade-"));
  const database = join(root, "scheduler.sqlite");
  let store = new SqliteSchedulerStore(database);
  try {
    store.append(event("run_legacy_upgrade", "plan.created", "plan:1", {
      revision: 1,
      tasks: [{
        id: "task_legacy",
        objective: "Preserve an old task",
        dependencies: [],
        status: "planned",
        requiredCapabilities: ["code"],
        attempt: 0,
      }],
    }));
    assert.equal(
      rebuildSchedulerProjection(store.readRun("run_legacy_upgrade")).acceptanceContractStatus,
      "acceptance_contract_upgrade_required"
    );
    store.append({
      runId: "run_legacy_upgrade",
      type: "acceptance_contract.upgrade_required" as NewSchedulerEvent["type"],
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "acceptance-contract-upgrade-required",
      payload: { taskIds: ["task_legacy"] },
    });
    const duplicate = store.append({
      runId: "run_legacy_upgrade",
      type: "acceptance_contract.upgrade_required" as NewSchedulerEvent["type"],
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "acceptance-contract-upgrade-required",
      payload: { taskIds: ["task_legacy"] },
    });
    assert.equal(duplicate.sequence, 2);
    assert.throws(
      () => store.append({
        runId: "run_legacy_upgrade",
        type: "acceptance_contract.upgrade_required" as NewSchedulerEvent["type"],
        occurredAt: "2026-07-13T00:00:00.000Z",
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "acceptance-contract-upgrade-required-duplicate",
        payload: { taskIds: ["task_legacy"] },
      }),
      /already recorded|upgrade gate/i
    );
    assert.equal(store.readRun("run_legacy_upgrade").length, 2);
    store.append(event("run_legacy_upgrade", "task.transitioned", "assign:1", {
      taskId: "task_legacy",
      status: "assigned",
      patch: { attempt: 1 },
    }));
    store.append(event("run_legacy_upgrade", "task.transitioned", "run:1", {
      taskId: "task_legacy",
      status: "running",
      patch: {},
    }));
    assert.throws(
      () => store.append(event("run_legacy_upgrade", "task.transitioned", "submit:1", {
        taskId: "task_legacy",
        status: "submitted",
        patch: { changeSetId: "changeset_legacy" },
      })),
      /acceptance_contract_upgrade_required|upgrade/i
    );

    assert.throws(
      () => store.append({
        runId: "run_legacy_upgrade",
        type: "acceptance_contract.upgraded" as NewSchedulerEvent["type"],
        occurredAt: "2026-07-13T00:00:00.000Z",
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "acceptance-contract-upgraded",
        payload: {
          revision: 2,
          criteriaByTask: [{ taskId: "task_legacy", acceptanceCriteria: [] }],
        },
      }),
      /criterion|invalid|upgrade/i
    );
    assert.equal(store.readRun("run_legacy_upgrade").length, 4);

    store.close();
    store = new SqliteSchedulerStore(database);
    store.append({
      runId: "run_legacy_upgrade",
      type: "acceptance_contract.upgraded" as NewSchedulerEvent["type"],
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "acceptance-contract-upgraded",
      payload: {
        revision: 2,
        criteriaByTask: [{
          taskId: "task_legacy",
          acceptanceCriteria: [{ id: "behavior", text: "The behavior is implemented." }],
        }],
      },
    });
    const upgraded = rebuildSchedulerProjection(store.readRun("run_legacy_upgrade"));
    assert.equal(upgraded.acceptanceContractStatus, "current");
    assert.deepEqual(upgraded.tasks.task_legacy.acceptanceCriteria, [
      { id: "behavior", text: "The behavior is implemented." },
    ]);
    assert.equal(upgraded.tasks.task_legacy.acceptanceCriteriaVersion, 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed legacy scheduler runs remain replayable and inspectable", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-legacy-completed-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(event("run_legacy_completed", "plan.created", "plan:1", {
      revision: 1,
      tasks: [task("task_done", "integrated", [])],
    }));
    store.append({
      runId: "run_legacy_completed",
      type: "run.completed",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "run-completed",
      payload: {},
    });
    const projection = rebuildSchedulerProjection(store.readRun("run_legacy_completed"));
    assert.equal(projection.status, "completed");
    assert.equal(projection.acceptanceContractStatus, "legacy_completed");
    assert.equal(projection.tasks.task_done.objective, "Objective task_done");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("gated active legacy runs reject raw completion and handoff selection until upgrade", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-legacy-gate-boundary-"));
  const database = join(root, "scheduler.sqlite");
  const legacyTask = task("task_gate", "planned", []);
  const store = new SqliteSchedulerStore(database);
  try {
    store.append(policyEvent("run_gate_completion", "finish"));
    store.append(event("run_gate_completion", "plan.created", "plan:1", {
      revision: 1,
      tasks: [legacyTask],
    }));
    store.append({
      runId: "run_gate_completion",
      type: "acceptance_contract.upgrade_required",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "acceptance-contract-upgrade-required",
      payload: { taskIds: [legacyTask.id] },
    });
    assert.throws(
      () => store.append({
        runId: "run_gate_completion",
        type: "run.completed",
        occurredAt: "2026-07-13T00:00:00.000Z",
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "run-completed-before-upgrade",
        payload: {},
      }),
      /upgrade|required|legacy/i,
    );
    assert.equal(store.readRun("run_gate_completion").length, 3);
    store.append({
      runId: "run_gate_completion",
      type: "acceptance_contract.upgraded",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "acceptance-contract-upgraded",
      payload: {
        revision: 2,
        criteriaByTask: [{
          taskId: legacyTask.id,
          acceptanceCriteria: [{ id: "behavior", text: "The behavior is implemented." }],
        }],
      },
    });
    store.append({
      runId: "run_gate_completion",
      type: "run.completed",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "run-completed-after-upgrade",
      payload: {},
    });
    const completed = rebuildSchedulerProjection(store.readRun("run_gate_completion"));
    assert.equal(completed.status, "completed");
    assert.equal(completed.acceptanceContractStatus, "current");

    store.append(policyEvent("run_gate_handoff", "plan_only"));
    store.append(event("run_gate_handoff", "plan.created", "plan:1", {
      revision: 1,
      tasks: [task("task_handoff_gate", "planned", [])],
    }));
    store.append({
      runId: "run_gate_handoff",
      type: "acceptance_contract.upgrade_required",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "acceptance-contract-upgrade-required",
      payload: { taskIds: ["task_handoff_gate"] },
    });
    store.append({
      runId: "run_gate_handoff",
      type: "project.handoff_requested",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "project-handoff-requested",
      payload: { summary: "Legacy handoff waits for upgrade." },
    });
    assert.throws(
      () => store.append({
        runId: "run_gate_handoff",
        type: "project.handoff_selected",
        occurredAt: "2026-07-13T00:00:00.000Z",
        actor: { role: "user", id: "local-user" },
        idempotencyKey: "project-handoff-selected-before-upgrade",
        payload: {
          choice: "keep_integration_branch",
          integrationRevision: "integration_revision",
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        },
      }),
      /upgrade|required|legacy/i,
    );
    assert.equal(
      rebuildSchedulerProjection(store.readRun("run_gate_handoff")).projectHandoff?.status,
      "requested",
    );
    store.append({
      runId: "run_gate_handoff",
      type: "acceptance_contract.upgraded",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "acceptance-contract-upgraded",
      payload: {
        revision: 2,
        criteriaByTask: [{
          taskId: "task_handoff_gate",
          acceptanceCriteria: [{ id: "behavior", text: "The behavior is implemented." }],
        }],
      },
    });
    store.append({
      runId: "run_gate_handoff",
      type: "project.handoff_selected",
      occurredAt: "2026-07-13T00:00:00.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "project-handoff-selected-after-upgrade",
      payload: {
        choice: "keep_integration_branch",
        integrationRevision: "integration_revision",
        integrationBranch: "aiboard/run/integration",
        appliedToProject: false,
      },
    });
    const handedOff = rebuildSchedulerProjection(store.readRun("run_gate_handoff"));
    assert.equal(handedOff.status, "completed");
    assert.equal(handedOff.acceptanceContractStatus, "current");
    assert.equal(handedOff.projectHandoff?.status, "selected");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable submission rejects fabricated evidence IDs and hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-evidence-boundary-"));
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  try {
    store.append(event("run_evidence_boundary", "plan.created", "plan:1", {
      revision: 1,
      tasks: [{
        id: "task_evidence",
        objective: "Bind evidence",
        dependencies: [],
        status: "planned",
        requiredCapabilities: [],
        attempt: 0,
        acceptanceCriteria: [{ id: "behavior", text: "Evidence belongs to this worker." }],
        acceptanceCriteriaVersion: 1,
      }],
    }));
    store.append(event("run_evidence_boundary", "task.transitioned", "assign:1", {
      taskId: "task_evidence",
      status: "assigned",
      patch: { attempt: 1, assignedWorkerId: "worker_task_evidence_1" },
    }));
    store.append(event("run_evidence_boundary", "task.transitioned", "running:1", {
      taskId: "task_evidence",
      status: "running",
      patch: {},
    }));
    assert.throws(
      () => store.append(event("run_evidence_boundary", "task.transitioned", "submit:1", {
        taskId: "task_evidence",
        status: "submitted",
        patch: {
          changeSetId: "changeset_fabricated",
          criterionEvidenceLinks: [{
            criterionId: "behavior",
            evidenceId: "evidence_does_not_exist",
            artifactHashes: ["f".repeat(64)],
            taskId: "task_evidence",
            attempt: 1,
          }],
        },
      })),
      /evidence.*(missing|not found|unknown)|artifact/i,
    );
    assert.equal(rebuildSchedulerProjection(store.readRun("run_evidence_boundary")).tasks.task_evidence.status, "running");
  } finally {
    store.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry clears the current acceptance projection while replay preserving versioned history", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-retry-projection-"));
  const database = join(root, "scheduler.sqlite");
  let store = new SqliteSchedulerStore(database);
  const oldLink = {
    criterionId: "behavior",
    evidenceId: "evidence_attempt_1",
    artifactHashes: ["a".repeat(64)],
    taskId: "task_retry",
    attempt: 1,
  };
  try {
    store.append(event("run_retry_projection", "plan.created", "plan:1", {
      revision: 1,
      tasks: [{
        id: "task_retry",
        objective: "Retry projection",
        dependencies: [],
        status: "planned",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "behavior", text: "The behavior works." }],
        acceptanceCriteriaVersion: 1,
        attempt: 0,
      }],
    }));
    store.append(event("run_retry_projection", "task.transitioned", "assign:1", {
      taskId: "task_retry",
      status: "assigned",
      patch: { attempt: 1, assignedWorkerId: "worker_1" },
    }));
    store.append(event("run_retry_projection", "task.transitioned", "running:1", {
      taskId: "task_retry",
      status: "running",
      patch: {},
    }));
    store.append(event("run_retry_projection", "task.transitioned", "submit:1", {
      taskId: "task_retry",
      status: "submitted",
      patch: {
        changeSetId: "changeset_attempt_1",
        criterionEvidenceLinks: [oldLink],
      },
    }));
    store.append({
      runId: "run_retry_projection",
      type: "review.decided",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "review:1",
      payload: {
        taskId: "task_retry",
        decision: "rejected",
        summary: "Attempt one is incomplete.",
        evidenceArtifactHashes: ["a".repeat(64)],
        criterionVerdicts: [{
          criterionId: "behavior",
          verdict: "unsatisfied",
          rationale: "Attempt one is incomplete.",
          evidenceIds: ["evidence_attempt_1"],
          artifactHashes: ["a".repeat(64)],
        }],
      },
    });
    store.append(event("run_retry_projection", "task.transitioned", "retry:1", {
      taskId: "task_retry",
      status: "planned",
      patch: {},
    }));

    const beforeRestart = rebuildSchedulerProjection(store.readRun("run_retry_projection"));
    assert.equal(beforeRestart.tasks.task_retry.status, "planned");
    assert.equal(beforeRestart.tasks.task_retry.criterionEvidenceLinks, undefined);
    assert.equal(beforeRestart.tasks.task_retry.changeSetId, undefined);
    assert.equal(beforeRestart.reviews.task_retry, undefined);
    assert.deepEqual(beforeRestart.submissionHistory?.task_retry, [{
      taskId: "task_retry",
      attempt: 1,
      acceptanceCriteriaVersion: 1,
      changeSetId: "changeset_attempt_1",
      criterionEvidenceLinks: [oldLink],
    }]);
    assert.deepEqual(beforeRestart.reviewHistory?.task_retry, [{
      taskId: "task_retry",
      attempt: 1,
      acceptanceCriteriaVersion: 1,
      status: "rejected",
      summary: "Attempt one is incomplete.",
      evidenceArtifactHashes: ["a".repeat(64)],
      criterionEvidenceLinks: [oldLink],
      criterionVerdicts: [{
        criterionId: "behavior",
        verdict: "unsatisfied",
        rationale: "Attempt one is incomplete.",
        evidenceIds: ["evidence_attempt_1"],
        artifactHashes: ["a".repeat(64)],
      }],
    }]);
    const audit = acceptanceContractAuditProjection(beforeRestart);
    assert.deepEqual(audit.tasks.task_retry.criterionEvidenceLinks, []);
    assert.deepEqual(audit.tasks.task_retry.criterionVerdicts, []);
    assert.equal(audit.tasks.task_retry.reviewStatus, undefined);
    assert.equal(audit.tasks.task_retry.submissionHistory[0].attempt, 1);
    assert.equal(audit.tasks.task_retry.reviewHistory[0].acceptanceCriteriaVersion, 1);

    store.close();
    store = new SqliteSchedulerStore(database);
    const recovered = rebuildSchedulerProjection(store.readRun("run_retry_projection"));
    assert.deepEqual(recovered.tasks.task_retry, beforeRestart.tasks.task_retry);
    assert.deepEqual(recovered.reviews, beforeRestart.reviews);
    assert.deepEqual(recovered.submissionHistory, beforeRestart.submissionHistory);
    assert.deepEqual(recovered.reviewHistory, beforeRestart.reviewHistory);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt scheduler payload identifies the event", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-corrupt-"));
  const database = join(root, "scheduler.sqlite");
  const store = new SqliteSchedulerStore(database);
  try {
    const appended = store.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [],
    }));
    const raw = new DatabaseSync(database);
    raw
      .prepare("UPDATE scheduler_events SET payload_json = ? WHERE event_id = ?")
      .run("{", appended.eventId);
    raw.close();
    assert.throws(() => store.readRun("run_1"), new RegExp(appended.eventId));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime assignments, provider cooldown, and Architect handoff recover durably", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-runtime-"));
  const database = join(root, "scheduler.sqlite");
  try {
    let store = new SqliteSchedulerStore(database);
    store.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [{
        id: "task_1",
        objective: "Implement feature",
        dependencies: [],
        status: "planned",
        requiredCapabilities: ["code"],
        attempt: 0,
      }],
    }));
    store.append(event("run_1", "task.transitioned", "assign:1", {
      taskId: "task_1",
      status: "assigned",
      patch: { attempt: 1, assignedWorkerId: "worker_1" },
    }));
    store.append(event("run_1", "task.transitioned", "running:1", {
      taskId: "task_1",
      status: "running",
    }));
    store.append({
      runId: "run_1",
      type: "worker.runtime_assigned",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "runtime:task_1:1:openai",
      payload: {
        taskId: "task_1",
        attempt: 1,
        runtimeId: "openai:code",
        sessionId: "worker:task_1:1",
      },
    });
    store.append({
      runId: "run_1",
      type: "provider.health_changed",
      occurredAt: "2026-07-12T00:00:01.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "health:openai:1",
      payload: {
        state: {
          providerId: "openai",
          status: "cooldown",
          consecutiveFailures: 1,
          updatedAt: 1_000,
          failureKind: "usage_limit",
          failureMessage: "limit",
          cooldownUntil: 61_000,
        },
      },
    });
    store.append({
      runId: "run_1",
      type: "architect.handoff_required",
      occurredAt: "2026-07-12T00:00:02.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "architect-handoff:1",
      payload: {
        reason: "provider unavailable",
        requiredCapabilities: ["code"],
        candidateRuntimeIds: ["anthropic:code"],
      },
    });
    assert.equal(rebuildSchedulerProjection(store.readRun("run_1")).status, "paused");
    store.close();

    store = new SqliteSchedulerStore(database);
    store.append({
      runId: "run_1",
      type: "architect.handoff_selected",
      occurredAt: "2026-07-12T00:00:03.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "architect-handoff:selected:1",
      payload: { runtimeId: "anthropic:code" },
    });
    const recovered = rebuildSchedulerProjection(store.readRun("run_1"));
    assert.equal(recovered.status, "running");
    assert.equal(recovered.runtime.workerAssignments["task_1:1"].runtimeId, "openai:code");
    assert.equal(recovered.runtime.providerHealth.openai.status, "cooldown");
    assert.equal(recovered.runtime.architect.runtimeId, "anthropic:code");
    assert.equal(recovered.runtime.architect.handoff, undefined);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a durable Architect handoff always offers an explicit retry of the current runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-empty-handoff-"));
  const database = join(root, "scheduler.sqlite");
  const store = new SqliteSchedulerStore(database);
  try {
    store.append({
      runId: "run_1",
      type: "run.initialized",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run:initialized",
      payload: {},
    });
    store.append({
      runId: "run_1",
      type: "architect.runtime_assigned",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "architect:assigned",
      payload: { runtimeId: "chatgpt:gpt-5.5" },
    });
    store.append({
      runId: "run_1",
      type: "architect.handoff_required",
      occurredAt: "2026-07-12T00:00:01.000Z",
      actor: { role: "runner", id: "runtime-router" },
      idempotencyKey: "architect:handoff",
      payload: {
        reason: "usage limit reached",
        requiredCapabilities: ["code"],
        candidateRuntimeIds: ["chatgpt:gpt-5.4"],
      },
    });

    const projection = rebuildSchedulerProjection(store.readRun("run_1"));
    assert.deepEqual(projection.runtime.architect.handoff?.candidateRuntimeIds, [
      "chatgpt:gpt-5.5",
      "chatgpt:gpt-5.4",
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Architect plan reconciliation atomically cancels stale work and rewires dependents", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-reconcile-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
  const initial = event("run_reconcile", "plan.created", "plan:1", {
    revision: 1,
    tasks: [
      task("T1", "integrated", []),
      task("T2", "planned", ["T1"]),
      task("T3", "planned", ["T2"]),
    ],
  });
  const reconciled = event("run_reconcile", "plan.reconciled", "plan:2", {
    revision: 2,
    summary: "T1 evidence proves T2 is already satisfied.",
    taskUpdates: [
      { taskId: "T2", action: "cancel" },
      { taskId: "T3", action: "revise", dependencies: ["T1"] },
    ],
  });

  store.append(initial);
  store.append(reconciled);
  const projection = rebuildSchedulerProjection(store.readRun("run_reconcile"));
  assert.equal(projection.planRevision, 2);
  assert.equal(projection.tasks.T2.status, "cancelled");
  assert.deepEqual(projection.tasks.T3.dependencies, ["T1"]);
  assert.deepEqual(readyTaskIds(Object.values(projection.tasks)), ["T3"]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan reconciliation rejects live dependencies on cancelled tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-reconcile-invalid-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
  const initial = event("run_invalid_reconcile", "plan.created", "plan:1", {
    revision: 1,
    tasks: [
      task("T1", "integrated", []),
      task("T2", "planned", ["T1"]),
      task("T3", "planned", ["T2"]),
    ],
  });
  const invalid = event("run_invalid_reconcile", "plan.reconciled", "plan:2", {
    revision: 2,
    summary: "Cancel T2 without repairing its dependent.",
    taskUpdates: [{ taskId: "T2", action: "cancel" }],
  });

  store.append(initial);
  assert.throws(
    () => store.append(invalid),
    /depends on cancelled task T2/i
  );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("projection records the most recently integrated revision", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-integration-revision-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(event("run_revision", "plan.created", "plan:1", {
      revision: 1,
      tasks: [task("T1", "integrating", [])],
    }));
    store.append(event("run_revision", "task.transitioned", "integrated:1", {
      taskId: "T1",
      status: "integrated",
      patch: { integrationRevision: "a".repeat(40) },
    }));
    assert.equal(
      rebuildSchedulerProjection(store.readRun("run_revision")).integrationRevision,
      "a".repeat(40)
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function event(
  runId: string,
  type: NewSchedulerEvent["type"],
  idempotencyKey: string,
  payload: Record<string, unknown>
): NewSchedulerEvent {
  return {
    runId,
    type,
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: {
      role:
        type === "plan.created" || type === "plan.reconciled"
          ? "architect"
          : type === "guidance.requested"
            ? "worker"
            : "runner",
      id: "actor_1",
    },
    idempotencyKey,
    payload,
  };
}

function task(
  id: string,
  status: BuildTask["status"],
  dependencies: string[]
): BuildTask {
  return {
    id,
    objective: `Objective ${id}`,
    dependencies,
    status,
    requiredCapabilities: ["code"],
    attempt: 0,
  };
}

function policyEvent(
  runId: string,
  runPolicy: "finish" | "budgeted" | "plan_only"
): NewSchedulerEvent {
  return {
    runId,
    type: "run.policy_configured",
    occurredAt: "2026-07-13T00:00:00.000Z",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy },
  };
}
