import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerEventType,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { VerifierCriterionVerdict } from "../src/verifier-contracts.js";
import { SchedulerVerifierVerdictAuthority } from "../src/verifier-verdict-authority.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";

const RUN_ID = "run-verifier-contract";
const REVISION = "a".repeat(40);
const FINAL_TASK_ID = "final-verification";
const GENERATION_ID = "final-generation";
const REVIEW_ID = "verifier-review-1";
const SESSION_ID = "verifier:run-verifier-contract:session";
const CRITERIA = [
  { taskId: "task-api", criterionId: "shared" },
  { taskId: "task-api", criterionId: "typed" },
  { taskId: "task-ui", criterionId: "shared" },
];

test("verifier request and criterion-complete verdict are durable and derive the overall result", () => {
  const fixture = createFixture("positive");
  try {
    const authority = new SchedulerVerifierVerdictAuthority(fixture.store);
    const request = verifierRequestPayload();
    authority.requestReview({
      runId: RUN_ID,
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      finalVerificationGenerationId: GENERATION_ID,
      runtime: request.runtime as {
        runtimeId: string;
        providerId: string;
        modelId: string;
        modelIdentity: string;
        sessionId: string;
      },
      excludedModels: request.excludedModels as Array<{
        source: "architect" | "accepted_change_author";
        runtimeId: string;
        modelIdentity: string;
      }>,
      criteria: CRITERIA,
      occurredAt: "2026-08-27T00:00:00.000Z",
    });
    authority.submitVerdict({
      runId: RUN_ID,
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      sessionId: SESSION_ID,
      actor: { role: "verifier", id: "google:verifier" },
      criterionVerdicts: CRITERIA.map((criterion, index) => ({
        ...criterion,
        verdict: "satisfied",
        rationale: `Criterion ${index + 1} is satisfied by current evidence.`,
        evidenceIds: [fixture.evidenceIds[index]!],
      })),
      occurredAt: "2026-08-27T00:00:03.000Z",
    });

    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.deepEqual(projection.verifier?.current?.criteria, CRITERIA);
    assert.equal(projection.verifier?.current?.status, "submitted");
    assert.equal(projection.verifier?.current?.verdict?.satisfied, true);
    assert.deepEqual(
      projection.verifier?.current?.verdict?.criterionVerdicts.map(
        ({ taskId, criterionId }) => ({ taskId, criterionId }),
      ),
      CRITERIA,
    );

    fixture.store.close();
    fixture.store = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: fixture.evidenceStore,
      validateCleanupReceipt: () => undefined,
      validateExecutionProfile: acceptFinalVerificationProfile,
    });
    const recovered = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.deepEqual(recovered.verifier, projection.verifier);
  } finally {
    fixture.close();
  }
});

test("verifier request rejects stale revisions, incomplete criteria, and non-independent model identity", () => {
  const scenarios: Array<{
    name: string;
    mutate(payload: Record<string, unknown>): void;
    pattern: RegExp;
  }> = [
    {
      name: "stale-revision",
      mutate: (payload) => { payload.targetRevision = "b".repeat(40); },
      pattern: /stale|revision|current/i,
    },
    {
      name: "omitted-criterion",
      mutate: (payload) => { payload.criteria = CRITERIA.slice(0, -1); },
      pattern: /criterion|criteria|exactly/i,
    },
    {
      name: "architect-model",
      mutate: (payload) => {
        payload.runtime = {
          runtimeId: "openai:verifier-alias",
          providerId: "openai",
          modelId: "openai/architect-model",
          modelIdentity: "architect-model",
          sessionId: SESSION_ID,
        };
      },
      pattern: /independent|excluded|architect|model/i,
    },
    {
      name: "author-model",
      mutate: (payload) => {
        payload.runtime = {
          runtimeId: "broker:author-alias",
          providerId: "broker",
          modelId: "anthropic/author-model",
          modelIdentity: "author-model",
          sessionId: SESSION_ID,
        };
      },
      pattern: /independent|excluded|author|model/i,
    },
    {
      name: "forged-model-identity",
      mutate: (payload) => {
        payload.runtime = {
          runtimeId: "google:verifier",
          providerId: "google",
          modelId: "google/verifier-model",
          modelIdentity: "forged-independent-name",
          sessionId: SESSION_ID,
        };
      },
      pattern: /identity|model/i,
    },
  ];

  for (const scenario of scenarios) {
    const fixture = createFixture(scenario.name);
    try {
      const payload = verifierRequestPayload();
      scenario.mutate(payload);
      assert.throws(
        () => fixture.store.append(event(
          "verifier.review_requested",
          `verifier:request:${scenario.name}`,
          payload,
          { role: "runner", id: "native-verifier-runtime" },
        )),
        scenario.pattern,
      );
      assert.equal(
        rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).verifier,
        undefined,
      );
    } finally {
      fixture.close();
    }
  }
});

test("failed or unapproved final verification stays blocked before any verifier model review", () => {
  const fixture = createFixture("p2-blocked", { approveFinalReview: false });
  try {
    assert.throws(
      () => appendVerifierRequest(fixture.store),
      /green final verification|structured architect approval/i,
    );
    assert.equal(
      rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).verifier,
      undefined,
    );
  } finally {
    fixture.close();
  }
});

test("verifier actor has no scheduler lifecycle authority outside typed verdict submission", () => {
  const fixture = createFixture("no-lifecycle");
  try {
    assert.throws(
      () => fixture.store.append(event(
        "run.paused",
        "verifier:forged-pause",
        { reason: "forged" },
        { role: "verifier", id: "google:verifier" },
      )),
      /no scheduler lifecycle authority/i,
    );
    assert.equal(
      rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).status,
      "running",
    );
  } finally {
    fixture.close();
  }
});

test("verifier verdict rejects forged authority, stale binding, and criterion omissions or duplication", () => {
  const scenarios: Array<{
    name: string;
    mutate(input: {
      payload: Record<string, unknown>;
      actor: { role: "verifier" | "runner"; id: string };
    }): void;
    pattern: RegExp;
  }> = [
    {
      name: "wrong-actor",
      mutate: (input) => { input.actor = { role: "runner", id: "google:verifier" }; },
      pattern: /verifier.*submit|actor|authority/i,
    },
    {
      name: "wrong-runtime",
      mutate: (input) => { input.actor = { role: "verifier", id: "other:runtime" }; },
      pattern: /runtime|identity|verifier/i,
    },
    {
      name: "wrong-session",
      mutate: (input) => { input.payload.sessionId = "verifier:wrong-session"; },
      pattern: /session|stale|foreign/i,
    },
    {
      name: "stale-revision",
      mutate: (input) => { input.payload.targetRevision = "b".repeat(40); },
      pattern: /revision|stale|foreign/i,
    },
    {
      name: "omitted-criterion",
      mutate: (input) => {
        input.payload.criterionVerdicts = completeVerdicts().slice(0, -1);
      },
      pattern: /criterion|criteria|exactly/i,
    },
    {
      name: "duplicate-criterion",
      mutate: (input) => {
        const verdicts = completeVerdicts();
        input.payload.criterionVerdicts = [...verdicts, verdicts[0]];
      },
      pattern: /duplicate|exactly|criterion/i,
    },
    {
      name: "empty-evidence",
      mutate: (input) => {
        const verdicts = completeVerdicts();
        verdicts[0] = { ...verdicts[0]!, evidenceIds: [] };
        input.payload.criterionVerdicts = verdicts;
      },
      pattern: /evidence/i,
    },
  ];

  for (const scenario of scenarios) {
    const fixture = createFixture(scenario.name);
    try {
      appendVerifierRequest(fixture.store);
      const input = {
        payload: verdictPayload(completeVerdicts(fixture.evidenceIds)),
        actor: { role: "verifier" as const, id: "google:verifier" },
      };
      scenario.mutate(input);
      assert.throws(
        () => fixture.store.append(event(
          "verifier.verdict_submitted",
          `verifier:verdict:${scenario.name}`,
          input.payload,
          input.actor,
        )),
        scenario.pattern,
      );
      assert.equal(
        rebuildSchedulerProjection(fixture.store.readRun(RUN_ID))
          .verifier?.current?.status,
        "requested",
      );
    } finally {
      fixture.close();
    }
  }
});

test("criteria added after review request make the pending verifier verdict stale", () => {
  const fixture = createFixture("criteria-changed");
  try {
    appendVerifierRequest(fixture.store);
    fixture.store.append(event(
      "plan.reconciled",
      "plan:add-follow-up",
      {
        revision: 2,
        summary: "Add a newly discovered compatibility requirement.",
        taskUpdates: [],
        newTasks: [{
          id: "task-compatibility",
          objective: "Implement compatibility behavior",
          dependencies: ["task-api"],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{
            id: "compatibility",
            text: "The compatibility behavior works.",
          }],
        }],
      },
      { role: "architect", id: "openai:architect" },
    ));

    assert.throws(
      () => fixture.store.append(verdictEvent({
        criterionVerdicts: completeVerdicts(fixture.evidenceIds),
      })),
      /criterion|criteria|stale|integrated/i,
    );
    assert.equal(
      rebuildSchedulerProjection(fixture.store.readRun(RUN_ID))
        .verifier?.current?.status,
      "requested",
    );
  } finally {
    fixture.close();
  }
});

test("an unsatisfied criterion persists as a negative verdict instead of being discarded", () => {
  const fixture = createFixture("negative");
  try {
    appendVerifierRequest(fixture.store);
    const verdicts = completeVerdicts(fixture.evidenceIds);
    verdicts[1] = {
      ...verdicts[1]!,
      verdict: "unsatisfied",
      rationale: "The typed boundary still accepts malformed input.",
    };
    fixture.store.append(verdictEvent({ criterionVerdicts: verdicts }));

    const verdict = rebuildSchedulerProjection(
      fixture.store.readRun(RUN_ID),
    ).verifier?.current?.verdict;
    assert.equal(verdict?.satisfied, false);
    assert.equal(verdict?.criterionVerdicts[1]?.verdict, "unsatisfied");
  } finally {
    fixture.close();
  }
});

test("verifier verdict evidence must exist in the authoritative run and replay requires that authority", () => {
  const fixture = createFixture("evidence");
  try {
    appendVerifierRequest(fixture.store);
    const verdicts = completeVerdicts(fixture.evidenceIds);
    verdicts[0] = { ...verdicts[0]!, evidenceIds: ["evidence_missing"] };
    assert.throws(
      () => fixture.store.append(verdictEvent({ criterionVerdicts: verdicts })),
      /evidence|missing|foreign/i,
    );

    fixture.store.append(verdictEvent({
      criterionVerdicts: completeVerdicts(fixture.evidenceIds),
    }));
    fixture.store.close();

    const withoutAuthority = new SqliteSchedulerStore(fixture.database, {
      validateCleanupReceipt: () => undefined,
      validateExecutionProfile: acceptFinalVerificationProfile,
    });
    try {
      assert.throws(
        () => withoutAuthority.readRun(RUN_ID),
        /authoritative evidence store/i,
      );
    } finally {
      withoutAuthority.close();
    }
    fixture.store = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: fixture.evidenceStore,
      validateCleanupReceipt: () => undefined,
      validateExecutionProfile: acceptFinalVerificationProfile,
    });
    assert.equal(
      rebuildSchedulerProjection(fixture.store.readRun(RUN_ID))
        .verifier?.current?.verdict?.satisfied,
      true,
    );
  } finally {
    fixture.close();
  }
});

interface Fixture {
  root: string;
  database: string;
  evidenceStore: SqliteEvidenceStore;
  store: SqliteSchedulerStore;
  evidenceIds: string[];
  close(): void;
}

function createFixture(
  name: string,
  options: { approveFinalReview?: boolean } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), `aiboard-verifier-contract-${name}-`));
  const database = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store = new SqliteSchedulerStore(database, {
    evidenceStore,
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  store.append(event("run.initialized", "run:init", {}));
  store.append(event("plan.created", "plan:1", {
    revision: 1,
    tasks: [
      {
        id: "task-api",
        objective: "Implement the API",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [
          { id: "shared", text: "The API meets its user-visible behavior." },
          { id: "typed", text: "The API rejects malformed input." },
        ],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      },
      {
        id: "task-ui",
        objective: "Implement the UI",
        dependencies: ["task-api"],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [
          { id: "shared", text: "The UI exposes the requested workflow." },
        ],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      },
    ],
  }, { role: "architect", id: "openai:architect" }));
  store.append(event("integration.revision_advanced", "integration:1", {
    integrationRevision: REVISION,
  }));
  store.append(event("final_verification.generation_created", "final:generation", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    planVersion: 1,
    plan: finalPlan(),
    executionProfile: emptyFinalVerificationProfile(REVISION),
  }));
  for (const check of finalPlan().checks) {
    store.append(event(
      "final_verification.check_completed",
      `final:check:${check.category}`,
      {
        taskId: FINAL_TASK_ID,
        generationId: GENERATION_ID,
        targetRevision: REVISION,
        attempt: 1,
        workspacePath: "C:/independent-final-verification",
        startedAt: "2026-08-27T00:00:00.000Z",
        finishedAt: "2026-08-27T00:00:01.000Z",
        result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] },
      },
    ));
  }
  store.append(event("final_verification.submitted", "final:submitted", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
    submissionId: "final-submission",
    submissionResult: {
      kind: "final_verification_submission",
      generationId: GENERATION_ID,
      runId: RUN_ID,
      taskId: FINAL_TASK_ID,
      attempt: 1,
      targetRevision: REVISION,
      plan: finalPlan(),
      executionProfile: emptyFinalVerificationProfile(REVISION),
      checks: finalPlan().checks.map((check) => ({
        ...check,
        green: true,
        evidenceIds: [],
        facts: [],
      })),
      evidenceIds: [],
      submittedAt: "2026-08-27T00:00:01.000Z",
      green: true,
    },
  }));
  store.append(event("final_verification.cleanup_started", "final:cleanup:start", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
  }));
  store.append(event("final_verification.cleanup_succeeded", "final:cleanup:done", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
  }));
  store.append(event("final_verification.review_requested", "final:review:request", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
    submissionId: "final-submission",
    reviewId: "final-review",
  }));
  if (options.approveFinalReview !== false) {
    store.append(event("final_verification.review_decided", "final:review:approved", {
      taskId: FINAL_TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      attempt: 1,
      submissionId: "final-submission",
      reviewId: "final-review",
      decision: "approved",
      summary: "Every final-verification category is approved.",
      categoryReviews: finalPlan().checks.map((check) => ({
        category: check.category,
        verdict: "approved",
        rationale: `${check.category} is current and green.`,
        evidenceIds: [],
      })),
    }, { role: "architect", id: "openai:architect" }));
  }

  const evidenceIds = CRITERIA.map((criterion, index) => evidenceStore.record({
    runId: RUN_ID,
    taskId: criterion.taskId,
    actor: { role: "verifier", id: "google:verifier" },
    fact: {
      kind: "browser_screenshot",
      label: `${criterion.taskId}:${criterion.criterionId}`,
      capturedAt: "2026-08-27T00:00:02.000Z",
      screenshotArtifactHash: `${index + 1}`.repeat(64),
      mediaType: "image/png",
      byteLength: 16,
    },
    createdAt: "2026-08-27T00:00:02.000Z",
    idempotencyKey: `verifier-evidence-${index}`,
    attempt: 1,
  }).id);

  return {
    root,
    database,
    evidenceStore,
    get store() { return store; },
    set store(value) { store = value; },
    evidenceIds,
    close: () => {
      try { store.close(); } catch { /* already closed for replay check */ }
      evidenceStore.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function appendVerifierRequest(store: SqliteSchedulerStore): void {
  store.append(event(
    "verifier.review_requested",
    "verifier:request",
    verifierRequestPayload(),
    { role: "runner", id: "native-verifier-runtime" },
  ));
}

function verifierRequestPayload(): Record<string, unknown> {
  return {
    reviewId: REVIEW_ID,
    targetRevision: REVISION,
    finalVerificationGenerationId: GENERATION_ID,
    runtime: {
      runtimeId: "google:verifier",
      providerId: "google",
      modelId: "google/verifier-model",
      modelIdentity: "verifier-model",
      sessionId: SESSION_ID,
    },
    excludedModels: [
      {
        source: "architect",
        runtimeId: "openai:architect",
        modelIdentity: "architect-model",
      },
      {
        source: "accepted_change_author",
        runtimeId: "anthropic:author",
        modelIdentity: "author-model",
      },
    ],
    criteria: CRITERIA,
  };
}

function completeVerdicts(
  evidenceIds = ["evidence-1", "evidence-2", "evidence-3"],
): VerifierCriterionVerdict[] {
  return CRITERIA.map((criterion, index) => ({
    ...criterion,
    verdict: "satisfied",
    rationale: `Criterion ${index + 1} is satisfied.`,
    evidenceIds: [evidenceIds[index]!],
  }));
}

function verdictPayload(criterionVerdicts: ReturnType<typeof completeVerdicts>) {
  return {
    reviewId: REVIEW_ID,
    targetRevision: REVISION,
    sessionId: SESSION_ID,
    criterionVerdicts,
  };
}

function verdictEvent(input: {
  criterionVerdicts: ReturnType<typeof completeVerdicts>;
}): NewSchedulerEvent {
  return event(
    "verifier.verdict_submitted",
    "verifier:verdict",
    verdictPayload(input.criterionVerdicts),
    { role: "verifier", id: "google:verifier" },
  );
}

function finalPlan(): FinalVerificationPlan {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category: category as "build" | "tests" | "runtime_smoke" | "browser",
      status: "not_applicable" as const,
      rationale: `No ${category} fixture is configured.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `No ${category} fixture is configured.`,
      },
    })),
  };
}

function event(
  type: SchedulerEventType,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  actor: NewSchedulerEvent["actor"] = { role: "runner", id: "runner-test" },
): NewSchedulerEvent {
  return {
    runId: RUN_ID,
    type,
    occurredAt: "2026-08-27T00:00:00.000Z",
    actor,
    idempotencyKey,
    payload,
  };
}
