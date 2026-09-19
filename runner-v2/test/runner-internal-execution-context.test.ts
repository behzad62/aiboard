import assert from "node:assert/strict";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createRunnerInternalExecutionContext as createRunnerInternalExecutionContextProduction,
} from "../src/runner-internal-execution-context.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import type {
  RunnerInternalOwnedProcess,
  RunnerInternalProcessKernel,
} from "../src/runner-internal-process-kernel.js";

const here = dirname(fileURLToPath(import.meta.url));
const createRunnerInternalExecutionContext = (
  input: Parameters<typeof createRunnerInternalExecutionContextProduction>[0],
) => createRunnerInternalExecutionContextProduction({
  ...input,
  ambientEnvironment: input.ambientEnvironment ?? snapshotNativeBuildAmbientEnvironment(),
});

test("static MCP attestation spawns nothing and ephemeral discovery cannot call tools or leak a live channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-context-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const marker = join(root, "mcp-started.txt");
  const methodLog = join(root, "mcp-methods.txt");
  const fixture = join(here, "fixtures", "mcp-server.mjs");
  await mkdir(project);
  await mkdir(state);
  const context = createRunnerInternalExecutionContext({
    projectDirectory: project,
    stateDirectory: state,
  });
  try {
    const servers = [{
      name: "docs",
      command: `${quote(process.execPath)} ${quote(fixture)} ${quote(marker)} ${quote(methodLog)}`,
    }];
    const attested = await context.attestConfiguredCapabilities({
      mcpServers: servers,
      capabilitiesConfig: { extensions: [], languageServers: [] },
    });
    assert.equal(existsSync(marker), false);
    assert.equal(attested.mcp.length, 1);
    assert.match(attested.mcp[0]!.configDigest, /^[a-f0-9]{64}$/);
    assert.equal(
      attested.mcp[0]!.executableDigest,
      createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
      "MCP attestation must hash the configured server executable, not its shell",
    );
    assert.equal("command" in attested.mcp[0]!, false);

    const executor = context.createMcpDiscoveryExecutor({
      runId: "run-discovery",
      servers,
      attestation: attested.mcp,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 5_000,
      terminationTimeoutMs: 15_000,
    });
    assert.equal("call" in executor, false);
    assert.equal("manager" in executor, false);
    assert.equal("channel" in executor, false);
    const discovered = await executor.discover();
    assert.equal(discovered.principal.purpose, "mcp_discovery");
    assert.equal(discovered.principal.role, "runner_internal");
    assert.equal(discovered.servers[0]!.status, "ready");
    const discoveryPid = Number(readFileSync(marker, "utf8"));
    assert.deepEqual(discovered.servers[0]!.tools.map((tool) => tool.name), ["lookup"]);
    assert.match(discovered.servers[0]!.schemaDigest!, /^[a-f0-9]{64}$/);
    assert.equal(discovered.servers[0]!.cleanupVerified, true);
    assert.equal("call" in discovered, false);
    const durable = JSON.parse(readFileSync(join(
      state,
      "builds",
      runnerRunStateSegment("run-discovery"),
      "mcp-discovery.json",
    ), "utf8")) as unknown;
    assert.deepEqual(durable, discovered);
    assert.equal(JSON.stringify(durable).includes(process.execPath), false);
    assert.deepEqual(readFileSync(methodLog, "utf8").trim().split("\n"), [
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    assert.equal(isProcessAlive(discoveryPid), false);
    await assert.rejects(executor.discover(), /already completed/);
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP discovery verifies descendant cleanup before reporting cleanupVerified", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-tree-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const marker = join(root, "descendant-pid.txt");
  await mkdir(project);
  await mkdir(state);
  const context = createRunnerInternalExecutionContext({ projectDirectory: project, stateDirectory: state });
  let descendantPid = 0;
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  try {
    const servers = [{
      name: "tree",
      command: `${quote(process.execPath)} ${quote(join(here, "fixtures", "mcp-descendant-server.mjs"))} ${quote(marker)}`,
    }];
    const attestation = await context.attestConfiguredCapabilities({
      mcpServers: servers,
      capabilitiesConfig: { extensions: [], languageServers: [] },
    });
    const result = await context.createMcpDiscoveryExecutor({
      runId: "run-tree",
      servers,
      attestation: attestation.mcp,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
      terminationTimeoutMs: 15_000,
    }).discover();
    descendantPid = Number(readFileSync(marker, "utf8"));
    assert.equal(result.servers[0]?.cleanupVerified, true);
    assert.equal(isProcessAlive(descendantPid), false,
      "cleanupVerified must cover descendants that outlive the MCP launcher");
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "MCP discovery verifies descendant cleanup before reporting cleanupVerified", root: root, hasPrimaryFailure, primaryFailure,
      cleanup: async () => { await context.close(); },
      certify: async () => {
        if (!descendantPid && existsSync(marker)) descendantPid = Number(readFileSync(marker, "utf8"));
        assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0, "the exact acquired process observation is required");
        try { process.kill(descendantPid, 0); throw new Error("Owned fixture process remains live after cleanup."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      },
      removeRoot: () => rm(root, { recursive: true }),
    });
  }
});

test("MCP discovery uses the canonical collision-resistant run state segment", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-run-state-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  await mkdir(state);
  const context = createRunnerInternalExecutionContext({ projectDirectory: project, stateDirectory: state });
  try {
    const attestation = await context.attestConfiguredCapabilities({
      mcpServers: [],
      capabilitiesConfig: { extensions: [], languageServers: [] },
    });
    for (const runId of ["Run-A", "run-a"]) {
      await context.createMcpDiscoveryExecutor({
        runId,
        servers: [],
        attestation: attestation.mcp,
      }).discover();
    }
    for (const runId of ["Run-A", "run-a"]) {
      const durable = JSON.parse(readFileSync(join(
        state,
        "builds",
        runnerRunStateSegment(runId),
        "mcp-discovery.json",
      ), "utf8")) as { runId: string };
      assert.equal(durable.runId, runId);
    }
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP discovery enforces its response line bound while bytes arrive", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-line-bound-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const marker = join(root, "oversized-completed.txt");
  await mkdir(project);
  await mkdir(state);
  const context = createRunnerInternalExecutionContext({ projectDirectory: project, stateDirectory: state });
  try {
    const servers = [{
      name: "oversized",
      command: `${quote(process.execPath)} ${quote(join(here, "fixtures", "mcp-oversized-server.mjs"))} ${quote(marker)}`,
    }];
    const attestation = await context.attestConfiguredCapabilities({
      mcpServers: servers,
      capabilitiesConfig: { extensions: [], languageServers: [] },
    });
    const result = await context.createMcpDiscoveryExecutor({
      runId: "run-oversized",
      servers,
      attestation: attestation.mcp,
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 500,
      terminationTimeoutMs: 15_000,
    }).discover();
    assert.equal(result.servers[0]?.status, "error");
    assert.equal(existsSync(marker), false,
      "the child must be stopped at the byte bound instead of after readline buffers the whole line");
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Git preflight and MCP discovery use distinct closed internal principals", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-principals-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  await mkdir(state);
  const context = createRunnerInternalExecutionContext({
    projectDirectory: project,
    stateDirectory: state,
    gitExecutor: async () => ({
      exitCode: 0,
      stdout: "git version 2.50.1.windows.1\n",
      stderr: "",
    }),
  });
  try {
    const git = await context.gitPreflight();
    assert.equal(git.result.available, true);
    assert.equal(git.principal.purpose, "git_preflight");
    assert.equal(git.principal.role, "runner_internal");
    const attested = await context.attestConfiguredCapabilities({
      mcpServers: [],
      capabilitiesConfig: { extensions: [], languageServers: [] },
    });
    const discovery = await context.createMcpDiscoveryExecutor({
      runId: "run-empty",
      servers: [],
      attestation: attested.mcp,
    }).discover();
    assert.notEqual(git.principal.principalId, discovery.principal.principalId);
    assert.notEqual(git.principal.callId, discovery.principal.callId);
    assert.deepEqual(discovery.servers, []);
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP discovery retains a transient cleanup failure for an exact executor retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-discovery-retry-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  await mkdir(state);
  const fixture = discoveryRetryKernel();
  const context = createRunnerInternalExecutionContext({
    projectDirectory: project,
    stateDirectory: state,
    processKernel: fixture.kernel,
  });
  try {
    const servers = [{ name: "retry", command: quote(process.execPath) }];
    const attestation = await context.attestConfiguredCapabilities({
      mcpServers: servers,
      capabilitiesConfig: { extensions: [], languageServers: [] },
    });
    const executor = context.createMcpDiscoveryExecutor({
      runId: "run-cleanup-retry",
      servers,
      attestation: attestation.mcp,
      requestTimeoutMs: 1_000,
      shutdownTimeoutMs: 100,
      terminationTimeoutMs: 100,
    });
    await assert.rejects(executor.discover(), /transient discovery cleanup failure/);
    assert.equal(fixture.closeCalls(), 1);
    await executor.close();
    assert.equal(fixture.closeCalls(), 2);
    assert.equal(fixture.activeCount(), 0);
    await context.close();
  } finally {
    await context.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Runner internal context retries a transient owned-kernel close failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-context-retry-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  await mkdir(state);
  let closeCalls = 0;
  const processKernel: RunnerInternalProcessKernel = {
    launch: async () => { throw new Error("unexpected launch"); },
    activeCount: () => 0,
    close: async () => {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error("transient kernel close failure");
    },
  };
  const context = createRunnerInternalExecutionContext({
    projectDirectory: project,
    stateDirectory: state,
    processKernel,
    closeInjectedProcessKernel: true,
  });
  try {
    await assert.rejects(
      context.close(),
      (error: unknown) => errorContains(error, "transient kernel close failure"),
    );
    await context.close();
    assert.equal(closeCalls, 2);
  } finally {
    await context.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("static MCP attestation refuses shell-dependent commands before any pre-run effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-shell-command-"));
  const project = join(root, "project");
  const state = join(root, "state");
  const marker = join(root, "mcp-started.txt");
  const methodLog = join(root, "mcp-methods.txt");
  const fixture = join(here, "fixtures", "mcp-server.mjs");
  await mkdir(project);
  await mkdir(state);
  const context = createRunnerInternalExecutionContext({ projectDirectory: project, stateDirectory: state });
  try {
    const direct = `${quote(process.execPath)} ${quote(fixture)} ${quote(marker)} ${quote(methodLog)}`;
    const shellCommand = process.platform === "win32"
      ? `set "RUNNER_MCP_COMPAT=1" && ${direct}`
      : `RUNNER_MCP_COMPAT=1 ${direct}`;
    const servers = [{ name: "shell-compatible", command: shellCommand }];
    await assert.rejects(context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig: { extensions: [], languageServers: [] } }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "mcp_command_invalid");
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(methodLog), false);
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

function quote(value: string): string {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function discoveryRetryKernel() {
  let outputSink: Parameters<RunnerInternalOwnedProcess["setOutputSink"]>[0] | undefined;
  let closeCalls = 0;
  let active = false;
  let sequence = 1;
  let offset = 0;
  const binding = Object.freeze({
    registryId: "runner-internal-discovery-test-registry",
    backendId: "runner-internal-discovery-test-backend",
    implementationGeneration: "runner-internal-discovery-test-generation",
    implementationDigest: "a".repeat(64),
    attestationVersion: 1,
    attestationDigest: "b".repeat(64),
    opaqueIdentity: "runner-internal-discovery-test-process",
    birthFingerprint: {
      observedAt: "2026-09-01T00:00:00.000Z",
      discriminator: "runner-internal-discovery-test-birth",
    },
    startedAt: "2026-09-01T00:00:00.000Z",
  });
  const owned: RunnerInternalOwnedProcess = Object.freeze({
    binding,
    setOutputSink(sink: Parameters<RunnerInternalOwnedProcess["setOutputSink"]>[0]) {
      outputSink = sink;
      return () => {
        if (outputSink === sink) outputSink = undefined;
      };
    },
    async write(payload: Uint8Array) {
      const request = JSON.parse(Buffer.from(payload).toString("utf8")) as {
        id?: number;
        method?: string;
      };
      if (request.id === undefined) return;
      const response = Buffer.from(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: request.method === "tools/list" ? { tools: [] } : {},
      })}\n`);
      const metadata = Object.freeze({
        stream: "stdout" as const,
        sequence: sequence++,
        startOffset: offset,
        endOffset: offset + response.byteLength,
        byteLength: response.byteLength,
        digest: createHash("sha256").update(response).digest("hex"),
      });
      offset = metadata.endOffset;
      await outputSink?.(metadata, response);
    },
    async closeInput() {},
    async reconcile() { return { state: "exited" as const, exitCode: 0 }; },
    async closeVerified() {
      closeCalls += 1;
      if (closeCalls === 1) throw new Error("transient discovery cleanup failure");
      active = false;
      return { exitCode: 0 };
    },
  });
  const kernel: RunnerInternalProcessKernel = Object.freeze({
    async launch() {
      active = true;
      return owned;
    },
    activeCount: () => active ? 1 : 0,
    async close() {
      if (active) await owned.closeVerified({ shutdownTimeoutMs: 1, terminationTimeoutMs: 1 });
    },
  });
  return {
    kernel,
    closeCalls: () => closeCalls,
    activeCount: () => active ? 1 : 0,
  };
}

function errorContains(error: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false;
  seen.add(error);
  if (error instanceof Error && error.message.includes(expected)) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((entry) => errorContains(entry, expected, seen));
  }
  return false;
}
