import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { ArtifactStore } from "../src/artifact-store.js";
import { createChildEnvironmentFactory } from "../src/child-environment.js";
import { ControlServer } from "../src/control-server.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { openLauncherMcpSession } from "../src/launcher-ipc.js";
import type { LauncherInstance } from "../src/launcher-instance.js";
import { parseLauncherArguments, runLauncher, runnerSpawnArguments } from "../src/launcher.js";
import { createLocalMcpProxy, LOCAL_MCP_INSTRUCTIONS, LocalMcpSessions } from "../src/local-stdio-mcp.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunSupervisor } from "../src/run-supervisor.js";

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const resultText = (value: unknown): string => JSON.stringify((value as CallResult).content);
function jsonResult(value: unknown): Record<string, unknown> {
  const result = value as CallResult;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text) as Record<string, unknown>;
}

async function localRoute(sessions: LocalMcpSessions, token: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: Map<string, string>; body: string }> {
  const server = new ControlServer({ supervisor: {} as RunSupervisor, token: "unrelated", bootstrapRun: async () => ({ baselineRevision: "x", baselineRef: "x" }), localMcp: sessions });
  const internal = server as unknown as { server: { address: () => { port: number } }; handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> };
  internal.server = { address: () => ({ port: 12345 }) };
  const headers = { host: "127.0.0.1:12345", authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders };
  const request = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  Object.assign(request, { method: "POST", url: "/v1/local-mcp", headers, rawHeaders: Object.entries(headers).flat() });
  const responseHeaders = new Map<string, string>();
  let responseBody = "";
  const response = { statusCode: 0, setHeader: (name: string, value: string) => responseHeaders.set(name.toLowerCase(), value),
    end: (value: string) => { responseBody = value; } } as unknown as ServerResponse;
  await internal.handle(request, response);
  return { status: response.statusCode, headers: responseHeaders, body: responseBody };
}

test("SDK clients use Runner broker grants and exact local managed-process owners", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".local-mcp-"));
  const project = join(root, "project"), state = join(root, "state"), outside = join(root, "outside");
  await mkdir(project); await mkdir(state); await mkdir(outside);
  await writeFile(join(project, "fixture.txt"), "local fixture\n");
  await writeFile(join(project, "fixture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(outside, "secret.txt"), "outside fixture\n");
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const bindings: ExecutionHostRunBinding[] = [];
  const capturingHost: ExecutionHost = { ...host, bindRun: async (input) => {
    const binding = await host.bindRun(input); bindings.push(binding); return binding;
  } };
  const sessions = new LocalMcpSessions({ host: capturingHost, workspacePath: project, statePath: join(state, "owners.sqlite"),
    permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  await sessions.recover();
  const first = sessions.mint(0), second = sessions.mint(1);
  const ownerDatabase = new DatabaseSync(join(state, "owners.sqlite"));
  const storedOwners = JSON.stringify(ownerDatabase.prepare("SELECT * FROM local_mcp_owners").all());
  ownerDatabase.close();
  assert.ok(!storedOwners.includes(first.token) && !storedOwners.includes(second.token));
  const proxy = createLocalMcpProxy((body) => sessions.perform(first.token, body));
  const client = new Client({ name: "fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([proxy.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("files_read"));
    assert.ok(names.includes("process_start"));
    assert.ok(names.includes("image_inspect"));
    for (const name of ["jobs_status", "jobs_events", "jobs_result", "jobs_cancel", "artifact_read", "git_commit", "browser", "devices_list", "complete_run"]) assert.ok(!names.includes(name), name);
    const instructions = client.getInstructions() ?? "";
    assert.equal(instructions, LOCAL_MCP_INSTRUCTIONS);
    for (const mentioned of instructions.match(/\b[a-z]+_[a-z_]+\b/gu) ?? []) assert.ok(names.includes(mentioned), `${mentioned} is not a local tool`);
    assert.match(resultText(await client.callTool({ name: "files_read", arguments: { path: "fixture.txt" } })), /local fixture/);
    const writeArgs = { path: "written.txt", content: "once", idempotencyKey: "write-once" };
    assert.equal((await client.callTool({ name: "files_write", arguments: writeArgs }) as CallResult).isError, undefined);
    assert.equal((await client.callTool({ name: "files_write", arguments: writeArgs }) as CallResult).isError, undefined);
    assert.equal((await client.callTool({ name: "files_write", arguments: { ...writeArgs, content: "twice" } }) as CallResult).isError, true);
    assert.match(resultText(await client.callTool({ name: "files_read", arguments: { path: "written.txt" } })), /once/);
    const routed = await localRoute(sessions, first.token, { operation: "call", name: "files_read", arguments: { path: "fixture.txt" } });
    assert.equal(routed.status, 200);
    assert.match(routed.body, /local fixture/);
    assert.equal((await localRoute(sessions, "invalid", { operation: "list" })).status, 403);
    const visual = await client.callTool({ name: "image_inspect", arguments: { path: "fixture.png" } });
    assert.equal(visual.isError, undefined, JSON.stringify(visual));
    assert.ok((visual.content as Array<{ type: string }>).some((part) => part.type === "image"));
    for (const name of ["unknown", "complete_run", "jobs_status", "artifact_read"]) assert.equal((await client.callTool({ name, arguments: {} }) as CallResult).isError, true, name);
    for (const forged of [{ role: "worker" }, { actor: { role: "architect", id: "x" } }, { grant: "x" }, { root: outside }, { workspacePath: outside }, { repoPath: outside }]) {
      assert.equal((await client.callTool({ name: "files_read", arguments: { path: "fixture.txt", ...forged } }) as CallResult).isError, true);
    }
    assert.equal((await client.callTool({ name: "files_read", arguments: { path: join(outside, "secret.txt") } }) as CallResult).isError, true);
    assert.equal((await client.callTool({ name: "image_inspect", arguments: { artifactHash: "a".repeat(64) } }) as CallResult).isError, true);
    assert.equal((await client.callTool({ name: "process_run", arguments: { command: process.execPath, env: { AIBOARD_MCP_DEPTH: "0" }, idempotencyKey: "forged-depth" } }) as CallResult).isError, true);
    const started = jsonResult(await client.callTool({ name: "process_start", arguments: {
      command: process.execPath, args: ["-e", "const c=require('node:crypto');process.stdout.write(JSON.stringify({depth:process.env.AIBOARD_MCP_DEPTH,argv:process.argv,envHashes:Object.values(process.env).map(v=>c.createHash('sha256').update(v).digest('hex'))}));setInterval(()=>{},1000)"], idempotencyKey: "start-one",
    } }));
    assert.equal(typeof started.processId, "string");
    const processId = started.processId as string;
    const read = await client.callTool({ name: "process_read_output", arguments: { processId, waitMs: 10_000 } });
    const stdout = (read as CallResult).content.find((item) => item.type === "text" && item.text?.startsWith("STDOUT\n"))!.text!.slice("STDOUT\n".length);
    assert.equal((JSON.parse(stdout) as { depth?: string }).depth, "1", "a Runner-started child of a depth-0 session sees depth 1");
    assert.doesNotMatch(resultText(read), new RegExp(first.token));
    assert.doesNotMatch(resultText(read), new RegExp(second.token));
    for (const token of [first.token, second.token]) assert.doesNotMatch(resultText(read), new RegExp(createHash("sha256").update(token).digest("hex")));
    const foreign = await sessions.perform(second.token, { operation: "call", name: "process_read_output", arguments: { processId } }) as { isError: boolean };
    assert.equal(foreign.isError, true);
    const ownerRecord = bindings[0]!.streamingState.readSession(bindings[0]!.streamingState.listSessionIds()[0]!)!;
    assert.equal(ownerRecord.actor.role, "local_mcp");
    assert.match(ownerRecord.actor.id, /^local-mcp-/);
    const signalled = await client.callTool({ name: "process_signal", arguments: { processId, signal: "SIGTERM", idempotencyKey: "stop-one" } });
    assert.equal((signalled as CallResult).isError, undefined, JSON.stringify(signalled));
    const child = await sessions.perform(second.token, { operation: "call", name: "process_run", arguments: {
      command: process.execPath, args: ["-e", "process.stdout.write(process.env.AIBOARD_MCP_DEPTH || 'missing')"], idempotencyKey: "nested-depth",
    } }) as { content: unknown[]; isError: boolean };
    assert.equal(child.isError, false, JSON.stringify(child));
    assert.match(JSON.stringify(child.content), /2/);
    first.revoke();
    await assert.rejects(sessions.perform(first.token, { operation: "list" }), /unavailable/);
  } finally {
    await client.close(); await proxy.close(); first.revoke(); second.revoke();
    await sessions.close(); await host.close(); await rm(root, { recursive: true, force: true });
  }
});

test("recursion depth is reserved, signed requests reject the limit, and tokens stay out of launch metadata", async () => {
  assert.equal(parseLauncherArguments(["mcp", "serve", "--stdio"]).command, "mcp");
  assert.throws(() => parseLauncherArguments(["mcp", "serve"]), /requires --stdio/);
  await assert.rejects(runLauncher(["mcp", "serve", "--stdio"], { environment: { AIBOARD_MCP_DEPTH: "2" } }), /recursion_limit/);
  const instance = {} as LauncherInstance;
  await assert.rejects(openLauncherMcpSession(instance, Buffer.alloc(32), 2), /recursion_limit/);
  const sessions = new LocalMcpSessions({ host: {} as ExecutionHost, workspacePath: process.cwd(), statePath: ":memory:", permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  assert.throws(() => sessions.mint(2), /recursion_limit/);
  await sessions.recover();
  const issued = sessions.mint(1);
  const args = runnerSpawnArguments({ projectPath: process.cwd(), projectKey: "project", owner: "owner" }, "C:/state", []);
  assert.ok(!JSON.stringify(args).includes(issued.token));
  assert.ok(!JSON.stringify(process.env).includes(issued.token));
  const environments = createChildEnvironmentFactory({ credentialResolver: { consume: () => { throw new Error("unused"); } }, mcpChildDepth: 2 });
  const prepared = environments.prepare({ ambient: {}, explicitOverrides: { AIBOARD_MCP_DEPTH: "0" } });
  assert.equal(environments.withChildEnvironment(prepared.capability, (environment) => environment.AIBOARD_MCP_DEPTH), "2");
  issued.revoke(); await sessions.close();
});

test("the local route refuses Origin and wrong Host without CORS", async () => {
  const sessions = new LocalMcpSessions({ host: {} as ExecutionHost, workspacePath: process.cwd(), statePath: ":memory:", permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  await sessions.recover();
  const issued = sessions.mint(0);
  const cases: Record<string, string>[] = [
    { host: "127.0.0.1:12345", origin: "https://aiboard.me" },
    { host: "localhost:12345" },
  ];
  for (const headers of cases) {
    const response = await localRoute(sessions, issued.token, { operation: "list" }, headers);
    assert.equal(response.status, 403);
    assert.equal(response.headers.has("access-control-allow-origin"), false);
  }
  issued.revoke();
  await sessions.close();
});

test("unverified recovery retains the exact owner and blocks session minting", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".local-mcp-recovery-"));
  const path = join(root, "owners.sqlite");
  let sessions: LocalMcpSessions | undefined;
  try {
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE local_mcp_owners (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
      principal_id TEXT NOT NULL UNIQUE, depth INTEGER NOT NULL);`);
    const id = "123e4567-e89b-42d3-a456-426614174000";
    database.prepare("INSERT INTO local_mcp_owners VALUES (?, ?, ?, ?)").run(`local-mcp-run-${id}`, `local-mcp-session-${id}`, `local-mcp-${id}`, 0);
    database.close();
    const host = { bindRun: async () => { throw new Error("injected recovery failure"); } } as unknown as ExecutionHost;
    sessions = new LocalMcpSessions({ host, workspacePath: root, statePath: path, permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    await assert.rejects(sessions.recover(), /recovery remains unverified/);
    assert.throws(() => sessions!.mint(0), /recovery is incomplete/);
    await sessions.close();
    sessions = undefined;
    const reopened = new DatabaseSync(path);
    assert.equal((reopened.prepare("SELECT count(*) AS count FROM local_mcp_owners").get() as { count: number }).count, 1);
    reopened.close();
  } finally { await sessions?.close(); await rm(root, { recursive: true, force: true }); }
});

test("stdio emits only MCP protocol frames and never the session token", async () => {
  const token = "f".repeat(64);
  const server = createLocalMcpProxy(async () => ({ tools: [] }));
  const input = new PassThrough(), output = new PassThrough();
  await server.connect(new StdioServerTransport(input, output));
  try {
    let next = once(output, "data");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } })}\n`);
    const [first] = await next;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    next = once(output, "data");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    const [second] = await next;
    const frames = `${first}${second}`.trim().split("\n").map((line) => JSON.parse(line) as { jsonrpc: string; id: number });
    assert.deepEqual(frames.map((frame) => [frame.jsonrpc, frame.id]), [["2.0", 1], ["2.0", 2]]);
    assert.ok(!`${first}${second}`.includes(token));
  } finally { await server.close(); input.destroy(); output.destroy(); }
});

/**
 * The relay's MCP_INSTRUCTIONS (packages/relay/src/mcp-tools.ts in aiboard-tunnel, as of aiboard-tunnel#29), verbatim.
 * When the relay's text changes, change this copy too; the test below then says what the local text must change.
 */
const RELAY_MCP_INSTRUCTIONS = [
  "AIBoard Remote runs tools on the user's own computer through their AI Board Runner.",
  "- deviceId may be left out while you use one device and no other is online; otherwise the call is refused.",
  "- Commands: process_run waits up to 45 s and returns the result; a longer command returns a jobId, and jobs_result has its result once jobs_status says it finished. Large output comes back as head, tail and diagnostics plus a processId. process_read_output with that processId takes search to find lines and lines to read them by number (process_run takes search too); do not run the command again or pipe it to see more.",
  "- Servers, long jobs and interactive programs: process_start with until (port, pattern or exit), because process_run stops a command at timeoutMs (default 120 s): what it printed comes back, but its effect is unknown. process_read_output with until {exit: true} and waitMs waits up to 30 s a call, so there is no need to poll quickly. process_interact sends one line and returns that turn's reply. process_signal stops a process and confirms it.",
  "- Files: files_read returns the file's sha256, even for a one-line range. files_patch (exact search and replace) and files_write default to the revision you last read or wrote, so read a file before changing it.",
  "- Git: status, diff and log have their own tools; commit by running git through process_run.",
  "- Every action that changes something needs an idempotencyKey: a new string per action, reused only to retry that same action.",
].join("\n");

/** The relay's wording that fits only the remote path, and what the local text says instead. The rest is shared word for word. */
const REMOTE_ONLY_WORDING: ReadonlyArray<readonly [relay: string, local: string]> = [
  ["AIBoard Remote runs tools on the user's own computer through their AI Board Runner.",
    "AI Board Runner runs these tools on this computer, in the project folder it was started for."],
  // There is one device, and the local server refuses deviceId.
  ["\n- deviceId may be left out while you use one device and no other is online; otherwise the call is refused.", ""],
  // No relay holds the call and there are no jobs: the call lasts as long as the command.
  ["process_run waits up to 45 s and returns the result; a longer command returns a jobId, and jobs_result has its result once jobs_status says it finished.",
    "process_run waits for the command to finish and returns the result."],
];

test("initialize gives a local client the relay's guidance, less what only the remote path has", async () => {
  const server = createLocalMcpProxy(async () => ({ tools: [] }));
  const input = new PassThrough(), output = new PassThrough();
  await server.connect(new StdioServerTransport(input, output));
  let instructions: string | undefined;
  try {
    const reply = once(output, "data");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } })}\n`);
    const [frame] = await reply;
    instructions = (JSON.parse(String(frame).split("\n")[0]!) as { result: { instructions?: string } }).result.instructions;
  } finally { await server.close(); input.destroy(); output.destroy(); }
  assert.equal(instructions, LOCAL_MCP_INSTRUCTIONS);
  let expected = RELAY_MCP_INSTRUCTIONS;
  for (const [relay, local] of REMOTE_ONLY_WORDING) {
    assert.ok(expected.includes(relay), `the relay text no longer says: ${relay.trim()}`);
    expected = expected.replace(relay, local);
  }
  // The Runner's own numbers (the 120 s default, the 30 s wait) are in the local text, so a change to one fails here too.
  assert.equal(LOCAL_MCP_INSTRUCTIONS, expected, "change the relay's text with this one, or list the difference in REMOTE_ONLY_WORDING");
  assert.equal(LOCAL_MCP_INSTRUCTIONS.length, 1307);
  assert.ok(LOCAL_MCP_INSTRUCTIONS.length < 1500, "this text sits in every session's context");
});
