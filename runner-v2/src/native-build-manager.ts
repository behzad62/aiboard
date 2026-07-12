import type { BuildRuntime, BuildStepResult } from "./build-runtime.js";
import type { BudgetProjection } from "./budget-ledger.js";
import type { BuildObservabilitySnapshot } from "./build-observability.js";
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
  usage(): BudgetProjection;
  observability(): Promise<BuildObservabilitySnapshot>;
  projectHandoff(choice: ProjectHandoffChoice): Promise<ProjectHandoffResult>;
  close(): void | Promise<void>;
}

export interface NativeBuildManagerOptions {
  specs: BuildSpecStore;
  createRuntime(spec: NativeBuildSpec): Promise<NativeBuildRuntimeHandle>;
  shouldAutoRun?(runId: string): boolean;
  onPumpResult?(runId: string, result: BuildStepResult): void;
  onPumpError?(runId: string, error: unknown): void;
}

export class NativeBuildManager implements BuildControlPlane {
  private readonly handles = new Map<string, NativeBuildRuntimeHandle>();
  private readonly pumps = new Map<string, Promise<void>>();
  private operationQueue = Promise.resolve();
  private closed = false;

  constructor(private readonly options: NativeBuildManagerOptions) {}

  async recover(): Promise<void> {
    const active: string[] = [];
    await this.serialized(async () => {
      for (const spec of this.options.specs.list()) {
        await this.ensureRuntime(spec);
        if (this.options.shouldAutoRun?.(spec.runId)) active.push(spec.runId);
      }
    });
    for (const runId of active) this.activate(runId);
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

  usage(runId: string): BudgetProjection {
    return this.require(runId).usage();
  }

  async observability(runId: string): Promise<BuildObservabilitySnapshot> {
    return await this.require(runId).observability();
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

  activate(runId: string): void {
    this.assertOpen();
    if (this.pumps.has(runId)) return;
    const handle = this.require(runId);
    if (handle.runtime.projection().status !== "running") return;
    const pump = this.pump(runId, handle).finally(() => {
      this.pumps.delete(runId);
    });
    this.pumps.set(runId, pump);
    void pump.catch(() => undefined);
  }

  async awaitIdle(runId?: string): Promise<void> {
    if (runId) {
      const pump = this.pumps.get(runId);
      if (pump) await pump;
      return;
    }
    await Promise.all([...this.pumps.values()]);
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
    if (projection.projectHandoff?.status === "selected") {
      if (projection.projectHandoff.choice !== choice) {
        throw new Error(
          `Final project handoff already selected ${projection.projectHandoff.choice}.`
        );
      }
      return projection;
    }
    if (projection.projectHandoff?.status !== "requested") {
      throw new Error("Final project handoff is not awaiting user selection.");
    }
    const result = await handle.projectHandoff(choice);
    return handle.runtime.selectProjectHandoff(choice, result, idempotencyKey);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.awaitIdle();
    await this.serialized(async () => {
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

  private async pump(
    runId: string,
    handle: NativeBuildRuntimeHandle
  ): Promise<void> {
    try {
      let result = await handle.runtime.runUntilBlocked();
      if (result.status === "idle") {
        const projection = handle.runtime.projection();
        if (projection.status === "running") {
          handle.runtime.pause(
            "no_mechanical_progress",
            `autonomous-idle:${projection.lastSequence}`
          );
        }
        result = { status: "paused", action: "no_mechanical_progress" };
      }
      this.options.onPumpResult?.(runId, result);
    } catch (error) {
      const projection = handle.runtime.projection();
      if (projection.status === "running") {
        handle.runtime.pause(
          "autonomous_pump_error",
          `autonomous-error:${projection.lastSequence}`
        );
      }
      this.options.onPumpError?.(runId, error);
      this.options.onPumpResult?.(runId, {
        status: "paused",
        action: "autonomous_pump_error",
      });
    }
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
