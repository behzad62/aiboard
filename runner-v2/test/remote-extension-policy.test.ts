import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolExecutionContext } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ExtensionCredentialStore } from "../src/extension-credentials.js";
import { extensionToolAdmitted, validateExtensionToolPolicy, type ExtensionToolPolicy, type McpServerComponent } from "../src/extension-management-contracts.js";
import { ExtensionManagementService, type ManagementCaller } from "../src/extension-management-service.js";
import { ManagedMcpRuntime } from "../src/extension-mcp.js";
import { ExtensionRegistryStore, generationDigest } from "../src/extension-registry.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import { canonicalMcpDigest, mcpConfigurationDigest } from "../src/mcp-configuration.js";
import { ManagedBuildToolRuntime } from "../src/managed-build-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { McpManager, type McpRequestOwner, type McpTransportFactory, type McpTransportWriter } from "../src/mcp-tools.js";
import type { McpDiscoveryResult, RunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";

const UI: ManagementCaller = { kind: "ui" };
const DIGEST = "a".repeat(64);
const NOW = "2026-10-27T00:00:00.000Z";

async function temporary(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiboard-r1c-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

async function v1Fixture(home: string): Promise<{ oldGeneration: string; oldRegistry: string }> {
  await mkdir(join(home, "generations"), { recursive: true });
  const records = [
    { id: "ext_alpha", versionId: "ver_alpha", approval: "all" as const },
    { id: "ext_bravo", versionId: "ver_bravo", approval: "non_destructive" as const },
    { id: "ext_charlie", versionId: "ver_charlie", approval: "non_destructive" as const },
  ];
  const source = { type: "remote_http" as const, url: "http://127.0.0.1:9999/mcp" };
  const scope = { kind: "user" as const };
  const components = (item: typeof records[number]): McpServerComponent[] => [{ kind: "mcp_server", componentId: "mcp:" + item.id,
    serverName: item.id, transport: "streamable_http", environment: [], route: "runner", url: source.url,
    schemaDigest: DIGEST, toolNames: ["read", "write"], toolApproval: item.approval }];
  const extensions = records.map((item) => ({ id: item.id, kind: "mcp_server", name: item.id, scope, provenance: "managed", source,
    currentVersionId: item.versionId, enabled: true, desiredGeneration: 1, activeGeneration: 1, readiness: { state: "ready" },
    componentIds: ["mcp:" + item.id], credentialRefs: ["credential-ref"], previousVersionIds: [], referencedBy: [], installedAt: NOW, updatedAt: NOW }));
  const versions = records.map((item) => ({ versionId: item.versionId, extensionId: item.id, source, components: components(item), createdAt: NOW, operationId: "install" }));
  const entries = records.map((item) => ({ extensionId: item.id, kind: "mcp_server" as const, name: item.id, scope, versionId: item.versionId, components: components(item) }));
  const generation = { generation: 1, createdAt: NOW, entries, digest: generationDigest(entries) };
  const registry = { schemaVersion: 1, revision: 9, currentGeneration: 1, extensions, versions,
    policy: { version: 1, humanRequestedSkills: "auto", humanRequestedExecutable: "ask", trustedSources: [] }, migrations: [] };
  const oldGeneration = JSON.stringify(generation, null, 2);
  const oldRegistry = JSON.stringify(registry, null, 2);
  await writeFile(join(home, "generations", "1.json"), oldGeneration);
  await writeFile(join(home, "registry.json"), oldRegistry);
  await writeFile(join(home, "mcp-tool-policy.json"), JSON.stringify({ ext_bravo: "all" }));
  return { oldGeneration, oldRegistry };
}

for (const crash of ["backup", "journal", "generation", "registry"] as const) {
  test("v1 migration recovers after " + crash + " without rewriting its generation", async (t) => {
    const home = join(await temporary(t), "home");
    const before = await v1Fixture(home);
    const interrupted = new ExtensionRegistryStore(home, (step) => { if (step === crash) throw new Error("simulated crash"); });
    await assert.rejects(interrupted.load(), /simulated crash/);
    const store = new ExtensionRegistryStore(home);
    const registry = await store.load();
    assert.equal(registry.schemaVersion, 2);
    assert.equal(registry.currentGeneration, 2);
    assert.equal(await readFile(join(home, "generations", "1.json"), "utf8"), before.oldGeneration);
    assert.equal(await readFile(join(home, "registry.v1.backup.json"), "utf8"), before.oldRegistry);
    assert.equal(registry.extensions[0]!.credentialRefs[0], "credential-ref");
    assert.deepEqual(registry.toolPolicies.ext_alpha!.toolFilter.allow.map((key) => key.toolName), ["read", "write"]);
    assert.equal(registry.toolPolicies.ext_alpha!.remoteExposure, false);
    assert.equal(registry.toolPolicies.ext_alpha!.riskLabel, "unreviewed");
    const generation = await store.generation(2);
    const alpha = generation.entries.find((item) => item.extensionId === "ext_alpha")!;
    const bravo = generation.entries.find((item) => item.extensionId === "ext_bravo")!;
    const charlie = generation.entries.find((item) => item.extensionId === "ext_charlie")!;
    assert.equal(alpha.components[0]!.kind === "mcp_server" && alpha.components[0]!.toolApproval, "all");
    assert.equal(bravo.toolApprovalOverride, "all", "separate override wins over component non_destructive");
    assert.equal(charlie.components[0]!.kind === "mcp_server" && charlie.components[0]!.toolApproval, "non_destructive");
    const runtime = new ManagedMcpRuntime({ home, stateDirectory: home, projectRoot: home, credentials: {} as ExtensionCredentialStore, internal: {} as RunnerInternalExecutionContext,
      installer: { nodeExecutable: process.execPath, environment: {}, fetchJson: async () => ({}), run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) } });
    assert.equal(await runtime.toolPolicyFor("ext_bravo", bravo.components[0] as McpServerComponent), "all");
    assert.equal(await runtime.toolPolicyFor("ext_charlie", charlie.components[0] as McpServerComponent), "non_destructive");
    assert.deepEqual(await store.load(), registry);
  });
}

test("a v1 server without a retained schema inventory migrates with no local tool grants", async (t) => {
  const home = join(await temporary(t), "home");
  await v1Fixture(home);
  const registry = JSON.parse(await readFile(join(home, "registry.json"), "utf8")) as { versions: Array<{ extensionId: string; components: Array<Record<string, unknown>> }> };
  const version = registry.versions.find((item) => item.extensionId === "ext_alpha")!;
  delete version.components[0]!.schemaDigest;
  delete version.components[0]!.toolNames;
  await writeFile(join(home, "registry.json"), JSON.stringify(registry));
  const migrated = await new ExtensionRegistryStore(home).load();
  assert.deepEqual(migrated.toolPolicies.ext_alpha!.toolFilter.allow, []);
  assert.deepEqual(migrated.toolPolicies.ext_alpha!.reviewed, []);
  assert.equal(migrated.toolPolicies.ext_alpha!.remoteExposure, false);
});

test("malformed legacy approval policy leaves the original registry untouched", async (t) => {
  const home = join(await temporary(t), "home");
  const before = await v1Fixture(home);
  await writeFile(join(home, "mcp-tool-policy.json"), "not-json");
  await assert.rejects(new ExtensionRegistryStore(home).load(), /approval policy/i);
  assert.equal(await readFile(join(home, "registry.json"), "utf8"), before.oldRegistry);
  assert.equal(await readFile(join(home, "generations", "1.json"), "utf8"), before.oldGeneration);
});

test("exact reviewed inventories fail closed and deny wins", () => {
  const component: McpServerComponent = { kind: "mcp_server", componentId: "one", serverName: "server", transport: "stdio", environment: [], route: "runner" };
  const key = { componentId: "one", toolName: "read" };
  const policy: ExtensionToolPolicy = { version: 1, versionId: "ver", reviewed: [{ componentId: "one", schemaDigest: DIGEST, toolNames: ["read"] }],
    toolFilter: { default: "allow", allow: [key], deny: [key] }, remoteExposure: false, riskLabel: "unreviewed" };
  assert.equal(extensionToolAdmitted(policy, component, DIGEST, ["read"], "read"), false);
  const allowed = { ...policy, toolFilter: { ...policy.toolFilter, deny: [] } };
  assert.equal(extensionToolAdmitted(allowed, component, DIGEST, ["read"], "read"), true);
  assert.equal(extensionToolAdmitted(allowed, component, DIGEST, ["read"], "read", true), false);
  assert.equal(extensionToolAdmitted(allowed, component, DIGEST, ["read", "new"], "new"), false);
  assert.equal(extensionToolAdmitted(allowed, component, "b".repeat(64), ["read"], "read"), false);
  assert.equal(extensionToolAdmitted(allowed, { ...component, route: "provider_hosted" }, DIGEST, ["read"], "read"), false);
  const version = { versionId: "ver", components: [component] };
  assert.throws(() => validateExtensionToolPolicy({ ...allowed, toolFilter: { ...allowed.toolFilter, allow: [key, key] } }, version));
  assert.throws(() => validateExtensionToolPolicy({ ...allowed, toolFilter: { ...allowed.toolFilter, allow: [{ componentId: "other", toolName: "read" }] } }, version));
  assert.throws(() => validateExtensionToolPolicy({ ...allowed, toolFilter: { ...allowed.toolFilter, allow: [{ componentId: "one", toolName: "*" }] } }, version));
});

async function offlineRuntime(t: test.TestContext) {
  const root = await temporary(t);
  const project = join(root, "project");
  const stateDirectory = join(root, "state");
  const home = join(root, "home");
  await mkdir(project, { recursive: true });
  const credentials = new ExtensionCredentialStore(join(stateDirectory, "credentials.enc"), Buffer.alloc(32, 1));
  t.after(() => credentials.close());
  const state = { names: ["read", "write"], schemaVersion: 0, calls: [] as string[] };
  const fakeFetch: typeof fetch = async (_input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} } };
    else if (message.method === "tools/list") result = { tools: state.names.map((name) => ({ name, inputSchema: { type: "object", properties: { version: { const: state.schemaVersion } } }, annotations: { readOnlyHint: true, destructiveHint: false } })) };
    else if (message.method === "tools/call") { state.calls.push(message.params!.name!); result = { content: [{ type: "text", text: "ok" }] }; }
    else throw new Error("unexpected method");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "offline" } });
  };
  const runtime = new ManagedMcpRuntime({ home, stateDirectory, projectRoot: project, credentials,
    internal: {} as RunnerInternalExecutionContext, remoteFetch: fakeFetch,
    installer: { nodeExecutable: process.execPath, environment: {}, fetchJson: async () => { throw new Error("no network"); }, run: async () => { throw new Error("no process"); } } });
  const service = await ExtensionManagementService.open({ home, projectRoot: project, credentials, handlers: [runtime.handler()] });
  runtime.attach(service);
  const view = await service.inspectSource({ type: "remote_http", url: "http://127.0.0.1:9999/mcp", serverName: "offline", auth: "none" }, UI);
  const plan = await service.planChange({ action: "install", inspectionId: view.inspectionId, scope: service.projectScope() }, UI);
  const operation = await service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: "offline-install" }, UI);
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("; "));
  return { root, service, runtime, state, id: operation.result!.extensionId!, artifacts: new ArtifactStore(join(root, "artifacts")) };
}

const context: ToolExecutionContext = { runId: "run", sessionId: "session", actor: { role: "worker", id: "worker" } };

test("approved install is the local review; materialization intersects pinned policy, live deny and remote exposure", async (t) => {
  const f = await offlineRuntime(t);
  const initial = await f.service.extensionToolPolicy(f.id);
  assert.equal(initial.policy.remoteExposure, false);
  assert.deepEqual(initial.policy.reviewed, initial.discovered, "approving the install records the discovered inventory as reviewed");
  assert.equal(initial.policy.toolFilter.default, "deny");
  assert.deepEqual(initial.policy.toolFilter.allow.map((key) => key.toolName).sort(), ["read", "write"], "exactly the discovered tools are allowed locally");
  assert.deepEqual(initial.policy.toolFilter.deny, []);
  const before = await f.runtime.chatTools(initial.currentGeneration, "before", f.artifacts);
  assert.deepEqual(before.tools.map((tool) => tool.definition.name).sort(), ["mcp.offline.read", "mcp.offline.write"]);
  await before.close();
  const remoteBefore = await f.runtime.remoteAdmittedTools(initial.currentGeneration, "remote-before", f.artifacts);
  assert.deepEqual(remoteBefore.tools, [], "remote exposure stays off until explicitly enabled");
  await remoteBefore.close();
  const inventory = initial.discovered[0]!;
  const read = { componentId: inventory.componentId, toolName: "read" };
  const write = { componentId: inventory.componentId, toolName: "write" };
  const reviewed = await f.service.setExtensionToolPolicy(f.id, { ...initial.policy, reviewed: initial.discovered,
    toolFilter: { default: "deny", allow: [read, write], deny: [write] } }, UI);
  const local = await f.runtime.chatTools(reviewed.currentGeneration, "reviewed", f.artifacts);
  t.after(() => local.close());
  assert.deepEqual(local.tools.map((tool) => tool.definition.name), ["mcp.offline.read"]);
  const cached = local.tools[0]!;
  const options = { permissionProfile: "full" as const, workspacePath: join(f.root, "project"), artifacts: f.artifacts };
  const source = { generation: async () => reviewed.currentGeneration, policyRevision: (generation: number) => f.service.policyRevisionForGeneration(generation),
    tools: (generation: number) => f.runtime.chatTools(generation, "refresh", f.artifacts) };
  const build = new ManagedBuildToolRuntime(new ToolBroker(options), source, options, () => true);
  t.after(() => build.close());
  await build.prepare();
  assert.deepEqual(build.definitions().map((tool) => tool.name), ["mcp.offline.read"]);
  assert.equal((await cached.execute({}, context)).isError, false);
  assert.deepEqual(f.state.calls, ["read"]);
  const remoteOff = await f.runtime.remoteAdmittedTools(reviewed.currentGeneration, "remote-off", f.artifacts);
  assert.deepEqual(remoteOff.tools, []); await remoteOff.close();
  const exposed = await f.service.setExtensionToolPolicy(f.id, { ...reviewed.policy, remoteExposure: true }, UI);
  const oldPinned = await f.runtime.remoteAdmittedTools(reviewed.currentGeneration, "old-pin", f.artifacts);
  assert.deepEqual(oldPinned.tools, []); await oldPinned.close();
  const remote = await f.runtime.remoteAdmittedTools(exposed.currentGeneration, "remote-on", f.artifacts);
  assert.equal(remote.tools.length, 1);
  assert.match(remote.tools[0]!.definition.name, /^mcp\.ext_/);
  await remote.close();
  const denied = await f.service.setExtensionToolPolicy(f.id, { ...exposed.policy,
    toolFilter: { ...exposed.policy.toolFilter, deny: [write, read] } }, UI);
  assert.equal((await cached.execute({}, context)).error?.code, "tool_unavailable");
  await build.prepare();
  assert.deepEqual(build.definitions(), [], "the next model turn invalidates the cached list");
  assert.deepEqual(f.state.calls, ["read"], "a cached call cannot bypass a later deny");
  const afterDeny = await f.runtime.chatTools(denied.currentGeneration, "denied", f.artifacts);
  assert.deepEqual(afterDeny.tools, []); await afterDeny.close();
});

test("changed inventory, disabled extensions, and provider-hosted components fail closed", async (t) => {
  const f = await offlineRuntime(t);
  const initial = await f.service.extensionToolPolicy(f.id);
  const approved = { currentGeneration: initial.currentGeneration };
  const list = await f.runtime.chatTools(approved.currentGeneration, "cached", f.artifacts);
  t.after(() => list.close());
  assert.ok(list.tools.length > 0);
  f.state.schemaVersion++;
  assert.equal((await list.tools[0]!.execute({}, context)).error?.code, "tool_unavailable", "changed schema with the same names is refused");
  f.state.schemaVersion--;
  f.state.names.push("new_tool");
  assert.equal((await list.tools[0]!.execute({}, context)).error?.code, "tool_unavailable");
  assert.deepEqual(f.state.calls, []);
  const changed = await f.runtime.chatTools(approved.currentGeneration, "changed", f.artifacts);
  assert.deepEqual(changed.tools, []); await changed.close();
  f.state.names.pop();
  const disable = await f.service.planChange({ action: "disable", extensionId: f.id }, UI);
  await f.service.applyChange({ planId: disable.planId, planDigest: disable.planDigest, key: "disable-extension" }, UI);
  assert.equal((await list.tools[0]!.execute({}, context)).error?.code, "permission_denied", "a locally disabled server reports its disabled reason");
  assert.deepEqual(f.state.calls, []);
  const provider = await f.service.recordProviderHostedMcp({ name: "direct", url: "https://example.test/mcp", enabled: true, hasToken: false }, UI);
  assert.equal(provider.readiness.state, "unsupported");
  const policy = await f.service.extensionToolPolicy(provider.id);
  assert.equal(policy.unsupported, true);
  await assert.rejects(f.service.setExtensionToolPolicy(provider.id, { ...policy.policy, remoteExposure: true }, UI), /provider-hosted/i);
});


function crashedManager(crashCount: number) {
  const server = { name: "fixture", command: "fixture-command" };
  const tools = [{ name: "read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }];
  const discovery: McpDiscoveryResult = { version: 1, runId: "crash-run",
    principal: { role: "runner_internal", purpose: "mcp_discovery", principalId: "discovery", callId: "discovery", runId: "crash-run", deadlineMs: 1000 },
    servers: [{ name: server.name, status: "ready", configDigest: mcpConfigurationDigest(server), executableDigest: DIGEST,
      tools, schemaDigest: canonicalMcpDigest(tools), cleanupVerified: true }] };
  const state = { opened: 0, writes: 0, attestations: 0, crashes: crashCount };
  const factory: McpTransportFactory = { open: async (request) => {
    state.opened++;
    assert.ok(request.owner?.context.executionGrant);
    const writer: McpTransportWriter = { write: async (bytes) => {
      const message = JSON.parse(Buffer.from(bytes).toString("utf8")) as { id?: number; method: string };
      if (message.method === "tools/call") {
        state.writes++;
        if (state.crashes > 0) { state.crashes--; request.onFailure(new Error("fixture crashed after write")); return; }
      }
      if (message.id !== undefined) {
        const result = message.method === "initialize" ? { protocolVersion: "2024-11-05" } : message.method === "tools/list" ? { tools } : { content: [{ type: "text", text: "ok" }] };
        await request.onOutput("stdout", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + String.fromCharCode(10)));
      }
    } };
    await request.handshake(writer);
    return { ...writer, request: async <T>(_owner: McpRequestOwner, perform: (writer: McpTransportWriter) => Promise<T>) => await perform(writer),
      closeVerified: async () => undefined };
  } };
  const manager = new McpManager({ cwd: process.cwd(), servers: [server], runId: "crash-run", discovery, maximumRestarts: 1,
    requestTimeoutMs: 100, transportFactory: factory,
    reattest: async () => { state.attestations++; return [{ ...server, envelope: { paths: [], network: false, credentialNames: [] },
      executablePath: process.execPath, arguments: [], configDigest: mcpConfigurationDigest(server), executableDigest: DIGEST }]; } });
  let sequence = 0;
  const invoke = () => manager.toolEntries()[0]!.client.call("read", {}, { runId: "crash-run", sessionId: "agent",
    actor: { role: "worker", id: "worker" }, callId: "call-" + ++sequence, toolName: "mcp.fixture.read",
    workspacePath: process.cwd(), executionGrant: Object.freeze({}) as OpaqueExecutionGrant });
  return { manager, state, invoke };
}

test("a crashing MCP session is degraded until a fresh authorized re-attested handshake succeeds", async () => {
  const f = crashedManager(1);
  await f.manager.start();
  try {
    await assert.rejects(f.invoke());
    assert.equal(f.manager.status()[0]!.status, "degraded");
    assert.equal(f.manager.status()[0]!.toolCount, 0);
    assert.equal(f.state.writes, 1, "the failed effect was not replayed");
    await f.invoke();
    assert.equal(f.state.attestations, 2);
    assert.equal(f.manager.status()[0]!.status, "ready");
    assert.equal(f.state.writes, 2);
  } finally { await f.manager.close(); }
});

test("repeated MCP crashes exhaust the bounded restart and stay degraded", async () => {
  const f = crashedManager(10);
  await f.manager.start();
  try {
    await assert.rejects(f.invoke());
    await assert.rejects(f.invoke());
    await assert.rejects(f.invoke(), /restart|exhaust/i);
    assert.equal(f.state.opened, 2);
    assert.equal(f.state.writes, 2);
    assert.equal(f.manager.status()[0]!.status, "degraded");
    assert.equal(f.manager.status()[0]!.toolCount, 0);
  } finally { await f.manager.close(); }
});

test("an unrelated extension's policy change does not rebuild a bound extension's tools", async (t) => {
  const f = await offlineRuntime(t);
  const boundGeneration = (await f.service.generation()).generation;
  let builds = 0;
  const options = { permissionProfile: "full" as const, workspacePath: join(f.root, "project"), artifacts: f.artifacts };
  const source = { generation: async () => boundGeneration, policyRevision: (generation: number) => f.service.policyRevisionForGeneration(generation),
    tools: (generation: number) => { builds++; return f.runtime.chatTools(generation, "bound-" + builds, f.artifacts); } };
  const build = new ManagedBuildToolRuntime(new ToolBroker(options), source, options, () => true);
  t.after(() => build.close());
  await build.prepare();
  assert.equal(builds, 1);
  assert.ok(build.definitions().some((tool) => tool.name === "mcp.offline.read"));
  const view = await f.service.inspectSource({ type: "remote_http", url: "http://127.0.0.1:9999/other", serverName: "other", auth: "none" }, UI);
  const plan = await f.service.planChange({ action: "install", inspectionId: view.inspectionId, scope: f.service.projectScope() }, UI);
  const other = await f.service.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: "other-install" }, UI);
  assert.equal(other.outcome, "succeeded", other.diagnostics.join("; "));
  await build.prepare();
  assert.equal(builds, 1, "installing an unrelated extension does not restart the bound session");
  const otherPolicy = await f.service.extensionToolPolicy(other.result!.extensionId!);
  await f.service.setExtensionToolPolicy(other.result!.extensionId!, { ...otherPolicy.policy, toolFilter: { default: "deny", allow: [], deny: [] } }, UI);
  await build.prepare();
  assert.equal(builds, 1, "an unrelated policy change does not rebuild the bound tools");
  const own = await f.service.extensionToolPolicy(f.id);
  const read = { componentId: own.discovered[0]!.componentId, toolName: "read" };
  await f.service.setExtensionToolPolicy(f.id, { ...own.policy, toolFilter: { ...own.policy.toolFilter, deny: [read] } }, UI);
  await build.prepare();
  assert.equal(builds, 2, "a relevant policy change rebuilds at the next model turn");
  assert.ok(!build.definitions().some((tool) => tool.name === "mcp.offline.read"));
});

test("re-enabling does not resurrect an explicitly denied tool", async (t) => {
  const f = await offlineRuntime(t);
  const initial = await f.service.extensionToolPolicy(f.id);
  const read = { componentId: initial.discovered[0]!.componentId, toolName: "read" };
  await f.service.setExtensionToolPolicy(f.id, { ...initial.policy, toolFilter: { ...initial.policy.toolFilter, deny: [read] } }, UI);
  const disable = await f.service.planChange({ action: "disable", extensionId: f.id }, UI);
  assert.equal((await f.service.applyChange({ planId: disable.planId, planDigest: disable.planDigest, key: "catalog-disable" }, UI)).outcome, "succeeded");
  const enable = await f.service.planChange({ action: "enable", extensionId: f.id }, UI);
  const enabled = await f.service.applyChange({ planId: enable.planId, planDigest: enable.planDigest, key: "catalog-enable" }, UI);
  assert.equal(enabled.outcome, "succeeded", enabled.diagnostics.join("; "));
  const policy = await f.service.extensionToolPolicy(f.id);
  assert.deepEqual(policy.policy.toolFilter.deny, [read], "explicit deny wins over the enable approval");
  const tools = await f.runtime.chatTools(enabled.result!.generation!, "reenabled", f.artifacts);
  assert.ok(!tools.tools.some((tool) => tool.definition.name === "mcp.offline.read"));
  assert.ok(tools.tools.some((tool) => tool.definition.name === "mcp.offline.write"));
  await tools.close();
});

test("an explicit deny survives an approved re-review of a changed inventory", async (t) => {
  const f = await offlineRuntime(t);
  const initial = await f.service.extensionToolPolicy(f.id);
  const read = { componentId: initial.discovered[0]!.componentId, toolName: "read" };
  await f.service.setExtensionToolPolicy(f.id, { ...initial.policy, toolFilter: { ...initial.policy.toolFilter, deny: [read] } }, UI);
  const disable = await f.service.planChange({ action: "disable", extensionId: f.id }, UI);
  assert.equal((await f.service.applyChange({ planId: disable.planId, planDigest: disable.planDigest, key: "changed-disable" }, UI)).outcome, "succeeded");
  f.state.names.push("added");
  const enable = await f.service.planChange({ action: "enable", extensionId: f.id }, UI);
  const enabled = await f.service.applyChange({ planId: enable.planId, planDigest: enable.planDigest, key: "changed-enable" }, UI);
  assert.equal(enabled.outcome, "succeeded", enabled.diagnostics.join("; "));
  const policy = await f.service.extensionToolPolicy(f.id);
  assert.ok(policy.policy.reviewed.some((item) => item.toolNames.includes("added")), "the approval reviewed the changed inventory");
  assert.deepEqual(policy.policy.toolFilter.deny, [read], "the earlier explicit deny is carried forward");
  const tools = await f.runtime.chatTools(enabled.result!.generation!, "changed-reenabled", f.artifacts);
  const names = tools.tools.map((tool) => tool.definition.name);
  assert.ok(!names.includes("mcp.offline.read"));
  assert.ok(names.includes("mcp.offline.write") && names.includes("mcp.offline.added"));
  await tools.close();
});
