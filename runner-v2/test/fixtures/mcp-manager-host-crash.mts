import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ArtifactStore } from "../../src/artifact-store.js";
import { createExecutionHost } from "../../src/execution-host.js";
import { createExecutionHostMcpTransportFactory } from "../../src/execution-host-mcp-transport.js";
import { McpManager } from "../../src/mcp-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../../src/runner-capability-contract.js";
import { createRunnerInternalExecutionContext } from "../../src/runner-internal-execution-context.js";

const [stateDirectory, projectDirectory, readyMarker, serverMarker, descendantMarker] =
  process.argv.slice(2);
if (!stateDirectory || !projectDirectory || !readyMarker || !serverMarker || !descendantMarker) {
  throw new Error("MCP manager crash fixture arguments are missing.");
}

const runId = "mcp-manager-crash-recovery";
const capabilities = emptyRunnerCapabilitiesConfig();
const serverFixture = fileURLToPath(new URL("./mcp-descendant-server.mjs", import.meta.url));
const servers = [{
  name: "tree",
  command: [process.execPath, serverFixture, descendantMarker, serverMarker]
    .map(quoteConfiguredArgument)
    .join(" "),
}];
const host = createExecutionHost({
  projectRoot: projectDirectory,
  stateDirectory,
  artifacts: new ArtifactStore(join(stateDirectory, "artifacts")),
  ...(process.platform === "win32" ? {
    processHostFacts: {
      portableDuplex: "verified" as const,
      windowsBatchArgv: "verified" as const,
      exactTreeBirth: "verified" as const,
      jobContainment: "unavailable" as const,
    },
  } : {}),
});
const internal = createRunnerInternalExecutionContext({
  projectDirectory,
  stateDirectory,
  processKernel: host.internalProcesses,
});
const attestation = await internal.attestConfiguredCapabilities({
  mcpServers: servers,
  capabilitiesConfig: capabilities,
});
const launches = await internal.resolveMcpRuntimeLaunches({
  servers,
  attestation: attestation.mcp,
});
const run = await host.bindRun({
  runId,
  permissionProfile: "full",
  capabilityContract: { digest: "a".repeat(64) } as RunnerCapabilityContract,
  capabilitiesConfig: capabilities,
});
await run.recover({ maxRecords: 1_024, timeoutMs: 30_000 });
const manager = new McpManager({
  cwd: projectDirectory,
  servers,
  transportFactory: createExecutionHostMcpTransportFactory({
    run,
    permissionProfile: "full",
    projectDirectory,
    launches,
  }),
});
await manager.start();
if (manager.status()[0]?.status !== "ready") {
  throw new Error(`MCP manager crash fixture did not become ready: ${JSON.stringify(manager.status())}`);
}
writeFileSync(readyMarker, JSON.stringify({ pid: process.pid }), { flag: "wx" });
process.exit(86);

function quoteConfiguredArgument(value: string): string {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}
