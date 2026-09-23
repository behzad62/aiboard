import assert from "node:assert/strict";
import test from "node:test";

import type { IndependentVerifierDriver } from "../src/build-runtime.js";
import { ContextManifestRecordingError } from "../src/context-manifest-store.js";
import {
  buildCompletionReadiness,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { assessBuildRisk, type BuildRiskAssessmentInput } from "../src/risk-policy.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  parseVerifierCriterionVerdicts,
  parseVerifierExpectations,
  parseVerifierReviewRequest,
  parseVerifierVerdict,
  type VerifierCriterionVerdict,
  type VerifierReviewProjection,
} from "../src/verifier-contracts.js";
import { SchedulerVerifierVerdictAuthority } from "../src/verifier-verdict-authority.js";
import { acceptFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  appendVerifierRequest,
  createFixture,
  createRuntime,
  CRITERIA,
  event,
  GENERATION_ID,
  REVIEW_ID,
  REVISION,
  RUN_ID,
  SESSION_ID,
  verifierRequestPayload,
} from "./support/verifier-run-fixture.js";

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

test("risk-based policy blocks completion until risk is current and a high-risk verdict is positive", () => {
  const fixture = createFixture("completion-gate");
  try {
    appendVerifierPolicy(fixture.store);
    let projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.deepEqual(buildCompletionReadiness(projection), {
      ready: false,
      issues: ["A current build-risk assessment is required."],
    });

    appendRiskAssessment(fixture.store, highRiskInput(), "risk:high");
    projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(buildCompletionReadiness(projection).ready, false);
    assert.match(
      buildCompletionReadiness(projection).issues.join(" "),
      /positive.*independent verifier|verifier.*positive/i,
    );

    appendVerifierRequest(fixture.store);
    fixture.store.append(verdictEvent({
      criterionVerdicts: completeVerdicts(fixture.evidenceIds),
    }));
    projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(buildCompletionReadiness(projection).ready, true);
  } finally {
    fixture.close();
  }
});

test("low-risk current assessment permits completion without an independent verdict", () => {
  const fixture = createFixture("low-risk-completion");
  try {
    appendVerifierPolicy(fixture.store);
    appendRiskAssessment(fixture.store, lowRiskInput(), "risk:low");
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.buildRisk?.current?.assessment.risk, "low");
    assert.equal(buildCompletionReadiness(projection).ready, true);
  } finally {
    fixture.close();
  }
});

test("strict qualification durably raises an otherwise low-risk build", () => {
  const fixture = createFixture("strict-qualification");
  try {
    appendVerifierPolicy(fixture.store, true);
    assert.throws(
      () => appendRiskAssessment(fixture.store, lowRiskInput(), "risk:weakened"),
      /qualification.*policy|policy.*qualification/i,
    );
    const strictInput = {
      ...lowRiskInput(),
      stricterQualification: true,
    };
    appendRiskAssessment(fixture.store, strictInput, "risk:strict");
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(
      projection.verifierPolicy?.alwaysRequireIndependentVerifier,
      true,
    );
    assert.equal(projection.buildRisk?.current?.assessment.risk, "high");
    assert.equal(buildCompletionReadiness(projection).ready, false);
  } finally {
    fixture.close();
  }
});

test("negative verifier verdict remains a completion blocker", () => {
  const fixture = createFixture("negative-completion");
  try {
    appendVerifierPolicy(fixture.store);
    appendRiskAssessment(fixture.store, highRiskInput(), "risk:high");
    appendVerifierRequest(fixture.store);
    const verdicts = completeVerdicts(fixture.evidenceIds);
    verdicts[0] = {
      ...verdicts[0]!,
      verdict: "unsatisfied",
      rationale: "The high-risk behavior remains incomplete.",
    };
    fixture.store.append(verdictEvent({ criterionVerdicts: verdicts }));
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.verifier?.current?.verdict?.satisfied, false);
    assert.equal(buildCompletionReadiness(projection).ready, false);
    assert.match(
      buildCompletionReadiness(projection).issues.join(" "),
      /positive.*independent verifier|unsatisfied/i,
    );
  } finally {
    fixture.close();
  }
});

test("integration advancement preserves and invalidates prior risk and verifier verdict history", () => {
  const fixture = createFixture("revision-invalidation");
  try {
    appendVerifierPolicy(fixture.store);
    appendRiskAssessment(fixture.store, highRiskInput(), "risk:high");
    appendVerifierRequest(fixture.store);
    const verdicts = completeVerdicts(fixture.evidenceIds);
    verdicts[2] = {
      ...verdicts[2]!,
      verdict: "unsatisfied",
      rationale: "The UI has a revision-bound defect.",
    };
    fixture.store.append(verdictEvent({ criterionVerdicts: verdicts }));
    const nextRevision = "b".repeat(40);
    fixture.store.append(event("integration.revision_advanced", "integration:2", {
      integrationRevision: nextRevision,
      previousIntegrationRevision: REVISION,
    }));

    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.verifier?.current, undefined);
    assert.equal(projection.verifier?.history.length, 1);
    assert.equal(projection.verifier?.history[0]?.state, "invalidated");
    assert.equal(projection.verifier?.history[0]?.invalidatedByRevision, nextRevision);
    assert.equal(projection.verifier?.history[0]?.verdict?.satisfied, false);
    assert.equal(projection.buildRisk?.current, undefined);
    assert.equal(projection.buildRisk?.history[0]?.state, "invalidated");
    assert.equal(projection.buildRisk?.history[0]?.invalidatedByRevision, nextRevision);
  } finally {
    fixture.close();
  }
});

test("risk assessment is recomputed by the kernel and cannot be lowered for one revision", () => {
  const fixture = createFixture("risk-integrity");
  try {
    appendVerifierPolicy(fixture.store);
    appendRiskAssessment(fixture.store, highRiskInput(), "risk:high");
    assert.throws(
      () => appendRiskAssessment(fixture.store, lowRiskInput(), "risk:downgrade"),
      /lower|downgrade|high risk/i,
    );
    const forged = lowRiskInput();
    assert.throws(
      () => fixture.store.append(event(
        "build.risk_assessed",
        "risk:forged",
        {
          targetRevision: REVISION,
          input: forged,
          assessment: assessBuildRisk(highRiskInput()),
        },
      )),
      /assessment|recompute|conflict/i,
    );
  } finally {
    fixture.close();
  }
});

test("high-risk runtime assesses, verifies, and only then requests completion", async () => {
  const fixture = createFixture("runtime-positive");
  let verifierCalls = 0;
  let completionCalls = 0;
  try {
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async () => {
        verifierCalls += 1;
        appendVerifierRequest(fixture.store);
        fixture.store.append(verdictEvent({
          criterionVerdicts: completeVerdicts(fixture.evidenceIds),
        }));
        return { status: "verdict_submitted" };
      },
    };
    const runtime = createRuntime(fixture.store, verifier, async (request) => {
      assert.equal(request.reason.type, "completion_decision_required");
      completionCalls += 1;
      const result = await request.tools.invoke({
        type: "tool_call",
        callId: "complete-after-verifier",
        name: "complete_run",
        arguments: { summary: "The independently verified build is ready." },
      }, request.context);
      assert.equal(result.isError, false, result.error?.message ?? "Completion failed");
    });

    assert.equal((await runtime.step()).action, "build_risk_assessed");
    assert.equal(completionCalls, 0);
    assert.equal((await runtime.step()).action, "verifier_verdict_submitted");
    assert.equal(completionCalls, 0);
    const completed = await runtime.step();
    assert.equal(completed.status, "paused");
    assert.equal(completed.action, "completion_decision_required");
    assert.equal(runtime.projection().projectHandoff?.status, "requested");
    assert.equal(verifierCalls, 1);
    assert.equal(completionCalls, 1);
  } finally {
    fixture.close();
  }
});

test("verifier context recording failure pauses with the target revision and no completion", async () => {
  const fixture = createFixture("runtime-recording");
  const failure = new ContextManifestRecordingError({
    runId: RUN_ID,
    sessionId: "verifier:session",
    purpose: "verifier:verdict",
    attempts: 3,
  }, new Error("sqlite locked"));
  let completionCalls = 0;
  try {
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async () => {
        throw failure;
      },
    };
    const runtime = createRuntime(fixture.store, verifier, async () => {
      completionCalls += 1;
    });
    assert.equal((await runtime.step()).action, "build_risk_assessed");
    const paused = await runtime.step();
    assert.equal(paused.status, "paused");
    assert.equal(paused.action, "context_recording_failed");
    const notes = fixture.store.readRun(RUN_ID).filter((event) => event.type === "context_manifest.recording_failed");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.payload.purpose, "verifier:verdict");
    assert.equal(notes[0]?.payload.attempts, 3);
    assert.equal(notes[0]?.payload.reason, failure.message);
    assert.equal(notes[0]?.payload.revision, REVISION);
    assert.equal(completionCalls, 0);
    assert.equal(runtime.projection().pauseReason?.reason, "context_recording_failed");
  } finally {
    fixture.close();
  }
});

test("unavailable independent verification creates a typed user-selection pause", async () => {
  const fixture = createFixture("runtime-unavailable");
  try {
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier", "fallback:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async () => ({
        status: "unavailable",
        reason: "no_independent_healthy_capability_match",
      }),
    };
    const runtime = createRuntime(fixture.store, verifier, async () => {
      assert.fail("Completion must not run without an independent verifier.");
    });

    assert.equal((await runtime.step()).action, "build_risk_assessed");
    const paused = await runtime.step();
    assert.equal(paused.status, "paused");
    assert.equal(paused.action, "verifier_selection_required");
    assert.deepEqual(runtime.projection().verifierSelection, {
      status: "required",
      reason: "no_independent_healthy_capability_match",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["google:verifier", "fallback:verifier"],
    });
    assert.equal(runtime.projection().projectHandoff, undefined);
  } finally {
    fixture.close();
  }
});

test("verifier budget exhaustion creates a typed user-selection pause", async () => {
  const fixture = createFixture("runtime-budget-exhausted");
  try {
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier", "fallback:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async () => ({
        status: "suspended",
        reason: "budget_exhausted",
        runtimeId: "google:verifier",
      }),
    };
    const runtime = createRuntime(fixture.store, verifier, async () => {
      assert.fail("Completion must not run after verifier budget exhaustion.");
    });

    assert.equal((await runtime.step()).action, "build_risk_assessed");
    const paused = await runtime.step();
    assert.equal(paused.status, "paused");
    assert.equal(paused.action, "verifier_selection_required");
    assert.deepEqual(runtime.projection().verifierSelection, {
      status: "required",
      reason: "budget_exhausted",
      requiredCapabilities: ["code"],
      candidateRuntimeIds: ["google:verifier", "fallback:verifier"],
    });
    assert.equal(runtime.projection().projectHandoff, undefined);
  } finally {
    fixture.close();
  }
});

test("guidance invalidation during verifier execution suppresses stale selection pause", async () => {
  const fixture = createFixture("runtime-guidance-invalidation");
  try {
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async () => {
        fixture.store.append(event(
          "user.guidance_submitted",
          "guidance:during-verifier",
          {
            guidanceId: "guidance-during-verifier",
            text: "Change the public API before completion.",
            version: 1,
            interruptionProtocolVersion: 1,
          },
          { role: "user", id: "local-user" },
        ));
        return { status: "suspended", reason: "cancelled" };
      },
    };
    const runtime = createRuntime(fixture.store, verifier, async () => {
      assert.fail("Stale completion must not run after guidance.");
    });

    assert.equal((await runtime.step()).action, "build_risk_assessed");
    const invalidated = await runtime.step();
    assert.equal(invalidated.status, "progressed");
    assert.equal(invalidated.action, "verifier_invalidated");
    assert.equal(runtime.projection().verifierSelection, undefined);
    assert.equal(runtime.projection().finalVerification?.current, undefined);
    assert.equal(
      runtime.projection().userGuidance["guidance-during-verifier"]?.status,
      "submitted",
    );
  } finally {
    fixture.close();
  }
});

test("provider failure supersedes a pending review with an independent fallback", async () => {
  const fixture = createFixture("runtime-provider-fallback");
  let calls = 0;
  try {
    const authority = new SchedulerVerifierVerdictAuthority(fixture.store);
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier", "fallback:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async () => {
        calls += 1;
        if (calls === 1) {
          requestReviewFor(authority, {
            reviewId: "review-google",
            runtimeId: "google:verifier",
            providerId: "google",
            modelId: "google/verifier-model",
            sessionId: "session-google",
          });
          return {
            status: "suspended",
            reason: "provider_error",
            runtimeId: "google:verifier",
          };
        }
        requestReviewFor(authority, {
          reviewId: "review-fallback",
          runtimeId: "fallback:verifier",
          providerId: "fallback",
          modelId: "fallback/independent-model",
          sessionId: "session-fallback",
        });
        authority.submitVerdict({
          runId: RUN_ID,
          reviewId: "review-fallback",
          targetRevision: REVISION,
          sessionId: "session-fallback",
          actor: { role: "verifier", id: "fallback:verifier" },
          criterionVerdicts: completeVerdicts(fixture.evidenceIds),
          occurredAt: "2026-08-27T00:00:05.000Z",
        });
        return { status: "verdict_submitted" };
      },
    };
    const runtime = createRuntime(fixture.store, verifier, async () => {
      assert.fail("This test stops before the completion request.");
    });

    assert.equal((await runtime.step()).action, "build_risk_assessed");
    assert.equal((await runtime.step()).action, "verifier_provider_failed");
    assert.equal((await runtime.step()).action, "verifier_verdict_submitted");
    const projection = runtime.projection();
    assert.equal(projection.verifier?.current?.reviewId, "review-fallback");
    assert.equal(projection.verifier?.current?.verdict?.satisfied, true);
    assert.equal(projection.verifier?.history[0]?.reviewId, "review-google");
    assert.equal(projection.verifier?.history[0]?.state, "superseded");
    assert.equal(
      projection.verifier?.history[0]?.supersededByReviewId,
      "review-fallback",
    );
  } finally {
    fixture.close();
  }
});

test("typed verifier selection resumes with the selected runtime", async () => {
  const fixture = createFixture("runtime-selection-resume");
  let preferredRuntimeId: string | undefined;
  try {
    const authority = new SchedulerVerifierVerdictAuthority(fixture.store);
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier", "fallback:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async (request) => {
        preferredRuntimeId = request.preferredRuntimeId;
        if (!request.preferredRuntimeId) {
          return {
            status: "unavailable",
            reason: "no_independent_healthy_capability_match",
          };
        }
        requestReviewFor(authority, {
          reviewId: "review-selected",
          runtimeId: request.preferredRuntimeId,
          providerId: "fallback",
          modelId: "fallback/independent-model",
          sessionId: "session-selected",
        });
        authority.submitVerdict({
          runId: RUN_ID,
          reviewId: "review-selected",
          targetRevision: REVISION,
          sessionId: "session-selected",
          actor: { role: "verifier", id: request.preferredRuntimeId },
          criterionVerdicts: completeVerdicts(fixture.evidenceIds),
          occurredAt: "2026-08-27T00:00:05.000Z",
        });
        return { status: "verdict_submitted" };
      },
    };
    const runtime = createRuntime(fixture.store, verifier, async () => {
      assert.fail("This test stops before the completion request.");
    });

    await runtime.step();
    assert.equal((await runtime.step()).status, "paused");
    assert.throws(
      () => runtime.resume("forbidden-generic-resume"),
      /verifier selection/i,
    );
    const selected = runtime.selectVerifierRuntime(
      "fallback:verifier",
      "select:fallback",
    );
    assert.equal(selected.status, "running");
    assert.equal((await runtime.step()).action, "verifier_verdict_submitted");
    assert.equal(preferredRuntimeId, "fallback:verifier");
  } finally {
    fixture.close();
  }
});

test("restart with a durable positive verdict does not invoke the verifier again", async () => {
  const fixture = createFixture("runtime-durable-restart");
  let verifierCalls = 0;
  let completionCalls = 0;
  try {
    appendVerifierPolicy(fixture.store);
    appendRiskAssessment(fixture.store, highRiskInput(), "risk:restart");
    appendVerifierRequest(fixture.store);
    fixture.store.append(verdictEvent({
      criterionVerdicts: completeVerdicts(fixture.evidenceIds),
    }));
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier"],
      assessRisk: async () => {
        assert.fail("Durable risk must be reused.");
      },
      verify: async () => {
        verifierCalls += 1;
        return { status: "verdict_submitted" };
      },
    };
    const runtime = createRuntime(fixture.store, verifier, async (request) => {
      completionCalls += 1;
      const result = await request.tools.invoke({
        type: "tool_call",
        callId: "complete-after-restart",
        name: "complete_run",
        arguments: { summary: "Recovered verification remains current." },
      }, request.context);
      assert.equal(result.isError, false, result.error?.message ?? "Completion failed");
    });

    assert.equal((await runtime.step()).action, "completion_decision_required");
    assert.equal(verifierCalls, 0);
    assert.equal(completionCalls, 1);
  } finally {
    fixture.close();
  }
});

test("negative verdict creates exact Architect-owned verifier repair work", async () => {
  const fixture = createFixture("runtime-negative-repair");
  let repairCalls = 0;
  try {
    const verifier: IndependentVerifierDriver = {
      candidateRuntimeIds: ["google:verifier"],
      assessRisk: async () => highRiskInput(),
      verify: async () => {
        appendVerifierRequest(fixture.store);
        const verdicts = completeVerdicts(fixture.evidenceIds);
        verdicts[0] = {
          ...verdicts[0]!,
          verdict: "unsatisfied",
          rationale: "The API behavior is incomplete on the integrated revision.",
        };
        fixture.store.append(verdictEvent({ criterionVerdicts: verdicts }));
        return { status: "verdict_submitted" };
      },
    };
    const runtime = createRuntime(fixture.store, verifier, async (request) => {
      assert.equal(request.reason.type, "verifier_repair_plan_required");
      if (request.reason.type !== "verifier_repair_plan_required") return;
      repairCalls += 1;
      assert.deepEqual(request.reason.unsatisfiedCriteria, [{
        taskId: "task-api",
        criterionId: "shared",
        rationale: "The API behavior is incomplete on the integrated revision.",
        evidenceIds: [fixture.evidenceIds[0]!],
      }]);
      const result = await request.tools.invoke({
        type: "tool_call",
        callId: "plan-verifier-repair",
        name: "plan_verifier_repairs",
        arguments: {
          reviewId: REVIEW_ID,
          targetRevision: REVISION,
          tasks: [{
            id: "repair-verifier-api",
            objective: "Repair the API behavior rejected by independent verification.",
            criteria: [{ taskId: "task-api", criterionId: "shared" }],
            evidenceIds: [fixture.evidenceIds[0]!],
            dependencies: [],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{
              id: "repair-api-shared",
              text: "The independently rejected API behavior is repaired.",
            }],
          }],
        },
      }, request.context);
      assert.equal(result.isError, false, result.error?.message ?? "Repair plan failed");
    });

    assert.equal((await runtime.step()).action, "build_risk_assessed");
    assert.equal((await runtime.step()).action, "verifier_verdict_submitted");
    assert.equal((await runtime.step()).action, "verifier_repair_plan_required");
    const projection = runtime.projection();
    assert.equal(repairCalls, 1);
    assert.equal(projection.verifier?.current?.verdict?.satisfied, false);
    assert.deepEqual(projection.verifier?.current?.repairTaskIds, [
      "repair-verifier-api",
    ]);
    assert.deepEqual(
      projection.tasks["repair-verifier-api"]?.verifierRepair,
      {
        sourceReviewId: REVIEW_ID,
        targetRevision: REVISION,
        criteria: [{ taskId: "task-api", criterionId: "shared" }],
        evidenceIds: [fixture.evidenceIds[0]!],
      },
    );
    assert.equal(projection.tasks["repair-verifier-api"]?.status, "planned");
    assert.throws(
      () => fixture.store.append(event(
        "task.transitioned",
        "cancel-current-verifier-repair",
        { taskId: "repair-verifier-api", status: "cancelled" },
        { role: "architect", id: "openai:architect" },
      )),
      /current-generation verification repair cannot be cancelled/i,
    );
  } finally {
    fixture.close();
  }
});

test("verifier repair kernel rejects incomplete, unrelated, duplicated, forged, or mis-evidenced work", () => {
  const scenarios: Array<{
    name: string;
    mutate(payload: Record<string, unknown>): void;
    actor?: NewSchedulerEvent["actor"];
    pattern: RegExp;
  }> = [
    {
      name: "omitted",
      mutate: () => undefined,
      pattern: /cover every unsatisfied criterion/i,
    },
    {
      name: "satisfied",
      mutate: (payload) => {
        (payload.tasks as Array<Record<string, unknown>>)[0]!.criteria = [{
          taskId: "task-api",
          criterionId: "typed",
        }];
      },
      pattern: /satisfied|unknown|duplicated/i,
    },
    {
      name: "duplicate",
      mutate: (payload) => {
        const task = (payload.tasks as Array<Record<string, unknown>>)[0]!;
        payload.tasks = [
          task,
          { ...structuredClone(task), id: "repair-duplicate" },
        ];
      },
      pattern: /duplicated/i,
    },
    {
      name: "wrong-evidence",
      mutate: (payload) => {
        (payload.tasks as Array<Record<string, unknown>>)[0]!.evidenceIds = [
          "replace-with-existing-evidence",
        ];
      },
      pattern: /exactly.*evidence|missing|foreign/i,
    },
    {
      name: "wrong-actor",
      mutate: () => undefined,
      actor: { role: "runner", id: "forged-architect" },
      pattern: /only the architect/i,
    },
  ];
  for (const scenario of scenarios) {
    const fixture = createFixture(`repair-guard-${scenario.name}`);
    try {
      appendVerifierRequest(fixture.store);
      const verdicts = completeVerdicts(fixture.evidenceIds);
      verdicts[0] = {
        ...verdicts[0]!,
        verdict: "unsatisfied",
        rationale: "The API behavior is incomplete.",
      };
      if (scenario.name === "omitted") {
        verdicts[1] = {
          ...verdicts[1]!,
          verdict: "unsatisfied",
          rationale: "The typed rejection behavior is also incomplete.",
        };
      }
      fixture.store.append(verdictEvent({ criterionVerdicts: verdicts }));
      const payload: Record<string, unknown> = {
        reviewId: REVIEW_ID,
        targetRevision: REVISION,
        revision: 2,
        tasks: [{
          id: "repair-api",
          objective: "Repair the rejected API behavior.",
          criteria: [{ taskId: "task-api", criterionId: "shared" }],
          evidenceIds: [fixture.evidenceIds[0]!],
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{
            id: "repair-api",
            text: "The rejected API behavior is repaired.",
          }],
        }],
      };
      scenario.mutate(payload);
      if (scenario.name === "wrong-evidence") {
        (payload.tasks as Array<Record<string, unknown>>)[0]!.evidenceIds = [
          fixture.evidenceIds[1]!,
        ];
      }
      assert.throws(
        () => fixture.store.append(event(
          "verifier.repairs_planned",
          `verifier-repair:${scenario.name}`,
          payload,
          scenario.actor ?? { role: "architect", id: "openai:architect" },
        )),
        scenario.pattern,
      );
      assert.equal(
        rebuildSchedulerProjection(fixture.store.readRun(RUN_ID))
          .verifier?.current?.repairTaskIds,
        undefined,
      );
    } finally {
      fixture.close();
    }
  }
});

test("verifier expectations cover every criterion exactly once with concrete behaviors and edge cases", () => {
  const criteria = [{ taskId: "task_ui", criterionId: "criterion_ui" }];
  const parsed = parseVerifierExpectations([{
    taskId: "task_ui", criterionId: "criterion_ui",
    expectedBehaviors: ["The membership card renders the organization name."],
    edgeCases: ["No memberships", "Two memberships with the same user id"],
    regressionSurfaces: ["src/app.ts render path"],
    requiredTests: ["MembershipCardRendersOrganization"],
  }], criteria);
  assert.equal(parsed.length, 1);
  assert.throws(() => parseVerifierExpectations([], criteria), /must represent every build criterion exactly once/);
  assert.throws(() => parseVerifierExpectations([{
    taskId: "task_ui", criterionId: "criterion_ui", expectedBehaviors: [], edgeCases: ["x"], regressionSurfaces: [], requiredTests: [],
  }], criteria), /expectedBehaviors requires at least one entry/);
});

test("duplicate verifier expectations are rejected separately from a missing criterion", () => {
  const criteria = [{ taskId: "task_ui", criterionId: "criterion_ui" }];
  const entry = {
    taskId: "task_ui", criterionId: "criterion_ui",
    expectedBehaviors: ["renders the name"],
    edgeCases: ["empty"],
    regressionSurfaces: [],
    requiredTests: [],
  };
  assert.throws(
    () => parseVerifierExpectations([entry, { ...entry }], criteria),
    /contains duplicate criteria/,
  );
  assert.throws(
    () => parseVerifierExpectations([{
      ...entry,
      criterionId: "criterion_other",
    }], criteria),
    /must represent every build criterion exactly once/,
  );
});

test("verifier expectations reject a missing edge case independently of behaviors", () => {
  const criteria = [{ taskId: "task_ui", criterionId: "criterion_ui" }];
  assert.throws(() => parseVerifierExpectations([{
    taskId: "task_ui", criterionId: "criterion_ui",
    expectedBehaviors: ["renders the name"],
    edgeCases: [],
    regressionSurfaces: [],
    requiredTests: [],
  }], criteria), /edgeCases requires at least one entry/);
  const parsed = parseVerifierExpectations([{
    taskId: "task_ui", criterionId: "criterion_ui",
    expectedBehaviors: ["renders the name"],
    edgeCases: ["empty"],
    regressionSurfaces: [],
    requiredTests: [],
  }], criteria);
  assert.deepEqual(parsed[0]?.regressionSurfaces, []);
  assert.deepEqual(parsed[0]?.requiredTests, []);
});

test("an unsatisfied two-pass verdict carries a location and reproduction steps", () => {
  const verdict = parseVerifierCriterionVerdicts([{
    taskId: "task_ui", criterionId: "criterion_ui", verdict: "unsatisfied",
    rationale: "Invalidation ignores the organization id.", evidenceIds: ["evidence_ui"],
    location: { path: "src/membership-service.ts", lines: "118-132" },
    reproduction: ["Create the same user in two organizations", "Remove membership in A", "Observe B's cache entry removed"],
  }]);
  assert.deepEqual(verdict[0]?.location, { path: "src/membership-service.ts", lines: "118-132" });
  assert.equal(verdict[0]?.reproduction?.length, 3);
  assert.throws(() => parseVerifierCriterionVerdicts([{
    taskId: "task_ui", criterionId: "criterion_ui", verdict: "unsatisfied", rationale: "x", evidenceIds: ["e"],
    location: { path: "" },
  }]), /location path must be non-empty/);
});

test("a satisfied verdict may omit location and reproduction", () => {
  const [verdict] = parseVerifierCriterionVerdicts([criterionVerdictInput()]);
  assert.equal(verdict?.location, undefined);
  assert.equal(verdict?.reproduction, undefined);
  assert.equal(Object.hasOwn(verdict!, "location"), false);
  assert.equal(Object.hasOwn(verdict!, "reproduction"), false);
});

test("location lines and reproduction entries are validated when present", () => {
  const [verdict] = parseVerifierCriterionVerdicts([criterionVerdictInput({
    location: { path: "src/app.ts" },
  })]);
  assert.deepEqual(verdict?.location, { path: "src/app.ts" });
  assert.equal(Object.hasOwn(verdict!.location!, "lines"), false);
  assert.throws(
    () => parseVerifierCriterionVerdicts([criterionVerdictInput({
      location: { path: "src/app.ts", lines: "abc" },
    })]),
    /location lines/,
  );
  assert.throws(
    () => parseVerifierCriterionVerdicts([criterionVerdictInput({
      reproduction: [""],
    })]),
    /reproduction/,
  );
});

const BASELINE = "b".repeat(40);
const EXPECTATIONS_SESSION = "verifier:expectations:pass-1";

test("two-pass verifier verdicts require recorded expectations and reproduction", () => {
  const fixture = createFixture("two-pass-expectations");
  try {
    fixture.store.append(event("verifier.policy_configured", "verifier:policy", {
      mode: "risk_based",
      candidateRuntimeIds: ["google:verifier"],
      alwaysRequireIndependentVerifier: false,
      twoPass: true,
    }));
    appendVerifierRequest(fixture.store, {
      twoPass: true,
      baselineRevision: BASELINE,
    });
    const requested = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(requested.verifierPolicy?.twoPass, true);
    assert.equal(requested.verifier?.current?.twoPass, true);
    assert.equal(requested.verifier?.current?.baselineRevision, BASELINE);

    assert.throws(
      () => fixture.store.append(verdictEvent({
        criterionVerdicts: completeVerdicts(fixture.evidenceIds),
      })),
      /Two-pass verifier verdict requires recorded expectations\./,
    );

    assert.throws(
      () => fixture.store.append(expectationsEvent(fixture, {
        actor: { role: "architect", id: "openai:architect" },
        idempotencyKey: "verifier:expectations:architect",
      })),
      /Only the selected verifier may record expectations\./,
    );
    assert.throws(
      () => fixture.store.append(expectationsEvent(fixture, {
        actor: { role: "verifier", id: "openai:foreign" },
        idempotencyKey: "verifier:expectations:foreign",
      })),
      /does not match the selected runtime identity/,
    );
    assert.throws(
      () => fixture.store.append(expectationsEvent(fixture, {
        reviewId: "verifier-review-other",
        idempotencyKey: "verifier:expectations:review",
      })),
      /stale or foreign to the current review/,
    );
    assert.throws(
      () => fixture.store.append(expectationsEvent(fixture, {
        targetRevision: "c".repeat(40),
        idempotencyKey: "verifier:expectations:target",
      })),
      /stale or foreign to the current review/,
    );
    assert.throws(
      () => fixture.store.append(expectationsEvent(fixture, {
        baselineRevision: "d".repeat(40),
        idempotencyKey: "verifier:expectations:baseline",
      })),
      /stale or foreign to the current review/,
    );
    assert.throws(
      () => fixture.store.append(expectationsEvent(fixture, {
        sessionId: "verifier:other-session",
        expectations: expectationEntries().slice(0, -1),
        idempotencyKey: "verifier:expectations:criteria",
      })),
      /must represent every build criterion exactly once/,
    );

    fixture.store.append(expectationsEvent(fixture, {
      idempotencyKey: "verifier:expectations:first",
    }));
    const recorded = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(recorded.verifier?.current?.expectations?.length, CRITERIA.length);
    assert.equal(recorded.verifier?.current?.expectationsSessionId, EXPECTATIONS_SESSION);

    fixture.store.append(expectationsEvent(fixture, {
      idempotencyKey: "verifier:expectations:repeat",
    }));
    assert.equal(
      rebuildSchedulerProjection(fixture.store.readRun(RUN_ID))
        .verifier?.current?.expectationsSessionId,
      EXPECTATIONS_SESSION,
    );
    assert.throws(
      () => fixture.store.append(expectationsEvent(fixture, {
        sessionId: "verifier:other-session",
        idempotencyKey: "verifier:expectations:conflict-session",
      })),
      /conflict with the recorded expectations/,
    );

    const unsatisfied = completeVerdicts(fixture.evidenceIds);
    unsatisfied[0] = {
      ...unsatisfied[0]!,
      verdict: "unsatisfied",
      rationale: "The organization cache is shared.",
    };
    assert.throws(
      () => fixture.store.append(verdictEvent({ criterionVerdicts: unsatisfied })),
      /Two-pass unsatisfied verdicts require reproduction steps\./,
    );
    unsatisfied[0] = {
      ...unsatisfied[0]!,
      location: { path: "src/membership-service.ts", lines: "118-132" },
      reproduction: ["Create the user twice", "Remove membership in A"],
    };
    fixture.store.append(verdictEvent({ criterionVerdicts: unsatisfied }));
    const submitted = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(submitted.verifier?.current?.status, "submitted");
    assert.equal(submitted.verifier?.current?.verdict?.satisfied, false);
    assert.equal(submitted.verifier?.current?.verdict?.criterionVerdicts[0]?.reproduction?.length, 2);
  } finally {
    fixture.close();
  }
});

test("a legacy review without twoPass accepts a verdict with no expectations", () => {
  const fixture = createFixture("legacy-single-pass");
  try {
    appendVerifierPolicy(fixture.store);
    appendVerifierRequest(fixture.store);
    const requested = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(requested.verifierPolicy?.twoPass, false);
    assert.equal(requested.verifier?.current?.twoPass, undefined);
    assert.equal(requested.verifier?.current?.expectations, undefined);
    fixture.store.append(verdictEvent({
      criterionVerdicts: completeVerdicts(fixture.evidenceIds),
    }));
    const submitted = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(submitted.verifier?.current?.status, "submitted");
    assert.equal(submitted.verifier?.current?.verdict?.satisfied, true);
    assert.equal(submitted.verifier?.current?.expectations, undefined);
  } finally {
    fixture.close();
  }
});

test("recordExpectations persists a bound two-pass review through the verdict authority", () => {
  const fixture = createFixture("authority-expectations");
  try {
    fixture.store.append(event("verifier.policy_configured", "verifier:policy", {
      mode: "risk_based",
      candidateRuntimeIds: ["google:verifier"],
      alwaysRequireIndependentVerifier: false,
      twoPass: true,
    }));
    const authority = new SchedulerVerifierVerdictAuthority(fixture.store);
    const request = verifierRequestPayload({
      twoPass: true,
      baselineRevision: BASELINE,
    });
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
      twoPass: true,
      baselineRevision: BASELINE,
      occurredAt: "2026-08-27T00:00:04.000Z",
    });
    authority.recordExpectations({
      runId: RUN_ID,
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      baselineRevision: BASELINE,
      sessionId: EXPECTATIONS_SESSION,
      actor: { role: "verifier", id: "google:verifier" },
      expectations: expectationEntries(),
      occurredAt: "2026-08-27T00:00:05.000Z",
    });
    const review = authority.currentReview(RUN_ID);
    assert.equal(review?.expectations?.length, CRITERIA.length);
    assert.equal(review?.expectationsSessionId, EXPECTATIONS_SESSION);
    authority.recordExpectations({
      runId: RUN_ID,
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      baselineRevision: BASELINE,
      sessionId: EXPECTATIONS_SESSION,
      actor: { role: "verifier", id: "google:verifier" },
      expectations: expectationEntries(),
      occurredAt: "2026-08-27T00:00:06.000Z",
    });
    assert.throws(
      () => authority.recordExpectations({
        runId: RUN_ID,
        reviewId: REVIEW_ID,
        targetRevision: REVISION,
        baselineRevision: BASELINE,
        sessionId: "verifier:other-session",
        actor: { role: "verifier", id: "google:verifier" },
        expectations: expectationEntries(),
        occurredAt: "2026-08-27T00:00:07.000Z",
      }),
      /conflict|idempotency/,
    );
  } finally {
    fixture.close();
  }
});

test("two-pass review requests require a baseline revision that matches the revision pattern", () => {
  const criteria = [{ taskId: "task_ui", criterionId: "criterion_ui" }];
  const baseline = "b".repeat(40);
  const parsed = parseVerifierReviewRequest(reviewRequestPayload({
    twoPass: true,
    baselineRevision: baseline,
  }), criteria, "2026-08-27T00:00:00.000Z");
  assert.equal(parsed.twoPass, true);
  assert.equal(parsed.baselineRevision, baseline);
  assert.throws(
    () => parseVerifierReviewRequest(reviewRequestPayload({ twoPass: true }), criteria, "2026-08-27T00:00:00.000Z"),
    /baseline revision/i,
  );
  assert.throws(
    () => parseVerifierReviewRequest(reviewRequestPayload({
      twoPass: true,
      baselineRevision: "not-a-revision",
    }), criteria, "2026-08-27T00:00:00.000Z"),
    /baseline revision/i,
  );
  const legacy = parseVerifierReviewRequest(
    reviewRequestPayload(),
    criteria,
    "2026-08-27T00:00:00.000Z",
  );
  assert.equal(legacy.twoPass, undefined);
  assert.equal(legacy.baselineRevision, undefined);
});

function reviewRequestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewId: "review_ui",
    targetRevision: "a".repeat(40),
    finalVerificationGenerationId: "generation_ui",
    runtime: {
      runtimeId: "google:verifier",
      providerId: "google",
      modelId: "google/verifier-model",
      modelIdentity: "verifier-model",
      sessionId: "session_ui",
    },
    excludedModels: [{
      source: "architect",
      runtimeId: "openai:architect",
      modelIdentity: "architect-model",
    }],
    criteria: [{ taskId: "task_ui", criterionId: "criterion_ui" }],
    ...overrides,
  };
}

function criterionVerdictInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    taskId: "task-api",
    criterionId: "shared",
    verdict: "satisfied",
    rationale: "The recorded evidence supports the criterion.",
    evidenceIds: ["evidence-1"],
    ...overrides,
  };
}

test("parseVerifierCriterionVerdicts omits acceptedFailures when the field is absent", () => {
  const [verdict] = parseVerifierCriterionVerdicts([criterionVerdictInput()]);
  assert.equal(verdict!.acceptedFailures, undefined);
  assert.equal(Object.hasOwn(verdict!, "acceptedFailures"), false);
});

test("parseVerifierCriterionVerdicts keeps a valid acceptedFailures entry", () => {
  const [verdict] = parseVerifierCriterionVerdicts([criterionVerdictInput({
    acceptedFailures: [{ evidenceId: "red", rationale: "Intentional pre-fix failure." }],
  })]);
  assert.deepEqual(verdict!.acceptedFailures, [
    { evidenceId: "red", rationale: "Intentional pre-fix failure." },
  ]);
});

test("parseVerifierCriterionVerdicts trims acceptedFailures evidenceId and rationale", () => {
  const [verdict] = parseVerifierCriterionVerdicts([criterionVerdictInput({
    acceptedFailures: [{
      evidenceId: "  red  ",
      rationale: "  Intentional pre-fix failure.  ",
    }],
  })]);
  assert.deepEqual(verdict!.acceptedFailures, [
    { evidenceId: "red", rationale: "Intentional pre-fix failure." },
  ]);
});

test("parseVerifierCriterionVerdicts rejects malformed acceptedFailures", () => {
  const invalid = /acceptedFailures is invalid/;
  const cases: Array<{ name: string; acceptedFailures: unknown }> = [
    { name: "not-array", acceptedFailures: { evidenceId: "red", rationale: "no" } },
    { name: "null-entry", acceptedFailures: [null] },
    { name: "array-entry", acceptedFailures: [["red"]] },
    { name: "non-object-entry", acceptedFailures: ["red"] },
    { name: "missing-evidenceId", acceptedFailures: [{ rationale: "Intentional pre-fix failure." }] },
    { name: "blank-evidenceId", acceptedFailures: [{ evidenceId: "   ", rationale: "Intentional pre-fix failure." }] },
    { name: "missing-rationale", acceptedFailures: [{ evidenceId: "red" }] },
    { name: "blank-rationale", acceptedFailures: [{ evidenceId: "red", rationale: "   " }] },
    {
      name: "duplicate-evidenceId",
      acceptedFailures: [
        { evidenceId: "red", rationale: "first" },
        { evidenceId: "red", rationale: "second" },
      ],
    },
  ];
  for (const scenario of cases) {
    assert.throws(
      () => parseVerifierCriterionVerdicts([
        criterionVerdictInput({ acceptedFailures: scenario.acceptedFailures }),
      ]),
      invalid,
      scenario.name,
    );
  }
});

test("parseVerifierVerdict clones acceptedFailures so mutation cannot alias the source", () => {
  const acceptedFailures = [
    { evidenceId: "red", rationale: "Intentional pre-fix failure." },
  ];
  const payload = {
    reviewId: REVIEW_ID,
    targetRevision: REVISION,
    sessionId: SESSION_ID,
    criterionVerdicts: [criterionVerdictInput({ acceptedFailures })],
  };
  const review: VerifierReviewProjection = {
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
    excludedModels: [],
    criteria: [{ taskId: "task-api", criterionId: "shared" }],
    status: "requested",
    state: "current",
    requestedAt: "2026-08-27T00:00:00.000Z",
  };
  const parsed = parseVerifierVerdict(payload, review, "2026-08-27T00:00:03.000Z");
  const cloned = parsed.criterionVerdicts[0]!.acceptedFailures!;
  assert.deepEqual(cloned, [
    { evidenceId: "red", rationale: "Intentional pre-fix failure." },
  ]);
  assert.notEqual(cloned, acceptedFailures);
  assert.notEqual(cloned[0], acceptedFailures[0]);
  cloned[0]!.rationale = "mutated";
  cloned.push({ evidenceId: "other", rationale: "extra" });
  assert.equal(acceptedFailures[0]!.rationale, "Intentional pre-fix failure.");
  assert.equal(acceptedFailures.length, 1);
});

function requestReviewFor(
  authority: SchedulerVerifierVerdictAuthority,
  runtime: {
    reviewId: string;
    runtimeId: string;
    providerId: string;
    modelId: string;
    sessionId: string;
  },
): void {
  authority.requestReview({
    runId: RUN_ID,
    reviewId: runtime.reviewId,
    targetRevision: REVISION,
    finalVerificationGenerationId: GENERATION_ID,
    runtime: {
      runtimeId: runtime.runtimeId,
      providerId: runtime.providerId,
      modelId: runtime.modelId,
      modelIdentity: runtime.modelId.split("/").at(-1)!,
      sessionId: runtime.sessionId,
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
    occurredAt: "2026-08-27T00:00:04.000Z",
  });
}

function appendVerifierPolicy(
  store: SqliteSchedulerStore,
  alwaysRequireIndependentVerifier = false,
): void {
  store.append(event("verifier.policy_configured", "verifier:policy", {
    mode: "risk_based",
    candidateRuntimeIds: ["google:verifier"],
    alwaysRequireIndependentVerifier,
  }));
}

function appendRiskAssessment(
  store: SqliteSchedulerStore,
  input: BuildRiskAssessmentInput,
  idempotencyKey: string,
): void {
  store.append(event("build.risk_assessed", idempotencyKey, {
    targetRevision: REVISION,
    input,
    assessment: assessBuildRisk(input),
  }));
}

function highRiskInput(): BuildRiskAssessmentInput {
  return {
    architectDeclaration: "low",
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: false,
      credentialEffects: false,
      externalWriteEffects: false,
      integrationConflict: false,
      changedPaths: ["src/auth/session.ts"],
    },
  };
}

function lowRiskInput(): BuildRiskAssessmentInput {
  return {
    architectDeclaration: "low",
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: false,
      credentialEffects: false,
      externalWriteEffects: false,
      integrationConflict: false,
      changedPaths: ["src/components/card.tsx"],
    },
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

function expectationEntries() {
  return CRITERIA.map((criterion) => ({
    taskId: criterion.taskId,
    criterionId: criterion.criterionId,
    expectedBehaviors: [`${criterion.taskId}:${criterion.criterionId} holds.`],
    edgeCases: ["empty"],
    regressionSurfaces: ["src/app.ts"],
    requiredTests: [`${criterion.criterionId} test`],
  }));
}

function expectationsEvent(
  _fixture: { evidenceIds: string[] },
  overrides: {
    actor?: NewSchedulerEvent["actor"];
    idempotencyKey?: string;
    reviewId?: string;
    targetRevision?: string;
    baselineRevision?: string;
    sessionId?: string;
    expectations?: ReturnType<typeof expectationEntries>;
  } = {},
): NewSchedulerEvent {
  return event(
    "verifier.expectations_recorded",
    overrides.idempotencyKey ?? "verifier:expectations",
    {
      reviewId: overrides.reviewId ?? REVIEW_ID,
      targetRevision: overrides.targetRevision ?? REVISION,
      baselineRevision: overrides.baselineRevision ?? BASELINE,
      sessionId: overrides.sessionId ?? EXPECTATIONS_SESSION,
      expectations: overrides.expectations ?? expectationEntries(),
    },
    overrides.actor ?? { role: "verifier", id: "google:verifier" },
  );
}
