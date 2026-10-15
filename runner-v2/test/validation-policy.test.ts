import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveValidationIntents,
  orderValidationIntents,
  partitionPacketVsFinal,
  resolveInheritedBaselineFailures,
  resolveValidationMandates,
} from "../src/validation-policy.js";

test("deriveValidationIntents names consumers/contracts/config/schema/security/isolation impact with a concise reason", () => {
  const [derived] = deriveValidationIntents([{
    id: "auth-login",
    acceptanceConditionIds: ["AC-1"],
    intendedBehavior: "login rejects wrong passwords",
    assertions: ["wrong password yields 401"],
    consumers: ["session-service", "audit-log"],
    contracts: ["AuthAPI.v2"],
    configImpact: true,
    schemaImpact: false,
    securityImpact: true,
    isolationImpact: false,
    isExactFailure: false,
  }]);
  assert.equal(derived.intent.scope, "affected");
  assert.match(derived.intent.scopeReason, /consumers\(audit-log,session-service\)/);
  assert.match(derived.intent.scopeReason, /contracts\(AuthAPI\.v2\)/);
  assert.match(derived.intent.scopeReason, /config/);
  assert.match(derived.intent.scopeReason, /security/);
  assert.ok(derived.intent.scopeReason.length < 300);
});

test("deriveValidationIntents marks exact failures targeted even without other impact", () => {
  const [derived] = deriveValidationIntents([{
    id: "exact-1",
    acceptanceConditionIds: ["AC-9"],
    intendedBehavior: "reproduce crash on empty input",
    assertions: ["empty input does not crash"],
    consumers: [],
    contracts: [],
    configImpact: false,
    schemaImpact: false,
    securityImpact: false,
    isolationImpact: false,
    isExactFailure: true,
  }]);
  assert.equal(derived.intent.scope, "targeted");
  assert.equal(derived.isExactFailure, true);
  assert.match(derived.intent.scopeReason, /Exact failure reproduction/);
});

test("deriveValidationIntents rejects malformed behaviors", () => {
  assert.throws(() => deriveValidationIntents("nope" as never), /behaviors array/);
  assert.throws(() => deriveValidationIntents([{
    id: "",
    acceptanceConditionIds: ["AC-1"],
    intendedBehavior: "b",
    assertions: ["a"],
    consumers: [],
    contracts: [],
    configImpact: false,
    schemaImpact: false,
    securityImpact: false,
    isolationImpact: false,
    isExactFailure: false,
  }]), /malformed/);
});

test("orderValidationIntents puts exact failures first, then affected scope, deterministically", () => {
  const derived = deriveValidationIntents([
    {
      id: "b-final", acceptanceConditionIds: ["A"], intendedBehavior: "b", assertions: ["b"],
      consumers: ["c"], contracts: [], configImpact: false, schemaImpact: false, securityImpact: false,
      isolationImpact: false, isExactFailure: false,
    },
    {
      id: "a-exact", acceptanceConditionIds: ["A"], intendedBehavior: "a", assertions: ["a"],
      consumers: [], contracts: [], configImpact: false, schemaImpact: false, securityImpact: false,
      isolationImpact: false, isExactFailure: true,
    },
    {
      id: "c-plain", acceptanceConditionIds: ["A"], intendedBehavior: "c", assertions: ["c"],
      consumers: [], contracts: [], configImpact: false, schemaImpact: false, securityImpact: false,
      isolationImpact: false, isExactFailure: false,
    },
  ], { defaultScope: "final" });
  const ordered = orderValidationIntents(derived);
  assert.deepEqual(ordered.map((d) => d.intent.id), ["intent_a-exact", "intent_b-final", "intent_c-plain"]);
});

test("resolveValidationMandates keeps the default full suite on the final candidate only", () => {
  const packet = resolveValidationMandates({ sourceMandates: [], projectMandates: [], isFinalCandidate: false });
  assert.deepEqual(packet.required, []);
  assert.deepEqual(packet.conflicts, []);
  const fin = resolveValidationMandates({ sourceMandates: [], projectMandates: [], isFinalCandidate: true });
  assert.equal(fin.required.length, 1);
  assert.equal(fin.required[0].gate, "full_suite");
});

test("resolveValidationMandates retains explicit gates and defers final-scope mandates off-candidate", () => {
  const resolution = resolveValidationMandates({
    sourceMandates: [{
      id: "e2e", gate: "e2e_browser", scope: "final", source: "source", description: "Source requires browser e2e at final.",
    }],
    projectMandates: [{
      id: "lint", gate: "eslint", scope: "affected", source: "project", description: "Project requires lint now.",
    }],
    isFinalCandidate: false,
  });
  assert.deepEqual(resolution.required.map((m) => m.id), ["lint"]);
  assert.deepEqual(resolution.deferredToFinal.map((m) => m.id), ["e2e"]);
  const onFinal = resolveValidationMandates({
    sourceMandates: [{
      id: "e2e", gate: "e2e_browser", scope: "final", source: "source", description: "Source requires browser e2e at final.",
    }],
    projectMandates: [],
    isFinalCandidate: true,
  });
  assert.ok(onFinal.required.some((m) => m.id === "e2e"));
  assert.ok(onFinal.required.some((m) => m.gate === "full_suite"));
});

test("resolveValidationMandates surfaces same-id scope conflicts instead of silently picking", () => {
  const resolution = resolveValidationMandates({
    sourceMandates: [{ id: "perf", gate: "perf", scope: "final", source: "source", description: "s" }],
    projectMandates: [{ id: "perf", gate: "perf", scope: "targeted", source: "project", description: "p" }],
    isFinalCandidate: false,
  });
  assert.equal(resolution.conflicts.length, 1);
  assert.equal(resolution.conflicts[0].id, "perf");
  assert.deepEqual([...resolution.conflicts[0].scopes].sort(), ["final", "targeted"]);
});

test("resolveInheritedBaselineFailures never auto-introduces or auto-waives without disposition", () => {
  const [resolution] = resolveInheritedBaselineFailures({
    baselineFailures: [{ checkId: "c1", evidenceId: "e1", summary: "old red", packetRequired: false }],
    dispositions: [],
  });
  assert.equal(resolution.status, "pending_disposition");
  assert.match(resolution.detail, /neither introduced as current nor waived/);
});

test("resolveInheritedBaselineFailures rejects waivers of packet-required checks", () => {
  const [resolution] = resolveInheritedBaselineFailures({
    baselineFailures: [{ checkId: "c1", evidenceId: "e1", summary: "old red", packetRequired: true }],
    dispositions: [{ checkId: "c1", disposition: "accepted", authorizedBy: "owner", rationale: "looks fine" }],
  });
  assert.equal(resolution.status, "waiver_rejected");
});

test("resolveInheritedBaselineFailures accepts non-required checks with authorized disposition and requires retest otherwise", () => {
  const resolutions = resolveInheritedBaselineFailures({
    baselineFailures: [
      { checkId: "c1", evidenceId: "e1", summary: "flaky ui", packetRequired: false },
      { checkId: "c2", evidenceId: "e2", summary: "needs rerun", packetRequired: true },
    ],
    dispositions: [
      { checkId: "c1", disposition: "accepted", authorizedBy: "owner", rationale: "ui-only, tracked separately" },
      { checkId: "c2", disposition: "retest", authorizedBy: "arch", rationale: "rerun on current revision" },
    ],
  });
  assert.equal(resolutions[0].status, "accepted_with_disposition");
  assert.equal(resolutions[1].status, "retest_required");
});

test("partitionPacketVsFinal requires packet criteria to pass and keeps final-gate visibly pending", () => {
  const blocked = partitionPacketVsFinal([
    { id: "p1", gate: "packet", status: "passed" },
    { id: "p2", gate: "packet", status: "failed" },
    { id: "f1", gate: "final", status: "pending" },
  ]);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blockers.length, 1);
  assert.match(blocked.blockers[0], /p2/);
  assert.deepEqual(blocked.finalGatePending.map((c) => c.id), ["f1"]);

  const ready = partitionPacketVsFinal([
    { id: "p1", gate: "packet", status: "passed" },
    { id: "f1", gate: "final", status: "pending" },
  ]);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.finalGatePending.map((c) => c.id), ["f1"]);
});
