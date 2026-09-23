/** Closed recovery commands and redacted durable facts. No model or OS effects. */
import { createHash } from "node:crypto";
import { types } from "node:util";
import type { ExecutionLifecycleAttestation, ExecutionLifecycleScope, ExecutionSafetyCapabilities, ExecutionSafetyCapabilityName, ProcessCleanupStatus } from "./execution-safety-contracts.js";

export const EXCEPTIONAL_PROCESS_STATES = ["orphaned", "identity_mismatch", "backend_unavailable", "outcome_unknown"] as const;
export type RecoveryAction = "inspect" | "terminate" | "remove_owned_artifact";
export interface RecoveryScope {
  kind: "subprocess" | "streaming"; runId: string; invocationId: string; logicalProcessId: string;
  taskId?: string; sessionId?: string; revision: number; ownerId: string; fencingToken: number;
  rootPid?: number; state: string; backendIdentity: string; birthFingerprint: string;
}
export interface RecoveryTarget {
  scope: RecoveryScope; owned: boolean; pendingEffects: boolean;
  capabilities: ExecutionSafetyCapabilities; cleanup: ProcessCleanupStatus;
  /** Explicit lifecycle evidence; absent only on legacy/ambiguous ownership. */
  lifecycle?: ExecutionLifecycleAttestation;
  /** Original subprocess requirement when durably available. */
  requiredLifecycleScope?: ExecutionLifecycleScope;
  backend?: Readonly<{ backendId: string; implementationDigest: string; providerId?: string }>;
  leaseExpiresAt?: string;
  requiredCapabilities?: readonly ExecutionSafetyCapabilityName[];
  /** Redacted aggregate only; no output content or artifact path is projected here. */
  output?: Readonly<{ totalBytes: number; truncated: boolean; lossyBytes: number }>;
}
export interface RecoveryProposal {
  version: 1; proposalId: string; callId: string; scope: RecoveryScope; requestedAction: RecoveryAction;
  targetScope: readonly string[]; requestedCapabilities: readonly ExecutionSafetyCapabilityName[];
  expiresAt: string; rationale: string;
}
export type RecoveryState = "proposed" | "user_decision_required" | "authorized" | "executing" | "executed" | "rejected" | "failed" | "outcome_unknown";
export type RecoveryReason = "submitted" | "validated" | "destructive_requires_user" | "user_approved" | "user_denied" |
  "scope_changed" | "expired" | "execution_started" | "inspection_completed" | "cleanup_verified" |
  "effect_failed" | "effect_outcome_unknown" | "resolved_by_verified_cleanup" | "model_failed";
export interface RecoveryAuditRecord extends Omit<RecoveryProposal, "rationale"> {
  proposalFingerprint: string; commandFingerprint: string; argumentsFingerprint: string; rationaleFingerprint: string;
  createdAt: string; updatedAt: string; state: RecoveryState; reason: RecoveryReason; attemptId?: string;
  observation?: "running" | "exited" | "identity_mismatch" | "outcome_unknown";
  cleanupState?: ProcessCleanupStatus["state"];
}
export class ProcessRecoveryError extends Error {
  constructor(readonly code: string) { super(RECOVERY_ERROR_MESSAGES[code] ?? "Exceptional recovery was refused."); this.name = "ProcessRecoveryError"; }
}
const RECOVERY_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  invalid_recovery_proposal: "Recovery proposal is not a supported closed command.",
  routine_recovery_forbidden: "Routine process lifecycle never accepts AI recovery commands.",
  recovery_scope_mismatch: "Recovery proposal no longer matches the exact recorded process and call.",
  recovery_expired: "Recovery proposal has expired or its deadline is invalid.",
  recovery_approval_required: "This exact destructive recovery proposal requires a local-user decision.",
  recovery_identity_unavailable: "A complete process birth and backend identity could not be verified.",
  recovery_ownership_unavailable: "The exact process ownership lease is not available to this Runner.",
  recovery_outcome_unknown: "An earlier recovery effect has an unresolved outcome; it will not be replayed.",
  recovery_capability_unavailable: "The required semantic recovery capability is not enforced.",
  recovery_action_unsupported: "No trusted ownership recipe exists for that recovery action.",
  recovery_model_failed: "The exceptional proposal generator failed; no recovery command was executed.",
  recovery_not_found: "Recovery proposal does not exist for this run.",
});
export function recoveryFingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
export function recoveryScope(target: RecoveryTarget): RecoveryScope { return parseRecoveryScope(target.scope); }
export function sameRecoveryScope(left: RecoveryScope, right: RecoveryScope): boolean {
  // Never PID-only: birth, backend, lease fence and every invocation owner matter.
  return recoveryFingerprint(left) === recoveryFingerprint(right);
}
export function sameRecoveryIdentity(left: RecoveryScope, right: RecoveryScope): boolean {
  const stable = (scope: RecoveryScope) => ({
    kind: scope.kind, runId: scope.runId, invocationId: scope.invocationId,
    logicalProcessId: scope.logicalProcessId, taskId: scope.taskId, sessionId: scope.sessionId,
    rootPid: scope.rootPid, backendIdentity: scope.backendIdentity,
    birthFingerprint: scope.birthFingerprint,
  });
  return recoveryFingerprint(stable(left)) === recoveryFingerprint(stable(right));
}
export function isExceptionalProcessState(state: string): boolean {
  return (EXCEPTIONAL_PROCESS_STATES as readonly string[]).includes(state);
}
const scopeKeys = ["kind", "runId", "invocationId", "logicalProcessId", "taskId", "sessionId", "revision", "ownerId", "fencingToken", "rootPid", "state", "backendIdentity", "birthFingerprint"];
export function parseRecoveryScope(value: unknown): RecoveryScope {
  const p = closed(value, scopeKeys);
  if (p.kind !== "subprocess" && p.kind !== "streaming") invalid();
  for (const k of ["runId", "invocationId", "logicalProcessId", "ownerId", "state", "backendIdentity", "birthFingerprint"]) text(p[k]);
  for (const k of ["taskId", "sessionId"]) if (p[k] !== undefined) text(p[k]);
  if (!Number.isSafeInteger(p.revision) || (p.revision as number) < 0 || !Number.isSafeInteger(p.fencingToken) || (p.fencingToken as number) < 1) invalid();
  if (p.rootPid !== undefined && (!Number.isSafeInteger(p.rootPid) || (p.rootPid as number) < 1)) invalid();
  return Object.freeze({ ...p }) as unknown as RecoveryScope;
}
const proposalKeys = ["version", "proposalId", "callId", "scope", "requestedAction", "targetScope", "requestedCapabilities", "expiresAt", "rationale"];
const capabilities = ["tree_termination", "crash_cleanup", "verified_emptiness", "write_confinement"];
export function parseRecoveryProposal(value: unknown): RecoveryProposal {
  const p = closed(value, proposalKeys);
  if (p.version !== 1) invalid();
  text(p.proposalId); text(p.callId); text(p.rationale, 4096);
  if (!["inspect", "terminate", "remove_owned_artifact"].includes(p.requestedAction as string)) invalid();
  if (!Array.isArray(p.targetScope) || p.targetScope.length < 1 || p.targetScope.length > 16) invalid();
  const targets = p.targetScope.map(v => text(v));
  if (!Array.isArray(p.requestedCapabilities) || p.requestedCapabilities.length > 4 || new Set(p.requestedCapabilities).size !== p.requestedCapabilities.length) invalid();
  if (p.requestedCapabilities.some(v => !capabilities.includes(v as string))) invalid();
  date(p.expiresAt);
  return Object.freeze({ ...p, scope: parseRecoveryScope(p.scope), targetScope: Object.freeze(targets),
    requestedCapabilities: Object.freeze([...p.requestedCapabilities]) }) as unknown as RecoveryProposal;
}
export function makeRecoveryAudit(proposal: RecoveryProposal, at: string): RecoveryAuditRecord {
  const { rationale, ...safe } = proposal;
  const fingerprints = { commandFingerprint: recoveryFingerprint(proposal.requestedAction),
    argumentsFingerprint: recoveryFingerprint({ targetScope: proposal.targetScope, requestedCapabilities: proposal.requestedCapabilities }),
    rationaleFingerprint: recoveryFingerprint(rationale) };
  return { ...safe, ...fingerprints, proposalFingerprint: recoveryFingerprint({ ...safe, rationaleFingerprint: fingerprints.rationaleFingerprint }),
    createdAt: at, updatedAt: at, state: "proposed", reason: "submitted" };
}
export function parseRecoveryAuditRecord(value: unknown): RecoveryAuditRecord {
  const p = closed(value, [...proposalKeys.filter(k => k !== "rationale"), "proposalFingerprint", "commandFingerprint", "argumentsFingerprint", "rationaleFingerprint", "createdAt", "updatedAt", "state", "reason", "attemptId", "observation", "cleanupState"]);
  const proposal = parseRecoveryProposal(Object.fromEntries(proposalKeys.map(k => [k, k === "rationale" ? "redacted" : p[k]])));
  for (const k of ["proposalFingerprint", "commandFingerprint", "argumentsFingerprint", "rationaleFingerprint"])
    if (typeof p[k] !== "string" || !/^[a-f0-9]{64}$/.test(p[k] as string)) invalid();
  date(p.createdAt); date(p.updatedAt);
  if (!["proposed", "user_decision_required", "authorized", "executing", "executed", "rejected", "failed", "outcome_unknown"].includes(p.state as string)) invalid();
  if (!["submitted", "validated", "destructive_requires_user", "user_approved", "user_denied", "scope_changed", "expired", "execution_started", "inspection_completed", "cleanup_verified", "effect_failed", "effect_outcome_unknown", "resolved_by_verified_cleanup", "model_failed"].includes(p.reason as string)) invalid();
  if (p.attemptId !== undefined) text(p.attemptId);
  if (p.observation !== undefined && !["running", "exited", "identity_mismatch", "outcome_unknown"].includes(p.observation as string)) invalid();
  if (p.cleanupState !== undefined && !["not_required", "pending", "verified_empty", "failed"].includes(p.cleanupState as string)) invalid();
  const { rationale: _r, ...safe } = proposal;
  if (p.commandFingerprint !== recoveryFingerprint(p.requestedAction) ||
      p.argumentsFingerprint !== recoveryFingerprint({ targetScope: p.targetScope, requestedCapabilities: p.requestedCapabilities }) ||
      p.proposalFingerprint !== recoveryFingerprint({ ...safe, rationaleFingerprint: p.rationaleFingerprint })) invalid();
  return Object.freeze({ ...p, scope: proposal.scope, targetScope: proposal.targetScope,
    requestedCapabilities: proposal.requestedCapabilities }) as unknown as RecoveryAuditRecord;
}
export function validateRecoveryTransition(prior: RecoveryAuditRecord | undefined, next: RecoveryAuditRecord, actor: { role: string; id: string }, at: string): void {
  const runner = actor.role === "runner" && actor.id === "process-recovery";
  const user = actor.role === "user" && actor.id === "local-user";
  if (next.updatedAt !== at || Date.parse(next.createdAt) > Date.parse(at)) invalid();
  if (!prior) { if (!runner || next.state !== "proposed" || next.reason !== "submitted" || next.createdAt !== at) invalid(); return; }
  const mutable = ["state", "reason", "updatedAt", "attemptId", "observation", "cleanupState"];
  const immutable = (r: RecoveryAuditRecord) => Object.fromEntries(Object.entries(r).filter(([k]) => !mutable.includes(k)));
  if (recoveryFingerprint(immutable(prior)) !== recoveryFingerprint(immutable(next)) || Date.parse(at) < Date.parse(prior.updatedAt)) invalid();
  const transitions: Record<RecoveryState, readonly RecoveryState[]> = {
    proposed: ["authorized", "user_decision_required", "rejected", "failed"], user_decision_required: ["authorized", "rejected"],
    authorized: ["executing", "rejected"], executing: ["executed", "failed", "outcome_unknown", "rejected"],
    executed: [], rejected: [], failed: [], outcome_unknown: ["rejected"],
  };
  if (!transitions[prior.state].includes(next.state)) invalid();
  const approval = prior.state === "user_decision_required";
  if (approval ? (!user && !(runner && next.state === "rejected")) : !runner) invalid();
  if (next.state === "authorized" && ((next.requestedAction !== "inspect" && (!user || next.reason !== "user_approved")) || Date.parse(at) >= Date.parse(next.expiresAt))) invalid();
  if (next.state === "user_decision_required" && (next.requestedAction !== "terminate" || next.reason !== "destructive_requires_user")) invalid();
  if (next.state === "executing" && (!next.attemptId || prior.attemptId || next.reason !== "execution_started" || Date.parse(at) >= Date.parse(next.expiresAt))) invalid();
  if (prior.attemptId && next.attemptId !== prior.attemptId) invalid();
  if (prior.state === "outcome_unknown" && (next.state !== "rejected" || next.reason !== "resolved_by_verified_cleanup" || next.cleanupState !== "verified_empty")) invalid();
  if (next.state === "executed" && (next.requestedAction === "inspect" ? next.reason !== "inspection_completed" : next.reason !== "cleanup_verified" || next.cleanupState !== "verified_empty")) invalid();
}
export function recoveryBlocksRun(records: Readonly<Record<string, RecoveryAuditRecord>> | undefined): boolean {
  return Object.values(records ?? {}).some(r => r.requestedAction !== "inspect" &&
    (["user_decision_required", "authorized", "executing", "outcome_unknown"].includes(r.state)));
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function invalid(): never { throw new ProcessRecoveryError("invalid_recovery_proposal"); }
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) invalid();
  return value;
}
function date(value: unknown): void {
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) invalid();
}
