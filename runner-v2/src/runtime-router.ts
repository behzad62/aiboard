import type {
  ProviderFailure,
  ProviderHealthRegistry,
} from "./provider-health.js";

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

export interface WorkerFailureRouteInput {
  currentRuntimeId: string;
  requiredCapabilities: string[];
  failure: ProviderFailure;
  handoff: WorkerHandoffPackage;
}

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

  constructor(options: RuntimeRouterOptions) {
    this.health = options.health;
    this.onDecision = options.onDecision;
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

  selectWorker(
    requiredCapabilities: readonly string[],
    excludedRuntimeIds: ReadonlySet<string> = new Set()
  ): WorkerSelection {
    const required = unique(requiredCapabilities);
    const runtime = this.eligible(required).find(
      (candidate) => !excludedRuntimeIds.has(candidate.runtimeId)
    );
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
