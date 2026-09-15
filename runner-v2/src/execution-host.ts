import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ArtifactStore } from "./artifact-store.js";
import type { GitCommandRunner } from "./git-runtime-runner.js";
import { BoundedOutputSpool } from "./bounded-output-spool.js";
import { createChildEnvironmentFactory } from "./child-environment.js";
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
import { createWindowsJobProcessHost, type WindowsJobProcessHost } from "./windows-job-process-host.js";
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
import {
  type StreamingRuntimeOptions,
} from "./streaming-process-session-runtime.js";
import {
  openSqliteStreamingSessionStore,
  type HostLaunchRecord,
  type OutputCheckpointRecord,
  type SqliteStreamingSessionStoreOptions,
  type StreamingSessionRecord,
} from "./streaming-session-store.js";
import { createSubprocessRuntimeKernel } from "./subprocess-runtime.js";
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
  readonly artifacts: ArtifactStore;
  readonly platform?: ExecutionHostPlatform;
  readonly ambientEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly managedProcesses?: ManagedProcessService;
  readonly windowsJobHost?: WindowsJobProcessHost;
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
}

export interface ExecutionHostRunBindingInput {
  readonly runId: string;
  readonly permissionProfile: PermissionProfile;
  readonly capabilityContract: RunnerCapabilityContract;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
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
  openStreaming(request: ExecutionHostStreamingOpenRequest): ReturnType<
    ReturnType<typeof createExecutionHostStreamingGraph>["open"]
  >;
  recover(input: { readonly maxRecords: number; readonly timeoutMs: number }): Promise<ExecutionHostRecoveryResult>;
  snapshot(): ExecutionHostRunBindingSnapshot;
  close(): Promise<void>;
}

export type ExecutionHostGitInspectionInput = Omit<ExecutionHostRunBindingInput, "capabilityContract"> & {
  readonly capabilityContract?: RunnerCapabilityContract;
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
  if (contains(projectRoot, stateDirectory)) {
    throw new Error("ExecutionHost state must remain outside the project root.");
  }
  const platform = options.platform ?? (process.platform === "win32" ? "windows" : "posix");
  const ambientEnvironment = snapshotFilteredEnvironment(
    options.ambientEnvironment ?? {},
  );
  const hostId = `execution-host-${randomUUID()}`;
  const managedProcesses = options.managedProcesses ?? new ManagedProcessService({
    stateDirectory: join(stateDirectory, "managed-processes"),
    platform: platform === "windows"
      ? "win32"
      : process.platform === "win32" ? "linux" : process.platform,
  });
  const ownsManagedProcesses = options.managedProcesses === undefined;
  const windowsJobHost = options.windowsJobHost ?? createWindowsJobProcessHost({
    stateDirectory: join(stateDirectory, "managed-processes-job-host"),
    platform: platform === "windows" ? "win32" : "linux",
  });
  const internalProcesses = createRunnerInternalProcessKernel({
    stateDirectory: join(stateDirectory, "internal-processes"),
    platform: platform === "windows"
      ? "win32"
      : process.platform === "win32" ? "linux" : process.platform,
  });
  const bindings = new Map<string, ExecutionHostRunBinding | symbol>();
  const inspectionOperations = new Set<Promise<unknown>>();
  const inspectionOwners = new Set<() => Promise<void>>();
  const reservation = Symbol("execution-host-binding-reservation");
  let closed = false;
  let closeComplete = false;
  let closePromise: Promise<void> | undefined;
  let managedProcessesClosed = false;
  let windowsFactsPromise: Promise<ProcessHostSemanticFacts> | undefined;

  const resolveWindowsFacts = async (): Promise<ProcessHostSemanticFacts> => {
    if (options.processHostFacts) return options.processHostFacts;
    return await (windowsFactsPromise ??= probeProcessHostSemantics({
      ...createWindowsProcessSemanticProbeSource({ ambientEnvironment }),
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
      try {
        const binding = await createRunBinding({
          hostId,
          runId,
          projectRoot,
          stateDirectory,
          permissionProfile: input.permissionProfile,
          capabilityContractDigest: digest,
          capabilitiesConfig: input.capabilitiesConfig,
          ambientEnvironment,
          artifacts: options.artifacts,
          managedProcesses,
          windowsJobHost,
          platform,
          streamingStoreOptions: options.streamingStoreOptions,
          streamingOutput: options.streamingOutput,
          cleanupFault: options.cleanupFault,
          resolveWindowsFacts,
          onClosed: () => {
            if (bindings.get(runId) === binding) bindings.delete(runId);
          },
        });
        if (closed) {
          await binding.close();
          throw new Error("ExecutionHost closed while a run binding was being created.");
        }
        bindings.set(runId, binding);
        return binding;
      } catch (error) {
        if (bindings.get(runId) === reservation) bindings.delete(runId);
        throw error;
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
        const queryProcesses = new ManagedProcessService({ stateDirectory: join(root, "managed"),
          platform: platform === "windows" ? "win32" : process.platform === "win32" ? "linux" : process.platform });
        const windowsJobHost = createWindowsJobProcessHost({ stateDirectory: join(root, "managed-job-host"),
          platform: platform === "windows" ? "win32" : "linux" });
        let binding: ExecutionHostRunBinding | undefined;
        let released = false;
        const cleanup = async () => {
          if (released) return;
          await binding?.close();
          await queryProcesses.close();
          released = true;
          inspectionOwners.delete(cleanup);
        };
        inspectionOwners.add(cleanup);
        let failed = false; let primary: unknown; let result: T | undefined;
        try {
          binding = await createRunBinding({ hostId, runId, projectRoot, stateDirectory,
            runtimeRoot: join(root, "runtime"), permissionProfile: input.permissionProfile,
            capabilityContractDigest: digest, capabilitiesConfig: input.capabilitiesConfig,
            ambientEnvironment, artifacts: new ArtifactStore(join(root, "artifacts")), managedProcesses: queryProcesses, windowsJobHost, platform,
            resolveWindowsFacts: async () => {
              if (options.processHostFacts) return options.processHostFacts;
              return await (windowsFactsPromise ??= probeProcessHostSemantics({
                ...createWindowsProcessSemanticProbeSource({ ambientEnvironment }),
                activeJobCreateClose: async () => await windowsJobHost.probeActiveJobCreateClose(),
              }));
            }, onClosed: () => undefined });
          if (closed) throw new Error("ExecutionHost closed before historical Git inspection.");
          result = await inspect(binding.git.lifecycle("inspection"));
        } catch (error) { failed = true; primary = error; }
        try { await cleanup(); }
        catch (error) { throw new AggregateError(failed ? [primary, error] : [error], `Historical Git query cleanup is unverified; retain ${root}.`); }
        if (failed) throw primary;
        await rm(root, { recursive: true });
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
    async close() {
      if (closeComplete) return;
      if (closePromise) return await closePromise;
      closed = true;
      const attempt = (async () => {
        const failures: unknown[] = [];
        // In-flight readers settle with their retained owners before the host
        // closes the shared environment/backend graph. Callback failure is not
        // cleanup failure; unresolved owners below retain their own blocker.
        await Promise.allSettled([...inspectionOperations]);
        for (const cleanup of [...inspectionOwners]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        const active = [...bindings.values()].filter(
          (value): value is ExecutionHostRunBinding => value !== reservation,
        );
        for (const binding of active.reverse()) {
          try { await binding.close(); } catch (error) { failures.push(error); }
        }
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

interface CreateRunBindingInput {
  readonly runtimeRoot?: string;
  readonly hostId: string;
  readonly runId: string;
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly permissionProfile: PermissionProfile;
  readonly capabilityContractDigest: string;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  readonly ambientEnvironment: Readonly<Record<string, string>>;
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
}

async function createRunBinding(input: CreateRunBindingInput): Promise<ExecutionHostRunBinding> {
  const runRoot = input.runtimeRoot ?? join(input.stateDirectory, "builds", runnerRunStateSegment(input.runId));
  await mkdir(runRoot, { recursive: true });
  const bindingId = `execution-binding-${randomUUID()}`;
  const constructionCleanups: Array<() => void | Promise<void>> = [];
  try {
    const isolation = await createConfiguredOciIsolationSelector(
      input.capabilitiesConfig,
      join(runRoot, "execution-isolation"),
    );
    constructionCleanups.push(async () => {
      const recovery = await isolation.recoverOwnedLeases();
      const blockers = recovery.flatMap((entry) => entry.blockers);
      if (blockers.length > 0) throw new Error(blockers.join(" "));
    });
    const childEnvironments = createChildEnvironmentFactory({
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
        artifacts: input.artifacts,
      }),
    });
    constructionCleanups.push(() => subprocessKernel.readOnlyStore.close());
    const executionGrants = createExecutionGrantAuthority();
    constructionCleanups.push(async () => await executionGrants.revokeAll("cleanup"));
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
    constructionCleanups.push(() => streamingKernel.store.close());
    const sessionAuthority = createSessionAuthority({
      grants: executionGrants,
      sessions: streamingKernel,
    });
    const streamingGraph = createExecutionHostStreamingGraph({
      permissionProfile: input.permissionProfile,
      ambientEnvironment: input.ambientEnvironment,
      environments: childEnvironments,
      isolation,
      registry: backendGraph.registry,
      channelBackends: backendGraph.channelBackends,
      kernel: streamingKernel,
      sessions: sessionAuthority,
      output: createStreamingOutputOptions({
        runRoot,
        projectRoot: input.projectRoot,
        artifacts: input.artifacts,
        overrides: input.streamingOutput,
      }),
    });
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
    let streamingStoreClosed = false;
    let subprocessStoreClosed = false;
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
      sessionAuthority,
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
      async recover(recoveryInput: { readonly maxRecords: number; readonly timeoutMs: number }) {
        if (closed) throw new Error("ExecutionHost run binding is closed.");
        if (!Number.isSafeInteger(recoveryInput.maxRecords) || recoveryInput.maxRecords < 1 ||
            !Number.isSafeInteger(recoveryInput.timeoutMs) || recoveryInput.timeoutMs < 1) {
          throw new Error("ExecutionHost recovery bounds are invalid.");
        }
        const streaming = await streamingRuntime.reconcileStartup(recoveryInput);
        const subprocess = await subprocessKernel.runtime.reconcileStartup();
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
            try { await input.managedProcesses.stopRun(input.runId); } catch (error) { failures.push(error); }
            try { await executionGrants.revokeAll("cleanup"); } catch (error) { failures.push(error); }
            try {
              consumeStreamingRecovery(await streamingRuntime.reconcileStartup({ maxRecords: 1_024, timeoutMs: 30_000 }));
            } catch (error) { failures.push(error); }
            for (const sessionId of streamingKernel.store.listSessionIds()) {
              if (streamingKernel.store.readBySession(sessionId)?.state === "released") continue;
              try {
                await streamingRuntime.cleanupOwnedSession({ sessionId, timeoutMs: 30_000 });
              } catch (error) { failures.push(error); }
            }
            try {
              consumeStreamingRecovery(await streamingRuntime.reconcileStartup({ maxRecords: 1_024, timeoutMs: 30_000 }));
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
            try { await subprocessKernel.runtime.reconcileStartup(); } catch (error) { failures.push(error); }
            try {
              await input.cleanupFault?.({
                runId: input.runId,
                point: "before_isolation_recovery",
              });
              const recovery = await isolation.recoverOwnedLeases();
              const blockers = recovery.flatMap((entry) => entry.blockers);
              if (blockers.length > 0) throw new Error(blockers.join(" "));
            } catch (error) { failures.push(error); }
            if (failures.length === 0) cleanupDutiesSettled = true;
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, `ExecutionHost run ${input.runId} cleanup failed.`);
          }
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
    managedRuntimeRegistration.detach = input.managedProcesses.registerRuntime(createExecutionHostManagedRuntime({
      run: binding, permissionProfile: input.permissionProfile, environment: input.ambientEnvironment,
    }));
    return binding;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    for (const cleanup of constructionCleanups.reverse()) {
      try { await cleanup(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
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
  const portable = createWindowsProcessBackend({
    stateDirectory: join(runRoot, "process-backend"),
    jobObjects: "unavailable",
    semanticFacts: facts,
  });
  const kinds = new Set(selectWindowsProcessBackendKinds(facts));
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
      backend: portable,
    }] : []),
  ];
}

function createStreamingOutputOptions(input: {
  readonly runRoot: string;
  readonly projectRoot: string;
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
        spillRoot: join(input.runRoot, "streaming-output"),
        projectRoot: input.projectRoot,
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
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("ExecutionHost run/session identity is invalid.");
  }
  return value;
}

/** Reserved by the B3 public-family seam; the host never fabricates this intent. */
export type ExecutionHostStreamingIntent = ExecutionInvocationIntent;
