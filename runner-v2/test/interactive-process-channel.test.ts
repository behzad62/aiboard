import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import {
  InteractiveProcessChannelError,
  createInteractiveProcessChannelRegistry,
} from "../src/interactive-process-channel.js";
import { createSessionAuthority } from "../src/session-authority.js";
import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "../src/session-authority.js";
import { createInMemoryStreamingSessionStore } from "../src/streaming-session-store.js";

test("keeps an acquired backend channel private and requires authorization for a write", async () => {
  const channel = new FakeChannel();
  const trustedAuthorization = {} as SessionOperationAuthorization;
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (authorization) => authorization === trustedAuthorization,
  });
  const attached = await registry.attach({
    sessionId: "stream-1",
    binding: backendBinding(),
    fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: {
      version: 1,
      acquire: async () => channel,
    },
  });
  assert.equal(attached, undefined);

  const payload = Buffer.from("request-body");
  await assert.rejects(
    registry.write({
      sessionId: "stream-1",
      authorization: {} as SessionOperationAuthorization,
      authorizationAssertion: testOperationAuthorization("write").authorizationAssertion,
      fencingToken: 1,
      sequence: 1,
      payload,
      byteLength: payload.byteLength,
      digest: createHash("sha256").update(payload).digest("hex"),
      timeoutMs: 1_000,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "authorization_required",
  );

  await registry.write({
    sessionId: "stream-1",
    authorization: trustedAuthorization,
    authorizationAssertion: testOperationAuthorization("write", trustedAuthorization).authorizationAssertion,
    fencingToken: 1,
    sequence: 1,
    payload,
    byteLength: payload.byteLength,
    digest: createHash("sha256").update(payload).digest("hex"),
    timeoutMs: 1_000,
  });
  assert.deepEqual(channel.writes, [{ sequence: 1, byteLength: 12 }]);
});

test("carries the exact SessionAuthority binding and access assertion into an interactive write", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-channel-authority-"));
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
    const assertion = {
      sessionId: "stream-1", operation: "write" as const, binding,
      requestAccess: [{ canonicalPath: workspace, mode: "write" as const }], credentialNames: [],
      networkApproved: false, externalApproved: false, destructiveApproved: false,
    };
    const authorization = sessions.authorizeLaunchOperation(assertion);
    const channel = new FakeChannel();
    const registry = createInteractiveProcessChannelRegistry({
      authorize: (candidate, expected) => sessions.assertOperationAuthorization(candidate, expected),
    });
    await registry.attach({
      sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: begun.record.ownerId, fencingToken: 1 },
      provider: { version: 1, acquire: async () => channel },
    });
    const payload = Buffer.from("bound-write");
    await registry.write({
      sessionId: "stream-1", authorization, authorizationAssertion: assertion, fencingToken: 1, sequence: 1,
      payload, byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
    });
    assert.deepEqual(channel.writes, [{ sequence: 1, byteLength: payload.byteLength }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closes input idempotently and refuses every write after the close", async () => {
  const channel = new FakeChannel();
  const authorization = {} as SessionOperationAuthorization;
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
  });
  await registry.attach({
    sessionId: "stream-1",
    binding: backendBinding(),
    fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  assert.equal(await registry.closeInput({
    sessionId: "stream-1", authorization, fencingToken: 1,
    authorizationAssertion: testOperationAuthorization("close_input", authorization).authorizationAssertion,
  }), true);
  assert.equal(await registry.closeInput({
    sessionId: "stream-1", authorization, fencingToken: 1,
    authorizationAssertion: testOperationAuthorization("close_input", authorization).authorizationAssertion,
  }), false);
  assert.equal(channel.closeCalls, 1);

  const payload = Buffer.from("later");
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1,
      authorizationAssertion: testOperationAuthorization("write", authorization).authorizationAssertion,
      payload, byteLength: payload.byteLength,
      digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 1_000,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "input_closed",
  );
});

test("refuses reattach unless the backend attests the exact durable binding", async () => {
  const channel = new FakeChannel();
  const binding = backendBinding();
  const registry = createInteractiveProcessChannelRegistry({
    authorize: () => true,
  });
  await assert.rejects(
    registry.reattach({
      sessionId: "stream-1",
      binding,
      fence: { ownerId: "owner-1", fencingToken: 1 },
      provider: {
        version: 1,
        acquire: async () => channel,
        reattach: async () => ({
          binding: { ...binding, backendId: "forged-backend" },
          channel,
          nextSequence: 1,
          inputClosed: false,
        }),
      },
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "input_unavailable",
  );
});

test("reattaches only with backend-attested input state and next write sequence", async () => {
  const channel = new FakeChannel();
  const authorization = {} as SessionOperationAuthorization;
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
  });
  const binding = backendBinding();
  await registry.reattach({
    sessionId: "stream-1",
    binding,
    fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: {
      version: 1,
      acquire: async () => channel,
      reattach: async () => ({ binding, channel, nextSequence: 2, inputClosed: false }),
    },
  });
  const payload = Buffer.from("after-reattach");
  await registry.write({
    sessionId: "stream-1", authorization, fencingToken: 1, sequence: 2, payload,
    authorizationAssertion: testOperationAuthorization("write", authorization).authorizationAssertion,
    byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
  });
  assert.deepEqual(channel.writes, [{ sequence: 2, byteLength: payload.byteLength }]);
});

test("clones attachment evidence and safely rejects stale attachment or reattachment without leaking channels", async () => {
  const initial = new FakeChannel();
  const replacement = new FakeChannel();
  const staleAttach = new FakeChannel();
  const staleReattach = new FakeChannel();
  const authority = testOperationAuthorization("write");
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authority.authorization,
  });
  const initialBinding = backendBinding();
  const initialFence = { ownerId: "owner-1", fencingToken: 2 };
  await registry.attach({
    sessionId: "stream-1", binding: initialBinding, fence: initialFence,
    provider: { version: 1, acquire: async () => initial },
  });
  initialBinding.backendId = "mutated-after-attach";
  initialFence.fencingToken = 99;
  const firstPayload = Buffer.from("first");
  await registry.write({
    sessionId: "stream-1", ...authority, fencingToken: 2, sequence: 1, payload: firstPayload,
    byteLength: firstPayload.byteLength, digest: createHash("sha256").update(firstPayload).digest("hex"), timeoutMs: 100,
  });

  const reattachBinding = backendBinding();
  const reattachFence = { ownerId: "owner-2", fencingToken: 3 };
  await registry.reattach({
    sessionId: "stream-1", binding: reattachBinding, fence: reattachFence,
    provider: {
      version: 1,
      acquire: async () => replacement,
      reattach: async () => ({ binding: reattachBinding, channel: replacement, nextSequence: 1, inputClosed: false }),
    },
  });
  reattachBinding.backendId = "mutated-after-reattach";
  reattachFence.fencingToken = 99;
  assert.equal(initial.detachCalls, 1);
  const replacementPayload = Buffer.from("replacement");
  await registry.write({
    sessionId: "stream-1", ...authority, fencingToken: 3, sequence: 1, payload: replacementPayload,
    byteLength: replacementPayload.byteLength,
    digest: createHash("sha256").update(replacementPayload).digest("hex"), timeoutMs: 100,
  });

  await assert.rejects(
    registry.attach({
      sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 2 },
      provider: { version: 1, acquire: async () => staleAttach },
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "stale_fence",
  );
  assert.equal(staleAttach.detachCalls, 1);

  await assert.rejects(
    registry.reattach({
      sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-0", fencingToken: 1 },
      provider: {
        version: 1,
        acquire: async () => staleReattach,
        reattach: async () => ({ binding: backendBinding(), channel: staleReattach, nextSequence: 2, inputClosed: false }),
      },
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "stale_fence",
  );
  assert.equal(staleReattach.detachCalls, 1);
  const lastPayload = Buffer.from("still-current");
  await registry.write({
    sessionId: "stream-1", ...authority, fencingToken: 3, sequence: 2, payload: lastPayload,
    byteLength: lastPayload.byteLength, digest: createHash("sha256").update(lastPayload).digest("hex"), timeoutMs: 100,
  });
  assert.deepEqual(replacement.writes, [
    { sequence: 1, byteLength: replacementPayload.byteLength },
    { sequence: 2, byteLength: lastPayload.byteLength },
  ]);
});

test("reports typed input_unavailable when attested reattach cannot be proven", async () => {
  const channel = new FakeChannel();
  const dispositions: string[] = [];
  const registry = createInteractiveProcessChannelRegistry({
    authorize: () => false,
    onDisposition: (_sessionId, _fence, disposition) => { dispositions.push(disposition); },
  });
  await assert.rejects(
    registry.reattach({
      sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
      provider: { version: 1, acquire: async () => channel, reattach: async () => undefined },
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "input_unavailable",
  );
  assert.deepEqual(dispositions, ["input_unavailable"]);
});

test("records backend_unavailable when backend-private channel acquisition fails", async () => {
  const dispositions: string[] = [];
  const registry = createInteractiveProcessChannelRegistry({
    authorize: () => false,
    onDisposition: (_sessionId, _fence, disposition) => { dispositions.push(disposition); },
  });
  await assert.rejects(
    registry.attach({
      sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
      provider: { version: 1, acquire: async () => { throw new Error("backend vanished"); } },
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "channel_unavailable",
  );
  assert.deepEqual(dispositions, ["backend_unavailable"]);
});

test("permits private output draining and terminal observation without a model-call authorization", async () => {
  const channel = new FakeChannel();
  const registry = createInteractiveProcessChannelRegistry({
    authorize: () => false,
  });
  await registry.attach({
    sessionId: "stream-1",
    binding: backendBinding(),
    fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  const privateBytes: Uint8Array[] = [];
  const unsubscribe = registry.subscribePrivateOutput({
    sessionId: "stream-1",
    sink: (bytes) => privateBytes.push(bytes),
  });
  channel.emitPrivateOutput(Buffer.from("diagnostic"));
  assert.equal(Buffer.from(privateBytes[0] ?? []).toString(), "diagnostic");
  assert.deepEqual(await registry.waitForTerminal({ sessionId: "stream-1" }), { state: "exited" });
  unsubscribe();
});

test("bounds private raw-output draining without exposing the backend channel", async () => {
  const channel = new FakeChannel();
  const registry = createInteractiveProcessChannelRegistry({
    authorize: () => false,
    maxPrivateOutputBytes: 4,
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  const chunks: Uint8Array[] = [];
  const unsubscribe = registry.subscribePrivateOutput({
    sessionId: "stream-1", sink: (bytes) => chunks.push(bytes),
  });
  channel.emitPrivateOutput(Buffer.from("eight-bytes"));
  assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(), "eigh");
  unsubscribe();
});

test("requires a current authorization before subscribing output for family delivery", async () => {
  const channel = new FakeChannel();
  const authorization = {} as SessionOperationAuthorization;
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
  });
  await registry.attach({
    sessionId: "stream-1",
    binding: backendBinding(),
    fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  assert.throws(
    () => registry.subscribeFamilyOutput({
      sessionId: "stream-1", authorization: {} as SessionOperationAuthorization, fencingToken: 1,
      authorizationAssertion: testOperationAuthorization("family_delivery").authorizationAssertion,
      deliver: () => undefined,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "authorization_required",
  );
  const familyBytes: Uint8Array[] = [];
  assert.throws(
    () => registry.subscribeFamilyOutput({
      sessionId: "stream-1", authorization, fencingToken: 2, deliver: () => undefined,
      authorizationAssertion: testOperationAuthorization("family_delivery", authorization).authorizationAssertion,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "stale_fence",
  );
  const unsubscribe = registry.subscribeFamilyOutput({
    sessionId: "stream-1", authorization, fencingToken: 1, deliver: (bytes) => familyBytes.push(bytes),
    authorizationAssertion: testOperationAuthorization("family_delivery", authorization).authorizationAssertion,
  });
  channel.emitPrivateOutput(Buffer.from("authorized-only"));
  assert.equal(Buffer.from(familyBytes[0] ?? []).toString(), "authorized-only");
  unsubscribe();
});

test("stops family output delivery after ToolBroker revokes the source call", async () => {
  const fixture = await createFamilyOutputFixture();
  try {
    const delivered: string[] = [];
    const unsubscribe = fixture.registry.subscribeFamilyOutput({
      sessionId: "stream-1", ...fixture.authority, fencingToken: 1,
      deliver: (bytes) => delivered.push(Buffer.from(bytes).toString()),
    });
    fixture.channel.emitPrivateOutput(Buffer.from("before-revoke"));
    await fixture.grants.revoke(fixture.grant, "completed");
    fixture.channel.emitPrivateOutput(Buffer.from("after-revoke"));
    assert.deepEqual(delivered, ["before-revoke"]);
    unsubscribe();
  } finally {
    await fixture.dispose();
  }
});

test("stops family output delivery after the source call grant expires", async () => {
  const fixture = await createFamilyOutputFixture(10);
  try {
    const delivered: string[] = [];
    const unsubscribe = fixture.registry.subscribeFamilyOutput({
      sessionId: "stream-1", ...fixture.authority, fencingToken: 1,
      deliver: (bytes) => delivered.push(Buffer.from(bytes).toString()),
    });
    fixture.channel.emitPrivateOutput(Buffer.from("before-expiry"));
    fixture.setNow("2026-08-29T00:00:00.011Z");
    fixture.channel.emitPrivateOutput(Buffer.from("after-expiry"));
    assert.deepEqual(delivered, ["before-expiry"]);
    unsubscribe();
  } finally {
    await fixture.dispose();
  }
});

test("stops family output delivery after fenced SessionAuthority takeover", async () => {
  const fixture = await createFamilyOutputFixture();
  try {
    const delivered: string[] = [];
    const unsubscribe = fixture.registry.subscribeFamilyOutput({
      sessionId: "stream-1", ...fixture.authority, fencingToken: 1,
      deliver: (bytes) => delivered.push(Buffer.from(bytes).toString()),
    });
    fixture.channel.emitPrivateOutput(Buffer.from("before-takeover"));
    fixture.setNow("2026-08-29T00:01:00.000Z");
    const current = fixture.store.store.readBySession("stream-1")!;
    fixture.sessions.takeover({
      sessionId: "stream-1", ownerId: current.ownerId, fencingToken: current.fencingToken,
      expectedRevision: current.revision, newOwnerId: "owner-recovered", newFencingToken: 2,
      leaseExpiresAt: "2026-08-29T00:02:00.000Z",
    });
    fixture.channel.emitPrivateOutput(Buffer.from("after-takeover"));
    assert.deepEqual(delivered, ["before-takeover"]);
    unsubscribe();
  } finally {
    await fixture.dispose();
  }
});

test("stops family output delivery after lifecycle release", async () => {
  const fixture = await createFamilyOutputFixture();
  try {
    const delivered: string[] = [];
    const unsubscribe = fixture.registry.subscribeFamilyOutput({
      sessionId: "stream-1", ...fixture.authority, fencingToken: 1,
      deliver: (bytes) => delivered.push(Buffer.from(bytes).toString()),
    });
    fixture.channel.emitPrivateOutput(Buffer.from("before-release"));
    await fixture.registry.release({ sessionId: "stream-1" });
    fixture.channel.emitPrivateOutput(Buffer.from("after-release"));
    assert.deepEqual(delivered, ["before-release"]);
    unsubscribe();
  } finally {
    await fixture.dispose();
  }
});

test("fails closed and records outcome_unknown when a write acknowledgement cannot be proven", async () => {
  const channel = new FakeChannel({ acknowledgedWrites: false });
  const authorization = {} as SessionOperationAuthorization;
  const dispositions: string[] = [];
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
    onDisposition: (_sessionId, fence, disposition) => { dispositions.push(fence.fencingToken + ":" + disposition); },
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  const payload = Buffer.from("unproven");
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1, payload,
      authorizationAssertion: testOperationAuthorization("write", authorization).authorizationAssertion,
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_outcome_unknown",
  );
  assert.deepEqual(dispositions, ["1:outcome_unknown"]);
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1, payload,
      authorizationAssertion: testOperationAuthorization("write", authorization).authorizationAssertion,
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_outcome_unknown",
  );
  assert.equal(channel.writes.length, 1);
});

test("rejects stale, mismatched, duplicate, and out-of-order writes before backend delivery", async () => {
  const channel = new FakeChannel();
  const authorization = {} as SessionOperationAuthorization;
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  const payload = Buffer.from("ordered");
  const input = {
    sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1, payload,
    authorizationAssertion: testOperationAuthorization("write", authorization).authorizationAssertion,
    byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
  };
  await assert.rejects(
    registry.write({ ...input, byteLength: input.byteLength + 1 }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_mismatch",
  );
  await assert.rejects(
    registry.write({ ...input, fencingToken: 2 }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "stale_fence",
  );
  await registry.write(input);
  await assert.rejects(
    registry.write(input),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_out_of_order",
  );
  await assert.rejects(
    registry.write({ ...input, sequence: 3 }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_out_of_order",
  );
  assert.deepEqual(channel.writes, [{ sequence: 1, byteLength: payload.byteLength }]);
});

test("serializes overlapping writes and delivers a byte copy that survives caller mutation", async () => {
  const channel = new BlockingWriteChannel();
  const authority = testOperationAuthorization("write");
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authority.authorization,
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  const firstPayload = Buffer.from("first");
  const first = registry.write({
    sessionId: "stream-1", ...authority, fencingToken: 1, sequence: 1, payload: firstPayload,
    byteLength: firstPayload.byteLength, digest: createHash("sha256").update(firstPayload).digest("hex"), timeoutMs: 100,
  });
  let second: Promise<void> | undefined;
  try {
    await channel.waitForFirstWrite();
    firstPayload[0] = "X".charCodeAt(0);
    const secondPayload = Buffer.from("second");
    second = registry.write({
      sessionId: "stream-1", ...authority, fencingToken: 1, sequence: 1, payload: secondPayload,
      byteLength: secondPayload.byteLength, digest: createHash("sha256").update(secondPayload).digest("hex"), timeoutMs: 100,
    });
    await Promise.resolve();
    assert.equal(channel.startedSequences.length, 1);
    channel.releaseFirstWrite();
    await first;
    await assert.rejects(
      second,
      (error) => error instanceof InteractiveProcessChannelError && error.code === "write_out_of_order",
    );
    assert.deepEqual(channel.startedSequences, [1]);
    assert.equal(channel.maximumInFlightWrites, 1);
    assert.deepEqual(channel.deliveredPayloads, ["first"]);
  } finally {
    channel.releaseFirstWrite();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
});

test("treats a write timeout as nonreplayable outcome_unknown", async () => {
  const channel = new FakeChannel({ delayMs: 25 });
  const authorization = {} as SessionOperationAuthorization;
  const dispositions: string[] = [];
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
    onDisposition: (_sessionId, _fence, disposition) => { dispositions.push(disposition); },
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  const payload = Buffer.from("slow");
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1, payload,
      authorizationAssertion: testOperationAuthorization("write", authorization).authorizationAssertion,
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 1,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_outcome_unknown",
  );
  assert.deepEqual(dispositions, ["outcome_unknown"]);
  assert.equal(channel.writes.length, 1);
});

test("requires authorization for graceful shutdown while lifecycle release remains backend-private", async () => {
  const channel = new FakeChannel();
  const authorization = {} as SessionOperationAuthorization;
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  await assert.rejects(
    registry.gracefulStop({
      sessionId: "stream-1", authorization: {} as SessionOperationAuthorization, fencingToken: 1,
      authorizationAssertion: testOperationAuthorization("graceful_shutdown").authorizationAssertion,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "authorization_required",
  );
  await registry.gracefulStop({
    sessionId: "stream-1", authorization, fencingToken: 1,
    authorizationAssertion: testOperationAuthorization("graceful_shutdown", authorization).authorizationAssertion,
  });
  assert.equal(channel.stopCalls, 1);
  assert.equal(await registry.release({ sessionId: "stream-1" }), true);
  assert.equal(await registry.release({ sessionId: "stream-1" }), false);
  const payload = Buffer.from("after-release");
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1, payload,
      authorizationAssertion: testOperationAuthorization("write", authorization).authorizationAssertion,
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "session_released",
  );
});

test("denies every family protocol and delivery action without a current authorization", async () => {
  const channel = new FakeChannel();
  const authorization = {} as SessionOperationAuthorization;
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  for (const operation of ["request", "parse_delivery", "input_control", "protocol_response", "family_delivery"] as const) {
    assert.throws(
      () => registry.assertFamilyActionAuthorization({
        sessionId: "stream-1", authorization: {} as SessionOperationAuthorization, fencingToken: 1, operation,
        authorizationAssertion: testOperationAuthorization(operation).authorizationAssertion,
      }),
      (error) => error instanceof InteractiveProcessChannelError && error.code === "authorization_required",
    );
    assert.doesNotThrow(() => registry.assertFamilyActionAuthorization({
      sessionId: "stream-1", authorization, fencingToken: 1, operation,
      authorizationAssertion: testOperationAuthorization(operation, authorization).authorizationAssertion,
    }));
  }
});

class FakeChannel {
  readonly writes: Array<{ sequence: number; byteLength: number }> = [];
  closeCalls = 0;
  stopCalls = 0;
  detachCalls = 0;
  privateSink?: (bytes: Uint8Array) => void;

  constructor(private readonly options: { acknowledgedWrites?: boolean; delayMs?: number } = {}) {}

  async write(input: { sequence: number; byteLength: number }, _payload: Uint8Array) {
    this.writes.push({ sequence: input.sequence, byteLength: input.byteLength });
    if (this.options.delayMs) await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    return { acknowledged: this.options.acknowledgedWrites !== false, sequence: input.sequence };
  }

  async closeInput() {
    this.closeCalls += 1;
    return { closed: true };
  }

  subscribePrivateOutput(sink: (bytes: Uint8Array) => void) {
    this.privateSink = sink;
    return () => { this.privateSink = undefined; };
  }

  async gracefulStop() {
    this.stopCalls += 1;
    return { stopped: true };
  }

  async waitForTerminal() {
    return { state: "exited" };
  }

  async detach() {
    this.detachCalls += 1;
    return { detached: true };
  }

  emitPrivateOutput(bytes: Uint8Array) {
    this.privateSink?.(bytes);
  }
}

class BlockingWriteChannel extends FakeChannel {
  readonly startedSequences: number[] = [];
  readonly deliveredPayloads: string[] = [];
  maximumInFlightWrites = 0;
  private inFlightWrites = 0;
  private releaseFirst?: () => void;
  private readonly firstWriteStarted = new Promise<void>((resolve) => { this.resolveFirstStart = resolve; });
  private resolveFirstStart!: () => void;
  private readonly firstWriteRelease = new Promise<void>((resolve) => { this.releaseFirst = resolve; });

  async write(input: { sequence: number }, payload: Uint8Array) {
    this.startedSequences.push(input.sequence);
    this.inFlightWrites += 1;
    this.maximumInFlightWrites = Math.max(this.maximumInFlightWrites, this.inFlightWrites);
    if (input.sequence === 1) {
      this.resolveFirstStart();
      await this.firstWriteRelease;
    }
    this.deliveredPayloads.push(Buffer.from(payload).toString());
    this.inFlightWrites -= 1;
    return { acknowledged: true, sequence: input.sequence };
  }

  async waitForFirstWrite() {
    await this.firstWriteStarted;
  }

  releaseFirstWrite() {
    this.releaseFirst?.();
  }
}

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

function testOperationAuthorization(
  operation: OperationAuthorizationAssertion["operation"],
  authorization = {} as SessionOperationAuthorization,
  sessionId = "stream-1",
): Readonly<{
  authorization: SessionOperationAuthorization;
  authorizationAssertion: OperationAuthorizationAssertion;
}> {
  return {
    authorization,
    authorizationAssertion: {
      sessionId,
      operation,
      binding: {
        runId: "run-1",
        sessionId: "agent-session-1",
        actor: { role: "worker", id: "worker-1" },
        toolName: "process.start",
        callId: "call-1",
        permissionProfile: "project",
      },
      requestAccess: [],
      credentialNames: [],
      networkApproved: false,
      externalApproved: false,
      destructiveApproved: false,
    },
  };
}

async function createFamilyOutputFixture(ttlMs = 120_000) {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-channel-family-output-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let now = new Date("2026-08-29T00:00:00.000Z");
  const grants = createExecutionGrantAuthority({ clock: () => now, ttlMs });
  const binding = {
    runId: "run-1", sessionId: "agent-session-1", actor: { role: "worker" as const, id: "worker-1" },
    toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
  };
  const grant = await grants.issue({
    ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
    externalApproved: false, destructiveApproved: false, networkApproved: false,
  });
  const store = createInMemoryStreamingSessionStore();
  const sessions = createSessionAuthority({ grants, sessions: store, clock: () => now });
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
  const authorizationAssertion = {
    sessionId: "stream-1", operation: "family_delivery" as const, binding,
    requestAccess: [{ canonicalPath: workspace, mode: "write" as const }], credentialNames: [],
    networkApproved: false, externalApproved: false, destructiveApproved: false,
  };
  const authorization = sessions.authorizeLaunchOperation(authorizationAssertion);
  const channel = new FakeChannel();
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate, expected) => sessions.assertOperationAuthorization(candidate, expected),
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(),
    fence: { ownerId: begun.record.ownerId, fencingToken: begun.record.fencingToken },
    provider: { version: 1, acquire: async () => channel },
  });
  return Object.freeze({
    authority: Object.freeze({ authorization, authorizationAssertion }),
    channel,
    grant,
    grants,
    registry,
    sessions,
    setNow: (value: string) => { now = new Date(value); },
    store,
    dispose: async () => { await rm(root, { recursive: true, force: true }); },
  });
}
