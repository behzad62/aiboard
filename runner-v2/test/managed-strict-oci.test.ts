import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import type { RunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const providerId = "managed-strict-oci";

test("strict managed execution refuses host-only identity before backend create and runs bare node only inside its attested OCI image", { timeout: 180_000 }, async (t) => {
  const docker = availableDocker();
  if (!docker) return t.skip("Docker with cached node:24-slim is unavailable; no pull or weakening attempted.");
  const root = await mkdtemp(join(tmpdir(), "p684-managed-strict-")); t.diagnostic(`exact strict managed root acquired: ${root}`);
  const project = join(root, "project"), state = join(root, "state"); await mkdir(project); await mkdir(state);
  const config: RunnerCapabilitiesConfig = { extensions: [], languageServers: [], isolationProviders: [{ id: providerId, type: "oci", cliPath: docker, image: "node:24-slim", allowNetwork: false }] };
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")),
    ...(process.platform === "win32" ? { processHostFacts: { portableDuplex: "verified" as const, windowsBatchArgv: "verified" as const, exactTreeBirth: "verified" as const, jobContainment: "unavailable" as const } } : {}) });
  let run: ExecutionHostRunBinding | undefined; let failed = false; let primary: unknown;
  try {
    run = await host.bindRun({ runId: "managed-strict-run", permissionProfile: "project", capabilityContract: { digest: "8".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: config });
    const service = run.managedProcesses;
    await assert.rejects(invoke(run, service, project, "process.start", "host-only", context => service.start({ command: process.execPath, args: ["-e", "console.log('must-not-run')"], cwd: "." }, context, project)), /isolation|image|executable|unavailable|represent/i);
    assert.equal(ownedContainers(docker), "", "host-only refusal must not leave an OCI container");
    const backendRoot = join(run.runRoot, "process-backend");
    assert.equal(existsSync(backendRoot) ? readdirSync(backendRoot).length : 0, 0, "host-only strict refusal occurs before backend process creation");

    const started = await invoke(run, service, project, "process.start", "container-start", context => service.start({ command: "node", args: ["-e", "console.log('strict-managed-ready'); setInterval(()=>{},1000)"], cwd: "." }, context, project));
    assert.equal(started.status, "running");
    let observed = started;
    for (let attempt = 0; attempt < 100 && !observed.stdout.includes("strict-managed-ready"); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      observed = await invoke(run, service, project, "process.poll", `container-poll-${attempt}`, context => service.poll(started.processId, context));
    }
    assert.match(observed.stdout, /strict-managed-ready/);
    const stopped = await invoke(run, service, project, "process.signal", "container-stop", context => service.signal(started.processId, "SIGTERM", context));
    assert.equal(stopped.status, "stopped");
    assert.equal(ownedContainers(docker), "", "exact strict managed stop releases its configured container");
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "Task 8.4 strict managed OCI", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "Strict managed cleanup remains unverified"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); assert.equal(ownedContainers(docker), ""); },
      removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`verified strict managed root removed: ${root}`); } });
  }
});

async function invoke<T>(run: ExecutionHostRunBinding, service: ManagedProcessService, workspacePath: string, toolName: "process.start" | "process.poll" | "process.signal", callId: string,
  perform: (context: ToolExecutionContext) => Promise<T>): Promise<T> {
  const actor = { role: "worker" as const, id: "worker" }, sessionId = "strict-agent";
  const grant = await run.executionGrants.issue({ runId: run.runId, sessionId, actor, callId, toolName, permissionProfile: "project", workspacePath,
    access: [{ path: workspacePath, mode: toolName === "process.poll" ? "read" : "write" }], networkApproved: false, externalApproved: false, destructiveApproved: false });
  try { return await perform({ runId: run.runId, sessionId, actor, callId, toolName, workspacePath, executionGrant: grant as OpaqueExecutionGrant }); }
  finally { await run.executionGrants.revoke(grant, "completed"); }
}

function availableDocker(): string | undefined {
  try {
    const docker = process.env.RUNNER_V2_TEST_DOCKER_CLI || (process.platform === "win32" ? execFileSync("where.exe", ["docker"], { encoding: "utf8" }).split(/\r?\n/)[0] : execFileSync("which", ["docker"], { encoding: "utf8" }).trim());
    if (!docker || !isAbsolute(docker)) return undefined;
    execFileSync(docker, ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    execFileSync(docker, ["image", "inspect", "node:24-slim"], { stdio: "ignore" });
    return docker;
  } catch { return undefined; }
}
function ownedContainers(docker: string): string {
  return execFileSync(docker, ["ps", "-aq", "--filter", `label=ai-board.runner-v2.provider=${providerId}`], { encoding: "utf8" }).trim();
}