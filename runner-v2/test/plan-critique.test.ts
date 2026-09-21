import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createArchitectTools } from "../src/architect-tools.js";
import { assessPlanRisk } from "../src/plan-critique-contracts.js";
import {
  planCritiquePending,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  TaskScheduler,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerRuntimeDriver,
} from "../src/task-scheduler.js";
import type { BuildTask } from "../src/task-contracts.js";
import type { VerifierRuntimeBinding } from "../src/verifier-contracts.js";

const RUN_ID = "run_critique";
const AT = "2026-09-02T00:00:00.000Z";
const USER: NewSchedulerEvent["actor"] = { role: "user", id: "user" };
const ARCHITECT: NewSchedulerEvent["actor"] = { role: "architect", id: "architect_1" };
const RUNNER: NewSchedulerEvent["actor"] = { role: "runner", id: "test" };
const CRITIC: NewSchedulerEvent["actor"] = { role: "verifier", id: "google:verifier" };

class DeferredDriver implements WorkerRuntimeDriver {
  readonly assignments: WorkerAssignment[] = [];
  run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment);
    return new Promise(() => undefined);
  }
}

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

function seededStore(
  root: string,
  options: {
    tasks?: BuildTask[];
    riskDeclaration?: { risk: "low" | "high"; rationale?: string };
    omitRiskDeclaration?: boolean;
  } = {},
): SqliteSchedulerStore {
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  store.append(event("run.initialized", "init", { runId: RUN_ID }));
  const tasks = options.tasks ?? highRiskTasks();
  const payload: Record<string, unknown> = { revision: 1, tasks };
  if (!options.omitRiskDeclaration) {
    payload.riskDeclaration = options.riskDeclaration ?? { risk: "low", rationale: "routine" };
  }
  store.append(event("plan.created", "plan:1", payload, ARCHITECT));
  return store;
}

function withStore(
  fn: (store: SqliteSchedulerStore, append: StoreAppend, projection: () => ReturnType<typeof rebuildSchedulerProjection>) => void,
  options?: Parameters<typeof seededStore>[1],
): void {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-"));
  const store = seededStore(root, options);
  const append: StoreAppend = (type, key, payload, actor) => store.append(event(type, key, payload, actor));
  try {
    fn(store, append, () => rebuildSchedulerProjection(store.readRun(RUN_ID)));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

type StoreAppend = (
  type: NewSchedulerEvent["type"],
  key: string,
  payload: Record<string, unknown>,
  actor?: NewSchedulerEvent["actor"],
) => ReturnType<SqliteSchedulerStore["append"]>;

function kernelAssessment(
  projection: ReturnType<typeof rebuildSchedulerProjection>,
  architectDeclaration: "low" | "high" = "low",
  stricterQualification = false,
) {
  return assessPlanRisk({
    architectDeclaration,
    stricterQualification,
    tasks: Object.values(projection.tasks),
  });
}

function configurePolicy(append: StoreAppend, mode: "risk_based" | "always" | "off" = "risk_based"): void {
  append("plan_critique.policy_configured", `critique-policy:${mode}`, { mode });
}

function configureRisk(
  append: StoreAppend,
  projection: () => ReturnType<typeof rebuildSchedulerProjection>,
  options: { architectDeclaration?: "low" | "high"; stricterQualification?: boolean } = {},
): void {
  const architectDeclaration = options.architectDeclaration ?? "low";
  const stricterQualification = options.stricterQualification ?? false;
  append("plan_critique.risk_assessed", "critique-risk", {
    planRevision: projection().planRevision,
    architectDeclaration,
    stricterQualification,
    assessment: kernelAssessment(projection(), architectDeclaration, stricterQualification),
  });
}

function requestCritiqueEvent(
  append: StoreAppend,
  options: {
    critiqueId?: string;
    planRevision?: number;
    runtime?: VerifierRuntimeBinding;
    excludedModels?: ReturnType<typeof architectExclusion>;
    supersedesCritiqueId?: string;
    key?: string;
  } = {},
): void {
  append(
    "plan_critique.requested",
    options.key ?? `critique:${options.critiqueId ?? "critique-1"}`,
    {
      critiqueId: options.critiqueId ?? "critique-1",
      planRevision: options.planRevision ?? 1,
      runtime: options.runtime ?? criticRuntime(),
      excludedModels: options.excludedModels ?? architectExclusion(),
      ...(options.supersedesCritiqueId ? { supersedesCritiqueId: options.supersedesCritiqueId } : {}),
    },
  );
}

const BLOCKING_FINDING = {
  findingId: "F-1",
  severity: "blocking",
  category: "overlapping_scope",
  taskIds: ["A", "B"],
  claim: "A and B both own src/cache.ts.",
  evidence: ["A objective mentions src/cache.ts", "B objective mentions src/cache.ts"],
};
const ADVISORY_FINDING = {
  findingId: "F-2",
  severity: "advisory",
  category: "missing_failure_mode",
  taskIds: ["E"],
  claim: "E ignores empty input.",
  evidence: ["E criteria never mention empty input"],
};

test("plan.created records architect risk declarations and defaults legacy plans to low", () => {
  withStore((_, append, projection) => {
    assert.deepEqual(projection().planRiskDeclaration, {
      risk: "low",
      rationale: "routine",
      source: "architect",
    });
    assert.throws(() => append("plan.created", "plan:again", {
      revision: 2,
      tasks: [task("Z")],
      riskDeclaration: { risk: "high", rationale: "late" },
    }, ARCHITECT), /second initial plan/);
  });
  withStore((_, _append, projection) => {
    assert.deepEqual(projection().planRiskDeclaration, { risk: "low", source: "legacy_default" });
  }, { omitRiskDeclaration: true });
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-invalid-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(event("run.initialized", "init", { runId: RUN_ID }));
    assert.throws(() => store.append(event("plan.created", "plan:bad-risk", {
      revision: 1,
      tasks: [task("A")],
      riskDeclaration: { risk: "medium", rationale: "nope" },
    }, ARCHITECT)), /risk/);
    assert.throws(() => store.append(event("plan.created", "plan:empty-rationale", {
      revision: 1,
      tasks: [task("A")],
      riskDeclaration: { risk: "high", rationale: "   " },
    }, ARCHITECT)), /rationale/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan_tasks passes riskDeclaration through to plan.created", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-tool-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    store.append(event("run.initialized", "init", { runId: RUN_ID }));
    const tool = createArchitectTools({ store, clock: () => AT })
      .find((candidate) => candidate.definition.name === "plan_tasks");
    assert.ok(tool, "plan_tasks is registered");
    const schema = tool.definition.inputSchema as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(schema.required, ["revision", "tasks"]);
    assert.ok(schema.properties.riskDeclaration);
    const missingRationale = tool.validate({
      revision: 1,
      tasks: [{
        id: "A", objective: "Do A", dependencies: [], requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "AC-1", text: "A works." }],
      }],
      riskDeclaration: { risk: "high" },
    });
    assert.equal(missingRationale.ok, false);
    const validated = tool.validate({
      revision: 1,
      tasks: [{
        id: "A", objective: "Do A", dependencies: [], requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "AC-1", text: "A works." }],
      }],
      riskDeclaration: { risk: "high", rationale: "complex surface" },
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = await tool.execute(validated.value, {
      runId: RUN_ID, sessionId: "architect", actor: { role: "architect", id: "architect_1" },
    });
    assert.equal(output.isError, false);
    const projection = rebuildSchedulerProjection(store.readRun(RUN_ID));
    assert.deepEqual(projection.planRiskDeclaration, {
      risk: "high",
      rationale: "complex surface",
      source: "architect",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan risk is recorded once, recomputed by the kernel, and gates the scheduler", () => {
  withStore((store, append, projection) => {
    assert.throws(
      () => append("plan_critique.policy_configured", "critique-policy:user", { mode: "always" }, USER),
      /Only the runner may configure plan critique policy/,
    );
    assert.throws(
      () => append("plan_critique.policy_configured", "critique-policy:architect", { mode: "always" }, ARCHITECT),
      /Only the runner may configure plan critique policy/,
    );
    assert.throws(
      () => append("plan_critique.policy_configured", "critique-policy:bad-mode", { mode: "sometimes" }),
      /mode/,
    );
    assert.equal(planCritiquePending(projection()), false, "no policy does not block workers");
    assert.throws(
      () => append("plan_critique.risk_assessed", "critique-risk:no-policy", {
        planRevision: 1, architectDeclaration: "low", stricterQualification: false,
        assessment: kernelAssessment(projection()),
      }),
      /policy/,
    );
    assert.throws(
      () => append("plan_critique.requested", "critique:no-policy", {
        critiqueId: "critique-1", planRevision: 1,
        runtime: criticRuntime(),
        excludedModels: architectExclusion(),
      }),
      /policy/,
    );
    configurePolicy(append, "risk_based");
    assert.equal(planCritiquePending(projection()), true, "no risk yet blocks workers");
    assert.throws(
      () => append("plan_critique.requested", "critique:no-risk", {
        critiqueId: "critique-1", planRevision: 1,
        runtime: criticRuntime(),
        excludedModels: architectExclusion(),
      }),
      /risk/,
    );
    assert.throws(
      () => append("plan_critique.policy_configured", "critique-policy:conflict", { mode: "always" }),
      /already configured/,
    );
    append("plan_critique.policy_configured", "critique-policy:same", { mode: "risk_based" });
    assert.equal(projection().planCritique?.policy?.mode, "risk_based");
    assert.throws(() => append("plan_critique.risk_assessed", "critique-risk:bad", {
      planRevision: 1, architectDeclaration: "low", stricterQualification: false,
      assessment: { risk: "low", reasons: [] },
    }), /conflicts with the kernel recomputation/);
    assert.throws(() => append("plan_critique.risk_assessed", "critique-risk:stale", {
      planRevision: 2, architectDeclaration: "low", stricterQualification: false,
      assessment: kernelAssessment(projection()),
    }), /plan revision/);
    assert.throws(() => append("plan_critique.risk_assessed", "critique-risk:declaration", {
      planRevision: 1, architectDeclaration: "high", stricterQualification: false,
      assessment: kernelAssessment(projection(), "high", false),
    }), /architectDeclaration|declaration|declared/);
    assert.throws(() => append("plan_critique.risk_assessed", "critique-risk:strict", {
      planRevision: 1, architectDeclaration: "low", stricterQualification: true,
      assessment: kernelAssessment(projection(), "low", true),
    }), /stricterQualification|qualification/);
    assert.throws(
      () => append("plan_critique.risk_assessed", "critique-risk:user", {
        planRevision: 1, architectDeclaration: "low", stricterQualification: false,
        assessment: kernelAssessment(projection()),
      }, USER),
      /Only the runner may assess plan risk/,
    );
    append("plan_critique.risk_assessed", "critique-risk", {
      planRevision: 1, architectDeclaration: "low", stricterQualification: false,
      assessment: kernelAssessment(projection()),
    });
    assert.deepEqual(projection().planCritique?.risk?.assessment.reasons.map((r) => r.code), ["task_count", "dependency_fan_in"]);
    assert.equal(projection().planCritique?.risk?.assessment.risk, "high");
    assert.equal(planCritiquePending(projection()), true, "high risk without a resolved critique blocks workers");
    store.append(event("plan.reconciled", "plan:2", {
      revision: 2,
      summary: "Cancel D to drop below the count threshold after risk was recorded.",
      taskUpdates: [{ taskId: "D", action: "cancel" }],
    }, ARCHITECT));
    assert.throws(() => append("plan_critique.risk_assessed", "critique-risk:again", {
      planRevision: 2, architectDeclaration: "low", stricterQualification: false,
      assessment: kernelAssessment(projection()),
    }), /already|once|planRevision/);
  });
});

test("risk below the threshold unblocks workers under risk_based and still blocks under always", () => {
  withStore((_, append, projection) => {
    configurePolicy(append, "risk_based");
    configureRisk(append, projection);
    assert.equal(projection().planCritique?.risk?.assessment.risk, "low");
    assert.equal(planCritiquePending(projection()), false);
  }, { tasks: [task("A"), task("B"), task("C", ["A"])] });
  withStore((_, append, projection) => {
    configurePolicy(append, "always");
    configureRisk(append, projection);
    assert.equal(projection().planCritique?.risk?.assessment.risk, "low");
    assert.equal(planCritiquePending(projection()), true, "always mode ignores low risk");
  }, { tasks: [task("A"), task("B"), task("C", ["A"])] });
  withStore((_, append, projection) => {
    configurePolicy(append, "off");
    assert.equal(planCritiquePending(projection()), false);
    configureRisk(append, projection);
    assert.equal(planCritiquePending(projection()), false);
  });
});

test("a critique is requested for the current plan by an independent runtime, submitted by that runtime, and resolved by the Architect", () => {
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    assert.throws(() => append("plan_critique.requested", "critique:not-independent", {
      critiqueId: "critique-1", planRevision: 1,
      runtime: binding("openai:architect", "architect", "plan-critic:s1"),
      excludedModels: architectExclusion(),
    }), /not independent from the Architect/);
    assert.throws(() => append("plan_critique.requested", "critique:stale-rev", {
      critiqueId: "critique-1", planRevision: 2,
      runtime: criticRuntime(),
      excludedModels: architectExclusion(),
    }), /plan revision/);
    assert.throws(() => append("plan_critique.requested", "critique:no-excluded", {
      critiqueId: "critique-1", planRevision: 1,
      runtime: criticRuntime(),
      excludedModels: [],
    }), /excluded model/);
    assert.throws(() => append("plan_critique.requested", "critique:identity-mismatch", {
      critiqueId: "critique-1", planRevision: 1,
      runtime: {
        runtimeId: "google:verifier",
        providerId: "google",
        modelId: "google/gemini",
        modelIdentity: "google/gemini",
        sessionId: "plan-critic:s1",
      },
      excludedModels: architectExclusion(),
    }), /model identity/);
    assert.throws(
      () => append("plan_critique.requested", "critique:user", {
        critiqueId: "critique-1", planRevision: 1,
        runtime: criticRuntime(),
        excludedModels: architectExclusion(),
      }, USER),
      /Only the runner may request a plan critique/,
    );
    append("plan_critique.requested", "critique:1", {
      critiqueId: "critique-1", planRevision: 1,
      runtime: criticRuntime(),
      excludedModels: architectExclusion(),
    });
    assert.equal(projection().planCritique?.current?.status, "requested");
    assert.equal(projection().planCritique?.current?.planRevision, 1);
    assert.equal(projection().planCritique?.current?.runtime.runtimeId, "google:verifier");
    assert.throws(() => append("plan_critique.submitted", "critique:1:foreign", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, { role: "verifier", id: "fallback:verifier" }), /does not match the selected critic runtime/);
    assert.throws(() => append("plan_critique.submitted", "critique:1:wrong-id", {
      critiqueId: "critique-other", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC), /critiqueId|match/);
    assert.throws(() => append("plan_critique.submitted", "critique:1:stale", {
      critiqueId: "critique-1", planRevision: 2, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC), /plan revision|stale/);
    assert.throws(() => append("plan_critique.submitted", "critique:1:session", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:other", findings: [],
    }, CRITIC), /sessionId|session/);
    assert.throws(() => append("plan_critique.submitted", "critique:1:runner", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }), /does not match the selected critic runtime/);
    assert.throws(() => append("plan_critique.submitted", "critique:1:runner-same-id", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, { role: "runner", id: "google:verifier" }), /does not match the selected critic runtime/);
    append("plan_critique.submitted", "critique:1:submitted", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1",
      findings: [BLOCKING_FINDING, ADVISORY_FINDING],
    }, CRITIC);
    assert.deepEqual(projection().planCritique?.current?.blockingFindingIds, ["F-1"]);
    assert.equal(projection().planCritique?.current?.status, "submitted");
    assert.equal(planCritiquePending(projection()), true);
    append("plan_critique.submitted", "critique:1:resubmitted", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1",
      findings: [BLOCKING_FINDING, ADVISORY_FINDING],
    }, CRITIC);
    assert.equal(projection().planCritique?.current?.status, "submitted");
    assert.throws(() => append("plan_critique.submitted", "critique:1:conflict", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC), /conflict|identical|already submitted/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:auto", {
      critiqueId: "critique-1", planRevision: 1, resolutions: [],
    }), /blocking findings require an Architect resolution/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:user", {
      critiqueId: "critique-1", planRevision: 1, resolutions: [],
    }, USER), /Architect resolution|Only the Architect/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:partial", {
      critiqueId: "critique-1", planRevision: 1, resolutions: [],
    }, ARCHITECT), /blocking finding F-1 has no resolution/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:unknown", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [
        { findingId: "F-1", resolution: "rejected", rationale: "ok" },
        { findingId: "F-9", resolution: "rejected", rationale: "no such finding" },
      ],
    }, ARCHITECT), /unknown finding|F-9/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:dup", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [
        { findingId: "F-1", resolution: "rejected", rationale: "once" },
        { findingId: "F-1", resolution: "rejected", rationale: "twice" },
      ],
    }, ARCHITECT), /duplicate/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:empty-rationale", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "   " }],
    }, ARCHITECT), /rationale/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:no-recon", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "plan_reconciled", rationale: "merge A and B" }],
    }, ARCHITECT), /plan_reconciled resolutions require a planReconciliation/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:untouched", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "plan_reconciled", rationale: "touch C instead" }],
      planReconciliation: { revision: 2, summary: "Cancel C.", taskUpdates: [{ taskId: "C", action: "cancel" }] },
    }, ARCHITECT), /taskIds|taskUpdates|A and B|finding F-1/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:stale", {
      critiqueId: "critique-1", planRevision: 2,
      resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "stale" }],
    }, ARCHITECT), /plan revision|stale|match/);
    append("plan_critique.resolved", "critique:1:resolved", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "plan_reconciled", rationale: "B is folded into A." }],
      planReconciliation: {
        revision: 2,
        summary: "Fold B into A.",
        taskUpdates: [
          { taskId: "B", action: "cancel" },
          { taskId: "E", action: "revise", dependencies: ["A"] },
        ],
      },
    }, ARCHITECT);
    const resolved = projection();
    assert.equal(resolved.planRevision, 2);
    assert.equal(resolved.tasks.B.status, "cancelled");
    assert.equal(resolved.planCritique?.current?.status, "resolved");
    assert.equal(resolved.planCritique?.current?.resolution?.resolvedBy, "architect");
    assert.equal(resolved.planCritique?.current?.resolution?.planRevisionAfter, 2);
    assert.equal(planCritiquePending(resolved), false);
    assert.throws(() => append("plan_critique.requested", "critique:2", {
      critiqueId: "critique-2", planRevision: 2,
      runtime: binding("google:verifier", "verifier", "plan-critic:s2"),
      excludedModels: architectExclusion(),
    }), /already resolved for this run/);
  });
});

test("plan_reconciled resolutions accept action revise as well as cancel", () => {
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    append("plan_critique.submitted", "critique:1:submitted", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1",
      findings: [BLOCKING_FINDING],
    }, CRITIC);
    append("plan_critique.resolved", "critique:1:revise", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "plan_reconciled", rationale: "Revise B in place." }],
      planReconciliation: {
        revision: 2,
        summary: "Revise B after the overlapping-scope finding.",
        taskUpdates: [{ taskId: "B", action: "revise", objective: "B no longer owns src/cache.ts." }],
      },
    }, ARCHITECT);
    const revised = projection();
    assert.equal(revised.planRevision, 2);
    assert.equal(revised.tasks.B.status, "planned");
    assert.equal(revised.tasks.B.objective, "B no longer owns src/cache.ts.");
    assert.equal(revised.planCritique?.current?.status, "resolved");
    assert.equal(planCritiquePending(revised), false);
  });
});

test("rejected blocking findings resolve without reconciling the plan", () => {
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    append("plan_critique.submitted", "critique:1:submitted", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1",
      findings: [BLOCKING_FINDING],
    }, CRITIC);
    append("plan_critique.resolved", "critique:1:rejected", {
      critiqueId: "critique-1", planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "The files are distinct." }],
    }, ARCHITECT);
    const resolved = projection();
    assert.equal(resolved.planRevision, 1);
    assert.equal(resolved.tasks.B.status, "planned");
    assert.equal(resolved.planCritique?.current?.resolution?.resolvedBy, "architect");
    assert.equal(planCritiquePending(resolved), false);
  });
});

test("a critique with no blocking findings is auto-resolved by the runner, and skips are durable", () => {
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    append("plan_critique.submitted", "critique:1:submitted", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC);
    assert.deepEqual(projection().planCritique?.current?.blockingFindingIds, []);
    append("plan_critique.resolved", "critique:1:auto", { critiqueId: "critique-1", planRevision: 1, resolutions: [] });
    assert.equal(projection().planCritique?.current?.resolution?.resolvedBy, "runner");
    assert.equal(planCritiquePending(projection()), false);
  });
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    append("plan_critique.submitted", "critique:1:advisory", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1",
      findings: [ADVISORY_FINDING],
    }, CRITIC);
    assert.deepEqual(projection().planCritique?.current?.blockingFindingIds, []);
    append("plan_critique.resolved", "critique:1:auto", { critiqueId: "critique-1", planRevision: 1, resolutions: [] });
    assert.equal(projection().planCritique?.current?.resolution?.resolvedBy, "runner");
  });
  withStore((_, append, projection) => {
    configurePolicy(append, "off");
    append("plan_critique.skipped", "critique:skipped:off", { planRevision: 1, reason: "policy_off" });
    assert.equal(projection().planCritique?.skipped?.reason, "policy_off");
    assert.equal(planCritiquePending(projection()), false);
  });
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    append("plan_critique.skipped", "critique:skipped", { planRevision: 1, reason: "low_plan_risk" });
    assert.equal(projection().planCritique?.skipped?.reason, "low_plan_risk");
    assert.equal(planCritiquePending(projection()), false);
  }, { tasks: [task("A"), task("B"), task("C", ["A"])] });
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    append("plan_critique.skipped", "critique:skipped:failed", { planRevision: 1, reason: "critic_failed" });
    assert.equal(projection().planCritique?.skipped?.reason, "critic_failed");
    assert.equal(planCritiquePending(projection()), false);
  });
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    append("plan_critique.skipped", "critique:skipped:plan-only", { planRevision: 1, reason: "plan_only" });
    assert.equal(projection().planCritique?.skipped?.reason, "plan_only");
    assert.equal(planCritiquePending(projection()), false);
  });
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    append("plan_critique.submitted", "critique:1:submitted", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC);
    assert.throws(
      () => append("plan_critique.skipped", "critique:skipped:submitted", { planRevision: 1, reason: "critic_failed" }),
      /submitted|resolved/,
    );
    append("plan_critique.resolved", "critique:1:auto", { critiqueId: "critique-1", planRevision: 1, resolutions: [] });
    assert.throws(
      () => append("plan_critique.skipped", "critique:skipped:resolved", { planRevision: 1, reason: "critic_failed" }),
      /submitted|resolved/,
    );
  });
  withStore((_, append) => {
    assert.throws(
      () => append("plan_critique.skipped", "critique:skipped:no-policy", { planRevision: 1, reason: "policy_off" }),
      /policy/,
    );
  });
  withStore((_, append) => {
    configurePolicy(append);
    assert.throws(
      () => append("plan_critique.skipped", "critique:skipped:bad-reason", { planRevision: 1, reason: "bored" }),
      /reason/,
    );
    assert.throws(
      () => append("plan_critique.skipped", "critique:skipped:user", { planRevision: 1, reason: "policy_off" }, USER),
      /Only the runner may skip a plan critique/,
    );
  });
});

test("a pending requested critique can be superseded by a different critic identity", () => {
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    assert.throws(() => append("plan_critique.requested", "critique:2:no-supersede", {
      critiqueId: "critique-2", planRevision: 1,
      runtime: binding("google:other", "other", "plan-critic:s2"),
      excludedModels: architectExclusion(),
    }), /supersede/);
    assert.throws(() => append("plan_critique.requested", "critique:2:wrong-supersede", {
      critiqueId: "critique-2", planRevision: 1,
      runtime: binding("google:other", "other", "plan-critic:s2"),
      excludedModels: architectExclusion(),
      supersedesCritiqueId: "critique-missing",
    }), /supersede/);
    append("plan_critique.requested", "critique:2", {
      critiqueId: "critique-2", planRevision: 1,
      runtime: binding("google:other", "other", "plan-critic:s2"),
      excludedModels: architectExclusion(),
      supersedesCritiqueId: "critique-1",
    });
    const state = projection().planCritique;
    assert.equal(state?.current?.critiqueId, "critique-2");
    assert.equal(state?.current?.runtime.runtimeId, "google:other");
    assert.equal(state?.history[0]?.critiqueId, "critique-1");
    assert.equal(state?.history[0]?.supersededByCritiqueId, "critique-2");
    assert.throws(() => append("plan_critique.submitted", "critique:1:old-critic", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC), /does not match the selected critic runtime|critiqueId/);
    append("plan_critique.submitted", "critique:2:submitted", {
      critiqueId: "critique-2", planRevision: 1, sessionId: "plan-critic:s2", findings: [],
    }, { role: "verifier", id: "google:other" });
    assert.equal(projection().planCritique?.current?.critiqueId, "critique-2");
    assert.equal(projection().planCritique?.current?.status, "submitted");
  });
});

test("a critique submitted against a stale plan revision is rejected, and the matching revision is accepted", () => {
  withStore((store, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    store.append(event("plan.reconciled", "plan:2", {
      revision: 2,
      summary: "Independent reconcile after the critique was bound to revision 1.",
      taskUpdates: [{ taskId: "C", action: "cancel" }],
    }, ARCHITECT));
    assert.equal(projection().planRevision, 2);
    assert.equal(projection().planCritique?.current?.planRevision, 1);
    assert.throws(() => append("plan_critique.submitted", "critique:1:bound-old", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC), /plan revision|stale/);
    assert.throws(() => append("plan_critique.submitted", "critique:1:current-new", {
      critiqueId: "critique-1", planRevision: 2, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC), /plan revision|stale|match/);
  });
});

test("resolution is rejected until the current critique is submitted", () => {
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    assert.equal(projection().planCritique?.current?.status, "requested");
    assert.throws(() => append("plan_critique.resolved", "critique:1:too-soon", {
      critiqueId: "critique-1", planRevision: 1, resolutions: [],
    }), /submitted/);
  });
});

test("a critique resolved against a stale plan revision is rejected, and the matching revision is accepted", () => {
  withStore((store, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    requestCritiqueEvent(append);
    append("plan_critique.submitted", "critique:1:submitted", {
      critiqueId: "critique-1", planRevision: 1, sessionId: "plan-critic:s1", findings: [],
    }, CRITIC);
    store.append(event("plan.reconciled", "plan:2", {
      revision: 2,
      summary: "Independent reconcile after the critique was submitted at revision 1.",
      taskUpdates: [{ taskId: "C", action: "cancel" }],
    }, ARCHITECT));
    assert.equal(projection().planRevision, 2);
    assert.equal(projection().planCritique?.current?.planRevision, 1);
    assert.throws(() => append("plan_critique.resolved", "critique:1:bound-old", {
      critiqueId: "critique-1", planRevision: 1, resolutions: [],
    }), /plan revision|stale/);
    assert.throws(() => append("plan_critique.resolved", "critique:1:current-new", {
      critiqueId: "critique-1", planRevision: 2, resolutions: [],
    }), /plan revision|stale|match/);
  });
});

test("plan critique cannot start after a worker was dispatched", () => {
  withStore((store, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    store.append(event("task.transitioned", "A:assigned", {
      taskId: "A", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker:A:1" },
    }));
    assert.throws(() => append("plan_critique.requested", "critique:late", {
      critiqueId: "critique-1", planRevision: 1,
      runtime: criticRuntime(),
      excludedModels: architectExclusion(),
    }), /cannot start after a worker was dispatched/);
  });
});

test("plan critique cannot start when a task is assigned even at attempt 0", () => {
  withStore((store, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    store.append(event("task.transitioned", "A:assigned", {
      taskId: "A", status: "assigned", patch: { assignedWorkerId: "worker:A:1" },
    }));
    assert.equal(projection().tasks.A.attempt, 0);
    assert.equal(projection().tasks.A.status, "assigned");
    assert.throws(() => append("plan_critique.requested", "critique:assigned-attempt-0", {
      critiqueId: "critique-1", planRevision: 1,
      runtime: criticRuntime(),
      excludedModels: architectExclusion(),
    }), /cannot start after a worker was dispatched/);
  });
});

test("plan critique cannot start when a still-planned task already has an attempt", () => {
  withStore((_, append, projection) => {
    configurePolicy(append);
    configureRisk(append, projection);
    assert.equal(projection().tasks.A.status, "planned");
    assert.equal(projection().tasks.A.attempt, 1);
    assert.throws(() => append("plan_critique.requested", "critique:planned-attempt-1", {
      critiqueId: "critique-1", planRevision: 1,
      runtime: criticRuntime(),
      excludedModels: architectExclusion(),
    }), /cannot start after a worker was dispatched/);
  }, { tasks: [{ ...task("A"), attempt: 1 }, task("B"), task("C"), task("D"), task("E", ["A", "B"])] });
});

test("stricter qualification is bound to the configured verifier policy", () => {
  withStore((store, append, projection) => {
    store.append(event("verifier.policy_configured", "verifier:policy", {
      mode: "risk_based",
      candidateRuntimeIds: ["google:verifier"],
      alwaysRequireIndependentVerifier: true,
    }));
    configurePolicy(append);
    assert.throws(() => append("plan_critique.risk_assessed", "critique-risk:not-strict", {
      planRevision: 1, architectDeclaration: "low", stricterQualification: false,
      assessment: kernelAssessment(projection(), "low", false),
    }), /stricterQualification|qualification/);
    append("plan_critique.risk_assessed", "critique-risk", {
      planRevision: 1, architectDeclaration: "low", stricterQualification: true,
      assessment: kernelAssessment(projection(), "low", true),
    });
    assert.equal(projection().planCritique?.risk?.stricterQualification, true);
    assert.ok(projection().planCritique?.risk?.assessment.reasons.some((reason) => reason.code === "stricter_qualification"));
  });
});

test("workers cannot start before the critique is resolved", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-tick-"));
  const store = seededStore(root);
  const driver = new DeferredDriver();
  try {
    const append: StoreAppend = (type, key, payload, actor) => store.append(event(type, key, payload, actor));
    const projection = () => rebuildSchedulerProjection(store.readRun(RUN_ID));
    configurePolicy(append);
    configureRisk(append, projection);
    assert.equal(planCritiquePending(projection()), true);
    const scheduler = new TaskScheduler({
      runId: RUN_ID,
      store,
      driver,
      maxConcurrency: 4,
      workspaceFor: async (taskValue, attempt) => `C:/work/${taskValue.id}/${attempt}`,
      clock: () => AT,
    });
    await scheduler.tick();
    assert.equal(driver.assignments.length, 0, "tick() must wait while a critique is pending");
    assert.equal(projection().tasks.A.status, "planned");
    append("plan_critique.skipped", "critique:skipped:failed", { planRevision: 1, reason: "critic_failed" });
    assert.equal(planCritiquePending(projection()), false);
    await scheduler.tick();
    assert.ok(driver.assignments.length > 0, "tick() dispatches after the critique is no longer pending");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tick still dispatches when plan critique policy is off", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-critique-tick-off-"));
  const store = seededStore(root);
  const driver = new DeferredDriver();
  try {
    store.append(event("plan_critique.policy_configured", "critique-policy:off", { mode: "off" }));
    assert.equal(planCritiquePending(rebuildSchedulerProjection(store.readRun(RUN_ID))), false);
    const scheduler = new TaskScheduler({
      runId: RUN_ID,
      store,
      driver,
      maxConcurrency: 4,
      workspaceFor: async (taskValue, attempt) => `C:/work/${taskValue.id}/${attempt}`,
      clock: () => AT,
    });
    await scheduler.tick();
    assert.ok(driver.assignments.length > 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
