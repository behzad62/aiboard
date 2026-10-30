import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ExtensionAuthorizer } from "./extension-authorization.js";
import type { ExtensionCredentialStore } from "./extension-credentials.js";
import {
  EXTENSION_LIMITS,
  ExtensionManagementError,
  extensionToolAdmitted,
  validateExtensionToolPolicy,
  sameScope,
  scopeKey,
  type AccessSummary,
  type AuthorizationReceipt,
  type ExtensionChangePlan,
  type ExtensionComponent,
  type ExtensionToolPolicy,
  type ExtensionToolInventory,
  type ExtensionDependency,
  type RunnerExtensionComponent,
  type ExtensionGeneration,
  type ExtensionKind,
  type ExtensionOperation,
  type ExtensionReadiness,
  type ExtensionScope,
  type ExtensionVersion,
  type InstalledExtension,
  type InstallPolicy,
  type McpServerComponent,
  type OperationAction,
  type OperationOwner,
  type OperationStage,
  type ResolvedSource,
  type SkillComponent,
  type UserActionRequest,
} from "./extension-management-contracts.js";
import { ExtensionPackageStore, readZipArchive, snapshotDirectory, type PackageTree } from "./extension-package-store.js";
import { defaultToolPolicy, legacyToolPolicy, ExtensionRegistryStore, type MutableRegistryState } from "./extension-registry.js";
import { discoverSkills, singleFileSkillTree } from "./extension-skill-validation.js";
import {
  isWithin,
  resolveGit,
  resolveLocalDirectory,
  sourceKey,
  type GitSourceOptions,
  type SourceRequest,
} from "./extension-sources.js";

/** Who is calling the service. Agents carry their run identity; only the UI can approve or hold secrets. */
export type ManagementCaller =
  | { readonly kind: "ui" }
  | {
      readonly kind: "agent";
      readonly runId: string;
      readonly sessionId: string;
      readonly actorRole: string;
      readonly actorId: string;
      /** Binds human-message intent; supplied by the Runner from the session, never by the model. */
      readonly conversationId?: string;
      /** Workers/verifiers can read the inventory but cannot change it. */
      readonly canMutate: boolean;
      /** Folder the agent may name as a local source without the human naming it (its workspace). */
      readonly workspaceRoot?: string;
    };

/** Public, serializable view of an inspected source (no package bytes). */
export interface SourceInspectionView {
  readonly inspectionId: string;
  readonly sourceKey: string;
  readonly source: ResolvedSource;
  readonly kind: ExtensionKind;
  readonly name?: string;
  readonly version?: string;
  readonly components: readonly ExtensionComponent[];
  readonly invalid: readonly Readonly<{ path: string; errors: readonly string[] }>[];
  readonly warnings: readonly string[];
  readonly access: AccessSummary;
  readonly requiresExecutableTrust: boolean;
  readonly requiredCredentials: readonly string[];
  readonly dependencies?: readonly ExtensionDependency[];
  readonly expiresAt: string;
}

/** What a kind handler returns after resolving a source; never runs package code. */
export interface HandlerInspection {
  readonly kind: ExtensionKind;
  readonly name?: string;
  readonly version?: string;
  readonly source: ResolvedSource;
  readonly components: readonly ExtensionComponent[];
  readonly invalid?: readonly Readonly<{ path: string; errors: readonly string[] }>[];
  readonly warnings?: readonly string[];
  readonly access: AccessSummary;
  readonly requiresExecutableTrust: boolean;
  readonly requiredCredentials?: readonly string[];
  /** Plugins: installed extensions the bundle uses (must exist when it is installed). */
  readonly dependencies?: readonly ExtensionDependency[];
  /** Per-component package trees, keyed by componentId (skills) or "" for the whole package. */
  readonly trees: ReadonlyMap<string, PackageTree>;
}

/**
 * Pluggable handling for kinds whose install needs more than storing files (MCP servers, plugin
 * bundles). The skill path is built in. Handlers reuse Runner-governed execution; none runs in the browser.
 */
export interface ExtensionKindHandler {
  readonly kind: ExtensionKind;
  /** Claims a non-tree source (npm, pypi, executable, remote_http) or a tree with a recognized manifest. */
  claims(request: SourceRequest, tree?: PackageTree): boolean;
  inspect(request: SourceRequest, tree: PackageTree | undefined, context: { readonly source?: ResolvedSource; readonly caller: ManagementCaller }): Promise<HandlerInspection>;
  /** Executable stage (dependency install) after authorization; returns the final components. */
  install?(plan: ExtensionChangePlan, context: HandlerInstallContext): Promise<{ readonly components: readonly ExtensionComponent[]; readonly packageDigest?: string }>;
  /** Real readiness check (handshake + discovery for MCP); never calls arbitrary advertised tools. */
  check?(extension: InstalledExtension, version: ExtensionVersion, context: HandlerCheckContext): Promise<ExtensionReadiness>;
  /** Releases owned resources (stops a connection) when disabled/removed. */
  release?(extension: InstalledExtension, version: ExtensionVersion | undefined): Promise<void>;
  /** OAuth: the authorization URL the user opens; state and PKCE stay in the Runner. */
  beginSignIn?(extension: InstalledExtension, version: ExtensionVersion): Promise<string>;
  /** OAuth callback with a state this handler issued; tokens go to the credential service. */
  completeSignIn?(state: string, code: string): Promise<{ readonly extensionId: string }>;
  /** MCP: the exact launch of a CLI-configured server, as a source the user can adopt explicitly. */
  adoptionSource?(name: string): SourceRequest | undefined;
  /** MCP: which tools may run without asking; changed only from Settings. */
  readonly toolPolicy?: {
    get(extensionId: string): Promise<"all" | "non_destructive" | undefined>;
    set(extensionId: string, policy: "all" | "non_destructive"): Promise<void>;
  };
}

export interface HandlerInstallContext {
  readonly packages: ExtensionPackageStore;
  readonly signal: AbortSignal;
  readonly report: (note: string) => Promise<void>;
  readonly extensionId: string;
}

export interface HandlerCheckContext {
  readonly packages: ExtensionPackageStore;
  readonly credentials: ExtensionCredentialStore;
  readonly signal: AbortSignal;
}

export interface ExternalItem {
  readonly kind: ExtensionKind;
  readonly name: string;
  readonly provenance: "external" | "cli" | "project";
  readonly source: ResolvedSource;
  readonly description?: string;
  readonly detail?: string;
  /** For CLI MCP servers: adoptable into managed configuration. */
  readonly adoptable?: boolean;
}

export interface ExtensionManagementServiceOptions {
  readonly home: string;
  readonly projectRoot: string;
  readonly allowNestedRunnerState?: boolean;
  readonly credentials: ExtensionCredentialStore;
  readonly git?: Omit<GitSourceOptions, "scratchDirectory" | "allowLocal">;
  readonly handlers?: readonly ExtensionKindHandler[];
  /** Read-only items discovered elsewhere (other tools' skill folders, project skills, CLI MCP). */
  readonly external?: () => Promise<readonly ExternalItem[]>;
  /** Generations pinned by live runs/sessions; their package versions are never collected. */
  readonly pinnedGenerations?: () => ReadonlySet<number>;
  readonly now?: () => Date;
}

interface CachedInspection {
  readonly view: SourceInspectionView;
  readonly trees: ReadonlyMap<string, PackageTree>;
  readonly ownerKey: string;
}

interface UploadRecord {
  readonly id: string;
  readonly filename: string;
  readonly path: string;
  readonly byteLength: number;
  readonly digest: string;
  readonly createdAt: number;
}

const MAX_CACHED_INSPECTIONS = 32;
const MAX_UPLOADS = 16;
const UPLOAD_TTL_MS = 60 * 60_000;

/**
 * The one Runner-owned extension manager shared by Settings and agent tools. Every mutation is an
 * idempotent, durable operation; installation publishes a new immutable capability generation that
 * new sessions bind and existing ones adopt only through an explicit turn-boundary transition.
 */
export class ExtensionManagementService {
  readonly registry: ExtensionRegistryStore;
  readonly packages: ExtensionPackageStore;
  readonly authorizer: ExtensionAuthorizer;
  readonly projectIdentity: string;
  private readonly inspections = new Map<string, CachedInspection>();
  private readonly plans = new Map<string, ExtensionChangePlan>();
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly running = new Map<string, Promise<ExtensionOperation>>();
  private readonly listeners = new Set<(event: ExtensionServiceEvent) => void>();
  private readonly handlers: readonly ExtensionKindHandler[];
  private readonly canonicalProjectRoot: string;

  private constructor(private readonly options: ExtensionManagementServiceOptions, canonicalProjectRoot: string) {
    this.registry = new ExtensionRegistryStore(options.home);
    this.packages = new ExtensionPackageStore(options.home);
    this.canonicalProjectRoot = canonicalProjectRoot;
    this.projectIdentity = projectIdentityFor(canonicalProjectRoot);
    this.authorizer = new ExtensionAuthorizer({ projectRoot: canonicalProjectRoot, ...(options.now ? { now: options.now } : {}) });
    this.handlers = options.handlers ?? [];
  }

  static async open(options: ExtensionManagementServiceOptions): Promise<ExtensionManagementService> {
    const home = resolve(options.home);
    const projectRoot = await realpath(options.projectRoot);
    if (!options.allowNestedRunnerState && isWithin(projectRoot, home)) throw new ExtensionManagementError("invalid_extensions_home", "The extension store must be outside the project.", 500);
    // The store directory is created by the first write, so starting a Runner leaves no trace.
    const service = new ExtensionManagementService({ ...options, home }, projectRoot);
    await service.registry.load();
    await service.recover();
    return service;
  }

  get projectRoot(): string {
    return this.canonicalProjectRoot;
  }

  projectScope(): ExtensionScope {
    return { kind: "project", projectIdentity: this.projectIdentity };
  }

  subscribe(listener: (event: ExtensionServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Inventory ----------------------------------------------------------------------------------

  async inventory(): Promise<ExtensionInventory> {
    const registry = await this.registry.load();
    const visible = registry.extensions.filter((entry) => !entry.removedAt && this.inScope(entry.scope));
    const external = this.options.external ? await this.options.external().catch(() => []) : [];
    const operations = (await this.registry.operations()).filter((operation) => operation.outcome === "running" || operation.outcome === "awaiting_user");
    return {
      currentGeneration: registry.currentGeneration,
      projectIdentity: this.projectIdentity,
      policy: registry.policy,
      items: visible.map((entry) => this.describe(entry, registry.versions)),
      external: external.map((item) => ({ ...item })),
      pendingOperations: operations.map(publicOperation),
    };
  }

  async generation(generation?: number): Promise<ExtensionGeneration> {
    const current = generation ?? (await this.registry.load()).currentGeneration;
    return await this.registry.generation(current);
  }

  /** Changes to the durable registry invalidate cached managed-tool lists. */
  async policyRevision(): Promise<number> {
    return (await this.registry.load()).revision;
  }

  /** Revision of only the policies and live state that can change a pinned generation's tools. */
  async policyRevisionForGeneration(generationNumber: number): Promise<string> {
    const generation = await this.registry.generation(generationNumber);
    const registry = await this.registry.load();
    const relevant = generation.entries.map((entry) => {
      const extension = registry.extensions.find((item) => item.id === entry.extensionId);
      return [entry.extensionId, entry.versionId, registry.toolPolicies[entry.extensionId] ?? null,
        registry.toolApprovals[entry.extensionId] ?? null, extension?.enabled ?? false,
        extension?.removedAt ?? null, extension?.currentVersionId ?? null, extension?.readiness.state ?? null];
    }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return sha256(JSON.stringify(relevant));
  }

  async setPolicy(policy: InstallPolicy, caller: ManagementCaller): Promise<InstallPolicy> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only you can change installation policy, from Settings.", 403);
    return await this.registry.mutate((state) => { state.setPolicy(policy); return state.registry.policy; });
  }

  // ---- Uploads (UI only) --------------------------------------------------------------------------

  async storeUpload(filename: string, bytes: Buffer): Promise<{ uploadId: string; byteLength: number; digest: string }> {
    if (!/^[^\\/\0]{1,200}$/.test(filename)) throw new ExtensionManagementError("invalid_upload", "Upload filename is invalid.");
    if (bytes.byteLength > EXTENSION_LIMITS.maxArchiveBytes) throw new ExtensionManagementError("archive_too_large", "Upload is too large.", 413);
    this.pruneUploads();
    const id = `upl_${randomBytes(16).toString("hex")}`;
    const path = join(this.options.home, "uploads", id);
    await mkdir(join(this.options.home, "uploads"), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    const record: UploadRecord = { id, filename, path, byteLength: bytes.byteLength, digest: sha256(bytes), createdAt: Date.now() };
    this.uploads.set(id, record);
    return { uploadId: id, byteLength: record.byteLength, digest: record.digest };
  }

  // ---- Inspect --------------------------------------------------------------------------------------

  async inspectSource(request: SourceRequest, caller: ManagementCaller): Promise<SourceInspectionView> {
    this.assertSourceAllowed(request, caller);
    let tree: PackageTree | undefined;
    let source: ResolvedSource | undefined;
    if (request.type === "local_directory") {
      const resolved = await resolveLocalDirectory(request.path);
      tree = resolved.tree;
      source = resolved.source;
      if (caller.kind === "agent") this.assertAgentLocalSource(resolved.source.type === "local_directory" ? resolved.source.path : request.path, caller);
    } else if (request.type === "upload") {
      if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Uploads are added from Settings.", 403);
      const upload = this.uploads.get(request.uploadId);
      if (!upload) throw new ExtensionManagementError("upload_missing", "That upload expired; add the file again.", 404);
      const bytes = await readFile(upload.path);
      if (/\.zip$/i.test(upload.filename) || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        tree = readZipArchive(bytes);
        source = { type: "archive", filename: upload.filename, archiveDigest: upload.digest, treeDigest: tree.digest };
      } else if (/(^|[\\/])SKILL\.md$/i.test(upload.filename) || /\.md$/i.test(upload.filename)) {
        tree = singleFileSkillTree(bytes);
        source = { type: "single_file", filename: upload.filename, treeDigest: tree.digest };
      } else {
        throw new ExtensionManagementError("upload_unsupported", "Upload a .zip archive or a single SKILL.md file.");
      }
    } else if (request.type === "git") {
      if (!this.options.git) throw new ExtensionManagementError("git_unavailable", "Git sources are unavailable on this Runner.", 503);
      const resolved = await resolveGit(request, { ...this.options.git, scratchDirectory: join(this.options.home, "scratch"), allowLocal: caller.kind === "ui" });
      tree = resolved.tree;
      source = resolved.source;
    }
    const handler = this.handlers.find((candidate) => candidate.claims(request, tree));
    let inspection: HandlerInspection;
    if (handler) {
      inspection = await handler.inspect(request, tree, { ...(source ? { source } : {}), caller });
    } else if (tree && source) {
      inspection = inspectSkills(tree, source);
    } else {
      throw new ExtensionManagementError("source_kind_unsupported", `${request.type} sources need MCP support, which this Runner build does not provide.`, 501);
    }
    const now = this.now();
    const view: SourceInspectionView = Object.freeze({
      inspectionId: `insp_${randomUUID()}`,
      sourceKey: sourceKey(inspection.source),
      source: inspection.source,
      kind: inspection.kind,
      ...(inspection.name ? { name: inspection.name } : {}),
      ...(inspection.version ? { version: inspection.version } : {}),
      components: inspection.components,
      invalid: inspection.invalid ?? [],
      warnings: inspection.warnings ?? [],
      access: inspection.access,
      requiresExecutableTrust: inspection.requiresExecutableTrust,
      requiredCredentials: inspection.requiredCredentials ?? [],
      ...(inspection.dependencies?.length ? { dependencies: inspection.dependencies } : {}),
      expiresAt: new Date(now.getTime() + EXTENSION_LIMITS.planTtlMs).toISOString(),
    });
    this.inspections.set(view.inspectionId, { view, trees: inspection.trees, ownerKey: callerKey(caller) });
    while (this.inspections.size > MAX_CACHED_INSPECTIONS) this.inspections.delete(this.inspections.keys().next().value!);
    return view;
  }

  // ---- Plan -----------------------------------------------------------------------------------------

  async planChange(request: PlanRequest, caller: ManagementCaller): Promise<ExtensionChangePlan> {
    if (caller.kind === "agent" && !caller.canMutate) throw new ExtensionManagementError("role_cannot_manage", "Your role can read installed capabilities but cannot change them; ask the coordinator.", 403);
    const registry = await this.registry.load();
    const now = this.now();
    const base = { planId: `plan_${randomUUID()}`, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + EXTENSION_LIMITS.planTtlMs).toISOString() };
    let plan: Omit<ExtensionChangePlan, "planDigest">;
    if (request.action === "install" || request.action === "update") {
      const cached = this.inspections.get(request.inspectionId);
      if (!cached || Date.parse(cached.view.expiresAt) <= now.getTime()) throw new ExtensionManagementError("inspection_expired", "Inspect the source again; that inspection expired.", 409);
      if (cached.ownerKey !== callerKey(caller)) throw new ExtensionManagementError("inspection_not_owned", "That inspection belongs to another caller.", 403);
      const view = cached.view;
      const scope = request.scope ?? (caller.kind === "agent" ? this.projectScope() : { kind: "user" as const });
      this.assertScope(scope);
      let components: readonly ExtensionComponent[];
      let name: string;
      let packageDigest: string | undefined;
      let source = view.source;
      if (view.kind === "skill") {
        const selected = selectSkillComponent(view.components as SkillComponent[], request.componentIds);
        if (selected.kind === "choose") {
          throw new ExtensionManagementError("selection_required", `This source contains ${view.components.length} skills; choose one: ${selected.options.join(", ")}.`, 409);
        }
        if (caller.kind === "agent" && request.componentIds?.length && view.components.length > 1) {
          // The model may only pick among several skills when the human named the one it picked.
          const named = caller.conversationId && this.authorizer.intentsFor(caller.conversationId).length > 0 && this.humanNamed(caller.conversationId, selected.component.skillName);
          if (!named) throw new ExtensionManagementError("selection_required", `This source contains several skills and you did not name "${selected.component.skillName}"; ask the user which one, or let them choose in Settings.`, 409);
        }
        name = selected.component.skillName;
        const tree = cached.trees.get(selected.component.componentId);
        if (!tree) throw new ExtensionManagementError("inspection_expired", "Inspect the source again.", 409);
        // The stored package is the skill folder itself; provenance keeps where it came from.
        components = [{ ...selected.component, packagePath: "" }];
        source = narrowSource(view.source, selected.component.packagePath, tree.digest);
        // Staging content is not execution: committing the bytes now lets an approved plan survive a Runner restart.
        await this.packages.commit(tree);
        packageDigest = tree.digest;
      } else {
        components = view.components;
        name = request.name ?? view.name ?? view.components[0]?.componentId ?? "extension";
        const tree = cached.trees.get("");
        if (tree) { await this.packages.commit(tree); packageDigest = tree.digest; }
      }
      const extensionId = extensionIdFor(view.kind, scope, name);
      const existing = registry.extensions.find((entry) => entry.id === extensionId && !entry.removedAt);
      const warnings = [...view.warnings, ...components.flatMap((component) => component.kind === "skill" ? component.warnings : [])];
      if (existing && existing.source && sourceKey(existing.source) !== sourceKey(source)) warnings.push(`Replaces "${name}" from ${sourceKey(existing.source)}.`);
      const shadow = view.kind === "skill" ? await this.shadowWarning(name) : undefined;
      if (shadow) warnings.push(shadow);
      plan = {
        ...base,
        action: existing ? "update" : "install",
        scope, kind: view.kind, name,
        ...(view.version ? { version: view.version } : {}),
        extensionId,
        source, sourceKey: sourceKey(source),
        ...(packageDigest ? { packageDigest } : {}),
        components, access: view.access,
        requiresExecutableTrust: view.requiresExecutableTrust,
        requiredCredentials: view.requiredCredentials,
        ...(view.dependencies?.length ? { dependencies: view.dependencies } : {}),
        warnings: Object.freeze([...new Set(warnings)]),
      };
    } else {
      const lifecycle = request as Extract<PlanRequest, { extensionId: string }>;
      const extensionId = lifecycle.extensionId;
      const extension = registry.extensions.find((entry) => entry.id === extensionId && !entry.removedAt);
      if (!extension || !this.inScope(extension.scope)) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
      if (extension.provenance === "external") throw new ExtensionManagementError("extension_read_only", "This item is managed outside AI Board; it is listed read-only.", 409);
      if (extension.provenance === "migrated") throw new ExtensionManagementError("extension_read_only", "This provider-hosted server is managed in Settings → Tools; to have the Runner call it, add it as a Runner-hosted server.", 409);
      const version = extension.currentVersionId ? registry.versions.find((entry) => entry.versionId === extension.currentVersionId) : undefined;
      let targetVersionId: string | undefined;
      if (lifecycle.action === "rollback") {
        targetVersionId = lifecycle.versionId ?? extension.previousVersionIds.at(-1);
        if (!targetVersionId || !extension.previousVersionIds.includes(targetVersionId)) throw new ExtensionManagementError("rollback_unavailable", "There is no earlier version to restore.", 409);
      }
      const target = targetVersionId ? registry.versions.find((entry) => entry.versionId === targetVersionId) : version;
      plan = {
        ...base,
        action: lifecycle.action, scope: extension.scope, kind: extension.kind, name: extension.name, extensionId: extension.id,
        source: target?.source ?? extension.source, sourceKey: sourceKey(target?.source ?? extension.source),
        ...(target?.packageDigest ? { packageDigest: target.packageDigest } : {}),
        components: target?.components ?? [],
        access: lifecycle.action === "enable" || lifecycle.action === "rollback" ? accessFor(target?.components ?? []) : NO_ACCESS,
        requiresExecutableTrust: (lifecycle.action === "enable" || lifecycle.action === "rollback") && (target?.components ?? []).some(isExecutableComponent),
        requiredCredentials: [],
        ...(targetVersionId ? { targetVersionId } : {}),
        warnings: extension.referencedBy.length && lifecycle.action === "remove" ? [`Used by ${extension.referencedBy.join(", ")}; it stays installed while they need it.`] : [],
      };
    }
    const sealed: ExtensionChangePlan = Object.freeze({ ...plan, planDigest: planDigest(plan) });
    this.plans.set(sealed.planId, sealed);
    if (this.plans.size > 256) this.plans.delete(this.plans.keys().next().value!);
    return sealed;
  }

  // ---- Apply ----------------------------------------------------------------------------------------

  /**
   * Applies a plan idempotently. `key` is the caller's idempotency key; replaying it returns the same
   * operation. Authorization comes only from the caller identity (UI) or the authorizer (agents).
   */
  async applyChange(input: { planId: string; planDigest: string; key: string }, caller: ManagementCaller): Promise<ExtensionOperation> {
    if (caller.kind === "agent" && !caller.canMutate) throw new ExtensionManagementError("role_cannot_manage", "Your role cannot change installed capabilities.", 403);
    if (!/^[A-Za-z0-9:_.-]{8,160}$/.test(input.key)) throw new ExtensionManagementError("invalid_operation_key", "Operation keys are 8-160 safe characters.");
    const fingerprint = sha256(JSON.stringify({ planDigest: input.planDigest, owner: callerKey(caller) }));
    const prior = (await this.registry.operations()).find((operation) => operation.key === input.key);
    if (prior) {
      if (prior.requestFingerprint !== fingerprint) throw new ExtensionManagementError("operation_key_conflict", "That operation key was already used for a different change.", 409);
      return await this.reconcile(prior);
    }
    const plan = this.plans.get(input.planId);
    if (!plan || plan.planDigest !== input.planDigest) throw new ExtensionManagementError("plan_not_found", "That plan is unknown or changed; plan the change again.", 409);
    if (Date.parse(plan.expiresAt) <= this.now().getTime()) throw new ExtensionManagementError("plan_expired", "That plan expired; plan the change again.", 409);
    let receipt: AuthorizationReceipt | undefined;
    let userAction: UserActionRequest | undefined;
    if (caller.kind === "ui") {
      receipt = this.authorizer.uiReceipt(plan);
    } else {
      const policy = (await this.registry.load()).policy;
      const decision = this.authorizer.decideForAgent(plan, caller.conversationId, policy);
      if (decision.kind === "authorized") receipt = decision.receipt;
      else userAction = { kind: "approve", reason: decision.reason, planDigest: plan.planDigest, summary: plan.access };
    }
    const now = this.now().toISOString();
    const operation: ExtensionOperation = {
      id: `op_${randomUUID()}`,
      key: input.key,
      owner: ownerOf(caller),
      action: plan.action,
      target: { ...(plan.extensionId ? { extensionId: plan.extensionId } : {}), ...(plan.sourceKey ? { sourceKey: plan.sourceKey } : {}), name: plan.name },
      scope: plan.scope,
      requestFingerprint: fingerprint,
      planDigest: plan.planDigest,
      plan,
      ...(receipt ? { authorizationRef: receipt.id, authorizationOrigin: receipt.origin } : {}),
      stage: userAction ? "await_authorization" : "stage",
      outcome: userAction ? "awaiting_user" : "running",
      progress: [{ stage: "resolve", at: now }, { stage: "inspect", at: now }, { stage: userAction ? "await_authorization" : "stage", at: now }],
      ...(userAction ? { userAction } : {}),
      diagnostics: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.registry.mutate((state) => {
      const busy = state.operations.find((entry) => (entry.outcome === "running" || entry.outcome === "awaiting_user") && entry.target.extensionId === plan.extensionId && plan.extensionId);
      if (busy) throw new ExtensionManagementError("operation_in_progress", `Another change to "${plan.name}" is in progress (${busy.id}).`, 409);
      state.putOperation(operation);
    });
    this.emit({ type: "operation", operation: publicOperation(operation) });
    if (userAction) return publicOperation(operation);
    return await this.execute(operation.id);
  }

  async operationStatus(id: string, caller: ManagementCaller): Promise<ExtensionOperation> {
    const operation = (await this.registry.operations()).find((entry) => entry.id === id);
    if (!operation || !this.inScope(operation.scope)) throw new ExtensionManagementError("operation_not_found", "No such operation.", 404);
    if (caller.kind === "agent" && operation.owner.kind === "agent" && operation.owner.runId !== caller.runId) throw new ExtensionManagementError("operation_not_found", "No such operation.", 404);
    return publicOperation(operation);
  }

  async listOperations(): Promise<ExtensionOperation[]> {
    return (await this.registry.operations()).filter((entry) => this.inScope(entry.scope)).map(publicOperation).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100);
  }

  /** The user's answer to an approval card (UI only). Binds to the exact plan digest shown. */
  async approve(operationId: string, planDigestShown: string, caller: ManagementCaller): Promise<ExtensionOperation> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only you can approve a change, from the operation card.", 403);
    const operation = await this.registry.mutate((state) => {
      const current = state.operation(operationId);
      if (!current) throw new ExtensionManagementError("operation_not_found", "No such operation.", 404);
      if (current.outcome !== "awaiting_user" || current.userAction?.kind !== "approve") return current;
      if (!current.plan || current.plan.planDigest !== planDigestShown) throw new ExtensionManagementError("plan_changed", "The change differs from what you approved; review it again.", 409);
      const receipt = this.authorizer.uiReceipt(current.plan);
      const next = this.advance(current, current.plan.requiredCredentials.length && this.missingCredentials(current.plan).length ? "await_credentials" : "stage", {
        authorizationRef: receipt.id, authorizationOrigin: receipt.origin,
      });
      state.putOperation(next);
      return next;
    });
    if (operation.outcome !== "running") return publicOperation(operation);
    return await this.execute(operation.id);
  }

  async decline(operationId: string, caller: ManagementCaller): Promise<ExtensionOperation> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only you can decline a change.", 403);
    return publicOperation(await this.registry.mutate((state) => {
      const current = state.operation(operationId);
      if (!current) throw new ExtensionManagementError("operation_not_found", "No such operation.", 404);
      if (current.outcome !== "awaiting_user") return current;
      const next = this.finish(current, "cancelled", "Declined by you.");
      state.putOperation(next);
      return next;
    }));
  }

  /** Secret entry from the dedicated UI field. The value goes straight to the credential store. */
  async submitCredential(operationOrExtensionId: string, name: string, value: string, caller: ManagementCaller): Promise<ExtensionOperation | InstalledExtension> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Credentials are entered by you in Settings, never through a model.", 403);
    const operations = await this.registry.operations();
    const operation = operations.find((entry) => entry.id === operationOrExtensionId);
    const extensionId = operation?.plan?.extensionId ?? operationOrExtensionId;
    const registry = await this.registry.load();
    const extension = registry.extensions.find((entry) => entry.id === extensionId);
    const allowed = operation?.plan?.requiredCredentials ?? (extension ? this.declaredCredentialNames(extension, registry.versions) : []);
    if (!allowed.includes(name)) throw new ExtensionManagementError("credential_not_requested", `${name} is not a credential this extension declares.`, 400);
    const stored = this.options.credentials.put({ extensionId, name, kind: "env", value });
    if (extension) {
      await this.registry.mutate((state) => {
        const current = state.extension(extensionId);
        if (current && !current.credentialRefs.includes(stored.ref)) state.putExtension({ ...current, credentialRefs: [...current.credentialRefs, stored.ref], updatedAt: this.now().toISOString() });
      });
    }
    if (operation && operation.outcome === "awaiting_user" && operation.userAction?.kind === "credential" && operation.plan && this.missingCredentials(operation.plan).length === 0) {
      await this.registry.mutate((state) => { const current = state.operation(operation.id); if (current) state.putOperation(this.advance(current, "stage")); });
      return await this.execute(operation.id);
    }
    return operation ? publicOperation((await this.registry.operations()).find((entry) => entry.id === operation.id)!) : (await this.registry.load()).extensions.find((entry) => entry.id === extensionId)!;
  }

  async revokeCredentials(extensionId: string, caller: ManagementCaller): Promise<{ revoked: number }> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only you can revoke credentials.", 403);
    const removed = this.options.credentials.revoke({ extensionId });
    await this.registry.mutate((state) => {
      const current = state.extension(extensionId);
      if (current) state.putExtension({ ...current, credentialRefs: [], readiness: current.enabled && removed.length ? { state: "needs_auth", detail: "Credentials were revoked.", checkedAt: this.now().toISOString() } : current.readiness, updatedAt: this.now().toISOString() });
    });
    return { revoked: removed.length };
  }

  /**
   * Idempotent migration of the browser's single remote MCP setting. It is listed with its
   * provider-hosted route and enabled state; the token stays in the browser and the Runner never calls
   * it. Moving it to Runner-hosted access is a separate, explicit install by the user.
   */
  async recordProviderHostedMcp(input: { name: string; url: string; enabled: boolean; hasToken: boolean }, caller: ManagementCaller): Promise<ExtensionInventoryItem> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only AI Board's settings can record a migrated server.", 403);
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw new ExtensionManagementError("invalid_request", "The migrated server URL is invalid.");
    }
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new ExtensionManagementError("invalid_request", "The migrated server URL must be http(s) without embedded credentials.");
    const url = `${parsed.origin}${parsed.pathname}`;
    const serverName = input.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32) || "remote";
    const scope: ExtensionScope = { kind: "user" };
    const extensionId = extensionIdFor("mcp_server", scope, `provider-hosted:${url}`);
    const now = this.now().toISOString();
    const readiness: ExtensionReadiness = input.enabled
      ? { state: "unsupported", checkedAt: now, detail: "Provider-hosted tools are unavailable because the Runner cannot enforce their tool filter." }
      : { state: "disabled", checkedAt: now, detail: "Disabled in Settings → Tools." };
    await this.registry.mutate((state) => {
      const prior = state.extension(extensionId);
      const version: ExtensionVersion = prior?.currentVersionId ? state.version(prior.currentVersionId)! : Object.freeze({
        versionId: `ver_${randomUUID()}`, extensionId, source: { type: "provider_hosted", url } as ResolvedSource, createdAt: now, operationId: "migration",
        components: [{ kind: "mcp_server", componentId: `mcp:${serverName}`, serverName, transport: "streamable_http", url, environment: [], route: "provider_hosted", auth: input.hasToken ? "bearer" : "none", network: true } satisfies McpServerComponent],
      });
      if (!prior) state.putVersion(version);
      // Re-running only syncs the enabled state; it never creates a second entry or a new generation.
      if (prior && prior.enabled === input.enabled && prior.readiness.state === readiness.state) return;
      state.putExtension({
        id: extensionId, kind: "mcp_server", name: input.name.slice(0, 120) || serverName, scope, provenance: "migrated", source: { type: "provider_hosted", url },
        currentVersionId: version.versionId, enabled: input.enabled, desiredGeneration: state.registry.currentGeneration, readiness,
        componentIds: version.components.map((component) => component.componentId), credentialRefs: [], previousVersionIds: [], referencedBy: [],
        installedAt: prior?.installedAt ?? now, updatedAt: now,
      });
      state.recordMigration(`provider-hosted-mcp:${url}`);
    });
    const registry = await this.registry.load();
    return this.describe(registry.extensions.find((entry) => entry.id === extensionId)!, registry.versions);
  }

  /**
   * Inspects a CLI-configured MCP server for explicit adoption into managed configuration. Its launch
   * arguments are taken exactly from the Runner's command line; the managed copy starts only once that
   * --mcp entry is removed, so there is never a duplicate connection.
   */
  async inspectAdoption(name: string, caller: ManagementCaller): Promise<SourceInspectionView> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Adopting a command-line server is done from Settings.", 403);
    for (const handler of this.handlers) {
      const source = handler.adoptionSource?.(name);
      if (source) {
        const view = await this.inspectSource(source, caller);
        return { ...view, warnings: [...view.warnings, "While the Runner is still started with this --mcp entry, the command-line server keeps running and this managed copy stays idle. Remove the --mcp flag to switch over."] };
      }
    }
    throw new ExtensionManagementError("extension_not_found", "No command-line MCP server with that name.", 404);
  }

  /** Starts OAuth sign-in for an extension (or the operation waiting on it). UI only; returns the URL to open. */
  async beginSignIn(operationOrExtensionId: string, caller: ManagementCaller): Promise<{ url: string }> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only you can sign in, from AI Board.", 403);
    const operation = (await this.registry.operations()).find((entry) => entry.id === operationOrExtensionId);
    const extensionId = operation?.result?.extensionId ?? operation?.plan?.extensionId ?? operationOrExtensionId;
    const registry = await this.registry.load();
    const extension = registry.extensions.find((entry) => entry.id === extensionId && !entry.removedAt);
    const version = registry.versions.find((entry) => entry.versionId === extension?.currentVersionId);
    if (!extension || !version) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
    const handler = this.handlerFor(extension.kind);
    if (!handler?.beginSignIn) throw new ExtensionManagementError("sign_in_unsupported", "This extension does not use sign-in.");
    return { url: await handler.beginSignIn(extension, version) };
  }

  /**
   * The browser redirect from the authorization server. Unauthenticated by design (the browser cannot
   * carry the Runner token), so only a state this Runner issued, once, is accepted.
   */
  async completeSignIn(state: string, code: string): Promise<{ extensionId: string; readiness: ExtensionReadiness }> {
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(state) || typeof code !== "string" || !code || code.length > 4096) {
      throw new ExtensionManagementError("sign_in_invalid", "The sign-in response is incomplete.", 400);
    }
    let completed: { extensionId: string } | undefined;
    for (const handler of this.handlers) {
      if (!handler.completeSignIn) continue;
      try {
        completed = await handler.completeSignIn(state, code);
        break;
      } catch (error) {
        if (error instanceof ExtensionManagementError && error.code === "sign_in_expired") continue;
        throw error;
      }
    }
    if (!completed) throw new ExtensionManagementError("sign_in_expired", "That sign-in link is unknown or expired; start sign-in again from AI Board.", 400);
    const extensionId = completed.extensionId;
    const waiting = (await this.registry.operations()).find((entry) => entry.outcome === "awaiting_user" && entry.userAction?.kind === "sign_in" && entry.result?.extensionId === extensionId);
    if (waiting?.result?.versionId !== undefined && waiting.result.generation !== undefined) {
      const version = (await this.registry.load()).versions.find((entry) => entry.versionId === waiting.result!.versionId)!;
      const finished = await this.finalizeReadiness(waiting.id, extensionId, version, waiting.result.generation, undefined);
      return { extensionId, readiness: finished.result?.readiness ?? { state: "failed" } };
    }
    return { extensionId, readiness: await this.test(extensionId) };
  }

  /** Which tools of a managed MCP server the assistant may call without asking (Settings choice). */
  async toolPolicy(extensionId: string): Promise<"all" | "non_destructive" | undefined> {
    const extension = await this.extensionRecord(extensionId);
    if (!extension) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
    return await this.handlerFor(extension.kind)?.toolPolicy?.get(extensionId);
  }

  async setToolPolicy(extensionId: string, policy: string, caller: ManagementCaller): Promise<"all" | "non_destructive"> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only you can change which tools may run without asking.", 403);
    if (policy !== "all" && policy !== "non_destructive") throw new ExtensionManagementError("invalid_request", "policy must be all or non_destructive.");
    const extension = await this.extensionRecord(extensionId);
    const setter = extension ? this.handlerFor(extension.kind)?.toolPolicy : undefined;
    if (!setter) throw new ExtensionManagementError("extension_not_found", "No such MCP server.", 404);
    await setter.set(extensionId, policy);
    this.emit({ type: "generation", generation: (await this.registry.load()).currentGeneration });
    return policy;
  }

  /** Record verified discovery as a candidate for local human review, never as an approval. */
  async recordMcpDiscovery(extensionId: string, versionId: string, inventory: ExtensionToolInventory): Promise<void> {
    await this.registry.mutate((state) => {
      const extension = state.extension(extensionId);
      if (!extension || extension.removedAt || extension.currentVersionId !== versionId) return;
      const prior = state.registry.toolDiscoveries[extensionId];
      const components = prior?.versionId === versionId ? prior.components.filter((item) => item.componentId !== inventory.componentId) : [];
      state.setToolDiscovery(extensionId, versionId, [...components, inventory].sort((left, right) => left.componentId.localeCompare(right.componentId)));
    });
  }

  async extensionToolPolicy(extensionId: string): Promise<ExtensionToolPolicyView> {
    const registry = await this.registry.load();
    const extension = registry.extensions.find((item) => item.id === extensionId && !item.removedAt && this.inScope(item.scope));
    const version = registry.versions.find((item) => item.versionId === extension?.currentVersionId && item.extensionId === extensionId);
    if (!extension || !version) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
    const current = registry.toolPolicies[extensionId];
    const discovery = registry.toolDiscoveries[extensionId];
    return {
      policy: current?.versionId === version.versionId ? current : defaultToolPolicy(version.versionId),
      discovered: discovery?.versionId === version.versionId ? discovery.components : [],
      currentGeneration: registry.currentGeneration,
      unsupported: version.components.some((component) => component.kind === "mcp_server" && component.route === "provider_hosted"),
    };
  }

  /** Only the authenticated local control plane may publish a reviewed widening. */
  async setExtensionToolPolicy(extensionId: string, raw: unknown, caller: ManagementCaller): Promise<ExtensionToolPolicyView> {
    if (caller.kind !== "ui") throw new ExtensionManagementError("ui_only", "Only you can review extension tools in local Settings.", 403);
    const generation = await this.registry.mutate((state) => {
      const extension = state.extension(extensionId);
      const version = extension?.currentVersionId ? state.version(extension.currentVersionId) : undefined;
      if (!extension || extension.removedAt || !this.inScope(extension.scope) || !version) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
      const policy = validateExtensionToolPolicy(raw, version);
      const prior = state.registry.toolPolicies[extensionId];
      // Catalog classification is Runner-owned; a submitted value cannot lower risk.
      if (policy.riskLabel !== (prior?.versionId === version.versionId ? prior.riskLabel : "unreviewed")) throw new ExtensionManagementError("tool_policy_invalid", "Risk labels are assigned by the Runner.");
      const discovery = state.registry.toolDiscoveries[extensionId];
      const expected = discovery?.versionId === version.versionId ? discovery.components : [];
      const canonical = (items: readonly ExtensionToolInventory[]) => JSON.stringify([...items].sort((a, b) => a.componentId.localeCompare(b.componentId)).map((item) => ({ ...item, toolNames: [...item.toolNames].sort() })));
      if (canonical(policy.reviewed) !== canonical(expected)) throw new ExtensionManagementError("tool_discovery_changed", "Discovery changed; review the current tools before applying policy.", 409);
      if (policy.remoteExposure && !version.components.some((component) => component.kind === "mcp_server" && component.route === "runner")) throw new ExtensionManagementError("unsupported", "Provider-hosted tools cannot be remotely exposed.", 409);
      state.setToolPolicy(extensionId, policy);
      state.putExtension({ ...extension, desiredGeneration: state.registry.currentGeneration + 1, updatedAt: this.now().toISOString() });
      return state.publishGeneration(undefined, this.now().toISOString()).generation;
    });
    this.emit({ type: "generation", generation });
    return await this.extensionToolPolicy(extensionId);
  }

  async managedMcpServerEligible(entry: ManagedMcpServerEntry, remote = false): Promise<boolean> {
    const registry = await this.registry.load();
    const extension = registry.extensions.find((item) => item.id === entry.extensionId);
    const live = registry.toolPolicies[entry.extensionId];
    if (!extension?.enabled || extension.removedAt || !this.inScope(extension.scope) || extension.currentVersionId !== entry.versionId ||
        extension.readiness.state !== "ready" || !live || live.versionId !== entry.versionId || !entry.toolPolicy) return false;
    const inventory = entry.toolPolicy.reviewed.find((item) => item.componentId === entry.component.componentId);
    return !!inventory && inventory.toolNames.some((name) =>
      extensionToolAdmitted(entry.toolPolicy!, entry.component, inventory.schemaDigest, inventory.toolNames, name, remote) &&
      extensionToolAdmitted(live, entry.component, inventory.schemaDigest, inventory.toolNames, name, remote));
  }

  /** A pinned decision intersects the latest live restriction at listing and call time. */
  async managedMcpToolAdmitted(entry: ManagedMcpServerEntry, schemaDigest: string, observedNames: readonly string[], toolName: string, remote = false): Promise<boolean> {
    const registry = await this.registry.load();
    const extension = registry.extensions.find((item) => item.id === entry.extensionId);
    if (!extension?.enabled || extension.removedAt || !this.inScope(extension.scope) || extension.currentVersionId !== entry.versionId || extension.readiness.state !== "ready") return false;
    const live = registry.toolPolicies[entry.extensionId];
    if (!entry.toolPolicy || !live || live.versionId !== entry.versionId) return false;
    return extensionToolAdmitted(entry.toolPolicy, entry.component, schemaDigest, observedNames, toolName, remote) &&
      extensionToolAdmitted(live, entry.component, schemaDigest, observedNames, toolName, remote);
  }

  /** Re-checks readiness without changing installed state. */
  async test(extensionId: string): Promise<ExtensionReadiness> {
    const registry = await this.registry.load();
    const extension = registry.extensions.find((entry) => entry.id === extensionId && !entry.removedAt);
    if (!extension) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
    const version = registry.versions.find((entry) => entry.versionId === extension.currentVersionId);
    if (!version) throw new ExtensionManagementError("extension_not_found", "That extension has no installed version.", 404);
    const readiness = await this.checkReadiness(extension, version);
    await this.registry.mutate((state) => { const current = state.extension(extensionId); if (current) state.putExtension({ ...current, readiness, updatedAt: this.now().toISOString() }); });
    return readiness;
  }

  // ---- Managed skill content (read by SkillCatalog for a pinned generation) ---------------------------

  /** Managed skills visible to this project in a generation, with their immutable package directories. */
  async managedSkills(generationNumber: number): Promise<ManagedSkillSource[]> {
    const generation = await this.registry.generation(generationNumber);
    const skills: ManagedSkillSource[] = [];
    for (const entry of generation.entries) {
      if (!this.inScope(entry.scope) || !entry.packageDigest) continue;
      for (const component of entry.components) {
        if (component.kind !== "skill") continue;
        skills.push({
          extensionId: entry.extensionId,
          versionId: entry.versionId,
          name: component.skillName,
          description: component.description,
          scope: entry.scope.kind,
          directory: join(this.packages.packageDirectory(entry.packageDigest), ...component.packagePath.split("/").filter(Boolean)),
          packageDigest: entry.packageDigest,
          generation: generation.generation,
        });
      }
    }
    return skills;
  }

  /** Managed MCP servers visible to this project in a generation (immutable entries). */
  async managedMcpServers(generationNumber: number): Promise<ManagedMcpServerEntry[]> {
    const generation = await this.registry.generation(generationNumber);
    const registry = await this.registry.load();
    return generation.entries.filter((entry) => this.inScope(entry.scope)).flatMap((entry) => entry.components
      .filter((component): component is McpServerComponent => component.kind === "mcp_server")
      .map((component) => ({ extensionId: entry.extensionId, versionId: entry.versionId, generation: generation.generation, component,
        toolPolicy: entry.toolPolicy ?? (registry.migrations.includes("extension-tool-policy-v1-to-v2") ? legacyToolPolicy(entry.versionId, entry.components) : defaultToolPolicy(entry.versionId)),
        pinnedApproval: entry.toolApprovalOverride ?? (!entry.toolPolicy ? registry.legacyToolApprovals[entry.extensionId] : undefined) ?? component.toolApproval ?? "all" })));
  }

  /**
   * Runner extensions of enabled plugins in the current generation. They are only loaded when the
   * Runner starts with no unfinished Build (an active Build's capability contract must not change).
   */
  async stagedRunnerExtensions(): Promise<StagedRunnerExtension[]> {
    const registry = await this.registry.load();
    if (registry.currentGeneration === 0) return [];
    const generation = await this.registry.generation(registry.currentGeneration);
    return generation.entries.filter((entry) => this.inScope(entry.scope) && entry.packageDigest).flatMap((entry) => entry.components
      .filter((component): component is RunnerExtensionComponent => component.kind === "runner_extension")
      .map((component) => ({
        pluginId: entry.extensionId,
        extensionId: component.extensionId,
        manifestDigest: component.manifestDigest,
        directory: join(this.packages.packageDirectory(entry.packageDigest!), ...component.packagePath.split("/").filter(Boolean)),
      })));
  }

  /** Live revocation, independent of the immutable capability snapshot of an active Build. */
  async runnerExtensionAllowed(extensionId: string): Promise<boolean> {
    const registry = await this.registry.load();
    const owners = registry.extensions.filter(entry => registry.versions.some(version =>
      version.extensionId === entry.id && version.components.some(component => component.kind === "runner_extension" && component.extensionId === extensionId)));
    // Operator-configured extensions are governed by their existing configuration.
    if (!owners.length) return true;
    return owners.some(entry => entry.enabled && !entry.removedAt && registry.versions.some(version =>
      version.versionId === entry.currentVersionId && version.components.some(component => component.kind === "runner_extension" && component.extensionId === extensionId)));
  }

  /** Current tool policy and credential names for a managed server (Settings may change policy). */
  async extensionRecord(extensionId: string): Promise<InstalledExtension | undefined> {
    return (await this.registry.load()).extensions.find((entry) => entry.id === extensionId && !entry.removedAt);
  }

  // ---- Execution ------------------------------------------------------------------------------------

  private async execute(operationId: string): Promise<ExtensionOperation> {
    const existing = this.running.get(operationId);
    if (existing) return await existing;
    const run = this.runStages(operationId).finally(() => this.running.delete(operationId));
    this.running.set(operationId, run);
    return await run;
  }

  private async runStages(operationId: string): Promise<ExtensionOperation> {
    let operation = (await this.registry.operations()).find((entry) => entry.id === operationId);
    if (!operation?.plan) throw new ExtensionManagementError("operation_not_found", "No such operation.", 404);
    const plan = operation.plan;
    try {
      if (!operation.authorizationRef || !this.authorizer.verify(operation.authorizationRef, plan)) {
        // Receipts are in-memory; after a Runner restart an approved-but-unstarted change needs a fresh approval.
        return publicOperation(await this.update(operationId, (current) => ({
          ...this.advance(current, "await_authorization"), outcome: "awaiting_user",
          userAction: { kind: "approve", reason: "Approval is needed again because the Runner restarted or the approval expired.", planDigest: plan.planDigest, summary: plan.access },
        })));
      }
      const missing = this.missingCredentials(plan);
      if (missing.length && plan.action !== "disable" && plan.action !== "remove") {
        return publicOperation(await this.update(operationId, (current) => ({
          ...this.advance(current, "await_credentials"), outcome: "awaiting_user",
          userAction: { kind: "credential", reason: `Enter ${missing.join(", ")} in the secure field; it is stored on the Runner and never shown to models.`, names: missing },
        })));
      }
      switch (plan.action) {
        case "install":
        case "update": operation = await this.install(operationId, plan); break;
        case "enable":
        case "disable": operation = await this.setEnabled(operationId, plan, plan.action === "enable"); break;
        case "remove": operation = await this.remove(operationId, plan); break;
        case "rollback": operation = await this.rollback(operationId, plan); break;
        default: throw new ExtensionManagementError("action_unsupported", `${plan.action} is not supported by apply_change.`);
      }
      return publicOperation(operation);
    } catch (error) {
      const failed = await this.update(operationId, (current) => current.outcome === "running" ? this.finish(current, current.stage === "install_dependencies" ? "outcome_unknown" : "failed", describe(error)) : current);
      return publicOperation(failed);
    }
  }

  private async install(operationId: string, plan: ExtensionChangePlan): Promise<ExtensionOperation> {
    let components = plan.components;
    let packageDigest = plan.packageDigest;
    await this.update(operationId, (current) => this.advance(current, "stage"));
    if (packageDigest) {
      // The committed copy must still be exactly what was inspected and authorized.
      const stored = await snapshotDirectory(this.packages.packageDirectory(packageDigest));
      if (stored.digest !== packageDigest) throw new ExtensionManagementError("package_store_corrupt", "Stored package does not match the authorized digest.", 500);
    }
    const handler = this.handlers.find((candidate) => candidate.kind === plan.kind);
    const extensionId = plan.extensionId!;
    if (handler?.install) {
      await this.update(operationId, (current) => this.advance(current, "install_dependencies"));
      const controller = new AbortController();
      const result = await handler.install(plan, { packages: this.packages, signal: controller.signal, extensionId, report: async (note) => { await this.update(operationId, (current) => ({ ...current, progress: [...current.progress, { stage: current.stage, at: this.now().toISOString(), note: bounded(note) }].slice(-64), updatedAt: this.now().toISOString() })); } });
      components = result.components;
      packageDigest = result.packageDigest ?? packageDigest;
    }
    await this.update(operationId, (current) => this.advance(current, "validate"));
    if (plan.kind === "skill") {
      const checked = discoverSkills(await snapshotDirectory(this.packages.packageDirectory(packageDigest!)));
      const component = checked.skills[0]?.component;
      if (checked.skills.length !== 1 || !component || component.skillName !== plan.name) throw new ExtensionManagementError("skill_invalid", `Stored skill failed validation: ${checked.invalid.flatMap((entry) => entry.errors).join("; ") || "unexpected content"}.`);
    }
    const now = this.now().toISOString();
    const version: ExtensionVersion = Object.freeze({
      versionId: `ver_${randomUUID()}`,
      extensionId,
      ...(plan.version ? { version: plan.version } : {}),
      source: plan.source!,
      ...(packageDigest ? { packageDigest } : {}),
      components,
      createdAt: now,
      operationId,
      ...(plan.dependencies?.length ? { dependencies: plan.dependencies } : {}),
    });
    const readinessBefore: ExtensionReadiness = { state: "installed", checkedAt: now };
    if (plan.dependencies?.length) this.assertDependencies((await this.registry.load()).extensions, plan.dependencies, plan.scope);
    await this.update(operationId, (current) => this.advance(current, "commit"));
    const baseGeneration = await this.registry.mutate((state) => {
      const prior = state.extension(extensionId);
      state.putVersion(version);
      const previous = prior?.currentVersionId && !prior.removedAt ? [...prior.previousVersionIds, prior.currentVersionId].slice(-5) : prior?.previousVersionIds ?? [];
      state.putExtension({
        id: extensionId, kind: plan.kind, name: plan.name, scope: plan.scope, provenance: "managed", source: plan.source!,
        currentVersionId: version.versionId, enabled: true,
        desiredGeneration: state.registry.currentGeneration + 1,
        ...(prior?.activeGeneration !== undefined ? { activeGeneration: prior.activeGeneration } : {}),
        readiness: readinessBefore,
        componentIds: components.map((component) => component.componentId),
        credentialRefs: prior?.credentialRefs ?? this.options.credentials.list(extensionId).map((entry) => entry.ref),
        previousVersionIds: previous,
        referencedBy: prior?.referencedBy ?? [],
        installedAt: prior && !prior.removedAt ? prior.installedAt : now,
        updatedAt: now,
      });
      relinkDependencies(state, extensionId, version.dependencies ?? [], now);
      const advanced = state.operation(operationId);
      if (advanced) state.putOperation(this.advance(advanced, "activate"));
      return state.registry.currentGeneration;
    });
    return await this.finalizeReadiness(operationId, extensionId, version, baseGeneration, plan.action === "update" ? previousVersionOf(await this.registry.load(), extensionId) : undefined, true);
  }

  /**
   * Readiness after activation. When an update's check fails, the previous working version is restored
   * in a new generation, so the last working state stays usable.
   */
  /** Approving an install/enable reviews the inventory discovered at that moment for local use. */
  private applyApprovedToolReview(state: MutableRegistryState, extensionId: string, version: ExtensionVersion): boolean {
    const discovery = state.registry.toolDiscoveries[extensionId];
    const discovered = discovery?.versionId === version.versionId ? discovery.components : [];
    if (!discovered.length) return false;
    const existing = state.registry.toolPolicies[extensionId];
    const prior = existing?.versionId === version.versionId ? existing : undefined;
    // Curated catalog policies and explicit per-tool decisions on this inventory still win.
    if (prior && prior.riskLabel !== "unreviewed") return false;
    const canonical = (items: readonly ExtensionToolInventory[]) => JSON.stringify([...items].sort((a, b) => a.componentId.localeCompare(b.componentId)).map((item) => ({ ...item, toolNames: [...item.toolNames].sort() })));
    if (prior && canonical(prior.reviewed) === canonical(discovered)) return false;
    const policy: ExtensionToolPolicy = { version: 1, versionId: version.versionId, reviewed: discovered,
      // Explicit user denies outlive inventory and version changes; deny wins over this allow list.
      toolFilter: { default: "deny", allow: discovered.flatMap((item) => item.toolNames.map((toolName) => ({ componentId: item.componentId, toolName }))), deny: [...(existing?.toolFilter.deny ?? [])] },
      remoteExposure: false, riskLabel: prior?.riskLabel ?? "unreviewed" };
    state.setToolPolicy(extensionId, policy);
    return true;
  }

  private async finalizeReadiness(operationId: string, extensionId: string, version: ExtensionVersion, generation: number, previousVersionId: string | undefined, publishPending = false): Promise<ExtensionOperation> {
    const extension = (await this.registry.load()).extensions.find((entry) => entry.id === extensionId)!;
    const readiness = await this.checkReadiness(extension, version);
    if (readiness.state === "failed" && previousVersionId) {
      const now = this.now().toISOString();
      const restored = await this.registry.mutate((state) => {
        const current = state.extension(extensionId)!;
        state.putExtension({ ...current, currentVersionId: previousVersionId, previousVersionIds: current.previousVersionIds.filter((id) => id !== previousVersionId), readiness: { ...readiness, detail: `Update failed its check; restored the previous version. ${readiness.detail ?? ""}`.trim() }, updatedAt: now });
        relinkDependencies(state, extensionId, state.version(previousVersionId)?.dependencies ?? [], now);
        const restoredGeneration = state.publishGeneration(operationId, now);
        const op = state.operation(operationId)!;
        const next: ExtensionOperation = { ...this.finish({ ...this.advance(op, "rollback") }, "rolled_back", readiness.lastError?.message ?? readiness.detail ?? "Readiness check failed."), result: { extensionId, versionId: previousVersionId, generation: restoredGeneration.generation, readiness } };
        state.putOperation(next);
        return next;
      });
      this.emit({ type: "generation", generation: restored.result?.generation ?? generation });
      this.emit({ type: "operation", operation: publicOperation(restored) });
      return restored;
    }
    const signIn = version.components.find((component): component is McpServerComponent => component.kind === "mcp_server" && component.auth === "oauth");
    if (readiness.state === "needs_auth" && signIn) {
      // The same operation waits for the user's sign-in; the callback resumes it (resumeAfterSignIn).
      const waiting = await this.registry.mutate((state) => {
        const effective = publishPending ? state.publishGeneration(operationId, this.now().toISOString()).generation : generation;
        const current = state.extension(extensionId)!;
        state.putExtension({ ...current, readiness, activeGeneration: effective, updatedAt: this.now().toISOString() });
        const op = state.operation(operationId)!;
        const next: ExtensionOperation = {
          ...this.advance(op, "await_sign_in"), outcome: "awaiting_user",
          userAction: { kind: "sign_in", reason: readiness.detail ?? "Sign in to finish connecting.", server: signIn.serverName },
          result: { extensionId, versionId: version.versionId, generation: effective, readiness },
        };
        state.putOperation(next);
        return next;
      });
      this.emit({ type: "generation", generation: waiting.result?.generation ?? generation });
      this.emit({ type: "operation", operation: publicOperation(waiting) });
      return waiting;
    }
    const finished = await this.registry.mutate((state) => {
      const reviewed = readiness.state === "ready" ? this.applyApprovedToolReview(state, extensionId, version) : false;
      const effective = publishPending || reviewed ? state.publishGeneration(operationId, this.now().toISOString()).generation : generation;
      const current = state.extension(extensionId)!;
      state.putExtension({ ...current, readiness, activeGeneration: effective, updatedAt: this.now().toISOString() });
      const op = state.operation(operationId)!;
      const outcome = readiness.state === "failed" ? "failed" : "succeeded";
      const next: ExtensionOperation = { ...this.finish(this.advance(op, "ready"), outcome, readiness.state === "failed" ? (readiness.lastError?.message ?? "Readiness check failed.") : undefined), result: { extensionId, versionId: version.versionId, generation: effective, readiness } };
      state.putOperation(next);
      return next;
    });
    this.emit({ type: "generation", generation: finished.result?.generation ?? generation });
    this.emit({ type: "operation", operation: publicOperation(finished) });
    return finished;
  }

  private async setEnabled(operationId: string, plan: ExtensionChangePlan, enabled: boolean): Promise<ExtensionOperation> {
    const extensionId = plan.extensionId!;
    await this.update(operationId, (current) => this.advance(current, "commit"));
    const registry = await this.registry.load();
    const prior = registry.extensions.find((entry) => entry.id === extensionId);
    const version = registry.versions.find((entry) => entry.versionId === prior?.currentVersionId);
    if (!enabled && prior && version) await this.handlerFor(prior.kind)?.release?.(prior, version).catch(() => undefined);
    const now = this.now().toISOString();
    if (enabled && version) {
      const baseGeneration = await this.registry.mutate((state) => {
        const current = state.extension(extensionId);
        if (!current) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
        state.putExtension({ ...current, enabled, desiredGeneration: state.registry.currentGeneration + 1, readiness: { state: "enabled", checkedAt: now }, updatedAt: now });
        return state.registry.currentGeneration;
      });
      return await this.finalizeReadiness(operationId, extensionId, version, baseGeneration, undefined, true);
    }
    const generation = await this.registry.mutate((state) => {
      const current = state.extension(extensionId);
      if (!current) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
      state.putExtension({ ...current, enabled, desiredGeneration: state.registry.currentGeneration + 1, readiness: { state: "disabled", checkedAt: now }, updatedAt: now });
      return state.publishGeneration(operationId, now);
    });
    return await this.completeSimple(operationId, extensionId, generation.generation, { state: "disabled", checkedAt: now });
  }

  private async remove(operationId: string, plan: ExtensionChangePlan): Promise<ExtensionOperation> {
    const extensionId = plan.extensionId!;
    await this.update(operationId, (current) => this.advance(current, "commit"));
    const registry = await this.registry.load();
    const prior = registry.extensions.find((entry) => entry.id === extensionId);
    if (prior?.referencedBy.length) throw new ExtensionManagementError("extension_in_use", `"${prior.name}" is used by ${prior.referencedBy.join(", ")}; remove those first.`, 409);
    const version = registry.versions.find((entry) => entry.versionId === prior?.currentVersionId);
    if (prior && version) await this.handlerFor(prior.kind)?.release?.(prior, version).catch(() => undefined);
    const now = this.now().toISOString();
    const generation = await this.registry.mutate((state) => {
      const current = state.extension(extensionId);
      if (!current) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
      // A bounded tombstone remains for audit; credentials are revoked only by the explicit control.
      state.putExtension({ ...current, enabled: false, removedAt: now, readiness: { state: "disabled", checkedAt: now, detail: "Removed." }, updatedAt: now });
      relinkDependencies(state, extensionId, [], now);
      return state.publishGeneration(operationId, now);
    });
    await this.collectPackages();
    return await this.completeSimple(operationId, extensionId, generation.generation, { state: "disabled", checkedAt: now, detail: "Removed." });
  }

  private async rollback(operationId: string, plan: ExtensionChangePlan): Promise<ExtensionOperation> {
    const extensionId = plan.extensionId!;
    const target = plan.targetVersionId!;
    await this.update(operationId, (current) => this.advance(current, "commit"));
    const now = this.now().toISOString();
    const baseGeneration = await this.registry.mutate((state) => {
      const current = state.extension(extensionId);
      if (!current || !current.previousVersionIds.includes(target)) throw new ExtensionManagementError("rollback_unavailable", "That version is no longer available.", 409);
      const previous = [...current.previousVersionIds.filter((id) => id !== target), ...(current.currentVersionId ? [current.currentVersionId] : [])].slice(-5);
      state.putExtension({ ...current, currentVersionId: target, previousVersionIds: previous, enabled: true, desiredGeneration: state.registry.currentGeneration + 1, updatedAt: now });
      relinkDependencies(state, extensionId, state.version(target)?.dependencies ?? [], now);
      return state.registry.currentGeneration;
    });
    const version = (await this.registry.load()).versions.find((entry) => entry.versionId === target)!;
    return await this.finalizeReadiness(operationId, extensionId, version, baseGeneration, undefined, true);
  }

  private async completeSimple(operationId: string, extensionId: string, generation: number, readiness: ExtensionReadiness): Promise<ExtensionOperation> {
    const finished = await this.registry.mutate((state) => {
      const extension = state.extension(extensionId);
      if (extension) state.putExtension({ ...extension, activeGeneration: generation, updatedAt: this.now().toISOString() });
      const op = state.operation(operationId)!;
      const next: ExtensionOperation = { ...this.finish(this.advance(op, "ready"), "succeeded"), result: { extensionId, generation, readiness } };
      state.putOperation(next);
      return next;
    });
    this.emit({ type: "generation", generation });
    this.emit({ type: "operation", operation: publicOperation(finished) });
    return finished;
  }

  private async checkReadiness(extension: InstalledExtension, version: ExtensionVersion): Promise<ExtensionReadiness> {
    const now = this.now().toISOString();
    if (!extension.enabled) return { state: "disabled", checkedAt: now };
    if (extension.kind === "skill") {
      // Ready means a real read of the stored instructions parses, not that files were copied.
      try {
        const component = version.components.find((entry): entry is SkillComponent => entry.kind === "skill")!;
        const text = await this.packages.read(version.packageDigest!, [component.packagePath, "SKILL.md"].filter(Boolean).join("/"), EXTENSION_LIMITS.maxSkillResourceBytes);
        const checked = discoverSkills(singleFileSkillTree(text));
        if (checked.skills[0]?.component.skillName !== component.skillName) throw new Error("Stored instructions no longer match the installed skill.");
        return { state: "ready", checkedAt: now };
      } catch (error) {
        return { state: "failed", checkedAt: now, lastError: { code: "skill_unreadable", message: describe(error), at: now } };
      }
    }
    const handler = this.handlerFor(extension.kind);
    if (!handler?.check) return { state: "unsupported", checkedAt: now, detail: `${extension.kind} readiness checks are unavailable on this Runner.` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      return await handler.check(extension, version, { packages: this.packages, credentials: this.options.credentials, signal: controller.signal });
    } catch (error) {
      return { state: "failed", checkedAt: now, lastError: { code: "readiness_check_failed", message: describe(error), at: now } };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Recovery -------------------------------------------------------------------------------------

  /**
   * After a restart: read-only stages are safe to fail and retry; dependency installation (executable
   * work) becomes outcome_unknown; a committed registry change is completed rather than redone.
   */
  private async recover(): Promise<void> {
    if (!(await this.registry.operations()).some((operation) => operation.outcome === "running")) return;
    const registry = await this.registry.load();
    await this.registry.mutate((state) => {
      for (const operation of state.operations) {
        if (operation.outcome !== "running") continue;
        const committed = operation.plan?.extensionId && registry.versions.some((version) => version.operationId === operation.id);
        if (committed || operation.stage === "activate" || operation.stage === "ready") {
          state.putOperation({ ...this.finish(operation, "succeeded", "Completed during Runner restart recovery; readiness is re-checked on use."), diagnostics: [...operation.diagnostics, "recovered_after_commit"].slice(-EXTENSION_LIMITS.maxDiagnostics) });
        } else if (operation.stage === "install_dependencies") {
          state.putOperation(this.finish(operation, "outcome_unknown", "The Runner stopped while installing dependencies; the result is unknown. Plan the change again to retry."));
        } else {
          state.putOperation(this.finish(operation, "failed", "Interrupted before anything was committed; safe to retry."));
        }
      }
    });
  }

  /** A replayed operation key: report the stored outcome; resume only work that is safe to resume. */
  private async reconcile(operation: ExtensionOperation): Promise<ExtensionOperation> {
    if (operation.outcome === "running" && !this.running.has(operation.id)) return publicOperation(operation);
    if (this.running.has(operation.id)) return await this.running.get(operation.id)!;
    return publicOperation(operation);
  }

  // ---- Helpers --------------------------------------------------------------------------------------

  private async update(operationId: string, change: (operation: ExtensionOperation) => ExtensionOperation): Promise<ExtensionOperation> {
    const next = await this.registry.mutate((state) => {
      const current = state.operation(operationId);
      if (!current) throw new ExtensionManagementError("operation_not_found", "No such operation.", 404);
      const updated = change(current);
      if (updated !== current) state.putOperation(updated);
      return updated;
    });
    this.emit({ type: "operation", operation: publicOperation(next) });
    return next;
  }

  private advance(operation: ExtensionOperation, stage: OperationStage, extra: Partial<ExtensionOperation> = {}): ExtensionOperation {
    const now = this.now().toISOString();
    const { userAction: _cleared, ...rest } = operation;
    return { ...rest, ...extra, stage, outcome: "running", progress: [...operation.progress, { stage, at: now }].slice(-64), updatedAt: now };
  }

  private finish(operation: ExtensionOperation, outcome: ExtensionOperation["outcome"], diagnostic?: string): ExtensionOperation {
    const { userAction: _cleared, ...rest } = operation;
    return { ...rest, outcome, diagnostics: diagnostic ? [...operation.diagnostics, bounded(diagnostic)].slice(-EXTENSION_LIMITS.maxDiagnostics) : operation.diagnostics, updatedAt: this.now().toISOString() };
  }

  private missingCredentials(plan: ExtensionChangePlan): string[] {
    if (!plan.extensionId) return [];
    const stored = new Set(this.options.credentials.list(plan.extensionId).map((entry) => entry.name));
    return plan.requiredCredentials.filter((name) => !stored.has(name));
  }

  private declaredCredentialNames(extension: InstalledExtension, versions: readonly ExtensionVersion[]): string[] {
    const version = versions.find((entry) => entry.versionId === extension.currentVersionId);
    return (version?.components ?? []).flatMap((component) => component.kind === "mcp_server" ? component.environment.map((entry) => entry.name) : []);
  }

  private assertDependencies(extensions: readonly InstalledExtension[], dependencies: readonly ExtensionDependency[], scope: ExtensionScope): void {
    for (const dependency of dependencies) {
      const found = extensions.some((entry) => !entry.removedAt && entry.kind === dependency.kind && entry.name === dependency.name && (entry.scope.kind === "user" || sameScope(entry.scope, scope)));
      if (!found) throw new ExtensionManagementError("dependency_missing", `This plugin uses the ${dependency.kind === "skill" ? "skill" : "MCP server"} "${dependency.name}", which is not installed here; install it first.`, 409);
    }
  }

  private handlerFor(kind: ExtensionKind): ExtensionKindHandler | undefined {
    return this.handlers.find((handler) => handler.kind === kind);
  }

  private async collectPackages(): Promise<void> {
    const registry = await this.registry.load();
    const retained = new Set<string>();
    const live = registry.extensions.filter((entry) => !entry.removedAt);
    for (const entry of live) {
      for (const id of [entry.currentVersionId, ...entry.previousVersionIds]) {
        const digest = registry.versions.find((version) => version.versionId === id)?.packageDigest;
        if (digest) retained.add(digest);
      }
    }
    // Versions bound by a pinned (in-use) generation are deferred, never deleted under an active run.
    const pinned = new Set([...(this.options.pinnedGenerations?.() ?? []), registry.currentGeneration]);
    for (const generation of pinned) {
      try { for (const entry of (await this.registry.generation(generation)).entries) if (entry.packageDigest) retained.add(entry.packageDigest); } catch { /* missing generation: nothing pinned */ }
    }
    for (const operation of await this.registry.operations()) if ((operation.outcome === "running" || operation.outcome === "awaiting_user") && operation.plan?.packageDigest) retained.add(operation.plan.packageDigest);
    await this.packages.collect(retained);
  }

  private describe(entry: InstalledExtension, versions: readonly ExtensionVersion[]): ExtensionInventoryItem {
    const version = versions.find((candidate) => candidate.versionId === entry.currentVersionId);
    return {
      ...entry,
      ...(version ? { currentVersion: { versionId: version.versionId, ...(version.version ? { version: version.version } : {}), source: version.source, createdAt: version.createdAt, components: version.components, ...(version.packageDigest ? { packageDigest: version.packageDigest } : {}), ...(version.dependencies?.length ? { dependencies: version.dependencies } : {}) } } : {}),
      previousVersions: entry.previousVersionIds.map((id) => versions.find((candidate) => candidate.versionId === id)).filter((value): value is ExtensionVersion => value !== undefined)
        .map((value) => ({ versionId: value.versionId, ...(value.version ? { version: value.version } : {}), createdAt: value.createdAt, source: value.source })),
      credentials: this.options.credentials.list(entry.id).map((credential) => ({ name: credential.name, ref: credential.ref, updatedAt: credential.updatedAt })),
    };
  }

  private async shadowWarning(name: string): Promise<string | undefined> {
    const external = this.options.external ? await this.options.external().catch(() => []) : [];
    const clash = external.find((item) => item.kind === "skill" && item.name === name);
    if (!clash) return undefined;
    return clash.provenance === "project"
      ? `A project skill named "${name}" exists and keeps precedence; this one is listed but not preferred.`
      : `Another skill named "${name}" exists (${clash.provenance}); the managed one takes precedence over it.`;
  }

  private humanNamed(conversationId: string, name: string): boolean {
    return this.authorizer.humanMentioned(conversationId, name);
  }

  private inScope(scope: ExtensionScope): boolean {
    return scope.kind === "user" || scope.projectIdentity === this.projectIdentity;
  }

  private assertScope(scope: ExtensionScope): void {
    if (!this.inScope(scope)) throw new ExtensionManagementError("scope_unavailable", "This Runner serves a different project.", 403);
  }

  private assertSourceAllowed(request: SourceRequest, caller: ManagementCaller): void {
    if (caller.kind === "agent" && request.type === "upload") throw new ExtensionManagementError("ui_only", "Uploads are added from Settings.", 403);
  }

  /** Agents may name local folders only inside their workspace or ones the human named in this conversation. */
  private assertAgentLocalSource(canonical: string, caller: Extract<ManagementCaller, { kind: "agent" }>): void {
    if (caller.workspaceRoot && isWithin(resolve(caller.workspaceRoot), canonical)) return;
    if (isWithin(this.canonicalProjectRoot, canonical)) return;
    const key = sourceKey({ type: "local_directory", path: canonical });
    const named = caller.conversationId && this.authorizer.intentsFor(caller.conversationId).some((intent) => intent.sourceKeys.some((granted) => granted === key || key.startsWith(`${granted}/`)));
    if (!named) throw new ExtensionManagementError("source_not_permitted", "That folder is outside the project and you were not asked to use it; ask the user to name it or add it in Settings.", 403);
  }

  private pruneUploads(): void {
    const cutoff = Date.now() - UPLOAD_TTL_MS;
    for (const [id, upload] of this.uploads) {
      if (upload.createdAt < cutoff || this.uploads.size > MAX_UPLOADS) { this.uploads.delete(id); void rm(upload.path, { force: true }); }
    }
  }

  private emit(event: ExtensionServiceEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listeners never break the operation */ }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export type ExtensionServiceEvent =
  | { readonly type: "operation"; readonly operation: ExtensionOperation }
  | { readonly type: "generation"; readonly generation: number };

export type PlanRequest =
  | { readonly action: "install" | "update"; readonly inspectionId: string; readonly componentIds?: readonly string[]; readonly scope?: ExtensionScope; readonly name?: string }
  | { readonly action: Exclude<OperationAction, "install" | "update" | "test" | "adopt" | "migrate" | "revoke_credentials">; readonly extensionId: string; readonly versionId?: string };

export interface ExtensionInventoryItem extends InstalledExtension {
  readonly currentVersion?: Readonly<{ versionId: string; version?: string; source: ResolvedSource; createdAt: string; components: readonly ExtensionComponent[]; packageDigest?: string; dependencies?: readonly ExtensionDependency[] }>;
  readonly previousVersions: readonly Readonly<{ versionId: string; version?: string; createdAt: string; source: ResolvedSource }>[];
  readonly credentials: readonly Readonly<{ name: string; ref: string; updatedAt: string }>[];
}

export interface ExtensionInventory {
  readonly currentGeneration: number;
  readonly projectIdentity: string;
  readonly policy: InstallPolicy;
  readonly items: readonly ExtensionInventoryItem[];
  readonly external: readonly ExternalItem[];
  readonly pendingOperations: readonly ExtensionOperation[];
}

export interface ManagedSkillSource {
  readonly extensionId: string;
  readonly versionId: string;
  readonly name: string;
  readonly description: string;
  readonly scope: "user" | "project";
  /** Immutable store directory holding SKILL.md and its resources. */
  readonly directory: string;
  readonly packageDigest: string;
  readonly generation: number;
}

/**
 * Points every installed dependency's referencedBy at the plugin exactly when the plugin's current
 * version uses it, so a shared dependency cannot be removed while a plugin needs it.
 */
function relinkDependencies(state: MutableRegistryState, pluginId: string, dependencies: readonly ExtensionDependency[], now: string): void {
  const plugin = state.extension(pluginId);
  for (const entry of state.registry.extensions) {
    if (entry.id === pluginId) continue;
    const used = !plugin?.removedAt && dependencies.some((dependency) => dependency.kind === entry.kind && dependency.name === entry.name) && !entry.removedAt &&
      (entry.scope.kind === "user" || (plugin !== undefined && sameScope(entry.scope, plugin.scope)));
    const has = entry.referencedBy.includes(pluginId);
    if (used === has) continue;
    state.putExtension({ ...entry, referencedBy: used ? [...entry.referencedBy, pluginId] : entry.referencedBy.filter((id) => id !== pluginId), updatedAt: now });
  }
}

export interface StagedRunnerExtension {
  readonly pluginId: string;
  readonly extensionId: string;
  readonly manifestDigest: string;
  readonly directory: string;
}

export interface ExtensionToolPolicyView {
  readonly policy: ExtensionToolPolicy;
  readonly discovered: readonly ExtensionToolInventory[];
  readonly currentGeneration: number;
  readonly unsupported: boolean;
}

export interface ManagedMcpServerEntry {
  readonly extensionId: string;
  readonly versionId: string;
  readonly generation: number;
  readonly component: McpServerComponent;
  readonly toolPolicy?: ExtensionToolPolicy;
  readonly pinnedApproval?: "all" | "non_destructive";
}

export const NO_ACCESS: AccessSummary = Object.freeze({ executesCode: "never", network: Object.freeze([]), filesystem: "No new access.", credentials: Object.freeze([]), notes: Object.freeze([]) });

export function projectIdentityFor(canonicalProjectRoot: string): string {
  const normalized = process.platform === "win32" ? canonicalProjectRoot.toLowerCase() : canonicalProjectRoot;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function extensionIdFor(kind: ExtensionKind, scope: ExtensionScope, name: string): string {
  return `ext_${createHash("sha256").update(`${kind}\0${scopeKey(scope)}\0${name}`).digest("hex").slice(0, 24)}`;
}

/** Instruction-only skills: what installing and using them can do. */
function inspectSkills(tree: PackageTree, source: ResolvedSource): HandlerInspection {
  const found = discoverSkills(tree);
  if (found.skills.length === 0) {
    const unsupported = unsupportedFormat(tree);
    throw new ExtensionManagementError(unsupported ? "format_unsupported" : "no_skills_found",
      unsupported ?? (found.invalid.length ? `No valid skills: ${found.invalid.map((entry) => `${entry.path}: ${entry.errors.join(" ")}`).join("; ")}` : "No SKILL.md or aiboard-plugin.json was found in this source."));
  }
  const names = new Map<string, number>();
  for (const skill of found.skills) names.set(skill.component.skillName, (names.get(skill.component.skillName) ?? 0) + 1);
  const duplicates = [...names].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicates.length) throw new ExtensionManagementError("package_name_collision", `Several skills share the name ${duplicates.join(", ")}.`);
  return {
    kind: "skill",
    source,
    ...(found.skills.length === 1 ? { name: found.skills[0].component.skillName } : {}),
    components: found.skills.map((skill) => skill.component),
    invalid: found.invalid,
    warnings: [],
    access: {
      executesCode: "never",
      network: [],
      filesystem: "Instructions and resources are read on demand. Scripts never run at install; using one is an ordinary governed command.",
      credentials: [],
      notes: ["Skill text is guidance only; it cannot raise permissions or install software."],
    },
    requiresExecutableTrust: false,
    trees: new Map(found.skills.map((skill) => [skill.component.componentId, skill.tree])),
  };
}

/** Known plugin formats from other applications: explained, never silently half-installed. */
export function unsupportedFormat(tree: PackageTree): string | undefined {
  const paths = new Set(tree.files.map((file) => file.path));
  if (paths.has(".claude-plugin/plugin.json") || paths.has(".claude-plugin/marketplace.json")) return "This is a Claude Code plugin. AI Board installs its skills only when they are standard SKILL.md folders; hooks, commands and agents are not supported. Point at a skills subfolder instead.";
  if (paths.has(".codex-plugin/plugin.json") || paths.has("codex-plugin.json")) return "This is a Codex plugin, which AI Board does not support; install its skills folder directly.";
  if (paths.has("manifest.json") && paths.has("server/index.js")) return "This looks like a desktop extension bundle (.dxt/.mcpb); register its MCP server command instead.";
  return undefined;
}

function selectSkillComponent(components: readonly SkillComponent[], requested: readonly string[] | undefined): { kind: "selected"; component: SkillComponent } | { kind: "choose"; options: string[] } {
  if (requested?.length) {
    if (requested.length !== 1) throw new ExtensionManagementError("selection_invalid", "Install one skill per change.");
    const component = components.find((entry) => entry.componentId === requested[0] || entry.skillName === requested[0]);
    if (!component) throw new ExtensionManagementError("selection_invalid", `${requested[0]} is not a skill in this source.`);
    return { kind: "selected", component };
  }
  if (components.length === 1) return { kind: "selected", component: components[0] };
  return { kind: "choose", options: components.map((entry) => entry.skillName) };
}

/** Points provenance at the selected skill folder inside a multi-skill source. */
function narrowSource(source: ResolvedSource, packagePath: string, treeDigest: string): ResolvedSource {
  if (!packagePath) return source;
  switch (source.type) {
    case "git": return { ...source, subdirectory: [source.subdirectory, packagePath].filter(Boolean).join("/"), treeDigest };
    case "local_directory": return { ...source, path: join(source.path, ...packagePath.split("/")), treeDigest };
    case "archive": return { ...source, treeDigest };
    default: return source;
  }
}

function accessFor(components: readonly ExtensionComponent[]): AccessSummary {
  if (!components.some(isExecutableComponent)) return NO_ACCESS;
  return { executesCode: "on_use", network: [], filesystem: "Runs with the access configured for its server.", credentials: components.flatMap((component) => component.kind === "mcp_server" ? component.environment.map((entry) => entry.name) : []), notes: [] };
}

export function isExecutableComponent(component: ExtensionComponent): boolean {
  return component.kind === "runner_extension" || (component.kind === "mcp_server" && component.route === "runner" && component.transport === "stdio");
}

function previousVersionOf(registry: Awaited<ReturnType<ExtensionRegistryStore["load"]>>, extensionId: string): string | undefined {
  return registry.extensions.find((entry) => entry.id === extensionId)?.previousVersionIds.at(-1);
}

function planDigest(plan: Omit<ExtensionChangePlan, "planDigest">): string {
  const { planId: _id, createdAt: _created, expiresAt: _expires, ...core } = plan;
  return sha256(JSON.stringify(core));
}

function ownerOf(caller: ManagementCaller): OperationOwner {
  return caller.kind === "ui" ? { kind: "ui" } : { kind: "agent", runId: caller.runId, sessionId: caller.sessionId, actorRole: caller.actorRole, actorId: caller.actorId };
}

function callerKey(caller: ManagementCaller): string {
  return caller.kind === "ui" ? "ui" : `agent:${caller.runId}:${caller.sessionId}`;
}

/** Operation view for UI and models: the plan is summarized; nothing secret is ever in an operation. */
export function publicOperation(operation: ExtensionOperation): ExtensionOperation {
  return operation;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function bounded(text: string): string {
  return text.length > EXTENSION_LIMITS.maxDiagnosticChars ? `${text.slice(0, EXTENSION_LIMITS.maxDiagnosticChars)}…` : text;
}

function describe(error: unknown): string {
  return bounded(error instanceof Error ? (error instanceof ExtensionManagementError ? `${error.code}: ${error.message}` : error.message) : String(error));
}
