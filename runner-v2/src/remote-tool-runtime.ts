import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type { ToolResult } from "./agent-contracts.js";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionHost, ExecutionHostRunBinding } from "./execution-host.js";
import { createFilesystemTools } from "./filesystem-tools.js";
import { createGitTools } from "./git-tools.js";
import { createImageTools } from "./image-tools.js";
import { createManagedProcessTools } from "./managed-process-tools.js";
import { createProcessTools } from "./process-tools.js";
import { roleAllowList } from "./role-capabilities.js";
import type { RunnerCapabilitiesConfig } from "./runner-capabilities-config.js";
import { createRunnerCapabilityContract } from "./runner-capability-contract.js";
import { DEFAULT_REMOTE_DEVICE_POLICY, RemotePrincipalStore, type LocalMcpIdentity, type RemoteDevicePolicy, type RemotePrincipal, type VerifiedRemoteIdentity } from "./remote-principal.js";
import type { RemoteAuditStore } from "./remote-audit-store.js";
import { APPROVAL_TOOLS, commandApprovalSummary, type CommandApprovalSummary } from "./remote-approval.js";
import { SqliteToolLedger } from "./sqlite-tool-ledger.js";
import { resolveProtectedLocations, type ProtectedLocations } from "./protected-locations.js";
import { createRemotePathGuard, RemotePathDeniedError, type RemotePathGuard } from "./remote-path-guard.js";
import { ToolBroker } from "./tool-broker.js";

export interface RemoteToolRuntimeOptions {
  readonly host: ExecutionHost;
  readonly principals: RemotePrincipalStore;
  /** Trusted local configuration, never copied from tool arguments. */
  readonly workspacePath: string;
  readonly permissionProfile: PermissionProfile;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  /** Runner-owned admission, supplied only by trusted composition after S1 and R2. */
  readonly admitEffect?: (request: Readonly<RemoteEffectRequest>, dispatch: () => Promise<ToolResult>) => Promise<ToolResult>;
  /** Trusted local protected-location configuration (S1a); never from tool input. */
  readonly protectedLocations?: ProtectedLocations;
  readonly pathGuard?: RemotePathGuard;
  readonly stateDirectory?: string;
  readonly deviceDirectory?: string;
  readonly extensionDirectories?: readonly string[];
  readonly installerBinDirectories?: readonly string[];
}

export interface RemoteEffectRequest {
  readonly principal: RemotePrincipal;
  readonly callId: string;
  readonly toolName: string;
  readonly workspacePath: string;
  readonly arguments: unknown;
  /** Raw transport JSON preserves duplicate keys for admission validation. */
  readonly rawRequest?: string;
  /** Job already marked dispatching by the trusted connector scheduler. */
  readonly admittedJobId?: string;
  /** Synchronous policy and revocation check at the pre-effect boundary. */
  readonly authorize: () => ToolResult | undefined;
}

export interface RemoteInvocationResult {
  readonly result: ToolResult;
  /** False proves the broker was never called; true does not prove an effect or stop. */
  readonly brokerInvoked: boolean;
  /** Runtime-supplied evidence, not inferred from a broker cancellation result. */
  readonly stopEvidence?: { readonly effect: "no_effect" | "effect_outcome_unknown" };
}

interface BoundRemote {
  readonly binding: ExecutionHostRunBinding;
  readonly broker: ToolBroker;
  readonly ledger: SqliteToolLedger;
  readonly pathGuard: RemotePathGuard;
}

export function remotePathGuardFor(options: Pick<RemoteToolRuntimeOptions, "protectedLocations" | "pathGuard" | "stateDirectory" | "deviceDirectory" | "extensionDirectories" | "installerBinDirectories">): RemotePathGuard {
  if (options.pathGuard) return options.pathGuard;
  return createRemotePathGuard(options.protectedLocations ?? resolveProtectedLocations({
    platform: process.platform, env: process.env, home: homedir(),
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    ...(options.deviceDirectory ? { deviceDirectory: options.deviceDirectory } : {}),
    ...(options.extensionDirectories ? { extensionDirectories: options.extensionDirectories } : {}),
    ...(options.installerBinDirectories ? { installerBinDirectories: options.installerBinDirectories } : {}),
  }));
}

const ALLOWED_TOOLS = new Set(roleAllowList("remote", "remote"));
const SHELL_TOOLS = new Set(["process.start", "process.run", "process.write_stdin"]);
const MUTATING_TOOLS = new Set([
  "fs.write", "fs.patch", "fs.move", "fs.delete", "process.start", "process.run",
  "process.write_stdin", "process.signal",
]);
const AUTHORITY_ARGUMENTS = new Set([
  "actor", "role", "runId", "sessionId", "workspace", "workspacePath", "scope", "scopeRef",
  "grant", "executionGrant", "externalApproved", "permissionProfile", "callId", "toolName",
]);

/**
 * A composition interface, not a public endpoint. R1d must not expose it before S1
 * path protections and R2 effect admission are in place. The caller verifies identity.
 */
export class RemoteToolRuntime {
  private readonly workspacePath: string;
  private readonly bindings = new Map<string, Promise<BoundRemote>>();
  private readonly partialBindings = new Map<string, { binding: ExecutionHostRunBinding; ledger?: SqliteToolLedger }>();
  private readonly active = new Set<Promise<ToolResult>>();
  private closing = false;
  readonly pathGuard: RemotePathGuard;

  constructor(private readonly options: RemoteToolRuntimeOptions) {
    if (!isAbsolute(options.workspacePath)) throw new Error("Remote workspace must be an absolute local path.");
    this.workspacePath = resolve(options.workspacePath);
    this.pathGuard = remotePathGuardFor(options);
  }

  pathAuditRecords(): readonly import("./remote-path-guard.js").RemotePathAuditRecord[] { return this.pathGuard.auditRecords(); }

  invoke(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal?: AbortSignal, rawRequest?: string, jobId?: string): Promise<ToolResult> {
    return this.beginInvocation(identity, name, args, signal, rawRequest, undefined, undefined, undefined, jobId);
  }

  async invokeAdmitted(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal: AbortSignal,
    rawRequest: string, jobId: string, beforeBroker?: () => boolean, approvalGranted = false): Promise<RemoteInvocationResult> {
    let brokerInvoked = false;
    const result = await this.beginInvocation(identity, name, args, signal, rawRequest, jobId, () => { brokerInvoked = true; }, beforeBroker, undefined, approvalGranted);
    return { result, brokerInvoked };
  }

  /** Local principal and device policy are rechecked independently of relay claims. */
  authorizeJob(identity: VerifiedRemoteIdentity, name?: string, args?: unknown): string | undefined {
    const principal = this.options.principals.getOrCreate(identity);
    if (principal.revoked || this.closing) return "unauthorized";
    const policy = this.options.principals.policy(identity);
    if (name?.startsWith("plugin_") && policy.readOnly) return "permission_denied";
    if (name) return policyRefusal(policy, name, args, true)?.code;
    return undefined;
  }

  requiresCommandApproval(identity: VerifiedRemoteIdentity, name: string): boolean {
    return this.options.principals.policy(identity).approvals && APPROVAL_TOOLS.has(name);
  }

  summarizeCommandApproval(identity: VerifiedRemoteIdentity, jobId: string, code: string, name: string, args: unknown): CommandApprovalSummary {
    return commandApprovalSummary(jobId, code, name, args, this.workspacePath, this.options.principals.policy(identity).onlyHere);
  }

  /** Stop only a process issued to this exact Runner-owned remote principal. */
  async stopStartedProcess(identity: VerifiedRemoteIdentity, processId: string): Promise<boolean> {
    const principal = this.options.principals.find(identity);
    if (!principal) return false;
    const bound = await this.binding(principal);
    const owned = (await bound.binding.managedProcesses.listRun(principal.runId)).find((item) =>
      item.processId === processId && item.sessionId === principal.sessionId &&
      item.actor.role === "remote" && item.actor.id === principal.principalId);
    if (!owned) return false;
    await bound.binding.managedProcesses.stopProcesses([processId]);
    const stopped = (await bound.binding.managedProcesses.listRun(principal.runId)).find((item) => item.processId === processId);
    return stopped?.status === "stopped";
  }
  private beginInvocation(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal?: AbortSignal,
    rawRequest?: string, admittedJobId?: string, onBrokerInvoke?: () => void, beforeBroker?: () => boolean, auditJobId?: string,
    approvalGranted = false): Promise<ToolResult> {
    const callId = `remote-call-${randomUUID()}`;
    const jobId = admittedJobId ?? auditJobId;
    const work = this.pathGuard.withWorkspaceScope(this.workspacePath, () => this.options.principals.policy(identity).onlyHere, async (scope) => {
      let dispatched: ToolResult | undefined;
      let result: ToolResult;
      try {
        if (this.closing) result = failure(callId, name, "runtime_closed", "Remote runtime is closing.");
        else {
          let snapshot: unknown;
          try { snapshot = freezeArguments(structuredClone(args)); }
          catch { snapshot = undefined; }
          result = snapshot === undefined && args !== undefined
            ? failure(callId, name, "invalid_arguments", "Tool arguments cannot be copied safely.")
            : await this.invokeChecked(identity, name, snapshot, callId, signal, rawRequest, admittedJobId, onBrokerInvoke, beforeBroker,
              (value) => { dispatched = value; }, approvalGranted && admittedJobId !== undefined);
        }
      } catch (error) {
        this.options.principals.auditStore.recordTool({ role: "remote", ...identity, toolName: safeToolName(name, ALLOWED_TOOLS),
          decision: "failed", outcomeCode: "exception", ...(scope.lastDenied ? { pathCategory: scope.lastDenied.pathCategory } : {}), ...(jobId ? { jobId } : {}) }, auditEnabled(this.options.principals, identity));
        throw error;
      }
      const observed = dispatched ?? result;
      const admittedJob = result.content.find((part) => part.type === "json" && part.value && typeof part.value === "object" && "jobId" in part.value);
      const resultJob = admittedJob?.type === "json" && typeof (admittedJob.value as { jobId?: unknown }).jobId === "string" ? (admittedJob.value as { jobId: string }).jobId : undefined;
      this.options.principals.auditStore.recordTool({ role: "remote", ...identity, toolName: safeToolName(name, ALLOWED_TOOLS),
        ...auditOutcome(observed), ...(scope.lastDenied ? { pathCategory: scope.lastDenied.pathCategory } : {}), ...((jobId ?? resultJob) ? { jobId: jobId ?? resultJob } : {}) }, auditEnabled(this.options.principals, identity));
      return result;
    });
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }

  private async invokeChecked(identity: VerifiedRemoteIdentity, name: string, args: unknown, callId: string,
    signal?: AbortSignal, rawRequest?: string, admittedJobId?: string, onBrokerInvoke?: () => void, beforeBroker?: () => boolean,
    onDispatch?: (result: ToolResult) => void, approvalGranted = false): Promise<ToolResult> {
    let principal = this.options.principals.getOrCreate(identity);
    identity = principal.identity;
    if (principal.revoked) return failure(callId, name, "principal_revoked", "Remote principal is revoked.");
    if (!ALLOWED_TOOLS.has(name) || name.startsWith("browser.")) {
      return failure(callId, name, "tool_unavailable", "Tool is unavailable to the remote principal.");
    }
    if (args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).some((key) => AUTHORITY_ARGUMENTS.has(key))) {
      return failure(callId, name, "invalid_arguments", "Tool arguments cannot supply Runner authority.");
    }
    if (name === "image.inspect" && args && typeof args === "object" && Object.hasOwn(args, "artifactHash")) {
      return failure(callId, name, "tool_unavailable", "Artifact-hash inspection is not authorized for remote principals.");
    }
    let refusal = policyRefusal(this.options.principals.policy(identity), name, args, approvalGranted);
    if (refusal) return failure(callId, name, refusal.code, refusal.message);
    try { await constrainArguments(this.pathGuard, this.workspacePath, this.options.principals.policy(identity), name, args, `remote:${principal.principalId}`); }
    catch (error) { if (error instanceof RemotePathDeniedError) return failure(callId, name, error.code, error.message); throw error; }
    if (isMutating(name, args) && !this.options.admitEffect) {
      return failure(callId, name, "effect_admission_required", "Durable remote effect admission is unavailable.");
    }
    const bound = await this.binding(principal);
    // Binding and recovery can await; revocation and narrowing must win before dispatch.
    principal = this.options.principals.find(identity)!;
    if (!principal || principal.revoked) return failure(callId, name, "principal_revoked", "Remote principal is revoked.");
    refusal = policyRefusal(this.options.principals.policy(identity), name, args, approvalGranted);
    if (refusal) return failure(callId, name, refusal.code, refusal.message);
    const authorize = (): ToolResult | undefined => {
      const current = this.options.principals.find(identity);
      if (!current || current.revoked) return failure(callId, name, "principal_revoked", "Remote principal is revoked.");
      principal = current;
      const currentRefusal = policyRefusal(this.options.principals.policy(identity), name, args, approvalGranted);
      if (currentRefusal) return failure(callId, name, currentRefusal.code, currentRefusal.message);
      if (this.closing || signal?.aborted) return failure(callId, name, "tool_cancelled", "Remote invocation was cancelled.");
      if (beforeBroker && !beforeBroker()) return failure(callId, name, "unauthorized", "Remote authorization changed before dispatch.");
      return undefined;
    };
    const dispatch = async (): Promise<ToolResult> => {
      const denied = authorize();
      if (denied) return denied;
      let dispatchArgs: unknown;
      try { dispatchArgs = await constrainArguments(this.pathGuard, this.workspacePath, this.options.principals.policy(identity), name, args, `remote:${principal.principalId}`); }
      catch (error) { if (error instanceof RemotePathDeniedError) { const result = failure(callId, name, error.code, error.message); onDispatch?.(result); return result; } throw error; }
      onBrokerInvoke?.();
      const result = await bound.broker.invoke({ type: "tool_call", callId, name, arguments: dispatchArgs }, {
        runId: principal.runId, sessionId: principal.sessionId,
        actor: { role: "remote", id: principal.principalId }, workspacePath: this.workspacePath,
        ...(signal ? { signal } : {}),
      });
      if (!result.isError && (name === "fs.write" || name === "fs.move") && args && typeof args === "object" && !Array.isArray(args)) {
        const dest = (args as Record<string, unknown>)[name === "fs.write" ? "path" : "destination"];
        if (typeof dest === "string") {
          try { await this.pathGuard.assertAllowedAfterCreate(resolve(this.workspacePath, dest), "write", { toolName: name, principal: principal.principalId }); }
          catch (cause) { if (cause instanceof RemotePathDeniedError) { const denied = failure(callId, name, cause.code, cause.message); onDispatch?.(denied); return denied; } throw cause; }
        }
      }
      onDispatch?.(result);
      return result;
    };
    if (isMutating(name, args)) {
      return await this.options.admitEffect!({ principal, callId, toolName: name, workspacePath: this.workspacePath,
        arguments: args, ...(rawRequest !== undefined ? { rawRequest } : {}),
        ...(admittedJobId !== undefined ? { admittedJobId } : {}), authorize }, dispatch);
    }
    return await dispatch();
  }

  private binding(principal: RemotePrincipal): Promise<BoundRemote> {
    if (this.partialBindings.has(principal.principalId)) {
      return Promise.reject(new Error("Remote execution cleanup remains unverified."));
    }
    const existing = this.bindings.get(principal.principalId);
    if (existing) return existing;
    const created = this.createBinding(principal);
    this.bindings.set(principal.principalId, created);
    void created.catch(() => { if (this.bindings.get(principal.principalId) === created) this.bindings.delete(principal.principalId); });
    return created;
  }

  private async createBinding(principal: RemotePrincipal): Promise<BoundRemote> {
    return await createGovernedBinding({ ...this.options, pathGuard: this.pathGuard }, this.workspacePath, principal.runId, ALLOWED_TOOLS,
      (binding, ledger) => this.partialBindings.set(principal.principalId, { binding, ledger }));
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active]);
    const failures: unknown[] = [];
    for (const [id, partial] of this.partialBindings) {
      try { await partial.binding.close(); partial.ledger?.close(); this.partialBindings.delete(id); }
      catch (error) { failures.push(error); }
    }
    for (const [id, pending] of this.bindings) {
      try {
        const bound = await pending;
        await bound.binding.close();
        bound.ledger.close();
        this.bindings.delete(id);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Remote execution cleanup remains unverified.");
  }
}

type GovernedOptions = Pick<RemoteToolRuntimeOptions, "host" | "permissionProfile" | "capabilitiesConfig" | "protectedLocations" | "pathGuard" | "stateDirectory" | "deviceDirectory" | "extensionDirectories" | "installerBinDirectories">;

async function createGovernedBinding(
  options: GovernedOptions, workspacePath: string, runId: string, allowed: ReadonlySet<string>,
  onPartial: (binding: ExecutionHostRunBinding, ledger?: SqliteToolLedger) => void, localMcpDepth?: number,
): Promise<BoundRemote> {
  const capabilityContract = await createRunnerCapabilityContract(options.capabilitiesConfig);
  const binding = await options.host.bindRun({ runId, permissionProfile: options.permissionProfile,
    capabilityContract, capabilitiesConfig: options.capabilitiesConfig,
    ...(localMcpDepth !== undefined ? { localMcpDepth } : {}) });
  let ledger: SqliteToolLedger | undefined;
  try {
    const recovery = await binding.recover({ maxRecords: 1_024, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS });
    if (recovery.subprocess.some((entry) => entry.state !== "cleaned") ||
      recovery.streaming.outcomes.some((entry) => entry.disposition !== "cleaned") ||
      recovery.streaming.sessionOutcomes.some((entry) => !["reattached", "cleanup_released"].includes(entry.disposition)) ||
      recovery.streaming.lateCleanupFailures.length > 0 || recovery.isolation.some((entry) => entry.blockers.length > 0)) {
      throw new Error("Remote execution recovery is blocked.");
    }
    ledger = new SqliteToolLedger(join(binding.runRoot, "remote-tool-ledger.sqlite"));
    const pathGuard = remotePathGuardFor(options);
    const broker = new ToolBroker({ permissionProfile: localMcpDepth === undefined ? options.permissionProfile : "project", workspacePath,
      git: binding.git, artifacts: options.host.artifacts, executionGrants: binding.executionGrants, ledger, pathGuard,
      ...(localMcpDepth !== undefined ? { approve: async (request) => !request.outsideWorkspace } : {}) });
    const tools = [
      ...createFilesystemTools({ artifacts: options.host.artifacts, pathGuard }), ...createGitTools(binding.git),
      ...createProcessTools({ execution: binding.commandExecution }), ...createManagedProcessTools(binding.managedProcesses),
      ...createImageTools({ artifacts: options.host.artifacts, pathGuard }),
    ];
    for (const tool of tools) if (allowed.has(tool.definition.name) && tool.definition.lifecycle !== true) broker.register(tool);
    return { binding, broker, ledger, pathGuard };
  } catch (error) {
    try { await binding.close(); ledger?.close(); }
    catch (cleanup) {
      onPartial(binding, ledger);
      throw new AggregateError([error, cleanup], "Remote binding cleanup remains unverified.");
    }
    throw error;
  }
}

const LOCAL_TOOLS: Readonly<Record<string, string>> = Object.freeze({
  files_read: "fs.read", files_list: "fs.list", files_search: "fs.search", files_write: "fs.write",
  files_patch: "fs.patch", files_move: "fs.move", files_delete: "fs.delete",
  process_start: "process.start", process_run: "process.run", process_read_output: "process.read_output",
  process_write_stdin: "process.write_stdin", process_signal: "process.signal", process_list: "process.list",
  git_status: "git.status", git_diff: "git.diff", git_log: "git.log", image_inspect: "image.inspect",
});
const LOCAL_ALLOWED = new Set(roleAllowList("local_mcp", "local_mcp"));

export interface LocalMcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown };
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean; readonly idempotentHint: boolean; readonly openWorldHint: boolean };
}

export interface LocalMcpOwner {
  readonly identity: LocalMcpIdentity;
  readonly runId: string;
  readonly sessionId: string;
  readonly depth: number;
}

export interface LocalMcpPolicyOptions {
  readonly policy?: () => Readonly<RemoteDevicePolicy>;
  readonly policyIdentity?: () => VerifiedRemoteIdentity | undefined;
  readonly auditStore?: RemoteAuditStore;
}

export function createLocalMcpOwner(depth: number): LocalMcpOwner {
  return Object.freeze({ identity: Object.freeze({ kind: "local_mcp", localClientId: `local-mcp-${randomUUID()}` }),
    runId: `local-mcp-run-${randomUUID()}`, sessionId: `local-mcp-session-${randomUUID()}`, depth });
}

/** One socket-owned identity and one exact managed-process owner. */
export class LocalMcpToolSession {
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private bound?: Promise<BoundRemote>;
  private partial?: { binding: ExecutionHostRunBinding; ledger?: SqliteToolLedger };
  private closed = false;
  private closing?: Promise<void>;
  private readonly pathGuard: RemotePathGuard;

  constructor(private readonly options: GovernedOptions & LocalMcpPolicyOptions & { workspacePath: string }, readonly owner: LocalMcpOwner) {
    if (!isAbsolute(options.workspacePath)) throw new Error("Local MCP workspace must be absolute.");
    this.pathGuard = remotePathGuardFor(options);
  }

  private binding(): Promise<BoundRemote> {
    if (this.closed) throw new Error("Local MCP session is revoked.");
    if (this.partial) throw new Error("Local MCP execution cleanup remains unverified.");
    return this.bound ??= createGovernedBinding({ ...this.options, pathGuard: this.pathGuard }, resolve(this.options.workspacePath), this.owner.runId, LOCAL_ALLOWED,
      (binding, ledger) => { this.partial = { binding, ledger }; }, this.owner.depth);
  }

  async recover(): Promise<void> { await this.binding(); }

  async pathAuditRecords(): Promise<readonly import("./remote-path-guard.js").RemotePathAuditRecord[]> {
    return (await this.binding()).pathGuard.auditRecords();
  }

  async list(): Promise<LocalMcpToolDefinition[]> {
    const bound = await this.binding();
    if (this.closed) throw new Error("Local MCP session is revoked.");
    const definitions = new Map(bound.broker.definitions().map((definition) => [definition.name, definition]));
    return Object.entries(LOCAL_TOOLS).map(([name, internal]) => {
      const definition = definitions.get(internal);
      if (!definition) throw new Error(`Local MCP tool ${name} is unavailable.`);
      const schema = structuredClone(definition.inputSchema) as { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
      if (name === "process_read_output") schema.properties = { ...schema.properties, view: { enum: ["output", "snapshot"] } };
      if (name === "image_inspect") {
        delete schema.properties?.artifactHash;
        schema.required = ["path"];
      }
      if (MUTATING_TOOLS.has(internal)) {
        schema.properties = { ...schema.properties, idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" } };
        schema.required = [...(schema.required ?? []), "idempotencyKey"];
      }
      const mutating = MUTATING_TOOLS.has(internal);
      const readOnly = definition.readOnly && internal !== "fs.search";
      const description = name === "image_inspect" ? "Inspect an image file in the project and return its bounded visual content." : definition.description;
      return { name, description: description + (mutating ? " The local call completes inline; job APIs are unavailable." : "") + " Artifact retrieval is not available.", inputSchema: schema,
        annotations: { readOnlyHint: readOnly, destructiveHint: mutating, idempotentHint: readOnly, openWorldHint: internal.startsWith("process.") && mutating } };
    });
  }

  invoke(name: string, input: unknown): Promise<ToolResult> {
    const work = this.pathGuard.withWorkspaceScope(resolve(this.options.workspacePath), () => true, async (scope) => {
      const identity = this.options.policyIdentity?.();
      let result: ToolResult;
      try { result = await this.invokeChecked(name, input); }
      catch (error) {
        this.options.auditStore?.recordTool({ role: "local_mcp", ...(identity ?? {}), clientId: this.owner.identity.localClientId,
          toolName: safeToolName(LOCAL_TOOLS[name] ?? "unknown", LOCAL_ALLOWED), decision: "failed", outcomeCode: "exception",
          ...(scope.lastDenied ? { pathCategory: scope.lastDenied.pathCategory } : {}) }, this.currentPolicy().audit);
        throw error;
      }
      this.options.auditStore?.recordTool({ role: "local_mcp", ...(identity ?? {}), clientId: this.owner.identity.localClientId,
        toolName: safeToolName(LOCAL_TOOLS[name] ?? "unknown", LOCAL_ALLOWED), ...auditOutcome(result),
        ...(scope.lastDenied ? { pathCategory: scope.lastDenied.pathCategory } : {}) }, this.currentPolicy().audit);
      return result;
    });
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }

  private async invokeChecked(name: string, input: unknown): Promise<ToolResult> {
    let callId = `local-call-${randomUUID()}`;
    const internal = Object.hasOwn(LOCAL_TOOLS, name) ? LOCAL_TOOLS[name] : undefined;
    if (this.closed) return failure(callId, name, "principal_revoked", "Local MCP session is revoked.");
    if (!internal) return failure(callId, name, "tool_unavailable", "Tool is unavailable to local MCP.");
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure(callId, name, "invalid_arguments", "Tool arguments must be an object.");
    let args: Record<string, unknown>;
    try { args = structuredClone(input) as Record<string, unknown>; } catch { return failure(callId, name, "invalid_arguments", "Tool arguments cannot be copied safely."); }
    if (Object.keys(args).some((key) => AUTHORITY_ARGUMENTS.has(key) || ["root", "repoPath", "deviceId"].includes(key))) return failure(callId, name, "invalid_arguments", "Tool arguments cannot supply Runner authority.");
    if (internal === "image.inspect" && Object.hasOwn(args, "artifactHash")) return failure(callId, name, "tool_unavailable", "Artifact-hash inspection is unavailable.");
    if (args.env && typeof args.env === "object" && Object.keys(args.env).some((key) => key.toUpperCase() === "AIBOARD_MCP_DEPTH")) return failure(callId, name, "invalid_arguments", "MCP ancestry is Runner-owned.");
    let refusal = policyRefusal(this.currentPolicy(), internal, args);
    if (refusal) return failure(callId, name, refusal.code, refusal.message);
    if (MUTATING_TOOLS.has(internal)) {
      if (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotencyKey)) return failure(callId, name, "invalid_arguments", "A valid idempotencyKey is required.");
      callId = `local-key-${createHash("sha256").update(args.idempotencyKey).digest("hex")}`;
      delete args.idempotencyKey;
    }
    let target = internal;
    if (name === "process_read_output" && args.view !== undefined) {
      if (args.view !== "output" && args.view !== "snapshot") return failure(callId, name, "invalid_arguments", "Invalid process output view.");
      if (args.view === "snapshot") {
        if (Object.keys(args).some((key) => key !== "view" && key !== "processId")) return failure(callId, name, "invalid_arguments", "Snapshot view only accepts processId.");
        target = "process.poll";
      }
      delete args.view;
    }
    try {
      args = await constrainArguments(this.pathGuard, this.options.workspacePath, this.currentPolicy(), internal, args, `local_mcp:${this.owner.identity.localClientId}`, true) as Record<string, unknown>;
      freezeArguments(args);
      const bound = await this.binding();
      if (this.closed || this.controller.signal.aborted) return failure(callId, name, "principal_revoked", "Local MCP session is revoked.");
      refusal = policyRefusal(this.currentPolicy(), internal, args);
      if (refusal) return failure(callId, name, refusal.code, refusal.message);
      args = await constrainArguments(this.pathGuard, this.options.workspacePath, this.currentPolicy(), internal, args, `local_mcp:${this.owner.identity.localClientId}`, true) as Record<string, unknown>;
      if (this.closed || this.controller.signal.aborted) return failure(callId, name, "principal_revoked", "Local MCP session is revoked.");
      const definition = bound.broker.definitions().find((item) => item.name === target);
      const properties = definition?.inputSchema.properties;
      if (!properties || typeof properties !== "object" || Object.keys(args).some((key) => !Object.hasOwn(properties, key))) {
        return failure(callId, name, "invalid_arguments", "Unknown tool argument.");
      }
      return await bound.broker.invoke({ type: "tool_call", callId, name: target, arguments: args }, {
        runId: this.owner.runId, sessionId: this.owner.sessionId, actor: { role: "local_mcp", id: this.owner.identity.localClientId },
        workspacePath: resolve(this.options.workspacePath), signal: this.controller.signal, ...(target === "image.inspect" ? { imageInput: true } : {}),
      });
    } catch (error) {
      if (this.closed) return failure(callId, name, "principal_revoked", "Local MCP session is revoked.");
      if (error instanceof RemotePathDeniedError) return failure(callId, name, error.code, error.message);
      return failure(callId, name, "tool_refused", error instanceof Error ? error.message : "Tool refused.");
    }
  }

  private currentPolicy(): Readonly<RemoteDevicePolicy> { return this.options.policy?.() ?? DEFAULT_REMOTE_DEVICE_POLICY; }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const work = this.closeOnce();
    this.closing = work;
    void work.finally(() => { if (this.closing === work) this.closing = undefined; }).catch(() => undefined);
    return work;
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    await Promise.allSettled([...this.active]);
    const failures: unknown[] = [];
    if (this.bound) {
      let bound: BoundRemote | undefined;
      try { bound = await this.bound; } catch { this.bound = undefined; }
      if (bound) {
        try { await bound.binding.close(); bound.ledger.close(); this.bound = undefined; }
        catch (error) { failures.push(error); }
      }
    }
    if (this.partial) {
      try { await this.partial.binding.close(); this.partial.ledger?.close(); this.partial = undefined; }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Local MCP execution cleanup remains unverified.");
  }
}

function policyRefusal(policy: Readonly<RemoteDevicePolicy>, name: string, args: unknown, approvalGranted = false): { code: string; message: string } | undefined {
  if (policy.readOnly && isMutating(name, args)) {
    return { code: "permission_denied", message: "Device policy is read-only." };
  }
  if (!policy.shell && SHELL_TOOLS.has(name)) return { code: "permission_denied", message: "Device policy disables process launch and input." };
  if (policy.approvals && APPROVAL_TOOLS.has(name) && !approvalGranted) return { code: "approval_required", message: "A local command approval is required." };
  return undefined;
}

async function constrainArguments(
  guard: RemotePathGuard, workspace: string, policy: Readonly<RemoteDevicePolicy>, name: string,
  value: unknown, principal: string, localProject = false,
): Promise<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const args = value as Record<string, unknown>;
  const context = { toolName: name, principal };
  if ((policy.onlyHere || localProject) && (name.startsWith("fs.") || name === "image.inspect")) {
    const mode = name === "fs.delete" ? "delete" : name === "fs.write" || name === "fs.patch" || name === "fs.move" ? "write" : "read";
    for (const key of ["path", "source", "destination"]) {
      if (typeof args[key] === "string") await guard.assertAllowed(resolve(workspace, args[key] as string), mode, context);
    }
  }
  if ((policy.onlyHere || localProject) && (name === "process.start" || name === "process.run")) {
    if (args.cwd === undefined || typeof args.cwd === "string") {
      await guard.assertWithinWorkspace(resolve(workspace, typeof args.cwd === "string" ? args.cwd : "."), workspace, context);
      if (policy.onlyHere) return Object.freeze({ ...args, cwd: "." });
    }
  }
  return value;
}

function auditEnabled(principals: RemotePrincipalStore, identity: VerifiedRemoteIdentity): boolean {
  try { return principals.policy(identity).audit; } catch { return true; }
}

function safeToolName(name: string, allowed: ReadonlySet<string>): string {
  return allowed.has(name) ? name : "unknown";
}

function auditOutcome(result: ToolResult): { decision: "allowed" | "denied" | "refused" | "failed"; reasonCode?: string; outcomeCode: string } {
  if (!result.isError) return { decision: "allowed", outcomeCode: "ok" };
  const code = result.error?.code ?? "tool_error";
  const decision = ["path_denied", "outside_only_here", "permission_denied", "principal_revoked"].includes(code) ? "denied"
    : ["tool_unavailable", "invalid_arguments", "approval_required", "effect_admission_required", "tool_refused"].includes(code) ? "refused" : "failed";
  return { decision, reasonCode: code, outcomeCode: "error" };
}

function isMutating(name: string, args: unknown): boolean {
  return MUTATING_TOOLS.has(name) || (name === "fs.search" && args !== null && typeof args === "object" &&
    "cancel" in args && args.cancel === true);
}

function freezeArguments(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new Error("Cyclic tool arguments are invalid.");
    seen.add(value);
    for (const child of Object.values(value)) freezeArguments(child, seen);
    Object.freeze(value);
  }
  return value;
}

function failure(callId: string, toolName: string, code: string, message: string): ToolResult {
  return { callId, toolName, content: [{ type: "text", text: message }], isError: true, error: { code, message } };
}
