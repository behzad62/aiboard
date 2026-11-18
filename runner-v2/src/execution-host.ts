import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { recordTempCreation, type TempRecordSink } from "./cleanup-ownership.js";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ArtifactStore } from "./artifact-store.js";
import type { GitCommandRunner } from "./git-runtime-runner.js";
import { BoundedOutputSpool } from "./bounded-output-spool.js";
import { createChildEnvironmentFactory, type RunnerProcessEnvironmentResolver } from "./child-environment.js";
import type { PermissionProfile } from "./contracts.js";
import { createRunGitExecutionContext, type RunGitExecutionContext } from "./git-run-context.js";
import {
  createExecutionGrantAuthority,
  type ExecutionGrantAuthority,
} from "./execution-grants.js";
import type { ExecutionInvocationIntent } from "./execution-safety-contracts.js";
import type { ExecutionIsolationSelector } from "./execution-isolation-provider.js";
import {
  createExecutionHostStreamingGraph,
  type ExecutionHostStreamingOpenRequest,
} from "./execution-host-streaming.js";
import { ManagedProcessService } from "./managed-process.js";
import { createExecutionHostManagedRuntime } from "./execution-host-managed-transport.js";
import type { ManagedProcessLaunchRequest, ManagedProcessRunRuntime, ManagedProcessTarget } from "./managed-process-transport.js";
import { createWindowsJobProcessHost, windowsBirthHelperDirectory, type WindowsJobProcessHost, type WindowsJobReleasedRecord, type WindowsJobSpareOptions } from "./windows-job-process-host.js";
import {
  createBoundedProcessOutputFactory,
  createRuntimeBackedOneShotCommandExecutor,
  type OneShotCommandExecutor,
} from "./one-shot-command-executor.js";
import {
  createProcessBackendRegistration,
  createProcessBackendRegistry,
} from "./process-backend.js";
import { createPosixProcessBackend } from "./posix-process-backend.js";
import { NativeOwnedProcessBackend } from "./native-process-backend.js";
import { InspectionConstructionOwner, assertSubprocessCleanupSettled, assertStreamingCleanupSettled, awaitInspectionConstruction, inheritedSubprocessResidue, releasedWindowsJobRecords, type SettledSubprocessBindings } from "./inspection-cleanup.js";
import {
  probeProcessHostSemantics,
  selectWindowsProcessBackendKinds,
  type ProcessHostSemanticFacts,
} from "./process-host-semantic-probes.js";
import { createWindowsProcessSemanticProbeSource } from "./windows-process-semantic-probes.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "./runner-capability-contract.js";
import { runnerRunStateSegment } from "./run-state-identity.js";
import {
  createRunnerInternalProcessKernel,
  type RunnerInternalProcessKernel,
} from "./runner-internal-process-kernel.js";
import { createSessionAuthority, type SessionAuthority } from "./session-authority.js";
import type { StreamingRuntimeOptions } from "./streaming-process-session-runtime.js";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import {
  openSqliteStreamingSessionStore,
  type HostLaunchRecord,
  type OutputCheckpointRecord,
  type SqliteStreamingSessionStoreOptions,
  type StreamingSessionRecord,
} from "./streaming-session-store.js";
import { createSubprocessRuntimeKernel, isExceptionalRecoveryState } from "./subprocess-runtime.js";
import {
  combineProcessRecoveryRuntimes,
  createStreamingProcessRecoveryRuntime,
  createSubprocessProcessRecoveryRuntime,
  type ProcessRecoveryRuntime,
} from "./process-recovery.js";
import { isSensitiveKey } from "./sensitive-redaction.js";
import {
  createConfiguredOciIsolationSelector,
} from "./oci-execution-isolation-provider.js";
import {
  createWindowsProcessBackend,
  WindowsJobObjectProcessBackend,
} from "./windows-process-backend.js";

const STREAMING_QUEUE_BYTES = 256 * 1024;
const STREAMING_QUEUE_CHUNKS = 16;
const STREAMING_FRAME_BYTES = 256 * 1024;

export type ExecutionHostPlatform = "posix" | "windows";

export interface ExecutionHostOptions {
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly allowNestedRunnerState?: boolean;
  readonly artifacts: ArtifactStore;
  readonly platform?: ExecutionHostPlatform;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly managedProcesses?: ManagedProcessService;
  readonly windowsJobHost?: WindowsJobProcessHost;
  /** Pre-started Job-host spares for the default Windows Job host (ignored with an injected windowsJobHost). Absent: none. */
  readonly windowsJobSpare?: WindowsJobSpareOptions;
  readonly processHostFacts?: ProcessHostSemanticFacts;
  readonly streamingStoreOptions?: SqliteStreamingSessionStoreOptions;
  readonly streamingOutput?: Pick<
    StreamingRuntimeOptions["output"],
    "createEvidenceSpool" | "deliver"
  >;
  /** Deterministic cleanup-boundary test seam; production leaves this unset. */
  readonly cleanupFault?: (event: Readonly<{
    runId: string;
    point: "before_isolation_recovery";
  }>) => void | Promise<void>;
  /**
   * T6b repair (OA-17): durable creation-record sink. The factory wires
   * this to Runner-private scheduler state; standalone hosts omit it and
   * the transient root is still always removed below.
   */
  readonly tempRecorders?: {
    readonly recorded: (record: {
      readonly path: string;
      readonly ownerRunId: string;
      readonly kind: "directory" | "file";
      readonly createdAt: string;
      readonly retained?: boolean;
    }) => void;
    readonly cleared: (path: string) => void;
  };
}

export interface ExecutionHostRunBindingInput {
  /** Trusted per-run evidence destination; defaults to the host store. */
  readonly artifacts?: ArtifactStore;
  readonly runId: string;
  readonly permissionProfile: PermissionProfile;
  readonly capabilityContract: RunnerCapabilityContract;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  /** Trusted ancestry of the local MCP proxy, if this is its private binding. */
  readonly localMcpDepth?: number;
  /** VF7b: Runner-set values for every process this run starts for one owner (playwright-cli.ts). */
  readonly processEnvironment?: RunnerProcessEnvironmentResolver;
  /** VF7b: told before and after each managed stop of this run (playwright-cli.ts's browser cleanup). */
  readonly managedStopObserver?: ManagedProcessStopObserver;
  /**
   * CW3: a short-lived Runner-internal run (a CLI worker's free checks or Test, cli-worker-processes.ts). Its run
   * root, managed-process records, Windows Job host (records and output logs, no spares) and artifacts live in
   * `<state>/transient-runs/<runId>/` instead of the shared stores, so a run that leaves no history adds nothing to
   * them. The Windows process facts are still the host's. The folder is removed when the binding's close has
   * proven every process stopped; a close that fails, a host closed under it or a crash keeps it.
   */
  readonly transient?: boolean;
}

/**
 * VF7b: a run's hook around every managed stop. `beforeStop` records; it never blocks or fails the stop.
 * `afterStop` runs once the owned process is proven stopped; a throw leaves the stop unverified (fail closed).
 * playwright-cli.ts never throws there: a browser it cannot prove gone is recorded and blocks the run's release.
 */
export interface ManagedProcessStopObserver {
  /** The Runner's own launch request, before the launch (never a model's text about it). Never blocks or fails it. */
  launching?(identity: Readonly<ManagedProcessLaunchIdentity>): void;
  beforeStop(target: Readonly<ManagedProcessTarget>): Promise<unknown> | unknown;
  afterStop(target: Readonly<ManagedProcessTarget>, recorded: unknown): Promise<void>;
}

/** VF7b: who launches what, from the managed launch request itself. */
export interface ManagedProcessLaunchIdentity {
  readonly runId: string;
  readonly sessionId: string;
  readonly processId: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** Wraps a managed runtime's launch and stop with the observer; every other operation is the runtime's own. */
export function observeManagedStops(runtime: ManagedProcessRunRuntime, observer: ManagedProcessStopObserver): ManagedProcessRunRuntime {
  return Object.freeze({
    ...runtime,
    async start(request: ManagedProcessLaunchRequest) {
      try {
        observer.launching?.(Object.freeze({ runId: request.identity.runId, sessionId: request.identity.sessionId, processId: request.identity.processId,
          command: request.command, args: Object.freeze([...request.args]) }));
      } catch { /* the observer never blocks a launch */ }
      return await runtime.start(request);
    },
    async stop(target: ManagedProcessTarget, context?: Readonly<import("./agent-contracts.js").ToolExecutionContext>, signal?: NodeJS.Signals, timeoutMs?: number) {
      let recorded: unknown;
      try { recorded = await observer.beforeStop(target); } catch { recorded = undefined; }
      const snapshot = await runtime.stop(target, context, signal, timeoutMs);
      if (snapshot.status === "stopped") await observer.afterStop(target, recorded);
      return snapshot;
    },
  });
}

export interface ExecutionHostRunBindingSnapshot {
  readonly hostId: string;
  readonly bindingId: string;
  readonly runId: string;
  readonly runRoot: string;
  readonly subprocessStatePath: string;
  readonly streamingStatePath: string;
  readonly capabilityContractDigest: string;
  readonly closed: boolean;
}

export interface ExecutionHostRecoveryResult {
  readonly subprocess: Readonly<Awaited<ReturnType<ReturnType<typeof createSubprocessRuntimeKernel>["runtime"]["reconcileStartup"]>>>;
  readonly streaming: Awaited<ReturnType<ReturnType<typeof createExecutionHostStreamingGraph>["runtime"]["reconcileStartup"]>>;
  readonly isolation: Readonly<Awaited<ReturnType<ExecutionIsolationSelector["recoverOwnedLeases"]>>>;
}

export interface ExecutionHostRunBinding {
  readonly runId: string;
  readonly runRoot: string;
  readonly git: RunGitExecutionContext;
  readonly commandExecution: OneShotCommandExecutor;
  readonly executionGrants: ExecutionGrantAuthority;
  readonly processRecoveryRuntime: ProcessRecoveryRuntime;
  readonly sessionAuthority: SessionAuthority;
  readonly streamingRuntime: ReturnType<typeof createExecutionHostStreamingGraph>["runtime"];
  readonly streamingState: Readonly<{
    listSessionIds(): readonly string[];
    readHostLaunch(launchId: string): Readonly<HostLaunchRecord> | undefined;
    readSession(sessionId: string): Readonly<StreamingSessionRecord> | undefined;
    readOutputCheckpoint(sessionId: string): Readonly<OutputCheckpointRecord> | undefined;
  }>;
  readonly isolation: ExecutionIsolationSelector;
  readonly managedProcesses: ManagedProcessService;
  /** T1 read-only whole-tree CPU evidence for an active owned streaming session. */
  readonly observeProcessUsage?: ReturnType<typeof createExecutionHostStreamingGraph>["observeUsage"];
  openStreaming(request: ExecutionHostStreamingOpenRequest): ReturnType<
    ReturnType<typeof createExecutionHostStreamingGraph>["open"]
  >;
  recover(input: { readonly maxRecords: number; readonly timeoutMs: number }): Promise<ExecutionHostRecoveryResult>;
  snapshot(): ExecutionHostRunBindingSnapshot;
  close(): Promise<void>;
}

export type ExecutionHostGitInspectionInput = Omit<ExecutionHostRunBindingInput, "capabilityContract"> & {
  readonly capabilityContract?: RunnerCapabilityContract;
  /** T6b repair (OA-17): per-query durable record sink; falls back to host options. */
  readonly tempRecorders?: TempRecordSink;
};

export interface ExecutionHost {
  readonly hostId: string;
  readonly artifacts: ArtifactStore;
  readonly managedProcesses: ManagedProcessService;
  readonly internalProcesses: RunnerInternalProcessKernel;
  bindRun(input: ExecutionHostRunBindingInput): Promise<ExecutionHostRunBinding>;
  /** Transient read-only run-owned inspection, with no write to historical state. */
  withGitInspection<T>(input: ExecutionHostGitInspectionInput, inspect: (git: GitCommandRunner) => Promise<T>): Promise<T>;
  activeRunIds(): readonly string[];
  filteredEnvironmentSource(): Readonly<Record<string, string>>;
  /**
   * Run the one-time host process checks now, so the first bound run does not wait for them (about 9 s on Windows).
   * The same checks, run once and shared with every binding; never rejects.
   */
  prepare?(): Promise<void>;
  /**
   * VF4b: the Windows host process facts every binding launches under (the same once-run checks), read only;
   * undefined on POSIX. A caller can tell why a launch would be refused (a `.cmd` while `windowsBatchArgv` is not
   * verified) without starting anything; nothing it reads changes what a launch may do.
   */
  windowsProcessFacts?(): Promise<ProcessHostSemanticFacts | undefined>;
  close(): Promise<void>;
}

/**
 * The one production composition root for child execution. Construction is
 * deliberately non-spawning; host probes and run resources are acquired only
 * by a bound run after CLI preflight has completed.
 */
export function createExecutionHost(options: ExecutionHostOptions): ExecutionHost {
  const projectRoot = canonicalRoot(options.projectRoot, "projectRoot");
  const stateDirectory = canonicalRoot(options.stateDirectory, "stateDirectory");
  if (!options.allowNestedRunnerState && contains(projectRoot, stateDirectory)) {
    throw new Error("ExecutionHost state must remain outside the project root.");
  }
  const platform = options.platform ?? (process.platform === "win32" ? "windows" : "posix");
  const ambientEnvironment = snapshotFilteredEnvironment(
    options.ambientEnvironment ?? {},
  );
  const hostId = `execution-host-${randomUUID()}`;
  const managedPlatform: NodeJS.Platform = platform === "windows"
    ? "win32"
    : process.platform === "win32" ? "linux" : process.platform;
  const managedProcesses = options.managedProcesses ?? new ManagedProcessService({
    stateDirectory: join(stateDirectory, "managed-processes"),
    platform: managedPlatform,
  });
  const ownsManagedProcesses = options.managedProcesses === undefined;
  const windowsJobHost = options.windowsJobHost ?? createWindowsJobProcessHost({
    stateDirectory: join(stateDirectory, "managed-processes-job-host"),
    platform: platform === "windows" ? "win32" : "linux",
    ...(options.windowsJobSpare ? { spare: options.windowsJobSpare } : {}),
  });
  const internalProcesses = createRunnerInternalProcessKernel({
    stateDirectory: join(stateDirectory, "internal-processes"),
    windowsBirthHelperDirectory: windowsBirthHelperDirectory(stateDirectory),
    platform: platform === "windows"
      ? "win32"
      : process.platform === "win32" ? "linux" : process.platform,
  });
  const bindings = new Map<string, ExecutionHostRunBinding | symbol>();
  const inspectionOperations = new Set<Promise<unknown>>();
  const inspectionOwners = new Set<() => Promise<void>>();
  const bindingOperations = new Set<Promise<void>>();
  /** Job-host record retention started by settled run closes; the host's close waits for it after closing its bindings. */
  const retentionOperations = new Set<Promise<unknown>>();
  const trackRetention = (retention: Promise<unknown>): void => {
    retentionOperations.add(retention);
    void retention.finally(() => retentionOperations.delete(retention));
  };
  const constructionOwners = new Map<InspectionConstructionOwner, string>();
  const reservation = Symbol("execution-host-binding-reservation");
  let closed = false;
  let closeComplete = false;
  let closePromise: Promise<void> | undefined;
  let managedProcessesClosed = false;
  let windowsFactsPromise: Promise<ProcessHostSemanticFacts> | undefined;

  const resolveWindowsFacts = async (): Promise<ProcessHostSemanticFacts> => {
    if (options.processHostFacts) return options.processHostFacts;
    return await (windowsFactsPromise ??= probeProcessHostSemantics({
      ...createWindowsProcessSemanticProbeSource({ ambientEnvironment, registerCleanup: (cleanup) => { inspectionOwners.add(cleanup); } }),
      activeJobCreateClose: async () => await windowsJobHost.probeActiveJobCreateClose(),
    }));
  };

  const host: ExecutionHost = Object.freeze({
    hostId,
    artifacts: options.artifacts,
    managedProcesses,
    internalProcesses,
    async bindRun(input: ExecutionHostRunBindingInput) {
      if (closed) throw new Error("ExecutionHost is closed.");
      const runId = safeSegment(input.runId);
      if (bindings.has(runId)) {
        throw new Error(`Run ${runId} already has a live execution binding.`);
      }
      const digest = capabilityDigest(input.capabilityContract);
      bindings.set(runId, reservation);
      const constructionOwner = new InspectionConstructionOwner();
      constructionOwners.set(constructionOwner, runId);
      let finishBinding!: () => void;
      const completion = new Promise<void>((resolveCompletion) => { finishBinding = resolveCompletion; });
      bindingOperations.add(completion);
      let transient: TransientRunState | undefined;
      // Set once createRunBinding returned: from then on only the binding's proven close may release a transient run.
      let constructed = false;
      // What the caller and the host's own close get: for a transient run, the wrapper that releases its folder.
      let exposed: ExecutionHostRunBinding | undefined;
      try {
        if (input.transient) {
          const root = join(stateDirectory, "transient-runs", runId);
          await mkdir(dirname(root), { recursive: true, mode: 0o700 });
          // Not recursive: a transient run id is never reused, so an existing folder is refused.
          await mkdir(root, { mode: 0o700 });
          try {
            transient = {
              root,
              managedProcesses: new ManagedProcessService({ stateDirectory: join(root, "managed"), platform: managedPlatform }),
              // Its own Job host, as historical Git inspection has: the shared one keeps every released process's
              // record and output logs for good, and a CLI's checks print account fields. No spares: a check or
              // Test never prestarts a Job-host pair, and never takes a running Build's spare slot.
              windowsJobHost: createWindowsJobProcessHost({ stateDirectory: join(root, "job-host"), platform: platform === "windows" ? "win32" : "linux",
                helperFallbackWarningKey: join(stateDirectory, "transient-runs") }),
            };
          } catch (error) {
            await rm(root, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
        }
        const binding = await createRunBinding({
          constructionOwner,
          hostId,
          runId,
          projectRoot,
          stateDirectory,
          allowNestedRunnerState: options.allowNestedRunnerState,
          permissionProfile: input.permissionProfile,
          capabilityContractDigest: digest,
          capabilitiesConfig: input.capabilitiesConfig,
          ambientEnvironment,
          ...(input.localMcpDepth !== undefined ? { mcpChildDepth: input.localMcpDepth + 1 } : {}),
          ...(input.processEnvironment ? { processEnvironment: input.processEnvironment } : {}),
          ...(input.managedStopObserver ? { managedStopObserver: input.managedStopObserver } : {}),
          ...(transient
            ? { runtimeRoot: join(transient.root, "runtime"), artifacts: new ArtifactStore(join(transient.root, "artifacts")), managedProcesses: transient.managedProcesses }
            : { artifacts: input.artifacts ?? options.artifacts, managedProcesses }),
          windowsJobHost: transient ? transient.windowsJobHost : windowsJobHost,
          platform,
          streamingStoreOptions: options.streamingStoreOptions,
          streamingOutput: options.streamingOutput,
          cleanupFault: options.cleanupFault,
          resolveWindowsFacts,
          trackRetention,
          onClosed: () => {
            const current = bindings.get(runId);
            if (current === binding || (exposed !== undefined && current === exposed)) bindings.delete(runId);
          },
        });
        constructed = true;
        exposed = transient ? transientRunBinding(binding, transient) : binding;
        constructionOwners.delete(constructionOwner);
        bindings.set(runId, exposed);
        if (closed) {
          await exposed.close();
          throw new Error("ExecutionHost closed while a run binding was being created.");
        }
        return exposed;
      } catch (error) {
        // Failed rollback stays reserved and creator-owned until host cleanup.
        if (constructionOwner.isComplete()) {
          constructionOwners.delete(constructionOwner);
          if (bindings.get(runId) === reservation) bindings.delete(runId);
          // A transient run whose construction threw and rolled back completely started nothing that outlives it. A
          // binding that was built and then failed its close keeps its folder, as any unproven close does.
          if (transient && !constructed) {
            try { await releaseTransientRunState(transient); } catch { /* its folder stays; the construction error stands */ }
          }
        }
        throw error;
      } finally {
        finishBinding();
        bindingOperations.delete(completion);
      }
    },
    withGitInspection<T>(input: ExecutionHostGitInspectionInput, inspect: (git: GitCommandRunner) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("ExecutionHost is closed."));
      const runId = safeSegment(input.runId);
      if (!["full", "project", "guarded"].includes(input.permissionProfile)) return Promise.reject(new Error("Git inspection profile is invalid."));
      // This is a fresh query descriptor, not a claim that an old Build had a
      // current active capability contract. Runtime/provider attestation remains
      // mandatory for any new Git process inside the query.
      const digest = createHash("sha256").update(JSON.stringify({ kind: "run-git-inspection-v1", runId,
        permissionProfile: input.permissionProfile, capabilitiesConfig: input.capabilitiesConfig })).digest("hex");
      const operation = (async () => {
        // Runtime files and output artifacts are new query-owned state. Original
        // historical databases and configured capability code are never reopened
        // for writes merely to display Git history.
        const root = await mkdtemp(join(tmpdir(), "aiboard-git-inspection-"));
                // T6b repair (B1/B6): the identity rule applies only to run/session
        // ids (validated above). The absolute project path is never run
        // through safeSegment. Recording is validated synchronously and
        // lives inside the operation so cleanup always runs: no crash,
        // no leaked temp root.
        let tempRecorded = false;
        const tempSink = input.tempRecorders ?? options.tempRecorders;
        try {
          recordTempCreation({ path: root, ownerRunId: runId, ownerProjectId: runId, createdAt: new Date().toISOString(), kind: "directory" });
          tempSink?.recorded({ path: root, ownerRunId: runId, kind: "directory", createdAt: new Date().toISOString() });
          tempRecorded = tempSink !== undefined;
        } catch {
          tempRecorded = false;
        }
        const queryProcesses = new ManagedProcessService({ stateDirectory: join(root, "managed"),
          platform: platform === "windows" ? "win32" : process.platform === "win32" ? "linux" : process.platform });
        const windowsJobHost = createWindowsJobProcessHost({ stateDirectory: join(root, "managed-job-host"),
          platform: platform === "windows" ? "win32" : "linux" });
        let binding: ExecutionHostRunBinding | undefined;
        const constructionOwner = new InspectionConstructionOwner();
        let released = false;
        const cleanup = async () => {
          if (released) return;
          await binding?.close();
          await constructionOwner.close();
          await queryProcesses.close();
          released = true;
          inspectionOwners.delete(cleanup);
        };
        inspectionOwners.add(cleanup);
        let failed = false; let primary: unknown; let result: T | undefined;
        try {
          binding = await createRunBinding({ constructionOwner, hostId, runId, projectRoot, stateDirectory,
            runtimeRoot: join(root, "runtime"), permissionProfile: input.permissionProfile,
            capabilityContractDigest: digest, capabilitiesConfig: input.capabilitiesConfig,
            ambientEnvironment, artifacts: new ArtifactStore(join(root, "artifacts")), managedProcesses: queryProcesses, windowsJobHost, platform,
            resolveWindowsFacts: async () => {
              if (options.processHostFacts) return options.processHostFacts;
              return await (windowsFactsPromise ??= probeProcessHostSemantics({
                ...createWindowsProcessSemanticProbeSource({ ambientEnvironment, registerCleanup: (cleanup) => { constructionOwner.addInspection(cleanup); } }),
                activeJobCreateClose: async () => await windowsJobHost.probeActiveJobCreateClose(),
              }));
            }, onClosed: () => undefined });
          if (closed) throw new Error("ExecutionHost closed before historical Git inspection.");
          result = await inspect(binding.git.lifecycle("inspection"));
        } catch (error) { failed = true; primary = error; }
        try { await cleanup(); }
        catch (error) { throw new AggregateError(failed ? [primary, error] : [error], `Historical Git query cleanup is unverified; retain ${root}.`); }
        if (failed) {
          await rm(root, { recursive: true, force: true });
          if (tempRecorded) {
            try { (input.tempRecorders ?? options.tempRecorders)?.cleared(root); } catch { /* bookkeeping never breaks the query */ }
          }
          throw primary;
        }
        await rm(root, { recursive: true });
        if (tempRecorded) {
          try { (input.tempRecorders ?? options.tempRecorders)?.cleared(root); } catch { /* bookkeeping never breaks the query */ }
        }
        return result!;
      })();
      inspectionOperations.add(operation);
      void operation.finally(() => inspectionOperations.delete(operation)).catch(() => undefined);
      return operation;
    },
    activeRunIds() {
      return Object.freeze([...bindings.entries()]
        .filter(([, value]) => value !== reservation)
        .map(([runId]) => runId)
        .sort());
    },
    filteredEnvironmentSource() {
      return Object.freeze({ ...ambientEnvironment });
    },
    prepare() {
      if (closed || platform !== "windows" || options.processHostFacts) return Promise.resolve();
      const warm = resolveWindowsFacts().then(() => undefined, () => undefined);
      inspectionOperations.add(warm);
      void warm.finally(() => inspectionOperations.delete(warm));
      return warm;
    },
    async windowsProcessFacts() {
      if (platform !== "windows") return undefined;
      if (closed) throw new Error("ExecutionHost is closed.");
      return await resolveWindowsFacts();
    },
    async close() {
      if (closeComplete) return;
      if (closePromise) return await closePromise;
      closed = true;
      const attempt = (async () => {
        const failures: unknown[] = [];
        // In-flight readers settle with their retained owners before the host
        // closes the shared environment/backend graph. Callback failure is not
        // cleanup failure; unresolved owners below retain their own blocker.
        await awaitInspectionConstruction(Promise.all([
          Promise.allSettled([...inspectionOperations]),
          Promise.all([...bindingOperations]),
        ]), Date.now() + AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS);
        for (const [owner, runId] of [...constructionOwners]) {
          try {
            await owner.close();
            constructionOwners.delete(owner);
            if (bindings.get(runId) === reservation) bindings.delete(runId);
          }
          catch (error) { failures.push(error); }
        }
        for (const cleanup of [...inspectionOwners]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        const active = [...bindings.values()].filter(
          (value): value is ExecutionHostRunBinding => value !== reservation,
        );
        for (const binding of active.reverse()) {
          try { await binding.close(); } catch (error) { failures.push(error); }
        }
        // Never fails: each retention keeps whatever it could not prove or delete.
        await Promise.allSettled([...retentionOperations]);
        if (failures.length > 0) {
          throw new AggregateError(failures, "ExecutionHost run-binding cleanup failed.");
        }
        try { await internalProcesses.close(); } catch (error) { failures.push(error); }
        if (ownsManagedProcesses && !managedProcessesClosed) {
          try {
            await managedProcesses.close();
            managedProcessesClosed = true;
          } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "ExecutionHost cleanup failed.");
        }
        closeComplete = true;
      })();
      closePromise = attempt;
      try {
        return await attempt;
      } finally {
        if (closePromise === attempt) closePromise = undefined;
      }
    },
  });
  return host;
}

interface TransientRunState {
  readonly root: string;
  readonly managedProcesses: ManagedProcessService;
  readonly windowsJobHost: WindowsJobProcessHost;
}

/**
 * CW3: a transient run's binding. Its close is the binding's own close, which throws unless every process was proven
 * stopped (then the folder stays); after that proof the run's private record store is closed and its folder removed.
 * A folder that cannot be removed (a handle Windows held a moment longer) is logged and left: the stop stands.
 */
function transientRunBinding(binding: ExecutionHostRunBinding, state: TransientRunState): ExecutionHostRunBinding {
  // One close at a time: the session's close and the host's own may meet. A close that failed may be tried again.
  let closing: Promise<void> | undefined;
  return Object.freeze({
    ...binding,
    close() {
      closing ??= (async () => {
        await binding.close();
        await releaseTransientRunState(state);
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    },
  });
}

/**
 * How long a transient run's removal waits for its private Job host's supervisors to exit after the proven stop. A
 * released process's supervisor reports the stop, then exits, holding its output logs until it does. Measured on an
 * idle Windows PC (cli-worker-processes.test.ts, 3 runs, 12 sessions, 1 or 2 supervisors each): every supervisor had
 * already exited when the wait began, so it took 0 ms. GitHub's Windows image ran the same test about 3 times slower.
 * The wait polls every 25 ms and ends as soon as they are gone, so the ceiling only bounds a host loaded far past that.
 */
const TRANSIENT_SUPERVISOR_EXIT_CEILING_MS = 15_000;

async function releaseTransientRunState(state: TransientRunState): Promise<void> {
  await state.managedProcesses.close();
  const alive = await state.windowsJobHost.awaitSupervisorsExited?.(TRANSIENT_SUPERVISOR_EXIT_CEILING_MS) ?? [];
  try {
    await rm(state.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  } catch (error) {
    // The folder stays. What a CLI printed (account fields from `auth status`) must not stay with it unnoticed: every
    // file that can hold its output is cleared, and what could not be is named.
    const kept = await clearTransientRunFiles(state.root);
    console.warn(`[runner] a transient run's folder could not be removed (${state.root}${alive.length > 0 ? `; supervisor processes ${alive.join(", ")} were still running` : ""}): ${error instanceof Error ? error.message : String(error)}. `
      + (kept.length === 0 ? "Every file in it was cleared." : `These files could not be cleared and may hold a CLI's output: ${kept.join(", ")}`));
  }
}

/** Empties, then removes, every file under a transient run's folder; returns the files that could be neither. */
async function clearTransientRunFiles(root: string): Promise<string[]> {
  const kept: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) continue;
      let cleared = false;
      // A hard link's target is emptied too, so only a file with one link is truncated (the CLI runs unsandboxed).
      try { if ((await stat(path)).nlink === 1) { await truncate(path, 0); cleared = true; } } catch { /* held without share-write */ }
      try { await rm(path, { force: true }); cleared = true; } catch { /* held open */ }
      if (!cleared) kept.push(path);
    }
  };
  await walk(root);
  return kept;
}

interface CreateRunBindingInput {
  readonly constructionOwner: InspectionConstructionOwner;
  readonly runtimeRoot?: string;
  readonly hostId: string;
  readonly runId: string;
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly allowNestedRunnerState?: boolean;
  readonly permissionProfile: PermissionProfile;
  readonly capabilityContractDigest: string;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  readonly ambientEnvironment: Readonly<Record<string, string>>;
  readonly mcpChildDepth?: number;
  readonly processEnvironment?: RunnerProcessEnvironmentResolver;
  readonly managedStopObserver?: ManagedProcessStopObserver;
  readonly artifacts: ArtifactStore;
  readonly managedProcesses: ManagedProcessService;
  readonly windowsJobHost: WindowsJobProcessHost;
  readonly platform: ExecutionHostPlatform;
  readonly streamingStoreOptions?: SqliteStreamingSessionStoreOptions;
  readonly streamingOutput?: Pick<
    StreamingRuntimeOptions["output"],
    "createEvidenceSpool" | "deliver"
  >;
  readonly cleanupFault?: ExecutionHostOptions["cleanupFault"];
  readonly resolveWindowsFacts: () => Promise<ProcessHostSemanticFacts>;
  readonly onClosed: () => void;
  /** Takes the Job-host record retention a settled close starts; without it the close awaits retention itself. */
  readonly trackRetention?: (retention: Promise<unknown>) => void;
}

async function createRunBinding(input: CreateRunBindingInput): Promise<ExecutionHostRunBinding> {
  const runRoot = input.runtimeRoot ?? join(input.stateDirectory, "builds", runnerRunStateSegment(input.runId));
  await mkdir(runRoot, { recursive: true });
  const bindingId = `execution-binding-${randomUUID()}`;
  const constructionOwner = input.constructionOwner;
  try {
    const isolation = await createConfiguredOciIsolationSelector(
      input.capabilitiesConfig,
      join(runRoot, "execution-isolation"),
    );
    constructionOwner.add(async () => {
      const recovery = await isolation.recoverOwnedLeases();
      const blockers = recovery.flatMap((entry) => entry.blockers);
      if (blockers.length > 0) throw new Error(blockers.join(" "));
    });
    const childEnvironments = createChildEnvironmentFactory({
      ...(input.mcpChildDepth !== undefined ? { mcpChildDepth: input.mcpChildDepth } : {}),
      ...(input.processEnvironment ? { processEnvironment: input.processEnvironment } : {}),
      credentialResolver: {
        consume: () => {
          throw new Error("No Runner child-environment credential grant is configured.");
        },
      },
    });
    const backendGraph = await createRunBackendRegistry(input, runRoot);
    const subprocessStatePath = join(runRoot, "subprocess-runtime.sqlite");
    const subprocessKernel = createSubprocessRuntimeKernel({
      registry: backendGraph.registry,
      state: { kind: "sqlite", path: subprocessStatePath },
      stateKey: await loadOrCreateStateKey(join(runRoot, "subprocess-runtime.key")),
      clock: hostClock(),
      environments: childEnvironments,
      outputs: createBoundedProcessOutputFactory({
        spillRoot: join(runRoot, "subprocess-output"),
        projectRoot: input.projectRoot,
        allowNestedRunnerState: input.allowNestedRunnerState,
        artifacts: input.artifacts,
      }),
    });
    constructionOwner.add(async () => {
      await subprocessKernel.runtime.reconcileStartup();
      assertSubprocessCleanupSettled(subprocessKernel.readOnlyStore);
      subprocessKernel.readOnlyStore.close();
    });
    const executionGrants = createExecutionGrantAuthority();
    constructionOwner.add(async () => await executionGrants.revokeAll("cleanup"));
    const commandExecution = createRuntimeBackedOneShotCommandExecutor({
      runtime: subprocessKernel.runtime,
      runtimeGrants: subprocessKernel.grantsController,
      executionGrants,
      isolation,
      permissionProfile: input.permissionProfile,
      ambientEnvironment: input.ambientEnvironment,
      environments: childEnvironments,
    });
    const subprocessRecoveryRuntime = createSubprocessProcessRecoveryRuntime({
      runtime: subprocessKernel.runtime,
      canRecoverExceptional: subprocessKernel.canRecoverExceptional,
      isRecoverableState: isExceptionalRecoveryState,
      store: subprocessKernel.readOnlyStore,
      executionGrants,
      permissionProfile: input.permissionProfile,
      workspacePath: input.projectRoot,
    });
    const streamingStatePath = join(runRoot, "streaming-sessions.sqlite");
    const streamingKernel = openSqliteStreamingSessionStore(
      streamingStatePath,
      await loadOrCreateStateKey(join(runRoot, "streaming-sessions.key")),
      input.streamingStoreOptions ?? {},
    );
    let sessionAuthority: SessionAuthority | undefined;
    let retainedStreamingGraph: ReturnType<typeof createExecutionHostStreamingGraph> | undefined;
    const getStreamingGraph = () => retainedStreamingGraph ??= createExecutionHostStreamingGraph({
      permissionProfile: input.permissionProfile,
      ambientEnvironment: input.ambientEnvironment,
      environments: childEnvironments,
      isolation,
      registry: backendGraph.registry,
      channelBackends: backendGraph.channelBackends,
      kernel: streamingKernel,
      sessions: sessionAuthority ??= createSessionAuthority({ grants: executionGrants, sessions: streamingKernel }),
      output: createStreamingOutputOptions({
        runRoot,
        projectRoot: input.projectRoot,
        allowNestedRunnerState: input.allowNestedRunnerState,
        artifacts: input.artifacts,
        overrides: input.streamingOutput,
      }),
    });
    constructionOwner.add(async () => {
      const runtime = getStreamingGraph().runtime;
      const failures: unknown[] = [];
      const recover = async () => {
        const recovery = await runtime.reconcileStartup({ maxRecords: 1_024, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS });
        for (const entry of recovery.outcomes) if (entry.disposition !== "cleaned") failures.push(new Error(`Streaming launch ${entry.launchId} remains ${entry.disposition}.`));
        for (const entry of recovery.sessionOutcomes) if (!["reattached", "cleanup_released"].includes(entry.disposition)) failures.push(new Error(`Streaming session ${entry.sessionId} remains ${entry.disposition}.`));
        for (const entry of recovery.lateCleanupFailures) failures.push(new Error(`Streaming session ${entry.sessionId} cleanup remains ${entry.code}.`));
      };
      await recover();
      for (const sessionId of streamingKernel.store.listSessionIds()) {
        if (streamingKernel.store.readBySession(sessionId)?.state !== "released") {
          try { await runtime.cleanupOwnedSession({ sessionId, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS }); }
          catch (error) { failures.push(error); }
        }
      }
      await recover();
      assertStreamingCleanupSettled(streamingKernel.store);
      if (failures.length) throw new AggregateError(failures, "Streaming construction rollback remains unverified.");
      streamingKernel.store.close();
    });
    const streamingGraph = getStreamingGraph();
    const streamingRuntime = streamingGraph.runtime;
    const streamingRecoveryRuntime = createStreamingProcessRecoveryRuntime({
      runtime: streamingRuntime,
      store: streamingKernel.store,
      executionGrants,
      permissionProfile: input.permissionProfile,
      workspacePath: input.projectRoot,
    });
    const processRecoveryRuntime = combineProcessRecoveryRuntimes(
      subprocessRecoveryRuntime,
      streamingRecoveryRuntime,
    );
    let closed = false;
    let closeComplete = false;
    let closePromise: Promise<void> | undefined;
    let cleanupDutiesSettled = false;
    let settledSubprocesses: SettledSubprocessBindings | undefined;
    let streamingStoreClosed = false;
    let subprocessStoreClosed = false;
    // Set by the first recover(): records only an exceptional recovery could settle.
    let subprocessResidue: ReadonlyMap<string, number> | undefined;
    const managedRuntimeRegistration: { detach?: () => void } = {};

    const git = createRunGitExecutionContext({
      runId: input.runId,
      projectRoot: input.projectRoot,
      stateDirectory: input.stateDirectory,
      permissionProfile: input.permissionProfile,
      execution: commandExecution,
      executionGrants,
      artifacts: input.artifacts,
      assertOpen: () => { if (closed) throw new Error("ExecutionHost run binding is closed."); },
    });

    const binding: ExecutionHostRunBinding = Object.freeze({
      runId: input.runId,
      runRoot,
      git,
      commandExecution,
      executionGrants,
      processRecoveryRuntime,
      sessionAuthority: sessionAuthority!,
      streamingRuntime,
      streamingState: Object.freeze({
        listSessionIds: () => streamingKernel.store.listSessionIds(),
        readHostLaunch: (launchId: string) => streamingKernel.store.readHostLaunch(launchId),
        readSession: (sessionId: string) => streamingKernel.store.readBySession(sessionId),
        readOutputCheckpoint: (sessionId: string) => streamingKernel.store.readOutputCheckpoint(sessionId),
      }),
      isolation,
      managedProcesses: input.managedProcesses,
      openStreaming: streamingGraph.open,
      observeProcessUsage: streamingGraph.observeUsage,
      async recover(recoveryInput: { readonly maxRecords: number; readonly timeoutMs: number }) {
        if (closed) throw new Error("ExecutionHost run binding is closed.");
        if (!Number.isSafeInteger(recoveryInput.maxRecords) || recoveryInput.maxRecords < 1 ||
            !Number.isSafeInteger(recoveryInput.timeoutMs) || recoveryInput.timeoutMs < 1) {
          throw new Error("ExecutionHost recovery bounds are invalid.");
        }
        const streaming = await streamingRuntime.reconcileStartup(recoveryInput);
        const subprocess = await subprocessKernel.runtime.reconcileStartup();
        subprocessResidue ??= inheritedSubprocessResidue(subprocessKernel.readOnlyStore);
        const isolationRecovery = await isolation.recoverOwnedLeases();
        return Object.freeze({
          subprocess: Object.freeze([...subprocess]),
          streaming,
          isolation: Object.freeze([...isolationRecovery]),
        });
      },
      snapshot() {
        return Object.freeze({
          hostId: input.hostId,
          bindingId,
          runId: input.runId,
          runRoot,
          subprocessStatePath,
          streamingStatePath,
          capabilityContractDigest: input.capabilityContractDigest,
          closed,
        });
      },
      async close() {
        if (closeComplete) return;
        if (closePromise) return await closePromise;
        closed = true;
        const attempt = (async () => {
          const failures: unknown[] = [];
          const consumeStreamingRecovery = (recovery: ExecutionHostRecoveryResult["streaming"]) => {
            for (const outcome of recovery.outcomes) {
              if (outcome.disposition !== "cleaned") {
                failures.push(new Error(`Streaming launch ${outcome.launchId} recovery remains ${outcome.disposition}.`));
              }
            }
            for (const outcome of recovery.sessionOutcomes) {
              if (outcome.disposition !== "reattached" && outcome.disposition !== "cleanup_released") {
                failures.push(new Error(`Streaming session ${outcome.sessionId} recovery remains ${outcome.disposition}.`));
              }
            }
            for (const failure of recovery.lateCleanupFailures) {
              failures.push(new Error(`Streaming session ${failure.sessionId} cleanup remains ${failure.code}.`));
            }
          };
          if (!cleanupDutiesSettled) {
            // PX-2c: retire the shared Job-host spare (if any) so run end
            // leaves zero supervisor/Job-host processes behind. Best-effort:
            // calls never depend on the spare, and a missing method (fakes)
            // is skipped.
            try { await input.windowsJobHost.retireSpare?.({ runId: input.runId }); } catch (error) { failures.push(error); }
            try { await input.managedProcesses.stopRun(input.runId); } catch (error) { failures.push(error); }
            try { await executionGrants.revokeAll("cleanup"); } catch (error) { failures.push(error); }
            try {
              consumeStreamingRecovery(await streamingRuntime.reconcileStartup({ maxRecords: 1_024, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS }));
            } catch (error) { failures.push(error); }
            for (const sessionId of streamingKernel.store.listSessionIds()) {
              if (streamingKernel.store.readBySession(sessionId)?.state === "released") continue;
              try {
                await streamingRuntime.cleanupOwnedSession({ sessionId, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS });
              } catch (error) { failures.push(error); }
            }
            try {
              consumeStreamingRecovery(await streamingRuntime.reconcileStartup({ maxRecords: 1_024, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS }));
            } catch (error) { failures.push(error); }
            for (const sessionId of streamingKernel.store.listSessionIds()) {
              const record = streamingKernel.store.readBySession(sessionId);
              if (record && record.state !== "released") {
                failures.push(new Error(`Streaming session ${sessionId} remains unreleased in ${record.state}.`));
              }
            }
            // Recovery is bounded; terminal ownership must also hold for every
            // durable launch, including records beyond either recovery pass.
            for (const launchId of streamingKernel.store.listHostLaunchIds()) {
              const record = streamingKernel.store.readHostLaunch(launchId);
              if (record?.state === "released") continue;
              if (record?.state === "handed_off" &&
                  streamingKernel.store.readBySession(record.sessionId)?.state === "released") continue;
              failures.push(new Error(`Streaming launch ${launchId} remains unreleased in ${record?.state ?? "missing"}.`));
            }
            try {
              await subprocessKernel.runtime.reconcileStartup();
              settledSubprocesses = assertSubprocessCleanupSettled(subprocessKernel.readOnlyStore, subprocessResidue);
            } catch (error) { failures.push(error); }
            try {
              await input.cleanupFault?.({
                runId: input.runId,
                point: "before_isolation_recovery",
              });
              const recovery = await isolation.recoverOwnedLeases();
              const blockers = recovery.flatMap((entry) => entry.blockers);
              if (blockers.length > 0) throw new Error(blockers.join(" "));
            } catch (error) { failures.push(error); }
            if (failures.length === 0) {
              cleanupDutiesSettled = true;
              // Every process the run's stores record as released is final there, so the shared Job host may delete
              // those records and their raw output. It re-checks each stop itself and keeps anything unproven. The
              // list is taken now, while the stores are open; the deletions run off the close path, tracked so the
              // ExecutionHost's own close waits for them. Best effort: a record that stays is only disk, never authority.
              if (input.windowsJobHost.retireReleasedRecords && settledSubprocesses) {
                let released: WindowsJobReleasedRecord[] = [];
                try { released = releasedWindowsJobRecords(input.runId, settledSubprocesses, streamingKernel.store); } catch { released = []; }
                const retention = input.windowsJobHost.retireReleasedRecords({ runId: input.runId, released }).catch(() => undefined);
                if (input.trackRetention) input.trackRetention(retention);
                else await retention;
              }
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, `ExecutionHost run ${input.runId} cleanup failed.`);
          }
          await constructionOwner.closeInspections();
          if (!streamingStoreClosed) {
            try {
              streamingKernel.store.close();
              streamingStoreClosed = true;
            } catch (error) { failures.push(error); }
          }
          if (!subprocessStoreClosed) {
            try {
              subprocessKernel.readOnlyStore.close();
              subprocessStoreClosed = true;
            } catch (error) { failures.push(error); }
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, `ExecutionHost run ${input.runId} cleanup failed.`);
          }
          managedRuntimeRegistration.detach?.();
          input.onClosed();
          closeComplete = true;
        })();
        closePromise = attempt;
        try {
          return await attempt;
        } finally {
          if (closePromise === attempt) closePromise = undefined;
        }
      },
    });
    const managedRuntime = createExecutionHostManagedRuntime({
      run: binding, permissionProfile: input.permissionProfile, environment: input.ambientEnvironment, artifacts: input.artifacts,
      ...(input.processEnvironment ? { processEnvironment: input.processEnvironment } : {}),
      // CW5a: the same once-run fact the Windows backends were built with (createWindowsBackends).
      ...(input.platform === "windows" ? { windowsBatchArgv: (await input.resolveWindowsFacts()).windowsBatchArgv } : {}),
    });
    managedRuntimeRegistration.detach = input.managedProcesses.registerRuntime(
      input.managedStopObserver ? observeManagedStops(managedRuntime, input.managedStopObserver) : managedRuntime,
    );
    constructionOwner.transfer();
    return binding;
  } catch (error) {
    try { await constructionOwner.close(); }
    catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `ExecutionHost run ${input.runId} construction and rollback failed.`,
      );
    }
    throw error;
  }
}

async function createRunBackendRegistry(
  input: CreateRunBindingInput,
  runRoot: string,
) {
  const backends = input.platform === "windows"
    ? await createWindowsBackends(input, runRoot)
    : [{
        stableAdapterId: "runner-posix-process-group-adapter-v1",
        backendId: "runner-posix-process-group-v1",
        codeIdentity: "runner-v2/posix-process-backend@1",
        backend: createPosixProcessBackend({
          stateDirectory: join(runRoot, "process-backend"),
        }),
      }];
  return Object.freeze({
    registry: createProcessBackendRegistry(backends.map((entry) =>
      createProcessBackendRegistration({
        stableAdapterId: entry.stableAdapterId,
        backendId: entry.backendId,
        codeDigest: createHash("sha256").update(entry.codeIdentity).digest("hex"),
        configDigest: createHash("sha256")
          .update("runner-v2/execution-host-process-backend@1")
          .digest("hex"),
        backend: entry.backend,
      }),
    )),
    channelBackends: new Map(backends.map((entry) => [entry.backendId, entry.backend])),
  });
}

async function createWindowsBackends(input: CreateRunBindingInput, runRoot: string) {
  const facts = await input.resolveWindowsFacts();
  const kinds = new Set(selectWindowsProcessBackendKinds(facts));
  const portable = kinds.has("portable") ? createWindowsProcessBackend({
    stateDirectory: join(runRoot, "process-backend"),
    windowsBirthHelperDirectory: windowsBirthHelperDirectory(input.stateDirectory),
    jobObjects: "unavailable",
    semanticFacts: facts,
  }) : undefined;
  if (portable instanceof NativeOwnedProcessBackend) {
    portable.registerInspectionCleanup(cleanup => {
      input.constructionOwner.addInspection(() => cleanup(Date.now() + 5_000));
    });
    await portable.prepareInspection(Date.now() + 30_000);
  }
  return [
    ...(kinds.has("job") ? [{
      stableAdapterId: "runner-windows-job-adapter-v1",
      backendId: "runner-windows-job-v1",
      codeIdentity: "runner-v2/windows-job-process-backend@1",
      backend: new WindowsJobObjectProcessBackend(
        input.windowsJobHost,
        facts.windowsBatchArgv,
        facts.jobContainment,
      ),
    }] : []),
    ...(kinds.has("portable") ? [{
      stableAdapterId: "runner-windows-portable-adapter-v1",
      backendId: "runner-windows-supervisor-v1",
      codeIdentity: "runner-v2/windows-portable-process-backend@1",
      backend: portable!,
    }] : []),
  ];
}

function createStreamingOutputOptions(input: {
  readonly runRoot: string;
  readonly projectRoot: string;
  readonly allowNestedRunnerState?: boolean;
  readonly artifacts: ArtifactStore;
  readonly overrides?: Pick<
    StreamingRuntimeOptions["output"],
    "createEvidenceSpool" | "deliver"
  >;
}): StreamingRuntimeOptions["output"] {
  return Object.freeze({
    maxQueueBytes: STREAMING_QUEUE_BYTES,
    maxQueueChunks: STREAMING_QUEUE_CHUNKS,
    maxFrameBytes: STREAMING_FRAME_BYTES,
    maxAcceptedChunks: STREAMING_QUEUE_CHUNKS,
    protocolStreams: ["stdout", "stderr"] as const,
    artifacts: input.artifacts,
    createEvidenceSpool: input.overrides?.createEvidenceSpool ?? ((sessionId) => {
      const spool = new BoundedOutputSpool({
        spillRoot: join(input.runRoot, `streaming-output-${createHash("sha256").update(sessionId).digest("hex").slice(0, 20)}`),
        projectRoot: input.projectRoot,
        allowNestedRunnerState: input.allowNestedRunnerState,
        ownershipId: `streaming-${safeSegment(sessionId)}`,
        artifactStore: input.artifacts,
      });
      return {
        write: async (stream, bytes) => { await spool.write(stream, bytes); },
        observe: async () => await spool.observe(),
        finalize: async () => await spool.finalize(),
        cleanup: async () => await spool.cleanup(),
      };
    }),
    deliver: input.overrides?.deliver ?? (async () => {
      throw new Error("Family streaming delivery is not authorized.");
    }),
  });
}

function hostClock() {
  return Object.freeze({
    now: () => new Date(),
    sleep: async (milliseconds: number) => await new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, milliseconds);
      timer.unref();
    }),
  });
}

async function loadOrCreateStateKey(path: string): Promise<Uint8Array> {
  try {
    const existing = await readFile(path);
    if (existing.byteLength !== 32) throw new Error("Execution state key is invalid.");
    return new Uint8Array(existing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const key = randomBytes(32);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(key);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    return new Uint8Array(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await readFile(path);
      if (existing.byteLength !== 32) throw new Error("Execution state key is invalid.");
      return new Uint8Array(existing);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

function snapshotFilteredEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const filtered = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(source)) {
    const canonical = name.toUpperCase();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === undefined ||
        isSensitiveKey(name) || canonical.startsWith("RUNNER_") ||
        canonical.startsWith("AIBOARD_RUNNER_")) continue;
    filtered[name] = value;
  }
  return Object.freeze(filtered);
}

function capabilityDigest(contract: RunnerCapabilityContract): string {
  if (!contract || typeof contract !== "object" ||
      typeof contract.digest !== "string" || !/^[a-f0-9]{64}$/i.test(contract.digest)) {
    throw new Error("ExecutionHost capability contract digest is invalid.");
  }
  return contract.digest.toLowerCase();
}

function canonicalRoot(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new Error(`ExecutionHost ${label} must be absolute.`);
  }
  return resolve(path);
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  // A path on another drive comes back absolute, not as "..", and is never inside.
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("ExecutionHost run/session identity is invalid.");
  }
  return value;
}

/** Reserved by the B3 public-family seam; the host never fabricates this intent. */
export type ExecutionHostStreamingIntent = ExecutionInvocationIntent;
