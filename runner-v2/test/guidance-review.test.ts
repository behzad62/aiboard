import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  ToolCallBlock,
} from "../src/agent-contracts.js";
import { runAgentLoop } from "../src/agent-loop.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import {
  createSubmitTaskTool,
  createWorkerLifecycleTools,
} from "../src/worker-lifecycle-tools.js";

const now = () => "2026-07-12T00:00:00.000Z";

test("Architect and worker lifecycle tools publish complete model-facing schemas", async () => {
  await withStore(async (store) => {
    const tools = [
      ...createArchitectTools({ store, clock: now }),
      ...createWorkerLifecycleTools({ store, taskId: "task_a", clock: now }),
      createSubmitTaskTool(async () => {
        throw new Error("schema only");
      }),
    ];
    const expectedRequired: Record<string, string[]> = {
      plan_tasks: ["revision", "tasks"],
      revise_task: ["taskId", "revision"],
      answer_guidance: ["requestId", "expectedVersion", "answer"],
      upgrade_acceptance_contract: ["revision", "criteriaByTask"],
      reconcile_plan: ["revision", "summary", "taskUpdates"],
      review_task: ["taskId", "decision", "summary", "evidenceArtifactHashes"],
      request_integration: ["taskId"],
      complete_run: ["summary"],
      ask_architect: ["requestId", "question", "blocking", "evidenceSequence"],
      challenge_guidance: ["requestId", "expectedVersion", "evidenceSequence", "reason"],
      request_replan: ["requestId", "reason", "summary", "proposedChange", "evidenceSequence"],
      submit_task: ["summary", "readiness"],
    };
    for (const tool of tools) {
      const schema = tool.definition.inputSchema as Record<string, unknown>;
      assert.equal(schema.type, "object", tool.definition.name);
      assert.deepEqual(schema.required, expectedRequired[tool.definition.name], tool.definition.name);
      assert.equal(schema.additionalProperties, false, tool.definition.name);
      assert.equal(typeof schema.properties, "object", tool.definition.name);
    }
  });
});

test("architect lifecycle changes require typed tool calls, not completion prose", async () => {
  await withStore(async (store) => {
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) {
      registry.register(tool);
    }
    const model = new ScriptedModel([
      {
        blocks: [{ type: "text", text: "I planned and completed the build." }],
        stopReason: "end_turn",
      },
    ]);
    const result = await runAgentLoop({
      model,
      registry,
      context: architectContext(),
      initialMessages: initialMessages(),
    });
    assert.equal(result.status, "suspended");
    assert.equal(store.readRun("run_1").length, 0);

    const plan = await invoke(registry, architectContext(), "plan_tasks", {
      revision: 1,
      tasks: [
        {
          id: "task_a",
          objective: "Use any prose, including 'invalid plan', without interpretation",
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "behavior", text: "The planned behavior is implemented." }],
        },
      ],
    });
    assert.equal(plan.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "planned");

    const invalid = await invoke(registry, architectContext(), "plan_tasks", {
      revision: 2,
      tasks: [
        {
          id: "dup",
          objective: "one",
          dependencies: [],
          requiredCapabilities: [],
          acceptanceCriteria: [{ id: "one", text: "One behavior." }],
        },
        {
          id: "dup",
          objective: "two",
          dependencies: [],
          requiredCapabilities: [],
          acceptanceCriteria: [{ id: "two", text: "Two behavior." }],
        },
      ],
    });
    assert.equal(invalid.isError, true);
    assert.match(invalid.error?.message ?? "", /duplicate_task_id/);
  });
});

test("plan_tasks persists a versioned criterion set and rejects incomplete criteria", async () => {
  await withStore(async (store) => {
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) registry.register(tool);
    const missing = await invoke(registry, architectContext(), "plan_tasks", {
      revision: 1,
      tasks: [{
        id: "task_a",
        objective: "Implement the requested behavior",
        dependencies: [],
        requiredCapabilities: ["code"],
        acceptanceCriteria: [],
      }],
    });
    assert.equal(missing.isError, true);
    assert.match((missing.error?.issues ?? []).join(" "), /acceptance|criterion|valid tasks/i);

    const planned = await invoke(registry, architectContext(), "plan_tasks", {
      revision: 1,
      tasks: [{
        id: "task_a",
        objective: "Implement the requested behavior",
        dependencies: [],
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "behavior", text: "The behavior works." }],
      }],
    });
    assert.equal(planned.isError, false);
    const initial = projection(store).tasks.task_a;
    assert.deepEqual(initial.acceptanceCriteria, [{ id: "behavior", text: "The behavior works." }]);
    assert.equal(initial.acceptanceCriteriaVersion, 1);

    const assigned = await invoke(registry, architectContext(), "revise_task", {
      taskId: "task_a",
      revision: 2,
      acceptanceCriteria: [{ id: "revised", text: "The revised behavior works." }],
    });
    assert.equal(assigned.isError, false);
    const revised = projection(store).tasks.task_a;
    assert.deepEqual(revised.acceptanceCriteria, [{ id: "revised", text: "The revised behavior works." }]);
    assert.equal(revised.acceptanceCriteriaVersion, 2);

    store.append({
      runId: "run_1",
      type: "task.transitioned",
      occurredAt: now(),
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "task_a:assigned",
      payload: {
        taskId: "task_a",
        status: "assigned",
        patch: { attempt: 1, assignedWorkerId: "worker_1" },
      },
    });
    const activeRevision = await invoke(registry, architectContext(), "revise_task", {
      taskId: "task_a",
      revision: 3,
      acceptanceCriteria: [{ id: "active", text: "Must not mutate while active." }],
    });
    assert.equal(activeRevision.isError, true);
    assert.match(activeRevision.error?.message ?? "", /planned, failed, or rejected|active attempt/i);
  });
});

test("blocking guidance pauses one task while advisory guidance preserves scope", async () => {
  await withStore(async (store) => {
    seedRunningTask(store);
    const registry = new ToolRegistry();
    for (const tool of createWorkerLifecycleTools({
      store,
      taskId: "task_a",
      clock: now,
    })) {
      registry.register(tool);
    }
    const advisory = await invoke(registry, workerContext(), "ask_architect", {
      requestId: "advisory_1",
      question: "Which naming style is preferred?",
      blocking: false,
      evidenceSequence: 4,
    });
    assert.equal(advisory.isError, false);
    assert.equal(advisory.lifecycle, undefined);
    assert.equal(projection(store).tasks.task_a.status, "running");
    assert.deepEqual(projection(store).tasks.task_a.requiredCapabilities, ["code"]);

    const blocking = await invoke(registry, workerContext(), "ask_architect", {
      requestId: "blocking_1",
      question: "Which incompatible API contract should I implement?",
      blocking: true,
      evidenceSequence: 5,
    });
    assert.equal(blocking.isError, false);
    assert.deepEqual(blocking.lifecycle, {
      type: "ask_architect",
      requestId: "blocking_1",
      blocking: true,
    });
    assert.equal(projection(store).tasks.task_a.status, "waiting_guidance");
    assert.equal(projection(store).guidance.blocking_1.status, "open");
  });
});

test("a reused worker guidance label allocates a fresh durable request", async () => {
  await withStore(async (store) => {
    seedRunningTask(store);
    const workerRegistry = new ToolRegistry();
    for (const tool of createWorkerLifecycleTools({
      store,
      taskId: "task_a",
      clock: now,
    })) workerRegistry.register(tool);
    const architectRegistry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) {
      architectRegistry.register(tool);
    }

    const first = await invoke(workerRegistry, workerContext(), "ask_architect", {
      requestId: "final_review_block",
      question: "How should the first failure be resolved?",
      blocking: true,
      evidenceSequence: 10,
    });
    assert.equal(first.isError, false);
    const answered = await invoke(
      architectRegistry,
      architectContext(),
      "answer_guidance",
      {
        requestId: "final_review_block",
        expectedVersion: 1,
        answer: "Resolve the first failure.",
      }
    );
    assert.equal(answered.isError, false);

    const second = await invoke(workerRegistry, workerContext(), "ask_architect", {
      requestId: "final_review_block",
      question: "How should the newly observed failure be resolved?",
      blocking: true,
      evidenceSequence: 20,
    });

    assert.equal(second.isError, false);
    assert.equal(second.lifecycle?.type, "ask_architect");
    assert.notEqual(second.lifecycle?.requestId, "final_review_block");
    const secondRequestId = second.lifecycle?.requestId ?? "";
    const current = projection(store);
    assert.equal(current.guidance.final_review_block.status, "answered");
    assert.equal(current.guidance[secondRequestId]?.status, "open");
    assert.equal(
      current.guidance[secondRequestId]?.question,
      "How should the newly observed failure be resolved?"
    );
    assert.equal(current.tasks.task_a.guidanceRequestId, secondRequestId);
  });
});

test("guidance challenges require fresh evidence and only one challenge per version", async () => {
  await withStore(async (store) => {
    seedRunningTask(store);
    const workerRegistry = new ToolRegistry();
    for (const tool of createWorkerLifecycleTools({
      store,
      taskId: "task_a",
      clock: now,
    })) workerRegistry.register(tool);
    const architectRegistry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) {
      architectRegistry.register(tool);
    }
    await invoke(workerRegistry, workerContext(), "ask_architect", {
      requestId: "guidance_1",
      question: "Use API A or B?",
      blocking: true,
      evidenceSequence: 10,
    });
    const answer = await invoke(architectRegistry, architectContext(), "answer_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      answer: "Use API A.",
    });
    assert.equal(answer.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "running");

    const stale = await invoke(workerRegistry, workerContext(), "challenge_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      evidenceSequence: 10,
      reason: "Same evidence should not reopen it.",
    });
    assert.equal(stale.isError, true);
    assert.match(stale.error?.message ?? "", /newer evidence/i);

    const challenge = await invoke(workerRegistry, workerContext(), "challenge_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      evidenceSequence: 11,
      reason: "The repository shows API A was removed.",
    });
    assert.equal(challenge.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "waiting_guidance");

    const duplicate = await invoke(workerRegistry, workerContext(), "challenge_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      evidenceSequence: 12,
      reason: "A second challenge is not allowed for this version.",
    });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.error?.message ?? "", /already challenged/i);

    await invoke(architectRegistry, architectContext(), "answer_guidance", {
      requestId: "guidance_1",
      expectedVersion: 1,
      answer: "Use API B given the new evidence.",
    });
    assert.equal(projection(store).guidance.guidance_1.version, 2);
  });
});

test("only Architect tools can approve, request integration, and complete", async () => {
  await withStore(async (store, evidenceStore) => {
    const artifactHash = "a".repeat(64);
    const evidence = evidenceStore.record({
      runId: "run_1",
      taskId: "task_a",
      actor: { role: "worker", id: "worker_1" },
      fact: {
        kind: "browser_screenshot",
        label: "criterion screenshot",
        capturedAt: now(),
        screenshotArtifactHash: artifactHash,
        mediaType: "image/png",
        byteLength: 10,
      },
      createdAt: now(),
      idempotencyKey: "authority-criterion",
      attempt: 1,
    });
    seedSubmittedTask(store, evidence.id, artifactHash);
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now, evidenceStore })) {
      registry.register(tool);
    }
    const workerReview = await invoke(registry, workerContext(), "review_task", {
      taskId: "task_a",
      decision: "approved",
      summary: "Looks good",
      evidenceArtifactHashes: [],
    });
    assert.equal(workerReview.isError, true);
    assert.equal(projection(store).tasks.task_a.status, "submitted");

    const review = await invoke(registry, architectContext(), "review_task", {
      taskId: "task_a",
      decision: "approved",
      summary: "The change meets the task intent.",
      evidenceArtifactHashes: [artifactHash],
      criterionVerdicts: [{
        criterionId: "behavior",
        verdict: "satisfied",
        rationale: "The durable evidence supports the task intent.",
        evidenceIds: [evidence.id],
        artifactHashes: [artifactHash],
      }],
    });
    assert.equal(review.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "approved");

    const integration = await invoke(
      registry,
      architectContext(),
      "request_integration",
      { taskId: "task_a" }
    );
    assert.equal(integration.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "integrating");

    const workerComplete = await invoke(registry, workerContext(), "complete_run", {
      summary: "Done",
    });
    assert.equal(workerComplete.isError, true);
    assert.equal(projection(store).status, "running");

    store.append({
      runId: "run_1",
      type: "task.transitioned",
      occurredAt: now(),
      actor: { role: "runner", id: "integration-manager" },
      idempotencyKey: "integration:task_a",
      payload: {
        taskId: "task_a",
        status: "integrated",
        patch: { integrationRevision: "revision_final" },
      },
    });

    const complete = await invoke(registry, architectContext(), "complete_run", {
      summary: "Architect accepts the handoff.",
    });
    assert.equal(complete.isError, true);
    assert.equal(complete.error?.code, "completion_not_ready");
    assert.equal(projection(store).status, "running");
    assert.equal(projection(store).projectHandoff, undefined);
  });
});

test("review_task requires complete criterion verdicts and evaluates rejected criteria", async () => {
  await withStore(async (store, evidenceStore) => {
    const artifactHash = "a".repeat(64);
      const evidence = evidenceStore.record({
        runId: "run_1",
        taskId: "task_a",
        actor: { role: "worker", id: "worker_1" },
        fact: {
          kind: "browser_screenshot",
          label: "criterion screenshot",
          capturedAt: now(),
          screenshotArtifactHash: artifactHash,
          mediaType: "image/png",
          byteLength: 10,
        },
        createdAt: now(),
        idempotencyKey: "criterion-evidence",
        attempt: 1,
      });
      store.append({
        runId: "run_1",
        type: "plan.created",
        occurredAt: now(),
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "plan:1",
        payload: {
          revision: 1,
          tasks: [{
            id: "task_a",
            objective: "Implement the requested behavior",
            dependencies: [],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [
              { id: "behavior", text: "The behavior is implemented." },
              { id: "verification", text: "The focused check passes." },
            ],
            acceptanceCriteriaVersion: 1,
            attempt: 0,
          }],
        },
      });
      transition(store, "assigned", { attempt: 1, assignedWorkerId: "worker_1" });
      transition(store, "running", {});
      transition(store, "submitted", {
        changeSetId: "changeset_1",
        criterionEvidenceLinks: [
          {
            criterionId: "behavior",
            evidenceId: evidence.id,
            artifactHashes: [artifactHash],
            taskId: "task_a",
            attempt: 1,
          },
          {
            criterionId: "verification",
            evidenceId: evidence.id,
            artifactHashes: [artifactHash],
            taskId: "task_a",
            attempt: 1,
          },
        ],
      });
      const registry = new ToolRegistry();
      for (const tool of createArchitectTools({ store, clock: now, evidenceStore })) {
        registry.register(tool);
      }
      const omitted = await invoke(registry, architectContext(), "review_task", {
        taskId: "task_a",
        decision: "approved",
        summary: "The review is incomplete.",
        evidenceArtifactHashes: [artifactHash],
        criterionVerdicts: [{
          criterionId: "behavior",
          verdict: "satisfied",
          rationale: "The evidence supports the behavior.",
          evidenceIds: [evidence.id],
          artifactHashes: [artifactHash],
        }],
      });
      assert.equal(omitted.isError, true);
      assert.match(omitted.error?.message ?? "", /criterion|verdict/i);

      const rejected = await invoke(registry, architectContext(), "review_task", {
        taskId: "task_a",
        decision: "rejected",
        summary: "The behavior criterion remains unsatisfied.",
        evidenceArtifactHashes: [artifactHash],
        criterionVerdicts: [
          {
            criterionId: "behavior",
            verdict: "unsatisfied",
            rationale: "The observed behavior does not meet the requirement.",
            evidenceIds: [evidence.id],
            artifactHashes: [artifactHash],
          },
          {
            criterionId: "verification",
            verdict: "satisfied",
            rationale: "The focused check produced durable evidence.",
            evidenceIds: [evidence.id],
            artifactHashes: [artifactHash],
          },
        ],
      });
      assert.equal(rejected.isError, false);
      const review = projection(store).reviews.task_a;
      assert.equal(review.status, "rejected");
      assert.equal(review.criterionVerdicts?.length, 2);
      assert.deepEqual(
        review.criterionVerdicts?.map((verdict) => verdict.criterionId),
        ["behavior", "verification"]
      );
  });
});

test("legacy active runs block Architect review until their contract is upgraded", async () => {
  await withStore(async (store) => {
    store.append({
      runId: "run_1",
      type: "plan.created",
      occurredAt: now(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [{
          id: "task_a",
          objective: "Recover a legacy task",
          dependencies: [],
          status: "submitted",
          requiredCapabilities: ["code"],
          attempt: 1,
          changeSetId: "legacy-change-set",
        }],
      },
    });
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) registry.register(tool);
    const review = await invoke(registry, architectContext(), "review_task", {
      taskId: "task_a",
      decision: "approved",
      summary: "Legacy review must wait for criteria.",
      evidenceArtifactHashes: [],
    });
    assert.equal(review.isError, true);
    assert.equal(review.error?.code, "acceptance_contract_upgrade_required");
    const complete = await invoke(registry, architectContext(), "complete_run", {
      summary: "Legacy completion must wait for criteria.",
    });
    assert.equal(complete.isError, true);
    assert.equal(complete.error?.code, "acceptance_contract_upgrade_required");
    assert.equal(projection(store).tasks.task_a.status, "submitted");
  });
});

test("Architect review can atomically reconcile stale successor tasks", async () => {
  await withStore(async (store, evidenceStore) => {
    const artifactHash = "c".repeat(64);
    const evidence = evidenceStore.record({
      runId: "run_1",
      taskId: "task_a",
      actor: { role: "worker", id: "worker_1" },
      fact: {
        kind: "browser_screenshot",
        label: "inspection",
        capturedAt: now(),
        screenshotArtifactHash: artifactHash,
        mediaType: "image/png",
        byteLength: 10,
      },
      createdAt: now(),
      idempotencyKey: "reconcile-inspection",
      attempt: 1,
    });
    store.append({
      runId: "run_1",
      type: "plan.created",
      occurredAt: now(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [
          {
            id: "task_a",
            objective: "Inspect the current implementation",
            dependencies: [],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "inspect", text: "The implementation is inspected." }],
            attempt: 0,
          },
          {
            id: "task_b",
            objective: "Apply the change assumed by the original plan",
            dependencies: ["task_a"],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "apply", text: "The requested change is applied." }],
            attempt: 0,
          },
          {
            id: "task_c",
            objective: "Continue from the current implementation",
            dependencies: ["task_b"],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "continue", text: "The implementation continues." }],
            attempt: 0,
          },
        ],
      },
    });
    transition(store, "assigned", { attempt: 1, assignedWorkerId: "worker_1" });
    transition(store, "running", {});
    transition(store, "submitted", {
      changeSetId: "inspection_1",
      criterionEvidenceLinks: [{
        criterionId: "inspect",
        evidenceId: evidence.id,
        artifactHashes: [artifactHash],
        taskId: "task_a",
        attempt: 1,
      }],
    });

    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now, evidenceStore })) {
      registry.register(tool);
    }
    const eventCount = store.readRun("run_1").length;
    const review = await invoke(registry, architectContext(), "review_task", {
      taskId: "task_a",
      decision: "approved",
      summary: "Inspection proves task_b is already satisfied.",
      evidenceArtifactHashes: [artifactHash],
      criterionVerdicts: [{
        criterionId: "inspect",
        verdict: "satisfied",
        rationale: "The inspection evidence supports the baseline.",
        evidenceIds: [evidence.id],
        artifactHashes: [artifactHash],
      }],
      planReconciliation: {
        revision: 2,
        summary: "Remove the obsolete change and continue from the inspected baseline.",
        taskUpdates: [
          { taskId: "task_b", action: "cancel" },
          {
            taskId: "task_c",
            action: "revise",
            dependencies: ["task_a"],
          },
        ],
      },
    });

    assert.equal(review.isError, false, review.error?.message ?? "review failed");
    assert.equal(store.readRun("run_1").length, eventCount + 1);
    assert.equal(projection(store).tasks.task_a.status, "approved");
    assert.equal(projection(store).tasks.task_b.status, "cancelled");
    assert.deepEqual(projection(store).tasks.task_c.dependencies, ["task_a"]);
    assert.equal(projection(store).planRevision, 2);
  });
});

test("Architect can reconcile a stale plan during failure resolution", async () => {
  await withStore(async (store) => {
    store.append({
      runId: "run_1",
      type: "plan.created",
      occurredAt: now(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:1",
      payload: {
        revision: 1,
        tasks: [
          {
            id: "task_a",
            objective: "Verified baseline",
            dependencies: [],
            status: "integrated",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "baseline", text: "The baseline is verified." }],
            attempt: 1,
          },
          {
            id: "task_b",
            objective: "Obsolete work",
            dependencies: ["task_a"],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "obsolete", text: "Obsolete work is removed." }],
            attempt: 2,
          },
          {
            id: "task_c",
            objective: "Remaining work",
            dependencies: ["task_b"],
            status: "planned",
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "remaining", text: "Remaining work is delivered." }],
            attempt: 0,
          },
        ],
      },
    });
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now })) {
      registry.register(tool);
    }

    const result = await invoke(registry, architectContext(), "reconcile_plan", {
      revision: 2,
      summary: "Evidence invalidated task_b.",
      taskUpdates: [
        { taskId: "task_b", action: "cancel" },
        { taskId: "task_c", action: "revise", dependencies: ["task_a"] },
      ],
    });

    assert.equal(result.isError, false, result.error?.message ?? "reconciliation failed");
    assert.deepEqual(result.lifecycle, {
      type: "architect_action",
      action: "plan_reconciled",
      referenceId: "2",
    });
    assert.equal(projection(store).tasks.task_b.status, "cancelled");
    assert.deepEqual(projection(store).tasks.task_c.dependencies, ["task_a"]);
    assert.equal(projection(store).planRevision, 2);
  });
});

test("Architect can review a retried task without colliding with the prior attempt", async () => {
  await withStore(async (store, evidenceStore) => {
    const artifactHash1 = "a".repeat(64);
    const evidence1 = evidenceStore.record({
      runId: "run_1",
      taskId: "task_a",
      actor: { role: "worker", id: "worker_1" },
      fact: {
        kind: "browser_screenshot",
        label: "attempt one",
        capturedAt: now(),
        screenshotArtifactHash: artifactHash1,
        mediaType: "image/png",
        byteLength: 10,
      },
      createdAt: now(),
      idempotencyKey: "retry-criterion-1",
      attempt: 1,
    });
    seedSubmittedTask(store, evidence1.id, artifactHash1);
    const registry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, clock: now, evidenceStore })) {
      registry.register(tool);
    }
    const rejected = await invoke(registry, architectContext(), "review_task", {
      taskId: "task_a",
      decision: "rejected",
      summary: "Attempt one lacks relevant evidence.",
      evidenceArtifactHashes: [artifactHash1],
      criterionVerdicts: [{
        criterionId: "behavior",
        verdict: "unsatisfied",
        rationale: "Attempt one does not satisfy the behavior.",
        evidenceIds: [evidence1.id],
        artifactHashes: [artifactHash1],
      }],
    });
    assert.equal(rejected.isError, false);
    store.append({
      runId: "run_1",
      type: "task.transitioned",
      occurredAt: now(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "retry:task_a:1",
      payload: { taskId: "task_a", status: "planned" },
    });
    transition(
      store,
      "assigned",
      { attempt: 2, assignedWorkerId: "worker_2" },
      "attempt:2"
    );
    transition(store, "running", {}, "attempt:2");
    const artifactHash2 = "b".repeat(64);
    const evidence2 = evidenceStore.record({
      runId: "run_1",
      taskId: "task_a",
      actor: { role: "worker", id: "worker_2" },
      fact: {
        kind: "browser_screenshot",
        label: "attempt two",
        capturedAt: now(),
        screenshotArtifactHash: artifactHash2,
        mediaType: "image/png",
        byteLength: 10,
      },
      createdAt: now(),
      idempotencyKey: "retry-criterion-2",
      attempt: 2,
    });
    transition(
      store,
      "submitted",
      {
        changeSetId: "changeset_2",
        criterionEvidenceLinks: [{
          criterionId: "behavior",
          evidenceId: evidence2.id,
          artifactHashes: [artifactHash2],
          taskId: "task_a",
          attempt: 2,
        }],
      },
      "attempt:2"
    );
    const approved = await invoke(registry, architectContext(), "review_task", {
      taskId: "task_a",
      decision: "approved",
      summary: "Attempt two includes the required evidence.",
      evidenceArtifactHashes: [artifactHash2],
      criterionVerdicts: [{
        criterionId: "behavior",
        verdict: "satisfied",
        rationale: "Attempt two satisfies the behavior.",
        evidenceIds: [evidence2.id],
        artifactHashes: [artifactHash2],
      }],
    });
    assert.equal(approved.isError, false);
    assert.equal(projection(store).tasks.task_a.status, "approved");
    assert.equal(
      projection(store).reviews.task_a.summary,
      "Attempt two includes the required evidence."
    );
  });
});

test("durable reducer rejects authority bypass events", async () => {
  await withStore(async (store, evidenceStore) => {
    const artifactHash = "a".repeat(64);
    const evidence = evidenceStore.record({
      runId: "run_1",
      taskId: "task_a",
      actor: { role: "worker", id: "worker_1" },
      fact: {
        kind: "browser_screenshot",
        label: "authority bypass evidence",
        capturedAt: now(),
        screenshotArtifactHash: artifactHash,
        mediaType: "image/png",
        byteLength: 10,
      },
      createdAt: now(),
      idempotencyKey: "authority-bypass-evidence",
      attempt: 1,
    });
    seedSubmittedTask(store, evidence.id, artifactHash);
    assert.throws(
      () => store.append({
        runId: "run_1",
        type: "task.transitioned",
        occurredAt: now(),
        actor: { role: "runner", id: "bypass" },
        idempotencyKey: "bypass-review",
        payload: { taskId: "task_a", status: "architect_review" },
      }),
      /only the Architect/i
    );
    assert.equal(projection(store).tasks.task_a.status, "submitted");
  });
});

class ScriptedModel implements AgentModel {
  constructor(private readonly turns: ModelTurn[]) {}
  async complete(_request: AgentModelRequest): Promise<ModelTurn> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    return turn;
  }
}

async function invoke(
  registry: ToolRegistry,
  context: ReturnType<typeof architectContext> | ReturnType<typeof workerContext>,
  name: string,
  args: unknown
) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId: `${name}_${Math.random()}`,
    name,
    arguments: args,
  };
  return await registry.invoke(call, context);
}

function initialMessages(): AgentMessage[] {
  return [
    { id: "system", role: "system", content: "Use native lifecycle tools." },
    { id: "user", role: "user", content: "Build it." },
  ];
}

function architectContext() {
  return {
    runId: "run_1",
    sessionId: "architect_session",
    actor: { role: "architect" as const, id: "architect_1" },
  };
}

function workerContext() {
  return {
    runId: "run_1",
    sessionId: "worker_session",
    actor: { role: "worker" as const, id: "worker_1" },
  };
}

function projection(store: SqliteSchedulerStore) {
  return rebuildSchedulerProjection(store.readRun("run_1"));
}

function seedRunningTask(store: SqliteSchedulerStore): void {
  seedPlan(store);
  transition(store, "assigned", { attempt: 1, assignedWorkerId: "worker_1" });
  transition(store, "running", {});
}

function seedSubmittedTask(
  store: SqliteSchedulerStore,
  evidenceId = "evidence_behavior",
  artifactHash = "a".repeat(64)
): void {
  seedRunningTask(store);
  transition(store, "submitted", {
    changeSetId: "changeset_1",
    criterionEvidenceLinks: [{
      criterionId: "behavior",
      evidenceId,
      artifactHashes: [artifactHash],
      taskId: "task_a",
      attempt: 1,
    }],
  });
}

function seedPlan(store: SqliteSchedulerStore): void {
  store.append({
    runId: "run_1",
    type: "plan.created",
    occurredAt: now(),
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "plan:1",
    payload: {
      revision: 1,
      tasks: [
        {
          id: "task_a",
          objective: "Implement the requested behavior",
          dependencies: [],
          status: "planned",
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "behavior", text: "The requested behavior is implemented." }],
          attempt: 0,
        },
      ],
    },
  });
}

function transition(
  store: SqliteSchedulerStore,
  status: "assigned" | "running" | "submitted",
  patch: Record<string, unknown>,
  keySuffix = ""
): void {
  store.append({
    runId: "run_1",
    type: "task.transitioned",
    occurredAt: now(),
    actor: { role: "runner", id: "test" },
    idempotencyKey: `task_a:${status}${keySuffix ? `:${keySuffix}` : ""}`,
    payload: { taskId: "task_a", status, patch },
  });
}

async function withStore(
  run: (
    store: SqliteSchedulerStore,
    evidenceStore: SqliteEvidenceStore,
  ) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-guidance-review-"));
  const evidenceStore = new SqliteEvidenceStore(":memory:");
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore,
  });
  try {
    await run(store, evidenceStore);
  } finally {
    store.close();
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
}
