import type {
  ProviderFailure,
  ProviderHealthRegistry,
} from "./provider-health.js";
import {
  canonicalModelIdentity,
  type ReviewerIndependence,
} from "./verifier-contracts.js";

export interface AgentRuntimeCandidate {
  runtimeId: string;
  providerId: string;
  modelId: string;
  capabilities: string[];
  priority: number;
}

export interface WorkerHandoffPackage {
  runId: string;
  taskId: string;
  sessionId: string;
  attempt: number;
  checkpointArtifactHash: string;
  workspacePath: string;
}

export type WorkerSelection =
  | {
      status: "assigned";
      runtime: AgentRuntimeCandidate;
      handoff?: WorkerHandoffPackage;
    }
  | {
      status: "unavailable";
      reason: "no_healthy_capability_match";
      requiredCapabilities: string[];
      runtime?: undefined;
      handoff?: WorkerHandoffPackage;
    };

/** How selectWorker spreads tasks over the owner's workers; every field is optional. */
export interface WorkerSelectionPreference {
  /** Task attempts each runtime is working on now: a new task goes to the least-loaded worker. */
  readonly activeAssignments?: ReadonlyMap<string, number>;
  /** Runtimes that worked on this task before, most recent first: a retry keeps its warm cache. */
  readonly affinity?: readonly string[];
  /** Runtimes doing poorly in this run: chosen only when no other healthy worker is eligible. */
  readonly demoted?: ReadonlySet<string>;
}

export interface WorkerFailureRouteInput {
  currentRuntimeId: string;
  requiredCapabilities: string[];
  failure: ProviderFailure;
  handoff: WorkerHandoffPackage;
}

export interface VerifierSelectionInput {
  requiredCapabilities: readonly string[];
  candidateRuntimeIds: readonly string[];
  architectRuntimeId: string;
  acceptedChangeAuthorRuntimeIds: readonly string[];
  excludedRuntimeIds?: ReadonlySet<string>;
}

export type VerifierSelection =
  | {
      status: "assigned";
      runtime: AgentRuntimeCandidate;
      independence: ReviewerIndependence;
    }
  | {
      status: "unavailable";
      reason: "no_independent_healthy_capability_match";
      requiredCapabilities: string[];
      runtime?: undefined;
    };

export interface RuntimeRouterDecision {
  type: "worker_handoff" | "worker_unavailable";
  fromRuntimeId: string;
  toRuntimeId?: string;
  providerId: string;
  failure: ProviderFailure;
  handoff: WorkerHandoffPackage;
}

export interface RuntimeRouterOptions {
  candidates: readonly AgentRuntimeCandidate[];
  health: ProviderHealthRegistry;
  /**
   * The owner's Reviewer: chosen first by selectVerifier whenever it is an eligible candidate and did
   * not author the change, even if it shares the Architect's model (recorded fresh_context).
   */
  preferredVerifierRuntimeId?: string;
  onDecision?: (decision: RuntimeRouterDecision) => void;
}

export interface ArchitectHandoffRequired {
  status: "user_selection_required";
  candidates: AgentRuntimeCandidate[];
  requiredCapabilities: string[];
}

export class RuntimeRouter {
  private readonly candidates: AgentRuntimeCandidate[];
  private readonly byId = new Map<string, AgentRuntimeCandidate>();
  private readonly health: ProviderHealthRegistry;
  private readonly onDecision?: RuntimeRouterOptions["onDecision"];
  private readonly preferredVerifierRuntimeId?: string;

  constructor(options: RuntimeRouterOptions) {
    this.health = options.health;
    this.onDecision = options.onDecision;
    this.preferredVerifierRuntimeId = options.preferredVerifierRuntimeId;
    this.candidates = options.candidates
      .map(cloneCandidate)
      .sort(compareCandidates);
    for (const candidate of this.candidates) {
      if (!candidate.runtimeId || !candidate.providerId || !candidate.modelId) {
        throw new Error("Runtime candidates require runtimeId, providerId, and modelId.");
      }
      if (this.byId.has(candidate.runtimeId)) {
        throw new Error(`Duplicate runtime ${candidate.runtimeId}.`);
      }
      this.byId.set(candidate.runtimeId, candidate);
    }
  }

  /**
   * Every task used to go to the first healthy worker, so the other workers the owner picked only
   * took over on failure (tunnel run). Now: demoted workers last, then the task's previous worker,
   * then the least-loaded one, ties in the owner's order.
   */
  selectWorker(
    requiredCapabilities: readonly string[],
    excludedRuntimeIds: ReadonlySet<string> = new Set(),
    preference: WorkerSelectionPreference = {}
  ): WorkerSelection {
    const required = unique(requiredCapabilities);
    const eligible = this.eligible(required).filter(
      (candidate) => !excludedRuntimeIds.has(candidate.runtimeId)
    );
    const preferred = eligible.filter((candidate) => !preference.demoted?.has(candidate.runtimeId));
    const pool = preferred.length > 0 ? preferred : eligible;
    const load = (candidate: AgentRuntimeCandidate) => preference.activeAssignments?.get(candidate.runtimeId) ?? 0;
    const runtime =
      preference.affinity?.map((runtimeId) => pool.find((candidate) => candidate.runtimeId === runtimeId)).find(Boolean) ??
      pool.reduce<AgentRuntimeCandidate | undefined>((best, candidate) => (!best || load(candidate) < load(best) ? candidate : best), undefined);
    return runtime
      ? { status: "assigned", runtime: cloneCandidate(runtime) }
      : {
          status: "unavailable",
          reason: "no_healthy_capability_match",
          requiredCapabilities: required,
        };
  }

  recordFailure(runtimeId: string, failure: ProviderFailure): void {
    const runtime = this.requireRuntime(runtimeId);
    this.health.recordFailure(runtime.providerId, failure);
  }

  recordSuccess(runtimeId: string): void {
    const runtime = this.requireRuntime(runtimeId);
    this.health.recordSuccess(runtime.providerId);
  }

  routeWorkerFailure(input: WorkerFailureRouteInput): WorkerSelection {
    const current = this.requireRuntime(input.currentRuntimeId);
    this.health.recordFailure(current.providerId, input.failure);
    const selection = this.selectWorker(
      input.requiredCapabilities,
      new Set([input.currentRuntimeId])
    );
    const result: WorkerSelection =
      selection.status === "assigned"
        ? { ...selection, handoff: { ...input.handoff } }
        : { ...selection, handoff: { ...input.handoff } };
    this.onDecision?.({
      type: result.status === "assigned" ? "worker_handoff" : "worker_unavailable",
      fromRuntimeId: input.currentRuntimeId,
      ...(result.status === "assigned"
        ? { toRuntimeId: result.runtime.runtimeId }
        : {}),
      providerId: current.providerId,
      failure: { ...input.failure },
      handoff: { ...input.handoff },
    });
    return result;
  }

  selectArchitectHandoff(
    requiredCapabilities: readonly string[],
    excludedRuntimeIds: ReadonlySet<string> = new Set()
  ): ArchitectHandoffRequired {
    const required = unique(requiredCapabilities);
    return {
      status: "user_selection_required",
      candidates: this.eligible(required)
        .filter((candidate) => !excludedRuntimeIds.has(candidate.runtimeId))
        .map(cloneCandidate),
      requiredCapabilities: required,
    };
  }

  selectVerifier(input: VerifierSelectionInput): VerifierSelection {
    const required = unique(input.requiredCapabilities);
    const allowedRuntimeIds = new Set(input.candidateRuntimeIds);
    for (const runtimeId of allowedRuntimeIds) {
      if (!this.byId.has(runtimeId)) {
        throw new Error(`Unknown verifier candidate runtime ${runtimeId}.`);
      }
    }
    const architect = this.byId.get(input.architectRuntimeId);
    if (!architect) {
      throw new Error(`Unknown Architect runtime ${input.architectRuntimeId}.`);
    }
    const excludedModelIdentities = new Set([
      canonicalModelIdentity(architect.modelId),
    ]);
    const authorModelIdentities = new Set<string>();
    for (const runtimeId of new Set(input.acceptedChangeAuthorRuntimeIds)) {
      const author = this.byId.get(runtimeId);
      if (!author) {
        throw new Error(`Unknown accepted change author runtime ${runtimeId}.`);
      }
      excludedModelIdentities.add(canonicalModelIdentity(author.modelId));
      authorModelIdentities.add(canonicalModelIdentity(author.modelId));
    }
    const eligibleAllowed = this.eligible(required).filter(
      (candidate) =>
        allowedRuntimeIds.has(candidate.runtimeId) &&
        !input.excludedRuntimeIds?.has(candidate.runtimeId),
    );
    const preferred = eligibleAllowed.find(
      (candidate) =>
        candidate.runtimeId === this.preferredVerifierRuntimeId &&
        !authorModelIdentities.has(canonicalModelIdentity(candidate.modelId)),
    );
    const distinct = eligibleAllowed.find(
      (candidate) =>
        !excludedModelIdentities.has(canonicalModelIdentity(candidate.modelId)),
    );
    const runtime = preferred ?? distinct ?? eligibleAllowed[0];
    if (!runtime) {
      return {
        status: "unavailable",
        reason: "no_independent_healthy_capability_match",
        requiredCapabilities: required,
      };
    }
    return {
      status: "assigned",
      runtime: cloneCandidate(runtime),
      independence: excludedModelIdentities.has(canonicalModelIdentity(runtime.modelId))
        ? "fresh_context"
        : "distinct_model",
    };
  }

  confirmArchitectHandoff(
    runtimeId: string,
    requiredCapabilities: readonly string[]
  ): AgentRuntimeCandidate {
    const runtime = this.requireRuntime(runtimeId);
    const required = unique(requiredCapabilities);
    if (!hasCapabilities(runtime, required)) {
      throw new Error(
        `Runtime ${runtimeId} does not satisfy required Architect capabilities.`
      );
    }
    if (!this.health.isAvailable(runtime.providerId)) {
      throw new Error(`Runtime ${runtimeId} is not currently available.`);
    }
    return cloneCandidate(runtime);
  }

  private eligible(requiredCapabilities: readonly string[]): AgentRuntimeCandidate[] {
    return this.candidates.filter(
      (candidate) =>
        this.health.isAvailable(candidate.providerId) &&
        hasCapabilities(candidate, requiredCapabilities)
    );
  }

  private requireRuntime(runtimeId: string): AgentRuntimeCandidate {
    const runtime = this.byId.get(runtimeId);
    if (!runtime) throw new Error(`Unknown runtime ${runtimeId}.`);
    return runtime;
  }
}

function hasCapabilities(
  runtime: AgentRuntimeCandidate,
  required: readonly string[]
): boolean {
  const available = new Set(runtime.capabilities);
  if (available.has("*")) return true;
  return required.every((capability) => available.has(capability));
}

function compareCandidates(
  left: AgentRuntimeCandidate,
  right: AgentRuntimeCandidate
): number {
  return left.priority - right.priority || left.runtimeId.localeCompare(right.runtimeId);
}

function cloneCandidate(candidate: AgentRuntimeCandidate): AgentRuntimeCandidate {
  return { ...candidate, capabilities: [...candidate.capabilities] };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
