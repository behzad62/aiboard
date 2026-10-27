/**
 * Extension management (skills, MCP servers, plugin bundles): one Runner-owned service shared by the
 * Settings UI and agent management tools. Every record here is validated on load; unknown fields are
 * rejected. Credentials are referenced by id only and never appear in these records.
 */
export const EXTENSION_REGISTRY_SCHEMA_VERSION = 1 as const;

export type ExtensionKind = "skill" | "mcp_server" | "plugin";
export type ExtensionScope = { readonly kind: "user" } | { readonly kind: "project"; readonly projectIdentity: string };

/** Where an installed item came from, pinned to an exact revision/digest. */
export type ResolvedSource =
  | { readonly type: "local_directory"; readonly path: string; readonly treeDigest: string }
  | { readonly type: "archive"; readonly filename: string; readonly archiveDigest: string; readonly treeDigest: string }
  | { readonly type: "single_file"; readonly filename: string; readonly treeDigest: string }
  | { readonly type: "git"; readonly url: string; readonly requestedRef: string; readonly commit: string; readonly subdirectory?: string; readonly treeDigest: string }
  | { readonly type: "npm"; readonly packageName: string; readonly version: string; readonly integrity?: string }
  | { readonly type: "pypi"; readonly packageName: string; readonly version: string }
  | { readonly type: "executable"; readonly command: string; readonly args: readonly string[]; readonly executableDigest: string }
  | { readonly type: "remote_http"; readonly url: string }
  /** Visible, CLI-configured MCP server; managed only after explicit adoption. */
  | { readonly type: "cli_config"; readonly name: string; readonly configDigest: string }
  /** Browser-side provider-hosted remote MCP route (migrated setting); never called through the Runner. */
  | { readonly type: "provider_hosted"; readonly url: string }
  /** Externally discovered skill folder (other tools' directories), listed read-only. */
  | { readonly type: "external_skill"; readonly path: string; readonly digest: string };

export type ReadinessState =
  | "downloaded" | "installed" | "configured" | "needs_auth" | "authenticated" | "enabled" | "ready"
  | "pending_activation" | "restart_required" | "disabled" | "failed" | "unsupported" | "external";

export interface ExtensionReadiness {
  readonly state: ReadinessState;
  readonly checkedAt?: string;
  /** Human-readable, redacted. */
  readonly detail?: string;
  readonly lastError?: Readonly<{ code: string; message: string; at: string }>;
  /** Per-component readiness for bundles and multi-tool servers. */
  readonly components?: Readonly<Record<string, ReadinessState>>;
}

export interface SkillComponent {
  readonly kind: "skill";
  readonly componentId: string;
  readonly skillName: string;
  readonly description: string;
  /** Path of the skill directory inside the package ("" for the package root). */
  readonly packagePath: string;
  readonly digest: string;
  readonly files: number;
  readonly allowedTools?: readonly string[];
  readonly license?: string;
  readonly compatibility?: string;
  readonly warnings: readonly string[];
}

export interface McpServerComponent {
  readonly kind: "mcp_server";
  readonly componentId: string;
  readonly serverName: string;
  readonly transport: "stdio" | "streamable_http";
  /** stdio: structured executable + argument array (authoritative, never shell-interpolated). */
  readonly command?: string;
  readonly args?: readonly string[];
  /** Working directory relative to the package, when the server runs from managed content. */
  readonly packageRelativeCommand?: boolean;
  readonly url?: string;
  /** Environment variable NAMES the server needs; values come only from credential references. */
  readonly environment: readonly Readonly<{ name: string; credentialRef?: string; required: boolean }>[];
  readonly route: "runner" | "provider_hosted";
  readonly schemaDigest?: string;
  readonly toolNames?: readonly string[];
  readonly executableDigest?: string;
  /** Managed npm/Python installs: the AI Board-owned directory holding the pinned dependencies. */
  readonly installRoot?: string;
  /** Digest of the installed entry file and lock metadata, re-verified before every launch. */
  readonly installDigest?: string;
  /** Which advertised tools a model may call without a per-call approval. Annotations are hints only. */
  readonly toolApproval?: "non_destructive" | "all";
  /** Remote servers: how the Runner authenticates. Secrets live in the credential service. */
  readonly auth?: "none" | "bearer" | "oauth";
  /** Whether the server is declared to reach the network (remote servers always do). */
  readonly network?: boolean;
  /** Pinned negotiated protocol version observed at the last readiness check (remote). */
  readonly protocolVersion?: string;
}

export interface RunnerExtensionComponent {
  readonly kind: "runner_extension";
  readonly componentId: string;
  readonly extensionId: string;
  readonly packagePath: string;
  readonly manifestDigest: string;
}

export type ExtensionComponent = SkillComponent | McpServerComponent | RunnerExtensionComponent;

export interface ExtensionVersion {
  readonly versionId: string;
  readonly extensionId: string;
  readonly version?: string;
  readonly source: ResolvedSource;
  /** Content-addressed package directory digest; absent for items with no managed files. */
  readonly packageDigest?: string;
  readonly components: readonly ExtensionComponent[];
  readonly createdAt: string;
  readonly operationId: string;
  /** Plugins: installed extensions this version uses (reference-counted via referencedBy). */
  readonly dependencies?: readonly ExtensionDependency[];
}

export interface ExtensionDependency {
  readonly kind: "skill" | "mcp_server";
  readonly name: string;
}

export interface InstalledExtension {
  /** Stable id: never a display name or filesystem path. */
  readonly id: string;
  readonly kind: ExtensionKind;
  readonly name: string;
  readonly scope: ExtensionScope;
  readonly provenance: "managed" | "cli" | "external" | "migrated";
  readonly source: ResolvedSource;
  readonly currentVersionId?: string;
  readonly enabled: boolean;
  readonly desiredGeneration: number;
  readonly activeGeneration?: number;
  readonly readiness: ExtensionReadiness;
  readonly componentIds: readonly string[];
  /** Identifiers only; values live in the credential service. */
  readonly credentialRefs: readonly string[];
  readonly previousVersionIds: readonly string[];
  /** Bundles that reference this item (shared dependency reference counting). */
  readonly referencedBy: readonly string[];
  readonly installedAt: string;
  readonly updatedAt: string;
  /** Uninstalled items keep a bounded tombstone for audit. */
  readonly removedAt?: string;
}

/** Immutable snapshot of what new runs/sessions see. Never rewritten once published. */
export interface ExtensionGeneration {
  readonly generation: number;
  readonly createdAt: string;
  readonly operationId?: string;
  readonly entries: readonly Readonly<{
    extensionId: string;
    kind: ExtensionKind;
    name: string;
    scope: ExtensionScope;
    versionId: string;
    packageDigest?: string;
    components: readonly ExtensionComponent[];
  }>[];
  readonly digest: string;
}

export interface ExtensionRegistryDocument {
  readonly schemaVersion: typeof EXTENSION_REGISTRY_SCHEMA_VERSION;
  readonly revision: number;
  readonly currentGeneration: number;
  readonly extensions: readonly InstalledExtension[];
  readonly versions: readonly ExtensionVersion[];
  readonly policy: InstallPolicy;
  readonly migrations: readonly string[];
}

/** User-controlled standing installation policy. */
export interface InstallPolicy {
  readonly version: 1;
  /** Instruction-only content (skills) named by the human in their own message. */
  readonly humanRequestedSkills: "auto" | "ask";
  /** Executable code (MCP servers, plugin executables) named by the human: auto only for trusted sources. */
  readonly humanRequestedExecutable: "trusted_sources" | "ask";
  /** Patterns such as "npm:@modelcontextprotocol/*" or "git:https://github.com/acme/*". */
  readonly trustedSources: readonly string[];
}

export const DEFAULT_INSTALL_POLICY: InstallPolicy = Object.freeze({
  version: 1, humanRequestedSkills: "auto", humanRequestedExecutable: "trusted_sources", trustedSources: Object.freeze([]),
});

export type OperationAction = "install" | "update" | "enable" | "disable" | "remove" | "rollback" | "test" | "adopt" | "migrate" | "revoke_credentials";
export type OperationStage =
  | "resolve" | "inspect" | "await_choice" | "await_authorization" | "await_credentials" | "await_sign_in"
  | "stage" | "install_dependencies" | "validate" | "commit" | "activate" | "ready" | "rollback";
export type OperationOutcome = "running" | "awaiting_user" | "succeeded" | "failed" | "cancelled" | "outcome_unknown" | "rolled_back";

export type OperationOwner =
  | { readonly kind: "ui" }
  | { readonly kind: "agent"; readonly runId: string; readonly sessionId: string; readonly actorRole: string; readonly actorId: string };

/** A concrete thing only the user can supply. Rendered as one operation card. */
export type UserActionRequest =
  | { readonly kind: "approve"; readonly reason: string; readonly planDigest: string; readonly summary: AccessSummary }
  | { readonly kind: "choose"; readonly reason: string; readonly options: readonly Readonly<{ id: string; label: string; description?: string }>[] }
  | { readonly kind: "credential"; readonly reason: string; readonly names: readonly string[] }
  | { readonly kind: "sign_in"; readonly reason: string; readonly server: string };

export interface AccessSummary {
  /** When code from this package can run: never, at install (package scripts) or when its tools are used. */
  readonly executesCode: "never" | "on_use" | "at_install_and_on_use";
  readonly network: readonly string[];
  readonly filesystem: string;
  readonly credentials: readonly string[];
  readonly notes: readonly string[];
}

export interface ExtensionChangePlan {
  readonly planId: string;
  readonly planDigest: string;
  readonly action: OperationAction;
  readonly scope: ExtensionScope;
  readonly kind: ExtensionKind;
  readonly name: string;
  readonly version?: string;
  readonly extensionId?: string;
  readonly source?: ResolvedSource;
  readonly sourceKey?: string;
  readonly packageDigest?: string;
  readonly components: readonly ExtensionComponent[];
  readonly access: AccessSummary;
  readonly requiresExecutableTrust: boolean;
  /** Credential names the user must supply through the secret UI before activation. */
  readonly requiredCredentials: readonly string[];
  /** rollback: the version to restore. */
  readonly targetVersionId?: string;
  /** Plugins: installed extensions the bundle uses instead of carrying its own copy. */
  readonly dependencies?: readonly ExtensionDependency[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ExtensionOperation {
  readonly id: string;
  /** Caller idempotency key; reusing it with different inputs is a conflict. */
  readonly key: string;
  readonly owner: OperationOwner;
  readonly action: OperationAction;
  readonly target: Readonly<{ extensionId?: string; sourceKey?: string; name?: string }>;
  readonly scope: ExtensionScope;
  readonly requestFingerprint: string;
  readonly planDigest?: string;
  /** The immutable plan being applied, kept so restart recovery never re-resolves a source. */
  readonly plan?: ExtensionChangePlan;
  readonly authorizationRef?: string;
  /** How the change was authorized; never a model-supplied value. */
  readonly authorizationOrigin?: AuthorizationReceipt["origin"];
  readonly stage: OperationStage;
  readonly outcome: OperationOutcome;
  readonly progress: readonly Readonly<{ stage: OperationStage; at: string; note?: string }>[];
  readonly userAction?: UserActionRequest;
  readonly result?: Readonly<{ extensionId?: string; versionId?: string; generation?: number; readiness?: ExtensionReadiness }>;
  /** Bounded, redacted diagnostics. */
  readonly diagnostics: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Authority to apply one concrete change. Minted only by an authenticated UI action, a matching
 * human message intent, or the user's standing policy — never from model arguments or third-party text.
 */
export interface AuthorizationReceipt {
  readonly id: string;
  readonly origin: "ui" | "human_message" | "standing_policy";
  readonly action: OperationAction;
  readonly scope: ExtensionScope;
  readonly sourceKey?: string;
  readonly extensionId?: string;
  readonly planDigest?: string;
  readonly accessDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly intentId?: string;
}

/** Sources the human named in their own message; binds a conversation, never model text. */
export interface HumanInstallIntent {
  readonly id: string;
  readonly conversationId: string;
  readonly textDigest: string;
  readonly sourceKeys: readonly string[];
  readonly projectScope: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export const EXTENSION_LIMITS = Object.freeze({
  maxPackageFiles: 512,
  maxPackageBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxPathDepth: 12,
  maxPathLength: 240,
  maxArchiveBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxExtensions: 512,
  maxOperations: 1_000,
  maxDiagnostics: 40,
  maxDiagnosticChars: 2_000,
  planTtlMs: 30 * 60_000,
  receiptTtlMs: 30 * 60_000,
  intentTtlMs: 2 * 60 * 60_000,
  maxSkillResourceBytes: 256 * 1024,
});

export class ExtensionManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ExtensionManagementError";
  }
}

export function scopeKey(scope: ExtensionScope): string {
  return scope.kind === "user" ? "user" : `project:${scope.projectIdentity}`;
}

export function parseScope(value: unknown): ExtensionScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExtensionManagementError("invalid_scope", "scope must be {kind:\"user\"} or {kind:\"project\", projectIdentity}.");
  const scope = value as Record<string, unknown>;
  if (scope.kind === "user" && Object.keys(scope).length === 1) return Object.freeze({ kind: "user" });
  if (scope.kind === "project" && typeof scope.projectIdentity === "string" && /^[a-f0-9]{16,64}$/.test(scope.projectIdentity) && Object.keys(scope).length === 2)
    return Object.freeze({ kind: "project", projectIdentity: scope.projectIdentity });
  throw new ExtensionManagementError("invalid_scope", "scope must be {kind:\"user\"} or {kind:\"project\", projectIdentity}.");
}

export function sameScope(left: ExtensionScope, right: ExtensionScope): boolean {
  return scopeKey(left) === scopeKey(right);
}
