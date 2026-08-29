import type { ToolExecutionContext } from "./agent-contracts.js";
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
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly explicitEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly context: Pick<ToolExecutionContext, "runId" | "sessionId" | "actor" | "signal"> & {
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
    const spool = new BoundedOutputSpool({
      spillRoot: input.spillRoot,
      projectRoot: input.projectRoot,
      ownershipId: `process-output-${createHash("sha256").update(ownerId).digest("hex")}`,
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
        requestedCapabilities: Object.freeze([
          "tree_termination" as const,
          "verified_emptiness" as const,
        ]),
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
        process = await options.runtime.invoke({
          intent: launchIntent,
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
          enforcement: selection.enforcement,
          disclosure: selection.disclosure,
          ...(selection.enforcement === "write_confinement_exact_grant"
            ? { providerId: selection.providerId }
            : {}),
        };
      } finally {
        try {
          if (selection) await options.isolation.release(selection);
        } finally {
          if (internalGrant) await options.executionGrants.revoke(opaqueGrant, "cleanup");
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
