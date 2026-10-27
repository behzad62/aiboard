import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  DEFAULT_INSTALL_POLICY,
  EXTENSION_LIMITS,
  EXTENSION_REGISTRY_SCHEMA_VERSION,
  ExtensionManagementError,
  parseScope,
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

  constructor(home: string) {
    this.home = resolve(home);
  }

  async load(): Promise<ExtensionRegistryDocument> {
    const raw = await readJson(join(this.home, "registry.json"));
    return raw === undefined ? emptyRegistry() : validateRegistry(raw);
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
        const registry = await this.load();
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
    this.registry = { ...this.registry, versions: this.registry.versions.filter((entry) => !ids.has(entry.versionId)) };
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
  return { schemaVersion: EXTENSION_REGISTRY_SCHEMA_VERSION, revision: 0, currentGeneration: 0, extensions: [], versions: [], policy: DEFAULT_INSTALL_POLICY, migrations: [] };
}

function validateRegistry(raw: unknown): ExtensionRegistryDocument {
  const value = record(raw, "registry");
  only(value, ["schemaVersion", "revision", "currentGeneration", "extensions", "versions", "policy", "migrations"], "registry");
  if (value.schemaVersion !== EXTENSION_REGISTRY_SCHEMA_VERSION) throw new ExtensionManagementError("registry_version_unsupported", `Extension registry schema ${String(value.schemaVersion)} is not supported by this Runner.`, 500);
  if (!Number.isSafeInteger(value.revision) || !Number.isSafeInteger(value.currentGeneration)) corrupt("registry revision/generation");
  if (!Array.isArray(value.extensions) || !Array.isArray(value.versions) || !Array.isArray(value.migrations)) corrupt("registry arrays");
  return {
    schemaVersion: EXTENSION_REGISTRY_SCHEMA_VERSION,
    revision: value.revision as number,
    currentGeneration: value.currentGeneration as number,
    extensions: (value.extensions as unknown[]).map(validateExtension),
    versions: (value.versions as unknown[]).map(validateVersion),
    policy: validatePolicy(value.policy),
    migrations: (value.migrations as unknown[]).map((entry) => typeof entry === "string" ? entry : corrupt("migration id")),
  };
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
  await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(join(path, ".."), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(path);
      await writeFile(join(path, "owner"), `${process.pid}\n`);
      return async () => { await rm(path, { recursive: true, force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const details = await stat(path).catch(() => undefined);
      // A lock older than any registry write left by a crashed process is reclaimed.
      if (details && Date.now() - details.mtimeMs > LOCK_STALE_MS) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new ExtensionManagementError("registry_busy", "The extension registry is locked by another Runner; retry shortly.", 503);
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(250, 10 * 2 ** Math.min(attempt, 5))));
    }
  }
}
