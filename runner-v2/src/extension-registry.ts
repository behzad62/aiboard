import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  DEFAULT_INSTALL_POLICY,
  EXTENSION_LIMITS,
  EXTENSION_REGISTRY_SCHEMA_VERSION,
  ExtensionManagementError,
  parseScope,
  validateExtensionToolPolicy,
  type ExtensionToolPolicy,
  type ExtensionToolInventory,
  type ExtensionComponent,
  type ExtensionGeneration,
  type ExtensionOperation,
  type ExtensionRegistryDocument,
  type InstalledExtension,
  type InstallPolicy,
  type ExtensionVersion,
} from "./extension-management-contracts.js";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

/**
 * Durable, versioned registry outside any project. Writers serialize through a directory lock (several
 * runners may share one user home) and publish by atomic rename. Generation snapshots are immutable
 * files: once written they are never rewritten, so a run pinned to one stays valid.
 */
export class ExtensionRegistryStore {
  readonly home: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(home: string, private readonly migrationStep?: (step: "backup" | "journal" | "generation" | "registry") => void | Promise<void>) {
    this.home = resolve(home);
  }

  async load(): Promise<ExtensionRegistryDocument> {
    const raw = await readJson(join(this.home, "registry.json"));
    const journal = await readJson(join(this.home, "registry-v1-migration.json"));
    if (journal !== undefined || (raw && typeof raw === "object" && (raw as Record<string, unknown>).schemaVersion === 1)) {
      const release = await acquireLock(join(this.home, ".lock"));
      try { return await this.loadLocked(); } finally { await release(); }
    }
    return raw === undefined ? emptyRegistry() : validateRegistry(raw);
  }

  private async loadLocked(): Promise<ExtensionRegistryDocument> {
    await recoverMigration(this.home);
    const raw = await readJson(join(this.home, "registry.json"));
    if (raw === undefined) return emptyRegistry();
    const value = record(raw, "registry");
    if (value.schemaVersion === 1) return await migrateV1(this.home, value, this.migrationStep);
    return validateRegistry(raw);
  }

  async operations(): Promise<ExtensionOperation[]> {
    const raw = await readJson(join(this.home, "operations.json"));
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new ExtensionManagementError("registry_corrupt", "operations.json is malformed.", 500);
    return raw.map(validateOperation);
  }

  async generation(generation: number): Promise<ExtensionGeneration> {
    if (generation === 0) return emptyGeneration();
    const raw = await readJson(join(this.home, "generations", `${generation}.json`));
    if (raw === undefined) throw new ExtensionManagementError("generation_missing", `Capability generation ${generation} is not stored.`, 404);
    const value = raw as ExtensionGeneration;
    if (value.generation !== generation || !Array.isArray(value.entries) || generationDigest(value.entries) !== value.digest)
      throw new ExtensionManagementError("generation_corrupt", `Capability generation ${generation} does not match its digest.`, 500);
    for (const entry of value.entries) {
      if (entry.toolPolicy) validateExtensionToolPolicy(entry.toolPolicy, { versionId: entry.versionId, components: entry.components });
      if (entry.toolApprovalOverride !== undefined && entry.toolApprovalOverride !== "all" && entry.toolApprovalOverride !== "non_destructive") corrupt("generation approval");
    }
    return value;
  }

  /**
   * Applies one mutation under the cross-process lock against the freshest stored state. The mutator
   * may publish a new generation; generation files are written before the registry that names them.
   */
  async mutate<T>(mutator: (state: MutableRegistryState) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const release = await acquireLock(join(this.home, ".lock"));
      try {
        const registry = await this.loadLocked();
        const operations = await this.operations();
        const state = new MutableRegistryState(registry, operations);
        const result = await mutator(state);
        if (state.publishedGeneration) {
          await writeAtomic(join(this.home, "generations", `${state.publishedGeneration.generation}.json`), state.publishedGeneration, true);
        }
        if (state.operationsChanged) await writeAtomic(join(this.home, "operations.json"), state.trimmedOperations());
        if (state.registryChanged) await writeAtomic(join(this.home, "registry.json"), validateRegistry({ ...state.registry, revision: registry.revision + 1 }));
        return result;
      } finally {
        await release();
      }
    });
    this.queue = run.catch(() => undefined);
    return await run;
  }
}

/** In-lock working copy. Every change goes through these methods so the persisted files stay consistent. */
export class MutableRegistryState {
  registry: ExtensionRegistryDocument;
  operations: ExtensionOperation[];
  registryChanged = false;
  operationsChanged = false;
  publishedGeneration: ExtensionGeneration | undefined;

  constructor(registry: ExtensionRegistryDocument, operations: ExtensionOperation[]) {
    this.registry = registry;
    this.operations = operations;
  }

  extension(id: string): InstalledExtension | undefined {
    return this.registry.extensions.find((entry) => entry.id === id);
  }

  version(id: string): ExtensionVersion | undefined {
    return this.registry.versions.find((entry) => entry.versionId === id);
  }

  putExtension(next: InstalledExtension): void {
    const others = this.registry.extensions.filter((entry) => entry.id !== next.id);
    if (others.length >= EXTENSION_LIMITS.maxExtensions && !this.extension(next.id)) throw new ExtensionManagementError("registry_full", "Too many extensions are registered.", 409);
    this.registry = { ...this.registry, extensions: [...others, validateExtension(next)].sort((a, b) => a.id.localeCompare(b.id)) };
    this.registryChanged = true;
  }

  putVersion(next: ExtensionVersion): void {
    if (this.version(next.versionId)) return;
    this.registry = { ...this.registry, versions: [...this.registry.versions, next] };
    this.registryChanged = true;
  }

  dropVersions(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    this.registry = { ...this.registry, versions: this.registry.versions.filter((entry) => !ids.has(entry.versionId)),
      toolPolicies: Object.fromEntries(Object.entries(this.registry.toolPolicies).filter(([, policy]) => !ids.has(policy.versionId))),
      toolDiscoveries: Object.fromEntries(Object.entries(this.registry.toolDiscoveries).filter(([, discovery]) => !ids.has(discovery.versionId))) };
    this.registryChanged = true;
  }

  setToolApproval(extensionId: string, approval: "all" | "non_destructive"): void {
    if (!this.extension(extensionId)) throw new ExtensionManagementError("extension_not_found", "No such installed extension.", 404);
    this.registry = { ...this.registry, toolApprovals: { ...this.registry.toolApprovals, [extensionId]: approval } };
    this.registryChanged = true;
  }

  setToolPolicy(extensionId: string, policy: ExtensionToolPolicy): void {
    const version = this.version(policy.versionId);
    if (!version || version.extensionId !== extensionId) throw new ExtensionManagementError("tool_policy_invalid", "Policy version does not belong to the extension.");
    this.registry = { ...this.registry, toolPolicies: { ...this.registry.toolPolicies, [extensionId]: validateExtensionToolPolicy(policy, version) } };
    this.registryChanged = true;
  }

  setToolDiscovery(extensionId: string, versionId: string, components: readonly ExtensionToolInventory[]): void {
    const version = this.version(versionId);
    if (!version || version.extensionId !== extensionId) throw new ExtensionManagementError("tool_policy_invalid", "Discovery version does not belong to the extension.");
    const policy = validateExtensionToolPolicy({ ...defaultToolPolicy(versionId), reviewed: components }, version);
    this.registry = { ...this.registry, toolDiscoveries: { ...this.registry.toolDiscoveries, [extensionId]: { versionId, components: policy.reviewed } } };
    this.registryChanged = true;
  }

  setPolicy(policy: InstallPolicy): void {
    this.registry = { ...this.registry, policy: validatePolicy(policy) };
    this.registryChanged = true;
  }

  recordMigration(id: string): void {
    if (this.registry.migrations.includes(id)) return;
    this.registry = { ...this.registry, migrations: [...this.registry.migrations, id] };
    this.registryChanged = true;
  }

  operation(id: string): ExtensionOperation | undefined {
    return this.operations.find((entry) => entry.id === id);
  }

  operationByKey(key: string): ExtensionOperation | undefined {
    return this.operations.find((entry) => entry.key === key);
  }

  putOperation(next: ExtensionOperation): void {
    this.operations = [...this.operations.filter((entry) => entry.id !== next.id), validateOperation(next)];
    this.operationsChanged = true;
  }

  /** Publishes the enabled set as a new immutable generation. */
  publishGeneration(operationId: string | undefined, now: string): ExtensionGeneration {
    const entries = this.registry.extensions
      .filter((entry) => entry.enabled && !entry.removedAt && entry.currentVersionId && entry.provenance !== "external")
      .map((entry) => {
        const version = this.version(entry.currentVersionId!);
        if (!version) throw new ExtensionManagementError("registry_corrupt", `Version ${entry.currentVersionId} of ${entry.id} is missing.`, 500);
        return Object.freeze({
          extensionId: entry.id, kind: entry.kind, name: entry.name, scope: entry.scope, versionId: version.versionId,
          ...(version.packageDigest ? { packageDigest: version.packageDigest } : {}),
          components: version.components,
          ...(this.registry.toolApprovals[entry.id] ? { toolApprovalOverride: this.registry.toolApprovals[entry.id] } : {}),
          ...(version.components.some((component) => component.kind === "mcp_server") ? { toolPolicy: this.registry.toolPolicies[entry.id]?.versionId === version.versionId ? this.registry.toolPolicies[entry.id] : defaultToolPolicy(version.versionId) } : {}),
        });
      })
      .sort((a, b) => a.extensionId.localeCompare(b.extensionId));
    const generation: ExtensionGeneration = Object.freeze({
      generation: this.registry.currentGeneration + 1,
      createdAt: now,
      ...(operationId ? { operationId } : {}),
      entries: Object.freeze(entries),
      digest: generationDigest(entries),
    });
    this.publishedGeneration = generation;
    this.registry = { ...this.registry, currentGeneration: generation.generation };
    this.registryChanged = true;
    return generation;
  }

  trimmedOperations(): ExtensionOperation[] {
    if (this.operations.length <= EXTENSION_LIMITS.maxOperations) return this.operations;
    // Terminal operations age out first; unresolved ones are never dropped.
    const terminal = this.operations.filter((entry) => !["running", "awaiting_user"].includes(entry.outcome)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const drop = new Set(terminal.slice(0, this.operations.length - EXTENSION_LIMITS.maxOperations).map((entry) => entry.id));
    return this.operations.filter((entry) => !drop.has(entry.id));
  }
}

export function generationDigest(entries: ExtensionGeneration["entries"]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function emptyGeneration(): ExtensionGeneration {
  return Object.freeze({ generation: 0, createdAt: new Date(0).toISOString(), entries: Object.freeze([]), digest: generationDigest([]) });
}

function emptyRegistry(): ExtensionRegistryDocument {
  return { schemaVersion: EXTENSION_REGISTRY_SCHEMA_VERSION, revision: 0, currentGeneration: 0, extensions: [], versions: [], toolPolicies: {}, toolApprovals: {}, legacyToolApprovals: {}, toolDiscoveries: {}, policy: DEFAULT_INSTALL_POLICY, migrations: [] };
}

export function defaultToolPolicy(versionId: string): ExtensionToolPolicy {
  return { version: 1, versionId, toolFilter: { default: "deny", allow: [], deny: [] }, remoteExposure: false, riskLabel: "unreviewed", reviewed: [] };
}

/** A v1 snapshot grants only names for which a complete schema inventory survived. */
export function legacyToolPolicy(versionId: string, components: readonly ExtensionComponent[]): ExtensionToolPolicy {
  const reviewed: ExtensionToolInventory[] = [];
  for (const component of components) {
    if (component.kind !== "mcp_server" || component.route !== "runner" || !component.schemaDigest || !component.toolNames) continue;
    if (!/^[a-f0-9]{64}$/.test(component.schemaDigest) || component.componentId.length < 1 || component.componentId.length > 160 ||
        component.toolNames.length > 4096 || new Set(component.toolNames).size !== component.toolNames.length ||
        component.toolNames.some((name) => !/^[A-Za-z0-9_.-]{1,128}$/.test(name))) continue;
    reviewed.push({ componentId: component.componentId, schemaDigest: component.schemaDigest, toolNames: [...component.toolNames] });
  }
  const policy: ExtensionToolPolicy = { ...defaultToolPolicy(versionId), reviewed,
    toolFilter: { default: "deny", allow: reviewed.flatMap((item) => item.toolNames.map((toolName) => ({ componentId: item.componentId, toolName }))), deny: [] } };
  return validateExtensionToolPolicy(policy, { versionId, components });
}

interface MigrationJournal {
  readonly version: 1;
  readonly sourceDigest: string;
  readonly policyDigest: string | null;
  readonly registry: ExtensionRegistryDocument;
  readonly generation: ExtensionGeneration;
}

async function migrateV1(home: string, raw: Record<string, unknown>, hook?: (step: "backup" | "journal" | "generation" | "registry") => void | Promise<void>): Promise<ExtensionRegistryDocument> {
  only(raw, ["schemaVersion", "revision", "currentGeneration", "extensions", "versions", "policy", "migrations"], "v1 registry");
  const source = await readFile(join(home, "registry.json"));
  try { if (JSON.stringify(JSON.parse(source.toString("utf8"))) !== JSON.stringify(raw)) corrupt("migration source changed"); }
  catch (error) { if (error instanceof ExtensionManagementError) throw error; return corrupt("migration source"); }
  const legacyPolicy = await readOptionalBytes(join(home, "mcp-tool-policy.json"));
  let legacyApprovals: Record<string, "all" | "non_destructive"> = {};
  if (legacyPolicy) {
    let parsed: unknown;
    try { parsed = JSON.parse(legacyPolicy.toString("utf8")); } catch { return corrupt("MCP approval policy"); }
    const approvals = record(parsed, "MCP approval policy");
    for (const [id, approval] of Object.entries(approvals)) {
      if (!/^ext_[a-z0-9_-]{4,80}$/.test(id) || (approval !== "all" && approval !== "non_destructive")) corrupt("MCP approval policy");
    }
    legacyApprovals = approvals as Record<string, "all" | "non_destructive">;
  }
  const ids = new Set(Array.isArray(raw.extensions) ? raw.extensions.map((entry: unknown) => record(entry, "extension").id) : []);
  const retainedApprovals = Object.fromEntries(Object.entries(legacyApprovals).filter(([id]) => ids.has(id)));
  const base = validateRegistry({ ...raw, schemaVersion: EXTENSION_REGISTRY_SCHEMA_VERSION, toolPolicies: {}, toolApprovals: retainedApprovals, legacyToolApprovals: retainedApprovals, toolDiscoveries: {} });
  if (base.currentGeneration > 0) {
    const existing = await readJson(join(home, "generations", String(base.currentGeneration) + ".json")) as ExtensionGeneration | undefined;
    if (!existing || existing.generation !== base.currentGeneration || !Array.isArray(existing.entries) || generationDigest(existing.entries) !== existing.digest) corrupt("v1 generation");
  }
  const state = new MutableRegistryState(base, []);
  for (const extension of base.extensions) {
    if (!extension.currentVersionId) continue;
    const version = base.versions.find((item) => item.extensionId === extension.id && item.versionId === extension.currentVersionId);
    if (!version) corrupt("v1 current version");
    if (version!.components.some((item) => item.kind === "mcp_server")) {
      const policy = legacyToolPolicy(version!.versionId, version!.components);
      state.setToolPolicy(extension.id, policy);
      state.setToolDiscovery(extension.id, version!.versionId, policy.reviewed);
    }
  }
  state.recordMigration("extension-tool-policy-v1-to-v2");
  const generation = state.publishGeneration(undefined, new Date().toISOString());
  const registry = validateRegistry({ ...state.registry, revision: base.revision + 1 });
  await writeBackup(join(home, "registry.v1.backup.json"), source);
  if (legacyPolicy) await writeBackup(join(home, "mcp-tool-policy.v1.backup.json"), legacyPolicy);
  await hook?.("backup");
  const journal: MigrationJournal = { version: 1, sourceDigest: digestBytes(source), policyDigest: legacyPolicy ? digestBytes(legacyPolicy) : null, registry, generation };
  await writeDurable(join(home, "registry-v1-migration.json"), Buffer.from(JSON.stringify(journal)));
  await hook?.("journal");
  await commitMigrationGeneration(home, generation);
  await hook?.("generation");
  await writeDurable(join(home, "registry.json"), Buffer.from(JSON.stringify(registry)));
  await hook?.("registry");
  await recoverMigration(home);
  return registry;
}

async function recoverMigration(home: string): Promise<void> {
  const raw = await readJson(join(home, "registry-v1-migration.json"));
  if (raw === undefined) return;
  const value = record(raw, "migration journal");
  only(value, ["version", "sourceDigest", "policyDigest", "registry", "generation"], "migration journal");
  if (value.version !== 1 || typeof value.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
      !(value.policyDigest === null || typeof value.policyDigest === "string" && /^[a-f0-9]{64}$/.test(value.policyDigest))) corrupt("migration journal");
  const registry = validateRegistry(value.registry);
  const generation = value.generation as ExtensionGeneration;
  if (!generation || generation.generation !== registry.currentGeneration || !Array.isArray(generation.entries) || generation.digest !== generationDigest(generation.entries)) corrupt("migration generation");
  for (const entry of generation.entries) if (entry.toolPolicy) validateExtensionToolPolicy(entry.toolPolicy, { versionId: entry.versionId, components: entry.components });
  const backup = await readOptionalBytes(join(home, "registry.v1.backup.json"));
  const approval = await readOptionalBytes(join(home, "mcp-tool-policy.json"));
  if (!backup || digestBytes(backup) !== value.sourceDigest || (approval ? digestBytes(approval) : null) !== value.policyDigest) corrupt("migration backup or approval policy");
  if (approval) {
    const policyBackup = await readOptionalBytes(join(home, "mcp-tool-policy.v1.backup.json"));
    if (!policyBackup || digestBytes(policyBackup) !== value.policyDigest) corrupt("migration policy backup");
  }
  const currentBytes = await readOptionalBytes(join(home, "registry.json"));
  if (!currentBytes) corrupt("migration source");
  let current: unknown;
  try { current = JSON.parse(currentBytes!.toString("utf8")); } catch { return corrupt("migration source"); }
  const currentRecord = record(current, "migration source");
  if (currentRecord.schemaVersion === 1) {
    if (digestBytes(currentBytes!) !== value.sourceDigest) corrupt("migration source changed");
    await commitMigrationGeneration(home, generation);
    await writeDurable(join(home, "registry.json"), Buffer.from(JSON.stringify(registry)));
  } else {
    if (JSON.stringify(validateRegistry(current)) !== JSON.stringify(registry)) corrupt("migration target changed");
    await commitMigrationGeneration(home, generation);
  }
  await rm(join(home, "registry-v1-migration.json"), { force: true });
}

async function commitMigrationGeneration(home: string, generation: ExtensionGeneration): Promise<void> {
  const target = join(home, "generations", String(generation.generation) + ".json");
  const existing = await readJson(target);
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(generation)) corrupt("migration generation already exists");
    return;
  }
  await writeDurable(target, Buffer.from(JSON.stringify(generation)));
}

async function readOptionalBytes(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function digestBytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

async function writeBackup(path: string, bytes: Buffer): Promise<void> {
  const existing = await readOptionalBytes(path);
  if (existing) {
    if (!existing.equals(bytes)) corrupt("migration backup differs");
    return;
  }
  await writeDurable(path, bytes);
}

async function writeDurable(path: string, bytes: Buffer): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = path + "." + process.pid + "-" + randomUUID() + ".tmp";
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    // Windows does not permit opening directories for fsync.
    if (process.platform !== "win32") {
      const directory = await open(join(path, ".."), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { if (created) await rm(temporary, { force: true }); }
}

function validateRegistry(raw: unknown): ExtensionRegistryDocument {
  const value = record(raw, "registry");
  only(value, ["schemaVersion", "revision", "currentGeneration", "extensions", "versions", "toolPolicies", "toolApprovals", "legacyToolApprovals", "toolDiscoveries", "policy", "migrations"], "registry");
  if (value.schemaVersion !== EXTENSION_REGISTRY_SCHEMA_VERSION) throw new ExtensionManagementError("registry_version_unsupported", `Extension registry schema ${String(value.schemaVersion)} is not supported by this Runner.`, 500);
  if (!Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.currentGeneration)) corrupt("registry revision/generation");
  if (!Array.isArray(value.extensions) || !Array.isArray(value.versions) || !Array.isArray(value.migrations)) corrupt("registry arrays");
  const extensions = (value.extensions as unknown[]).map(validateExtension);
  const versions = (value.versions as unknown[]).map(validateVersion);
  const policies = record(value.toolPolicies, "tool policies");
  const approvals = validateApprovalMap(value.toolApprovals, extensions);
  const legacyApprovals = validateApprovalMap(value.legacyToolApprovals, extensions);
  const discoveries = record(value.toolDiscoveries, "tool discoveries");
  const toolPolicies: Record<string, ExtensionToolPolicy> = {};
  const toolDiscoveries: Record<string, { versionId: string; components: readonly ExtensionToolInventory[] }> = {};
  for (const [id, rawPolicy] of Object.entries(policies)) {
    const policy = record(rawPolicy, "tool policy");
    const version = versions.find((entry) => entry.extensionId === id && entry.versionId === policy.versionId);
    if (!extensions.some((entry) => entry.id === id) || !version) corrupt("tool policy owner");
    toolPolicies[id] = validateExtensionToolPolicy(policy, version!);
  }
  for (const [id, rawDiscovery] of Object.entries(discoveries)) {
    const discovery = record(rawDiscovery, "tool discovery");
    only(discovery, ["versionId", "components"], "tool discovery");
    const version = versions.find((entry) => entry.extensionId === id && entry.versionId === discovery.versionId);
    if (!extensions.some((entry) => entry.id === id) || !version) corrupt("tool discovery owner");
    const policy = validateExtensionToolPolicy({ ...defaultToolPolicy(version!.versionId), reviewed: discovery.components }, version!);
    toolDiscoveries[id] = { versionId: version!.versionId, components: policy.reviewed };
  }
  return {
    schemaVersion: EXTENSION_REGISTRY_SCHEMA_VERSION,
    revision: value.revision as number,
    currentGeneration: value.currentGeneration as number,
    extensions,
    versions,
    toolPolicies,
    toolApprovals: approvals,
    legacyToolApprovals: legacyApprovals,
    toolDiscoveries,
    policy: validatePolicy(value.policy),
    migrations: (value.migrations as unknown[]).map((entry) => typeof entry === "string" ? entry : corrupt("migration id")),
  };
}

function validateApprovalMap(raw: unknown, extensions: readonly InstalledExtension[]): Record<string, "all" | "non_destructive"> {
  const value = record(raw, "MCP approvals");
  const result: Record<string, "all" | "non_destructive"> = {};
  for (const [id, approval] of Object.entries(value)) {
    if (!extensions.some((extension) => extension.id === id) || (approval !== "all" && approval !== "non_destructive")) corrupt("MCP approval");
    result[id] = approval as "all" | "non_destructive";
  }
  return result;
}

function validateExtension(raw: unknown): InstalledExtension {
  const value = record(raw, "extension");
  only(value, ["id", "kind", "name", "scope", "provenance", "source", "currentVersionId", "enabled", "desiredGeneration", "activeGeneration", "readiness", "componentIds", "credentialRefs", "previousVersionIds", "referencedBy", "installedAt", "updatedAt", "removedAt"], "extension");
  if (typeof value.id !== "string" || !/^ext_[a-z0-9_-]{4,80}$/.test(value.id)) corrupt("extension id");
  if (!["skill", "mcp_server", "plugin"].includes(value.kind as string)) corrupt("extension kind");
  if (!["managed", "cli", "external", "migrated"].includes(value.provenance as string)) corrupt("extension provenance");
  if (typeof value.name !== "string" || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.desiredGeneration)) corrupt("extension fields");
  parseScope(value.scope);
  validateSource(value.source);
  for (const key of ["componentIds", "credentialRefs", "previousVersionIds", "referencedBy"]) if (!stringArray(value[key])) corrupt(`extension ${key}`);
  const readiness = record(value.readiness, "readiness");
  if (typeof readiness.state !== "string") corrupt("extension readiness");
  return value as unknown as InstalledExtension;
}

function validateVersion(raw: unknown): ExtensionVersion {
  const value = record(raw, "version");
  only(value, ["versionId", "extensionId", "version", "source", "packageDigest", "components", "createdAt", "operationId", "dependencies"], "version");
  if (typeof value.versionId !== "string" || typeof value.extensionId !== "string" || !Array.isArray(value.components)) corrupt("version fields");
  if (value.packageDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.packageDigest as string)) corrupt("version packageDigest");
  validateSource(value.source);
  (value.components as unknown[]).forEach(validateComponent);
  return value as unknown as ExtensionVersion;
}

export function validateComponent(raw: unknown): ExtensionComponent {
  const value = record(raw, "component");
  if (value.kind === "skill") {
    only(value, ["kind", "componentId", "skillName", "description", "packagePath", "digest", "files", "allowedTools", "license", "compatibility", "warnings"], "skill component");
    if (typeof value.skillName !== "string" || typeof value.packagePath !== "string" || typeof value.digest !== "string") corrupt("skill component");
  } else if (value.kind === "mcp_server") {
    only(value, ["kind", "componentId", "serverName", "transport", "command", "args", "packageRelativeCommand", "url", "environment", "route", "schemaDigest", "toolNames", "executableDigest", "installRoot", "installDigest", "toolApproval", "auth", "network", "protocolVersion"], "MCP component");
    if (typeof value.serverName !== "string" || !["stdio", "streamable_http"].includes(value.transport as string) || !Array.isArray(value.environment)) corrupt("MCP component");
    if (value.args !== undefined && !stringArray(value.args)) corrupt("MCP component args");
    if (value.route !== "runner" && value.route !== "provider_hosted") corrupt("MCP component route");
    if (value.toolApproval !== undefined && value.toolApproval !== "all" && value.toolApproval !== "non_destructive") corrupt("MCP component approval");
    if (value.schemaDigest !== undefined && (typeof value.schemaDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.schemaDigest))) corrupt("MCP component schema digest");
    if (value.toolNames !== undefined && (!Array.isArray(value.toolNames) || value.toolNames.length > 4096 ||
        value.toolNames.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) || new Set(value.toolNames).size !== value.toolNames.length)) corrupt("MCP component tool names");
  } else if (value.kind === "runner_extension") {
    only(value, ["kind", "componentId", "extensionId", "packagePath", "manifestDigest"], "runner extension component");
  } else {
    corrupt("component kind");
  }
  if (typeof value.componentId !== "string") corrupt("componentId");
  return value as unknown as ExtensionComponent;
}

function validateSource(raw: unknown): void {
  const value = record(raw, "source");
  const allowed: Record<string, string[]> = {
    local_directory: ["path", "treeDigest"], archive: ["filename", "archiveDigest", "treeDigest"], single_file: ["filename", "treeDigest"],
    git: ["url", "requestedRef", "commit", "subdirectory", "treeDigest"], npm: ["packageName", "version", "integrity"], pypi: ["packageName", "version"],
    executable: ["command", "args", "executableDigest"], remote_http: ["url"], cli_config: ["name", "configDigest"], provider_hosted: ["url"], external_skill: ["path", "digest"],
  };
  const keys = allowed[value.type as string];
  if (!keys) corrupt("source type");
  only(value, ["type", ...keys], "source");
}

function validatePolicy(raw: unknown): InstallPolicy {
  if (raw === undefined) return DEFAULT_INSTALL_POLICY;
  const value = record(raw, "policy");
  only(value, ["version", "humanRequestedSkills", "humanRequestedExecutable", "trustedSources"], "policy");
  if (value.version !== 1 || !["auto", "ask"].includes(value.humanRequestedSkills as string) || !["trusted_sources", "ask"].includes(value.humanRequestedExecutable as string) || !stringArray(value.trustedSources))
    throw new ExtensionManagementError("policy_invalid", "Installation policy is malformed.");
  for (const pattern of value.trustedSources as string[]) {
    if (!/^(npm|pypi|git|url):\S{1,300}$/.test(pattern)) throw new ExtensionManagementError("policy_invalid", `Trusted source "${pattern}" must look like npm:@scope/*, pypi:name, git:https://host/org/* or url:https://host/*.`);
  }
  return Object.freeze({ version: 1, humanRequestedSkills: value.humanRequestedSkills as "auto" | "ask", humanRequestedExecutable: value.humanRequestedExecutable as "trusted_sources" | "ask", trustedSources: Object.freeze([...(value.trustedSources as string[])]) });
}

export function validateOperation(raw: unknown): ExtensionOperation {
  const value = record(raw, "operation");
  only(value, ["id", "key", "owner", "action", "target", "scope", "requestFingerprint", "planDigest", "plan", "authorizationRef", "authorizationOrigin", "stage", "outcome", "progress", "userAction", "result", "diagnostics", "createdAt", "updatedAt"], "operation");
  if (typeof value.id !== "string" || typeof value.key !== "string" || typeof value.requestFingerprint !== "string") corrupt("operation identity");
  if (!["running", "awaiting_user", "succeeded", "failed", "cancelled", "outcome_unknown", "rolled_back"].includes(value.outcome as string)) corrupt("operation outcome");
  if (!Array.isArray(value.progress) || !stringArray(value.diagnostics)) corrupt("operation progress");
  if ((value.diagnostics as string[]).length > EXTENSION_LIMITS.maxDiagnostics) corrupt("operation diagnostics");
  parseScope(value.scope);
  const owner = record(value.owner, "owner");
  if (owner.kind !== "ui" && owner.kind !== "agent") corrupt("operation owner");
  return value as unknown as ExtensionOperation;
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) corrupt(label);
  return raw as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) corrupt(`${label} field ${key}`);
}

function stringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function corrupt(what: string): never {
  throw new ExtensionManagementError("registry_corrupt", `Extension registry has an invalid ${what}.`, 500);
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ExtensionManagementError("registry_corrupt", `${path} is not valid JSON.`, 500);
  }
}

async function writeAtomic(path: string, value: unknown, immutable = false): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  if (immutable && (await stat(path).catch(() => undefined))) throw new ExtensionManagementError("generation_exists", `${path} already exists and is immutable.`, 500);
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Test seams for the registry lock; production uses the defaults. */
export interface RegistryLockOptions {
  waitMs?: number;
  staleMs?: number;
  /** Runs after a stale lock was chosen for reclamation and before it is reclaimed. */
  beforeReclaim?: () => void | Promise<void>;
}

/**
 * Cross-process registry lock: a directory holding exactly one unique `owner-<uuid>` marker (pid inside).
 * Ownership is the marker, not the directory. Reclaiming a stale lock removes only that stale owner's
 * marker and then the directory only if it is empty, so a reclaimer that lost a race can never remove a
 * successor's lock, and release never touches a lock that is no longer this owner's.
 */
export async function acquireRegistryLock(path: string, options: RegistryLockOptions = {}): Promise<() => Promise<void>> {
  await mkdir(join(path, ".."), { recursive: true });
  const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
  const marker = `owner-${randomUUID()}`;
  for (let attempt = 0; ; attempt += 1) {
    if (await tryCreateLock(path, marker)) return () => releaseLock(path, marker);
    const stale = await staleLockEntry(path, options.staleMs ?? LOCK_STALE_MS);
    if (stale !== undefined) {
      await options.beforeReclaim?.();
      await reclaimLock(path, stale);
      continue;
    }
    if (Date.now() > deadline) throw new ExtensionManagementError("registry_busy", "The extension registry is locked by another Runner; retry shortly.", 503);
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(250, 10 * 2 ** Math.min(attempt, 5))));
  }
}

const acquireLock = acquireRegistryLock;

async function tryCreateLock(path: string, marker: string): Promise<boolean> {
  try { await mkdir(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    await writeFile(join(path, marker), `${process.pid}\n`, { flag: "wx" });
  } catch (error) {
    // A reclaimer removed the still-empty directory before the marker landed: lost the race, retry.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    await removeEmptyLock(path);
    throw error;
  }
  // Two contenders can write markers into one directory (one recreated it after the other's reclaim).
  // Only a sole marker owns the lock; otherwise back off and retry.
  const entries = await readdir(path).catch(() => [] as string[]);
  if (entries.length === 1 && entries[0] === marker) return true;
  await unlink(join(path, marker)).catch(() => undefined);
  await removeEmptyLock(path);
  return false;
}

async function releaseLock(path: string, marker: string): Promise<void> {
  try { await unlink(join(path, marker)); } catch (error) {
    // The marker is gone: this lock was reclaimed, so whatever is there now is not ours to remove.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await removeEmptyLock(path);
}

/**
 * The entry to reclaim from a stale lock: an owner marker whose process is gone, `null` for a directory
 * left empty by a crash between creation and marker, or undefined when it is not provably stale. Age alone
 * is not authority to steal an active writer's lock, and unknown contents are never reclaimed.
 */
async function staleLockEntry(path: string, staleMs: number): Promise<string | null | undefined> {
  const details = await stat(path).catch(() => undefined);
  if (!details || Date.now() - details.mtimeMs <= staleMs) return undefined;
  const entries = await readdir(path).catch(() => undefined);
  if (!entries) return undefined;
  if (entries.length === 0) return null;
  // `owner` is the pre-marker lock format; new locks never use that name.
  const [entry] = entries;
  if (entries.length !== 1 || !entry || !/^owner(?:-[0-9a-f-]{36})?$/.test(entry)) return undefined;
  return await lockOwnerGone(join(path, entry)) ? entry : undefined;
}

async function reclaimLock(path: string, entry: string | null): Promise<void> {
  if (entry) await unlink(join(path, entry)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await removeEmptyLock(path);
}

/** Removes the lock directory only when it is empty; a successor's marker keeps it. */
async function removeEmptyLock(path: string): Promise<void> {
  await rmdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  });
}

async function lockOwnerGone(markerPath: string): Promise<boolean> {
  const owner = await readFile(markerPath, "utf8").catch(() => undefined);
  if (!owner || !/^\d+\s*$/.test(owner)) return false;
  const pid = Number(owner.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
