import { join } from "node:path";

import {
  ExtensionManagementError,
  type AccessSummary,
  type ExtensionComponent,
  type ExtensionDependency,
  type ExtensionReadiness,
  type ExtensionVersion,
  type InstalledExtension,
  type McpServerComponent,
  type ResolvedSource,
  type RunnerExtensionComponent,
} from "./extension-management-contracts.js";
import type { ExtensionKindHandler, HandlerInspection, StagedRunnerExtension } from "./extension-management-service.js";
import type { ManagedMcpRuntime } from "./extension-mcp.js";
import { ExtensionPackageStore, normalizePackagePath, subtree, type PackageTree } from "./extension-package-store.js";
import { discoverSkills, singleFileSkillTree } from "./extension-skill-validation.js";
import type { SourceRequest } from "./extension-sources.js";
import { captureRunnerExtensionClosure } from "./runner-capability-contract.js";

export const PLUGIN_MANIFEST_FILE = "aiboard-plugin.json";
export const PLUGIN_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_COMPONENTS = 32;
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * `aiboard-plugin.json`, schema version 1. Every field is declared data: a manifest cannot carry
 * authorization, change access policy, register lifecycle tools or alter verification.
 *
 * {
 *   "schemaVersion": 1,
 *   "id": "example.docs-workflow",            // [a-z0-9][a-z0-9._-]{1,63}
 *   "name": "Documentation workflow",          // display name, ≤ 120 chars
 *   "version": "1.0.0",                        // the bundle's own version, ≤ 64 chars
 *   "description": "…", "license": "MIT", "homepage": "https://…",   // optional metadata
 *   "skills": [{ "path": "skills/docs" }],                            // folders holding SKILL.md
 *   "mcpServers": [{ "id": "docs", "definitionPath": "mcp/docs.json" }],
 *       // definition: { "transport": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/server.mjs"],
 *       //               "env": ["DOCS_TOKEN"], "serverName": "docs" }
 *       //          or  { "transport": "streamable_http", "url": "https://…", "auth": "none" | "bearer" | "oauth" }
 *   "runnerExtensions": [{ "path": "runner" }],                      // folders with runner-extension.json
 *   "requires": [{ "kind": "skill" | "mcp_server", "name": "…" }]     // installed items the bundle uses
 * }
 */
export interface PluginManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly skills: readonly Readonly<{ path: string }>[];
  readonly mcpServers: readonly Readonly<{ id: string; definitionPath: string }>[];
  readonly runnerExtensions: readonly Readonly<{ path: string }>[];
  readonly requires: readonly ExtensionDependency[];
}

/** Known plugin formats from other tools, with what AI Board cannot run from them. */
const FOREIGN_FORMATS: ReadonlyArray<Readonly<{ marker: string; name: string; missing: string; test?: (text: string) => boolean }>> = [
  { marker: ".claude-plugin/plugin.json", name: "a Claude Code plugin", missing: "Its hooks, slash commands and agents are not supported. Install folders under skills/ as skills, and add servers from .mcp.json as MCP servers." },
  { marker: "gemini-extension.json", name: "a Gemini CLI extension", missing: "Its context files and commands are not supported. Add its MCP servers as MCP servers." },
  { marker: "package.json", name: "a VS Code extension", missing: "Editor extensions cannot run in AI Board.", test: (text) => /"engines"\s*:\s*\{[^}]*"vscode"/.test(text) },
  { marker: "manifest.json", name: "a browser extension", missing: "Browser extensions cannot run in AI Board.", test: (text) => /"manifest_version"\s*:/.test(text) },
];

export interface PluginHandlerOptions {
  readonly home: string;
  readonly mcp: ManagedMcpRuntime;
  /** What the Runner did with staged Runner extensions at its last start. */
  readonly runnerExtensions?: () => RunnerExtensionActivation;
}

export interface RunnerExtensionActivation {
  /** Package directories loaded into this Runner's capability configuration. */
  readonly active: ReadonlySet<string>;
  /** Directories refused at startup, with the reason. */
  readonly refused: ReadonlyMap<string, string>;
  /** Why activation was postponed (for example, an unfinished Build). */
  readonly deferred?: string;
}

/**
 * Plugin bundles: skills + MCP definitions + optional trusted Runner extensions, published atomically as
 * one versioned extension (so an update with a failing check rolls back as a unit). Runner extensions are
 * validated with the existing closure capture (nothing is imported) and activate only at a Runner restart
 * with no active Build.
 */
export function createPluginHandler(options: PluginHandlerOptions): ExtensionKindHandler {
  const packages = new ExtensionPackageStore(options.home);
  return {
    kind: "plugin",
    claims: (_request, tree) => tree !== undefined && (fileOf(tree, PLUGIN_MANIFEST_FILE) !== undefined || foreignFormat(tree) !== undefined),
    inspect: async (_request: SourceRequest, tree, context) => {
      if (!tree || !context.source) throw new ExtensionManagementError("plugin_invalid", "A plugin is a folder, archive or Git source.");
      const foreign = foreignFormat(tree);
      if (!fileOf(tree, PLUGIN_MANIFEST_FILE) && foreign) {
        throw new ExtensionManagementError("plugin_format_unsupported", `This looks like ${foreign.name}, not an AI Board plugin (${PLUGIN_MANIFEST_FILE}). ${foreign.missing}`, 422);
      }
      return await inspectPlugin(tree, context.source, packages, options);
    },
    check: async (extension, version) => await checkPlugin(extension, version, packages, options),
  };
}

/**
 * Decides, at Runner start, which staged plugin Runner extensions join this Runner's capability
 * configuration. A Build's capability contract is fixed for its lifetime, so nothing activates while
 * any Build is unfinished (set-aside runs included). Each closure is re-captured and validated
 * statically (no import) and must still match what was installed; id clashes are refused.
 */
export async function activateStagedRunnerExtensions(input: {
  readonly staged: readonly StagedRunnerExtension[];
  readonly unfinishedBuilds: () => number;
  readonly configuredDirectories: readonly string[];
}): Promise<RunnerExtensionActivation> {
  const active = new Set<string>();
  const refused = new Map<string, string>();
  if (input.staged.length === 0) return { active, refused };
  const unfinished = input.unfinishedBuilds();
  if (unfinished > 0) return { active, refused, deferred: `${unfinished} unfinished Build(s) keep their capabilities until they finish or are cancelled.` };
  const ids = new Set<string>();
  for (const directory of input.configuredDirectories) {
    const closure = await captureRunnerExtensionClosure(directory).catch(() => undefined);
    if (closure) ids.add(closure.manifest.id);
  }
  for (const entry of input.staged) {
    try {
      const closure = await captureRunnerExtensionClosure(entry.directory);
      if (closure.manifest.id !== entry.extensionId || closure.contract.manifestDigest !== entry.manifestDigest) throw new Error("its files changed since installation");
      if (ids.has(closure.manifest.id)) throw new Error("an extension with the same id is already configured");
      ids.add(closure.manifest.id);
      active.add(entry.directory);
    } catch (error) {
      refused.set(entry.directory, error instanceof Error ? error.message : String(error));
    }
  }
  return { active, refused };
}

function fileOf(tree: PackageTree, path: string): Buffer | undefined {
  return tree.files.find((file) => file.path === path)?.bytes;
}

/**
 * A foreign bundle with no AI Board manifest. When it also holds SKILL.md folders it is left to the
 * skill installer (those skills install as skills); otherwise it is refused with an explanation.
 */
function foreignFormat(tree: PackageTree) {
  if (tree.files.some((file) => file.path === "SKILL.md" || file.path.endsWith("/SKILL.md"))) return undefined;
  return FOREIGN_FORMATS.find((format) => {
    const file = fileOf(tree, format.marker);
    return file !== undefined && (!format.test || format.test(file.toString("utf8")));
  });
}

export function parsePluginManifest(bytes: Buffer): PluginManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw invalid("is larger than 64 KiB");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid("is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("must be an object");
  const value = raw as Record<string, unknown>;
  const allowed = ["$schema", "schemaVersion", "id", "name", "version", "description", "license", "homepage", "skills", "mcpServers", "runnerExtensions", "requires"];
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw invalid(`has unsupported fields: ${unknown.join(", ")} (authorization, hooks and lifecycle settings cannot come from a manifest)`);
  if (value.schemaVersion !== PLUGIN_SCHEMA_VERSION) throw invalid(`needs "schemaVersion": ${PLUGIN_SCHEMA_VERSION}`);
  const text = (key: string, max: number, required = true) => {
    const field = value[key];
    if (field === undefined && !required) return undefined;
    if (typeof field !== "string" || !field.trim() || field.length > max || /[\0\r\n]/.test(field)) throw invalid(`field ${key} must be text (≤ ${max} characters)`);
    return field.trim();
  };
  const id = text("id", 64)!;
  if (!PLUGIN_ID.test(id)) throw invalid("id must be lowercase letters, digits, '.', '_' or '-'");
  const list = <T>(key: string, parse: (entry: Record<string, unknown>) => T): T[] => {
    const field = value[key];
    if (field === undefined) return [];
    if (!Array.isArray(field) || field.length > MAX_COMPONENTS) throw invalid(`${key} must be an array of at most ${MAX_COMPONENTS}`);
    return field.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(`${key} entries must be objects`);
      return parse(entry as Record<string, unknown>);
    });
  };
  const path = (entry: Record<string, unknown>, key: string, owner: string) => {
    const field = entry[key];
    if (typeof field !== "string") throw invalid(`${owner}.${key} must be a path`);
    try {
      return normalizePackagePath(field);
    } catch {
      throw invalid(`${owner}.${key} "${field}" is not a contained relative path`);
    }
  };
  const only = (entry: Record<string, unknown>, keys: string[], owner: string) => {
    const extra = Object.keys(entry).filter((key) => !keys.includes(key));
    if (extra.length) throw invalid(`${owner} has unsupported fields: ${extra.join(", ")}`);
  };
  const skills = list("skills", (entry) => { only(entry, ["path"], "skills"); return { path: path(entry, "path", "skills") }; });
  const mcpServers = list("mcpServers", (entry) => {
    only(entry, ["id", "definitionPath"], "mcpServers");
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.id)) throw invalid("mcpServers.id must be a short lowercase name");
    return { id: entry.id, definitionPath: path(entry, "definitionPath", "mcpServers") };
  });
  const runnerExtensions = list("runnerExtensions", (entry) => { only(entry, ["path"], "runnerExtensions"); return { path: path(entry, "path", "runnerExtensions") }; });
  const requires = list("requires", (entry): ExtensionDependency => {
    only(entry, ["kind", "name"], "requires");
    if ((entry.kind !== "skill" && entry.kind !== "mcp_server") || typeof entry.name !== "string" || !entry.name || entry.name.length > 120) throw invalid("requires entries need kind skill|mcp_server and a name");
    return { kind: entry.kind, name: entry.name };
  });
  if (!skills.length && !mcpServers.length && !runnerExtensions.length) throw invalid("declares no components");
  const description = text("description", 1024, false);
  const license = text("license", 128, false);
  const homepage = text("homepage", 512, false);
  return {
    schemaVersion: 1, id, name: text("name", 120)!, version: text("version", 64)!,
    ...(description ? { description } : {}), ...(license ? { license } : {}), ...(homepage ? { homepage } : {}),
    skills, mcpServers, runnerExtensions, requires,
  };
}

async function inspectPlugin(tree: PackageTree, source: ResolvedSource, packages: ExtensionPackageStore, options: PluginHandlerOptions): Promise<HandlerInspection> {
  const manifest = parsePluginManifest(fileOf(tree, PLUGIN_MANIFEST_FILE)!);
  // Content-addressed staging is not execution; it gives bundled scripts their final immutable path.
  await packages.commit(tree);
  const root = packages.packageDirectory(tree.digest);
  const components: ExtensionComponent[] = [];
  const warnings: string[] = [];
  const credentials: string[] = [];
  const network = new Set<string>();
  let executes: AccessSummary["executesCode"] = "never";

  for (const declared of manifest.skills) {
    const found = discoverSkills(subtree(tree, declared.path));
    if (found.skills.length !== 1) throw invalid(`skills path ${declared.path} must hold exactly one SKILL.md (${found.invalid.flatMap((entry) => entry.errors).join("; ") || `found ${found.skills.length}`})`);
    const skill = found.skills[0]!.component;
    components.push({ ...skill, componentId: `skill:${skill.skillName}`, packagePath: declared.path });
    warnings.push(...skill.warnings);
  }
  for (const declared of manifest.mcpServers) {
    const bytes = fileOf(tree, declared.definitionPath);
    if (!bytes) throw invalid(`mcpServers ${declared.id}: ${declared.definitionPath} is missing`);
    let definition: unknown;
    try {
      definition = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw invalid(`mcpServers ${declared.id}: ${declared.definitionPath} is not valid JSON`);
    }
    const server = await options.mcp.pluginServerComponent({ serverName: declared.id, ...(definition as object) }, root);
    components.push({ ...server.component, componentId: `mcp:${server.component.serverName}` });
    credentials.push(...server.requiredCredentials);
    server.access.network.forEach((host) => network.add(host));
    if (server.access.executesCode !== "never") executes = "on_use";
  }
  for (const declared of manifest.runnerExtensions) {
    // The existing loader's static closure capture: manifest, contained relative ESM graph, no import.
    const closure = await captureRunnerExtensionClosure(join(root, ...declared.path.split("/"))).catch((error: unknown) => {
      throw invalid(`runnerExtensions ${declared.path}: ${error instanceof Error ? error.message : String(error)}`);
    });
    components.push({ kind: "runner_extension", componentId: `runner:${closure.manifest.id}`, extensionId: closure.manifest.id, packagePath: declared.path, manifestDigest: closure.contract.manifestDigest } satisfies RunnerExtensionComponent);
    executes = "on_use";
    warnings.push(`Runner extension "${closure.manifest.id}" runs inside the Runner process with your user account; it is not sandboxed. It becomes active after a Runner restart while no Build is running.`);
  }
  const names = components.map((component) => component.componentId);
  if (new Set(names).size !== names.length) throw invalid("declares two components with the same name");
  if (manifest.requires.length) warnings.push(`Uses installed ${manifest.requires.map((entry) => `${entry.kind === "skill" ? "skill" : "MCP server"} "${entry.name}"`).join(", ")}; they cannot be removed while this plugin needs them.`);
  const executable = components.some((component) => component.kind === "runner_extension" || (component.kind === "mcp_server" && component.transport === "stdio"));
  return {
    kind: "plugin", name: manifest.name, version: manifest.version, source, components,
    warnings: [...new Set(warnings)],
    access: {
      executesCode: executes,
      network: [...network],
      filesystem: executable ? "Bundled programs run as your user account with the project folder as working directory. Not sandboxed." : "Instructions and files only.",
      credentials: [...new Set(credentials)],
      notes: [
        `${manifest.skills.length} skill(s), ${manifest.mcpServers.length} MCP server(s), ${manifest.runnerExtensions.length} Runner extension(s).`,
        ...(manifest.license ? [`License: ${manifest.license}.`] : []),
        "Labels in the package (such as \"read-only\" or \"official\") are not verified.",
      ],
    },
    requiresExecutableTrust: executable,
    requiredCredentials: [...new Set(credentials)],
    ...(manifest.requires.length ? { dependencies: manifest.requires } : {}),
    trees: new Map([["", tree]]),
  };
}

async function checkPlugin(extension: InstalledExtension, version: ExtensionVersion, packages: ExtensionPackageStore, options: PluginHandlerOptions): Promise<ExtensionReadiness> {
  const now = new Date().toISOString();
  const states: Array<{ id: string; readiness: ExtensionReadiness }> = [];
  for (const component of version.components) {
    if (component.kind === "skill") {
      try {
        const text = await packages.read(version.packageDigest!, [component.packagePath, "SKILL.md"].filter(Boolean).join("/"), 256 * 1024);
        if (discoverSkills(singleFileSkillTree(text)).skills[0]?.component.skillName !== component.skillName) throw new Error("instructions no longer match");
        states.push({ id: component.componentId, readiness: { state: "ready", checkedAt: now } });
      } catch (error) {
        states.push({ id: component.componentId, readiness: { state: "failed", checkedAt: now, lastError: { code: "skill_unreadable", message: `${component.skillName}: ${error instanceof Error ? error.message : String(error)}`, at: now } } });
      }
    } else if (component.kind === "mcp_server") {
      const readiness = await options.mcp.checkComponent(extension.id, version.versionId, component as McpServerComponent);
      states.push({ id: component.componentId, readiness: readiness.lastError ? { ...readiness, lastError: { ...readiness.lastError, message: `${component.serverName}: ${readiness.lastError.message}` } } : readiness });
    } else {
      const directory = join(packages.packageDirectory(version.packageDigest!), ...component.packagePath.split("/"));
      const activation = options.runnerExtensions?.();
      const refused = activation?.refused.get(directory);
      states.push({ id: component.componentId, readiness: activation?.active.has(directory)
        ? { state: "ready", checkedAt: now, detail: `Runner extension "${component.extensionId}" is loaded; new Builds use it.` }
        : refused
          ? { state: "failed", checkedAt: now, lastError: { code: "runner_extension_refused", message: `Runner extension "${component.extensionId}": ${refused}`, at: now } }
          : { state: "restart_required", checkedAt: now, detail: `Runner extension "${component.extensionId}" activates when the Runner restarts with no unfinished Build.${activation?.deferred ? ` ${activation.deferred}` : ""}` } });
    }
  }
  const components = Object.fromEntries(states.map((entry) => [entry.id, entry.readiness.state]));
  const failed = states.find((entry) => entry.readiness.state === "failed");
  if (failed) return { ...failed.readiness, components };
  const auth = states.find((entry) => entry.readiness.state === "needs_auth");
  if (auth) return { ...auth.readiness, components };
  const restart = states.find((entry) => entry.readiness.state === "restart_required");
  if (restart) return { ...restart.readiness, components };
  return { state: "ready", checkedAt: now, detail: `${states.length} component(s) ready.`, components };
}

function invalid(message: string): ExtensionManagementError {
  return new ExtensionManagementError("plugin_invalid", `${PLUGIN_MANIFEST_FILE} ${message}.`, 422);
}
