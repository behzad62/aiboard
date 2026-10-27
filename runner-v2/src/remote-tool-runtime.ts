import { randomUUID } from "node:crypto";
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
import { RemotePrincipalStore, type RemoteDevicePolicy, type RemotePrincipal, type VerifiedRemoteIdentity } from "./remote-principal.js";
import { SqliteToolLedger } from "./sqlite-tool-ledger.js";
import { ToolBroker } from "./tool-broker.js";

export interface RemoteToolRuntimeOptions {
  readonly host: ExecutionHost;
  readonly principals: RemotePrincipalStore;
  /** Trusted local configuration, never copied from tool arguments. */
  readonly workspacePath: string;
  readonly permissionProfile: PermissionProfile;
  readonly capabilitiesConfig: RunnerCapabilitiesConfig;
  /** Runner-owned R2 admission, supplied only by trusted composition after S1. */
  readonly admitEffect?: (request: Readonly<{
    principal: RemotePrincipal; callId: string; toolName: string; workspacePath: string; arguments: unknown;
  }>) => Promise<boolean>;
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

  invoke(identity: VerifiedRemoteIdentity, name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const callId = `remote-call-${randomUUID()}`;
    if (this.closing) return Promise.resolve(failure(callId, name, "runtime_closed", "Remote runtime is closing."));
    let snapshot: unknown;
    try { snapshot = freezeArguments(structuredClone(args)); }
    catch { return Promise.resolve(failure(callId, name, "invalid_arguments", "Tool arguments cannot be copied safely.")); }
    const work = this.invokeChecked(identity, name, snapshot, callId, signal);
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }

  private async invokeChecked(identity: VerifiedRemoteIdentity, name: string, args: unknown, callId: string, signal?: AbortSignal): Promise<ToolResult> {
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
    if (isMutating(name, args)) {
      if (!await this.options.admitEffect!({ principal, callId, toolName: name, workspacePath: this.workspacePath, arguments: args })) {
        return failure(callId, name, "effect_admission_required", "Durable remote effect admission is unavailable.");
      }
      principal = this.options.principals.find(identity)!;
      if (!principal || principal.revoked) return failure(callId, name, "principal_revoked", "Remote principal is revoked.");
      refusal = policyRefusal(this.options.principals.policy(identity), name, args);
      if (refusal) return failure(callId, name, refusal.code, refusal.message);
    }
    if (this.closing || signal?.aborted) return failure(callId, name, "tool_cancelled", "Remote invocation was cancelled.");
    return await bound.broker.invoke({ type: "tool_call", callId, name, arguments: args }, {
      runId: principal.runId, sessionId: principal.sessionId,
      actor: { role: "remote", id: principal.principalId }, workspacePath: this.workspacePath,
      ...(signal ? { signal } : {}),
    });
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
    const capabilityContract = await createRunnerCapabilityContract(this.options.capabilitiesConfig);
    const binding = await this.options.host.bindRun({ runId: principal.runId,
      permissionProfile: this.options.permissionProfile, capabilityContract,
      capabilitiesConfig: this.options.capabilitiesConfig });
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
      const broker = new ToolBroker({ permissionProfile: this.options.permissionProfile,
        workspacePath: this.workspacePath, git: binding.git, artifacts: this.options.host.artifacts,
        executionGrants: binding.executionGrants, ledger });
      const tools = [
        ...createFilesystemTools({ artifacts: this.options.host.artifacts }),
        ...createGitTools(binding.git),
        ...createProcessTools({ execution: binding.commandExecution }),
        ...createManagedProcessTools(binding.managedProcesses),
        ...createImageTools({ artifacts: this.options.host.artifacts }),
      ];
      for (const tool of tools) {
        if (ALLOWED_TOOLS.has(tool.definition.name) && tool.definition.lifecycle !== true) broker.register(tool);
      }
      return { binding, broker, ledger };
    } catch (error) {
      try { await binding.close(); ledger?.close(); }
      catch (cleanup) {
        this.partialBindings.set(principal.principalId, { binding, ledger });
        throw new AggregateError([error, cleanup], "Remote binding cleanup remains unverified.");
      }
      throw error;
    }
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
