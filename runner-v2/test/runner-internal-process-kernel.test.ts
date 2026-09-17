import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  BackpressuredInteractiveProcessChannelProvider,
  BackpressuredOutputMetadata,
  InteractiveProcessChannel,
} from "../src/interactive-process-channel.js";
import type { ProcessBackend } from "../src/process-backend.js";
import { createRunnerInternalProcessKernel } from "../src/runner-internal-process-kernel.js";

test("internal owned-process cleanup retries a transient verified-empty failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-kernel-retry-"));
  const fixture = faultBackend({ verifyEmptyFailures: 1 });
  const kernelOptions = {
    stateDirectory: root,
    platform: process.platform,
    backend: fixture.backend,
  };
  const kernel = createRunnerInternalProcessKernel(kernelOptions);
  try {
    const owned = await kernel.launch(launchInput(root, "owned-retry"));
    owned.setOutputSink(() => undefined);
    await assert.rejects(
      owned.closeVerified({ shutdownTimeoutMs: 1, terminationTimeoutMs: 50 }),
      /transient verified-empty failure/,
    );
    assert.equal(kernel.activeCount(), 1);
    await owned.closeVerified({ shutdownTimeoutMs: 1, terminationTimeoutMs: 50 });
    assert.equal(kernel.activeCount(), 0);
    assert.equal(fixture.releaseCalls(), 1);
  } finally {
    await kernel.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("internal kernel close retries only ownership that failed transient cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-kernel-close-retry-"));
  const fixture = faultBackend({ verifyEmptyFailures: 1 });
  const kernelOptions = {
    stateDirectory: root,
    platform: process.platform,
    backend: fixture.backend,
  };
  const kernel = createRunnerInternalProcessKernel(kernelOptions);
  try {
    const owned = await kernel.launch(launchInput(root, "kernel-retry"));
    owned.setOutputSink(() => undefined);
    await assert.rejects(
      kernel.close(),
      (error: unknown) => errorContains(error, "transient verified-empty failure"),
    );
    assert.equal(kernel.activeCount(), 1);
    await kernel.close();
    assert.equal(kernel.activeCount(), 0);
    assert.equal(fixture.releaseCalls(), 1);
  } finally {
    await kernel.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("channel acquisition plus cleanup failure retains one kernel-owned retry authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-internal-kernel-acquire-"));
  const fixture = faultBackend({ acquireFailure: true, verifyEmptyFailures: 1 });
  const kernelOptions = {
    stateDirectory: root,
    platform: process.platform,
    backend: fixture.backend,
  };
  const kernel = createRunnerInternalProcessKernel(kernelOptions);
  try {
    await assert.rejects(
      kernel.launch(launchInput(root, "acquire-failure")),
      (error: unknown) => error instanceof AggregateError &&
        error.errors.some((entry) => String(entry).includes("injected channel acquisition failure")) &&
        error.errors.some((entry) => String(entry).includes("transient verified-empty failure")),
    );
    assert.equal(kernel.activeCount(), 1);
    await kernel.close();
    assert.equal(kernel.activeCount(), 0);
    assert.equal(fixture.releaseCalls(), 1);
  } finally {
    await kernel.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

type TestBackend = ProcessBackend & Readonly<{
  backpressuredChannelProvider(): BackpressuredInteractiveProcessChannelProvider;
}>;

function faultBackend(options: {
  readonly acquireFailure?: boolean;
  readonly verifyEmptyFailures?: number;
}) {
  let verifyEmptyFailures = options.verifyEmptyFailures ?? 0;
  let releases = 0;
  const channel: InteractiveProcessChannel & Readonly<{
    subscribeBackpressuredOutput(
      sink: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => Promise<BackpressuredOutputMetadata>,
    ): () => void;
  }> = {
    write: async () => ({ acknowledged: true }),
    closeInput: async () => ({ closed: true }),
    subscribePrivateOutput: () => () => undefined,
    gracefulStop: async () => ({ state: "exited" }),
    waitForTerminal: async () => ({ state: "exited", exitCode: 0 }),
    detach: async () => ({ detached: true }),
    subscribeBackpressuredOutput: () => () => undefined,
  };
  const backend: TestBackend = {
    probe: async () => ({
      attestationVersion: 1,
      backendId: "runner-internal-fault-backend",
      verified: true,
      platformLabel: "test",
      capabilities: {
        tree_termination: "enforced",
        crash_cleanup: "unavailable",
        verified_emptiness: "enforced",
        write_confinement: "unavailable",
      },
    }),
    launch: async () => ({
      opaqueIdentity: "fault-owned-process",
      birthFingerprint: {
        observedAt: "2026-09-01T00:00:00.000Z",
        discriminator: "fault-birth",
      },
      rootPid: 42,
      startedAt: "2026-09-01T00:00:00.000Z",
    }),
    observe: async () => ({ state: "exited", exitCode: 0 }),
    signal: async () => ({ state: "exited" }),
    verifyEmpty: async () => {
      if (verifyEmptyFailures > 0) {
        verifyEmptyFailures -= 1;
        throw new Error("transient verified-empty failure");
      }
      return { empty: true };
    },
    reconcile: async () => ({ state: "exited", exitCode: 0 }),
    release: async () => {
      releases += 1;
      return { released: true };
    },
    backpressuredChannelProvider() {
      return {
        version: 2,
        replayCapacityChunks: 4,
        replayCapacityBytes: 1_024,
        acquire: async () => {
          if (options.acquireFailure) throw new Error("injected channel acquisition failure");
          return channel;
        },
      };
    },
  };
  return { backend, releaseCalls: () => releases };
}

function launchInput(root: string, callId: string) {
  return {
    principalId: "runner-internal-test-principal",
    callId,
    runId: "runner-internal-test-run",
    kind: "command" as const,
    executable: process.execPath,
    arguments: ["-e", ""],
    workingDirectory: root,
    environment: {},
    access: [],
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
