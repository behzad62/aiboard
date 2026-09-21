import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SchedulerPlanCritiqueAuthority,
  type RequestPlanCritiqueInput,
  type SubmitPlanCritiqueInput,
} from "../src/plan-critique-authority.js";
import { assessPlanRisk } from "../src/plan-critique-contracts.js";
import type { PlanCritiqueFinding } from "../src/plan-critique-contracts.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerEvent,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import type { VerifierRuntimeBinding } from "../src/verifier-contracts.js";

const RUN_ID = "run_critique";
const AT = "2026-09-02T00:00:00.000Z";
const ARCHITECT: NewSchedulerEvent["actor"] = { role: "architect", id: "architect_1" };
const RUNNER: NewSchedulerEvent["actor"] = { role: "runner", id: "test" };
const CRITIC = { role: "verifier" as const, id: "google:verifier" };

function event(
  type: NewSchedulerEvent["type"],
  idempotencyKey: string,
  payload: Record<string, unknown>,
  actor: NewSchedulerEvent["actor"] = RUNNER,
): NewSchedulerEvent {
  return { runId: RUN_ID, type, occurredAt: AT, actor, idempotencyKey, payload };
}

function task(id: string, dependencies: string[] = []): BuildTask {
  return {
    id,
    objective: `Do ${id}`,
    dependencies,
    status: "planned",
    requiredCapabilities: ["code"],
    attempt: 0,
    acceptanceCriteria: [{ id: "AC-1", text: `${id} works.` }],
    acceptanceCriteriaVersion: 1,
  };
}

function highRiskTasks(): BuildTask[] {
  return [task("A"), task("B"), task("C"), task("D"), task("E", ["A", "B"])];
}

function binding(runtimeId: string, modelId: string, sessionId: string): VerifierRuntimeBinding {
  return {
    runtimeId,
    providerId: "google",
    modelId,
    modelIdentity: modelId,
    sessionId,
  };
}

function criticRuntime() {
  return binding("google:verifier", "verifier", "plan-critic:s1");
}

function architectExclusion() {
  return [{ source: "architect" as const, runtimeId: "openai:architect", modelIdentity: "architect" }];
}

function requestInput(overrides: Partial<RequestPlanCritiqueInput> = {}): RequestPlanCritiqueInput {
  return {
    runId: RUN_ID,
    critiqueId: "critique-1",
    planRevision: 1,
    runtime: criticRuntime(),
    excludedModels: architectExclusion(),
    occurredAt: AT,
    ...overrides,
  };
}

function findingWithCriterion(): PlanCritiqueFinding {
  return {
    findingId: "F-1",
    severity: "blocking",
    category: "overlapping_scope",
    taskIds: ["A", "B"],
    criterionIds: [{ taskId: "A", criterionId: "AC-1" }],
    claim: "A and B both own src/cache.ts.",
    evidence: ["A objective mentions src/cache.ts", "B objective mentions src/cache.ts"],
  };
}

function submitInput(overrides: Partial<SubmitPlanCritiqueInput> = {}): SubmitPlanCritiqueInput {
  return {
    runId: RUN_ID,
    critiqueId: "critique-1",
    planRevision: 1,
    sessionId: "plan-critic:s1",
    actor: CRITIC,
    findings: [findingWithCriterion()],
    occurredAt: AT,
    ...overrides,
  };
}

function seededStore(root: string): SqliteSchedulerStore {
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  store.append(event("run.initialized", "init", { runId: RUN_ID }));
  store.append(event("plan.created", "plan:1", {
    revision: 1,
    tasks: highRiskTasks(),
    riskDeclaration: { risk: "low", rationale: "routine" },
  }, ARCHITECT));
  store.append(event("plan_critique.policy_configured", "critique-policy:risk_based", { mode: "risk_based" }));
  const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
  store.append(event("plan_critique.risk_assessed", "critique-risk", {
    planRevision: projection.planRevision,
    architectDeclaration: "low",
    stricterQualification: false,
    assessment: assessPlanRisk({
      architectDeclaration: "low",
      stricterQualification: false,
      tasks: Object.values(projection.tasks),
    }),
  }));
  return store;
}

function withReadyStore(
  fn: (store: SqliteSchedulerStore, authority: SchedulerPlanCritiqueAuthority) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-authority-"));
  const store = seededStore(root);
  try {
    fn(store, new SchedulerPlanCritiqueAuthority(store));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function requestedEvents(store: SchedulerStore): SchedulerEvent[] {
  return store.readRun(RUN_ID).filter((candidate) => candidate.type === "plan_critique.requested");
}

function submittedEvents(store: SchedulerStore): SchedulerEvent[] {
  return store.readRun(RUN_ID).filter((candidate) => candidate.type === "plan_critique.submitted");
}

function acceptedEvent(input: NewSchedulerEvent, sequence = 99): SchedulerEvent {
  return { eventId: "stub-event", sequence, ...input };
}

class HideNewEventsStore implements SchedulerStore {
  private hiddenSequence: number | undefined;
  constructor(private readonly inner: SchedulerStore) {}
  append(input: NewSchedulerEvent): SchedulerEvent {
    const appended = this.inner.append(input);
    this.hiddenSequence = appended.sequence;
    return appended;
  }
  readRun(runId: string, afterSequence?: number): SchedulerEvent[] {
    return this.inner.readRun(runId, afterSequence).filter(
      (candidate) => this.hiddenSequence === undefined || candidate.sequence < this.hiddenSequence,
    );
  }
  close(): void {
    this.inner.close();
  }
}

class FrozenProjectionStore implements SchedulerStore {
  lastAppend: NewSchedulerEvent | undefined;
  constructor(private readonly events: SchedulerEvent[]) {}
  append(input: NewSchedulerEvent): SchedulerEvent {
    this.lastAppend = input;
    return acceptedEvent(input);
  }
  readRun(): SchedulerEvent[] {
    return this.events;
  }
  close(): void {}
}

class RecordingStore implements SchedulerStore {
  lastAppend: NewSchedulerEvent | undefined;
  constructor(private readonly inner: SchedulerStore) {}
  append(input: NewSchedulerEvent): SchedulerEvent {
    this.lastAppend = input;
    return this.inner.append(input);
  }
  readRun(runId: string, afterSequence?: number): SchedulerEvent[] {
    return this.inner.readRun(runId, afterSequence);
  }
  close(): void {
    this.inner.close();
  }
}

function isCritiqueProjection(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.critiqueId === "string"
    && (record.status === "requested" || record.status === "submitted" || record.status === "resolved")
    && typeof record.runtime === "object"
    && record.runtime !== null;
}

test("requestCritique appends plan_critique.requested and returns the durable projection", () => {
  withReadyStore((store, authority) => {
    const projection = authority.requestCritique(requestInput());
    const events = requestedEvents(store);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.idempotencyKey, "plan-critique:request:critique-1");
    assert.equal(events[0]?.payload.critiqueId, "critique-1");
    assert.equal("supersedesCritiqueId" in events[0]!.payload, false);
    assert.equal(projection.critiqueId, "critique-1");
    assert.equal(projection.planRevision, 1);
    assert.equal(projection.status, "requested");
    assert.equal(projection.runtime.sessionId, "plan-critic:s1");
    assert.deepEqual(projection.excludedModels, architectExclusion());
    assert.equal(authority.currentCritique(RUN_ID)?.critiqueId, "critique-1");
  });
});

test("requestCritique is idempotent for the same critiqueId", () => {
  withReadyStore((store, authority) => {
    const first = authority.requestCritique(requestInput());
    const second = authority.requestCritique(requestInput());
    assert.deepEqual(second, first);
    assert.equal(requestedEvents(store).length, 1);
    assert.equal(requestedEvents(store)[0]?.idempotencyKey, "plan-critique:request:critique-1");
  });
});

test("supersedesCritiqueId is set only when a different requested critique is current", () => {
  withReadyStore((store, authority) => {
    const first = authority.requestCritique(requestInput());
    assert.equal("supersedesCritiqueId" in requestedEvents(store)[0]!.payload, false, "absent when there is no current critique");
    assert.equal(first.critiqueId, "critique-1");

    const sameAgain = authority.requestCritique(requestInput());
    assert.equal(sameAgain.critiqueId, "critique-1");
    assert.equal(requestedEvents(store).length, 1);
    assert.equal("supersedesCritiqueId" in requestedEvents(store)[0]!.payload, false, "absent when the current critique has the same critiqueId");

    const replacement = authority.requestCritique(requestInput({
      critiqueId: "critique-2",
      runtime: binding("google:other", "other", "plan-critic:s2"),
    }));
    const events = requestedEvents(store);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.payload.supersedesCritiqueId, "critique-1");
    assert.equal(replacement.critiqueId, "critique-2");
    assert.equal(store.readRun(RUN_ID).at(-1)?.payload.supersedesCritiqueId, "critique-1");
    const history = rebuildSchedulerProjection(store.readRun(RUN_ID)).planCritique?.history ?? [];
    assert.equal(history[0]?.critiqueId, "critique-1");
    assert.equal(history[0]?.supersededByCritiqueId, "critique-2");
  });
});

test("currentCritique returns undefined for a run with no events and clones the projection", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-authority-empty-"));
  const empty = new SqliteSchedulerStore(join(root, "scheduler-empty.sqlite"));
  try {
    const authority = new SchedulerPlanCritiqueAuthority(empty);
    assert.equal(authority.currentCritique(RUN_ID), undefined);
    assert.equal(authority.currentCritique("missing-run"), undefined);
  } finally {
    empty.close();
    rmSync(root, { recursive: true, force: true });
  }

  withReadyStore((_store, authority) => {
    authority.requestCritique(requestInput());
    const original = globalThis.structuredClone;
    const clonedCritiques: unknown[] = [];
    globalThis.structuredClone = ((value: unknown, transfer?: StructuredSerializeOptions) => {
      if (isCritiqueProjection(value)) clonedCritiques.push(value);
      return original(value, transfer);
    }) as typeof structuredClone;
    try {
      const first = authority.currentCritique(RUN_ID);
      assert.ok(first);
      assert.ok(clonedCritiques.length >= 1, "currentCritique must structuredClone the durable projection");
      first.status = "submitted";
      first.runtime.sessionId = "mutated-session";
      first.excludedModels.push({
        source: "architect",
        runtimeId: "mutated",
        modelIdentity: "mutated",
      });
      const second = authority.currentCritique(RUN_ID);
      assert.ok(second);
      assert.equal(second.status, "requested");
      assert.equal(second.runtime.sessionId, "plan-critic:s1");
      assert.equal(second.excludedModels.length, 1);
      assert.notEqual(second, first);
    } finally {
      globalThis.structuredClone = original;
    }
  });
});

test("submitFindings appends plan_critique.submitted with deep-copied findings", () => {
  withReadyStore((store) => {
    const recording = new RecordingStore(store);
    const authority = new SchedulerPlanCritiqueAuthority(recording);
    authority.requestCritique(requestInput());
    const findings = [findingWithCriterion()];
    const originalTaskIds = [...findings[0]!.taskIds];
    const originalEvidence = [...findings[0]!.evidence];
    const originalCriteria = findings[0]!.criterionIds!.map((criterion) => ({ ...criterion }));

    const projection = authority.submitFindings(submitInput({ findings }));
    const events = submittedEvents(recording);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.idempotencyKey, "plan-critique:submit:critique-1");
    assert.equal(projection.status, "submitted");
    assert.equal(projection.critiqueId, "critique-1");
    assert.deepEqual(projection.blockingFindingIds, ["F-1"]);

    const stored = recording.lastAppend?.payload.findings as PlanCritiqueFinding[];
    assert.ok(stored);
    assert.notEqual(stored, findings);
    assert.notEqual(stored[0], findings[0]);
    assert.notEqual(stored[0]?.taskIds, findings[0]?.taskIds);
    assert.notEqual(stored[0]?.evidence, findings[0]?.evidence);
    assert.notEqual(stored[0]?.criterionIds, findings[0]?.criterionIds);
    assert.notEqual(stored[0]?.criterionIds?.[0], findings[0]?.criterionIds?.[0]);

    findings.push(findingWithCriterion());
    findings[0]!.taskIds.push("E");
    findings[0]!.evidence.push("mutated-evidence");
    findings[0]!.criterionIds!.push({ taskId: "B", criterionId: "AC-1" });
    findings[0]!.criterionIds![0]!.criterionId = "MUTATED";
    findings[0]!.claim = "mutated-claim";

    assert.deepEqual((recording.lastAppend?.payload.findings as PlanCritiqueFinding[])[0]?.taskIds, originalTaskIds);
    assert.deepEqual((recording.lastAppend?.payload.findings as PlanCritiqueFinding[])[0]?.evidence, originalEvidence);
    assert.deepEqual((recording.lastAppend?.payload.findings as PlanCritiqueFinding[])[0]?.criterionIds, originalCriteria);
    assert.equal((recording.lastAppend?.payload.findings as PlanCritiqueFinding[])[0]?.claim, "A and B both own src/cache.ts.");

    const durable = authority.currentCritique(RUN_ID);
    assert.equal(durable?.findings?.length, 1);
    assert.deepEqual(durable?.findings?.[0]?.taskIds, originalTaskIds);
    assert.deepEqual(durable?.findings?.[0]?.evidence, originalEvidence);
    assert.deepEqual(durable?.findings?.[0]?.criterionIds, originalCriteria);
  });
});

test("requestCritique throws when the request was not durably projected", () => {
  withReadyStore((store) => {
    const hidden = new HideNewEventsStore(store);
    const authority = new SchedulerPlanCritiqueAuthority(hidden);
    assert.throws(
      () => authority.requestCritique(requestInput()),
      { message: "Requested plan critique was not durably projected." },
    );
  });
});

test("submitFindings throws when the findings were not durably projected", () => {
  withReadyStore((store) => {
    new SchedulerPlanCritiqueAuthority(store).requestCritique(requestInput());
    const hidden = new HideNewEventsStore(store);
    const authority = new SchedulerPlanCritiqueAuthority(hidden);
    assert.throws(
      () => authority.submitFindings(submitInput()),
      { message: "Plan critique findings were not durably projected." },
    );
  });
});

test("submitFindings read-back fires when the durable critique is missing entirely", () => {
  withReadyStore((store) => {
    new SchedulerPlanCritiqueAuthority(store).requestCritique(requestInput());
    const frozen = new FrozenProjectionStore([]);
    const authority = new SchedulerPlanCritiqueAuthority(frozen);
    assert.throws(
      () => authority.submitFindings(submitInput()),
      { message: "Plan critique findings were not durably projected." },
    );
  });
});

test("submitFindings read-back fires when the durable status is not submitted", () => {
  withReadyStore((store) => {
    const authority = new SchedulerPlanCritiqueAuthority(store);
    authority.requestCritique(requestInput());
    authority.submitFindings(submitInput({ findings: [] }));
    store.append(event("plan_critique.resolved", "critique:1:resolved", {
      critiqueId: "critique-1",
      planRevision: 1,
      resolutions: [],
    }));
    const frozen = new FrozenProjectionStore(store.readRun(RUN_ID));
    const isolated = new SchedulerPlanCritiqueAuthority(frozen);
    assert.throws(
      () => isolated.submitFindings(submitInput({ findings: [] })),
      { message: "Plan critique findings were not durably projected." },
    );
  });
});

test("submitFindings read-back fires when the durable critiqueId does not match", () => {
  withReadyStore((store) => {
    const authority = new SchedulerPlanCritiqueAuthority(store);
    authority.requestCritique(requestInput());
    authority.submitFindings(submitInput({ findings: [] }));
    const frozen = new FrozenProjectionStore(store.readRun(RUN_ID));
    const isolated = new SchedulerPlanCritiqueAuthority(frozen);
    assert.throws(
      () => isolated.submitFindings(submitInput({ critiqueId: "critique-other", findings: [] })),
      { message: "Plan critique findings were not durably projected." },
    );
  });
});

test("submitFindings read-back fires when the durable planRevision does not match", () => {
  withReadyStore((store) => {
    const authority = new SchedulerPlanCritiqueAuthority(store);
    authority.requestCritique(requestInput());
    authority.submitFindings(submitInput({ findings: [] }));
    const frozen = new FrozenProjectionStore(store.readRun(RUN_ID));
    const isolated = new SchedulerPlanCritiqueAuthority(frozen);
    assert.throws(
      () => isolated.submitFindings(submitInput({ planRevision: 2, findings: [] })),
      { message: "Plan critique findings were not durably projected." },
    );
  });
});

test("submitFindings read-back fires when the durable sessionId does not match", () => {
  withReadyStore((store) => {
    const authority = new SchedulerPlanCritiqueAuthority(store);
    authority.requestCritique(requestInput());
    authority.submitFindings(submitInput({ findings: [] }));
    const frozen = new FrozenProjectionStore(store.readRun(RUN_ID));
    const isolated = new SchedulerPlanCritiqueAuthority(frozen);
    assert.throws(
      () => isolated.submitFindings(submitInput({ sessionId: "plan-critic:other", findings: [] })),
      { message: "Plan critique findings were not durably projected." },
    );
  });
});
