import { authorizeSessionLeaseOwnership } from "./session-authority.js";
import { transferExecutionIsolationLeaseToSession } from "./execution-isolation-provider.js";
import { createHash } from "node:crypto";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";

import type { ChildEnvironmentFactory } from "./child-environment.js";
import type { PermissionProfile } from "./contracts.js";
import type { ConsumedExecutionGrantClaims } from "./execution-grants.js";
import type { ExecutionInvocationIntent } from "./execution-safety-contracts.js";
import type {
  ExecutionIsolationSelection,
  ExecutionIsolationSelector,
} from "./execution-isolation-provider.js";
import type { InteractiveProcessChannel } from "./interactive-process-channel.js";
import {
  adoptProcessBackendAfterRestart,
  parseProcessEmptyVerification,
  parseProcessLaunchResult,
  parseProcessReconciliation,
  parseProcessReleaseResult,
  reattestProcessBackend,
  selectProcessBackend,
  type ProcessBackend,
  type ProcessBackendBinding,
  type ProcessBackendRegistry,
  type ProcessEffectFence,
} from "./process-backend.js";
import type { SessionAuthority } from "./session-authority.js";
import {
  createStreamingProcessSessionRuntime,
  type StreamingHandshakeControl,
  type StreamingOpenRequest,
  type StreamingRuntimeOptions,
} from "./streaming-process-session-runtime.js";
import type {
  HostLaunchRecord,
  StreamingSessionLease,
  StreamingSessionStoreKernel,
} from "./streaming-session-store.js";

const HOST_GRACEFUL_SETTLEMENT_MS = 5_000;
const HOST_CLEANUP_POLL_MS = 25;

interface BackpressuredBackend extends ProcessBackend {
  backpressuredChannelProvider(): Readonly<{
    acquire: StreamingRuntimeOptions["channel"]["acquire"];
    reattach: NonNullable<StreamingRuntimeOptions["channel"]["reattach"]>;
  }>;
}

export interface ExecutionHostStreamingOpenRequest extends StreamingOpenRequest {
  readonly intent: ExecutionInvocationIntent;
  /** Runner-family-owned executable token for strict image execution. */
  readonly imageExecutable?: string;
  readonly explicitEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly verifyHandshake: (channel: ExecutionHostStreamingHandshakeChannel) => Promise<string>;
}

/** Pre-adoption host-only duplex capability; it is never returned by open(). */
export type ExecutionHostStreamingHandshakeChannel = Readonly<
  StreamingHandshakeControl & Pick<
    InteractiveProcessChannel,
    "closeInput" | "gracefulStop" | "waitForTerminal"
  >
>;

export interface ExecutionHostStreamingGraphOptions {
  readonly permissionProfile: PermissionProfile;
  readonly ambientEnvironment: Readonly<Record<string, string>>;
  readonly environments: ChildEnvironmentFactory;
  readonly isolation: ExecutionIsolationSelector;
  readonly registry: ProcessBackendRegistry;
  readonly channelBackends: ReadonlyMap<string, ProcessBackend>;
  readonly sessions: SessionAuthority;
  readonly kernel: StreamingSessionStoreKernel;
  readonly output: StreamingRuntimeOptions["output"];
}

interface PendingLaunchContext {
  readonly intent: ExecutionInvocationIntent;
  readonly imageExecutable?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly verifyHandshake: (channel: ExecutionHostStreamingHandshakeChannel) => Promise<string>;
  backendIdentity?: string;
}

/**
 * Production streaming composition for ExecutionHost. Family adapters provide
 * only their exact intent and protocol handshake; process, isolation, channel,
 * output, recovery, and cleanup authority stay inside the host.
 */
export function createExecutionHostStreamingGraph(
  options: ExecutionHostStreamingGraphOptions,
) {
  const pending = new Map<string, PendingLaunchContext>();
  const contextByBackendIdentity = new Map<string, PendingLaunchContext>();
  const verifierByChannel = new WeakMap<
    object,
    (channel: ExecutionHostStreamingHandshakeChannel) => Promise<string>
  >();
  const selections = new Map<string, ExecutionIsolationSelection>();

  const selectedForBinding = async (
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ) => {
    try {
      return await reattestProcessBackend(options.registry, binding, fence);
    } catch {
      return await adoptProcessBackendAfterRestart(options.registry, binding, fence);
    }
  };

  const channelBackend = (binding: ProcessBackendBinding): BackpressuredBackend => {
    const backend = options.channelBackends.get(binding.backendId);
    if (!backend || typeof (backend as Partial<BackpressuredBackend>).backpressuredChannelProvider !== "function") {
      throw new Error("Selected process backend has no backpressured interactive channel.");
    }
    return backend as BackpressuredBackend;
  };

  const runtime = createStreamingProcessSessionRuntime({
    sessions: options.sessions,
    kernel: options.kernel,
    isolation: {
      acquire: async ({ launchId, claims }) => {
        const context = exactPendingContext(pending, launchId, claims);
        const selection = await options.isolation.acquire({
          permissionProfile: options.permissionProfile,
          intent: context.intent,
          ...(context.imageExecutable
            ? { imageExecutable: context.imageExecutable }
            : {}),
          grant: claims,
          environment: context.environment,
        });
        const lease = streamingLease(selection, context.intent, claims);
        selections.set(lease.leaseId, selection);
        return lease;
      },
      release: async (lease) => {
        const selection = selections.get(lease.leaseId);
        if (selection) {
          try { await options.isolation.release(selection); }
          finally { selections.delete(lease.leaseId); }
          return;
        }
        if (lease.providerId === "runner-unconfined-explicit-full") return;
        const recovery = await options.isolation.recoverOwnedLeases();
        const blockers = recovery.flatMap((entry) => entry.blockers);
        if (blockers.length > 0 || options.isolation.activeLeases().some((entry) => entry.leaseId === lease.leaseId)) {
          throw new Error(blockers.join(" ") || `Isolation lease ${lease.leaseId} remains active.`);
        }
      },
    },
    host: {
      launch: async ({ launchId, claims, lease }) => {
        const context = exactPendingContext(pending, launchId, claims);
        const selection = selections.get(lease.leaseId);
        if (!selection) throw new Error("Exact streaming isolation selection is unavailable.");
        const intent = await options.isolation.prepareExecution(selection, context.intent);
        const fence = Object.freeze({ ownerId: `host:${claims.runId}`, fencingToken: 1 });
        const selected = await selectProcessBackend(
          options.registry,
          intent.requestedCapabilities,
          intent.requiredLifecycleScope,
          fence,
        );
        const launch = parseProcessLaunchResult(await selected.backend.launch({
          intent,
          grant: processGrant(claims, lease.invocationId),
          environment: context.environment,
          outputOwnerId: `streaming-output:${launchId}`,
          fence,
        }));
        context.backendIdentity = launch.opaqueIdentity;
        contextByBackendIdentity.set(launch.opaqueIdentity, context);
        return Object.freeze({
          registryId: selected.registryId,
          backendId: selected.attestation.backendId,
          implementationGeneration: selected.implementationGeneration,
          implementationDigest: selected.implementationDigest,
          attestationVersion: selected.attestation.attestationVersion,
          attestationDigest: selected.attestationDigest,
          capabilities: selected.attestation.capabilities,
          lifecycle: selected.attestation.lifecycle,
          ...launch,
        });
      },
      quiesce: async ({ record, fence, deadlineAt }) => await quiesceExactBackend(
        record as HostLaunchRecord,
        fence,
        deadlineAt,
        selectedForBinding,
      ),
      observeQuiescence: async ({ record, fence, deadlineAt }) => await observeExactBackendQuiescence(
        record as HostLaunchRecord,
        fence,
        deadlineAt,
        selectedForBinding,
      ),
      release: async ({ record, fence, deadlineAt }) => await releaseExactBackend(
        record as HostLaunchRecord,
        fence,
        deadlineAt,
        selectedForBinding,
      ),
    },
    channel: {
      version: 2,
      replayCapacityChunks: options.output.maxQueueChunks,
      replayCapacityBytes: options.output.maxQueueBytes,
      acquire: async (binding, fence) => {
        await selectedForBinding(binding, fence);
        const channel = await channelBackend(binding).backpressuredChannelProvider().acquire(binding, fence);
        const context = contextByBackendIdentity.get(binding.opaqueIdentity);
        if (!context) {
          await channel.detach().catch(() => undefined);
          throw new Error("Exact streaming handshake context is unavailable.");
        }
        verifierByChannel.set(channel as object, context.verifyHandshake);
        return channel;
      },
      reattach: async (binding, fence) => {
        await selectedForBinding(binding, fence);
        return await channelBackend(binding).backpressuredChannelProvider().reattach(binding, fence);
      },
    },
    handshake: {
      verify: async (channel, control) => {
        const verifier = verifierByChannel.get(channel as object);
        if (!verifier) throw new Error("Exact streaming handshake verifier is unavailable.");
        const interactive = channel as Partial<InteractiveProcessChannel>;
        if (typeof interactive.closeInput !== "function" ||
            typeof interactive.gracefulStop !== "function" ||
            typeof interactive.waitForTerminal !== "function") {
          throw new Error("Streaming channel lacks exact pre-adoption duplex control.");
        }
        verifierByChannel.delete(channel as object);
        return await verifier(Object.freeze({
          write: control.write,
          waitForOutput: control.waitForOutput,
          deliverOutput: control.deliverOutput,
          closeInput: interactive.closeInput.bind(channel),
          gracefulStop: interactive.gracefulStop.bind(channel),
          waitForTerminal: interactive.waitForTerminal.bind(channel),
        }));
      },
    },
    output: options.output,
  });

  return Object.freeze({
    runtime,
    async open(request: ExecutionHostStreamingOpenRequest) {
      assertOpenRequest(request, options.permissionProfile);
      if (pending.has(request.launchId)) throw new Error(`Streaming launch ${request.launchId} is already pending.`);
      const prepared = options.environments.prepare({
        ambient: options.ambientEnvironment,
        explicitOverrides: request.explicitEnvironment,
        runId: request.intent.runId,
        invocationId: request.intent.invocationId,
      });
      const environment = options.environments.withChildEnvironment(
        prepared.capability,
        (value) => Object.freeze({ ...value }),
      );
      const context: PendingLaunchContext = {
        intent: Object.freeze({
          ...request.intent,
          arguments: Object.freeze([...request.intent.arguments]),
          requiredLifecycleScope: request.intent.requiredLifecycleScope,
      requestedCapabilities: Object.freeze([...request.intent.requestedCapabilities]),
        }),
        ...(request.imageExecutable
          ? { imageExecutable: request.imageExecutable }
          : {}),
        environment,
        verifyHandshake: request.verifyHandshake,
      };
      pending.set(request.launchId, context);
      try {
        const facade = await runtime.open(request);
        if (request.intent.kind === "mcp_server") {
          const selection = selections.get(facade.record.lease.leaseId);
          if (selection?.enforcement === "write_confinement_exact_grant") {
            try {
              transferExecutionIsolationLeaseToSession(options.isolation, selection,
                authorizeSessionLeaseOwnership(options.sessions, facade.sessionId));
            } catch (primary) {
              try { await runtime.cleanupOwnedSession({ sessionId: facade.sessionId, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS }); }
              catch (cleanup) { throw new AggregateError([primary, cleanup], "MCP adopted isolation transfer could not certify cleanup."); }
              throw primary;
            }
          }
        }
        return facade;
      } finally {
        pending.delete(request.launchId);
        if (context.backendIdentity) contextByBackendIdentity.delete(context.backendIdentity);
      }
    },
  });
}

function exactPendingContext(
  pending: ReadonlyMap<string, PendingLaunchContext>,
  launchId: string,
  claims: ConsumedExecutionGrantClaims,
): PendingLaunchContext {
  const context = pending.get(launchId);
  if (!context || context.intent.invocationId !== launchId || context.intent.runId !== claims.runId ||
      context.intent.sessionId !== claims.sessionId) {
    throw new Error("Exact streaming launch context is unavailable.");
  }
  return context;
}

function assertOpenRequest(
  request: ExecutionHostStreamingOpenRequest,
  permissionProfile: PermissionProfile,
): void {
  if (request.intent.invocationId !== request.launchId || request.intent.runId !== request.binding.runId ||
      request.intent.sessionId !== request.binding.sessionId ||
      request.binding.permissionProfile !== permissionProfile ||
      (request.imageExecutable !== undefined &&
        (!request.imageExecutable.trim() || request.imageExecutable.includes("\0"))) ||
      typeof request.verifyHandshake !== "function") {
    throw new Error("Streaming open request does not match its exact host/run authority.");
  }
}

function streamingLease(
  selection: ExecutionIsolationSelection,
  intent: ExecutionInvocationIntent,
  claims: ConsumedExecutionGrantClaims,
): StreamingSessionLease {
  if (selection.enforcement === "write_confinement_exact_grant") {
    return Object.freeze({
      leaseId: selection.lease.leaseId,
      providerId: selection.providerId,
      invocationId: selection.lease.invocationId,
      providerIdentity: selection.lease.providerIdentity,
      acquiredAt: selection.lease.acquiredAt,
      ...(selection.lease.expiresAt ? { expiresAt: selection.lease.expiresAt } : {}),
      access: Object.freeze(selection.lease.grantedAccess.map((entry) => Object.freeze({ ...entry }))),
    });
  }
  return Object.freeze({
    leaseId: `unconfined-${createHash("sha256")
      .update(`${intent.runId}\0${intent.invocationId}\0${claims.grantId}`)
      .digest("hex")}`,
    providerId: "runner-unconfined-explicit-full",
    invocationId: intent.invocationId,
    providerIdentity: createHash("sha256").update("runner-v2/unconfined-explicit-full@1").digest("hex"),
    acquiredAt: new Date().toISOString(),
    ...(claims.expiresAt ? { expiresAt: claims.expiresAt } : {}),
    access: Object.freeze(claims.access.map((entry) => Object.freeze({ ...entry }))),
  });
}

function processGrant(
  claims: ConsumedExecutionGrantClaims,
  invocationId: string,
) {
  return Object.freeze({
    grantId: claims.grantId,
    runId: claims.runId,
    invocationId,
    issuedAt: claims.issuedAt,
    ...(claims.expiresAt ? { expiresAt: claims.expiresAt } : {}),
    access: Object.freeze(claims.access.map((entry) => Object.freeze({ ...entry }))),
  });
}

function backendLaunchNeverBegan(record: HostLaunchRecord): boolean {
  // begin_launch is durable before the backend can be invoked. A missing
  // binding alone is NOT proof; an issued launch effect or later history keeps
  // crash/ambiguous launch cleanup blocked. Isolation recovery is separate.
  return !record.backendBinding && !record.channelAcquisitionStartedAt && !record.outputCheckpointCreatedAt &&
    !record.effects.some((effect) => effect.kind === "launch" || effect.kind === "handoff") &&
    record.history.every((entry) => ["prepared", "isolated", "cleanup_pending", "cleanup_blocked"].includes(entry.state));
}

export async function quiesceExactBackend(
  record: HostLaunchRecord,
  fence: ProcessEffectFence,
  deadlineAt: number,
  selectedForBinding: (
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ) => Promise<{ backend: ProcessBackend }>,
): Promise<"verified" | "blocked" | "outcome_unknown"> {
  const binding = record.backendBinding;
  if (!binding) return backendLaunchNeverBegan(record) ? "verified" : "outcome_unknown";
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) return "outcome_unknown";
  try {
    const selected = await selectedForBinding(binding, fence);
    let observed = parseProcessReconciliation(await selected.backend.reconcile(binding, fence));
    // Force/terminate "exited" proves workload quiescence. verifyEmpty also
    // demands stopped supervisor status and settled output; those belong to
    // retained_output_settlement / backend_release, not this resource.
    let workloadExited = observed.state === "exited";
    // Signal "exited" only means the OS group looked empty. POSIX supervisors can
    // still publish status=outcome_unknown until force proves durable retirement;
    // retained_output_settlement then fails because settle requires running|stopping|stopped.
    // Quiescence is therefore reconcile "exited" (durable retirement / terminal proof).
    const refreshExited = async () => {
      observed = parseProcessReconciliation(await selected.backend.reconcile(binding, fence));
      if (observed.state === "exited") workloadExited = true;
      return observed;
    };
    if (observed.state === "running" || observed.state === "outcome_unknown") {
      let gracefulRequested = false;
      try {
        await selected.backend.signal(binding, "terminate", fence);
        gracefulRequested = true;
      } catch { /* force escalation below retains the same exact binding */ }
      await refreshExited();
      const gracefulDeadline = Math.min(
        deadlineAt,
        Date.now() + HOST_GRACEFUL_SETTLEMENT_MS,
      );
      // outcome_unknown after terminate means the OS group may be empty while the
      // supervisor still lacks durable retirement; waiting here only burns the
      // cleanup deadline before force can publish that proof.
      while (!workloadExited && gracefulRequested && observed.state === "running" && Date.now() < gracefulDeadline) {
        await sleep(HOST_CLEANUP_POLL_MS);
        await refreshExited();
      }
      while (!workloadExited && Date.now() < deadlineAt) {
        try {
          await selected.backend.signal(binding, "force_terminate", fence);
        } catch { /* a just-exited exact tree is settled by the next reconciliation */ }
        await refreshExited();
        if (workloadExited) break;
        await sleep(HOST_CLEANUP_POLL_MS);
      }
    }
    return workloadExited ? "verified" : "outcome_unknown";
  } catch {
    return "outcome_unknown";
  }
}

async function releaseExactBackend(
  record: HostLaunchRecord,
  fence: ProcessEffectFence,
  deadlineAt: number,
  selectedForBinding: (
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ) => Promise<{ backend: ProcessBackend }>,
): Promise<"verified" | "blocked" | "outcome_unknown"> {
  const binding = record.backendBinding;
  if (!Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) return "outcome_unknown";
  if (!binding) return backendLaunchNeverBegan(record) ? "verified" : "outcome_unknown";
  try {
    const selected = await selectedForBinding(binding, fence);
    const empty = parseProcessEmptyVerification(await selected.backend.verifyEmpty(binding, fence));
    if (!empty.empty) return "blocked";
    parseProcessReleaseResult(await selected.backend.release(binding, fence));
    return "verified";
  } catch {
    // A missing backend after a crash between physical release and the durable
    // session CAS is not proof of success. The coordinator persists a typed
    // reconciliation blocker for this outcome.
    return "outcome_unknown";
  }
}

async function observeExactBackendQuiescence(
  record: HostLaunchRecord,
  fence: ProcessEffectFence,
  deadlineAt: number,
  selectedForBinding: (
    binding: ProcessBackendBinding,
    fence: ProcessEffectFence,
  ) => Promise<{ backend: ProcessBackend }>,
): Promise<"verified" | "blocked" | "outcome_unknown"> {
  const binding = record.backendBinding;
  if (!binding || !Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt) return "outcome_unknown";
  try {
    const selected = await selectedForBinding(binding, fence);
    const observed = parseProcessReconciliation(await selected.backend.reconcile(binding, fence));
    if (observed.state === "exited") return "verified";
    if (observed.state === "running") return "blocked";
    return "outcome_unknown";
  } catch {
    return "outcome_unknown";
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
