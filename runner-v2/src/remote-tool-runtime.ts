import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
import { RemotePrincipalStore, type LocalMcpIdentity, type RemoteDevicePolicy, type RemotePrincipal, type VerifiedRemoteIdentity } from "./remote-principal.js";
import { SqliteToolLedger } from "./sqlite-tool-ledger.js";
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

  constructor(private readonly options: RemoteToolRuntimeOptions) {
    if (!isAbsolute(options.workspacePath)) throw new Error("Remote workspace must be an absolute local path.");
    this.workspacePath = resolve(options.workspacePath);
  }

  invoke(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal?: AbortSignal, rawRequest?: string): Promise<ToolResult> {
    return this.beginInvocation(identity, name, args, signal, rawRequest);
  }

  async invokeAdmitted(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal: AbortSignal,
    rawRequest: string, jobId: string, beforeBroker?: () => boolean): Promise<RemoteInvocationResult> {
    let brokerInvoked = false;
    const result = await this.beginInvocation(identity, name, args, signal, rawRequest, jobId, () => { brokerInvoked = true; }, beforeBroker);
    return { result, brokerInvoked };
  }

  /** Local principal and device policy are rechecked independently of relay claims. */
  authorizeJob(identity: VerifiedRemoteIdentity, name?: string, args?: unknown): string | undefined {
    const principal = this.options.principals.getOrCreate(identity);
    if (principal.revoked || this.closing) return "unauthorized";
    const policy = this.options.principals.policy(identity);
    if (name?.startsWith("plugin_") && policy.readOnly) return "permission_denied";
    if (name) return policyRefusal(policy, name, args)?.code;
    return undefined;
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
    rawRequest?: string, admittedJobId?: string, onBrokerInvoke?: () => void, beforeBroker?: () => boolean): Promise<ToolResult> {
    const callId = `remote-call-${randomUUID()}`;
    if (this.closing) return Promise.resolve(failure(callId, name, "runtime_closed", "Remote runtime is closing."));
    let snapshot: unknown;
    try { snapshot = freezeArguments(structuredClone(args)); }
    catch { return Promise.resolve(failure(callId, name, "invalid_arguments", "Tool arguments cannot be copied safely.")); }
    const work = this.invokeChecked(identity, name, snapshot, callId, signal, rawRequest, admittedJobId, onBrokerInvoke, beforeBroker);
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }

  private async invokeChecked(identity: VerifiedRemoteIdentity, name: string, args: unknown, callId: string,
    signal?: AbortSignal, rawRequest?: string, admittedJobId?: string, onBrokerInvoke?: () => void, beforeBroker?: () => boolean): Promise<ToolResult> {
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
    let refusal = policyRefusal(this.options.principals.policy(identity), name, args);
    if (refusal) return failure(callId, name, refusal.code, refusal.message);
    if (isMutating(name, args) && !this.options.admitEffect) {
      return failure(callId, name, "effect_admission_required", "Durable remote effect admission is unavailable.");
    }
    const bound = await this.binding(principal);
    // Binding and recovery can await; revocation and narrowing must win before dispatch.
    principal = this.options.principals.find(identity)!;
    if (!principal || principal.revoked) return failure(callId, name, "principal_revoked", "Remote principal is revoked.");
    refusal = policyRefusal(this.options.principals.policy(identity), name, args);
    if (refusal) return failure(callId, name, refusal.code, refusal.message);
    const authorize = (): ToolResult | undefined => {
      const current = this.options.principals.find(identity);
      if (!current || current.revoked) return failure(callId, name, "principal_revoked", "Remote principal is revoked.");
      principal = current;
      const currentRefusal = policyRefusal(this.options.principals.policy(identity), name, args);
      if (currentRefusal) return failure(callId, name, currentRefusal.code, currentRefusal.message);
      if (this.closing || signal?.aborted) return failure(callId, name, "tool_cancelled", "Remote invocation was cancelled.");
      if (beforeBroker && !beforeBroker()) return failure(callId, name, "unauthorized", "Remote authorization changed before dispatch.");
      return undefined;
    };
    const dispatch = async (): Promise<ToolResult> => {
      const denied = authorize();
      if (denied) return denied;
      onBrokerInvoke?.();
      return await bound.broker.invoke({ type: "tool_call", callId, name, arguments: args }, {
        runId: principal.runId, sessionId: principal.sessionId,
        actor: { role: "remote", id: principal.principalId }, workspacePath: this.workspacePath,
        ...(signal ? { signal } : {}),
      });
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
    return await createGovernedBinding(this.options, this.workspacePath, principal.runId, ALLOWED_TOOLS,
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

type GovernedOptions = Pick<RemoteToolRuntimeOptions, "host" | "permissionProfile" | "capabilitiesConfig">;

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
    const broker = new ToolBroker({ permissionProfile: localMcpDepth === undefined ? options.permissionProfile : "project", workspacePath,
      git: binding.git, artifacts: options.host.artifacts, executionGrants: binding.executionGrants, ledger,
      ...(localMcpDepth !== undefined ? { approve: async (request) => !request.outsideWorkspace } : {}) });
    const tools = [
      ...createFilesystemTools({ artifacts: options.host.artifacts }), ...createGitTools(binding.git),
      ...createProcessTools({ execution: binding.commandExecution }), ...createManagedProcessTools(binding.managedProcesses),
      ...createImageTools({ artifacts: options.host.artifacts }),
    ];
    for (const tool of tools) if (allowed.has(tool.definition.name) && tool.definition.lifecycle !== true) broker.register(tool);
    return { binding, broker, ledger };
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

  constructor(private readonly options: GovernedOptions & { workspacePath: string }, readonly owner: LocalMcpOwner) {
    if (!isAbsolute(options.workspacePath)) throw new Error("Local MCP workspace must be absolute.");
  }

  private binding(): Promise<BoundRemote> {
    if (this.closed) throw new Error("Local MCP session is revoked.");
    if (this.partial) throw new Error("Local MCP execution cleanup remains unverified.");
    return this.bound ??= createGovernedBinding(this.options, resolve(this.options.workspacePath), this.owner.runId, LOCAL_ALLOWED,
      (binding, ledger) => { this.partial = { binding, ledger }; }, this.owner.depth);
  }

  async recover(): Promise<void> { await this.binding(); }

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
    const work = this.invokeChecked(name, input);
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
      const paths = internal.startsWith("fs.") ? ["path", "source", "destination"] : internal === "image.inspect" ? ["path"] : internal.startsWith("process.") ? ["cwd"] : [];
      for (const key of paths) if (typeof args[key] === "string") await assertProjectPath(this.options.workspacePath, args[key] as string);
      freezeArguments(args);
      const bound = await this.binding();
      if (this.closed || this.controller.signal.aborted) return failure(callId, name, "principal_revoked", "Local MCP session is revoked.");
      for (const key of paths) if (typeof args[key] === "string") await assertProjectPath(this.options.workspacePath, args[key] as string);
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
      return failure(callId, name, "tool_refused", error instanceof Error ? error.message : "Tool refused.");
    }
  }

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

async function assertProjectPath(workspace: string, path: string): Promise<void> {
  const root = await realpath(workspace);
  const target = resolve(root, path);
  const inside = (candidate: string) => { const part = relative(root, candidate); return part === "" || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
  if (!inside(target)) throw new Error("Path outside the project is unavailable until S1.");
  let current = target;
  for (;;) {
    try { if (!inside(await realpath(current))) throw new Error("Path outside the project is unavailable until S1."); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(current, "..");
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function policyRefusal(policy: Readonly<RemoteDevicePolicy>, name: string, args: unknown): { code: string; message: string } | undefined {
  if (policy.onlyHere && (name.startsWith("fs.") || name === "image.inspect")) {
    return { code: "policy_unavailable", message: "Cwd-only file protection is not available yet." };
  }
  if (policy.readOnly && isMutating(name, args)) {
    return { code: "permission_denied", message: "Device policy is read-only." };
  }
  if (!policy.shell && SHELL_TOOLS.has(name)) return { code: "permission_denied", message: "Device policy disables process launch and input." };
  // Job-bound terminal/dashboard approvals are added after R2. Never treat Full or model input as approval.
  if (policy.approvals && SHELL_TOOLS.has(name)) return { code: "approval_required", message: "A local command approval is required." };
  return undefined;
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
