import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost } from "../src/execution-host.js";
import { ExtensionCredentialStore } from "../src/extension-credentials.js";
import { ExtensionManagementService } from "../src/extension-management-service.js";
import { createRemotePluginToolProvider, ManagedMcpRuntime } from "../src/extension-mcp.js";
import { remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, verifyDeviceProof, type RelayChallenge } from "../src/remote-auth.js";
import { RemoteConnector, type RemoteConnectionState, type RemotePluginToolProvider, type RemoteRequestRuntime } from "../src/remote-connector.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";
import { closeRemoteComposition, composeRemoteRuntime } from "../src/runner-composition.js";
import { closeRunnerResources } from "../src/runner-resource-cleanup.js";
import { childProcessIpcDuplex, FakeRelay, FixtureWebSocketTransport, pairedDuplex, TestRelayAuthority } from "./fixtures/remote-fake-relay.js";

const FIXED_TIME = "2026-10-27T12:00:00Z";
const clock = () => new Date(FIXED_TIME);
const CONTRACTS = new URL("../../docs/remote/r0/contracts/fixtures/", import.meta.url);
const CRASH_ONCE = fileURLToPath(new URL("./fixtures/remote-mcp-crash-once.mjs", import.meta.url));
const CHILD = fileURLToPath(new URL("./fixtures/remote-signal-runner.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
void TSX;
const UI = { kind: "ui" } as const;

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, CONTRACTS), "utf8")) as T;
}

function ambient(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && /^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(name))) as Record<string, string>;
}

function makeRequest(deviceId: string, overrides: Partial<RemoteRequest> = {}, counter = Math.floor(Math.random() * 1e9)): RemoteRequest {
  const request: RemoteRequest = {
    protocolVersion: "1.0.0", requestId: `req-${counter}`, accountId: "account-1", clientId: "client-1",
    deviceId, deviceEpoch: "5", toolId: "files_read", operationClass: "read", scopeRef: "scope-project",
    issuedAt: "2026-10-27T11:59:00Z", expiresAt: "2026-10-27T12:05:00Z", nonce: `nonce-${counter}`,
    idempotencyKey: `key-${counter}`, payloadDigest: "", traceId: `trace-${counter}`, payload: { path: "README.md" },
    ...overrides,
  };
  request.payloadDigest = remotePayloadDigest(request);
  return request;
}

async function harness(t: test.TestContext, options: {
  pluginTools?: RemotePluginToolProvider;
  pluginSetup?: (ctx: { root: string; project: string; state: string; host: ExecutionHost; artifacts: ArtifactStore }) => Promise<RemotePluginToolProvider>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "aiboard-fake-relay-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(join(project, "README.md"), "isolated relay read\n");
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: ambient() });
  const grants: Array<{ toolName: string; actor: { role: string; id: string }; sessionId: string }> = [];
  const observedHost: ExecutionHost = {
    ...host,
    bindRun: async (input) => {
      const binding = await host.bindRun(input);
      const authority = binding.executionGrants;
      return { ...binding, executionGrants: { ...authority, issue: async (request) => {
        const grant = await authority.issue(request);
        grants.push({ toolName: request.toolName, actor: request.actor, sessionId: request.sessionId });
        return grant;
      } } };
    },
  };
  let pluginTools = options.pluginTools;
  if (options.pluginSetup) pluginTools = await options.pluginSetup({ root, project, state, host, artifacts });
  const authority = new TestRelayAuthority();
  const composition = composeRemoteRuntime({
    stateDirectory: state, deviceDirectory: state, workspacePath: project, host: observedHost,
    permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig(), now: clock,
  });
  const device = composition.deviceStore.ensure("account-1");
  const session = authority.session("account-1", "client-1", FIXED_TIME);
  const relay = new FakeRelay();
  const [client, server] = pairedDuplex();
  relay.accept(server);
  const transport = new FixtureWebSocketTransport(client, relay.certificate);
  const results: ToolResult[] = [];
  let dispatches = 0;
  const runtime: RemoteRequestRuntime = {
    invoke: async (identity, name, args, signal, raw) => {
      dispatches += 1;
      const result = await composition.runtime.invoke(identity, name, args, signal, raw);
      results.push(result);
      return result;
    },
  };
  const states: RemoteConnectionState[] = [];
  const shutdown: string[] = [];
  let releaseRecovery!: () => void;
  const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  let sawDegraded!: () => void;
  const degraded = new Promise<void>((resolve) => { sawDegraded = resolve; });
  const connector = new RemoteConnector({
    deviceStore: composition.deviceStore, authenticator: composition.authenticator,
    admission: composition.admission, runtime, session, createTransport: () => transport,
    reconcile: async () => { composition.admission.reconcileStartup(); await recoveryGate; },
    now: clock,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); }),
    reconnect: { baseDelayMs: 500, maxDelayMs: 500, maxAttempts: 0 },
    ...(pluginTools ? { pluginTools } : {}),
    onStateChange: (value) => { states.push(value); if (value.state === "connected-degraded") sawDegraded(); },
    onShutdownStep: (step) => shutdown.push(step),
  });
  t.after(async () => {
    releaseRecovery();
    await closeRunnerResources({
      remote: { close: async () => {
        const failures: unknown[] = [];
        for (const close of [() => connector.close(), () => relay.close(), () => closeRemoteComposition(composition)]) {
          try { await close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Fake relay cleanup remains unverified.");
      } },
      executionHost: host,
    });
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const challenge: RelayChallenge = {
    audience: REMOTE_RELAY_AUDIENCE, accountId: session.accountId, deviceId: device.deviceId,
    scope: REMOTE_CONNECT_SCOPE, nonce: "relay-challenge-1", epoch: "5", expiresAt: "2026-10-27T12:05:00Z",
  };
  const starting = connector.start();
  await relay.send({ type: "challenge", challenge });
  const proof = await relay.nextMessage();
  assert.equal(proof.type, "proof");
  if (proof.type === "proof") {
    assert.equal(proof.deviceId, device.deviceId);
    assert.equal(proof.publicKey, device.publicKey);
    assert.equal(verifyDeviceProof(device.publicKey, challenge, proof.signature), true);
  }
  await relay.send({ type: "authenticated", epoch: challenge.epoch });
  await degraded;

  const send = async (request: RemoteRequest, authorization = authority.authorize(request)) => {
    await relay.send({ type: "request", request, authorization });
    const message = await relay.nextMessage();
    assert.equal(message.type, "response");
    return message.type === "response" ? message.response : (() => { throw new Error("expected response"); })();
  };

  return { root, project, state, relay, connector, composition, device, states, shutdown, grants, results, starting,
    releaseRecovery, authority, host, artifacts, send, dispatchCount: () => dispatches };
}

test("scenario 1-2: WSS device proof gates readiness and the authorized contract read dispatches once", { timeout: 180_000 }, async (t) => {
  const h = await harness(t);
  assert.equal(h.connector.isReady(), false);
  const examples = await Promise.all([
    fixture<RemoteConnectionState>("valid/connection-state.valid.authenticating.json"),
    fixture<RemoteConnectionState>("valid/connection-state.valid.degraded.json"),
    fixture<RemoteConnectionState>("valid/connection-state.valid.ready.json"),
  ]);
  assert.deepEqual(h.states.map(({ state, reasonCode }) => ({ state, reasonCode })),
    examples.slice(0, 2).map(({ state, reasonCode }) => ({ state, reasonCode })));
  h.releaseRecovery();
  await h.starting;
  assert.equal(h.connector.isReady(), true);
  assert.deepEqual(h.states.map(({ state, reasonCode }) => ({ state, reasonCode })),
    examples.map(({ state, reasonCode }) => ({ state, reasonCode })));
  assert.equal(h.states.at(-1)?.deviceEpoch, "5");

  const example = await fixture<RemoteRequest>("valid/remote-request.valid.read.json");
  const request = { ...example, deviceId: h.device.deviceId };
  request.payloadDigest = remotePayloadDigest(request);
  const response = await h.send(request);
  assert.equal(response.admitted, true, JSON.stringify(response));
  assert.equal(response.status, "completed");
  assert.ok(response.jobId);
  assert.equal(h.dispatchCount(), 1);
  assert.equal(h.results[0]?.isError, false);
  assert.match(JSON.stringify(h.results[0]?.content), /isolated relay read/);
  assert.equal(h.grants.length, 1);
  assert.equal(h.grants[0]?.toolName, "fs.read");
  const owner = h.composition.principals.find({ accountId: "account-1", clientId: "client-1", deviceId: h.device.deviceId });
  assert.ok(owner);
  assert.deepEqual(h.grants[0]?.actor, { role: "remote", id: owner.principalId });
  assert.equal(h.grants[0]?.sessionId, owner.sessionId);
  await h.connector.close();
  assert.deepEqual(h.shutdown, ["admission-stopped", "inflight-settled", "transport-closed"]);
});

test("scenario 3: mismatched scope, missing authorization and stale epoch are denied with zero dispatches", { timeout: 180_000 }, async (t) => {
  const h = await harness(t);
  h.releaseRecovery();
  await h.starting;
  // Resigned with a mismatched authorized scope: claims and request agree on an unapproved scope.
  const scopeRequest = makeRequest(h.device.deviceId, { scopeRef: "scope-unapproved" }, 101);
  const scopeResponse = await h.send(scopeRequest);
  assert.equal(scopeResponse.admitted, false);
  assert.equal(scopeResponse.errorCode, "unauthorized");
  assert.equal(scopeResponse.status, "blocked_policy");
  assert.equal(h.dispatchCount(), 0);
  // Missing authorization is a failure, not a bypass.
  const missing = makeRequest(h.device.deviceId, {}, 102);
  await h.relay.send({ type: "request", request: missing });
  const missingMessage = await h.relay.nextMessage();
  assert.equal(missingMessage.type === "response" && missingMessage.response.errorCode, "unauthorized");
  assert.equal(h.dispatchCount(), 0);
  // Contract epoch-mismatch fixture against the authenticated epoch 5.
  const stale = await fixture<RemoteRequest>("invalid/remote-request.invalid.device-epoch-mismatch.json");
  const staleRequest = { ...stale, deviceId: h.device.deviceId };
  staleRequest.payloadDigest = remotePayloadDigest(staleRequest);
  const staleResponse = await h.send(staleRequest);
  assert.equal(staleResponse.admitted, false);
  assert.equal(staleResponse.errorCode, "device_epoch_mismatch");
  assert.equal(h.dispatchCount(), 0);
  // The authorized read still works after the denials.
  const ok = await h.send(makeRequest(h.device.deviceId, {}, 103));
  assert.equal(ok.admitted, true);
  assert.equal(h.dispatchCount(), 1);
});

async function installCrashOnce(ctx: { root: string; project: string; state: string; host: ExecutionHost; artifacts: ArtifactStore }, t: test.TestContext) {
  const fixtureState = join(ctx.root, "mcp-fixture");
  await mkdir(fixtureState, { recursive: true });
  const credentials = new ExtensionCredentialStore(join(ctx.state, "extension-credentials.enc"), Buffer.alloc(32, 1));
  const internal = createRunnerInternalExecutionContext({
    projectDirectory: ctx.project, stateDirectory: ctx.state,
    processKernel: ctx.host.internalProcesses, ambientEnvironment: ctx.host.filteredEnvironmentSource(),
  });
  const runtime = new ManagedMcpRuntime({
    home: join(ctx.root, "home"), stateDirectory: ctx.state, projectRoot: ctx.project, credentials, internal,
    executionHost: ctx.host, capabilitiesConfig: () => emptyRunnerCapabilitiesConfig(),
    installer: {
      nodeExecutable: process.execPath, environment: ctx.host.filteredEnvironmentSource(),
      fetchJson: async () => { throw new Error("no network in tests"); },
      run: async () => { throw new Error("no installer in this test"); },
    },
  });
  const extensions = await ExtensionManagementService.open({
    home: join(ctx.root, "home"), projectRoot: ctx.project, credentials, handlers: [runtime.handler()],
  });
  runtime.attach(extensions);
  t.after(async () => { credentials.close(); await internal.close().catch(() => undefined); });
  const view = await extensions.inspectSource(
    { type: "executable", command: process.execPath, args: [CRASH_ONCE, fixtureState], serverName: "fixture" }, UI);
  const plan = await extensions.planChange({ action: "install", inspectionId: view.inspectionId, scope: extensions.projectScope() }, UI);
  const operation = await extensions.applyChange({ planId: plan.planId, planDigest: plan.planDigest, key: `ui-${plan.planId}` }, UI);
  assert.equal(operation.outcome, "succeeded", operation.diagnostics.join("; "));
  const extensionId = operation.result!.extensionId!;
  const policyView = await extensions.extensionToolPolicy(extensionId);
  await extensions.setExtensionToolPolicy(extensionId, {
    ...policyView.policy, remoteExposure: true, reviewed: policyView.discovered,
    toolFilter: {
      default: "deny",
      allow: policyView.discovered.flatMap((item) => item.toolNames.map((toolName) => ({ componentId: item.componentId, toolName }))),
      deny: [],
    },
  }, UI);
  const provider = createRemotePluginToolProvider(runtime, {
    generation: async () => (await extensions.generation()).generation,
    artifacts: ctx.artifacts, workspacePath: ctx.project,
  });
  const listed = await provider.list();
  assert.equal(listed.length, 1, JSON.stringify(listed));
  assert.match(listed[0]!.relayToolId, /^plugin_fixture_read_[0-9a-f]{8}$/);
  assert.equal(listed[0]!.available, true);
  return { provider, relayToolId: listed[0]!.relayToolId, fixtureState,
    closeTestDoubles: async () => { try { credentials.close(); } catch { /* already closed */ } await internal.close().catch(() => undefined); } };
}

test("scenario 4-5: managed process and plugin tool pass; plugin crash degrades, never replays, and recovers", { timeout: 180_000 }, async (t) => {
  let plugin!: Awaited<ReturnType<typeof installCrashOnce>>;
  const h = await harness(t, {
    pluginSetup: async (ctx) => {
      plugin = await installCrashOnce(ctx, t);
      return plugin.provider;
    },
  });
  h.releaseRecovery();
  await h.starting;
  assert.equal(h.connector.state().state, "tool-ready", JSON.stringify(h.connector.state()));

  // Managed process under the same remote owner, read back through the broker.
  const started = await h.send(makeRequest(h.device.deviceId, {
    toolId: "process_start", operationClass: "write",
    payload: { command: process.execPath, args: ["-e", "console.log('managed-hello'); setInterval(() => {}, 1000);"] },
  }, 201));
  assert.equal(started.admitted, true, JSON.stringify(started));
  const snapshot = h.results.at(-1)?.content.find((block) => block.type === "json" && !!block.value && typeof block.value === "object" && "processId" in block.value);
  assert.ok(snapshot && snapshot.type === "json");
  const processId = (snapshot.value as { processId: string }).processId;
  const output = await h.send(makeRequest(h.device.deviceId, {
    toolId: "process_read_output", operationClass: "read", payload: { processId, waitMs: 2_000 },
  }, 202));
  assert.equal(output.admitted, true, JSON.stringify(output));
  assert.match(JSON.stringify(h.results.at(-1)?.content), /managed-hello/);

  // Approved plugin tool through the connector.
  const read = await h.send(makeRequest(h.device.deviceId, {
    toolId: plugin.relayToolId, operationClass: "read", payload: {},
  }, 203));
  assert.equal(read.admitted, true, JSON.stringify(read));
  assert.equal(read.status, "completed", JSON.stringify(read));
  const callsBefore = await readFile(join(plugin.fixtureState, "calls.log"), "utf8");
  assert.match(callsBefore, / read/);

  // Crash after ready: degraded, interrupted call unknown, never replayed.
  const crashed = await h.send(makeRequest(h.device.deviceId, {
    toolId: plugin.relayToolId, operationClass: "read", payload: { crash: true },
  }, 204));
  assert.equal(crashed.admitted, true, JSON.stringify(crashed));
  assert.equal(crashed.status, "outcome_unknown", JSON.stringify(crashed));
  assert.equal(h.connector.state().state, "connected-degraded", JSON.stringify(h.connector.state()));
  assert.equal(h.connector.state().reasonCode, "optional_tool_unavailable");
  const callsAfterCrash = await readFile(join(plugin.fixtureState, "calls.log"), "utf8");
  assert.equal(callsAfterCrash.match(/ crash/g)?.length, 1, "the interrupted call was sent exactly once");

  // Re-attested restart of the same executable and schema returns to ready.
  const recovered = await h.send(makeRequest(h.device.deviceId, {
    toolId: plugin.relayToolId, operationClass: "read", payload: {},
  }, 205));
  assert.equal(recovered.admitted, true, JSON.stringify(recovered));
  assert.equal(recovered.status, "completed", JSON.stringify(recovered));
  assert.equal(h.connector.state().state, "tool-ready", JSON.stringify(h.connector.state()));
  const launches = (await readFile(join(plugin.fixtureState, "launches.log"), "utf8")).trim().split(/\r?\n/);
  assert.ok(launches.length >= 2, `expected a supervised restart, launches: ${launches.join(",")}`);
  const callsFinal = await readFile(join(plugin.fixtureState, "calls.log"), "utf8");
  assert.equal(callsFinal.match(/ crash/g)?.length, 1, "the crashed call was never replayed");
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`cleanup_blocked: timed out waiting for ${label}; this is a typed blocker, not a success.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("scenario 6: SIGINT shutdown of the child Runner cleans its managed process, MCP child and descendants", { timeout: 240_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-fake-relay-child-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const deviceDir = join(root, "device");
  const extensionsHome = join(root, "home");
  await mkdir(project); await mkdir(state); await mkdir(deviceDir);
  await writeFile(join(project, "README.md"), "isolated relay read\n");
  const parentArtifacts = new ArtifactStore(join(state, "artifacts"));
  const parentHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: parentArtifacts, ambientEnvironment: ambient() });
  const installed = await installCrashOnce({ root, project, state, host: parentHost, artifacts: parentArtifacts }, t);
  await installed.provider.close?.();
  await installed.closeTestDoubles();
  await parentHost.close();

  const authority = new TestRelayAuthority();
  const now = new Date();
  const sessionPath = join(root, "session.json");
  const certPath = join(root, "relay-cert.pem");
  const relay = new FakeRelay();
  await writeFile(sessionPath, JSON.stringify(authority.session("account-1", "client-1", now.toISOString())));
  await writeFile(certPath, relay.certificate);
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", CHILD,
    "--project", project, "--state-dir", state, "--device-dir", deviceDir,
    "--extensions-home", extensionsHome, "--relay-cert", certPath, "--session-file", sessionPath,
  ], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced", windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await relay.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  relay.accept(childProcessIpcDuplex(child));

  const identityPath = join(deviceDir, "remote-device.json");
  await waitFor("child device identity", () => existsSync(identityPath), 90_000);
  const identity = JSON.parse(await readFile(identityPath, "utf8")) as { deviceId: string; publicKey: string };
  const at = Date.now();
  const challenge: RelayChallenge = {
    audience: REMOTE_RELAY_AUDIENCE, accountId: "account-1", deviceId: identity.deviceId,
    scope: REMOTE_CONNECT_SCOPE, nonce: "child-challenge-1", epoch: "5",
    expiresAt: new Date(at + 5 * 60_000).toISOString(),
  };
  await relay.send({ type: "challenge", challenge });
  const proof = await relay.nextMessage();
  assert.equal(proof.type, "proof");
  if (proof.type === "proof") assert.equal(verifyDeviceProof(identity.publicKey, challenge, proof.signature), true);
  await relay.send({ type: "authenticated", epoch: "5" });
  const statusPath = join(state, "remote-status.json");
  await waitFor("child tool-ready status", async () => {
    if (child.exitCode !== null) throw new Error(`cleanup_blocked: child exited before readiness (${child.exitCode}): ${stderr.slice(-800)}`);
    try { return (JSON.parse(await readFile(statusPath, "utf8")) as { state: string }).state === "tool-ready"; } catch { return false; }
  }, 90_000);

  let counter = 500;
  const dynamic = (overrides: Partial<RemoteRequest> = {}): RemoteRequest => {
    counter += 1;
    const request: RemoteRequest = {
      protocolVersion: "1.0.0", requestId: `req-child-${counter}`, accountId: "account-1", clientId: "client-1",
      deviceId: identity.deviceId, deviceEpoch: "5", toolId: "files_read", operationClass: "read", scopeRef: "scope-project",
      issuedAt: new Date(Date.now() - 5_000).toISOString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      nonce: `nonce-child-${counter}`, idempotencyKey: `key-child-${counter}`, payloadDigest: "",
      traceId: `trace-child-${counter}`, payload: { path: "README.md" }, ...overrides,
    };
    request.payloadDigest = remotePayloadDigest(request);
    return request;
  };
  const send = async (request: RemoteRequest) => {
    await relay.send({ type: "request", request, authorization: authority.authorize(request) });
    const message = await relay.nextMessage();
    assert.equal(message.type, "response");
    return message.type === "response" ? message.response : (() => { throw new Error("expected response"); })();
  };

  const read = await send(dynamic());
  assert.equal(read.admitted, true, JSON.stringify(read));
  assert.equal(read.status, "completed", JSON.stringify(read));

  const pidFile = join(root, "managed.pid");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile.replaceAll("\\", "/"))}, "" + process.pid); setInterval(() => {}, 1000);`;
  const started = await send(dynamic({
    toolId: "process_start", operationClass: "write",
    payload: { command: process.execPath, args: ["-e", script] },
  }));
  assert.equal(started.admitted, true, JSON.stringify(started));
  await waitFor("managed process pid file", () => existsSync(pidFile), 30_000);
  const managedPid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isInteger(managedPid) && managedPid > 0);
  assert.equal(processExists(managedPid), true);

  const pluginCall = await send(dynamic({ toolId: installed.relayToolId, operationClass: "read", payload: {} }));
  assert.equal(pluginCall.admitted, true, JSON.stringify(pluginCall));
  assert.equal(pluginCall.status, "completed", JSON.stringify(pluginCall));
  const launchPids = (await readFile(join(installed.fixtureState, "launches.log"), "utf8"))
    .split(/\r?\n/).map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
  assert.ok(launchPids.length >= 1, "the MCP fixture child was launched by the child Runner");
  assert.ok(launchPids.some((pid) => processExists(pid)), "an MCP child is live before SIGINT");

  // POSIX: a real SIGINT. Windows cannot raise SIGINT in a console-less
  // child (child.kill is TerminateProcess, which would skip the Runner's
  // shutdown entirely), so the child runs the same registered SIGINT handler
  // on request. Either way the Runner alone must stop what it owns: no job
  // object or external reaper cleans up after it.
  if (process.platform === "win32") child.send({ type: "aiboard-test-sigint" });
  else child.kill("SIGINT");
  const exit = await Promise.race([
    closed,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cleanup_blocked: child did not exit after SIGINT; typed blocker, not a success. " + stderr.slice(-800))), 90_000)),
  ]);
  assert.ok(exit.code === 130 || (process.platform !== "win32" && exit.signal === "SIGINT"), `unexpected child exit ${JSON.stringify(exit)}: ${stderr.slice(-800)}`);
  // Exact owned cleanup, verified through recorded identities and OS liveness.
  for (const pid of [managedPid, ...launchPids]) {
    await waitFor(`owned process ${pid} to stop`, () => !processExists(pid), 30_000);
  }
  assert.equal(stdout.includes("remoteSignalRunnerReady"), true);
});
