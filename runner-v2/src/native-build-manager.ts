import type { BuildRuntime, BuildStepResult } from "./build-runtime.js";
import type {
  BuildObservabilitySnapshot,
  BuildTranscriptPage,
} from "./build-observability.js";
import type {
  ArchitectQuestionAnswerControlInput,
  BuildControlPlane,
  UserGuidanceControlInput,
} from "./build-runtime-registry.js";
import type { BuildSpecStore, NativeBuildSpec } from "./build-spec.js";
import type { NativeBuildUsageProjection } from "./model-usage-projection.js";
import type {
  ProjectHandoffChoice,
  SchedulerActor,
  SchedulerEvent,
  FinalVerificationGenerationProjection,
  SchedulerProjection,
} from "./scheduler-store.js";
import { assertBuildCompletionReady } from "./scheduler-store.js";
import type {
  IntegrationFileSnapshot,
  ProjectHandoffResult,
} from "./integration-manager.js";
import type { FinalVerificationCleanupController } from "./final-verification-cleanup.js";

export interface NativeBuildRuntimeHandle {
  runtime: BuildRuntime;
  /** A durable terminal projection with no mutable runtime authority. */
  historical?: true;
  usage(): NativeBuildUsageProjection;
  observability(): Promise<BuildObservabilitySnapshot>;
  transcript(afterSequence?: number): Promise<BuildTranscriptPage>;
  files(): Promise<IntegrationFileSnapshot>;
  compact(): void | Promise<void>;
  projectHandoff(choice: ProjectHandoffChoice): Promise<ProjectHandoffResult>;
  /** Constructed cleanup primitive; lifecycle wiring is owned by the P2.6 manager packet. */
  finalVerificationCleanup?: FinalVerificationCleanupController;
  retireInvalidatedFinalVerification?(
    generation: FinalVerificationGenerationProjection,
    currentGeneration?: FinalVerificationGenerationProjection,
  ): Promise<void>;
  cleanup(): void | Promise<void>;
  close(): void | Promise<void>;
}

/** Authoritative lifecycle states that may be projected by a terminal reader. */
export type HistoricalTerminalState = "completed" | "failed" | "stopped";

export interface NativeBuildManagerOptions {
  specs: BuildSpecStore;
  createRuntime(spec: NativeBuildSpec): Promise<NativeBuildRuntimeHandle>;
  /** Stamps runner-owned durable identity before a new Build spec is persisted. */
  prepareSpec?(spec: NativeBuildSpec): Promise<NativeBuildSpec>;
  /** Rejects a stored spec before recovery can construct its runtime or model clients. */
  validateRecoveredSpec?(spec: NativeBuildSpec): Promise<void>;
  /** Allows callers with an authoritative lifecycle store to omit settled runs from recovery. */
  shouldRecoverSpec?(spec: NativeBuildSpec): boolean | Promise<boolean>;
  /** Opens storage-backed terminal projections without constructing a live runtime. */
  createHistoricalRuntime?(
    spec: NativeBuildSpec,
    terminalState: HistoricalTerminalState,
  ): Promise<NativeBuildRuntimeHandle>;
  /**
   * The RunSupervisor-derived terminal state. Historical Build reads must not
   * infer completion from an incomplete or absent scheduler log.
   */
  terminalStateForHistoricalSpec?(
    spec: NativeBuildSpec,
  ): HistoricalTerminalState | undefined | Promise<HistoricalTerminalState | undefined>;
  /** Records a durable recovery validation failure without starting the rejected Build. */
  onRecoverySpecError?(runId: string, error: unknown): void;
  shouldAutoRun?(runId: string): boolean;
  onPumpResult?(runId: string, result: BuildStepResult): void;
  onPumpError?(runId: string, error: unknown): void;
  runArtifactCompaction?(operation: () => Promise<void>): Promise<void>;
  prepareArtifactCleanup?(): Promise<void>;
}

type NativeBuildHandleShutdownPhase =
  | "status_pending"
  | "settled_cleanup_pending"
  | "ready_for_teardown"
  | "teardown_started";

interface NativeBuildHandleShutdownState {
  phase: NativeBuildHandleShutdownPhase;
}

export class NativeBuildManager implements BuildControlPlane {
  private readonly handles = new Map<string, NativeBuildRuntimeHandle>();
  private readonly handleShutdown = new Map<string, NativeBuildHandleShutdownState>();
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
  private specsClosed = false;

  constructor(private readonly options: NativeBuildManagerOptions) {}

  async recover(): Promise<void> {
    const active: string[] = [];
    const settled: Array<[string, NativeBuildRuntimeHandle]> = [];
    const quiesceFailed = new Set<string>();
    await this.serialized(async () => {
      for (const spec of this.options.specs.list()) {
        try {
          if (this.options.shouldRecoverSpec && !await this.options.shouldRecoverSpec(spec)) {
            await this.ensureHistoricalRuntime(spec);
            continue;
          }
          await this.options.validateRecoveredSpec?.(spec);
        } catch (error) {
          this.options.onRecoverySpecError?.(spec.runId, error);
          this.options.onPumpError?.(spec.runId, error);
          continue;
        }
        let handle: NativeBuildRuntimeHandle;
        try {
          handle = await this.ensureRuntime(spec);
        } catch (error) {
          this.options.onRecoverySpecError?.(spec.runId, error);
          this.options.onPumpError?.(spec.runId, error);
          continue;
        }
        try {
          const projection = handle.runtime.projection();
          const pendingInterruptions = Object.values(projection.userGuidance ?? {})
            .filter((guidance) => guidance.interruptionStatus !== "completed")
            .sort((left, right) => left.version - right.version);
          const orphanedInvalidations = (projection.finalVerification?.history ?? [])
            .filter((generation) =>
              generation.invalidatedByGuidanceId &&
              !projection.userGuidance?.[generation.invalidatedByGuidanceId]
            );
          if (pendingInterruptions.length === 0 && orphanedInvalidations.length === 0) {
            await handle.finalVerificationCleanup?.quiesceRun();
          } else {
            for (const guidance of pendingInterruptions) {
              const interrupted = (projection.finalVerification?.history ?? [])
                .filter((generation) =>
                  generation.invalidatedByGuidanceId === guidance.guidanceId
                );
              if (interrupted.length > 0 && handle.retireInvalidatedFinalVerification) {
                for (const generation of interrupted) {
                  await handle.retireInvalidatedFinalVerification(
                    generation,
                    projection.finalVerification?.current,
                  );
                }
              } else {
                await handle.finalVerificationCleanup?.quiesceRun();
              }
              handle.runtime.completeManagedUserGuidanceInterruption(
                guidance.guidanceId,
                guidance.version,
              );
            }
            for (const generation of orphanedInvalidations) {
              await handle.retireInvalidatedFinalVerification?.(
                generation,
                projection.finalVerification?.current,
              );
            }
          }
        } catch (error) {
          quiesceFailed.add(spec.runId);
          this.options.onPumpError?.(spec.runId, error);
        }
        const status = handle.runtime.projection().status;
        if (status === "completed" && !quiesceFailed.has(spec.runId)) {
          settled.push([spec.runId, handle]);
        }
        if (!quiesceFailed.has(spec.runId) && this.options.shouldAutoRun?.(spec.runId)) active.push(spec.runId);
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
      const prepared = this.options.prepareSpec
        ? await this.options.prepareSpec(spec)
        : spec;
      const saved = this.options.specs.save(prepared);
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
    const handle = this.requireMutable(runId);
    return await this.executeWithFinalization(
      runId,
      handle,
      () => handle.runtime.step()
    );
  }

  async runUntilBlocked(runId: string, maxSteps?: number): Promise<BuildStepResult> {
    const handle = this.requireMutable(runId);
    return await this.executeWithFinalization(
      runId,
      handle,
      () => handle.runtime.runUntilBlocked(maxSteps)
    );
  }

  activate(runId: string): void {
    this.assertOpen();
    const handle = this.requireMutable(runId);
    if (this.pumps.has(runId)) return;
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

  async submitUserGuidance(
    runId: string,
    input: UserGuidanceControlInput
  ): Promise<SchedulerProjection> {
    this.requireMutable(runId);
    const result = await this.withRuntimeActivity(async () =>
      this.serialized(async () => {
        const handle = this.requireMutable(runId);
        const submitted = typeof handle.runtime.submitManagedUserGuidance === "function"
          ? handle.runtime.submitManagedUserGuidance(input)
          : handle.runtime.submitUserGuidance(input);
        const guidance = submitted.userGuidance?.[input.guidanceId];
        if (guidance?.interruptionStatus === "completed") {
          return { projection: submitted, shouldWake: false };
        }
        const interrupted = submitted.status === "completed"
          ? undefined
          : [...(submitted.finalVerification?.history ?? [])]
              .reverse()
              .find((generation) =>
                generation.invalidatedByGuidanceId === input.guidanceId
              );
        if (interrupted && handle.retireInvalidatedFinalVerification) {
          await handle.retireInvalidatedFinalVerification(
            interrupted,
            submitted.finalVerification?.current,
          );
        } else {
          await handle.finalVerificationCleanup?.quiesceRun();
        }
        const projection = typeof handle.runtime.completeManagedUserGuidanceInterruption === "function"
          ? handle.runtime.completeManagedUserGuidanceInterruption(
              input.guidanceId,
              input.version,
            )
          : submitted;
        return { projection, shouldWake: true };
      })
    );
    if (result.shouldWake) this.wake(runId);
    return result.projection;
  }

  async answerArchitectQuestion(
    runId: string,
    input: ArchitectQuestionAnswerControlInput
  ): Promise<SchedulerProjection> {
    const handle = this.requireMutable(runId);
    const projection = await this.withRuntimeActivity(async () =>
      handle.runtime.answerArchitectQuestion(input)
    );
    this.wake(runId);
    return projection;
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
    const handle = this.requireMutable(runId);
    return await this.withRuntimeActivity(async () => {
      const projection = handle.runtime.pause(reason, idempotencyKey);
      await handle.finalVerificationCleanup?.quiesceRun();
      return projection;
    });
  }

  async resume(runId: string, idempotencyKey: string): Promise<SchedulerProjection> {
    const handle = this.requireMutable(runId);
    return await this.withRuntimeActivity(async () =>
      handle.runtime.resume(idempotencyKey)
    );
  }

  async continue(runId: string, idempotencyKey: string): Promise<SchedulerProjection> {
    const handle = this.requireMutable(runId);
    if (!this.options.specs.get(runId).benchmark) {
      throw new Error("Non-renewing continuation is restricted to benchmark Builds.");
    }
    return await this.withRuntimeActivity(async () =>
      handle.runtime.continue(idempotencyKey)
    );
  }

  async selectArchitectHandoff(
    runId: string,
    runtimeId: string,
    idempotencyKey: string
  ): Promise<SchedulerProjection> {
    const handle = this.requireMutable(runId);
    return await this.withRuntimeActivity(async () =>
      handle.runtime.selectArchitectHandoff(runtimeId, idempotencyKey)
    );
  }

  async selectVerifierRuntime(
    runId: string,
    runtimeId: string,
    idempotencyKey: string,
  ): Promise<SchedulerProjection> {
    const handle = this.requireMutable(runId);
    const projection = await this.withRuntimeActivity(async () =>
      handle.runtime.selectVerifierRuntime(runtimeId, idempotencyKey)
    );
    this.wake(runId);
    return projection;
  }

  async selectProjectHandoff(
    runId: string,
    choice: ProjectHandoffChoice,
    idempotencyKey: string
  ): Promise<SchedulerProjection> {
    this.requireMutable(runId);
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
    this.requireMutable(runId);
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
      // This path already owns a runtime-activity lease. It must finish an
      // in-flight automatic handoff when close begins, while still refusing
      // historical handles without reopening public mutation authority.
      const handle = this.requireMutableWithinActivity(runId);
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
      assertBuildCompletionReady(projection);
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
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.activityGateClosed = true;
    this.rejectActivityWaiters();
    const attempt = this.closeAfterPumps();
    this.closePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.closePromise === attempt) this.closePromise = undefined;
      throw error;
    }
  }

  private async closeAfterPumps(): Promise<void> {
    await this.awaitIdle();
    if (this.liveCompaction) await this.liveCompaction;
    await this.waitForRuntimeActivityIdle();
    this.closed = true;
    await this.serialized(async () => {
      const failures: unknown[] = [];
      for (const [runId, handle] of [...this.handles.entries()]) {
        if (await this.closeHandle(runId, handle, failures)) {
          this.handles.delete(runId);
          this.handleShutdown.delete(runId);
        }
      }
      if (!this.specsClosed) {
        try {
          this.options.specs.close();
          this.specsClosed = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Could not close native Build resources.");
      }
    });
  }

  private async closeHandle(
    runId: string,
    handle: NativeBuildRuntimeHandle,
    failures: unknown[],
  ): Promise<boolean> {
    const shutdown = this.handleShutdown.get(runId) ?? { phase: "status_pending" };
    this.handleShutdown.set(runId, shutdown);
    if (shutdown.phase === "status_pending") {
      try {
        shutdown.phase = !handle.historical && handle.runtime.projection().status === "completed"
          ? "settled_cleanup_pending"
          : "ready_for_teardown";
      } catch (error) {
        failures.push(error);
        shutdown.phase = "ready_for_teardown";
      }
    }
    if (shutdown.phase === "settled_cleanup_pending") {
      try {
        await this.cleanupSettledRun(runId, handle);
        shutdown.phase = "ready_for_teardown";
      } catch (error) {
        failures.push(error);
        return false;
      }
    }
    if (shutdown.phase === "ready_for_teardown") {
      shutdown.phase = "teardown_started";
    }
    try {
      await handle.close();
      return true;
    } catch (error) {
      failures.push(error);
      return false;
    }
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

  private async ensureHistoricalRuntime(
    spec: NativeBuildSpec,
  ): Promise<NativeBuildRuntimeHandle | undefined> {
    const existing = this.handles.get(spec.runId);
    if (existing) return existing;
    if (!this.options.createHistoricalRuntime) return undefined;
    const terminalState = await this.options.terminalStateForHistoricalSpec?.(spec);
    if (!isHistoricalTerminalState(terminalState)) {
      throw new Error(
        `Historical Build ${spec.runId} requires an authoritative terminal RunSupervisor state.`,
      );
    }
    const handle = await this.options.createHistoricalRuntime(spec, terminalState);
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
    if (handle.historical) throw historicalReadOnlyError(runId);
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
          await handle.finalVerificationCleanup?.quiesceRun();
        }
        result = { status: "paused", action: "no_mechanical_progress" };
      }
      if (
        result.status === "blocked" &&
        result.action !== "user_guidance_interruption_pending"
      ) {
        await handle.finalVerificationCleanup?.quiesceRun();
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
      let reported = error;
      try { await handle.finalVerificationCleanup?.quiesceRun(); }
      catch (quiesceError) {
        reported = new AggregateError([error, quiesceError], `Build ${runId} failed and could not quiesce owned resources.`);
      }
      this.options.onPumpError?.(runId, reported);
      this.options.onPumpResult?.(runId, {
        status: "paused",
        action: "autonomous_pump_error",
      });
    } finally {
      releaseActivity();
      if (compaction) await compaction;
    }
  }

  private wake(runId: string): void {
    const active = this.pumps.get(runId);
    if (!active) {
      this.activate(runId);
      return;
    }
    void active.finally(() => this.activate(runId)).catch(() => undefined);
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
      if (finalized.result.status === "paused" || finalized.result.status === "blocked") {
        await handle.finalVerificationCleanup?.quiesceRun();
      }
      result = finalized.result;
      compaction = finalized.compaction;
    } catch (error) {
      try { await handle.finalVerificationCleanup?.quiesceRun(); }
      catch (quiesceError) {
        throw new AggregateError(
          [error, quiesceError],
          `Build ${runId} failed and could not quiesce owned resources.`,
        );
      }
      throw error;
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
        ([, handle]) => !handle.historical && handle.runtime.projection().status !== "running"
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

  private requireMutable(runId: string): NativeBuildRuntimeHandle {
    const handle = this.require(runId);
    if (handle.historical) throw historicalReadOnlyError(runId);
    return handle;
  }

  private requireMutableWithinActivity(runId: string): NativeBuildRuntimeHandle {
    const handle = this.handles.get(runId);
    if (!handle) throw new Error(`Unknown build runtime ${runId}.`);
    if (handle.historical) throw historicalReadOnlyError(runId);
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

function historicalReadOnlyError(runId: string): Error {
  return new Error(`Historical Build ${runId} is read-only.`);
}

function isHistoricalTerminalState(value: unknown): value is HistoricalTerminalState {
  return value === "completed" || value === "failed" || value === "stopped";
}

function eventLoopYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
