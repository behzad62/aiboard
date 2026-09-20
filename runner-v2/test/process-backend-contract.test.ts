import assert from "node:assert/strict";
import test from "node:test";

import {
  adoptProcessBackendAfterRestart,
  createProcessBackendRegistration,
  createProcessBackendRegistry,
  parseProcessBackendProbe,
  parseProcessLaunchResult,
  parseProcessObservation,
  parseProcessSignalResult,
  parseProcessEmptyVerification,
  parseProcessReconciliation,
  parseProcessReleaseResult,
  selectProcessBackend,
  reattestProcessBackend,
  type ProcessBackend,
  type ProcessBackendRegistration,
} from "../src/process-backend.js";
import { createWindowsProcessBackend, WindowsJobObjectProcessBackend, type WindowsJobProcessService } from "../src/windows-process-backend.js";

const capabilities = {
  tree_termination: "enforced",
  crash_cleanup: "enforced",
  verified_emptiness: "enforced",
  write_confinement: "enforced",
} as const;
function backend(
  id = "fake",
  probe: unknown = {
    attestationVersion: 2,
    backendId: id,
    verified: true,
    platformLabel: "fixture",
    lifecycle: { scope: "contained_workload", termination: "enforced", emptiness: "enforced" },
    capabilities,
  },
): ProcessBackend {
  return {
    probe: async () => probe,
    launch: async () => ({
      opaqueIdentity: "opaque",
      birthFingerprint: {
        observedAt: "2026-01-01T00:00:00.000Z",
        discriminator: "birth",
      },
      rootPid: 7,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
    observe: async () => ({ state: "exited", exitCode: 0 }),
    signal: async () => ({ state: "exited" }),
    verifyEmpty: async () => ({ empty: true, proofArtifactId: "proof" }),
    reconcile: async () => ({ state: "exited", exitCode: 0 }),
    release: async () => ({ released: true }),
  };
}
const registration = (value = backend()): ProcessBackendRegistration =>
  createProcessBackendRegistration({
    stableAdapterId: "fake-adapter",
    backendId: "fake",
    codeDigest: "1".repeat(64),
    configDigest: "2".repeat(64),
    backend: value,
  });
const registry = (value = backend()): ProcessBackendRegistration[] => [
  registration(value),
];

test("Runner registry snapshot rejects structural forgeries and ignores array and implementation replacement", async () => {
  const original = backend();
  const entries = registry(original);
  const trusted = createProcessBackendRegistry(entries);
  entries[0] = registration(backend());
  original.probe = async () => ({
    attestationVersion: 2,
    backendId: "replacement",
    verified: true,
    platformLabel: "replacement",
    lifecycle: { scope: "contained_workload", termination: "enforced", emptiness: "enforced" },
    capabilities,
  });
  const selected = await selectProcessBackend(trusted, [], "process_group");
  assert.equal(selected.attestation.backendId, "fake");
  await assert.rejects(
    selectProcessBackend({} as never, [], "process_group"),
    /registry authority/i,
  );
});

test("fresh revalidation returns the exact immutable implementation snapshot used for effects", async () => {
  const source = backend();
  let releases = 0;
  source.release = async () => {
    releases += 1;
    return { released: true };
  };
  const trusted = createProcessBackendRegistry(registry(source));
  const selected = await selectProcessBackend(trusted, [], "process_group");
  source.release = async () => {
    throw new Error("replacement");
  };
  const binding = {
    registryId: selected.registryId,
    backendId: "fake",
    implementationGeneration: selected.implementationGeneration,
    implementationDigest: selected.implementationDigest,
    attestationVersion: selected.attestation.attestationVersion,
    attestationDigest: selected.attestationDigest,
  };
  const fresh = await reattestProcessBackend(trusted, binding);
  assert.deepEqual(
    await fresh.backend.release({} as never, {
      ownerId: "owner",
      fencingToken: 1,
    }),
    {
      released: true,
    },
  );
  assert.equal(releases, 1);
});

test("v2 backend selection enforces lifecycle scope without treating process groups as containment", async () => {
  const scoped = backend("fake", {
    attestationVersion: 2,
    backendId: "fake",
    verified: true,
    platformLabel: "fixture",
    lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" },
    capabilities,
  });
  const trusted = createProcessBackendRegistry(registry(scoped));
  const selected = await selectProcessBackend(trusted, [], "process_group" as never);
  assert.equal(selected.attestation.lifecycle.scope, "process_group");
  await assert.rejects(
    selectProcessBackend(trusted, [], "contained_workload" as never),
    /required semantic capabilities|lifecycle/i,
  );
});
test("selects by verified semantic capability and returns immutable registry-bound attestation digest", async () => {
  const selected = await selectProcessBackend(
    createProcessBackendRegistry(registry()),
    ["tree_termination"],
    "process_group",
  );
  assert.match(selected.registryId, /^registry-/);
  assert.match(selected.attestationDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(selected.attestation), true);
});

test("rejects duplicate registry identities and false or identity-conflicting attestations", async () => {
  assert.throws(
    () => createProcessBackendRegistry([...registry(), ...registry()]),
    /registry identity/i,
  );
  await assert.rejects(
    selectProcessBackend(
      createProcessBackendRegistry(
        registry(
          backend("fake", {
            attestationVersion: 1,
            backendId: "other",
            verified: true,
            platformLabel: "x",
            capabilities,
          }),
        ),
      ),
      [],
      "process_group",
    ),
    /verified process backend/i,
  );
  await assert.rejects(
    selectProcessBackend(
      createProcessBackendRegistry(
        registry(
          backend("fake", {
            attestationVersion: 1,
            backendId: "fake",
            verified: false,
            platformLabel: "x",
            capabilities,
          }),
        ),
      ),
      [],
      "process_group",
    ),
    /verified process backend/i,
  );
});

test("strictly snapshots every backend operation response and rejects unknown keys and wrong types", () => {
  assert.deepEqual(
    parseProcessLaunchResult({
      opaqueIdentity: "opaque",
      birthFingerprint: { observedAt: "x", discriminator: "birth" },
      rootPid: 9,
      startedAt: "x",
    }),
    {
      opaqueIdentity: "opaque",
      birthFingerprint: { observedAt: "x", discriminator: "birth" },
      rootPid: 9,
      startedAt: "x",
    },
  );
  assert.deepEqual(parseProcessObservation({ state: "exited", exitCode: 0 }), {
    state: "exited",
    exitCode: 0,
  });
  assert.deepEqual(parseProcessSignalResult({ state: "running" }), {
    state: "running",
  });
  assert.deepEqual(
    parseProcessEmptyVerification({ empty: true, proofArtifactId: "proof" }),
    { empty: true, proofArtifactId: "proof" },
  );
  assert.deepEqual(parseProcessReconciliation({ state: "identity_mismatch" }), {
    state: "identity_mismatch",
  });
  assert.deepEqual(parseProcessReleaseResult({ released: true }), {
    released: true,
  });
  const malformed: Array<[(value: unknown) => unknown, unknown]> = [
    [
      parseProcessLaunchResult,
      {
        opaqueIdentity: "o",
        birthFingerprint: { observedAt: "x", discriminator: "d" },
        startedAt: "x",
        extra: true,
      },
    ],
    [parseProcessObservation, { state: "exited", exitCode: "0" }],
    [parseProcessSignalResult, { state: "maybe" }],
    [parseProcessEmptyVerification, { empty: "false", detail: "not empty" }],
    [parseProcessReconciliation, { state: "exited", pid: 7 }],
    [parseProcessReleaseResult, { released: "yes" }],
  ];
  for (const [parse, value] of malformed)
    assert.throws(() => parse(value), /backend|invalid|unknown/i);
});

test("all backend parsers reject accessors and proxies without consulting them", () => {
  const parsers: Array<(value: unknown) => unknown> = [
    parseProcessBackendProbe,
    parseProcessLaunchResult,
    parseProcessObservation,
    parseProcessSignalResult,
    parseProcessEmptyVerification,
    parseProcessReconciliation,
    parseProcessReleaseResult,
  ];
  for (const parse of parsers) {
    let reads = 0;
    const accessor = Object.defineProperty({}, "state", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "exited";
      },
    });
    assert.throws(() => parse(accessor), /backend|invalid/i);
    assert.equal(reads, 0);
    assert.throws(
      () =>
        parse(
          new Proxy(
            {},
            {
              ownKeys: () => {
                throw new Error("trap");
              },
            },
          ),
        ),
      /backend|invalid/i,
    );
  }
});

test("fresh re-attestation must match registry identity, implementation, backend id, version, and digest", async () => {
  let probeValue: unknown = {
    attestationVersion: 2,
    backendId: "fake",
    verified: true,
    platformLabel: "fixture",
    lifecycle: { scope: "contained_workload", termination: "enforced", emptiness: "enforced" },
    capabilities,
  };
  const source = backend();
  source.probe = async () => probeValue;
  const trusted = createProcessBackendRegistry(registry(source));
  const selected = await selectProcessBackend(trusted, [], "process_group");
  const binding = {
    registryId: selected.registryId,
    backendId: selected.attestation.backendId,
    implementationGeneration: selected.implementationGeneration,
    implementationDigest: selected.implementationDigest,
    attestationVersion: selected.attestation.attestationVersion,
    attestationDigest: selected.attestationDigest,
  };
  await assert.doesNotReject(reattestProcessBackend(trusted, binding));
  probeValue = {
    attestationVersion: 2,
    backendId: "fake",
    verified: true,
    platformLabel: "changed",
    lifecycle: { scope: "contained_workload", termination: "enforced", emptiness: "enforced" },
    capabilities,
  };
  await assert.rejects(
    reattestProcessBackend(trusted, binding),
    /attestation mismatch/i,
  );
});

test("normal reattestation rejects copied identity while explicit trusted restart adoption selects the new exact instance", async () => {
  const first = createProcessBackendRegistry(registry(backend()));
  const selected = await selectProcessBackend(first, [], "process_group");
  const binding = {
    registryId: selected.registryId,
    backendId: selected.attestation.backendId,
    implementationGeneration: selected.implementationGeneration,
    implementationDigest: selected.implementationDigest,
    attestationVersion: selected.attestation.attestationVersion,
    attestationDigest: selected.attestationDigest,
  };
  const replacement = backend();
  const second = createProcessBackendRegistry(registry(replacement));
  await assert.rejects(
    reattestProcessBackend(second, binding),
    /attestation mismatch/i,
  );
  const adopted = await adoptProcessBackendAfterRestart(second, binding);
  assert.notEqual(
    adopted.implementationGeneration,
    selected.implementationGeneration,
  );
  assert.deepEqual(
    await adopted.backend.release({} as never, {
      ownerId: "owner",
      fencingToken: 1,
    }),
    {
      released: true,
    },
  );
  assert.throws(
    () =>
      createProcessBackendRegistry([
        { kind: "runner-process-backend-registration" },
      ] as never),
    /registration authority/i,
  );
});

test("portable Windows baseline is available without Job Objects but strict guarantees require the Job enhancement", async () => {
  const baseline = createWindowsProcessBackend({ jobObjects: "unavailable", semanticFacts: { portableDuplex: "verified", exactTreeBirth: "verified", windowsBatchArgv: "verified", jobContainment: "unavailable" } });
  const job = new WindowsJobObjectProcessBackend(jobService(true));
  const trusted = createProcessBackendRegistry([
    createProcessBackendRegistration({
      stableAdapterId: "windows-portable",
      backendId: "runner-windows-supervisor-v1",
      codeDigest: "3".repeat(64),
      configDigest: "4".repeat(64),
      backend: baseline,
    }),
    createProcessBackendRegistration({
      stableAdapterId: "windows-job",
      backendId: "runner-windows-job-v1",
      codeDigest: "5".repeat(64),
      configDigest: "6".repeat(64),
      backend: job,
    }),
  ]);
  assert.equal((await selectProcessBackend(trusted, [], "process_group")).attestation.backendId, "runner-windows-supervisor-v1");
  assert.equal((await selectProcessBackend(trusted, ["crash_cleanup"], "contained_workload")).attestation.backendId, "runner-windows-job-v1");
  const baselineOnly = createProcessBackendRegistry([
    createProcessBackendRegistration({
      stableAdapterId: "windows-portable-only",
      backendId: "runner-windows-supervisor-v1",
      codeDigest: "7".repeat(64),
      configDigest: "8".repeat(64),
      backend: baseline,
    }),
  ]);
  await assert.rejects(selectProcessBackend(baselineOnly, [], "contained_workload"), /required semantic capabilities/i);
  const unavailableJob = createProcessBackendRegistry([
    createProcessBackendRegistration({
      stableAdapterId: "windows-job-unavailable",
      backendId: "runner-windows-job-v1",
      codeDigest: "9".repeat(64),
      configDigest: "a".repeat(64),
      backend: new WindowsJobObjectProcessBackend(jobService(false)),
    }),
  ]);
  await assert.rejects(selectProcessBackend(unavailableJob, ["crash_cleanup"], "contained_workload"), /required semantic capabilities/i);
});

function jobService(available: boolean): WindowsJobProcessService {
  const unavailable = async (): Promise<never> => { throw new Error("fixture operation is unavailable"); };
  return {
    probeActiveJobCreateClose: async () => available,
    launchOwned: unavailable,
    signalOwned: unavailable,
    reconcileOwned: unavailable,
    releaseOwned: unavailable,
    readOwnedOutput: () => { throw new Error("fixture operation is unavailable"); },
  };
}
