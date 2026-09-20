import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionHostMcpTransportFactory } from "../src/execution-host-mcp-transport.js";
import type { ExecutionHostRunBinding } from "../src/execution-host.js";
import { mcpConfigurationDigest } from "../src/mcp-configuration.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";

for (const label of ["absent", "foreign-run", "missing-grant"] as const) test(`MCP transport refuses ${label} actual-call authority before grants or launch`, async () => {
  const server = { name: "docs", command: `"${process.execPath}"` };
  let issued = 0; let launched = 0;
  const run = { runId: "actual-run", executionGrants: { issue: async () => { issued++; throw new Error("must not mint transport authority"); } },
    openStreaming: async () => { launched++; throw new Error("must not launch"); } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostMcpTransportFactory({ run, projectDirectory: process.cwd(), permissionProfile: "full",
    launches: [{ ...server, executablePath: process.execPath, arguments: [], configDigest: mcpConfigurationDigest(server), executableDigest: "a".repeat(64), envelope: { paths: [], network: false, credentialNames: [] } }] });
  await assert.rejects(factory.open({ server, handshake: async () => "a".repeat(64), onOutput: () => undefined, onFailure: () => undefined,
    ...(label === "absent" ? {} : { owner: { context: { runId: label === "foreign-run" ? "foreign" : run.runId, sessionId: "agent", actor: { role: "worker" as const, id: "worker" }, callId: "actual-call", toolName: "mcp.docs.lookup" },
      envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } } })
  }), /authority|grant|context|run/i);
  assert.equal(issued, 0); assert.equal(launched, 0);
});


test("MCP transport requests explicit process-group lifecycle without requiring the optional Windows Job enhancement", async () => {
  const server = { name: "docs", command: `"${process.execPath}"` };
  const configDigest = mcpConfigurationDigest(server); const executableDigest = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
  let observed = false;
  const stop = new Error("controlled before-runtime invocation boundary");
  const run = { runId: "actual-run", openStreaming: async (request: { intent: { requiredLifecycleScope: string; requestedCapabilities: readonly string[] } }) => {
    assert.equal(request.intent.requiredLifecycleScope, "process_group");
    assert.deepEqual(request.intent.requestedCapabilities, []);
    observed = true; throw stop;
  } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostMcpTransportFactory({ run, projectDirectory: process.cwd(), permissionProfile: "full",
    launches: [{ ...server, executablePath: process.execPath, arguments: [], configDigest, executableDigest, envelope: { paths: [], network: false, credentialNames: [] } }] });
  await assert.rejects(factory.open({ server, expected: { name: "docs", configDigest, executableDigest, tools: [], status: "ready", cleanupVerified: true },
    owner: { context: { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "call", toolName: "mcp.docs.lookup", executionGrant: {} as OpaqueExecutionGrant },
      envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } },
    handshake: async () => assert.fail("no backend is being launched"), onOutput: () => undefined, onFailure: () => undefined }),
    (error: unknown) => error === stop);
  assert.equal(observed, true);
});

test("MCP production resolve descriptor with lifecycle requirements requests contained_workload under full", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-lifecycle-resolve-"));
  const kernel = {
    launch: async () => assert.fail("static attestation must never spawn"),
    close: async () => undefined,
    activeCount: () => 0,
  } as never;
  const context = createRunnerInternalExecutionContext({
    projectDirectory: root,
    stateDirectory: join(root, "state"),
    processKernel: kernel,
    ambientEnvironment: {},
  });
  try {
    const server = {
      name: "docs",
      command: `"${process.execPath}"`,
      lifecycleRequirements: { requireCompleteCleanup: true as const },
    };
    const attested = await context.attestConfiguredCapabilities({
      mcpServers: [server],
      capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    });
    const launches = await context.resolveMcpRuntimeLaunches({
      servers: [server],
      attestation: attested.mcp,
    });
    let observed: string | undefined;
    const stop = new Error("controlled production mcp lifecycle boundary");
    const run = {
      runId: "actual-run",
      openStreaming: async (request: { intent: { requiredLifecycleScope: string } }) => {
        observed = request.intent.requiredLifecycleScope;
        throw stop;
      },
    } as unknown as ExecutionHostRunBinding;
    const factory = createExecutionHostMcpTransportFactory({
      run,
      projectDirectory: process.cwd(),
      permissionProfile: "full",
      launches,
    });
    await assert.rejects(factory.open({
      server,
      expected: {
        name: "docs",
        configDigest: launches[0]!.configDigest,
        executableDigest: launches[0]!.executableDigest,
        tools: [],
        status: "ready",
        cleanupVerified: true,
      },
      owner: {
        context: {
          runId: run.runId,
          sessionId: "agent",
          actor: { role: "worker", id: "worker" },
          callId: "call",
          toolName: "mcp.docs.lookup",
          executionGrant: {} as OpaqueExecutionGrant,
        },
        envelope: {
          access: [],
          credentialNames: [],
          networkApproved: false,
          externalApproved: false,
          destructiveApproved: false,
        },
      },
      handshake: async () => assert.fail("no backend is being launched"),
      onOutput: () => undefined,
      onFailure: () => undefined,
    }), (error: unknown) => error === stop);
    assert.equal(observed, "contained_workload");
  } finally {
    await context.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const flag of ["requireCompleteCleanup", "knownUnavoidableDetachment"] as const) {
  test(`MCP trusted launch descriptor with ${flag} requests contained_workload`, async () => {
    const server = { name: "docs", command: `"${process.execPath}"` };
    const configDigest = mcpConfigurationDigest(server);
    const executableDigest = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const { lifecycleRequirementsDigest } = await import("../src/execution-lifecycle-policy.js");
    const lifecycleRequirements = { [flag]: true as const };
    let observed: string | undefined;
    const stop = new Error("controlled mcp lifecycle boundary");
    const run = { runId: "actual-run", openStreaming: async (request: { intent: { requiredLifecycleScope: string } }) => {
      observed = request.intent.requiredLifecycleScope; throw stop;
    } } as unknown as ExecutionHostRunBinding;
    const factory = createExecutionHostMcpTransportFactory({ run, projectDirectory: process.cwd(), permissionProfile: "full",
      launches: [{
        ...server, executablePath: process.execPath, arguments: [], configDigest, executableDigest,
        envelope: { paths: [], network: false, credentialNames: [] },
        lifecycleRequirements,
        lifecycleRequirementsDigest: lifecycleRequirementsDigest(lifecycleRequirements),
      }] });
    await assert.rejects(factory.open({ server, expected: { name: "docs", configDigest, executableDigest, tools: [], status: "ready", cleanupVerified: true },
      owner: { context: { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "call", toolName: "mcp.docs.lookup", executionGrant: {} as OpaqueExecutionGrant },
        envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } },
      handshake: async () => assert.fail("no backend is being launched"), onOutput: () => undefined, onFailure: () => undefined }),
      (error: unknown) => error === stop);
    assert.equal(observed, "contained_workload");
  });

  test(`MCP refuses stale launch descriptor when ${flag} identity digest drifts`, async () => {
    const server = { name: "docs", command: `"${process.execPath}"` };
    const configDigest = mcpConfigurationDigest(server);
    const executableDigest = createHash("sha256").update(await readFile(process.execPath)).digest("hex");
    const { lifecycleRequirementsDigest } = await import("../src/execution-lifecycle-policy.js");
    let launched = 0;
    const run = { runId: "actual-run", openStreaming: async () => { launched++; throw new Error("must not launch"); } } as unknown as ExecutionHostRunBinding;
    const factory = createExecutionHostMcpTransportFactory({ run, projectDirectory: process.cwd(), permissionProfile: "full",
      launches: [{
        ...server, executablePath: process.execPath, arguments: [], configDigest, executableDigest,
        envelope: { paths: [], network: false, credentialNames: [] },
        lifecycleRequirements: { [flag]: true },
        lifecycleRequirementsDigest: lifecycleRequirementsDigest(undefined),
      }] });
    await assert.rejects(factory.open({ server, expected: { name: "docs", configDigest, executableDigest, tools: [], status: "ready", cleanupVerified: true },
      owner: { context: { runId: run.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "call", toolName: "mcp.docs.lookup", executionGrant: {} as OpaqueExecutionGrant },
        envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } },
      handshake: async () => assert.fail("no backend is being launched"), onOutput: () => undefined, onFailure: () => undefined }),
      /attestation|lifecycle|digest|identity/i);
    assert.equal(launched, 0);
  });
}