import assert from "node:assert/strict";
import test from "node:test";

import { parseProcessBackendProbe, parseProcessLaunchResult, parseProcessObservation, parseProcessSignalResult, parseProcessEmptyVerification, parseProcessReconciliation, parseProcessReleaseResult, selectProcessBackend, reattestProcessBackend, type ProcessBackend, type ProcessBackendRegistryEntry } from "../src/process-backend.js";

const capabilities = { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } as const;
function backend(id = "fake", probe: unknown = { attestationVersion: 1, backendId: id, verified: true, platformLabel: "fixture", capabilities }): ProcessBackend {
  return { probe: async () => probe, launch: async () => ({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "2026-01-01T00:00:00.000Z", discriminator: "birth" }, rootPid: 7, startedAt: "2026-01-01T00:00:00.000Z" }), observe: async () => ({ state: "exited", exitCode: 0 }), signal: async () => ({ state: "exited" }), verifyEmpty: async () => ({ empty: true, proofArtifactId: "proof" }), reconcile: async () => ({ state: "exited", exitCode: 0 }), release: async () => ({ released: true }) };
}
const registry = (value = backend()): ProcessBackendRegistryEntry[] => [{ registryId: "registry-fake-v1", backendId: "fake", backend: value }];

test("selects by verified semantic capability and returns immutable registry-bound attestation digest", async () => {
  const selected = await selectProcessBackend(registry(), ["tree_termination"]);
  assert.equal(selected.registryId, "registry-fake-v1"); assert.match(selected.attestationDigest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(selected.attestation), true);
});

test("rejects duplicate registry identities and false or identity-conflicting attestations", async () => {
  await assert.rejects(selectProcessBackend([...registry(), ...registry()], []), /registry identity/i);
  await assert.rejects(selectProcessBackend(registry(backend("fake", { attestationVersion: 1, backendId: "other", verified: true, platformLabel: "x", capabilities })), []), /verified process backend/i);
  await assert.rejects(selectProcessBackend(registry(backend("fake", { attestationVersion: 1, backendId: "fake", verified: false, platformLabel: "x", capabilities })), []), /verified process backend/i);
});

test("strictly snapshots every backend operation response and rejects unknown keys and wrong types", () => {
  assert.deepEqual(parseProcessLaunchResult({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "x", discriminator: "birth" }, rootPid: 9, startedAt: "x" }), { opaqueIdentity: "opaque", birthFingerprint: { observedAt: "x", discriminator: "birth" }, rootPid: 9, startedAt: "x" });
  assert.deepEqual(parseProcessObservation({ state: "exited", exitCode: 0 }), { state: "exited", exitCode: 0 });
  assert.deepEqual(parseProcessSignalResult({ state: "running" }), { state: "running" });
  assert.deepEqual(parseProcessEmptyVerification({ empty: true, proofArtifactId: "proof" }), { empty: true, proofArtifactId: "proof" });
  assert.deepEqual(parseProcessReconciliation({ state: "identity_mismatch" }), { state: "identity_mismatch" });
  assert.deepEqual(parseProcessReleaseResult({ released: true }), { released: true });
  const malformed: Array<[(value: unknown) => unknown, unknown]> = [
    [parseProcessLaunchResult, { opaqueIdentity: "o", birthFingerprint: { observedAt: "x", discriminator: "d" }, startedAt: "x", extra: true }],
    [parseProcessObservation, { state: "exited", exitCode: "0" }],
    [parseProcessSignalResult, { state: "maybe" }],
    [parseProcessEmptyVerification, { empty: "false", detail: "not empty" }],
    [parseProcessReconciliation, { state: "exited", pid: 7 }],
    [parseProcessReleaseResult, { released: "yes" }],
  ];
  for (const [parse, value] of malformed) assert.throws(() => parse(value), /backend|invalid|unknown/i);
});

test("all backend parsers reject accessors and proxies without consulting them", () => {
  const parsers: Array<(value: unknown) => unknown> = [parseProcessBackendProbe, parseProcessLaunchResult, parseProcessObservation, parseProcessSignalResult, parseProcessEmptyVerification, parseProcessReconciliation, parseProcessReleaseResult];
  for (const parse of parsers) {
    let reads = 0; const accessor = Object.defineProperty({}, "state", { enumerable: true, get: () => { reads += 1; return "exited"; } });
    assert.throws(() => parse(accessor), /backend|invalid/i); assert.equal(reads, 0);
    assert.throws(() => parse(new Proxy({}, { ownKeys: () => { throw new Error("trap"); } })), /backend|invalid/i);
  }
});

test("fresh re-attestation must match registry identity, backend id, version, and digest", async () => {
  const entries = registry(); const selected = await selectProcessBackend(entries, []);
  await assert.doesNotReject(reattestProcessBackend(entries, { registryId: selected.registryId, backendId: selected.attestation.backendId, attestationVersion: selected.attestation.attestationVersion, attestationDigest: selected.attestationDigest }));
  entries[0] = { registryId: "registry-fake-v1", backendId: "fake", backend: backend("fake", { attestationVersion: 1, backendId: "fake", verified: true, platformLabel: "changed", capabilities }) };
  await assert.rejects(reattestProcessBackend(entries, { registryId: selected.registryId, backendId: selected.attestation.backendId, attestationVersion: selected.attestation.attestationVersion, attestationDigest: selected.attestationDigest }), /attestation mismatch/i);
});
