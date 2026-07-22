import type { BuildRuntime, BuildStepResult } from "./build-runtime.js";
import { emptyUsage } from "./budget-ledger.js";
import type {
  BuildObservabilitySnapshot,
  BuildTranscriptPage,
} from "./build-observability.js";
import type { IntegrationFileSnapshot } from "./integration-manager.js";
import type { NativeBuildUsageProjection } from "./model-usage-projection.js";
import type {
  ProjectHandoffChoice,
  SchedulerEvent,
  SchedulerProjection,
} from "./scheduler-store.js";

export interface BuildControlPlane {
  projection(runId: string): SchedulerProjection;
  usage(runId: string): NativeBuildUsageProjection;
  observability(runId: string): Promise<BuildObservabilitySnapshot>;
  transcript(runId: string, afterSequence?: number): Promise<BuildTranscriptPage>;
  files(runId: string): Promise<IntegrationFileSnapshot>;
  events(runId: string, afterSequence?: number): SchedulerEvent[];
  step(runId: string): Promise<BuildStepResult>;
  runUntilBlocked(runId: string, maxSteps?: number): Promise<BuildStepResult>;
  activate(runId: string): void;
  pause(runId: string, reason: string, idempotencyKey: string): Promise<SchedulerProjection>;
  resume(runId: string, idempotencyKey: string): Promise<SchedulerProjection>;
  continue(runId: string, idempotencyKey: string): Promise<SchedulerProjection>;
  selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): Promise<SchedulerProjection>;
  selectProjectHandoff(
    runId: string,
    choice: ProjectHandoffChoice,
    idempotencyKey: string
  ): Promise<SchedulerProjection>;
}

export class BuildRuntimeRegistry implements BuildControlPlane {
  private readonly runtimes = new Map<string, BuildRuntime>();
  private readonly pumps = new Map<string, Promise<void>>();

  register(runtime: BuildRuntime): void {
    if (this.runtimes.has(runtime.id)) {
      throw new Error(`Build runtime ${runtime.id} is already registered.`);
    }
    this.runtimes.set(runtime.id, runtime);
  }

  unregister(runId: string): void {
    this.runtimes.delete(runId);
  }

  projection(runId: string): SchedulerProjection {
    return this.require(runId).projection();
  }

  usage(runId: string): NativeBuildUsageProjection {
    this.require(runId);
    return {
      scopeId: runId,
      reservations: {},
      activeSegments: {},
      effective: emptyUsage(),
      lifetime: emptyUsage(),
      window: { index: 1 },
      lastSequence: 0,
      attributedModelReservationCount: 0,
      models: [],
    };
  }

  async observability(runId: string): Promise<BuildObservabilitySnapshot> {
    return {
      runId,
      budget: this.usage(runId),
      toolCallCount: 0,
      agents: [],
      tools: [],
      evidence: [],
      memories: [],
      skills: [],
      processes: [],
      providers: [],
      events: [],
      git: { integrationBranch: "", integrationRevision: "", commits: [] },
    };
  }

  async transcript(runId: string, afterSequence = 0): Promise<BuildTranscriptPage> {
    this.require(runId);
    return { turns: [], cursor: afterSequence };
  }

  async files(runId: string): Promise<IntegrationFileSnapshot> {
    this.require(runId);
    throw new Error("Revision-backed files require the native Build manager.");
  }

  events(runId: string, afterSequence = 0): SchedulerEvent[] {
    return this.require(runId).events(afterSequence);
  }

  async step(runId: string): Promise<BuildStepResult> {
    return await this.require(runId).step();
  }

  async runUntilBlocked(
    runId: string,
    maxSteps?: number
  ): Promise<BuildStepResult> {
    return await this.require(runId).runUntilBlocked(maxSteps);
  }

  activate(runId: string): void {
    if (this.pumps.has(runId)) return;
    const pump = this.require(runId).runUntilBlocked().then(() => undefined).finally(() => {
      this.pumps.delete(runId);
    });
    this.pumps.set(runId, pump);
    void pump.catch(() => undefined);
  }

  async pause(runId: string, reason: string, idempotencyKey: string): Promise<SchedulerProjection> {
    return this.require(runId).pause(reason, idempotencyKey);
  }

  async resume(runId: string, idempotencyKey: string): Promise<SchedulerProjection> {
    return this.require(runId).resume(idempotencyKey);
  }

  async continue(runId: string, idempotencyKey: string): Promise<SchedulerProjection> {
    return this.require(runId).continue(idempotencyKey);
  }

  async selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): Promise<SchedulerProjection> {
    return this.require(runId).selectArchitectHandoff(runtimeId, idempotencyKey);
  }

  async selectProjectHandoff(
    _runId: string,
    _choice: ProjectHandoffChoice,
    _idempotencyKey: string
  ): Promise<SchedulerProjection> {
    throw new Error("Final project handoff requires the native Build manager.");
  }

  private require(runId: string): BuildRuntime {
    const runtime = this.runtimes.get(runId);
    if (!runtime) throw new Error(`Unknown build runtime ${runId}.`);
    return runtime;
  }
}
