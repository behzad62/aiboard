import type { BuildRuntime, BuildStepResult } from "./build-runtime.js";
import type {
  BuildObservabilitySnapshot,
  BuildTranscriptPage,
} from "./build-observability.js";
import type { BuildControlPlane } from "./build-runtime-registry.js";
import type { BuildSpecStore, NativeBuildSpec } from "./build-spec.js";
import type { NativeBuildUsageProjection } from "./model-usage-projection.js";
import type {
  ProjectHandoffChoice,
  SchedulerActor,
  SchedulerEvent,
  SchedulerProjection,
} from "./scheduler-store.js";
import type {
  IntegrationFileSnapshot,
  ProjectHandoffResult,
} from "./integration-manager.js";

export interface NativeBuildRuntimeHandle {
  runtime: BuildRuntime;
  usage(): NativeBuildUsageProjection;
  observability(): Promise<BuildObservabilitySnapshot>;
  transcript(afterSequence?: number): Promise<BuildTranscriptPage>;
  files(): Promise<IntegrationFileSnapshot>;
  compact(): void | Promise<void>;
  projectHandoff(choice: ProjectHandoffChoice): Promise<ProjectHandoffResult>;
  cleanup(): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface NativeBuildManagerOptions {
  specs: BuildSpecStore;
  createRuntime(spec: NativeBuildSpec): Promise<NativeBuildRuntimeHandle>;
  shouldAutoRun?(runId: string): boolean;
  onPumpResult?(runId: string, result: BuildStepResult): void;
  onPumpError?(runId: string, error: unknown): void;
  runArtifactCompaction?(operation: () => Promise<void>): Promise<void>;
  prepareArtifactCleanup?(): Promise<void>;
}

export class NativeBuildManager implements BuildControlPlane {
  private readonly handles = new Map<string, NativeBuildRuntimeHandle>();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly settledRuns = new Set<string>();
  private operationQueue = Promise.resolve();
  private activityGateClosed = false;
  private activeRuntimeOperations = 0;
  private readonly activityWaiters: Array<{
    resolve(release: () => void): void;
    reject(error: Error): void;
  }> = [];
  private readonly activityIdleWaiters: Array<() => void> = [];
  private liveCompaction: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private closing = false;
  private closed = false;

  constructor(private readonly options: NativeBuildManagerOptions) {}

  async recover(): Promise<void> {
    const active: string[] = [];
    const settled: Array<[string, NativeBuildRuntimeHandle]> = [];
    await this.serialized(async () => {
      for (const spec of this.options.specs.list()) {
        const handle = await this.ensureRuntime(spec);
        const status = handle.runtime.projection().status;
        if (status === "completed") {
          settled.push([spec.runId, handle]);
        }
        if (this.options.shouldAutoRun?.(spec.runId)) active.push(spec.runId);
      }
    });
    const compactAndCleanup = async () => {
      await this.compactEligibleRuns();
      if (this.options.prepareArtifactCleanup) {
        try {
          await this.options.prepareArtifactCleanup();
          await this.compactEligibleRuns();
        } catch (error) {
          this.options.onPumpError?.("startup-artifact-reachability", error);
        }
      }
      for (const [runId, handle] of settled) {
        await this.tryCleanupSettledRun(runId, handle);
      }
    };
    if (this.options.runArtifactCompaction) {
      await this.options.runArtifactCompaction(compactAndCleanup);
    } else {
      await compactAndCleanup();
    }
    for (const runId of active) {
      if (this.require(runId).runtime.projection().status === "completed") {
        this.options.onPumpResult?.(runId, {
          status: "completed",
          action: "recovered_settled_build",
        });
      } else {
        this.activate(runId);
      }
    }
  }

  async create(spec: NativeBuildSpec): Promise<SchedulerProjection> {
    return await this.serialized(async () => {
      const saved = this.options.specs.save(spec);
      const handle = await this.ensureRuntime(saved);
      return handle.runtime.projection();
    });
  }

  listSpecs(projectId?: string): NativeBuildSpec[] {
    return this.options.specs
      .list()
      .filter((spec) => projectId === undefined || spec.projectId === projectId);
  }

  projection(runId: string): SchedulerProjection {
    return this.require(runId).runtime.projection();
  }

  usage(runId: string): NativeBuildUsageProjection {
    return this.require(runId).usage();
  }

  async observability(runId: string): Promise<BuildObservabilitySnapshot> {
    return await this.require(runId).observability();
  }

  async transcript(runId: string, afterSequence = 0): Promise<BuildTranscriptPage> {
    return await this.require(runId).transcript(afterSequence);
  }

  async files(runId: string): Promise<IntegrationFileSnapshot> {
    return await this.require(runId).files();
  }

  events(runId: string, afterSequence = 0): SchedulerEvent[] {
    return this.require(runId).runtime.events(afterSequence);
  }

  async step(runId: string): Promise<BuildStepResult> {
    const handle = this.require(runId);
    return await this.executeWithFinalization(
      runId,
      handle,
      () => handle.runtime.step()
    );
  }

  async runUntilBlocked(runId: string, maxSteps?: number): Promise<BuildStepResult> {
    const handle = this.require(runId);
    return await this.executeWithFinalization(
      runId,
      handle,
      () => handle.runtime.runUntilBlocked(maxSteps)
    );
  }

  activate(runId: string): void {
    this.assertOpen();
    if (this.pumps.has(runId)) return;
    const handle = this.require(runId);
    const projection = handle.runtime.projection();
    if (
      projection.status !== "running" &&
      projection.projectHandoff?.status !== "requested" &&
      !(projection.status === "completed" && !this.settledRuns.has(runId))
    ) return;
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

  async pause(
    runId: string,
    reason: string,
    idempotencyKey: string
  ): Promise<SchedulerProjection> {
    const handle = this.require(runId);
    return await this.withRuntimeActivity(async () =>
      handle.runtime.pause(reason, idempotencyKey)
    );
  }

  async resume(runId: string, idempotencyKey: string): Promise<SchedulerProjection> {
    const handle = this.require(runId);
    return await this.withRuntimeActivity(async () =>
      handle.runtime.resume(idempotencyKey)
    );
  }

  async continue(runId: string, idempotencyKey: string): Promise<SchedulerProjection> {
    if (!this.options.specs.get(runId).benchmark) {
      throw new Error("Non-renewing continuation is restricted to benchmark Builds.");
    }
    const handle = this.require(runId);
    return await this.withRuntimeActivity(async () =>
      handle.runtime.continue(idempotencyKey)
    );
  }

  async selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): Promise<SchedulerProjection> {
    const handle = this.require(runId);
    return await this.withRuntimeActivity(async () =>
      handle.runtime.selectArchitectHandoff(runtimeId, idempotencyKey)
    );
  }

  async selectProjectHandoff(
    runId: string,
    choice: ProjectHandoffChoice,
    idempotencyKey: string
  ): Promise<SchedulerProjection> {
    return await this.selectProjectHandoffAs(
      runId,
      choice,
      idempotencyKey,
      { role: "user", id: "local-user" }
    );
  }

  private async selectProjectHandoffAs(
    runId: string,
    choice: ProjectHandoffChoice,
    idempotencyKey: string,
    actor: SchedulerActor
  ): Promise<SchedulerProjection> {
    const releaseActivity = await this.acquireRuntimeActivity();
    const compaction = this.requestLiveCompaction();
    let selected: SchedulerProjection;
    try {
      selected = await this.selectProjectHandoffInsideActivity(
        runId,
        choice,
        idempotencyKey,
        actor
      );
    } finally {
      releaseActivity();
    }
    await compaction;
    return selected;
  }

  private async selectProjectHandoffInsideActivity(
    runId: string,
    choice: ProjectHandoffChoice,
    idempotencyKey: string,
    actor: SchedulerActor
  ): Promise<SchedulerProjection> {
    return await this.serialized(async () => {
      const handle = this.handles.get(runId);
      if (!handle) throw new Error(`Unknown build runtime ${runId}.`);
      const projection = handle.runtime.projection();
      if (projection.projectHandoff?.status === "selected") {
        if (projection.projectHandoff.choice !== choice) {
          throw new Error(
            `Final project handoff already selected ${projection.projectHandoff.choice}.`
          );
        }
        await this.tryCleanupSettledRun(runId, handle);
        return projection;
      }
      if (projection.projectHandoff?.status !== "requested") {
        throw new Error("Final project handoff is not awaiting user selection.");
      }
      const result = await handle.projectHandoff(choice);
      const selected = handle.runtime.selectProjectHandoff(
        choice,
        result,
        idempotencyKey,
        actor
      );
      await this.tryCleanupSettledRun(runId, handle);
      return selected;
    });
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.activityGateClosed = true;
      this.rejectActivityWaiters();
      this.closePromise = this.closeAfterPumps();
    }
    await this.closePromise;
  }

  private async closeAfterPumps(): Promise<void> {
    await this.awaitIdle();
    if (this.liveCompaction) await this.liveCompaction;
    await this.waitForRuntimeActivityIdle();
    this.closed = true;
    await this.serialized(async () => {
      const handles = [...this.handles.values()];
      this.handles.clear();
      const failures: unknown[] = [];
      for (const handle of handles) {
        if (handle.runtime.projection().status === "completed") {
          try {
            await this.cleanupSettledRun(handle.runtime.id, handle);
          } catch (error) {
            failures.push(error);
          }
        }
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
    let releaseActivity: (() => void) | undefined;
    try {
      releaseActivity = await this.acquireRuntimeActivity();
    } catch (error) {
      if (this.closing) return;
      throw error;
    }
    let compaction: Promise<void> | undefined;
    try {
      let result = await handle.runtime.runUntilBlocked();
      while (
        result.status === "progressed" &&
        handle.runtime.projection().status === "running"
      ) {
        await eventLoopYield();
        result = await handle.runtime.runUntilBlocked();
      }
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
      const finalized = await this.finalizeExecutionInsideActivity(
        runId,
        handle,
        result
      );
      result = finalized.result;
      compaction = finalized.compaction;
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
    } finally {
      releaseActivity();
      if (compaction) await compaction;
    }
  }

  private async executeWithFinalization(
    runId: string,
    handle: NativeBuildRuntimeHandle,
    execute: () => Promise<BuildStepResult>
  ): Promise<BuildStepResult> {
    const releaseActivity = await this.acquireRuntimeActivity();
    let result!: BuildStepResult;
    let compaction: Promise<void> | undefined;
    try {
      const finalized = await this.finalizeExecutionInsideActivity(
        runId,
        handle,
        await execute()
      );
      result = finalized.result;
      compaction = finalized.compaction;
    } finally {
      releaseActivity();
      if (compaction) await compaction;
    }
    return result;
  }

  private async finalizeExecutionInsideActivity(
    runId: string,
    handle: NativeBuildRuntimeHandle,
    result: BuildStepResult
  ): Promise<{ result: BuildStepResult; compaction?: Promise<void> }> {
    const projection = handle.runtime.projection();
    if (
      projection.projectHandoff?.status === "requested" &&
      (projection.runPolicy === "finish" || projection.runPolicy === "budgeted")
    ) {
      if (this.settledRuns.has(runId)) {
        return {
          result: {
            status: "completed",
            action: "automatic_project_handoff_applied",
          },
        };
      }
      const compaction = this.requestLiveCompaction();
      try {
        await this.selectProjectHandoffInsideActivity(
          runId,
          "apply_to_project",
          "automatic-project-handoff",
          { role: "runner", id: "native-build-manager" }
        );
        return {
          result: {
            status: "completed",
            action: "automatic_project_handoff_applied",
          },
          compaction,
        };
      } catch (error) {
        this.options.onPumpError?.(runId, error);
        return {
          result: {
            status: "paused",
            action: "automatic_project_handoff_failed",
          },
          compaction,
        };
      }
    }
    if (projection.status === "completed") {
      if (this.settledRuns.has(runId)) return { result };
      const compaction = this.requestLiveCompaction();
      try {
        await this.cleanupSettledRun(runId, handle);
      } catch (error) {
        this.options.onPumpError?.(runId, error);
      }
      return { result: { status: "completed", action: result.action }, compaction };
    }
    return { result };
  }

  private requestLiveCompaction(): Promise<void> {
    if (!this.options.runArtifactCompaction || !this.options.prepareArtifactCleanup) {
      return Promise.resolve();
    }
    if (this.liveCompaction) return this.liveCompaction;

    // Close synchronously while the settling caller still holds its lease.
    // It can queue tombstones, release itself, and only then can this scan run.
    this.activityGateClosed = true;
    const slot: { generation?: Promise<void> } = {};
    const generation = (async () => {
      await this.waitForRuntimeActivityIdle();
      try {
        await this.options.runArtifactCompaction!(async () => {
          await this.compactEligibleRuns();
          await this.options.prepareArtifactCleanup!();
          await this.compactEligibleRuns();
        });
      } catch (error) {
        this.options.onPumpError?.("live-artifact-reachability", error);
      } finally {
        if (this.liveCompaction === slot.generation) this.liveCompaction = undefined;
        this.openRuntimeActivityGate();
      }
    })();
    slot.generation = generation;
    this.liveCompaction = generation;
    return generation;
  }

  private async withRuntimeActivity<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireRuntimeActivity();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquireRuntimeActivity(): Promise<() => void> {
    this.assertOpen();
    if (!this.activityGateClosed) {
      this.activeRuntimeOperations += 1;
      return Promise.resolve(this.runtimeActivityRelease());
    }
    return new Promise((resolve, reject) => {
      this.activityWaiters.push({ resolve, reject });
    });
  }

  private runtimeActivityRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRuntimeOperations -= 1;
      if (this.activeRuntimeOperations === 0) {
        for (const resolve of this.activityIdleWaiters.splice(0)) resolve();
      }
    };
  }

  private waitForRuntimeActivityIdle(): Promise<void> {
    if (this.activeRuntimeOperations === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.activityIdleWaiters.push(resolve);
    });
  }

  private openRuntimeActivityGate(): void {
    if (this.closing) {
      this.activityGateClosed = true;
      this.rejectActivityWaiters();
      return;
    }
    this.activityGateClosed = false;
    for (const { resolve } of this.activityWaiters.splice(0)) {
      this.activeRuntimeOperations += 1;
      resolve(this.runtimeActivityRelease());
    }
  }

  private rejectActivityWaiters(): void {
    const error = new Error("Native Build manager is closing.");
    for (const { reject } of this.activityWaiters.splice(0)) reject(error);
  }

  private async cleanupSettledRun(
    runId: string,
    handle: NativeBuildRuntimeHandle
  ): Promise<void> {
    if (this.settledRuns.has(runId)) return;
    await handle.cleanup();
    this.settledRuns.add(runId);
  }

  private async compactRuns(
    runs: Array<[string, NativeBuildRuntimeHandle]>
  ): Promise<void> {
    for (const [runId, handle] of runs) {
      try {
        await handle.compact();
      } catch (error) {
        this.options.onPumpError?.(runId, error);
      }
    }
  }

  private async compactEligibleRuns(): Promise<void> {
    await this.compactRuns(
      [...this.handles.entries()].filter(
        ([, handle]) => handle.runtime.projection().status !== "running"
      )
    );
  }

  private async tryCleanupSettledRun(
    runId: string,
    handle: NativeBuildRuntimeHandle
  ): Promise<void> {
    try {
      await this.cleanupSettledRun(runId, handle);
    } catch (error) {
      this.options.onPumpError?.(runId, error);
    }
  }

  private require(runId: string): NativeBuildRuntimeHandle {
    this.assertOpen();
    const handle = this.handles.get(runId);
    if (!handle) throw new Error(`Unknown build runtime ${runId}.`);
    return handle;
  }

  private assertOpen(): void {
    if (this.closed || this.closing) throw new Error("Native Build manager is closed.");
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

function eventLoopYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
