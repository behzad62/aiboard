import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import type { OneShotCommandResult } from "../src/one-shot-command-executor.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { createRunnerInternalExecutionContext, type McpDiscoveryResult, type RunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";

for (const mode of ["run", "internal-discovery"] as const) {
test(`real ExecutionHost ${mode} excludes ungranted credentials from child environment and exact supervisor argv`, { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-credential-graph-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  await mkdir(state);
  const ready = join(project, "ready.json");
  const release = join(project, "release");
  // Never introduce real account credentials into this fixture, including RED runs.
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && /^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(name)));
  const prefix = "SYNTHETIC_GRAPH_CREDENTIAL_";
  const ambientEnvironment = {
      ...ambient, GRAPH_SAFE_VALUE: "retained",
      OPENAI_API_KEY: `${prefix}OPENAI`,
      ANTHROPIC_FOUNDRY_API_KEY: `${prefix}FOUNDRY`,
      AZURE_OPENAI_API_KEY: `${prefix}AZURE`,
      SERVICE_PRIVATE_KEY: `${prefix}PRIVATE`,
    };
  const host = createExecutionHost({
    projectRoot: project, stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment,
    ...(process.platform === "win32" ? {processHostFacts: {
      portableDuplex: "verified" as const, windowsBatchArgv: "verified" as const,
      exactTreeBirth: "verified" as const, jobContainment: "unavailable" as const,
    }} : {}),
  });
  let command: Promise<OneShotCommandResult | McpDiscoveryResult> | undefined;
  let internal: RunnerInternalExecutionContext | undefined;
  let primaryFailure: unknown;
  let childPid = 0;
  let supervisorPid = 0;
  try {
    const runId = "credential-graph";
    let backendRoot: string;
    if (mode === "run") {
    const run = await host.bindRun({
      runId, permissionProfile: "full",
      capabilityContract: {digest: "c".repeat(64)} as RunnerCapabilityContract,
      capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    });
    const binding = {
      runId, sessionId: "credential-session", callId: "credential-call",
      actor: {role: "worker" as const, id: "credential-worker"},
      toolName: "process.run", permissionProfile: "full" as const,
    };
    const grant = await run.executionGrants.issue({
      ...binding, workspacePath: project, access: [{path: project, mode: "write"}],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    command = run.commandExecution.execute({
      executable: process.execPath,
      arguments: [fileURLToPath(new URL("./fixtures/credential-graph-child.mjs", import.meta.url)), ready, release],
      workingDirectory: project, timeoutMs: 60_000,
      context: {...binding, executionGrant: grant},
    });
    backendRoot = join(run.runRoot, "process-backend");
    } else {
      internal = createRunnerInternalExecutionContext({
        projectDirectory: project, stateDirectory: state, ambientEnvironment,
        processKernel: host.internalProcesses,
      });
      const args = [process.execPath, fileURLToPath(new URL("./fixtures/credential-graph-child.mjs", import.meta.url)), ready, release, "mcp"];
      const servers = [{name: "credential-fixture", command: args.map(quoteArgument).join(" ")}];
      const attestation = await internal.attestConfiguredCapabilities({mcpServers: servers, capabilitiesConfig: emptyRunnerCapabilitiesConfig()});
      command = internal.createMcpDiscoveryExecutor({runId, servers, attestation: attestation.mcp,
        requestTimeoutMs: 60_000, shutdownTimeoutMs: 15_000, terminationTimeoutMs: 15_000}).discover();
      backendRoot = join(state, "internal-processes");
    }
    void command.catch(() => undefined);
    await waitFor(() => existsSync(ready));
    const child = JSON.parse(readFileSync(ready, "utf8"));
    childPid = child.pid;
    const owners = readdirSync(backendRoot).flatMap((directory) => {
      const path = join(backendRoot, directory, "state.json");
      return existsSync(path) ? [{directory: join(backendRoot, directory), state: JSON.parse(readFileSync(path, "utf8"))}] : [];
    });
    assert.equal(owners.length, 1, "fixture must have exactly one owned supervisor");
    const owner = owners[0]!;
    supervisorPid = owner.state.supervisorPid;
    assert.ok(Number.isSafeInteger(supervisorPid) && supervisorPid > 0);
    await waitFor(() => JSON.parse(readFileSync(join(owner.directory, "state.json"), "utf8"))
      .knownProcesses.some((entry: {pid: number}) => entry.pid === childPid));
    // Inspect only this exact durable owner's argv. Never print raw argv or env.
    const argv = supervisorArguments(supervisorPid);
    const configurations = [...argv.matchAll(/[A-Za-z0-9_-]{80,}/g)].flatMap(([encoded]) => {
      try {
        const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
        return value.nonce === owner.state.nonce && resolve(value.directory) === resolve(owner.directory) ? [value] : [];
      } catch { return []; }
    });
    assert.equal(configurations.length, 1, "live argv must match exact durable nonce and directory");
    const config = configurations[0]!;
    assert.deepEqual({
      supervisorMetadataContainsCredential: JSON.stringify(config).includes(prefix),
      rawSupervisorArgvContainsCredential: argv.includes(prefix),
      childEnvironmentContainsCredential: child.credentialPresent,
      childArgvContainsCredential: child.argvCredentialPresent,
    }, {
      supervisorMetadataContainsCredential: false,
      rawSupervisorArgvContainsCredential: false,
      childEnvironmentContainsCredential: false,
      childArgvContainsCredential: false,
    }, "ungranted synthetic credentials must be absent throughout the actual launch graph");
    assert.equal(child.safeValue, "retained");
    assert.equal(config.environment.GRAPH_SAFE_VALUE, "retained");
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try { await writeFile(release, "release"); } catch (error) { cleanupErrors.push(error); }
    try {
      const result = await command;
      if (result && "process" in result) {
        assert.equal(result.process.outcome, "exited");
        assert.equal(result.process.exitCode, 0);
        assert.equal(result.process.cleanup.state, "verified_empty");
      } else if (result) {
        assert.equal(result.servers[0]?.status, "ready");
        assert.equal(result.servers[0]?.cleanupVerified, true);
      }
    } catch (error) { cleanupErrors.push(error); }
    try { await internal?.close(); } catch (error) { cleanupErrors.push(error); }
    try { await host.close(); } catch (error) { cleanupErrors.push(error); }
    try {
      await waitFor(() => !alive(childPid) && !alive(supervisorPid));
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) {
      throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors,
        `Credential graph cleanup failed; exact evidence preserved at ${root}.`);
    }
    await rm(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 100});
  }
  if (primaryFailure) throw primaryFailure;
});
}

function quoteArgument(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

function supervisorArguments(pid: number): string {
  try {
    if (process.platform === "win32") {
      return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine | ConvertTo-Json -Compress`],
      {encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024}));
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1024 * 1024});
  } catch {
    // Child-process/JSON exceptions may embed raw captured argv; never forward them.
    throw new Error("Exact supervisor metadata inspection unavailable.");
  }
}

function alive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Credential graph fixture readiness/cleanup deadline exceeded.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
