import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutionGrantAuthority, ExecutionGrantError } from "../src/execution-grants.js";
import {
  SessionAuthorityError,
  assertSessionEnvelopeSubset,
  createSessionAuthority,
} from "../src/session-authority.js";
import { createInMemoryStreamingSessionStore } from "../src/streaming-session-store.js";

test("consumes one launch grant exactly once and persists only immutable session claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-authority-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority({
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    const binding = {
      runId: "run-1",
      sessionId: "agent-session-1",
      actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start",
      callId: "call-1",
      permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants,
      sessions: createInMemoryStreamingSessionStore(),
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });

    const begun = sessions.beginTransfer({
      sessionId: "stream-1",
      grant,
      binding,
      lease: {
        leaseId: "lease-1",
        providerId: "fake-provider",
        invocationId: "invoke-1",
        providerIdentity: "a".repeat(64),
        acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }],
        credentialNames: [],
        networkApproved: false,
        externalApproved: false,
        destructiveApproved: false,
      },
    });

    assert.equal(begun.record.state, "pending_transfer");
    assert.equal(JSON.stringify(begun.record).includes("opaqueGrant"), false);
    assert.throws(
      () => grants.consume(grant, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_consumed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a semantic streaming session-ID collision before consuming the new grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-collision-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const sessions = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore() });
    const transfer = (
      grant: Awaited<ReturnType<typeof grants.issue>>,
      inputBinding: typeof binding,
      leaseId = "lease-1",
    ) => {
      return sessions.beginTransfer({
        sessionId: "stream-1", grant, binding: inputBinding,
        lease: {
          leaseId, providerId: "fake-provider", invocationId: "invoke-1",
          providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
          access: [{ canonicalPath: workspace, mode: "write" }],
        },
        backendBinding: backendBinding(),
        envelope: {
          access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
          networkApproved: false, externalApproved: false, destructiveApproved: false,
        },
      });
    };
    const firstGrant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    await transfer(firstGrant, binding);

    const collisionBinding = { ...binding, runId: "other-run", callId: "call-2" };
    const collisionGrant = await grants.issue({
      ...collisionBinding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    assert.throws(
      () => transfer(collisionGrant, collisionBinding),
      (error) => error instanceof SessionAuthorityError && (error as { code: string }).code === "session_collision",
    );
    assert.doesNotThrow(() => grants.consume(collisionGrant, collisionBinding));
    const sameCallCollisionGrant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    assert.throws(
      () => transfer(sameCallCollisionGrant, binding, "different-lease"),
      (error) => error instanceof SessionAuthorityError && (error as { code: string }).code === "session_collision",
    );
    assert.doesNotThrow(() => grants.consume(sameCallCollisionGrant, binding));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a session envelope that broadens the launch grant's exact path access", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-envelope-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1",
      sessionId: "agent-session-1",
      actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start",
      callId: "call-1",
      permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants,
      sessions: createInMemoryStreamingSessionStore(),
    });
    assert.throws(
      () => sessions.beginTransfer({
        sessionId: "stream-1",
        grant,
        binding,
        lease: {
          leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
          providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
          access: [{ canonicalPath: workspace, mode: "write" }],
        },
        backendBinding: backendBinding(),
        envelope: {
          access: [{ canonicalPath: outside, mode: "write" }],
          credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false,
        },
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "envelope_escalation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compares path, credentials, network, external, and destructive envelope authority separately", () => {
  const claims = {
    access: [{ canonicalPath: "C:\\workspace", mode: "write" as const }],
    credentialNames: ["SERVICE_TOKEN"],
    networkApproved: false,
    externalApproved: false,
    destructiveApproved: false,
  };
  const envelope = {
    access: [{ canonicalPath: "C:\\workspace", mode: "write" as const }],
    credentialNames: ["SERVICE_TOKEN"],
    networkApproved: false,
    externalApproved: false,
    destructiveApproved: false,
  };
  assert.doesNotThrow(() => assertSessionEnvelopeSubset(envelope, claims));
  for (const expanded of [
    { ...envelope, access: [{ canonicalPath: "C:\\outside", mode: "write" as const }] },
    { ...envelope, credentialNames: ["OTHER_TOKEN"] },
    { ...envelope, networkApproved: true },
    { ...envelope, externalApproved: true },
    { ...envelope, destructiveApproved: true },
  ]) {
    assert.throws(
      () => assertSessionEnvelopeSubset(expanded, claims),
      (error) => error instanceof SessionAuthorityError && error.code === "envelope_escalation",
    );
  }
});

test("refuses an isolation lease that broadens the launch grant or cannot cover the fixed session envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-lease-envelope-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  try {
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const issue = async (callId: string) => {
      const grants = createExecutionGrantAuthority();
      const grant = await grants.issue({
        ...binding, callId, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
        externalApproved: false, destructiveApproved: false, networkApproved: false,
      });
      return { grants, grant, localBinding: { ...binding, callId } };
    };
    const broad = await issue("call-broad");
    const broadSessions = createSessionAuthority({ grants: broad.grants, sessions: createInMemoryStreamingSessionStore() });
    assert.throws(
      () => broadSessions.beginTransfer({
        sessionId: "stream-1", grant: broad.grant, binding: broad.localBinding,
        lease: {
          leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
          providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
          access: [{ canonicalPath: outside, mode: "write" }],
        },
        backendBinding: backendBinding(),
        envelope: {
          access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
          networkApproved: false, externalApproved: false, destructiveApproved: false,
        },
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "envelope_escalation",
    );
    const narrow = await issue("call-narrow");
    const narrowSessions = createSessionAuthority({ grants: narrow.grants, sessions: createInMemoryStreamingSessionStore() });
    assert.throws(
      () => narrowSessions.beginTransfer({
        sessionId: "stream-2", grant: narrow.grant, binding: narrow.localBinding,
        lease: {
          leaseId: "lease-2", providerId: "fake-provider", invocationId: "invoke-2",
          providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
          access: [],
        },
        backendBinding: backendBinding(),
        envelope: {
          access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
          networkApproved: false, externalApproved: false, destructiveApproved: false,
        },
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "envelope_escalation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durably transfers cleanup ownership only after the exact transfer acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-transfer-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(),
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    const adopted = sessions.acknowledgeTransfer({
      sessionId: "stream-1",
      ownerId: begun.record.ownerId as string,
      fencingToken: 1,
      expectedRevision: begun.record.revision as number,
      effectId: begun.record.effects[0]?.effectId as string,
    });
    assert.equal(adopted.record.state, "active");
    assert.equal(adopted.record.cleanupOwner, "session_authority");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds an opaque launch-call authorization to its exact session and operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-operation-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(),
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId as string, fencingToken: 1,
      expectedRevision: begun.record.revision as number, effectId: begun.record.effects[0]?.effectId as string,
    });
    const authorization = sessions.authorizeLaunchOperation({
      sessionId: "stream-1",
      operation: "request",
      requestAccess: [{ canonicalPath: workspace, mode: "write" as const }],
      credentialNames: [],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
    });
    assert.deepEqual(Object.keys(authorization), []);
    assert.doesNotThrow(() => sessions.assertOperationAuthorization(authorization, {
      sessionId: "stream-1", operation: "request",
      binding, requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
      networkApproved: false, externalApproved: false, destructiveApproved: false,
    }));
    assert.throws(
      () => sessions.assertOperationAuthorization(authorization, {
        sessionId: "stream-1", operation: "write",
        binding, requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "operation_mismatch",
    );
    assert.throws(
      () => sessions.assertOperationAuthorization(authorization, {
        sessionId: "stream-1", operation: "request",
        binding: { ...binding, callId: "forged-call" },
        requestAccess: [{ canonicalPath: workspace, mode: "write" }],
        credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "binding_mismatch",
    );
    assert.throws(
      () => sessions.assertOperationAuthorization({} as never, {
        sessionId: "stream-1", operation: "request", binding,
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "authorization_forged",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalidates a current operation authorization after a fenced recovery takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-stale-auth-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    let now = new Date("2026-08-29T00:00:00.000Z");
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(),
      clock: () => now,
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    const active = sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId,
    }).record;
    const authorization = sessions.authorizeLaunchOperation({
      sessionId: "stream-1", operation: "request",
      requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
      networkApproved: false, externalApproved: false, destructiveApproved: false,
    });
    now = new Date("2026-08-29T00:01:00.000Z");
    sessions.takeover({
      sessionId: "stream-1", ownerId: active.ownerId, fencingToken: active.fencingToken,
      expectedRevision: active.revision, newOwnerId: "session-authority:recovered",
      newFencingToken: 2, leaseExpiresAt: "2026-08-29T00:05:00.000Z",
    });
    assert.throws(
      () => sessions.assertOperationAuthorization(authorization, {
        sessionId: "stream-1", operation: "request", binding,
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "authorization_stale",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revokes a session operation authorization when ToolBroker revokes its source call", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-revoked-auth-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore() });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId,
    });
    const authorization = sessions.authorizeLaunchOperation({
      sessionId: "stream-1", operation: "request",
      requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
      networkApproved: false, externalApproved: false, destructiveApproved: false,
    });
    await grants.revoke(grant, "completed");
    assert.throws(
      () => sessions.assertOperationAuthorization(authorization, {
        sessionId: "stream-1", operation: "request", binding,
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "authorization_revoked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expires a session operation authorization when the source call grant expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-expired-auth-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let now = new Date("2026-08-29T00:00:00.000Z");
  try {
    const grants = createExecutionGrantAuthority({ clock: () => now, ttlMs: 10 });
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(), clock: () => now,
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: now.toISOString(),
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId,
    });
    const authorization = sessions.authorizeLaunchOperation({
      sessionId: "stream-1", operation: "request",
      requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
      networkApproved: false, externalApproved: false, destructiveApproved: false,
    });
    now = new Date("2026-08-29T00:00:00.011Z");
    assert.throws(
      () => sessions.assertOperationAuthorization(authorization, {
        sessionId: "stream-1", operation: "request", binding,
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "authorization_revoked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an expired durable session owner before issuing a new family authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-expired-lease-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let now = new Date("2026-08-29T00:00:00.000Z");
  try {
    const grants = createExecutionGrantAuthority({ clock: () => now, ttlMs: 120_000 });
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(), clock: () => now,
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: now.toISOString(),
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId,
    });
    now = new Date("2026-08-29T00:01:00.000Z");
    assert.throws(
      () => sessions.authorizeLaunchOperation({
        sessionId: "stream-1", operation: "request",
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "authorization_stale",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not reuse the launching ToolBroker call for a second session operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-once-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore() });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId as string, fencingToken: 1,
      expectedRevision: begun.record.revision as number, effectId: begun.record.effects[0]?.effectId as string,
    });
    const request = {
      sessionId: "stream-1", operation: "request" as const,
      requestAccess: [{ canonicalPath: workspace, mode: "write" as const }],
      credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false,
    };
    sessions.authorizeLaunchOperation(request);
    assert.throws(
      () => sessions.authorizeLaunchOperation({ ...request, operation: "write" }),
      (error) => error instanceof SessionAuthorityError && error.code === "launch_call_consumed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a second opaque grant for the same ToolBroker call before consuming it", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-second-grant-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const issue = () => grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore() });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant: await issue(), binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId,
    });
    const secondGrant = await issue();
    assert.throws(
      () => sessions.authorizeOperation({
        sessionId: "stream-1", grant: secondGrant, binding, operation: "request",
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "second_grant_for_call",
    );
    assert.doesNotThrow(() => grants.consume(secondGrant, binding));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a second streaming-session transfer for one exact ToolBroker call", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-second-transfer-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const issue = () => grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore() });
    const transfer = (sessionId: string, grant: Awaited<ReturnType<typeof issue>>) => sessions.beginTransfer({
      sessionId, grant, binding,
      lease: {
        leaseId: "lease-" + sessionId, providerId: "fake-provider", invocationId: "invoke-" + sessionId,
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    transfer("stream-1", await issue());
    const secondGrant = await issue();
    assert.throws(
      () => transfer("stream-2", secondGrant),
      (error) => error instanceof SessionAuthorityError && error.code === "second_grant_for_call",
    );
    assert.doesNotThrow(() => grants.consume(secondGrant, binding));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replays each unadopted transfer and cleanup effect once without fabricating adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-recover-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(),
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    const replayed: string[] = [];
    const recovered = sessions.recoverUnadopted({
      sessionId: "stream-1",
      ownerId: begun.record.ownerId as string,
      fencingToken: 1,
      replay: (effect) => {
        replayed.push(effect.kind);
        return effect.kind === "transfer" ? "ambiguous" : "cleaned";
      },
    });
    assert.deepEqual(replayed, ["transfer", "cleanup"]);
    assert.equal(recovered.record.state, "released");
    assert.equal(recovered.record.cleanupOwner, "none");
    assert.equal(recovered.record.effects.every((effect) => effect.status === "acknowledged"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed into durable provider-lease cleanup blocking after host loss before adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-recover-blocked-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(),
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    const replayed: string[] = [];
    const recovered = sessions.recoverUnadopted({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      replay: (effect) => {
        replayed.push(effect.kind);
        return effect.kind === "transfer" ? "ambiguous" : "blocked";
      },
    });
    assert.deepEqual(replayed, ["transfer", "cleanup"]);
    assert.equal(recovered.record.state, "cleanup_blocked");
    assert.equal(recovered.record.cleanupOwner, "provider_lease");
    assert.equal(recovered.record.effects.find((effect) => effect.kind === "cleanup")?.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses SessionAuthority-only fenced cleanup after transfer acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-adopted-recovery-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({
      grants, sessions: createInMemoryStreamingSessionStore(),
      clock: () => new Date("2026-08-29T00:00:00.000Z"),
    });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    const active = sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId,
    }).record;
    const replayed: string[] = [];
    const recovered = sessions.recoverAdopted({
      sessionId: "stream-1", ownerId: active.ownerId, fencingToken: active.fencingToken,
      replay: (effect) => {
        replayed.push(effect.kind);
        return "cleaned";
      },
    });
    assert.deepEqual(replayed, ["cleanup"]);
    assert.equal(recovered.record.state, "released");
    assert.equal(recovered.record.cleanupOwner, "none");
    assert.equal(recovered.record.effects.every((effect) => effect.status === "acknowledged"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records a typed unavailable disposition instead of authorizing a relaunch", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-disposition-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const grants = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await grants.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore() });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant, binding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    const active = sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken,
      expectedRevision: begun.record.revision, effectId: begun.record.effects[0]!.effectId,
    }).record;
    const unavailable = sessions.recordDisposition({
      sessionId: "stream-1", ownerId: active.ownerId, fencingToken: active.fencingToken,
      expectedRevision: active.revision, disposition: "input_unavailable",
    });
    assert.equal(unavailable.record.state, "input_unavailable");
    assert.throws(
      () => sessions.authorizeLaunchOperation({
        sessionId: "stream-1", operation: "request",
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "session_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires a fresh exact ToolBroker call for a later session operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-session-fresh-call-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  try {
    const grants = createExecutionGrantAuthority();
    const launchBinding = {
      runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const launchGrant = await grants.issue({
      ...launchBinding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const sessions = createSessionAuthority({ grants, sessions: createInMemoryStreamingSessionStore() });
    const begun = sessions.beginTransfer({
      sessionId: "stream-1", grant: launchGrant, binding: launchBinding,
      lease: {
        leaseId: "lease-1", providerId: "fake-provider", invocationId: "invoke-1",
        providerIdentity: "a".repeat(64), acquiredAt: "2026-08-29T00:00:00.000Z",
        access: [{ canonicalPath: workspace, mode: "write" }],
      },
      backendBinding: backendBinding(),
      envelope: {
        access: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      },
    });
    sessions.acknowledgeTransfer({
      sessionId: "stream-1", ownerId: begun.record.ownerId as string, fencingToken: 1,
      expectedRevision: begun.record.revision as number, effectId: begun.record.effects[0]?.effectId as string,
    });
    const broaderBinding = { ...launchBinding, callId: "call-broader", toolName: "process.request" };
    const broaderGrant = await grants.issue({
      ...broaderBinding, workspacePath: workspace,
      access: [{ path: workspace, mode: "write" }, { path: outside, mode: "write" }],
      externalApproved: true, destructiveApproved: false, networkApproved: true,
      credentialNames: ["SERVICE_TOKEN"],
    });
    assert.throws(
      () => sessions.authorizeOperation({
        sessionId: "stream-1", grant: broaderGrant, binding: broaderBinding, operation: "request",
        requestAccess: [{ canonicalPath: outside, mode: "write" }], credentialNames: ["SERVICE_TOKEN"],
        networkApproved: true, externalApproved: true, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "envelope_escalation",
    );
    const rejectedCallRetryGrant = await grants.issue({
      ...broaderBinding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    assert.throws(
      () => sessions.authorizeOperation({
        sessionId: "stream-1", grant: rejectedCallRetryGrant, binding: broaderBinding, operation: "request",
        requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
        networkApproved: false, externalApproved: false, destructiveApproved: false,
      }),
      (error) => error instanceof SessionAuthorityError && error.code === "second_grant_for_call",
    );
    assert.doesNotThrow(() => grants.consume(rejectedCallRetryGrant, broaderBinding));
    for (const [label, changed] of [
      ["actor", { actor: { role: "worker" as const, id: "other-worker" } }],
      ["agent-session", { sessionId: "other-agent-session" }],
    ] as const) {
      const mismatchedBinding = { ...launchBinding, ...changed, callId: "call-" + label, toolName: "process.request" };
      const mismatchedGrant = await grants.issue({
        ...mismatchedBinding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
        externalApproved: false, destructiveApproved: false, networkApproved: false,
      });
      assert.throws(
        () => sessions.authorizeOperation({
          sessionId: "stream-1", grant: mismatchedGrant, binding: mismatchedBinding, operation: "request",
          requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
          networkApproved: false, externalApproved: false, destructiveApproved: false,
        }),
        (error) => error instanceof SessionAuthorityError && error.code === "binding_mismatch",
        label,
      );
    }
    const laterBinding = { ...launchBinding, callId: "call-2", toolName: "process.request" };
    const laterGrant = await grants.issue({
      ...laterBinding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const authorization = sessions.authorizeOperation({
      sessionId: "stream-1",
      grant: laterGrant,
      binding: laterBinding,
      operation: "request",
      requestAccess: [{ canonicalPath: workspace, mode: "write" }],
      credentialNames: [],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
    });
    assert.doesNotThrow(() => sessions.assertOperationAuthorization(authorization, {
      sessionId: "stream-1", operation: "request",
      binding: laterBinding, requestAccess: [{ canonicalPath: workspace, mode: "write" }], credentialNames: [],
      networkApproved: false, externalApproved: false, destructiveApproved: false,
    }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function backendBinding() {
  return {
    registryId: "registry-1",
    backendId: "backend-1",
    implementationGeneration: "generation-1",
    implementationDigest: "b".repeat(64),
    attestationVersion: 1,
    attestationDigest: "c".repeat(64),
    opaqueIdentity: "backend-child-1",
    birthFingerprint: {
      observedAt: "2026-08-29T00:00:00.000Z",
      discriminator: "birth-1",
    },
    startedAt: "2026-08-29T00:00:00.000Z",
  };
}
