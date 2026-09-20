import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactStore } from "../../src/artifact-store.js";
import { createExecutionHost } from "../../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../src/native-build-factory.js";
import type { ExecutionInvocationIntent } from "../../src/execution-safety-contracts.js";
import { emptyRunnerCapabilitiesConfig } from "../../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../../src/runner-capability-contract.js";
import { runnerRunStateSegment } from "../../src/run-state-identity.js";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "../../src/cleanup-timeouts.js";
import type { StreamingRuntimeOptions } from "../../src/streaming-process-session-runtime.js";
import type { SqliteStreamingSessionStoreOptions } from "../../src/streaming-session-store.js";
import { recoverAndCloseRealStreamingOwner } from "./real-streaming-crash-lifecycle.js";

const RUN_ID = "b3-crash-run";

/**
 * Test convenience around the production ExecutionHost graph. It supplies
 * fixture identities and inspection aliases only; it contains no process,
 * isolation, channel, recovery, output, or cleanup implementation.
 */
export async function createRealStreamingHarness(input: {
  readonly stateDirectory: string;
  readonly projectDirectory: string;
  readonly integrityKey: Uint8Array;
  readonly leaseReleaseMarker?: string;
  readonly childScript: string;
  readonly adoptionFault?: SqliteStreamingSessionStoreOptions["adoptionFault"];
  readonly createEvidenceSpool?: StreamingRuntimeOptions["output"]["createEvidenceSpool"];
  readonly deliver?: StreamingRuntimeOptions["output"]["deliver"];
}) {
  const runRoot = join(input.stateDirectory, "builds", runnerRunStateSegment(RUN_ID));
  const keyPath = join(runRoot, "streaming-sessions.key");
  await mkdir(runRoot, { recursive: true });
  try {
    await writeFile(keyPath, input.integrityKey, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(keyPath);
    if (!existing.equals(Buffer.from(input.integrityKey))) {
      throw new Error("Production streaming fixture integrity key changed.");
    }
  }
  const host = createExecutionHost({
    projectRoot: input.projectDirectory,
    stateDirectory: input.stateDirectory,
    artifacts: new ArtifactStore(join(input.stateDirectory, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
    ...(process.platform === "win32" ? {
      processHostFacts: {
        portableDuplex: "verified" as const,
        windowsBatchArgv: "verified" as const,
        exactTreeBirth: "verified" as const,
        jobContainment: "unavailable" as const,
      },
    } : {}),
    ...(input.adoptionFault ? { streamingStoreOptions: { adoptionFault: input.adoptionFault } } : {}),
    ...((input.createEvidenceSpool || input.deliver) ? {
      streamingOutput: {
        createEvidenceSpool: input.createEvidenceSpool ?? (() => ({
          write: async () => undefined,
          finalize: async () => ({ streams: [] }),
          cleanup: async () => undefined,
        })),
        deliver: input.deliver ?? (async () => {
          throw new Error("Family delivery is unauthorized in the B3 host fixture.");
        }),
      },
    } : {}),
  });
  const run = await host.bindRun({
    runId: RUN_ID,
    permissionProfile: "full",
    capabilityContract: { digest: "a".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  const binding = Object.freeze({
    runId: RUN_ID,
    sessionId: "b3-agent-session",
    actor: Object.freeze({ role: "worker" as const, id: "b3-worker" }),
    toolName: "process.start",
    callId: "b3-crash-call",
    permissionProfile: "full" as const,
  });
  const intent: ExecutionInvocationIntent = Object.freeze({
    invocationId: "b3-crash-launch",
    runId: RUN_ID,
    sessionId: "b3-agent-session",
    kind: "mcp_server",
    executable: process.execPath,
    arguments: Object.freeze([input.childScript]),
    workingDirectory: input.projectDirectory,
    requiredLifecycleScope: "process_group",
    requestedCapabilities: Object.freeze([]),
  });
  const kernel = Object.freeze({
    store: Object.freeze({
      readHostLaunch: run.streamingState.readHostLaunch,
      readBySession: run.streamingState.readSession,
      readOutputCheckpoint: run.streamingState.readOutputCheckpoint,
      close: () => undefined,
    }),
  });

  return Object.freeze({
    host,
    run,
    runRoot,
    backendStateDirectory: join(runRoot, "process-backend"),
    runtime: run.streamingRuntime,
    kernel,
    grants: run.executionGrants,
    binding,
    async cleanupOutstandingForTest() {
      await recoverAndCloseRealStreamingOwner(
        () => run.recover({ maxRecords: 1_024, timeoutMs: AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS }),
        () => host.close(),
      );
    },
    async crashOpen() {
      const grant = await run.executionGrants.issue({
        ...binding,
        workspacePath: input.projectDirectory,
        access: [{ path: input.projectDirectory, mode: "write" }],
        externalApproved: false,
        destructiveApproved: false,
        networkApproved: false,
      });
      return await run.openStreaming({
        sessionId: "b3-stream-session",
        launchId: "b3-crash-launch",
        grant,
        binding,
        intent,
        verifyHandshake: async () => "d".repeat(64),
        envelope: {
          access: [],
          credentialNames: [],
          networkApproved: false,
          externalApproved: false,
          destructiveApproved: false,
        },
      });
    },
  });
}
