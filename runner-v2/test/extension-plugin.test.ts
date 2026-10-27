import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { LocalPluginLoader } from "../src/plugin-loader.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { ExtensionCredentialStore } from "../src/extension-credentials.js";
import { ExtensionManagementError } from "../src/extension-management-contracts.js";
import { ExtensionManagementService, type ManagementCaller } from "../src/extension-management-service.js";
import { ManagedMcpRuntime } from "../src/extension-mcp.js";
import { activateStagedRunnerExtensions, createPluginHandler, parsePluginManifest, PLUGIN_MANIFEST_FILE, type RunnerExtensionActivation } from "../src/extension-plugin.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";

const UI: ManagementCaller = { kind: "ui" };
const FIXTURE = fileURLToPath(new URL("./fixtures/extension-mcp-server.mjs", import.meta.url));

interface Fixture {
  root: string;
  extensions: ExtensionManagementService;
  setActivation(next: RunnerExtensionActivation): void;
}

/** Real ExecutionHost, internal process kernel and MCP discovery; plugin sources are local folders. */
async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aiboard-ext-plugin-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const home = join(root, "home");
  await mkdir(project, { recursive: true });
  await mkdir(state, { recursive: true });
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && /^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(name))) as Record<string, string>;
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: ambient });
  const internal = createRunnerInternalExecutionContext({ projectDirectory: project, stateDirectory: state, processKernel: host.internalProcesses, ambientEnvironment: host.filteredEnvironmentSource() });
  const credentials = new ExtensionCredentialStore(join(state, "extension-credentials.enc"), Buffer.alloc(32, 1));
  const runtime = new ManagedMcpRuntime({
    home, stateDirectory: state, projectRoot: project, credentials, internal, executionHost: host, capabilitiesConfig: () => emptyRunnerCapabilitiesConfig(),
    installer: {
      nodeExecutable: process.execPath, environment: host.filteredEnvironmentSource(),
      fetchJson: async () => { throw new Error("no network in tests"); },
      run: async () => { throw new Error("no installer in this test"); },
    },
  });
  let activation: RunnerExtensionActivation = { active: new Set(), refused: new Map() };
  const extensions = await ExtensionManagementService.open({
    home, projectRoot: project, credentials,
    handlers: [runtime.handler(), createPluginHandler({ home, mcp: runtime, runnerExtensions: () => activation })],
  });
  runtime.attach(extensions);
  t.after(async () => {
    credentials.close();
    await internal.close();
    await host.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { root, extensions, setActivation: (next) => { activation = next; } };
}

interface BundleOptions {
  version?: string;
  serverMode?: string;
  requires?: Array<{ kind: "skill" | "mcp_server"; name: string }>;
  runnerExtension?: boolean;
  extraManifest?: Record<string, unknown>;
  mcp?: boolean;
}

/** Writes a plugin folder: one skill, optionally the fixture MCP server and a Runner extension. */
async function writeBundle(directory: string, options: BundleOptions = {}): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, "skills", "release-notes"), { recursive: true });
  await writeFile(join(directory, "skills", "release-notes", "SKILL.md"), [
    "---", "name: release-notes", `description: Drafts release notes from merged changes (bundle ${options.version ?? "1.0.0"}).`, "---", "", "Group changes by area and keep one line per change.", "",
  ].join("\n"));
  const manifest: Record<string, unknown> = {
    schemaVersion: 1, id: "example.release-kit", name: "Release kit", version: options.version ?? "1.0.0", license: "MIT",
    skills: [{ path: "skills/release-notes" }],
    ...options.extraManifest,
  };
  if (options.mcp !== false) {
    await mkdir(join(directory, "mcp"), { recursive: true });
    await copyFile(FIXTURE, join(directory, "server.mjs"));
    await writeFile(join(directory, "mcp", "notes.json"), JSON.stringify({ transport: "stdio", command: process.execPath, args: ["${PLUGIN_ROOT}/server.mjs", options.serverMode ?? "ok"] }));
    manifest.mcpServers = [{ id: "notes", definitionPath: "mcp/notes.json" }];
  }
  if (options.runnerExtension) {
    await mkdir(join(directory, "runner"), { recursive: true });
    await writeFile(join(directory, "runner", "runner-extension.json"), JSON.stringify({ apiVersion: 1, id: "example.release-tools", name: "Release tools", version: "1.0.0", entry: "index.mjs", capabilities: [] }));
    await writeFile(join(directory, "runner", "index.mjs"), "export default function create() { return { async close() {} }; }\n");
    manifest.runnerExtensions = [{ path: "runner" }];
  }
  if (options.requires) manifest.requires = options.requires;
  await writeFile(join(directory, PLUGIN_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
}

async function install(env: Fixture, path: string) {
  const view = await env.extensions.inspectSource({ type: "local_directory", path }, UI);
  const plan = await env.extensions.planChange({ action: "install", inspectionId: view.inspectionId, scope: env.extensions.projectScope() }, UI);
  return { view, plan, operation: await env.extensions.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: `ui-${plan.planId}` }, UI) };
}

async function change(env: Fixture, action: "remove" | "disable" | "enable", extensionId: string) {
  const plan = await env.extensions.planChange({ action, extensionId }, UI);
  return await env.extensions.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: `ui-${plan.planId}` }, UI);
}

test("a skill + MCP plugin installs atomically: one generation, both components live and checked", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const bundle = join(env.root, "release-kit");
  await writeBundle(bundle);
  const { view, operation } = await install(env, bundle);
  assert.equal(view.kind, "plugin");
  assert.deepEqual(view.components.map((component) => component.componentId).sort(), ["mcp:notes", "skill:release-notes"]);
  assert.equal(view.requiresExecutableTrust, true, "a bundled stdio server is executable content");
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("; "));
  assert.equal(operation.result?.readiness?.state, "ready", JSON.stringify(operation.result?.readiness));
  assert.deepEqual(operation.result?.readiness?.components, { "skill:release-notes": "ready", "mcp:notes": "ready" });

  const generation = operation.result!.generation!;
  assert.equal(generation, 1, "both components published in a single generation");
  const skills = await env.extensions.managedSkills(generation);
  assert.deepEqual(skills.map((skill) => skill.name), ["release-notes"]);
  const servers = await env.extensions.managedMcpServers(generation);
  assert.deepEqual(servers.map((server) => server.component.serverName), ["notes"]);
  // ${PLUGIN_ROOT} resolved to the immutable package copy, never the user's source folder.
  assert.ok(!JSON.stringify(servers[0]!.component).includes(bundle.replaceAll("\\", "\\\\")), "launch must not reference the mutable source folder");
});

test("an update whose MCP server fails its check rolls back the whole bundle", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const bundle = join(env.root, "release-kit");
  await writeBundle(bundle);
  const first = await install(env, bundle);
  assert.equal(first.operation.outcome, "succeeded", first.operation.diagnostics.join("; "));
  const extensionId = first.operation.result!.extensionId!;
  const before = (await env.extensions.inventory()).items.find((entry) => entry.id === extensionId)!;

  await writeBundle(bundle, { version: "2.0.0", serverMode: "crash" });
  const second = await install(env, bundle);
  assert.equal(second.plan.action, "update");
  assert.equal(second.operation.outcome, "rolled_back", second.operation.diagnostics.join("; "));
  const after = (await env.extensions.inventory()).items.find((entry) => entry.id === extensionId)!;
  assert.equal(after.currentVersion?.versionId, before.currentVersion?.versionId, "the previous version is current again");
  assert.equal(after.currentVersion?.version, "1.0.0");
  const skills = await env.extensions.managedSkills((await env.extensions.inventory()).currentGeneration);
  assert.match(skills[0]!.description, /bundle 1\.0\.0/, "the skill also rolled back with the bundle");
});

test("plugin dependencies must exist and are retained while the plugin needs them", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const bundle = join(env.root, "release-kit");
  await writeBundle(bundle, { mcp: false, requires: [{ kind: "skill", name: "changelog-style" }] });
  const missing = await install(env, bundle);
  assert.equal(missing.operation.outcome, "failed");
  assert.match(missing.operation.diagnostics.join(" "), /changelog-style.*not installed/);

  const shared = join(env.root, "changelog-style");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "SKILL.md"), "---\nname: changelog-style\ndescription: House style for changelog entries.\n---\n\nUse the imperative mood.\n");
  const skill = await install(env, shared);
  assert.equal(skill.operation.outcome, "succeeded", skill.operation.diagnostics.join("; "));
  const skillId = skill.operation.result!.extensionId!;

  const plugin = await install(env, bundle);
  assert.equal(plugin.operation.outcome, "succeeded", plugin.operation.diagnostics.join("; "));
  const pluginId = plugin.operation.result!.extensionId!;
  assert.deepEqual((await env.extensions.extensionRecord(skillId))?.referencedBy, [pluginId]);

  const blocked = await change(env, "remove", skillId);
  assert.notEqual(blocked.outcome, "succeeded");
  assert.match(blocked.diagnostics.join(" "), /used by/);
  assert.ok(await env.extensions.extensionRecord(skillId), "the shared skill stays installed");

  const removedPlugin = await change(env, "remove", pluginId);
  assert.equal(removedPlugin.outcome, "succeeded", removedPlugin.diagnostics.join("; "));
  assert.deepEqual((await env.extensions.extensionRecord(skillId))?.referencedBy, []);
  const removedSkill = await change(env, "remove", skillId);
  assert.equal(removedSkill.outcome, "succeeded", removedSkill.diagnostics.join("; "));
});

test("foreign plugin formats are explained and never become ready", async (t) => {
  const env = await fixture(t);
  const claude = join(env.root, "claude-plugin");
  await mkdir(join(claude, ".claude-plugin"), { recursive: true });
  await writeFile(join(claude, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "x" }));
  await writeFile(join(claude, "README.md"), "hooks and commands\n");
  await assert.rejects(env.extensions.inspectSource({ type: "local_directory", path: claude }, UI),
    (error: unknown) => error instanceof ExtensionManagementError && error.code === "plugin_format_unsupported" && /Claude Code plugin/.test(error.message));

  // A Claude Code plugin that ships SKILL.md folders still installs those skills as skills.
  await mkdir(join(claude, "skills", "triage"), { recursive: true });
  await writeFile(join(claude, "skills", "triage", "SKILL.md"), "---\nname: triage\ndescription: Triage incoming issues.\n---\n\nLabel by area.\n");
  const skills = await env.extensions.inspectSource({ type: "local_directory", path: claude }, UI);
  assert.equal(skills.kind, "skill");
  assert.deepEqual(skills.components.map((component) => component.componentId), ["skill:triage"]);

  const gemini = join(env.root, "gemini");
  await mkdir(gemini, { recursive: true });
  await writeFile(join(gemini, "gemini-extension.json"), JSON.stringify({ name: "x", version: "1" }));
  await assert.rejects(env.extensions.inspectSource({ type: "local_directory", path: gemini }, UI),
    (error: unknown) => error instanceof ExtensionManagementError && error.code === "plugin_format_unsupported");

  const vscode = join(env.root, "vscode");
  await mkdir(vscode, { recursive: true });
  await writeFile(join(vscode, "package.json"), JSON.stringify({ name: "x", engines: { vscode: "^1.90.0" } }));
  await assert.rejects(env.extensions.inspectSource({ type: "local_directory", path: vscode }, UI),
    (error: unknown) => error instanceof ExtensionManagementError && error.code === "plugin_format_unsupported" && /VS Code/.test(error.message));
  assert.deepEqual((await env.extensions.inventory()).items.filter((entry) => entry.kind === "plugin"), []);
});

test("manifests cannot carry authorization or escape the bundle", () => {
  const base = { schemaVersion: 1, id: "example.kit", name: "Kit", version: "1", skills: [{ path: "skills/a" }] };
  const parse = (value: unknown) => parsePluginManifest(Buffer.from(JSON.stringify(value)));
  assert.equal(parse(base).id, "example.kit");
  assert.throws(() => parse({ ...base, approved: true }), /unsupported fields: approved/);
  assert.throws(() => parse({ ...base, hooks: { preToolUse: "x" } }), /unsupported fields: hooks/);
  assert.throws(() => parse({ ...base, skills: [{ path: "../outside" }] }), /not a contained relative path/);
  assert.throws(() => parse({ ...base, skills: [{ path: "C:/Windows" }] }), /not a contained relative path/);
  assert.throws(() => parse({ ...base, skills: [{ path: "skills/a", trusted: true }] }), /unsupported fields: trusted/);
  assert.throws(() => parse({ ...base, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => parse({ ...base, skills: [] }), /declares no components/);
  assert.throws(() => parse({ ...base, requires: [{ kind: "plugin", name: "x" }] }), /requires entries/);
});

test("a bundled Runner extension is validated without import and reports restart_required until loaded at startup", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const bundle = join(env.root, "release-kit");
  await writeBundle(bundle, { mcp: false, runnerExtension: true });
  const { view, operation } = await install(env, bundle);
  assert.equal(view.requiresExecutableTrust, true);
  assert.ok(view.warnings.some((warning) => /not sandboxed/.test(warning)));
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("; "));
  assert.equal(operation.result?.readiness?.state, "restart_required", JSON.stringify(operation.result?.readiness));
  assert.deepEqual(operation.result?.readiness?.components, { "skill:release-notes": "ready", "runner:example.release-tools": "restart_required" });

  const staged = await env.extensions.stagedRunnerExtensions();
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.extensionId, "example.release-tools");
  const extensionId = operation.result!.extensionId!;

  // A start with an unfinished Build keeps it staged: that Build's capability contract is fixed.
  const deferred = await activateStagedRunnerExtensions({ staged, unfinishedBuilds: () => 1, configuredDirectories: [] });
  assert.equal(deferred.active.size, 0);
  assert.match(deferred.deferred ?? "", /1 unfinished Build/);
  env.setActivation(deferred);
  const waiting = await env.extensions.test(extensionId);
  assert.equal(waiting.state, "restart_required");
  assert.match(waiting.detail ?? "", /unfinished Build/);

  // A start with no unfinished Build loads it into the capability configuration → ready.
  const loaded = await activateStagedRunnerExtensions({ staged, unfinishedBuilds: () => 0, configuredDirectories: [] });
  assert.deepEqual([...loaded.active], [staged[0]!.directory]);
  env.setActivation(loaded);
  const ready = await env.extensions.test(extensionId);
  assert.equal(ready.state, "ready", JSON.stringify(ready));

  // An id clash with an operator-configured extension is refused with the reason, not "ready".
  const clash = await activateStagedRunnerExtensions({ staged, unfinishedBuilds: () => 0, configuredDirectories: [join(bundle, "runner")] });
  assert.equal(clash.active.size, 0);
  env.setActivation(clash);
  const refused = await env.extensions.test(extensionId);
  assert.equal(refused.state, "failed");
  assert.match(refused.lastError?.message ?? "", /same id/);

  // A disabled plugin's Runner extension is not staged for the next start.
  await change(env, "disable", extensionId);
  assert.deepEqual(await env.extensions.stagedRunnerExtensions(), []);
});


test("disabling a loaded plugin immediately revokes calls and prevents loading into another Build", async t => {
  const env = await fixture(t);
  const bundle = join(env.root, "revocable-kit");
  await writeBundle(bundle, { mcp: false, runnerExtension: true });
  await writeFile(join(bundle, "runner", "runner-extension.json"), JSON.stringify({ apiVersion: 1, id: "example.release-tools", name: "Release", version: "1", entry: "index.mjs", capabilities: ["tools"] }));
  await writeFile(join(bundle, "runner", "index.mjs"), `export function createExtension() { return {
    capabilities() { return { tools: [{ definition: { name: "release.status", description: "Read release status", inputSchema: {type:"object"}, readOnly:true, effect:"none" }, validate: input => ({ok:true,value:input}), execute: async () => ({isError:false,content:[{type:"text",text:"READY"}]}) }], contextContributors:[], languageProviders:[] }; },
    async start() {}, async close() {}
  }; }`);
  const { operation } = await install(env, bundle);
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("; "));
  const staged = await env.extensions.stagedRunnerExtensions();
  const options = { pluginDirectories: staged.map(entry => entry.directory), projectDirectory: join(env.root, "project"), stateDirectory: join(env.root, "state"), admitExtension: (id: string) => env.extensions.runnerExtensionAllowed(id) };
  let checks = 0;
  const revokedBeforeStart = await new LocalPluginLoader({...options,admitExtension:async()=>++checks !== 2}).load();
  const context = { runId:"build", sessionId:"worker", actor:{role:"worker" as const,id:"worker"} };
  assert.equal((await revokedBeforeStart.registry.tools()[0]!.tool.execute({},context)).error?.code,"extension_disabled",
    "a component revoked before start cannot become callable merely because it is enabled again");
  await revokedBeforeStart.close();
  const loaded = await new LocalPluginLoader(options).load();
  t.after(() => loaded.close());
  const tool = loaded.registry.tools()[0]!.tool;
  assert.equal((await tool.execute({}, context)).isError, false);
  assert.equal((await change(env, "disable", operation.result!.extensionId!)).outcome, "succeeded");
  assert.equal((await tool.execute({}, context)).error?.code, "extension_disabled");
  const nextBuild = await new LocalPluginLoader(options).load();
  t.after(() => nextBuild.close());
  assert.equal(nextBuild.registry.tools().length, 0);
  assert.equal(await env.extensions.runnerExtensionAllowed("operator.configured"), true);
});
