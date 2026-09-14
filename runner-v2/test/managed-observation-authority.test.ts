import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { createSessionAuthority, type SessionOperationRequest, type OperationAuthorizationAssertion, type SessionOperationAuthorization } from "../src/session-authority.js";
import { createInMemoryStreamingSessionStore, getStreamingSessionStoreWriter } from "../src/streaming-session-store.js";

type Batch = { authorizeObservationBatch(request: Omit<SessionOperationRequest, "sessionId" | "operation"> & { sessionIds: readonly string[] }): readonly SessionOperationAuthorization[] };
const noAccess = { requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } as const;
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "p684-observation-authority-")); t.diagnostic(`exact synthetic authority root: ${root}`);
  let time = Date.parse("2026-09-14T00:00:00.000Z"), sequence = 0; const clock = () => new Date(time);
  const grants = createExecutionGrantAuthority({ clock }), kernel = createInMemoryStreamingSessionStore(), authority = createSessionAuthority({ grants, sessions: kernel, clock });
  const binding = { runId: "run", sessionId: "agent", actor: { role: "worker" as const, id: "worker" }, toolName: "process.start", callId: "start", permissionProfile: "full" as const };
  const issue = async (toolName: string, actor = binding.actor) => { const exact = { ...binding, actor, toolName, callId: `call-${++sequence}` }; return { binding: exact,
    grant: await grants.issue({ ...exact, workspacePath: root, access: [{ path: root, mode: "write" }], ...{ networkApproved: false, externalApproved: false, destructiveApproved: false } }) }; };
  for (const sessionId of ["one", "two"]) {
    const launch = await issue("process.start");
    const begun = authority.beginTransfer({ sessionId, ...launch,
      lease: { leaseId: `lease-${sessionId}`, providerId: "fixture", invocationId: `invoke-${sessionId}`, providerIdentity: "a".repeat(64), acquiredAt: clock().toISOString(), access: [] },
      backendBinding: { registryId: "registry", backendId: "fixture", implementationGeneration: "one", implementationDigest: "b".repeat(64), attestationVersion: 1, attestationDigest: "c".repeat(64), opaqueIdentity: sessionId, birthFingerprint: { observedAt: clock().toISOString(), discriminator: sessionId }, startedAt: clock().toISOString() },
      envelope: { access: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } });
    authority.acknowledgeTransfer({ sessionId, ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken, expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId });
    await grants.revoke(launch.grant, "completed");
  }
  return { root, authority, kernel, grants, issue, clock, advance: () => { time += 400_000; }, async close(passed: boolean) { kernel.store.close(); if (passed) await rm(root, { recursive: true }); else t.diagnostic(`synthetic authority failure retained: ${root}`); } };
}

test("managed list consumes one original call once for a bounded exact-owner observation batch", async t => {
  const f = await fixture(t); let passed = false;
  try {
    const call = await f.issue("process.list"); const authority = f.authority as unknown as Batch;
    assert.equal(typeof authority.authorizeObservationBatch, "function", "list must not manufacture one new grant per child");
    const authorizations = authority.authorizeObservationBatch({ ...call, ...noAccess, sessionIds: ["one", "two"] });
    assert.equal(authorizations.length, 2);
    for (const [index, sessionId] of ["one", "two"].entries()) {
      const expected = { sessionId, operation: "observe", binding: call.binding, ...noAccess } as unknown as OperationAuthorizationAssertion;
      f.authority.assertOperationAuthorization(authorizations[index]!, expected);
      assert.throws(() => f.authority.assertOperationAuthorization(authorizations[index]!, { ...expected, operation: "write" }), /operation/i);
    }
    assert.throws(() => f.grants.consume(call.grant, call.binding), /consum/i);
    assert.throws(() => authority.authorizeObservationBatch({ ...call, ...noAccess, sessionIds: ["one"] }), /second|reuse|consum/i);
    await f.grants.revoke(call.grant, "completed");
    assert.throws(() => f.authority.assertOperationAuthorization(authorizations[0]!, { sessionId: "one", operation: "observe", binding: call.binding, ...noAccess } as unknown as OperationAuthorizationAssertion), /revok|current|authority/i);
    passed = true;
  } finally { await f.close(passed); }
});

test("managed observation rechecks owner takeover and never widens unavailable-session writes", async t => {
  const f = await fixture(t); let passed = false;
  try {
    const record = f.kernel.store.readBySession("one")!;
    f.authority.recordDisposition({ sessionId: "one", ownerId: record.ownerId, fencingToken: record.fencingToken, expectedRevision: record.revision, disposition: "input_unavailable" });
    const call = await f.issue("process.poll"), request = { ...call, sessionId: "one", operation: "observe", ...noAccess } as unknown as SessionOperationRequest;
    const authorization = f.authority.authorizeOperation(request);
    f.authority.assertOperationAuthorization(authorization, request);
    const write = await f.issue("process.write");
    assert.throws(() => f.authority.authorizeOperation({ ...request, ...write, operation: "write" }), /active|unavailable/i);
    f.advance(); const latest = f.kernel.store.readBySession("one")!;
    getStreamingSessionStoreWriter(f.kernel).apply({ type: "takeover", sessionId: "one", ownerId: latest.ownerId, fencingToken: latest.fencingToken,
      expectedRevision: latest.revision, newOwnerId: "new-exact-owner", newFencingToken: latest.fencingToken + 1, leaseExpiresAt: new Date(f.clock().getTime() + 300_000).toISOString(), at: f.clock().toISOString() });
    assert.throws(() => f.authority.assertOperationAuthorization(authorization, request), /stale|fence/i); passed = true;
  } finally { await f.close(passed); }
});

for (const scenario of ["foreign-owner", "duplicate", "too-many"] as const) test(`managed observation batch refuses ${scenario} without producing partial capabilities`, async t => {
  const f = await fixture(t); let passed = false;
  try {
    const authority = f.authority as unknown as Batch;
    assert.equal(typeof authority.authorizeObservationBatch, "function");
    const call = await f.issue("process.list", scenario === "foreign-owner" ? { role: "worker", id: "foreign" } : undefined);
    const sessionIds = scenario === "duplicate" ? ["one", "one"] : scenario === "too-many" ? Array.from({ length: 129 }, (_, i) => String(i)) : ["one", "two"];
    assert.throws(() => authority.authorizeObservationBatch({ ...call, ...noAccess, sessionIds }), /bound|duplic|owner|match|invalid/i); passed = true;
  } finally { await f.close(passed); }
});
