import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProcessBackendProbe,
  selectProcessBackend,
  type ProcessBackend,
} from "../src/process-backend.js";

function backend(id: string, probe: unknown): ProcessBackend {
  return {
    probe: async () => probe,
    launch: async () => { throw new Error("unused"); },
    observe: async () => ({ exitCode: 0, signal: undefined }),
    signal: async () => ({ state: "exited" }),
    verifyEmpty: async () => ({ empty: true, proofArtifactId: "proof" }),
    reconcile: async () => ({ state: "exited", exitCode: 0 }),
    release: async () => undefined,
    backendId: id,
  };
}

test("selects by verified semantic capabilities rather than platform label", async () => {
  const weak = backend("same-os", {
    backendId: "same-os", verified: true, platformLabel: "preferred-os",
    capabilities: { tree_termination: "partial", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" },
  });
  const strong = backend("portable", {
    backendId: "portable", verified: true, platformLabel: "other-os",
    capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" },
  });
  assert.equal((await selectProcessBackend([weak, strong], ["tree_termination"])).backendId, "portable");
});

test("refuses false, unverified, malformed, and identity-conflicting capability claims", async () => {
  const claims = [
    { backendId: "bad", verified: false, platformLabel: "x", capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } },
    { backendId: "bad", verified: "yes", platformLabel: "x", capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } },
    { backendId: "other", verified: true, platformLabel: "x", capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } },
    { backendId: "bad", verified: true, platformLabel: "x", capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" }, extra: true },
  ];
  for (const claim of claims) {
    await assert.rejects(selectProcessBackend([backend("bad", claim)], ["tree_termination"]), /verified process backend/i);
  }
});

test("strictly parses and freezes a verified backend probe", () => {
  const probe = parseProcessBackendProbe({
    backendId: "fake", verified: true, platformLabel: "fixture",
    capabilities: { tree_termination: "enforced", crash_cleanup: "partial", verified_emptiness: "enforced", write_confinement: "unavailable" },
  });
  assert.equal(Object.isFrozen(probe), true);
  assert.equal(Object.isFrozen(probe.capabilities), true);
});

test("rejects accessor and proxy capability claims without consulting them", () => {
  let getterReads = 0;
  const accessor = Object.defineProperty({
    backendId: "fake", verified: true, platformLabel: "fixture",
    capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" },
  }, "verified", { enumerable: true, get: () => { getterReads += 1; return true; } });
  assert.throws(() => parseProcessBackendProbe(accessor), /verified process backend/i);
  assert.equal(getterReads, 0);

  const proxy = new Proxy({}, { ownKeys: () => { throw new Error("shape trap"); } });
  assert.throws(() => parseProcessBackendProbe(proxy), /verified process backend/i);
});
