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
import { createRemotePluginToolProvider, ManagedMcpRuntime, remotePluginToolId } from "../src/extension-mcp.js";
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
  auth: "none" | "oauth" | "bearer";
  readonly tokens: Map<string, number>;
  readonly codes: Map<string, { challenge: string; resource: string; redirectUri: string }>;
  tokenRequests: number;
  refreshes: number;
  callCount: Record<string, number>;
  issuedTokens: string[];
  redirectMcp: boolean;
  expiresIn: number;
  expireSession?: boolean;
  initializeCount?: number;
  modern?: boolean;
  formAnswer?: unknown;
  app?: boolean;
  appReads?: number;
  onToolCall?: (name:string)=>void;
  taskRecovery?: "working" | "completed" | "wrong";
  taskReads?: number;
  taskCancels?: number;
  taskCreated?: string;
}

/** Mock remote MCP server + OAuth authorization server on 127.0.0.1. */
async function mockRemote(t: test.TestContext, auth: "none" | "oauth" | "bearer"): Promise<MockState> {
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
    if (state.auth==="bearer" && request.headers.authorization!=="Bearer fixture-bearer-secret") { response.writeHead(401);response.end();return; }
    if (state.auth === "oauth") {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      const expires = token ? state.tokens.get(token) : undefined;
      if (!expires || expires < Date.now()) {
        response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${state.base}/.well-known/oauth-protected-resource/mcp", scope="notes.read"` });
        response.end();
        return;
      }
    }
    const message = JSON.parse(await readBody(request)) as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; requestState?: string; uri?: string; taskId?: string; inputResponses?: Record<string, unknown>; _meta?: { progressToken?: number } } };
    if (message.id === undefined) { response.statusCode = 202; response.end(); return; }
    if (state.modern && message.method === "server/discover") return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { supportedVersions: ["2026-07-28"] } });
    if (message.method === "initialize") {
      state.initializeCount = (state.initializeCount ?? 0) + 1;
      state.expireSession = false;
      return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock-remote" } } }, { "mcp-session-id": "session-1" });
    }
    if (state.expireSession) return sendJson(response, 404, {});
    if (state.modern ? request.headers["mcp-protocol-version"] !== "2026-07-28" : request.headers["mcp-session-id"] !== "session-1" || request.headers["mcp-protocol-version"] !== "2025-06-18") return sendJson(response, 400, { error: "missing session headers" });
    if (message.method === "tools/list") {
      // An SSE response carrying a refused server request before the real result.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} })}\n\n`);
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [
        { name: "read_note", description: "Read a note", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false }, ...(state.app ? { _meta: { ui: { resourceUri: "ui://notes/example.html" } } } : {}) },
        { name: "send_email", description: "Send an email", inputSchema: { type: "object" } },
        { name: "flaky_write", description: "Write that loses its response", inputSchema: { type: "object" }, annotations: { destructiveHint: false } },
      ] } })}\n\n`);
      return;
    }
    if (state.taskRecovery && message.method === "tasks/get") {
      assert.equal(message.params?.taskId,"persistent-task");
      assert.equal(request.headers["mcp-name"],"persistent-task");
      state.taskReads=(state.taskReads??0)+1;
      if(state.taskRecovery==="working"){request.socket.destroy();return;}
      return sendJson(response,200,{jsonrpc:"2.0",id:message.id,result:{resultType:"complete",
        taskId:state.taskRecovery==="wrong"?"other-task":"persistent-task",createdAt:state.taskCreated,lastUpdatedAt:new Date().toISOString(),
        ttlMs:60000,status:"completed",result:{content:[{type:"text",text:"verified recovered result"}]}}});
    }
    if(state.taskRecovery && message.method==="tasks/cancel"){
      state.taskCancels=(state.taskCancels??0)+1;
      return sendJson(response,200,{jsonrpc:"2.0",id:message.id,result:{resultType:"complete"}});
    }
    if (state.app && message.method === "resources/read") {
      assert.equal(message.params?.uri, "ui://notes/example.html");
      state.appReads = (state.appReads ?? 0) + 1;
      return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { contents: [{ uri: "ui://notes/example.html", mimeType: "text/html;profile=mcp-app", text: "<html>UI-ONLY-HTML</html>", _meta:{ui:{csp:{resourceDomains:["https://cdn.example.com"]}}} }] } });
    }
    if (message.method === "tools/call") {
      const name = message.params?.name ?? "";
      state.callCount[name] = (state.callCount[name] ?? 0) + 1;
      state.onToolCall?.(name);
      if(state.taskRecovery && name==="read_note"){
        state.taskCreated=new Date().toISOString();
        return sendJson(response,200,{jsonrpc:"2.0",id:message.id,result:{resultType:"task",taskId:"persistent-task",
          createdAt:state.taskCreated,lastUpdatedAt:state.taskCreated,ttlMs:60000,pollIntervalMs:100,status:"working",content:[]}});
      }
      if (state.app && name === "read_note") return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "note ready" }], _meta: { appOnly: "UI-ONLY-META" } } });
      if (state.modern && name === "read_note") {
        if (!message.params?.inputResponses) return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { resultType: "input_required", requestState: "note-state", inputRequests: { answer: { method: "elicitation/create", params: { mode: "form", message: "Choose your note label", requestedSchema: { type: "object", properties: { label: { type: "string", minLength: 2 } }, required: ["label"] } } } } } });
        assert.equal(message.params.requestState, "note-state");
        state.formAnswer = message.params.inputResponses.answer;
        return sendJson(response, 200, { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", content: [{ type: "text", text: "note ready" }] } });
      }
      if (name === "flaky_write") { request.socket.destroy(); return; }
      if (message.params?._meta?.progressToken !== undefined) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
        const token = message.params._meta.progressToken;
        response.write(event({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token + 1, progress: 99 } }));
        response.write(event({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } }));
        response.end(event({ jsonrpc: "2.0", id: message.id, result: { content: [], structuredContent: message.params.arguments, isError: false } }));
        return;
      }
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
  const credentials = new ExtensionCredentialStore(join(root, "state", "extension-credentials.enc"), Buffer.alloc(32, 1));
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
  return { root, extensions, runtime, sessions, seen, credentials, setSteps: (next: Step[]) => { steps = next; } };
}

function call(name: string, args: unknown): ModelTurn {
  return { blocks: [{ type: "tool_call", callId: `${name}-${Math.random().toString(16).slice(2)}`, name, arguments: args }], stopReason: "tool_calls" };
}

function textOf(result: ToolResult | undefined): string {
  return (result?.content ?? []).map((block) => block.type === "text" ? block.text : "").join("");
}

async function install(env: Awaited<ReturnType<typeof fixture>>, url: string, auth: "none" | "oauth" | "bearer") {
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

test("MCP routing IDs preserve exact downstream names without normalization collisions", () => {
  const names = ["readNote", "readnote", "read.note", "read_note", "a".repeat(128)];
  const ids = names.map((name) => remotePluginToolId("fixture", name, "2".repeat(64)));
  assert.equal(new Set(ids).size, names.length);
  for (const id of ids) assert.match(id, /^[a-z0-9_-]{1,64}$/);
});

test("generic gateway respects versioned exposure and preserves HTTP progress, arguments, and structured output", async (t) => {
  const env = await fixture(t);
  const server = await mockRemote(t, "none");
  const { operation } = await install(env, server.base + "/mcp", "none");
  const extensionId = operation.result!.extensionId!;
  const openGateway = () => createRemotePluginToolProvider(env.runtime, {
    generation: async () => (await env.extensions.generation()).generation,
    artifacts: new ArtifactStore(join(env.root, "gateway-artifacts")), workspacePath: join(env.root, "project"),
  });
  const gateway = openGateway();
  t.after(async () => { await gateway.close?.(); });
  const identity = { accountId: "account", clientId: "client", deviceId: "device" };
  const discovery = () => gateway.invoke(identity, "mcp_tools_list", { serverId: "notes" });
  const hidden = await discovery();
  assert.equal(hidden.error?.code, "mcp_server_not_exposed");
  assert.doesNotMatch(JSON.stringify(hidden), /read_note/);
  assert.match(JSON.stringify(await gateway.invoke(identity, "mcp_servers_list", {})), /Settings.*Extensions/);
  const tools = await env.extensions.extensionToolPolicy(extensionId);
  await env.extensions.setExtensionToolPolicy(extensionId, { ...tools.policy, remoteExposure: true, reviewed: tools.discovered,
    toolFilter: { default: "deny", allow: tools.discovered.map(({ componentId }) => ({ componentId, toolName: "read_note" })), deny: [] } }, UI);
  assert.deepEqual((await gateway.invoke(identity, "mcp_servers_list", {})).content, [{
    type: "json", value: { servers: [{ serverId: "notes", transport: "streamable_http", status: "ready", toolCount: 1 }] },
  }]);
  const listed = JSON.stringify(await discovery());
  assert.match(listed, /read_note.*inputSchema/);
  assert.doesNotMatch(listed, /send_email/);
  assert.equal((await gateway.invoke(identity, "mcp_tool_call", { serverId: "notes", toolName: "send_email" })).isError, true);
  const first = { serverId: "notes", toolName: "read_note", arguments: { id: "first" } };
  assert.equal((await gateway.invoke(identity, "mcp_tool_call", first)).isError, false);
  const starts = server.initializeCount!;
  server.expireSession = true;
  const updates: unknown[] = [];
  const result = await gateway.invokeAdmitted!(identity, "mcp_tool_call",
    { serverId: "notes", toolName: "read_note", arguments: { id: null }, timeoutMs: 5000 },
    new AbortController().signal, () => true, (value) => updates.push(value));
  assert.equal(server.initializeCount, starts + 1);
  assert.equal(server.callCount.read_note, 2);
  assert.equal((await gateway.invoke({ ...identity, clientId: "other" }, "mcp_tool_call", first)).isError, false);
  assert.equal(server.initializeCount, starts + 2, "a separate conversation initializes its own downstream session");
  assert.deepEqual(updates, [{ progress: 1, total: 2 }]);
  assert.deepEqual(result.result.content, [{ type: "json", value: { id: null } }]);
  assert.equal(result.result.isError, false);

  server.redirectMcp = true;
  const offlineGateway = openGateway();
  t.after(async () => { await offlineGateway.close?.(); });
  assert.deepEqual((await offlineGateway.invoke(identity, "mcp_servers_list", {})).content, [{
    type: "json", value: { servers: [{ serverId: "notes", transport: "streamable_http", status: "error", toolCount: 0 }] },
  }]);
  assert.equal((await offlineGateway.invoke(identity, "mcp_tools_list", { serverId: "notes" })).error?.code, "mcp_server_unavailable");
});

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
  const credentials = new ExtensionCredentialStore(join(root, "creds.enc"), Buffer.alloc(32, 1));
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

test("managed modern MCP chat waits for a session-bound human answer and continues", async (t) => {
  const remote = await mockRemote(t, "none"); remote.modern = true;
  const env = await fixture(t);
  const { operation } = await install(env, remote.base + "/mcp", "none");
  assert.equal(operation.outcome, "succeeded");
  await reviewTools(env, operation.result!.extensionId!);
  env.setSteps([(request) => {
    assert.ok(request.tools.some(tool => tool.name === "mcp.notes.read_note"));
    return call("mcp.notes.read_note", { id: "n1" });
  }, (_request, result) => {
    assert.match(textOf(result), /note ready/);
    return { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" };
  }]);
  await env.sessions.create({ sessionId: "mcp-form-chat", runtimeId: CONFIG.runtimeId });
  await env.sessions.send("mcp-form-chat", { messageId: "form1", text: "read note" });
  let prompt;
  for (let i = 0; i < 100; i++) {
    prompt = (await env.sessions.get("mcp-form-chat")).mcpInputs[0];
    if (prompt) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(prompt, "real chat publishes a pending form");
  assert.equal(prompt.source, "notes");
  assert.equal(remote.callCount.read_note, 1);
  await assert.rejects(env.sessions.answerMcpInput("mcp-form-chat", prompt.id, { action: "accept", content: { label: "x" } }), /match/);
  await env.sessions.answerMcpInput("mcp-form-chat", prompt.id, { action: "accept", content: { label: "user label" } });
  const done = await env.sessions.settled("mcp-form-chat");
  assert.equal(done.status, "idle");
  assert.equal(done.mcpInputs.length, 0);
  assert.deepEqual(remote.formAnswer, { action: "accept", content: { label: "user label" } });
  assert.equal(remote.callCount.read_note, 2);
});

test("managed MCP chat publishes a separate app resource and excludes app-only data from the model transcript", async t => {
  const remote = await mockRemote(t, "none"); remote.modern = true; remote.app = true;
  const env = await fixture(t);
  const { operation } = await install(env, remote.base + "/mcp", "none");
  assert.equal(operation.outcome, "succeeded");
  const reviewed=await env.extensions.extensionToolPolicy(operation.result!.extensionId!);
  await env.extensions.setExtensionToolPolicy(operation.result!.extensionId!,{...reviewed.policy,reviewed:reviewed.discovered,
    toolFilter:{default:"allow",allow:[],deny:[]}},UI);
  env.setSteps([() => call("mcp.notes.read_note", {id:"n1"}), (_request, result) => {
    assert.match(textOf(result), /note ready/);
    assert.doesNotMatch(JSON.stringify(result), /UI-ONLY/);
    return { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" };
  }]);
  await env.sessions.create({ sessionId: "app-chat", runtimeId: CONFIG.runtimeId });
  await env.sessions.send("app-chat", { messageId: "app1", text: "show note" });
  const done = await env.sessions.settled("app-chat");
  assert.equal(done.status, "idle");
  assert.equal(remote.appReads, 1);
  assert.equal(done.mcpApps.length, 1);
  assert.doesNotMatch(JSON.stringify(done), /UI-ONLY/);
  const id = done.mcpApps[0].id;
  const app = await env.sessions.getMcpApp("app-chat", id);
  assert.match(app.html, /UI-ONLY-HTML/);
  assert.deepEqual(app.resourceDomains,["https://cdn.example.com"]);
  assert.equal(app.result._meta?.appOnly, "UI-ONLY-META");
  assert.deepEqual(app.arguments, { id: "n1" });
  assert.doesNotMatch(JSON.stringify(env.seen), /UI-ONLY/);
  await env.sessions.create({ sessionId: "other-chat", runtimeId: CONFIG.runtimeId });
  await assert.rejects(env.sessions.getMcpApp("other-chat", id), /expired or belongs/);
  assert.deepEqual(app.allowedTools, ["read_note"]);
  const denied = await env.sessions.stageMcpAppCall("app-chat",id,{name:"read_note",arguments:{id:"denied"}});
  await env.sessions.answerMcpAppCall("app-chat",id,denied.id,{approve:false});
  assert.equal(remote.callCount.read_note,1);
  await assert.rejects(env.sessions.stageMcpAppCall("app-chat",id,{name:"send_email",arguments:{}}), /not available/);
  const ticket = await env.sessions.stageMcpAppCall("app-chat",id,{name:"read_note",arguments:{id:"n2"}});
  assert.equal(remote.callCount.read_note,1);
  await assert.rejects(env.sessions.answerMcpAppCall("other-chat",id,ticket.id,{approve:true}), /unavailable/);
  const reply = await env.sessions.answerMcpAppCall("app-chat",id,ticket.id,{approve:true});
  assert.equal(reply.isError,false);
  assert.equal(reply._meta?.appOnly,"UI-ONLY-META");
  assert.equal(remote.callCount.read_note,2);
  await assert.rejects(env.sessions.answerMcpAppCall("app-chat",id,ticket.id,{approve:true}), /unavailable/);
  const revoked = await env.sessions.stageMcpAppCall("app-chat",id,{name:"read_note",arguments:{id:"n3"}});
  const policy = await env.extensions.extensionToolPolicy(operation.result!.extensionId!);
  await env.extensions.setExtensionToolPolicy(operation.result!.extensionId!, { ...policy.policy, reviewed: policy.discovered, toolFilter: {default:"deny",allow:[],deny:[]} }, UI);
  assert.equal((await env.sessions.answerMcpAppCall("app-chat",id,revoked.id,{approve:true})).isError,true);
  assert.equal(remote.callCount.read_note,2);
  await env.sessions.dismissMcpApp("app-chat", id);
  assert.equal((await env.sessions.get("app-chat")).mcpApps.length, 0);
});

test("remote managed HTTP provider forwards form answers to the original downstream continuation", async t => {
  const env=await fixture(t);
  const remote=await mockRemote(t,"none");remote.modern=true;
  const {operation}=await install(env,remote.base+"/mcp","none");
  const extensionId=operation.result!.extensionId!;
  const tools=await env.extensions.extensionToolPolicy(extensionId);
  await env.extensions.setExtensionToolPolicy(extensionId,{...tools.policy,remoteExposure:true,reviewed:tools.discovered,
    toolFilter:{default:"deny",allow:tools.discovered.map(({componentId})=>({componentId,toolName:"read_note"})),deny:[]}},UI);
  const gateway=createRemotePluginToolProvider(env.runtime,{
    generation:async()=>(await env.extensions.generation()).generation,
    artifacts:new ArtifactStore(join(env.root,"gateway-artifacts")),workspacePath:join(env.root,"project"),
  });
  t.after(async()=>{await gateway.close?.();});
  const identity={accountId:"account",clientId:"client",deviceId:"device"};
  let prompts=0;
  const answer=await gateway.invokeAdmitted!(identity,"mcp_tool_call",{serverId:"notes",toolName:"read_note",arguments:{id:"n1"},forwardMcpInput:true},
    new AbortController().signal,()=>true,undefined,async (request,_signal,source)=>{
      prompts++;assert.equal(source,"notes");assert.equal(request.method,"elicitation/create");
      return {action:"accept",content:{label:"external answer"}};
    });
  assert.equal(answer.result.isError,false,JSON.stringify(answer.result));
  assert.match(textOf(answer.result),/note ready/);
  assert.equal(prompts,1);
  assert.equal(remote.callCount.read_note,2);
  assert.deepEqual(remote.formAnswer,{action:"accept",content:{label:"external answer"}});
});

test("managed HTTP task recovery uses a fresh client and never replays the original tool",async t=>{
  const env=await fixture(t);
  const remote=await mockRemote(t,"none");remote.modern=true;remote.taskRecovery="working";
  const {operation}=await install(env,remote.base+"/mcp","none");
  assert.equal(operation.outcome,"succeeded");
  const extensionId=operation.result!.extensionId!;
  const tools=await env.extensions.extensionToolPolicy(extensionId);
  await env.extensions.setExtensionToolPolicy(extensionId,{...tools.policy,remoteExposure:true,reviewed:tools.discovered,
    toolFilter:{default:"deny",allow:tools.discovered.map(({componentId})=>({componentId,toolName:"read_note"})),deny:[]}},UI);
  const makeGateway=()=>createRemotePluginToolProvider(env.runtime,{
    generation:async()=>(await env.extensions.generation()).generation,
    artifacts:new ArtifactStore(join(env.root,"gateway-artifacts")),workspacePath:join(env.root,"project"),
  });
  const gateway=makeGateway();
  const identity={accountId:"account",clientId:"client",deviceId:"device"};
  let receipt:import("../src/mcp-task-recovery.js").McpTaskRecoveryReceipt|undefined;
  try {
    const answer=await gateway.invokeAdmitted!(identity,"mcp_tool_call",{serverId:"notes",toolName:"read_note",arguments:{id:"n1"}},
      new AbortController().signal,()=>true,undefined,undefined,r=>{receipt=r;});
    assert.equal(answer.result.isError,true);
    assert.ok(receipt);
    assert.equal(receipt.taskId,"persistent-task");
    assert.equal(remote.callCount.read_note,1);
  }finally{await gateway.close?.();}
  const restarted=makeGateway();t.after(async()=>{await restarted.close?.();});
  remote.taskRecovery="wrong";
  assert.equal(await restarted.recoverTask!(receipt!,AbortSignal.timeout(5000),()=>true),undefined);
  remote.taskRecovery="completed";
  const before=remote.taskReads;
  assert.equal(await restarted.recoverTask!({...receipt!,componentDigest:"a".repeat(64)},AbortSignal.timeout(5000),()=>true),undefined);
  assert.equal(remote.taskReads,before);
  assert.equal(await restarted.recoverTask!({...receipt!,createdAt:"2000-01-01T00:00:00Z"},AbortSignal.timeout(5000),()=>true),undefined);
  const recovered=await restarted.recoverTask!(receipt!,AbortSignal.timeout(5000),()=>true);
  assert.equal(recovered?.isError,false,JSON.stringify(recovered));
  assert.match(textOf(recovered!),/verified recovered result/);
  assert.equal(remote.callCount.read_note,1);
  const current=await env.extensions.extensionToolPolicy(extensionId);
  await env.extensions.setExtensionToolPolicy(extensionId,{...current.policy,reviewed:current.discovered,toolFilter:{default:"deny",allow:[],deny:[]}},UI);
  const reads=remote.taskReads;
  assert.equal(await restarted.recoverTask!(receipt!,AbortSignal.timeout(5000),()=>true),undefined);
  assert.equal(remote.taskReads,reads);
});

for(const auth of ["bearer","oauth"] as const)test("authenticated task recovery: "+auth+" preserves exact grant, rejects replacement",async t=>{
  const env=await fixture(t);
  const remote=await mockRemote(t,auth);remote.modern=true;remote.taskRecovery="working";
  if(auth==="oauth") remote.expiresIn=30;
  const {operation}=await install(env,remote.base+"/mcp",auth);
  if(auth==="oauth"){
    const {url}=await env.extensions.beginSignIn(operation.id,UI);
    const redirected=await fetch(url,{redirect:"manual"});
    const callback=new URL(redirected.headers.get("location")!);
    await env.extensions.completeSignIn(callback.searchParams.get("state")!,callback.searchParams.get("code")!);
  }else{
    await env.extensions.submitCredential(operation.id,"MCP_BEARER_TOKEN","fixture-bearer-secret",UI);
  }
  const installed=await env.extensions.operationStatus(operation.id,UI);
  assert.equal(installed.outcome,"succeeded",JSON.stringify(installed.diagnostics));
  const extensionId=installed.result!.extensionId!;
  const tools=await env.extensions.extensionToolPolicy(extensionId);
  await env.extensions.setExtensionToolPolicy(extensionId,{...tools.policy,remoteExposure:true,reviewed:tools.discovered,
    toolFilter:{default:"deny",allow:tools.discovered.map(({componentId})=>({componentId,toolName:"read_note"})),deny:[]}},UI);
  const makeGateway=()=>createRemotePluginToolProvider(env.runtime,{
    generation:async()=>(await env.extensions.generation()).generation,
    artifacts:new ArtifactStore(join(env.root,"gateway-artifacts")),workspacePath:join(env.root,"project"),
  });
  const gateway=makeGateway();
  let receipt:import("../src/mcp-task-recovery.js").McpTaskRecoveryReceipt|undefined;
  try{
    const answer=await gateway.invokeAdmitted!({accountId:"account",clientId:"client",deviceId:"device"},"mcp_tool_call",
      {serverId:"notes",toolName:"read_note",arguments:{id:"n1"}},new AbortController().signal,()=>true,undefined,undefined,r=>{receipt=r;});
    assert.equal(answer.result.isError,true);
    assert.ok(receipt?.credentialBinding);
    assert.equal(remote.callCount.read_note,1);
  }finally{await gateway.close?.();}
  const fresh=makeGateway();t.after(async()=>fresh.close?.());
  remote.taskRecovery="completed";
  const refreshes=remote.refreshes;
  const recovered=await fresh.recoverTask!(receipt!,AbortSignal.timeout(5000),()=>true);
  assert.match(textOf(recovered),/verified recovered result/);
  assert.equal(remote.callCount.read_note,1);
  if(auth==="oauth") assert.ok(remote.refreshes>refreshes);
  const count=remote.taskReads;
  assert.equal(await fresh.recoverTask!({...receipt!,credentialBinding:undefined},AbortSignal.timeout(5000),()=>true),undefined);
  const meta=env.credentials.list(extensionId)[0]!;
  const snapshot=env.credentials.taskCredential(meta.ref);
  assert.equal(snapshot.lineage,receipt!.credentialBinding);
  // Even replacing the same value with the same public reference is a new grant.
  const replacement=env.credentials.put({extensionId,name:snapshot.name,kind:snapshot.kind,value:snapshot.value,
    refreshToken:snapshot.refreshToken,expiresAt:snapshot.expiresAt,scope:snapshot.scope,resource:snapshot.resource,oauthClient:snapshot.oauthClient});
  assert.equal(replacement.ref,meta.ref);
  assert.notEqual(env.credentials.taskCredential(meta.ref).lineage,receipt!.credentialBinding);
  assert.equal(await fresh.recoverTask!(receipt!,AbortSignal.timeout(5000),()=>true),undefined);
  assert.equal(remote.taskReads,count);
  assert.equal(remote.callCount.read_note,1);
  assert.doesNotMatch(JSON.stringify(receipt),/fixture-bearer-secret|access-\d|refresh-1/);
});

test("managed HTTP App write requires explicit allowance, one approval, and current policy", async t => {
  const remote = await mockRemote(t, "none"); remote.modern = true; remote.app = true;
  const env = await fixture(t);
  const { operation } = await install(env, remote.base + "/mcp", "none");
  assert.equal(operation.outcome, "succeeded");
  const extensionId=operation.result!.extensionId!;
  await env.extensions.setToolPolicy(extensionId,"all",UI);
  const policy=await env.extensions.extensionToolPolicy(extensionId);
  const keys=policy.discovered.flatMap(({componentId})=>["send_email","flaky_write"].map(toolName=>({componentId,toolName})));
  await env.extensions.setExtensionToolPolicy(extensionId,{...policy.policy,reviewed:policy.discovered,
    toolFilter:{default:"allow",allow:keys,deny:[]}},UI);
  env.setSteps([() => call("mcp.notes.read_note", {id:"n1"}), (_request, result) => {
    assert.match(textOf(result), /note ready/);
    assert.doesNotMatch(JSON.stringify(result), /UI-ONLY/);
    return { blocks: [{ type: "text", text: "done" }], stopReason: "end_turn" };
  }]);
  await env.sessions.create({ sessionId: "app-chat", runtimeId: CONFIG.runtimeId });
  await env.sessions.send("app-chat", { messageId: "app1", text: "show note" });
  const done = await env.sessions.settled("app-chat");
  assert.equal(done.status, "idle");
  assert.equal(remote.appReads, 1);
  assert.equal(done.mcpApps.length, 1);
  assert.doesNotMatch(JSON.stringify(done), /UI-ONLY/);
  const id=done.mcpApps[0].id;
  const app=await env.sessions.getMcpApp("app-chat",id);
  assert.ok(app.allowedTools?.includes("send_email"));
  assert.ok(app.allowedTools?.includes("flaky_write"));
  assert.equal(remote.callCount.send_email,undefined);
  const denied=await env.sessions.stageMcpAppCall("app-chat",id,{name:"send_email",arguments:{subject:"denied"}});
  assert.equal(denied.risk,"destructive");
  await env.sessions.answerMcpAppCall("app-chat",id,denied.id,{approve:false});
  assert.equal(remote.callCount.send_email,undefined);
  const ticket=await env.sessions.stageMcpAppCall("app-chat",id,{name:"send_email",arguments:{subject:"approved"}});
  ticket.arguments.subject="tampered";
  const result=await env.sessions.answerMcpAppCall("app-chat",id,ticket.id,{approve:true});
  assert.equal(result.isError,false,JSON.stringify(result));
  assert.match(JSON.stringify(result.content),/approved/);
  assert.doesNotMatch(JSON.stringify(result.content),/tampered/);
  assert.equal(remote.callCount.send_email,1);
  await assert.rejects(env.sessions.answerMcpAppCall("app-chat",id,ticket.id,{approve:true}),/unavailable/);
  const uncertain=await env.sessions.stageMcpAppCall("app-chat",id,{name:"flaky_write",arguments:{}});
  assert.equal(uncertain.risk,"write");
  const failed=await env.sessions.answerMcpAppCall("app-chat",id,uncertain.id,{approve:true});
  assert.equal(failed.isError,true);
  assert.match(JSON.stringify(failed.content),/not retried/);
  assert.equal(remote.callCount.flaky_write,1);
  const revoked=await env.sessions.stageMcpAppCall("app-chat",id,{name:"send_email",arguments:{subject:"revoked"}});
  const live=await env.extensions.extensionToolPolicy(extensionId);
  await env.extensions.setExtensionToolPolicy(extensionId,{...live.policy,reviewed:live.discovered,
    toolFilter:{default:"allow",allow:[],deny:[]}},UI);
  assert.equal((await env.sessions.answerMcpAppCall("app-chat",id,revoked.id,{approve:true})).isError,true);
  assert.equal(remote.callCount.send_email,1);
});

test("an App cannot combine tool output from an old credential with resources from a replacement",async t=>{
  const env=await fixture(t);
  const remote=await mockRemote(t,"bearer");remote.modern=true;remote.app=true;
  const {operation}=await install(env,remote.base+"/mcp","bearer");
  await env.extensions.submitCredential(operation.id,"MCP_BEARER_TOKEN","fixture-bearer-secret",UI);
  const installed=await env.extensions.operationStatus(operation.id,UI);
  assert.equal(installed.outcome,"succeeded");
  const extensionId=installed.result!.extensionId!;
  await reviewTools(env,extensionId);
  const replace=()=>{
    const saved=env.credentials.list(extensionId)[0]!;
    env.credentials.put({extensionId,name:saved.name,kind:saved.kind,value:"fixture-bearer-secret"});
  };
  remote.onToolCall=name=>{if(name==="read_note")replace();};
  env.setSteps([()=>call("mcp.notes.read_note",{id:"n1"}),(_request,result)=>{
    assert.match(textOf(result),/note ready/);return {blocks:[{type:"text",text:"done"}],stopReason:"end_turn"};
  }]);
  await env.sessions.create({sessionId:"app-credential-race",runtimeId:CONFIG.runtimeId});
  await env.sessions.send("app-credential-race",{messageId:"m1",text:"Read note"});
  const done=await env.sessions.settled("app-credential-race");
  assert.equal(done.status,"idle");
  assert.equal(remote.callCount.read_note,1);
  assert.equal(remote.appReads,undefined);
  assert.deepEqual(done.mcpApps,[]);
});
