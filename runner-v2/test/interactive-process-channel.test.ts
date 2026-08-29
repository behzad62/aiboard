import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  InteractiveProcessChannelError,
  createInteractiveProcessChannelRegistry,
} from "../src/interactive-process-channel.js";

test("keeps an acquired backend channel private and requires authorization for a write", async () => {
  const channel = new FakeChannel();
  const trustedAuthorization = {};
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
      authorization: {},
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
    fencingToken: 1,
    sequence: 1,
    payload,
    byteLength: payload.byteLength,
    digest: createHash("sha256").update(payload).digest("hex"),
    timeoutMs: 1_000,
  });
  assert.deepEqual(channel.writes, [{ sequence: 1, byteLength: 12 }]);
});

test("closes input idempotently and refuses every write after the close", async () => {
  const channel = new FakeChannel();
  const authorization = {};
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
  }), true);
  assert.equal(await registry.closeInput({
    sessionId: "stream-1", authorization, fencingToken: 1,
  }), false);
  assert.equal(channel.closeCalls, 1);

  const payload = Buffer.from("later");
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1,
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
  const authorization = {};
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
    byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
  });
  assert.deepEqual(channel.writes, [{ sequence: 2, byteLength: payload.byteLength }]);
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
  const authorization = {};
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
      sessionId: "stream-1", authorization: {}, fencingToken: 1, deliver: () => undefined,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "authorization_required",
  );
  const familyBytes: Uint8Array[] = [];
  assert.throws(
    () => registry.subscribeFamilyOutput({
      sessionId: "stream-1", authorization, fencingToken: 2, deliver: () => undefined,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "stale_fence",
  );
  const unsubscribe = registry.subscribeFamilyOutput({
    sessionId: "stream-1", authorization, fencingToken: 1, deliver: (bytes) => familyBytes.push(bytes),
  });
  channel.emitPrivateOutput(Buffer.from("authorized-only"));
  assert.equal(Buffer.from(familyBytes[0] ?? []).toString(), "authorized-only");
  unsubscribe();
});

test("fails closed and records outcome_unknown when a write acknowledgement cannot be proven", async () => {
  const channel = new FakeChannel({ acknowledgedWrites: false });
  const authorization = {};
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
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_outcome_unknown",
  );
  assert.deepEqual(dispositions, ["1:outcome_unknown"]);
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1, payload,
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_outcome_unknown",
  );
  assert.equal(channel.writes.length, 1);
});

test("rejects stale, mismatched, duplicate, and out-of-order writes before backend delivery", async () => {
  const channel = new FakeChannel();
  const authorization = {};
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

test("treats a write timeout as nonreplayable outcome_unknown", async () => {
  const channel = new FakeChannel({ delayMs: 25 });
  const authorization = {};
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
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 1,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "write_outcome_unknown",
  );
  assert.deepEqual(dispositions, ["outcome_unknown"]);
  assert.equal(channel.writes.length, 1);
});

test("requires authorization for graceful shutdown while lifecycle release remains backend-private", async () => {
  const channel = new FakeChannel();
  const authorization = {};
  const registry = createInteractiveProcessChannelRegistry({
    authorize: (candidate) => candidate === authorization,
  });
  await registry.attach({
    sessionId: "stream-1", binding: backendBinding(), fence: { ownerId: "owner-1", fencingToken: 1 },
    provider: { version: 1, acquire: async () => channel },
  });
  await assert.rejects(
    registry.gracefulStop({ sessionId: "stream-1", authorization: {}, fencingToken: 1 }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "authorization_required",
  );
  await registry.gracefulStop({ sessionId: "stream-1", authorization, fencingToken: 1 });
  assert.equal(channel.stopCalls, 1);
  assert.equal(await registry.release({ sessionId: "stream-1" }), true);
  assert.equal(await registry.release({ sessionId: "stream-1" }), false);
  const payload = Buffer.from("after-release");
  await assert.rejects(
    registry.write({
      sessionId: "stream-1", authorization, fencingToken: 1, sequence: 1, payload,
      byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 100,
    }),
    (error) => error instanceof InteractiveProcessChannelError && error.code === "session_released",
  );
});

test("denies every family protocol and delivery action without a current authorization", async () => {
  const channel = new FakeChannel();
  const authorization = {};
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
        sessionId: "stream-1", authorization: {}, fencingToken: 1, operation,
      }),
      (error) => error instanceof InteractiveProcessChannelError && error.code === "authorization_required",
    );
    assert.doesNotThrow(() => registry.assertFamilyActionAuthorization({
      sessionId: "stream-1", authorization, fencingToken: 1, operation,
    }));
  }
});

class FakeChannel {
  readonly writes: Array<{ sequence: number; byteLength: number }> = [];
  closeCalls = 0;
  stopCalls = 0;
  privateSink?: (bytes: Uint8Array) => void;

  constructor(private readonly options: { acknowledgedWrites?: boolean; delayMs?: number } = {}) {}

  async write(input: { sequence: number; byteLength: number }) {
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
    return { detached: true };
  }

  emitPrivateOutput(bytes: Uint8Array) {
    this.privateSink?.(bytes);
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
