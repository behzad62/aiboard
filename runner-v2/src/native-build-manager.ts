import type { BuildRuntime, BuildStepResult } from "./build-runtime.js";
import type { BuildControlPlane } from "./build-runtime-registry.js";
import type { BuildSpecStore, NativeBuildSpec } from "./build-spec.js";
import type {
  ProjectHandoffChoice,
  SchedulerEvent,
  SchedulerProjection,
} from "./scheduler-store.js";
import type { ProjectHandoffResult } from "./integration-manager.js";

export interface NativeBuildRuntimeHandle {
  runtime: BuildRuntime;
  projectHandoff(choice: ProjectHandoffChoice): Promise<ProjectHandoffResult>;
  close(): void | Promise<void>;
}

export interface NativeBuildManagerOptions {
  specs: BuildSpecStore;
  createRuntime(spec: NativeBuildSpec): Promise<NativeBuildRuntimeHandle>;
}

export class NativeBuildManager implements BuildControlPlane {
  private readonly handles = new Map<string, NativeBuildRuntimeHandle>();
  private operationQueue = Promise.resolve();
  private closed = false;

  constructor(private readonly options: NativeBuildManagerOptions) {}

  async recover(): Promise<void> {
    await this.serialized(async () => {
      for (const spec of this.options.specs.list()) {
        await this.ensureRuntime(spec);
      }
    });
  }

  async create(spec: NativeBuildSpec): Promise<SchedulerProjection> {
    return await this.serialized(async () => {
      const saved = this.options.specs.save(spec);
      const handle = await this.ensureRuntime(saved);
      return handle.runtime.projection();
    });
  }

  projection(runId: string): SchedulerProjection {
    return this.require(runId).runtime.projection();
  }

  events(runId: string, afterSequence = 0): SchedulerEvent[] {
    return this.require(runId).runtime.events(afterSequence);
  }

  async step(runId: string): Promise<BuildStepResult> {
    return await this.require(runId).runtime.step();
  }

  async runUntilBlocked(runId: string, maxSteps?: number): Promise<BuildStepResult> {
    return await this.require(runId).runtime.runUntilBlocked(maxSteps);
  }

  pause(runId: string, reason: string, idempotencyKey: string): SchedulerProjection {
    return this.require(runId).runtime.pause(reason, idempotencyKey);
  }

  resume(runId: string, idempotencyKey: string): SchedulerProjection {
    return this.require(runId).runtime.resume(idempotencyKey);
  }

  selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): SchedulerProjection {
    return this.require(runId).runtime.selectArchitectHandoff(
      runtimeId,
      idempotencyKey
    );
  }

  async selectProjectHandoff(
    runId: string,
    choice: ProjectHandoffChoice,
    idempotencyKey: string
  ): Promise<SchedulerProjection> {
    const handle = this.require(runId);
    const projection = handle.runtime.projection();
    if (projection.projectHandoff?.status !== "requested") {
      throw new Error("Final project handoff is not awaiting user selection.");
    }
    const result = await handle.projectHandoff(choice);
    return handle.runtime.selectProjectHandoff(choice, result, idempotencyKey);
  }

  async close(): Promise<void> {
    await this.serialized(async () => {
      if (this.closed) return;
      this.closed = true;
      const handles = [...this.handles.values()];
      this.handles.clear();
      const failures: unknown[] = [];
      for (const handle of handles) {
        try {
          await handle.close();
        } catch (error) {
          failures.push(error);
        }
      }
      this.options.specs.close();
      if (failures.length > 0) {
        throw new AggregateError(failures, "Could not close native Build resources.");
      }
    });
  }

  private async ensureRuntime(spec: NativeBuildSpec): Promise<NativeBuildRuntimeHandle> {
    this.assertOpen();
    const existing = this.handles.get(spec.runId);
    if (existing) return existing;
    const handle = await this.options.createRuntime(spec);
    if (handle.runtime.id !== spec.runId) {
      await handle.close();
      throw new Error(`Build runtime identity mismatch for ${spec.runId}.`);
    }
    this.handles.set(spec.runId, handle);
    return handle;
  }

  private require(runId: string): NativeBuildRuntimeHandle {
    this.assertOpen();
    const handle = this.handles.get(runId);
    if (!handle) throw new Error(`Unknown build runtime ${runId}.`);
    return handle;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Native Build manager is closed.");
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
