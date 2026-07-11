import type { BuildRuntime, BuildStepResult } from "./build-runtime.js";
import type {
  ProjectHandoffChoice,
  SchedulerEvent,
  SchedulerProjection,
} from "./scheduler-store.js";

export interface BuildControlPlane {
  projection(runId: string): SchedulerProjection;
  events(runId: string, afterSequence?: number): SchedulerEvent[];
  step(runId: string): Promise<BuildStepResult>;
  runUntilBlocked(runId: string, maxSteps?: number): Promise<BuildStepResult>;
  pause(runId: string, reason: string, idempotencyKey: string): SchedulerProjection;
  resume(runId: string, idempotencyKey: string): SchedulerProjection;
  selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): SchedulerProjection;
  selectProjectHandoff(
    runId: string,
    choice: ProjectHandoffChoice,
    idempotencyKey: string
  ): Promise<SchedulerProjection>;
}

export class BuildRuntimeRegistry implements BuildControlPlane {
  private readonly runtimes = new Map<string, BuildRuntime>();

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

  pause(runId: string, reason: string, idempotencyKey: string): SchedulerProjection {
    return this.require(runId).pause(reason, idempotencyKey);
  }

  resume(runId: string, idempotencyKey: string): SchedulerProjection {
    return this.require(runId).resume(idempotencyKey);
  }

  selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): SchedulerProjection {
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
