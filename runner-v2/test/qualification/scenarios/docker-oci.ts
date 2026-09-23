import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "../../../src/agent-contracts.js";
import { ArtifactStore } from "../../../src/artifact-store.js";
import type { OpaqueExecutionGrant } from "../../../src/execution-grants.js";
import { createExecutionGrantAuthority } from "../../../src/execution-grants.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../../../src/execution-host.js";
import { createExecutionHostMcpTransportFactory } from "../../../src/execution-host-mcp-transport.js";
import type { ManagedProcessService } from "../../../src/managed-process.js";
import { McpManager } from "../../../src/mcp-tools.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../../src/native-build-factory.js";
import { createRunnerInternalExecutionContext } from "../../../src/runner-internal-execution-context.js";
import { createOciExecutionIsolationProvider } from "../../../src/oci-execution-isolation-provider.js";
import type { RunnerCapabilitiesConfig } from "../../../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../../../src/runner-capability-contract.js";
import { finalizeCertifiedFixture } from "../../support/certified-fixture-cleanup.js";
import {
  createQualificationFixtureRoot,
  deferQualificationFixtureRemoval,
  exitScenarioMain,
  skipQualificationScenario,
} from "../../support/qualification-harness.js";
import { isQualificationScenarioEntry } from "../../support/qualification-scenario-entry.js";

const execFileAsync = promisify(execFile);
const managedProviderId = "qual-managed-strict-oci";

function requireDocker(image: string): string {
  try {
    const docker = process.env.RUNNER_V2_TEST_DOCKER_CLI
      || (process.platform === "win32"
        ? execFileSync("where.exe", ["docker"], { encoding: "utf8" }).split(/\r?\n/)[0]
        : execFileSync("which", ["docker"], { encoding: "utf8" }).trim());
    if (!docker || !isAbsolute(docker)) throw new Error("docker CLI path unavailable");
    execFileSync(docker, ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    execFileSync(docker, ["image", "inspect", image], { stdio: "ignore" });
    return docker;
  } catch (error) {
    if (process.env.RUNNER_V2_REQUIRE_DOCKER === "1") {
      throw new Error(`Required Docker OCI qualification unavailable (need daemon + ${image}).`, { cause: error });
    }
    throw Object.assign(new Error(`SKIP docker unavailable for ${image}`), { code: "QUAL_SKIP_DOCKER" });
  }
}

async function runDockerRequiredGate(): Promise<void> {
  if (process.env.RUNNER_V2_REQUIRE_DOCKER !== "1") {
    skipQualificationScenario("docker-required-gate: RUNNER_V2_REQUIRE_DOCKER unset (hosted Linux gate)");
  }
  requireDocker("alpine:latest");
  requireDocker("node:24-slim");
}

async function runAlpineContainment(): Promise<void> {
  let docker: string;
  try { docker = requireDocker("alpine:latest"); }
  catch (error) {
    if ((error as { code?: string }).code === "QUAL_SKIP_DOCKER") skipQualificationScenario(String((error as Error).message));
    throw error;
  }
  const root = createQualificationFixtureRoot("oci-alpine");
  const workspace = join(root, "workspace");
  const state = join(root, "state");
  const external = join(root, "external");
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await mkdir(external); await mkdir(state);
  await writeFile(join(workspace, "scripts", "build.mjs"), "");
  await writeFile(join(external, "input.txt"), "fixture");
  const authority = createExecutionGrantAuthority({ clock: () => new Date("2026-08-28T10:00:00.000Z") });
  const binding = {
    runId: "run", sessionId: "session", actor: { role: "worker" as const, id: "worker" },
    toolName: "process.run", callId: "call", permissionProfile: "project" as const,
  };
  const grant = await authority.issue({
    ...binding, workspacePath: workspace,
    access: [{ path: workspace, mode: "write" }, { path: external, mode: "read" }],
    externalApproved: true, destructiveApproved: false, networkApproved: false,
  });
  const claims = authority.consume(grant, binding);
  const intent = {
    invocationId: "invocation", runId: "run", taskId: "task", sessionId: "session",
    kind: "command" as const, executable: "sh",
    arguments: ["-c", [
      "touch /runner/workspace/inside-write",
      "touch /runner/grants/0/outside-write >/dev/null 2>&1 || true",
      "ln -s /runner/grants/0 /runner/workspace/external-link",
      "touch /runner/workspace/external-link/symlink-write >/dev/null 2>&1 || true",
      "wget -q -T 2 -O /dev/null http://1.1.1.1 && touch /runner/workspace/network-available || true",
    ].join("; ")],
    workingDirectory: workspace,
    requiredLifecycleScope: "contained_workload" as const,
    requestedCapabilities: ["write_confinement" as const],
  };
  const provider = createOciExecutionIsolationProvider({
    providerId: "oci-qual-real", cliPath: docker, image: "alpine:latest", stateDirectory: state,
  });
  const tracked = new Set<string>();
  try {
    await provider.attest();
    await provider.acquire({
      providerId: "oci-qual-real", implementationDigest: "a".repeat(64), intent, grant: claims,
    });
    const leases = JSON.parse(readFileSync(join(state, "oci-leases-oci-qual-real.json"), "utf8")) as Array<{ containerId: string }>;
    const containerId = leases[0]?.containerId;
    assert.ok(containerId);
    tracked.add(containerId);
    const start = await execFileResult(docker, ["start", "--attach", containerId]);
    assert.equal(start.code, 0, start.stderr);
    assert.equal(existsSync(join(workspace, "inside-write")), true);
    assert.equal(existsSync(join(external, "outside-write")), false);
    assert.equal(existsSync(join(external, "symlink-write")), false);
    assert.equal(existsSync(join(workspace, "network-available")), false);
    const restarted = createOciExecutionIsolationProvider({
      providerId: "oci-qual-real", cliPath: docker, image: "alpine:latest", stateDirectory: state,
    });
    await restarted.attest();
    const recovery = await restarted.recoverOwned();
    assert.equal(recovery.cleaned, 1);
    tracked.delete(containerId);
    await restarted.acknowledgeRecovery(recovery.transitions ?? []);
  } finally {
    for (const id of tracked) await execFileResult(docker, ["rm", "--force", id]);
    deferQualificationFixtureRemoval(root);
  }
}

async function runManagedStrict(): Promise<void> {
  let docker: string;
  try { docker = requireDocker("node:24-slim"); }
  catch (error) {
    if ((error as { code?: string }).code === "QUAL_SKIP_DOCKER") skipQualificationScenario(String((error as Error).message));
    throw error;
  }
  const root = createQualificationFixtureRoot("managed-strict-oci");
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const config: RunnerCapabilitiesConfig = {
    extensions: [], languageServers: [],
    isolationProviders: [{ id: managedProviderId, type: "oci", cliPath: docker, image: "node:24-slim", allowNetwork: false }],
  };
  const host = createExecutionHost({
    projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
    ...(process.platform === "win32" ? {
      processHostFacts: {
        portableDuplex: "verified" as const, windowsBatchArgv: "verified" as const,
        exactTreeBirth: "verified" as const, jobContainment: "unavailable" as const,
      },
    } : {}),
  });
  let run: ExecutionHostRunBinding | undefined; let failed = false; let primary: unknown;
  try {
    run = await host.bindRun({
      runId: "managed-strict-run", permissionProfile: "project",
      capabilityContract: { digest: "8".repeat(64) } as RunnerCapabilityContract,
      capabilitiesConfig: config,
    });
    const service = run.managedProcesses;
    await assert.rejects(
      invoke(run, service, project, "process.start", "host-only",
        (context) => service.start({ command: process.execPath, args: ["-e", "console.log('must-not-run')"], cwd: "." }, context, project)),
      /isolation|image|executable|unavailable|represent/i,
    );
    assert.equal(ownedContainers(docker), "");
    const backendRoot = join(run.runRoot, "process-backend");
    assert.equal(existsSync(backendRoot) ? readdirSync(backendRoot).length : 0, 0);
    const started = await invoke(run, service, project, "process.start", "container-start",
      (context) => service.start({ command: "node", args: ["-e", "console.log('strict-managed-ready'); setInterval(()=>{},1000)"], cwd: "." }, context, project));
    assert.equal(started.status, "running");
    let observed = started;
    for (let attempt = 0; attempt < 100 && !observed.stdout.includes("strict-managed-ready"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      observed = await invoke(run, service, project, "process.poll", `container-poll-${attempt}`,
        (context) => service.poll(started.processId, context));
    }
    assert.match(observed.stdout, /strict-managed-ready/);
    const stopped = await invoke(run, service, project, "process.signal", "container-stop",
      (context) => service.signal(started.processId, "SIGTERM", context));
    assert.equal(stopped.status, "stopped");
    assert.equal(ownedContainers(docker), "");
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "qualification strict managed OCI", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => {
        const errors: unknown[] = [];
        for (const close of [() => run?.close(), () => host.close()]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "Strict managed cleanup remains unverified");
      },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); assert.equal(ownedContainers(docker), ""); },
      removeRoot: async () => { deferQualificationFixtureRemoval(root); },
    });
  }
}

async function runMcpContained(): Promise<void> {
  let docker: string;
  try { docker = requireDocker("node:24-slim"); }
  catch (error) {
    if ((error as { code?: string }).code === "QUAL_SKIP_DOCKER") skipQualificationScenario(String((error as Error).message));
    throw error;
  }
  const root = createQualificationFixtureRoot("docker-mcp-contained");
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const fixture = join(project, "mcp-descendant-server.mjs");
  await copyFile(fileURLToPath(new URL("../../fixtures/mcp-descendant-server.mjs", import.meta.url)), fixture);
  const providerId = `qm-${randomUUID().replaceAll("-", "")}`;
  const server = {
    name: "detached",
    command: `node "${fixture.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" --lazy --detached`,
    envelope: { paths: [{ path: project, mode: "read" as const }], network: false },
  };
  const config: RunnerCapabilitiesConfig = {
    extensions: [], languageServers: [],
    isolationProviders: [{ id: providerId, type: "oci", cliPath: docker, image: "node:24-slim", allowNetwork: false }],
  };
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const host = createExecutionHost({
    projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment,
    ...(process.platform === "win32" ? {
      processHostFacts: {
        portableDuplex: "verified" as const, windowsBatchArgv: "verified" as const,
        exactTreeBirth: "verified" as const, jobContainment: "unavailable" as const,
      },
    } : {}),
  });
  const internal = createRunnerInternalExecutionContext({
    projectDirectory: project, stateDirectory: state, processKernel: host.internalProcesses, ambientEnvironment,
  });
  let run: ExecutionHostRunBinding | undefined;
  let manager: McpManager | undefined;
  let primary: unknown;
  let failed = false;
  try {
    const attestation = await internal.attestConfiguredCapabilities({ mcpServers: [server], capabilitiesConfig: config });
    const launches = await internal.resolveMcpRuntimeLaunches({ servers: [server], attestation: attestation.mcp });
    run = await host.bindRun({
      runId: providerId, permissionProfile: "project",
      capabilityContract: { digest: "b".repeat(64) } as RunnerCapabilityContract,
      capabilitiesConfig: config,
    });
    const discoverer = internal.createMcpDiscoveryExecutor({
      runId: run.runId, servers: [server], attestation: attestation.mcp, requestTimeoutMs: 5_000,
    });
    let discovery;
    try { discovery = await discoverer.discover(); } finally { await discoverer.close(); }
    manager = new McpManager({
      runId: run.runId, discovery,
      reattest: () => internal.resolveMcpRuntimeLaunches({ servers: [server], attestation: attestation.mcp }),
      cwd: project, servers: [server], requestTimeoutMs: 30_000,
      transportFactory: createExecutionHostMcpTransportFactory({
        run, permissionProfile: "project", projectDirectory: project, launches,
      }),
    });
    await manager.start();
    const entry = manager.toolEntries().find((item) => item.tool.name === "probe");
    assert.ok(entry, "real contained MCP discovery must expose the probe tool");
    const actor = { role: "worker" as const, id: "qualification-worker" };
    const sessionId = "qualification-mcp-agent";
    const callId = "qualification-mcp-probe";
    const toolName = `mcp.${entry.client.spec.name}.probe`;
    const grant = await run.executionGrants.issue({
      runId: run.runId, sessionId, actor, callId, toolName, permissionProfile: "project", workspacePath: project,
      access: [{ path: project, mode: "read" }], networkApproved: false,
      destructiveApproved: false, externalApproved: false,
    });
    let result;
    try {
      result = await entry.client.call("probe", {}, {
        runId: run.runId, sessionId, actor, callId, toolName, workspacePath: project,
        executionGrant: grant as OpaqueExecutionGrant,
      });
    } finally {
      await run.executionGrants.revoke(grant, "completed");
    }
    const text = result.content?.[0]?.text;
    if (typeof text !== "string") assert.fail("Contained MCP probe did not return text content.");
    assert.match(text, /^tree-alive:\d+$/);
    assert.notEqual(ownedContainers(docker, providerId), "", "detached MCP workload must be inside the owned OCI boundary");
    await manager.close(); manager = undefined;
    assert.equal(ownedContainers(docker, providerId), "", "closing contained MCP must retire the whole OCI boundary");
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "qualification Docker MCP contained descendant", root,
      hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => {
        const failures: unknown[] = [];
        for (const close of [() => manager?.close(), () => run?.close(), () => internal.close(), () => host.close()]) {
          try { await close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Docker MCP exact cleanup remains unverified");
      },
      certify: async () => {
        assert.deepEqual(host.activeRunIds(), []);
        assert.equal(ownedContainers(docker, providerId), "");
      },
      removeRoot: async () => { deferQualificationFixtureRemoval(root); },
    });
  }
}

async function invoke<T>(
  run: ExecutionHostRunBinding, service: ManagedProcessService, workspacePath: string,
  toolName: "process.start" | "process.poll" | "process.signal", callId: string,
  perform: (context: ToolExecutionContext) => Promise<T>,
): Promise<T> {
  const actor = { role: "worker" as const, id: "worker" }, sessionId = "strict-agent";
  const grant = await run.executionGrants.issue({
    runId: run.runId, sessionId, actor, callId, toolName, permissionProfile: "project", workspacePath,
    access: [{ path: workspacePath, mode: toolName === "process.poll" ? "read" : "write" }],
    networkApproved: false, externalApproved: false, destructiveApproved: false,
  });
  try { return await perform({ runId: run.runId, sessionId, actor, callId, toolName, workspacePath, executionGrant: grant as OpaqueExecutionGrant }); }
  finally { await run.executionGrants.revoke(grant, "completed"); }
}

function ownedContainers(docker: string, providerId = managedProviderId): string {
  return execFileSync(docker, [
    "ps", "-aq",
    "--filter", "label=ai-board.runner-v2.owned=true",
    "--filter", `label=ai-board.runner-v2.provider=${providerId}`,
  ], { encoding: "utf8" }).trim();
}

async function execFileResult(executable: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(executable, [...args], { encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(error) };
  }
}

if (isQualificationScenarioEntry(import.meta.url)) {
  const name = process.env.RUNNER_V2_QUALIFICATION_SCENARIO ?? "";
  const runners: Record<string, () => Promise<void>> = {
    "docker-required-gate": runDockerRequiredGate,
    "oci-alpine-containment": runAlpineContainment,
    "managed-strict-oci": runManagedStrict,
    "docker-mcp-contained": runMcpContained,
  };
  await exitScenarioMain(async () => {
    const run = runners[name];
    if (!run) throw new Error(`Unknown docker scenario: ${name}`);
    await run();
  });
}
