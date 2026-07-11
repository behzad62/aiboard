import type { BuildRuntime, BuildStepResult } from "./build-runtime.js";
import type {
  SchedulerEvent,
  SchedulerProjection,
} from "./scheduler-store.js";

export interface BuildControlPlane {
  projection(runId: string): SchedulerProjection;
  events(runId: string, afterSequence?: number): SchedulerEvent[];
  step(runId: string): Promise<BuildStepResult>;
  runUntilBlocked(runId: string, maxSteps?: number): Promise<BuildStepResult>;
  selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): SchedulerProjection;
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

  selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): SchedulerProjection {
    return this.require(runId).selectArchitectHandoff(runtimeId, idempotencyKey);
  }

  private require(runId: string): BuildRuntime {
    const runtime = this.runtimes.get(runId);
    if (!runtime) throw new Error(`Unknown build runtime ${runId}.`);
    return runtime;
  }
}
