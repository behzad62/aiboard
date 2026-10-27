import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn, ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { ToolBroker } from "../src/tool-broker.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { ChatAgentSessions } from "../src/chat-agent-session.js";
import { ExtensionCredentialStore } from "../src/extension-credentials.js";
import { ExtensionManagementService, type ManagementCaller } from "../src/extension-management-service.js";
import { ManagedMcpRuntime } from "../src/extension-mcp.js";
import { assertRemoteDestination, RemoteMcpClient } from "../src/mcp-remote.js";
import type { ProviderConfigStore, RunnerProviderConfig } from "../src/provider-config-store.js";
import type { RunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";

const UI: ManagementCaller = { kind: "ui" };
const CONFIG: RunnerProviderConfig = {
  runtimeId: "scripted", providerId: "openai", modelId: "scripted-model", transport: "openai-compatible", secret: "unused-provider-secret",
  capabilities: ["tools"], priority: 1,
};

interface MockState {
  readonly base: string;
  auth: "none" | "oauth";
  readonly tokens: Map<string, number>;
  readonly codes: Map<string, { challenge: string; resource: string; redirectUri: string }>;
  tokenRequests: number;
  refreshes: number;
  callCount: Record<string, number>;
  issuedTokens: string[];
  redirectMcp: boolean;
  expiresIn: number;
}

/** Mock remote MCP server + OAuth authorization server on 127.0.0.1. */
async function mockRemote(t: test.TestContext, auth: "none" | "oauth"): Promise<MockState> {
  const state = { auth, tokens: new Map(), codes: new Map(), tokenRequests: 0, refreshes: 0, callCount: {}, issuedTokens: [], redirectMcp: false, expiresIn: 3600 } as unknown as MockState;
  const server: Server = createServer(async (request, response) => {
    try { await handle(state, request, response); } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  (state as { base: string }).base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

async function handle(state: MockState, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", state.base);
  if (url.pathname === "/mcp" && request.method === "DELETE") { response.statusCode = 204; response.end(); return; }
  if (url.pathname === "/mcp" && request.method === "POST") {
    if (state.redirectMcp) { response.writeHead(307, { location: "https://elsewhere.example/mcp" }); response.end(); return; }
    if (state.auth === "oauth") {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      const expires = token ? state.tokens.get(token) : undefined;
      if (!expires || expires < Date.now()) {
        response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp", scope="notes.read"` });
        response.end();
        return;
      }
    }
    const message = JSON.parse(await readBody(request)) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) { response.statusCode = 202; response.end(); return; }
    if (message.method === "initialize") return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-remote" } } }, { "mcp-session-id": "session-1" });
    if (request.headers["mcp-session-id"] !== "session-1" || request.headers["mcp-protocol-version"] !== "2025-06-18") return sendJson(response, 400, { error: "missing session headers" });
    if (message.method === "tools/list") {
      // An SSE response carrying a refused server request before the real result.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} })}\n\n`);
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "read_note", description: "Read a note", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: "send_email", description: "Send an email", inputSchema: { type: "object" } },
        { name: "flaky_write", description: "Write that loses its response", inputSchema: { type: "object" }, annotations: { destructiveHint: false } },
      ] } })}\n\n`);
      return;
    }
    if (message.method === "tools/call") {
      const name = message.params?.name ?? "";
      state.callCount[name] = (state.callCount[name] ?? 0) + 1;
      if (name === "flaky_write") { request.socket.destroy(); return; }
      return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name}:${JSON.stringify(message.params?.arguments ?? {})}:HERON-3` }], isError: false } });
    }
    return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } });
  }
  if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return sendJson(response, 200, { resource: `${state.base}/mcp`, authorization_servers: [`${state.base}/as`], scopes_supported: ["notes.read"] });
  if (url.pathname === "/.well-known/oauth-authorization-server/as") {
    return sendJson(response, 200, { issuer: `${state.base}/as`, authorization_endpoint: `${state.base}/as/authorize`, token_endpoint: `${state.base}/as/token`, registration_endpoint: `${state.base}/as/register`, code_challenge_methods_supported: ["S256"] });
  }
  if (url.pathname === "/as/register" && request.method === "POST") {
    const body = JSON.parse(await readBody(request)) as { redirect_uris?: string[]; token_endpoint_auth_method?: string };
    assert.equal(body.token_endpoint_auth_method, "none");
    return sendJson(response, 201, { client_id: "client-1", redirect_uris: body.redirect_uris });
  }
  if (url.pathname === "/as/authorize") {
    const params = url.searchParams;
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("resource"), `${state.base}/mcp`);
    const code = `code-${state.codes.size + 1}`;
    state.codes.set(code, { challenge: params.get("code_challenge")!, resource: params.get("resource")!, redirectUri: params.get("redirect_uri")! });
    response.writeHead(302, { location: `${params.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(params.get("state")!)}` });
    response.end();
    return;
  }
  if (url.pathname === "/as/token" && request.method === "POST") {
    state.tokenRequests += 1;
    const form = new URLSearchParams(await readBody(request));
    if (form.get("resource") !== `${state.base}/mcp`) return sendJson(response, 400, { error: "invalid_target" });
    if (form.get("grant_type") === "authorization_code") {
      const code = state.codes.get(form.get("code") ?? "");
      state.codes.delete(form.get("code") ?? "");
      const verified = code && createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === code.challenge && code.redirectUri === form.get("redirect_uri");
      if (!verified) return sendJson(response, 400, { error: "invalid_grant" });
    } else if (form.get("grant_type") === "refresh_token") {
      if (form.get("refresh_token") !== "refresh-1") return sendJson(response, 400, { error: "invalid_grant" });
      state.refreshes += 1;
    } else {
      return sendJson(response, 400, { error: "unsupported_grant_type" });
    }
    const token = `access-${state.issuedTokens.length + 1}-SYNTHETIC`;
    state.issuedTokens.push(token);
    state.tokens.set(token, Date.now() + state.expiresIn * 1000);
    return sendJson(response, 200, { access_token: token, token_type: "Bearer", expires_in: state.expiresIn, refresh_token: "refresh-1", scope: "notes.read" });
  }
  response.statusCode = 404;
  response.end();
}

type Step = (request: AgentModelRequest, lastResult: ToolResult | undefined) => ModelTurn;

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "aiboard-remote-mcp-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  const credentials = new ExtensionCredentialStore(join(root, "state", "extension-credentials.enc"), "remote-test-token-0123456789abc");
  const runtime = new ManagedMcpRuntime({
    home: join(root, "home"), stateDirectory: join(root, "state"), projectRoot: project, credentials,
    // Remote servers never use the local process kernel.
    internal: {} as RunnerInternalExecutionContext,
    installer: { nodeExecutable: process.execPath, environment: {}, fetchJson: async () => { throw new Error("unused"); }, run: async () => { throw new Error("unused"); } },
    oauthRedirectUri: () => "http://127.0.0.1:1/v2/extensions/oauth/callback",
  });
  const extensions = await ExtensionManagementService.open({ home: join(root, "home"), projectRoot: project, credentials, handlers: [runtime.handler()] });
  runtime.attach(extensions);
  let steps: Step[] = [];
  const seen: AgentModelRequest[] = [];
  const model: AgentModel = {
    async complete(request) {
      seen.push(request);
      const lastTool = [...request.messages].reverse().find((message) => message.role === "tool");
      const step = steps.shift();
      const turn = step ? step(request, lastTool?.content as ToolResult | undefined) : { blocks: [{ type: "text" as const, text: "(end)" }], stopReason: "end_turn" as const };
      return { ...turn, usage: { inputTokens: 100, outputTokens: 10 } };
    },
  };
  const sessions = new ChatAgentSessions({
    projectRoot: project, stateDirectory: join(root, "state"), extensions,
    providerConfigs: { load: () => [CONFIG], save: () => undefined, close: () => undefined } as unknown as ProviderConfigStore,
    modelFactory: () => model,
    generationTools: async (generation, sessionId, artifacts) => await runtime.chatTools(generation, sessionId, artifacts),
  });
  t.after(async () => { await sessions.close(); credentials.close(); await rm(root, { recursive: true, force: true }); });
  return { root, extensions, runtime, sessions, seen, setSteps: (next: Step[]) => { steps = next; } };
}

function call(name: string, args: unknown): ModelTurn {
  return { blocks: [{ type: "tool_call", callId: `${name}-${Math.random().toString(16).slice(2)}`, name, arguments: args }], stopReason: "tool_calls" };
}

function textOf(result: ToolResult | undefined): string {
  return (result?.content ?? []).map((block) => block.type === "text" ? block.text : "").join("");
}

async function install(env: Awaited<ReturnType<typeof fixture>>, url: string, auth: "none" | "oauth") {
  const view = await env.extensions.inspectSource({ type: "remote_http", url, serverName: "notes", auth }, UI);
  const plan = await env.extensions.planChange({ action: "install", inspectionId: view.inspectionId, scope: env.extensions.projectScope() }, UI);
  return { view, plan, operation: await env.extensions.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: `ui-${plan.planId}` }, UI) };
}

async function reviewTools(env: Awaited<ReturnType<typeof fixture>>, extensionId: string): Promise<void> {
  const view = await env.extensions.extensionToolPolicy(extensionId);
  await env.extensions.setExtensionToolPolicy(extensionId, { ...view.policy, reviewed: view.discovered,
    toolFilter: { default: "deny", allow: view.discovered.flatMap((item) => item.toolNames.map((toolName) => ({ componentId: item.componentId, toolName }))), deny: [] } }, UI);
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await stat(path)).size < 16 * 1024 * 1024 && (await readFile(path)).includes(needle)) hits.push(path);
    }
  };
  await walk(root);
  return hits;
}

test("remote destinations: https by default, http only for loopback, private networks refused", async () => {
  await assert.rejects(assertRemoteDestination("http://example.com/mcp"), /must use https/);
  await assert.rejects(assertRemoteDestination("https://10.1.2.3/mcp"), /private network/);
  await assert.rejects(assertRemoteDestination("https://user:pw@example.com/mcp"), /Credentials in the URL/);
  assert.equal((await assertRemoteDestination("http://127.0.0.1:9/mcp")).hostname, "127.0.0.1");
});

test("a no-auth remote server is ready after a real handshake; chat may call only non-destructive tools by default", async (t) => {
  const remote = await mockRemote(t, "none");
  const env = await fixture(t);
  const { view, operation } = await install(env, `${remote.base}/mcp`, "none");
  assert.equal(view.requiresExecutableTrust, false);
  assert.equal(view.access.executesCode, "never");
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("; "));
  assert.match(operation.result?.readiness?.detail ?? "", /3 tools: read_note, send_email, flaky_write \(MCP 2025-06-18\)/);
  await reviewTools(env, operation.result!.extensionId!);

  env.setSteps([
    (request) => {
      assert.ok(request.tools.some((tool) => tool.name === "mcp.notes.read_note"));
      return call("mcp.notes.read_note", { id: "n1" });
    },
    (_request, result) => {
      assert.match(textOf(result), /read_note:\{"id":"n1"\}:HERON-3/);
      return call("mcp.notes.send_email", { to: "x" });
    },
    (_request, result) => {
      assert.equal(result?.error?.code, "permission_denied", "unannotated tools are destructive until the user allows all tools");
      return call("mcp.notes.flaky_write", {});
    },
    (_request, result) => {
      assert.equal(result?.isError, true);
      assert.match(textOf(result), /OUTCOME UNKNOWN \(not retried\)/);
      return { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" };
    },
  ]);
  await env.sessions.create({ sessionId: "remote-chat", runtimeId: "scripted" });
  await env.sessions.send("remote-chat", { messageId: "m1", text: "Use the notes server." });
  assert.equal((await env.sessions.settled("remote-chat")).status, "idle");
  assert.equal(remote.callCount.send_email ?? 0, 0, "a refused call never reaches the server");
  assert.equal(remote.callCount.flaky_write, 1, "an ambiguous mutating call is sent exactly once");

  await env.extensions.setToolPolicy(operation.result!.extensionId!, "all", UI);
  assert.equal(await env.extensions.toolPolicy(operation.result!.extensionId!), "all");
});

test("OAuth: the operation waits on a sign-in card, PKCE/state/resource are enforced, tokens refresh inside the Runner and never leak", async (t) => {
  const remote = await mockRemote(t, "oauth");
  remote.expiresIn = 30; // inside the 60 s refresh margin, so the next use refreshes
  const env = await fixture(t);
  const { operation } = await install(env, `${remote.base}/mcp`, "oauth");
  assert.equal(operation.outcome, "awaiting_user");
  assert.equal(operation.userAction?.kind, "sign_in");

  const { url } = await env.extensions.beginSignIn(operation.id, UI);
  const authorize = new URL(url);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("resource"), `${remote.base}/mcp`);
  assert.equal(authorize.searchParams.get("scope"), "notes.read");
  assert.equal(authorize.searchParams.get("code_verifier"), null, "the verifier never leaves the Runner");
  // The user's browser follows the authorization server's redirect back to the Runner callback.
  const redirected = await fetch(url, { redirect: "manual" });
  const callback = new URL(redirected.headers.get("location")!);
  const state = callback.searchParams.get("state")!;
  const code = callback.searchParams.get("code")!;

  await assert.rejects(env.extensions.completeSignIn("forged-state-value-000000", code), /unknown or expired/);
  const completed = await env.extensions.completeSignIn(state, code);
  assert.equal(completed.readiness.state, "ready");
  await assert.rejects(env.extensions.completeSignIn(state, code), /unknown or expired/, "a state is single-use");
  const resumed = await env.extensions.operationStatus(operation.id, UI);
  assert.equal(resumed.outcome, "succeeded", "the same operation resumed after sign-in");

  // The 30 s token is refreshed by the Runner on the next use.
  const readiness = await env.extensions.test(operation.result?.extensionId ?? resumed.result!.extensionId!);
  assert.equal(readiness.state, "ready");
  assert.ok(remote.refreshes >= 1, "refresh happened inside the Runner");

  for (const token of [...remote.issuedTokens, "refresh-1"]) {
    assert.deepEqual(await filesContaining(env.root, token), [], `${token} is stored only encrypted`);
  }
  assert.doesNotMatch(JSON.stringify(await env.extensions.listOperations()), /access-\d|refresh-1/);
});

test("redirects are refused instead of forwarding credentials to another origin", async (t) => {
  const remote = await mockRemote(t, "none");
  remote.redirectMcp = true;
  const client = new RemoteMcpClient({ url: `${remote.base}/mcp`, authorization: async () => "Bearer SYNTHETIC" });
  await assert.rejects(client.initialize(), /does not follow MCP redirects/);
});

test("the browser's provider-hosted MCP setting migrates idempotently, keeps its route and token custody, and stays read-only", async (t) => {
  const env = await fixture(t);
  const before = (await env.extensions.generation()).generation;
  const first = await env.extensions.recordProviderHostedMcp({ name: "Docs", url: "https://mcp.example.test/sse?x=1", enabled: true, hasToken: true }, UI);
  const again = await env.extensions.recordProviderHostedMcp({ name: "Docs", url: "https://mcp.example.test/sse?x=1", enabled: true, hasToken: true }, UI);
  assert.equal(first.id, again.id);
  assert.equal(first.provenance, "migrated");
  assert.equal(first.readiness.state, "unsupported");
  assert.equal(first.currentVersion?.components[0]?.kind === "mcp_server" && first.currentVersion.components[0].route, "provider_hosted");
  assert.equal(first.credentials.length, 0, "no token moved to the Runner");
  const inventory = await env.extensions.inventory();
  assert.equal(inventory.items.filter((item) => item.provenance === "migrated").length, 1);
  assert.equal((await env.extensions.generation()).generation, before, "migration publishes no generation and starts no Runner calls");
  const disabled = await env.extensions.recordProviderHostedMcp({ name: "Docs", url: "https://mcp.example.test/sse", enabled: false, hasToken: true }, UI);
  assert.equal(disabled.readiness.state, "disabled");
  await assert.rejects(env.extensions.planChange({ action: "remove", extensionId: first.id }, UI), /managed in Settings → Tools/);
  await assert.rejects(env.extensions.recordProviderHostedMcp({ name: "x", url: "https://u:p@example.test/mcp", enabled: true, hasToken: false }, UI), /without embedded credentials/);
});

test("a CLI-configured MCP server is adopted only on request, with its exact launch arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-adopt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = new ExtensionCredentialStore(join(root, "creds.enc"), "adopt-test-token-0123456789abcdef");
  t.after(() => credentials.close());
  const script = join(root, "server.mjs");
  await (await import("node:fs/promises")).writeFile(script, "process.stdin.resume();\n");
  const runtime = new ManagedMcpRuntime({
    home: join(root, "home"), stateDirectory: join(root, "state"), projectRoot: join(root, "project"), credentials, internal: {} as RunnerInternalExecutionContext,
    installer: { nodeExecutable: process.execPath, environment: {}, fetchJson: async () => ({}), run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
    reservedServerNames: ["docs"], cliServers: [{ name: "docs", command: `"${process.execPath}" "${script}" --verbose` }],
  });
  await mkdir(join(root, "project"));
  const extensions = await ExtensionManagementService.open({ home: join(root, "home"), projectRoot: join(root, "project"), credentials, handlers: [runtime.handler()] });
  runtime.attach(extensions);
  const view = await extensions.inspectAdoption("docs", UI);
  const component = view.components[0];
  assert.ok(component?.kind === "mcp_server");
  assert.equal(component.serverName, "docs");
  assert.deepEqual(component.args, [script, "--verbose"]);
  assert.ok(view.warnings.some((warning) => /Remove the --mcp flag/.test(warning)));
  await assert.rejects(extensions.inspectAdoption("missing", UI), /No command-line MCP server/);
  await assert.rejects(extensions.inspectAdoption("docs", { kind: "agent", runId: "r", sessionId: "s", actorRole: "architect", canMutate: true } as ManagementCaller), /from Settings/);
});


test("remote managed MCP is available in a Build with the Build permission profile", async t => {
  const remote=await mockRemote(t,"none");
  const env=await fixture(t);
  const {operation}=await install(env,`${remote.base}/mcp`,"none");
  assert.equal(operation.outcome,"succeeded");
  await reviewTools(env, operation.result!.extensionId!);
  const artifacts=new ArtifactStore(join(env.root,"build-artifacts"));
  const host=createExecutionHost({projectRoot:join(env.root,"project"),stateDirectory:join(env.root,"build-state"),artifacts,ambientEnvironment:snapshotNativeBuildAmbientEnvironment()});
  const binding=await host.bindRun({runId:"remote-build",permissionProfile:"guarded",capabilityContract:{digest:"d".repeat(64)} as RunnerCapabilityContract,capabilitiesConfig:emptyRunnerCapabilitiesConfig()});
  const managed=await env.runtime.buildTools((await env.extensions.generation()).generation,binding,"guarded",artifacts);
  try {
  const broker=new ToolBroker({approve:async request=>request.toolName === "mcp.notes.read_note",permissionProfile:"guarded",workspacePath:join(env.root,"project"),artifacts,executionGrants:binding.executionGrants});
  for(const tool of managed.tools)broker.register(tool);
  const result=await broker.invoke({type:"tool_call",callId:"remote-read",name:"mcp.notes.read_note",arguments:{id:"build-note"}},
    {runId:"remote-build",sessionId:"worker",actor:{role:"worker",id:"worker"}});
  assert.equal(result.isError,false,textOf(result));
  assert.match(textOf(result),/HERON-3/);
  const refused=await broker.invoke({type:"tool_call",callId:"remote-write",name:"mcp.notes.send_email",arguments:{to:"x"}},
    {runId:"remote-build",sessionId:"worker",actor:{role:"worker",id:"worker"}});
  assert.equal(refused.isError,true);
  assert.equal(remote.callCount.send_email ?? 0,0);
  } finally { await managed.close(); await binding.close(); await host.close(); }
});
