import assert from "node:assert/strict";
import test from "node:test";

import {
  EXECUTION_SAFETY_CAPABILITY_NAMES,
  assertDurableExecutionSafetyValue,
  cloneExecutionBackendAttestation,
  cloneIsolationProviderAttestation,
  executionSafetyCapabilitiesSatisfy,
  parseExecutionBackendAttestation,
  parseIsolationProviderAttestation,
  type ExecutionBackendAttestation,
  type ExecutionSafetyCapabilityName,
} from "../src/execution-safety-contracts.js";

const enforcedCapabilities: Record<ExecutionSafetyCapabilityName, "enforced"> = {
  tree_termination: "enforced",
  crash_cleanup: "enforced",
  verified_emptiness: "enforced",
  write_confinement: "enforced",
};

test("execution-safety attestations use closed semantic capability and state names", () => {
  assert.deepEqual(EXECUTION_SAFETY_CAPABILITY_NAMES, [
    "tree_termination",
    "crash_cleanup",
    "verified_emptiness",
    "write_confinement",
  ]);
  const parsed = parseExecutionBackendAttestation({
    backendId: "fixture.portable",
    mechanism: "fixture process supervisor",
    platformLabel: "fixture-os",
    capabilities: enforcedCapabilities,
  });
  assert.equal(parsed.capabilities.write_confinement, "enforced");

  assert.throws(
    () => parseExecutionBackendAttestation({
      backendId: "fixture.portable",
      mechanism: "fixture process supervisor",
      platformLabel: "fixture-os",
      capabilities: { ...enforcedCapabilities, job_object: "enforced" },
    }),
    /unknown.*capability|capability.*unknown/i,
  );
  assert.throws(
    () => parseExecutionBackendAttestation({
      backendId: "fixture.portable",
      mechanism: "fixture process supervisor",
      platformLabel: "fixture-os",
      capabilities: { ...enforcedCapabilities, crash_cleanup: "best_effort" },
    }),
    /state/i,
  );
  assert.throws(
    () => parseExecutionBackendAttestation({
      backendId: "fixture.portable",
      mechanism: "fixture process supervisor",
      platformLabel: "fixture-os",
      capabilities: enforcedCapabilities,
      nativeHandle: 42,
    }),
    /unknown.*nativeHandle/i,
  );
});

test("execution-safety attestation clones do not retain caller-owned mutable values", () => {
  const source: ExecutionBackendAttestation = {
    backendId: "fixture.portable",
    mechanism: "fixture process supervisor",
    platformLabel: "fixture-os",
    capabilities: { ...enforcedCapabilities },
  };
  const clone = cloneExecutionBackendAttestation(source);
  (source.capabilities as Record<string, string>).tree_termination = "unavailable";
  assert.equal(clone.capabilities.tree_termination, "enforced");
  assert.notEqual(clone.capabilities, source.capabilities);
});

test("isolation-provider attestations share the closed semantic capability contract", () => {
  const source = {
    providerId: "fixture.isolation",
    mechanism: "fixture isolated executor",
    platformLabel: "fixture-os",
    capabilities: { ...enforcedCapabilities } as Record<
      ExecutionSafetyCapabilityName,
      "enforced" | "unavailable"
    >,
  };
  const parsed = parseIsolationProviderAttestation(source);
  const clone = cloneIsolationProviderAttestation(parsed);
  source.capabilities.write_confinement = "unavailable";
  assert.equal(clone.capabilities.write_confinement, "enforced");
  assert.throws(
    () => parseIsolationProviderAttestation({ ...source, platformFamily: "fixture" }),
    /unknown.*platformFamily/i,
  );
});

test("durable execution-safety values reject handles, secret material, and live values", () => {
  assert.doesNotThrow(() => assertDurableExecutionSafetyValue({
    backendIdentity: { backendId: "fixture.portable", opaqueIdentity: "process-identity-7" },
    artifactIds: ["stdout-7", "stderr-7"],
  }));
  assert.throws(
    () => assertDurableExecutionSafetyValue({ cleanup: { nativeHandle: 1234 } }),
    /nativeHandle/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ grant: { credentialValue: "secret" } }),
    /credentialValue/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ grant: { oneCallToken: "secret" } }),
    /oneCallToken/i,
  );
  assert.throws(
    () => assertDurableExecutionSafetyValue({ close: () => undefined }),
    /durable/i,
  );
});

test("capability comparison selects semantic enforcement independently of mechanism labels", () => {
  const first = parseExecutionBackendAttestation({
    backendId: "fixture.first",
    mechanism: "alpha",
    platformLabel: "host-a",
    capabilities: enforcedCapabilities,
  });
  const second = parseExecutionBackendAttestation({
    backendId: "fixture.second",
    mechanism: "beta",
    platformLabel: "host-b",
    capabilities: { ...enforcedCapabilities, write_confinement: "partial" },
  });
  assert.equal(
    executionSafetyCapabilitiesSatisfy(first.capabilities, ["tree_termination", "write_confinement"]),
    true,
  );
  assert.equal(
    executionSafetyCapabilitiesSatisfy(second.capabilities, ["tree_termination", "write_confinement"]),
    false,
  );
});
