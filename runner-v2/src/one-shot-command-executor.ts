import type { ToolExecutionContext } from "./agent-contracts.js";
import {
  freezeExecutionLifecycleRequirements,
  resolveRequiredLifecycleScope,
  type ExecutionLifecycleRequirements,
} from "./execution-lifecycle-policy.js";
import { createHash } from "node:crypto";
import type { PermissionProfile } from "./contracts.js";
import type { ChildEnvironmentFactory } from "./child-environment.js";
import { BoundedOutputSpool } from "./bounded-output-spool.js";
import type { ArtifactStore } from "./artifact-store.js";
import type {
  ExecutionInvocationIntent,
  GenericProcessResult,
  ProcessOutputDisposition,
} from "./execution-safety-contracts.js";
import type {
  ExecutionGrantAuthority,
  ExecutionGrantBinding,
  OpaqueExecutionGrant,
} from "./execution-grants.js";
import type {
  ExecutionIsolationSelection,
  ExecutionIsolationSelector,
} from "./execution-isolation-provider.js";
import type {
  ExecutionGrantController,
  ProcessOutputFactory,
  ProcessOutputSession,
  SubprocessRuntime,
} from "./subprocess-runtime.js";

export interface OneShotCommandRequest {
  /** Private bounded live bytes for protocol-like callers (Git). Not durable. */
  readonly captureOutputBytes?: number;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly explicitEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  /** Trusted lifecycle requirements; never inferred from argv or model text. */
  readonly lifecycleRequirements?: ExecutionLifecycleRequirements;
  readonly context: Pick<ToolExecutionContext, "runId" | "sessionId" | "signal"> & {
    readonly actor: ExecutionGrantBinding["actor"];
    readonly callId: string;
    readonly toolName: string;
    readonly taskId?: string;
    readonly executionGrant?: OpaqueExecutionGrant;
    readonly runnerInternal?: true;
  };
}

export function createBoundedProcessOutputFactory(input: {
  readonly spillRoot: string;
  readonly projectRoot: string;
  readonly artifacts: ArtifactStore;
}): ProcessOutputFactory {
  const sessions = new Map<string, ProcessOutputSession>();
  const create = (ownerId: string): ProcessOutputSession => {
    const ownerDigest = createHash("sha256").update(ownerId).digest("hex");
    const spool = new BoundedOutputSpool({
      // A durable output owner must have an independently claimable root. A
      // shared physical root races both directory creation and ownership-marker
      // validation when one-shot commands execute concurrently. The owner digest
      // is stable across restart, so reopen reaches the exact same private root.
      spillRoot: `${input.spillRoot}-${ownerDigest.slice(0, 20)}`,
      projectRoot: input.projectRoot,
      ownershipId: `process-output-${ownerDigest}`,
      artifactStore: input.artifacts,
    });
    const session: ProcessOutputSession = Object.freeze({
      ownerId,
      write: async (
        stream: "stdout" | "stderr",
        bytes: Uint8Array,
      ) => await spool.write(stream, bytes),
      finalize: async () => {
        try { return await spool.finalize(); }
        finally { sessions.delete(ownerId); }
      },
      cleanup: async () => {
        try { await spool.cleanup(); }
        finally { sessions.delete(ownerId); }
      },
    });
    sessions.set(ownerId, session);
    return session;
  };
  return Object.freeze({
    prepare: async (ownerId: string) => {
      if (sessions.has(ownerId)) throw new Error("Output owner is already active.");
      return create(ownerId);
    },
    reopen: async (ownerId: string) => sessions.get(ownerId) ?? create(ownerId),
  });
}

export interface OneShotCommandResult {
  readonly capturedOutput?: Readonly<{ stdout: Uint8Array; stderr: Uint8Array; complete: boolean }>;
  readonly process: GenericProcessResult;
  readonly enforcement:
    | "write_confinement_exact_grant"
    | "unconfined_explicit_full";
  readonly disclosure:
    | "provider_specific_not_universal_boundary"
    | "unconfined_explicit_full";
  readonly providerId?: string;
}

/** Call-scoped facade; the shared runtime and grant authority stay Runner-private. */
export interface OneShotCommandExecutor {
  execute(request: OneShotCommandRequest): Promise<OneShotCommandResult>;
}

export interface RuntimeBackedOneShotCommandExecutorOptions {
  readonly runtime: SubprocessRuntime;
  readonly runtimeGrants: ExecutionGrantController;
  readonly executionGrants: ExecutionGrantAuthority;
  readonly isolation: ExecutionIsolationSelector;
  readonly permissionProfile: PermissionProfile;
  readonly ambientEnvironment: Readonly<Record<string, string | undefined>>;
  readonly environments: ChildEnvironmentFactory;
  readonly clock?: () => Date;
}

export function createRuntimeBackedOneShotCommandExecutor(
  options: RuntimeBackedOneShotCommandExecutorOptions,
): OneShotCommandExecutor {
  const clock = options.clock ?? (() => new Date());
  return Object.freeze({
    async execute(request: OneShotCommandRequest): Promise<OneShotCommandResult> {
      const capture = request.captureOutputBytes === undefined ? undefined : boundedLiveOutput(request.captureOutputBytes);
      let opaqueGrant = request.context.executionGrant;
      let internalGrant = false;
      if (!opaqueGrant && request.context.runnerInternal === true) {
        opaqueGrant = await options.executionGrants.issue({
          runId: request.context.runId,
          sessionId: request.context.sessionId,
          actor: request.context.actor,
          toolName: request.context.toolName,
          callId: request.context.callId,
          permissionProfile: options.permissionProfile,
          workspacePath: request.workingDirectory,
          access: [{ path: request.workingDirectory, mode: "write" }],
          externalApproved: false,
          destructiveApproved: false,
          networkApproved: false,
          ...(request.context.signal ? { signal: request.context.signal } : {}),
        });
        internalGrant = true;
      }
      if (!opaqueGrant) throw commandError(
        "execution_grant_unavailable",
        "An exact ToolBroker execution grant is required.",
      );
      const invocationId = safeInvocationId(
        request.context.runId,
        request.context.sessionId,
        request.context.callId,
      );
      const originalIntent: ExecutionInvocationIntent = Object.freeze({
        invocationId,
        runId: request.context.runId,
        sessionId: request.context.sessionId,
        ...(request.context.taskId ? { taskId: request.context.taskId } : {}),
        kind: "command" as const,
        executable: request.executable,
        arguments: Object.freeze([...request.arguments]),
        workingDirectory: request.workingDirectory,
        requiredLifecycleScope: resolveRequiredLifecycleScope({
          permissionProfile: options.permissionProfile,
          lifecycleRequirements: freezeExecutionLifecycleRequirements(request.lifecycleRequirements),
        }),
        requestedCapabilities: Object.freeze([]),
      });
      const claims = options.executionGrants.consume(opaqueGrant, {
        runId: request.context.runId,
        sessionId: request.context.sessionId,
        actor: request.context.actor,
        toolName: request.context.toolName,
        callId: request.context.callId,
        permissionProfile: options.permissionProfile,
      });
      let selection: ExecutionIsolationSelection | undefined;
      let process: GenericProcessResult | undefined;
      let runtimeGrantIssued = false;
      try {
        if (options.permissionProfile === "full") {
          selection = await options.isolation.acquire({
            permissionProfile: options.permissionProfile,
            intent: originalIntent,
            grant: claims,
          });
        } else {
          const prepared = options.environments.prepare({
            ambient: options.ambientEnvironment,
            explicitOverrides: request.explicitEnvironment,
            runId: originalIntent.runId,
            invocationId,
          });
          selection = await options.environments.withChildEnvironment(
            prepared.capability,
            async (environment) => await options.isolation.acquire({
              permissionProfile: options.permissionProfile,
              intent: originalIntent,
              grant: claims,
              environment,
            }),
          );
        }
        const launchIntent = await options.isolation.prepareExecution(
          selection,
          originalIntent,
        );
        options.runtimeGrants.issue({
          grantId: claims.grantId,
          runId: claims.runId,
          invocationId,
          issuedAt: claims.issuedAt,
          expiresAt: claims.expiresAt,
          access: claims.access,
        });
        runtimeGrantIssued = true;
        process = await options.runtime.invoke({
          intent: launchIntent,
          ...(capture ? { onOutput: capture.write } : {}),
          grantId: claims.grantId,
          ambientEnvironment: options.permissionProfile === "full"
            ? options.ambientEnvironment
            : {},
          ...(options.permissionProfile === "full" && request.explicitEnvironment
            ? { explicitEnvironment: request.explicitEnvironment }
            : {}),
          ...(request.context.signal ? { signal: request.context.signal } : {}),
          deadline: new Date(clock().getTime() + request.timeoutMs),
        });
        return {
          process,
          ...(capture ? { capturedOutput: capture.result(process) } : {}),
          enforcement: selection.enforcement,
          disclosure: selection.disclosure,
          ...(selection.enforcement === "write_confinement_exact_grant"
            ? { providerId: selection.providerId }
            : {}),
        };
      } finally {
        try {
          if (runtimeGrantIssued) options.runtimeGrants.revoke(claims.grantId);
        } finally {
          try {
            if (selection) await options.isolation.release(selection);
          } finally {
            if (internalGrant) await options.executionGrants.revoke(opaqueGrant, "cleanup");
          }
        }
      }
    },
  });
}

export function outputFor(
  result: GenericProcessResult,
  stream: "stdout" | "stderr",
): ProcessOutputDisposition {
  return result.output.find((entry) => entry.stream === stream) ?? {
    stream,
    tail: "",
    totalBytes: 0,
    truncated: false,
    spillBytes: 0,
    lossyBytes: 0,
  };
}

function safeInvocationId(runId: string, sessionId: string, callId: string): string {
  const source = `${runId}\0${sessionId}\0${callId}`;
  if (!runId.trim() || !sessionId.trim() || !callId.trim()) throw commandError(
    "execution_invocation_invalid",
    "Command invocation identity is invalid.",
  );
  return `inv-${createHash("sha256").update(source).digest("hex")}`;
}

function commandError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}


/** Bounded ephemeral transport capture. Disk loss is still reported separately.
 * Overflow keeps draining; it never kills a workload or returns partial success.
 */
function boundedLiveOutput(maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 * 1024 * 1024)
    throw new Error("Command output capture bound must be from 1 to 134217728 bytes.");
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  const totals = { stdout: 0, stderr: 0 };
  let overflow = false;
  return {
    write(stream: "stdout" | "stderr", bytes: Uint8Array): void {
      totals[stream] += bytes.byteLength;
      if (totals.stdout + totals.stderr > maximum) overflow = true;
      if (!overflow && bytes.byteLength) chunks[stream].push(Buffer.from(bytes));
    },
    result(process: GenericProcessResult) {
      const complete = !overflow && process.output.length === 2 && (["stdout", "stderr"] as const).every((stream) =>
        process.output.filter((entry) => entry.stream === stream).length === 1 &&
        process.output.find((entry) => entry.stream === stream)!.totalBytes === totals[stream]);
      return Object.freeze({ stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr), complete });
    },
  };
}
