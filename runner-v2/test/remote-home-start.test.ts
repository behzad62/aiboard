import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, verifyDeviceProof, type RelayChallenge } from "../src/remote-auth.js";
import { RemoteDeviceStore } from "../src/remote-device-store.js";
import { remoteDeviceDirectory, type StateLocationOptions } from "../src/launcher-instance.js";
import { resolveRunnerOwnedRoots, runnerOwnedPathContains } from "../src/runner-owned-roots.js";
import { startRunner, type RunnerStartSeams, type StartedRunner } from "../src/runner-start.js";
import { FakeRelay, FixtureWebSocketTransport, pairedDuplex, TestRelayAuthority } from "./fixtures/remote-fake-relay.js";

function location(home: string): StateLocationOptions {
  return {
    platform: process.platform, home,
    environment: process.platform === "win32"
      ? { ...process.env, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") }
      : { ...process.env, HOME: home, XDG_DATA_HOME: join(home, "xdg") },
  };
}

test("owned roots resolve nesting, case rules and aliases without creating paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-roots-"));
  try {
    const project = join(root, "project");
    const external = join(root, "external");
    await mkdir(project); await mkdir(external);
    const input = {
      projectPath: project, stateDirectory: join(external, "state"),
      deviceDirectory: join(external, "device"), extensionsHome: join(external, "extensions"),
      capabilitiesConfigPath: join(external, "capabilities.json"), location: location(external),
    };
    const outside = await resolveRunnerOwnedRoots(input);
    assert.equal(outside.nested, false);
    assert.equal(existsSync(input.stateDirectory), false);
    const nested = await resolveRunnerOwnedRoots({ ...input, stateDirectory: join(project, "state") });
    assert.equal(nested.nested, true);
    assert.ok(nested.directories.includes(join(await realpath(project), "state", "builds")));
    assert.equal(runnerOwnedPathContains(project.toUpperCase(), join(project, "child"), "darwin"), true);
    assert.equal(runnerOwnedPathContains(project.toUpperCase(), join(project, "child"), "win32"), true);
    if (process.platform !== "win32") {
      assert.equal(runnerOwnedPathContains(project.toUpperCase(), join(project, "child"), "linux"), project.toUpperCase() === project);
    }
    assert.equal(runnerOwnedPathContains(project, `${project}-sibling`, process.platform), false);
    const alias = join(root, "alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    const throughAlias = await resolveRunnerOwnedRoots({ ...input, stateDirectory: join(alias, "state") });
    assert.equal(throughAlias.nested, true);
    assert.equal(throughAlias.directories[0], join(await realpath(project), "state"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("nested state without --remote retains the original startup refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-home-refusal-"));
  const oldExitCode = process.exitCode;
  let failure: unknown;
  try {
    const result = await startRunner(["--project", root, "--state-dir", join(root, "state")], {
      controlListener: "none", onStartupError: (error) => { failure = error; },
    });
    assert.equal(result.started, false);
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, "invalid_state_directory: Runner state must be outside the project directory.");
    assert.equal(existsSync(join(root, "state")), false);
  } finally {
    process.exitCode = oldExitCode;
    await rm(root, { recursive: true, force: true });
  }
});

test("authenticated remote-only home start protects owned paths and uses cwd", { timeout: 120_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "aiboard-remote-home-"));
  const oldExitCode = process.exitCode;
  const state = join(home, "runner-state");
  const device = join(home, "device-custody");
  const extensions = join(home, "extension-store");
  const config = join(home, "runner-capabilities.json");
  const testLocation = location(home);
  const data = dirname(remoteDeviceDirectory(testLocation));
  const ownedDirectories = [state, data, device, extensions, join(state, "builds"),
    join(state, "verification-workspaces"), join(state, "verifier-workspaces"), join(state, "extensions")];
  for (const directory of ownedDirectories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, "sentinel.txt"), "private-needle\n");
  }
  const configText = JSON.stringify({ version: 1, extensions: [], languageServers: [] });
  await writeFile(config, configText);
  await writeFile(join(home, "visible.txt"), "visible cwd content\n");
  const identity = new RemoteDeviceStore(device).ensure("account-1");
  const authority = new TestRelayAuthority();
  const session = authority.session("account-1", "client-1", new Date().toISOString());
  const relay = new FakeRelay();
  const [client, server] = pairedDuplex();
  relay.accept(server);
  const transport = new FixtureWebSocketTransport(client, relay.certificate);
  let agents: Parameters<NonNullable<RunnerStartSeams["onLocalAgentsReady"]>>[0] | undefined;
  const lifecycle: { runner?: StartedRunner } = {};
  let shutdownResolve!: (error?: unknown) => void;
  const shutdownComplete = new Promise<unknown>((resolve) => { shutdownResolve = resolve; });
  t.after(async () => {
    if (lifecycle.runner?.started) {
      await lifecycle.runner.shutdown();
      const error = await shutdownComplete;
      if (error) throw error;
    }
    await relay.close();
    process.exitCode = oldExitCode;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const starting = startRunner([
    "--project", home, "--state-dir", state, "--extensions-home", extensions,
    "--capabilities-config", config, "--remote", "--remote-device-dir", device,
  ], {
    location: testLocation, controlListener: "none", createTransport: () => transport,
    issuer: { pairingUrl: "https://mcp.aiboard.me/pair", restoreSession: async () => session,
      requestSession: async () => { throw new Error("Unexpected pairing request."); } },
    onLocalAgentsReady: (value) => { agents = value; },
    onShutdownComplete: shutdownResolve,
  });
  const challenge: RelayChallenge = {
    audience: REMOTE_RELAY_AUDIENCE, accountId: session.accountId, deviceId: identity.deviceId,
    scope: REMOTE_CONNECT_SCOPE, nonce: "home-challenge", epoch: "5",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  await Promise.race([
    relay.send({ type: "challenge", challenge }),
    starting.then((value) => { if (!value.started) throw new Error("Runner failed before relay authentication."); }),
  ]);
  const proof = await relay.nextMessage();
  assert.equal(proof.type, "proof");
  if (proof.type === "proof") assert.equal(verifyDeviceProof(identity.publicKey, challenge, proof.signature), true);
  await relay.send({ type: "authenticated", epoch: "5" });
  const runner = await starting;
  lifecycle.runner = runner;
  assert.equal(runner.started, true);
  assert.equal(runner.remoteOnly, true);
  assert.equal(runner.remoteService?.status().state, "tool-ready");
  assert.ok(agents);
  const unavailable = (error: unknown) => error instanceof Error && "code" in error && error.code === "local_agents_unavailable_nested_state";
  await assert.rejects(agents.builds.recover(), unavailable);
  await assert.rejects(agents.builds.create({} as Parameters<typeof agents.builds.create>[0]), unavailable);
  await assert.rejects(agents.toolBench.start({} as Parameters<typeof agents.toolBench.start>[0]), unavailable);
  await assert.rejects(agents.chatSessions.create({ sessionId: "chat", runtimeId: "model" }), unavailable);
  await assert.rejects(agents.chatSessions.send("chat", { messageId: "m", text: "hello" }), unavailable);

  const runtime = runner.remoteService!.composition.runtime;
  const originalInvoke = runtime.invoke.bind(runtime);
  const results: ToolResult[] = [];
  runtime.invoke = async (...args) => {
    const result = await originalInvoke(...args);
    results.push(result);
    return result;
  };
  let sequence = 0;
  const send = async (toolId: string, payload: Record<string, unknown>, operationClass = "read", badSignature = false) => {
    sequence += 1;
    const request: RemoteRequest = {
      protocolVersion: "1.0.0", requestId: `home-${sequence}`, accountId: "account-1", clientId: "client-1",
      deviceId: identity.deviceId, deviceEpoch: "5", toolId, operationClass, scopeRef: "scope-project",
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: `home-nonce-${sequence}`, idempotencyKey: `home-key-${sequence}`, payloadDigest: "",
      traceId: `home-trace-${sequence}`, payload,
    };
    request.payloadDigest = remotePayloadDigest(request);
    const authorization = authority.authorize(request);
    await relay.send({ type: "request", request, authorization: badSignature ? { ...authorization, signature: "invalid" } : authorization });
    const message = await relay.nextMessage();
    assert.equal(message.type, "response");
    if (message.type !== "response") throw new Error("Expected a relay response.");
    return message.response;
  };
  const refusedAuth = await send("files_read", { path: "visible.txt" }, "read", true);
  assert.equal(refusedAuth.errorCode, "unauthorized");
  assert.equal(results.length, 0);
  const read = await send("files_read", { path: "visible.txt" });
  assert.equal(read.status, "completed");
  assert.match(JSON.stringify(results.at(-1)?.content), /visible cwd content/);
  for (const directory of ownedDirectories) {
    for (const [tool, payload, operation] of [
      ["files_read", { path: join(directory, "sentinel.txt") }, "read"],
      ["files_list", { path: directory }, "read"],
      ["files_search", { path: directory, pattern: "private-needle" }, "read"],
      ["files_write", { path: join(directory, "denied.txt"), content: "changed" }, "write"],
    ] as const) {
      await send(tool, payload, operation);
      assert.equal(results.at(-1)?.error?.code, "path_denied", `${tool} ${directory}`);
    }
    assert.equal(await readFile(join(directory, "sentinel.txt"), "utf8"), "private-needle\n");
    assert.equal(existsSync(join(directory, "denied.txt")), false);
  }
  for (const [tool, payload, operation] of [
    ["files_read", { path: config }, "read"], ["files_list", { path: config }, "read"],
    ["files_search", { path: config, pattern: "version" }, "read"],
    ["files_write", { path: config, content: "changed" }, "write"],
  ] as const) {
    await send(tool, payload, operation);
    assert.equal(results.at(-1)?.error?.code, "path_denied", tool);
  }
  assert.equal(await readFile(config, "utf8"), configText);
  await send("files_list", { path: "." });
  assert.equal(results.at(-1)?.isError, false);
  const listed = JSON.stringify(results.at(-1)?.content);
  assert.match(listed, /visible\.txt/);
  for (const hidden of [state, device, extensions, config]) assert.doesNotMatch(listed, new RegExp(basename(hidden)));
  const marker = join(home, "cwd-marker.txt");
  const processStart = await send("process_start", { command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('cwd-marker.txt', process.cwd())"] }, "write");
  assert.equal(processStart.status, "completed", JSON.stringify(processStart));
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(existsSync(marker), true);
  assert.equal((await realpath(await readFile(marker, "utf8"))).toLowerCase(), (await realpath(home)).toLowerCase());
});
