import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createChildEnvironmentFactory } from "../../src/child-environment.js";
import {
  createProcessBackendRegistration,
  createProcessBackendRegistry,
  type ProcessBackend,
} from "../../src/process-backend.js";
import { createSubprocessRuntimeKernel } from "../../src/subprocess-runtime.js";

const [root, name] = process.argv.slice(2);
if (!root || !name) throw new Error("fixture args");
const capabilities = {
  tree_termination: "enforced",
  crash_cleanup: "enforced",
  verified_emptiness: "enforced",
  write_confinement: "enforced",
} as const;
const backend: ProcessBackend = {
  probe: async () => ({
    attestationVersion: 2,
    backendId: "fake",
    verified: true,
    platformLabel: "fixture",
    lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" },
    capabilities,
  }),
  launch: async () => {
    for (let i = 0; i < 500; i += 1) {
      try {
        await Promise.all([
          access(join(root, "a.ready")),
          access(join(root, "b.ready")),
        ]);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    return {
      opaqueIdentity: "opaque",
      birthFingerprint: {
        observedAt: "2026-01-01T00:00:00.000Z",
        discriminator: "birth",
      },
      startedAt: "2026-01-01T00:00:00.000Z",
    };
  },
  observe: async () => ({ state: "exited", exitCode: 0 }),
  signal: async () => ({ state: "exited" }),
  verifyEmpty: async () => ({ empty: true }),
  reconcile: async () => ({ state: "exited", exitCode: 0 }),
  release: async () => ({ released: true }),
};
const registry = createProcessBackendRegistry([
  createProcessBackendRegistration({
    stableAdapterId: "fake-adapter",
    backendId: "fake",
    codeDigest: "1".repeat(64),
    configDigest: "2".repeat(64),
    backend,
  }),
]);
let prepares = 0;
const outputs = {
  prepare: async (ownerId: string) => {
    prepares += 1;
    return session(ownerId);
  },
  reopen: async (ownerId: string) => session(ownerId),
};
function session(ownerId: string) {
  return {
    ownerId,
    write: async () => undefined,
    finalize: async () => ({
      streams: [
        {
          stream: "stdout" as const,
          tail: "",
          tailBytesBase64: "",
          tailByteLength: 0,
          tailDisplayTruncated: false,
          totalBytes: 0,
          truncated: false,
          spillBytes: 0,
          lossyBytes: 0,
          lossyOutput: false,
          lossReasons: [],
          spillState: "empty" as const,
        },
        {
          stream: "stderr" as const,
          tail: "",
          tailBytesBase64: "",
          tailByteLength: 0,
          tailDisplayTruncated: false,
          totalBytes: 0,
          truncated: false,
          spillBytes: 0,
          lossyBytes: 0,
          lossyOutput: false,
          lossReasons: [],
          spillState: "empty" as const,
        },
      ],
    }),
    cleanup: async () => undefined,
  };
}
const clock = {
  now: () => new Date(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
const environments = createChildEnvironmentFactory({
  credentialResolver: {
    consume: () => {
      throw new Error("unused");
    },
  },
  now: clock.now,
});
const kernel = createSubprocessRuntimeKernel({
  registry,
  state: { kind: "sqlite", path: join(root, "state.sqlite") },
  stateKey: new Uint8Array(32).fill(7),
  clock,
  environments,
  outputs,
  createLogicalProcessId: () => "proc-shared",
});
kernel.grantsController.issue({
  grantId: "grant-shared",
  runId: "run",
  invocationId: "shared",
  issuedAt: "2020-01-01T00:00:00.000Z",
  access: [],
});
await writeFile(join(root, `${name}.ready`), "ready");
const result = await kernel.runtime.invoke({
  intent: {
    runId: "run",
    invocationId: "shared",
    kind: "command",
    executable: "tool",
    arguments: [],
    workingDirectory: "C:\\safe",
    requiredLifecycleScope: "process_group",
    requestedCapabilities: [],
  },
  grantId: "grant-shared",
  ambientEnvironment: {},
});
const grantRemained = kernel.grantsController.revoke("grant-shared");
await writeFile(
  join(root, `${name}.json`),
  JSON.stringify({ outcome: result.outcome, prepares, grantRemained }),
);
kernel.readOnlyStore.close();
