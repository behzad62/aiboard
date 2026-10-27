/**
 * Browser client for the Runner's /v2/extensions and /v2/chat-sessions endpoints. Lightweight DTOs
 * only: no Runner service code is imported. Secret values are sent once, in a request body, to the
 * Runner credential endpoint and are never stored in the browser or returned by the Runner.
 */
import { NativeRunnerError, type NativeRunnerConnection } from "./runner-v2";

export type ExtensionKind = "skill" | "mcp_server" | "plugin";
export type ExtensionScopeDto = { kind: "user" } | { kind: "project"; projectIdentity: string };
export type ReadinessState =
  | "downloaded" | "installed" | "configured" | "needs_auth" | "authenticated" | "enabled" | "ready"
  | "pending_activation" | "restart_required" | "disabled" | "failed" | "unsupported" | "external";

export interface ExtensionReadinessDto {
  state: ReadinessState;
  checkedAt?: string;
  detail?: string;
  lastError?: { code: string; message: string; at: string };
  components?: Record<string, ReadinessState>;
}

export type ResolvedSourceDto =
  | { type: "local_directory"; path: string; treeDigest: string }
  | { type: "archive"; filename: string; archiveDigest: string; treeDigest: string }
  | { type: "single_file"; filename: string; treeDigest: string }
  | { type: "git"; url: string; requestedRef: string; commit: string; subdirectory?: string; treeDigest: string }
  | { type: "npm"; packageName: string; version: string; integrity?: string }
  | { type: "pypi"; packageName: string; version: string }
  | { type: "executable"; command: string; args: string[]; executableDigest: string }
  | { type: "remote_http"; url: string }
  | { type: "cli_config"; name: string; configDigest: string }
  | { type: "provider_hosted"; url: string }
  | { type: "external_skill"; path: string; digest: string };

export type ExtensionComponentDto =
  | { kind: "skill"; componentId: string; skillName: string; description: string; packagePath: string; digest: string; files: number; allowedTools?: string[]; license?: string; compatibility?: string; warnings: string[] }
  | { kind: "mcp_server"; componentId: string; serverName: string; transport: "stdio" | "streamable_http"; command?: string; args?: string[]; url?: string; environment: { name: string; credentialRef?: string; required: boolean }[]; route: "runner" | "provider_hosted"; schemaDigest?: string; toolNames?: string[]; executableDigest?: string; installRoot?: string; toolApproval?: McpToolPolicy; auth?: "none" | "bearer" | "oauth"; network?: boolean }
  | { kind: "runner_extension"; componentId: string; extensionId: string; packagePath: string; manifestDigest: string };

export interface AccessSummaryDto {
  executesCode: "never" | "on_use" | "at_install_and_on_use";
  network: string[];
  filesystem: string;
  credentials: string[];
  notes: string[];
}

export interface ExtensionItemDto {
  id: string;
  kind: ExtensionKind;
  name: string;
  scope: ExtensionScopeDto;
  provenance: "managed" | "cli" | "external" | "migrated";
  source: ResolvedSourceDto;
  currentVersionId?: string;
  enabled: boolean;
  desiredGeneration: number;
  activeGeneration?: number;
  readiness: ExtensionReadinessDto;
  componentIds: string[];
  credentialRefs: string[];
  previousVersionIds: string[];
  referencedBy: string[];
  installedAt: string;
  updatedAt: string;
  currentVersion?: { versionId: string; version?: string; source: ResolvedSourceDto; createdAt: string; components: ExtensionComponentDto[]; packageDigest?: string; dependencies?: ExtensionDependencyDto[] };
  previousVersions: { versionId: string; version?: string; createdAt: string; source: ResolvedSourceDto }[];
  credentials: { name: string; ref: string; updatedAt: string }[];
}

export interface ExternalItemDto {
  kind: ExtensionKind;
  name: string;
  provenance: "external" | "cli" | "project";
  source: ResolvedSourceDto;
  description?: string;
  detail?: string;
  adoptable?: boolean;
}

export type UserActionDto =
  | { kind: "approve"; reason: string; planDigest: string; summary: AccessSummaryDto }
  | { kind: "choose"; reason: string; options: { id: string; label: string; description?: string }[] }
  | { kind: "credential"; reason: string; names: string[] }
  | { kind: "sign_in"; reason: string; server: string };

export interface ExtensionOperationDto {
  id: string;
  key: string;
  owner: { kind: "ui" } | { kind: "agent"; runId: string; sessionId: string; actorRole: string; actorId: string };
  action: string;
  target: { extensionId?: string; sourceKey?: string; name?: string };
  scope: ExtensionScopeDto;
  planDigest?: string;
  plan?: ExtensionPlanDto;
  authorizationOrigin?: "ui" | "human_message" | "standing_policy";
  stage: string;
  outcome: "running" | "awaiting_user" | "succeeded" | "failed" | "cancelled" | "outcome_unknown" | "rolled_back";
  progress: { stage: string; at: string; note?: string }[];
  userAction?: UserActionDto;
  result?: { extensionId?: string; versionId?: string; generation?: number; readiness?: ExtensionReadinessDto };
  diagnostics: string[];
  createdAt: string;
  updatedAt: string;
}

export interface InstallPolicyDto {
  version: 1;
  humanRequestedSkills: "auto" | "ask";
  humanRequestedExecutable: "trusted_sources" | "ask";
  trustedSources: string[];
}

export interface ExtensionInventoryDto {
  currentGeneration: number;
  projectIdentity: string;
  policy: InstallPolicyDto;
  items: ExtensionItemDto[];
  external: ExternalItemDto[];
  pendingOperations: ExtensionOperationDto[];
}

export type SourceRequestDto =
  | { type: "local_directory"; path: string }
  | { type: "upload"; uploadId: string }
  | { type: "git"; url: string; ref?: string; subdirectory?: string }
  | ({ type: "npm"; packageName: string; version?: string; bin?: string } & McpLaunchDto)
  | ({ type: "pypi"; packageName: string; version?: string; entry?: string } & McpLaunchDto)
  | ({ type: "executable"; command: string } & McpLaunchDto)
  | { type: "remote_http"; url: string; serverName?: string; auth?: "none" | "bearer" | "oauth" };

/** Launch details for a local MCP server. `env` lists variable NAMES; values go to the secure field. */
export interface McpLaunchDto {
  args?: string[];
  env?: string[];
  serverName?: string;
}

export type McpToolPolicy = "all" | "non_destructive";

export interface SourceInspectionDto {
  inspectionId: string;
  sourceKey: string;
  source: ResolvedSourceDto;
  kind: ExtensionKind;
  name?: string;
  version?: string;
  components: ExtensionComponentDto[];
  invalid: { path: string; errors: string[] }[];
  warnings: string[];
  access: AccessSummaryDto;
  requiresExecutableTrust: boolean;
  requiredCredentials: string[];
  /** Plugins: installed skills / MCP servers the bundle uses; they must already be installed. */
  dependencies?: ExtensionDependencyDto[];
  expiresAt: string;
}

export interface ExtensionDependencyDto {
  kind: "skill" | "mcp_server";
  name: string;
}

export interface ExtensionPlanDto {
  planId: string;
  planDigest: string;
  action: string;
  scope: ExtensionScopeDto;
  kind: ExtensionKind;
  name: string;
  version?: string;
  extensionId?: string;
  source?: ResolvedSourceDto;
  components: ExtensionComponentDto[];
  access: AccessSummaryDto;
  requiresExecutableTrust: boolean;
  requiredCredentials: string[];
  warnings: string[];
  expiresAt: string;
}

export type PlanRequestDto =
  | { action: "install" | "update"; inspectionId: string; componentIds?: string[]; scope: "user" | "project"; name?: string }
  | { action: "enable" | "disable" | "remove" | "rollback"; extensionId: string; versionId?: string };

export interface BrowseResultDto {
  path: string;
  parent?: string;
  directories: string[];
  hasSkill: boolean;
  roots?: string[];
}

export function getExtensionInventory(connection: NativeRunnerConnection, signal?: AbortSignal): Promise<ExtensionInventoryDto> {
  return call(connection, "/v2/extensions", { method: "GET", signal });
}

export function inspectExtensionSource(connection: NativeRunnerConnection, source: SourceRequestDto, signal?: AbortSignal): Promise<SourceInspectionDto> {
  return call(connection, "/v2/extensions/inspect", { method: "POST", body: JSON.stringify({ source }), signal });
}

export async function uploadExtensionFile(connection: NativeRunnerConnection, file: File, signal?: AbortSignal): Promise<{ uploadId: string; byteLength: number; digest: string }> {
  return call(connection, `/v2/extensions/uploads?filename=${encodeURIComponent(file.name)}`, {
    method: "POST", body: await file.arrayBuffer(), headers: { "Content-Type": "application/octet-stream" }, signal,
  });
}

export function planExtensionChange(connection: NativeRunnerConnection, plan: PlanRequestDto, signal?: AbortSignal): Promise<ExtensionPlanDto> {
  return call(connection, "/v2/extensions/plans", { method: "POST", body: JSON.stringify(plan), signal });
}

export function applyExtensionPlan(connection: NativeRunnerConnection, plan: Pick<ExtensionPlanDto, "planId" | "planDigest">, key: string, signal?: AbortSignal): Promise<ExtensionOperationDto> {
  return call(connection, "/v2/extensions/operations", { method: "POST", body: JSON.stringify({ planId: plan.planId, planDigest: plan.planDigest, key }), signal });
}

export function listExtensionOperations(connection: NativeRunnerConnection, signal?: AbortSignal): Promise<{ operations: ExtensionOperationDto[] }> {
  return call(connection, "/v2/extensions/operations", { method: "GET", signal });
}

export function approveExtensionOperation(connection: NativeRunnerConnection, operationId: string, planDigest: string): Promise<ExtensionOperationDto> {
  return call(connection, `/v2/extensions/operations/${encodeURIComponent(operationId)}/approve`, { method: "POST", body: JSON.stringify({ planDigest }) });
}

export function declineExtensionOperation(connection: NativeRunnerConnection, operationId: string): Promise<ExtensionOperationDto> {
  return call(connection, `/v2/extensions/operations/${encodeURIComponent(operationId)}/decline`, { method: "POST", body: "{}" });
}

/** The value is sent to the Runner's credential store and nowhere else; the response names it only. */
export function submitExtensionCredential(connection: NativeRunnerConnection, target: string, name: string, value: string): Promise<{ stored: string }> {
  return call(connection, "/v2/extensions/credentials", { method: "POST", body: JSON.stringify({ target, name, value }) });
}

export function revokeExtensionCredentials(connection: NativeRunnerConnection, extensionId: string): Promise<{ revoked: number }> {
  return call(connection, `/v2/extensions/${encodeURIComponent(extensionId)}/credentials/revoke`, { method: "POST", body: "{}" });
}

export function testExtension(connection: NativeRunnerConnection, extensionId: string): Promise<ExtensionReadinessDto> {
  return call(connection, `/v2/extensions/${encodeURIComponent(extensionId)}/test`, { method: "POST", body: "{}" });
}

export function saveInstallPolicy(connection: NativeRunnerConnection, policy: InstallPolicyDto): Promise<InstallPolicyDto> {
  return call(connection, "/v2/extensions/policy", { method: "PUT", body: JSON.stringify({ policy }) });
}

export function browseRunnerFolders(connection: NativeRunnerConnection, path?: string): Promise<BrowseResultDto> {
  return call(connection, `/v2/extensions/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`, { method: "GET" });
}

/** Opens OAuth sign-in for an MCP server: returns the authorization URL to open in a new tab. */
export function beginExtensionSignIn(connection: NativeRunnerConnection, operationOrExtensionId: string): Promise<{ url: string }> {
  return call(connection, `/v2/extensions/${encodeURIComponent(operationOrExtensionId)}/sign-in`, { method: "POST", body: "{}" });
}

export interface ExtensionToolKeyDto { componentId: string; toolName: string }
export interface ExtensionToolInventoryDto { componentId: string; schemaDigest: string; toolNames: string[] }
export interface ExtensionToolPolicyDto {
  version: 1;
  versionId: string;
  toolFilter: { default: "allow" | "deny"; allow: ExtensionToolKeyDto[]; deny: ExtensionToolKeyDto[] };
  remoteExposure: boolean;
  riskLabel: "low" | "elevated" | "high" | "unreviewed";
  reviewed: ExtensionToolInventoryDto[];
}
export interface ExtensionToolPolicyViewDto {
  policy: ExtensionToolPolicyDto;
  discovered: ExtensionToolInventoryDto[];
  currentGeneration: number;
  unsupported: boolean;
}
export function getExtensionToolPolicy(connection: NativeRunnerConnection, extensionId: string): Promise<ExtensionToolPolicyViewDto> {
  return call(connection, "/v2/extensions/" + encodeURIComponent(extensionId) + "/tool-filter-policy", { method: "GET" });
}
export function setExtensionToolPolicy(connection: NativeRunnerConnection, extensionId: string, policy: ExtensionToolPolicyDto): Promise<ExtensionToolPolicyViewDto> {
  return call(connection, "/v2/extensions/" + encodeURIComponent(extensionId) + "/tool-filter-policy", { method: "PUT", body: JSON.stringify({ policy }) });
}

export function getMcpToolPolicy(connection: NativeRunnerConnection, extensionId: string): Promise<{ policy?: McpToolPolicy }> {
  return call(connection, `/v2/extensions/${encodeURIComponent(extensionId)}/tool-policy`, { method: "GET" });
}

export function setMcpToolPolicy(connection: NativeRunnerConnection, extensionId: string, policy: McpToolPolicy): Promise<{ policy: McpToolPolicy }> {
  return call(connection, `/v2/extensions/${encodeURIComponent(extensionId)}/tool-policy`, { method: "PUT", body: JSON.stringify({ policy }) });
}

/** Inspects a command-line (--mcp) server for explicit adoption with its exact launch arguments. */
export function inspectCliMcpAdoption(connection: NativeRunnerConnection, name: string): Promise<SourceInspectionDto> {
  return call(connection, "/v2/extensions/adopt-cli-mcp", { method: "POST", body: JSON.stringify({ name }) });
}

/**
 * Records the browser's provider-hosted remote MCP setting in the Runner inventory (idempotent).
 * The token is never sent: provider-hosted calls keep using the token saved in this browser.
 */
export function recordProviderHostedMcp(connection: NativeRunnerConnection, input: { name: string; url: string; enabled: boolean; hasToken: boolean }): Promise<ExtensionItemDto> {
  return call(connection, "/v2/extensions/migrations/provider-hosted-mcp", { method: "POST", body: JSON.stringify(input) });
}

/** Turns a pasted link or name into a source request (GitHub tree links become pinned Git sources). */
export function sourceFromText(text: string): SourceRequestDto | undefined {
  const value = text.trim();
  if (!value) return undefined;
  const github = value.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.+?))?)?\/?$/);
  if (github) return { type: "git", url: `https://github.com/${github[1]}/${github[2]}`, ...(github[3] ? { ref: github[3] } : {}), ...(github[4] ? { subdirectory: github[4] } : {}) };
  if (/^https:\/\/.+\.git$/i.test(value) || /^https:\/\/(gitlab\.com|bitbucket\.org|codeberg\.org)\//i.test(value)) return { type: "git", url: value };
  if (/^https?:\/\//i.test(value)) return { type: "remote_http", url: value };
  const npm = value.match(/^(?:npm:)?((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  if (npm) return { type: "npm", packageName: npm[1], version: npm[2] };
  const pypi = value.match(/^(?:pypi:)([A-Za-z0-9][A-Za-z0-9._-]*)(?:==([0-9][0-9A-Za-z.!+-]*))?$/);
  if (pypi) return { type: "pypi", packageName: pypi[1], ...(pypi[2] ? { version: pypi[2] } : {}) };
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) return { type: "local_directory", path: value };
  return undefined;
}

export function describeSource(source: ResolvedSourceDto): string {
  switch (source.type) {
    case "local_directory": return source.path;
    case "archive": return `${source.filename} (archive)`;
    case "single_file": return `${source.filename} (single file)`;
    case "git": return `${source.url}${source.subdirectory ? ` › ${source.subdirectory}` : ""} @ ${source.commit.slice(0, 10)}`;
    case "npm": return `npm ${source.packageName}@${source.version}`;
    case "pypi": return `PyPI ${source.packageName}==${source.version}`;
    case "executable": return source.command;
    case "remote_http": return source.url;
    case "cli_config": return `--mcp ${source.name}`;
    case "provider_hosted": return `${source.url} (provider-hosted)`;
    case "external_skill": return source.path;
  }
}

export const READINESS_LABELS: Record<ReadinessState, string> = {
  downloaded: "Downloaded", installed: "Installed", configured: "Configured", needs_auth: "Needs sign-in", authenticated: "Signed in",
  enabled: "Enabled", ready: "Ready", pending_activation: "Pending activation", restart_required: "Restart required",
  disabled: "Disabled", failed: "Failed", unsupported: "Unsupported", external: "Managed elsewhere",
};

// ---- Chat sessions -------------------------------------------------------------------------------

export interface RunnerChatSnapshotDto {
  sessionId: string;
  runtimeId: string;
  status: "idle" | "running" | "failed";
  generation: number;
  transitions: { from: number; to: number; at: string; operationIds: string[]; boundary: string }[];
  messages: { id: string; role: "user" | "assistant"; text: string; at: string; toolCalls?: { name: string; isError?: boolean; errorCode?: string }[] }[];
  operations: ExtensionOperationDto[];
  error?: string;
  updatedAt: string;
}

export function createRunnerChatSession(connection: NativeRunnerConnection, input: { sessionId: string; runtimeId: string }, signal?: AbortSignal): Promise<RunnerChatSnapshotDto> {
  return call(connection, "/v2/chat-sessions", { method: "POST", body: JSON.stringify(input), signal });
}

export function getRunnerChatSession(connection: NativeRunnerConnection, sessionId: string, signal?: AbortSignal): Promise<RunnerChatSnapshotDto> {
  return call(connection, `/v2/chat-sessions/${encodeURIComponent(sessionId)}`, { method: "GET", signal });
}

export function sendRunnerChatMessage(connection: NativeRunnerConnection, sessionId: string, input: { messageId: string; text: string }, signal?: AbortSignal): Promise<RunnerChatSnapshotDto> {
  return call(connection, `/v2/chat-sessions/${encodeURIComponent(sessionId)}/messages`, { method: "POST", body: JSON.stringify(input), signal });
}

export function stopRunnerChatSession(connection: NativeRunnerConnection, sessionId: string): Promise<RunnerChatSnapshotDto> {
  return call(connection, `/v2/chat-sessions/${encodeURIComponent(sessionId)}/stop`, { method: "POST", body: "{}" });
}

async function call<T>(connection: NativeRunnerConnection, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${connection.url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", ...init.headers },
  });
  const data = await response.json().catch(() => ({})) as { error?: string; code?: string } & T;
  if (!response.ok) throw new NativeRunnerError(data.error ?? `Runner request failed (HTTP ${response.status}).`, response.status, data.code);
  return data;
}
