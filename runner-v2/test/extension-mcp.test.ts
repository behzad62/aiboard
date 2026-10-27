import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn, ToolResult } from "../src/agent-contracts.js";
import { runAgentLoop } from "../src/agent-loop.js";
import { mcpToolAdmitted, roleToolSurface } from "../src/role-capabilities.js";
import { ManagedBuildToolRuntime } from "../src/managed-build-tools.js";
import { ExtensionRunBindings } from "../src/extension-run-bindings.js";
import { createExtensionManagementTools } from "../src/extension-management-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ChatAgentSessions } from "../src/chat-agent-session.js";
import { createExecutionHost } from "../src/execution-host.js";
import { ExtensionCredentialStore } from "../src/extension-credentials.js";
import { ExtensionManagementService, type ManagementCaller } from "../src/extension-management-service.js";
import { ManagedMcpRuntime, type McpInstallerCommand } from "../src/extension-mcp.js";
import type { ProviderConfigStore, RunnerProviderConfig } from "../src/provider-config-store.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";

const UI: ManagementCaller = { kind: "ui" };
const FIXTURE = fileURLToPath(new URL("./fixtures/extension-mcp-server.mjs", import.meta.url));
// Synthetic value only; never a real account credential.
const SECRET = "SYNTHETIC-FIXTURE-TOKEN-5f2c9a";
const CONFIG: RunnerProviderConfig = {
  runtimeId: "scripted", providerId: "openai", modelId: "scripted-model", transport: "openai-compatible", secret: "unused-provider-secret",
  capabilities: ["tools"], priority: 1,
};

type Step = (request: AgentModelRequest, lastResult: ToolResult | undefined) => ModelTurn | Promise<ModelTurn>;

function scripted(steps: Step[], seen: AgentModelRequest[]): AgentModel {
  let index = 0;
  return {
    async complete(request) {
      seen.push(request);
      const lastTool = [...request.messages].reverse().find((message) => message.role === "tool");
      const step = steps[index++];
      const turn = step ? await step(request, lastTool?.content as ToolResult | undefined) : { blocks: [{ type: "text" as const, text: "(script exhausted)" }], stopReason: "end_turn" as const };
      return { ...turn, usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
}

function call(name: string, args: unknown): ModelTurn {
  return { blocks: [{ type: "tool_call", callId: `${name}-${Math.random().toString(16).slice(2)}`, name, arguments: args }], stopReason: "tool_calls" };
}

function say(text: string): ModelTurn {
  return { blocks: [{ type: "text", text }], stopReason: "end_turn" };
}

function textOf(result: ToolResult | undefined): string {
  return (result?.content ?? []).map((block) => block.type === "text" ? block.text : block.type === "json" ? JSON.stringify(block.value) : "").join("");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- scripted assertions read arbitrary tool JSON
function json(result: ToolResult | undefined): Record<string, any> {
  const block = result?.content.find((entry) => entry.type === "json");
  assert.ok(block && block.type === "json", `expected JSON result, got ${JSON.stringify(result?.content)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  return block.value as Record<string, any>;
}

interface Fixture {
  root: string;
  project: string;
  home: string;
  host: ReturnType<typeof createExecutionHost>;
  state: string;
  extensions: ExtensionManagementService;
  runtime: ManagedMcpRuntime;
  sessions: ChatAgentSessions;
  seen: AgentModelRequest[];
  setSteps(steps: Step[]): void;
}

/** Real ExecutionHost, internal process kernel, discovery and MCP sessions; only the model is scripted. */
async function fixture(t: test.TestContext, options: { run?: McpInstallerCommand; fetchJson?: (url: string) => Promise<unknown>; path?: string } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "aiboard-ext-mcp-"));
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
  const environment = options.path !== undefined ? { ...Object.fromEntries(Object.entries(host.filteredEnvironmentSource()).filter(([name]) => name.toLowerCase() !== "path")), PATH: options.path } : host.filteredEnvironmentSource();
  const runtime = new ManagedMcpRuntime({
    home, stateDirectory: state, projectRoot: project, credentials, internal, executionHost: host, capabilitiesConfig: () => emptyRunnerCapabilitiesConfig(),
    installer: {
      nodeExecutable: process.execPath, environment,
      fetchJson: options.fetchJson ?? (async () => { throw new Error("no network in tests"); }),
      run: options.run ?? (async () => { throw new Error("no installer in this test"); }),
    },
  });
  const extensions = await ExtensionManagementService.open({ home, projectRoot: project, credentials, handlers: [runtime.handler()] });
  runtime.attach(extensions);
  const seen: AgentModelRequest[] = [];
  let steps: Step[] = [];
  const sessions = new ChatAgentSessions({
    projectRoot: project, stateDirectory: state, extensions,
    providerConfigs: { load: () => [CONFIG], save: () => undefined, close: () => undefined } as unknown as ProviderConfigStore,
    modelFactory: () => scripted(steps, seen),
    generationTools: async (generation, sessionId, artifacts) => await runtime.chatTools(generation, sessionId, artifacts),
  });
  t.after(async () => {
    await sessions.close();
    credentials.close();
    await internal.close();
    await host.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  return { root, project, home, host, state, extensions, runtime, sessions, seen, setSteps: (next) => { steps = next; } };
}

async function installFixtureServer(env: Fixture, args: string[], credentialNames: string[] = []) {
  const view = await env.extensions.inspectSource({ type: "executable", command: process.execPath, args, serverName: "fixture", ...(credentialNames.length ? { env: credentialNames } : {}) }, UI);
  const plan = await env.extensions.planChange({ action: "install", inspectionId: view.inspectionId, scope: env.extensions.projectScope() }, UI);
  return { view, plan, operation: await env.extensions.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: `ui-${plan.planId}` }, UI) };
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await stat(path)).size < 64 * 1024 * 1024 && (await readFile(path)).includes(needle)) hits.push(path);
    }
  };
  await walk(root);
  return hits;
}

test("a registered local MCP server collects its secret in a card, passes a real handshake and is called from chat without the secret leaking", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const { plan, operation } = await installFixtureServer(env, [FIXTURE, "needs-token"], ["FIXTURE_API_TOKEN"]);
  assert.equal(plan.requiresExecutableTrust, true);
  assert.deepEqual(plan.requiredCredentials, ["FIXTURE_API_TOKEN"]);
  assert.equal(operation.outcome, "awaiting_user");
  assert.equal(operation.userAction?.kind, "credential");

  const finished = await env.extensions.submitCredential(operation.id, "FIXTURE_API_TOKEN", SECRET, UI);
  assert.ok("outcome" in finished);
  assert.equal(finished.outcome, "succeeded", finished.diagnostics.join("; "));
  assert.equal(finished.result?.readiness?.state, "ready");
  assert.match(finished.result?.readiness?.detail ?? "", /3 tools: lookup, credential_status, delete_note/);

  env.setSteps([
    (request) => {
      assert.ok(request.tools.some((tool) => tool.name === "mcp.fixture.credential_status"), "managed tools are offered in the chat");
      return call("mcp.fixture.credential_status", {});
    },
    (_request, result) => {
      assert.equal(result?.isError, false, textOf(result));
      assert.match(textOf(result), new RegExp(`token:present length:${SECRET.length}`));
      return call("mcp.fixture.lookup", { query: "otters" });
    },
    (_request, result) => {
      assert.match(textOf(result), /found:otters:OTTER-7/);
      return say("The fixture server works: OTTER-7.");
    },
  ]);
  await env.sessions.create({ sessionId: "chat-mcp", runtimeId: "scripted" });
  await env.sessions.send("chat-mcp", { messageId: "m1", text: "Check the fixture server." });
  const snapshot = await env.sessions.settled("chat-mcp");
  assert.equal(snapshot.status, "idle", snapshot.error ?? "");
  assert.equal(snapshot.messages.at(-1)?.text, "The fixture server works: OTTER-7.");

  // The secret exists only inside the encrypted credential store: not in prompts, results, registry,
  // operations, chat state or leftover launcher files.
  assert.doesNotMatch(JSON.stringify(env.seen), new RegExp(SECRET));
  assert.deepEqual(await filesContaining(env.root, SECRET), []);
  const secrets = join(env.home, "mcp-secrets");
  for (const directory of await readdir(secrets)) {
    assert.deepEqual((await readdir(join(secrets, directory))).filter((name) => name.endsWith(".secret") && !name.endsWith(".tmp")).length <= 1, true, "no accumulating secret files");
  }
});

test("a chat agent asks once, the user approves the card, and the new MCP tool is used in the same reply", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  let operationId = "";
  let planDigest = "";
  env.setSteps([
    () => call("extensions.inspect_source", { source: { type: "executable", command: process.execPath, args: [FIXTURE], serverName: "fixture" } }),
    (_request, result) => call("extensions.plan_change", { action: "install", inspectionId: json(result).inspectionId, applyIfAuthorized: true }),
    async (request, result) => {
      const value = json(result);
      assert.equal(value.operation.outcome, "awaiting_user", JSON.stringify(value));
      assert.ok(!request.tools.some((tool) => tool.name.startsWith("mcp.")), "no MCP tools before approval");
      operationId = value.operation.operationId;
      planDigest = value.planDigest ?? value.plan?.planDigest;
      // The user approves on the operation card while the agent waits; the agent cannot approve.
      const operation = await env.extensions.operationStatus(operationId, UI);
      const approved = await env.extensions.approve(operationId, operation.plan!.planDigest, UI);
      assert.equal(approved.outcome, "succeeded", approved.diagnostics.join("; "));
      return call("extensions.operation_status", { operationId });
    },
    (request, result) => {
      assert.equal(json(result).outcome, "succeeded");
      void request;
      return call("extensions.list", {});
    },
    (request) => {
      assert.ok(request.tools.some((tool) => tool.name === "mcp.fixture.lookup"), "the new generation's tools are visible at the next model turn");
      return call("mcp.fixture.lookup", { query: "beavers" });
    },
    (_request, result) => {
      assert.match(textOf(result), /found:beavers:OTTER-7/);
      return say("Added the fixture server and looked it up: OTTER-7.");
    },
  ]);
  await env.sessions.create({ sessionId: "chat-agent-mcp", runtimeId: "scripted" });
  await env.sessions.send("chat-agent-mcp", { messageId: "m1", text: `Add the MCP server ${FIXTURE} and look up beavers with it.` });
  const snapshot = await env.sessions.settled("chat-agent-mcp");
  assert.equal(snapshot.status, "idle", snapshot.error ?? "");
  assert.equal(snapshot.messages.at(-1)?.text, "Added the fixture server and looked it up: OTTER-7.");
  assert.deepEqual(snapshot.transitions.map((transition) => [transition.from, transition.to, transition.boundary]), [[0, 1, "model_turn"]]);
  const operation = snapshot.operations.find((entry) => entry.id === operationId);
  assert.equal(operation?.authorizationOrigin, "ui", "executable code was authorized by the card, not by the model or chat text");
  void planDigest;
});

test("Settings tool policy limits a chat to non-destructive tools; a changed server script is refused", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const script = join(env.root, "server-copy.mjs");
  await copyFile(FIXTURE, script);
  const { operation } = await installFixtureServer(env, [script]);
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("; "));
  await env.runtime.setToolPolicy(operation.result!.extensionId!, "non_destructive");
  env.setSteps([
    () => call("mcp.fixture.delete_note", { id: "n1" }),
    (_request, result) => {
      assert.equal(result?.isError, true);
      assert.equal(result?.error?.code, "permission_denied");
      return call("mcp.fixture.lookup", { query: "x" });
    },
    (_request, result) => {
      assert.equal(result?.isError, false, textOf(result));
      return say("done");
    },
  ]);
  await env.sessions.create({ sessionId: "chat-policy", runtimeId: "scripted" });
  await env.sessions.send("chat-policy", { messageId: "m1", text: "Try the fixture tools." });
  assert.equal((await env.sessions.settled("chat-policy")).status, "idle");

  await writeFile(script, `${await readFile(script, "utf8")}\n// tampered\n`);
  const readiness = await env.extensions.test(operation.result!.extensionId!);
  assert.equal(readiness.state, "failed");
  assert.match(readiness.lastError?.message ?? "", /changed since installation/);
});

test("a server that crashes before the handshake is reported failed, not ready", { timeout: 120_000 }, async (t) => {
  const env = await fixture(t);
  const { operation } = await installFixtureServer(env, [FIXTURE, "crash"]);
  assert.equal(operation.outcome, "failed");
  assert.equal(operation.result?.readiness?.state, "failed");
  assert.match(operation.result?.readiness?.lastError?.message ?? "", /handshake/);
});

test("pinned npm recipe installs with scripts disabled, verifies integrity, and a failed update rolls back to the working version", { timeout: 180_000 }, async (t) => {
  const commands: string[][] = [];
  const crashing = join(tmpdir(), `aiboard-crash-${process.pid}.mjs`);
  await writeFile(crashing, "process.exit(3);\n");
  t.after(() => rm(crashing, { force: true }));
  const manifests: Record<string, unknown> = {
    "1.0.0": { version: "1.0.0", bin: { "fixture-mcp": "server.mjs" }, dist: { integrity: "sha512-one" }, scripts: { postinstall: "node build.js" } },
    "1.0.1": { version: "1.0.1", bin: { "fixture-mcp": "server.mjs" }, dist: { integrity: "sha512-two" } },
  };
  const env = await fixture(t, {
    fetchJson: async (url) => {
      assert.match(url, /^https:\/\/registry\.npmjs\.org\/@fixture%2fmcp-server\//);
      const version = url.endsWith("/latest") ? "1.0.0" : url.split("/").pop()!;
      return manifests[version];
    },
    run: async (command, args, cwd) => {
      commands.push([command, ...args]);
      const spec = args.find((arg) => arg.startsWith("@fixture/mcp-server@"))!;
      const version = spec.split("@").pop()!;
      const packageRoot = join(cwd, "node_modules", "@fixture", "mcp-server");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@fixture/mcp-server", version, bin: { "fixture-mcp": "server.mjs" } }));
      await copyFile(version === "1.0.0" ? FIXTURE : crashing, join(packageRoot, "server.mjs"));
      await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ packages: { "node_modules/@fixture/mcp-server": { version, integrity: (manifests[version] as { dist: { integrity: string } }).dist.integrity } } }));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  const view = await env.extensions.inspectSource({ type: "npm", packageName: "@fixture/mcp-server", serverName: "fixture" }, UI);
  assert.equal(view.version, "1.0.0");
  assert.ok(view.warnings.some((warning) => /postinstall/.test(warning)), "install scripts are disclosed");
  const plan = await env.extensions.planChange({ action: "install", inspectionId: view.inspectionId, scope: env.extensions.projectScope() }, UI);
  const installed = await env.extensions.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: "ui-npm-install-1" }, UI);
  assert.equal(installed.outcome, "succeeded", installed.diagnostics.join("; "));
  assert.ok(commands[0]!.includes("--ignore-scripts") && commands[0]!.includes("@fixture/mcp-server@1.0.0"), "pinned exact version, scripts disabled");
  const workingVersion = installed.result!.versionId!;

  const update = await env.extensions.inspectSource({ type: "npm", packageName: "@fixture/mcp-server", version: "1.0.1", serverName: "fixture" }, UI);
  const updatePlan = await env.extensions.planChange({ action: "update", inspectionId: update.inspectionId, scope: env.extensions.projectScope() }, UI);
  const updated = await env.extensions.applyChange({ planId: updatePlan.planId, planDigest: updatePlan.planDigest, key: "ui-npm-update-1" }, UI);
  assert.equal(updated.outcome, "rolled_back", updated.diagnostics.join("; "));
  const record = await env.extensions.extensionRecord(installed.result!.extensionId!);
  assert.equal(record?.currentVersionId, workingVersion);
  const { plans } = await env.runtime.launchPlans((await env.extensions.generation()).generation);
  assert.equal(plans.length, 1);
  assert.match(plans[0]!.spec.command, /1\.0\.0-/, "the restored generation launches the working version");
});

test("a Python server without a Python runtime is an actionable requirement, never a system install", async (t) => {
  const empty = await mkdtemp(join(tmpdir(), "aiboard-empty-path-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const env = await fixture(t, { path: empty });
  await assert.rejects(
    env.extensions.inspectSource({ type: "pypi", packageName: "fixture-mcp" }, UI),
    (error: Error & { code?: string }) => error.code === "runtime_missing" && /never installs system runtimes/.test(error.message),
  );
});


test("Build-owned installation publishes MCP on the next model turn, preserves other Build pins and revokes disabled calls", {timeout:120_000}, async t => {
  const env = await fixture(t);
  const pins = new ExtensionRunBindings(env.state, env.extensions);
  t.after(() => pins.close());
  await pins.bind("build-install");
  await pins.bind("unrelated-build");
  const binding = await env.host.bindRun({runId:"build-install", permissionProfile:"full", capabilityContract:{digest:"d".repeat(64)} as RunnerCapabilityContract, capabilitiesConfig:emptyRunnerCapabilitiesConfig()});
  t.after(() => binding.close());
  const brokerOptions = {permissionProfile:"full" as const, workspacePath:env.project, executionGrants:binding.executionGrants, artifacts:new ArtifactStore(join(env.state,"build-artifacts"))};
  const base = new ToolBroker(brokerOptions);
  for (const tool of createExtensionManagementTools({service:env.extensions, conversationId:()=>"build-conversation", canMutate:context=>context.actor.role === "architect"})) base.register(tool);
  env.extensions.authorizer.recordHumanMessage("build-conversation", `Install the MCP server ${FIXTURE} and use it to find beavers.`);
  const source = {generation:()=>pins.generation("build-install"), tools:(g:number)=>env.runtime.buildTools(g,binding,"full",brokerOptions.artifacts)};
  const runtime = new ManagedBuildToolRuntime(base, source, brokerOptions, tool=>mcpToolAdmitted(roleToolSurface("architect","inspection").mcpPolicy, tool.definition));
  t.after(() => runtime.close());
  let installedId = "";
  const requests: AgentModelRequest[] = [];
  const model = scripted([
    () => call("extensions.inspect_source", {source:{type:"executable",command:process.execPath,args:[FIXTURE],serverName:"fixture"}}),
    (_request,result) => call("extensions.plan_change", {action:"install",inspectionId:json(result).inspectionId,applyIfAuthorized:true}),
    async (_request,result) => {
      const operationId = json(result).operation.operationId;
      const operation = await env.extensions.operationStatus(operationId,UI);
      const approved = await env.extensions.approve(operationId, operation.plan!.planDigest, UI);
      assert.equal(approved.outcome,"succeeded",approved.diagnostics.join("; "));
      installedId = approved.result!.extensionId!;
      return call("extensions.operation_status", {operationId});
    },
    (request,result) => {
      assert.equal(json(result).outcome,"succeeded");
      assert.ok(request.tools.some(tool=>tool.name === "mcp.fixture.lookup"));
      assert.ok(!request.tools.some(tool=>tool.name === "mcp.fixture.delete_note"),"Architect read-only surface");
      return call("mcp.fixture.lookup", {query:"beavers"});
    },
    async (_request,result) => {
      assert.match(textOf(result), /found:beavers:OTTER-7/);
      const worker = new ManagedBuildToolRuntime(new ToolBroker(brokerOptions), source, brokerOptions,
        tool=>mcpToolAdmitted(roleToolSurface("worker","task").mcpPolicy,tool.definition));
      try {
        await worker.prepare();
        assert.ok(worker.definitions().some(tool=>tool.name === "mcp.fixture.delete_note"));
        const used = await worker.invoke({type:"tool_call",callId:"worker-use",name:"mcp.fixture.lookup",arguments:{query:"worker"}},
          {runId:"build-install",sessionId:"worker",actor:{role:"worker",id:"worker"},workspacePath:env.project});
        assert.equal(used.isError,false,textOf(used));
        assert.match(textOf(used),/found:worker:OTTER-7/);
      } finally { await worker.close(); }
      const plan = await env.extensions.planChange({action:"disable",extensionId:installedId},UI);
      assert.equal((await env.extensions.applyChange({planId:plan.planId,planDigest:plan.planDigest,key:plan.planId},UI)).outcome,"succeeded");
      return call("mcp.fixture.lookup",{query:"denied"});
    },
    (_request,result) => {assert.equal(result?.isError,true); assert.match(textOf(result),/disabled|removed/i);return say("verified");},
  ], requests);
  const outcome = await runAgentLoop({model, registry:runtime, beforeModelTurn:()=>runtime.prepare(), context:{runId:"build-install",sessionId:"architect",actor:{role:"architect",id:"architect"},workspacePath:env.project}, initialMessages:[{id:"user",role:"user",content:"Install the fixture server and find beavers."}]});
  assert.equal(outcome.status,"suspended");
  if (outcome.status !== "suspended") throw new Error("Expected scripted end-of-turn suspension.");
  assert.equal(outcome.reason,"model_ended_without_lifecycle", outcome.error ?? "");
  assert.equal(requests.length,6);
  assert.ok(await pins.generation("build-install") > 0);
  assert.equal(await pins.generation("unrelated-build"),0);
});
