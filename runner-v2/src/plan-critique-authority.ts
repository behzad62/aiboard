import {
  rebuildSchedulerProjection,
  type SchedulerStore,
} from "./scheduler-store.js";
import type { AgentActor } from "./agent-contracts.js";
import type {
  PlanCritiqueFinding,
  PlanCritiqueProjection,
} from "./plan-critique-contracts.js";
import type {
  VerifierExcludedModel,
  VerifierRuntimeBinding,
} from "./verifier-contracts.js";

export interface RequestPlanCritiqueInput {
  runId: string;
  critiqueId: string;
  planRevision: number;
  runtime: VerifierRuntimeBinding;
  excludedModels: VerifierExcludedModel[];
  occurredAt: string;
}

export interface SubmitPlanCritiqueInput {
  runId: string;
  critiqueId: string;
  planRevision: number;
  sessionId: string;
  actor: AgentActor & { role: "verifier" };
  findings: PlanCritiqueFinding[];
  occurredAt: string;
}

export interface PlanCritiqueAuthority {
  requestCritique(input: RequestPlanCritiqueInput): PlanCritiqueProjection;
  currentCritique(runId: string): PlanCritiqueProjection | undefined;
  submitFindings(input: SubmitPlanCritiqueInput): PlanCritiqueProjection;
}

export class SchedulerPlanCritiqueAuthority implements PlanCritiqueAuthority {
  constructor(
    private readonly store: SchedulerStore,
    private readonly runnerId = "native-plan-critic-runtime",
  ) {}

  requestCritique(input: RequestPlanCritiqueInput): PlanCritiqueProjection {
    const current = this.currentCritique(input.runId);
    const supersedesCritiqueId =
      current?.status === "requested" && current.critiqueId !== input.critiqueId
        ? current.critiqueId
        : undefined;
    this.store.append({
      runId: input.runId,
      type: "plan_critique.requested",
      occurredAt: input.occurredAt,
      actor: { role: "runner", id: this.runnerId },
      idempotencyKey: `plan-critique:request:${input.critiqueId}`,
      payload: {
        critiqueId: input.critiqueId,
        planRevision: input.planRevision,
        runtime: { ...input.runtime },
        excludedModels: input.excludedModels.map((model) => ({ ...model })),
        ...(supersedesCritiqueId ? { supersedesCritiqueId } : {}),
      },
    });
    const critique = this.currentCritique(input.runId);
    if (!critique || critique.critiqueId !== input.critiqueId) {
      throw new Error("Requested plan critique was not durably projected.");
    }
    return critique;
  }

  currentCritique(runId: string): PlanCritiqueProjection | undefined {
    const events = this.store.readRun(runId);
    if (events.length === 0) return undefined;
    const current = rebuildSchedulerProjection(events).planCritique?.current;
    return current ? structuredClone(current) : undefined;
  }

  submitFindings(input: SubmitPlanCritiqueInput): PlanCritiqueProjection {
    this.store.append({
      runId: input.runId,
      type: "plan_critique.submitted",
      occurredAt: input.occurredAt,
      actor: { ...input.actor },
      idempotencyKey: `plan-critique:submit:${input.critiqueId}`,
      payload: {
        critiqueId: input.critiqueId,
        planRevision: input.planRevision,
        sessionId: input.sessionId,
        findings: input.findings.map((finding) => ({
          ...finding,
          taskIds: [...finding.taskIds],
          evidence: [...finding.evidence],
          ...(finding.criterionIds
            ? { criterionIds: finding.criterionIds.map((criterion) => ({ ...criterion })) }
            : {}),
        })),
      },
    });
    const critique = this.currentCritique(input.runId);
    if (
      !critique?.findings ||
      critique.status !== "submitted" ||
      critique.critiqueId !== input.critiqueId ||
      critique.planRevision !== input.planRevision ||
      critique.runtime.sessionId !== input.sessionId
    ) {
      throw new Error("Plan critique findings were not durably projected.");
    }
    return structuredClone(critique);
  }
}
