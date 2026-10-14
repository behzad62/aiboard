import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionGrantError,
  RESERVED_TRUSTED_NATIVE_PATCH_TOOL,
  assertCurrentConsumedExecutionGrantClaims,
  createExecutionGrantAuthority,
  registerConsumedExecutionGrantRevoker,
  reserveExecutionGrantForFilesystemMutation,
} from "../src/execution-grants.js";

test("issues a canonical opaque grant and consumes it for exactly its bound call", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  const now = new Date("2026-08-28T10:00:00.000Z");
  try {
    const authority = createExecutionGrantAuthority({ clock: () => now, ttlMs: 1_000 });
    const grant = await authority.issue({
      runId: "run-1",
      sessionId: "session-1",
      actor: { role: "worker", id: "worker-1" },
      toolName: "process.run",
      callId: "call-1",
      permissionProfile: "project",
      workspacePath: workspace,
      access: [
        { path: ".", mode: "write" },
        { path: outside, mode: "read" },
      ],
      externalApproved: true,
      destructiveApproved: false,
      networkApproved: false,
    });

    assert.deepEqual(Object.keys(grant), []);
    assert.equal(JSON.stringify(grant), "{}");
    const binding = {
      runId: "run-1",
      sessionId: "session-1",
      actor: { role: "worker", id: "worker-1" },
      toolName: "process.run",
      callId: "call-1",
      permissionProfile: "project",
    } as const;
    const foreignAuthority = createExecutionGrantAuthority();
    assert.throws(
      () => foreignAuthority.consume(grant, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_forged",
    );
    await assert.rejects(
      foreignAuthority.revoke(grant, "completed"),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_forged",
    );
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => authority.consume(grant, binding)),
      Promise.resolve().then(() => authority.consume(grant, binding)),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    const consumed = attempts.find((attempt) => attempt.status === "fulfilled")!.value;
    assert.equal(consumed.workspacePath, await import("node:fs/promises").then((fs) => fs.realpath(workspace)));
    assert.deepEqual(consumed.access.map((entry) => entry.mode), ["write", "read"]);
    assert.equal(consumed.externalApproved, true);
    assert.equal(consumed.destructiveApproved, false);
    assert.match(consumed.nonce, /^[a-f0-9]{32}$/);
    assert.throws(
      () => authority.consume(grant, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_consumed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains only the bounded approved credential names in consumed claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-credentials-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const authority = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await authority.issue({
      ...binding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" }],
      credentialNames: ["SERVICE_TOKEN", "DB_CERT"],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    const claims = authority.consume(grant, binding);
    assert.deepEqual(claims.credentialNames, ["SERVICE_TOKEN", "DB_CERT"]);
    assert.throws(
      () => (claims.credentialNames as string[]).push("FORGED"),
      TypeError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clones every public credential-name result instead of sharing authority-owned arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-credential-clone-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const authority = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await authority.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      credentialNames: ["SERVICE_TOKEN"], externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const consumed = authority.consume(grant, binding);
    const snapshot = authority.activeSnapshots()[0]!;
    assert.notStrictEqual(snapshot.credentialNames, consumed.credentialNames);
    assert.deepEqual(snapshot.credentialNames, consumed.credentialNames);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("makes consumed claims unusable after the ToolBroker revokes their opaque grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-current-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const authority = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1", sessionId: "session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await authority.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const claims = authority.consume(grant, binding);
    assert.equal(assertCurrentConsumedExecutionGrantClaims(claims), claims);
    await authority.revoke(grant, "completed");
    assert.throws(
      () => assertCurrentConsumedExecutionGrantClaims(claims),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_revoked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observing expired consumed claims leaves exactly-once cleanup to ToolBroker revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-expiry-owner-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let now = new Date("2026-08-29T00:00:00.000Z");
  try {
    const authority = createExecutionGrantAuthority({ clock: () => now, ttlMs: 10 });
    const binding = {
      runId: "run-1", sessionId: "session-1", actor: { role: "worker" as const, id: "worker-1" },
      toolName: "process.start", callId: "call-1", permissionProfile: "project" as const,
    };
    const grant = await authority.issue({
      ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    const claims = authority.consume(grant, binding);
    let cleanupCalls = 0;
    await registerConsumedExecutionGrantRevoker(claims, async () => { cleanupCalls += 1; });
    now = new Date("2026-08-29T00:00:00.010Z");

    assert.throws(
      () => assertCurrentConsumedExecutionGrantClaims(claims),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_expired",
    );
    assert.equal(cleanupCalls, 0);
    assert.equal(await authority.revoke(grant, "timed_out"), true);
    assert.equal(cleanupCalls, 1);
    assert.equal(await authority.revoke(grant, "timed_out"), false);
    assert.equal(cleanupCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("denies forged, mismatched, escalated, expired, revoked, and restarted grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-deny-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let now = new Date("2026-08-28T10:00:00.000Z");
  const binding = {
    runId: "run-1",
    sessionId: "session-1",
    actor: { role: "worker" as const, id: "worker-1" },
    toolName: "process.run",
    callId: "call-1",
    permissionProfile: "guarded" as const,
  };
  try {
    const authority = createExecutionGrantAuthority({ clock: () => now, ttlMs: 100 });
    const issue = () => authority.issue({
      ...binding,
      workspacePath: workspace,
      access: [{ path: ".", mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });

    assert.throws(
      () => authority.consume({} as never, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_forged",
    );
    for (const changed of [
      { runId: "other" },
      { sessionId: "other" },
      { callId: "other" },
      { toolName: "fs.write" },
      { actor: { role: "worker" as const, id: "other" } },
      { permissionProfile: "full" as const },
    ]) {
      const grant = await issue();
      assert.throws(
        () => authority.consume(grant, { ...binding, ...changed }),
        (error) => error instanceof ExecutionGrantError && error.code === "grant_mismatch",
      );
    }

    const expired = await issue();
    now = new Date("2026-08-28T10:00:00.101Z");
    assert.throws(
      () => authority.consume(expired, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_expired",
    );
    now = new Date("2026-08-28T10:00:00.000Z");
    const revoked = await issue();
    assert.equal(await authority.revoke(revoked, "cancelled"), true);
    assert.throws(
      () => authority.consume(revoked, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_revoked",
    );
    const beforeRestart = await issue();
    await authority.revokeAll("restart");
    assert.throws(
      () => authority.consume(beforeRestart, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_revoked",
    );
    assert.equal(authority.activeSnapshots().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects access escalation and symbolic canonical roots before issuance", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-path-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const authority = createExecutionGrantAuthority();
    await assert.rejects(
      authority.issue({
        runId: "run",
        sessionId: "session",
        actor: { role: "worker", id: "worker" },
        toolName: "process.run",
        callId: "call",
        permissionProfile: "project",
        workspacePath: workspace,
        access: [{ path: join(workspace, ".."), mode: "write" }],
        externalApproved: false,
        destructiveApproved: false,
        networkApproved: false,
      }),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_escalation",
    );
    await assert.rejects(
      authority.issue({
        runId: "run", sessionId: "session", actor: { role: "worker", id: "worker" },
        toolName: "process.run", callId: "conflict", permissionProfile: "project",
        workspacePath: workspace,
        access: [{ path: workspace, mode: "read" }, { path: join(workspace, "."), mode: "write" }],
        externalApproved: false, destructiveApproved: false, networkApproved: false,
      }),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_escalation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart and cancellation close an asynchronous issuance barrier", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-race-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  try {
    const authority = createExecutionGrantAuthority({ beforeIssueCommit: () => barrier });
    const request = {
      runId: "run", sessionId: "session", actor: { role: "worker" as const, id: "worker" },
      toolName: "process.run", callId: "call", permissionProfile: "project" as const,
      workspacePath: workspace, access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    };
    const issuing = authority.issue(request);
    await new Promise((resolve) => setImmediate(resolve));
    await authority.revokeAll("restart");
    release();
    await assert.rejects(issuing, (error) => error instanceof ExecutionGrantError && error.code === "grant_revoked");

    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      authority.issue({ ...request, signal: cancelled.signal }),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_revoked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem reservation allows the reserved trusted native adapter with exact same binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-reserve-native-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    assert.equal(RESERVED_TRUSTED_NATIVE_PATCH_TOOL, "openrouter.apply_patch");
    const authority = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1",
      sessionId: "session-1",
      actor: { role: "worker" as const, id: "worker-1" },
      toolName: "openrouter.apply_patch",
      callId: "call-1",
      permissionProfile: "project" as const,
    };
    const grant = await authority.issue({
      ...binding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    const reservation = reserveExecutionGrantForFilesystemMutation(authority, grant, binding);
    assert.equal(reservation.destructiveApproved, false);
    assert.equal(reservation.access.length, 1);
    reservation.assertCurrent();
    assert.throws(
      () => reserveExecutionGrantForFilesystemMutation(authority, grant, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_consumed"
    );
    await authority.revoke(grant, "cleanup");
    assert.throws(
      () => reservation.assertCurrent(),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_revoked"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem reservation still allows the four native names with exact binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-reserve-fs-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const authority = createExecutionGrantAuthority();
    for (const toolName of ["fs.write", "fs.patch", "fs.move", "fs.delete"] as const) {
      const binding = {
        runId: "run-1",
        sessionId: "session-1",
        actor: { role: "worker" as const, id: "worker-1" },
        toolName,
        callId: `call-${toolName}`,
        permissionProfile: "project" as const,
      };
      const grant = await authority.issue({
        ...binding,
        workspacePath: workspace,
        access: [{ path: workspace, mode: "write" as const }],
        externalApproved: false,
        destructiveApproved: toolName === "fs.delete",
        networkApproved: false,
      });
      const reservation = reserveExecutionGrantForFilesystemMutation(authority, grant, binding);
      assert.equal(reservation.destructiveApproved, toolName === "fs.delete");
      await authority.revoke(grant, "cleanup");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem reservation rejects generic aliases and rewritten bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-reserve-alias-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const authority = createExecutionGrantAuthority();
    const nativeBinding = {
      runId: "run-1",
      sessionId: "session-1",
      actor: { role: "worker" as const, id: "worker-1" },
      toolName: "openrouter.apply_patch",
      callId: "call-1",
      permissionProfile: "project" as const,
    };
    const nativeGrant = await authority.issue({
      ...nativeBinding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    assert.throws(
      () => reserveExecutionGrantForFilesystemMutation(authority, nativeGrant, { ...nativeBinding, toolName: "fs.write" }),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_mismatch"
    );
    await authority.revoke(nativeGrant, "cleanup");

    const fsBinding = {
      runId: "run-1",
      sessionId: "session-1",
      actor: { role: "worker" as const, id: "worker-1" },
      toolName: "fs.write" as const,
      callId: "call-2",
      permissionProfile: "project" as const,
    };
    const fsGrant = await authority.issue({
      ...fsBinding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    assert.throws(
      () => reserveExecutionGrantForFilesystemMutation(authority, fsGrant, { ...fsBinding, toolName: "openrouter.apply_patch" }),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_mismatch"
    );
    await authority.revoke(fsGrant, "cleanup");

    for (const toolName of ["evil.tool", "openrouter.apply_patch.evil", "fs.write.evil"]) {
      const binding = {
        runId: "run-1",
        sessionId: "session-1",
        actor: { role: "worker" as const, id: "worker-1" },
        toolName,
        callId: `call-${toolName}`,
        permissionProfile: "project" as const,
      };
      const grant = await authority.issue({
        ...binding,
        workspacePath: workspace,
        access: [{ path: workspace, mode: "write" as const }],
        externalApproved: false,
        destructiveApproved: false,
        networkApproved: false,
      });
      assert.throws(
        () => reserveExecutionGrantForFilesystemMutation(authority, grant, binding),
        (error) => error instanceof ExecutionGrantError && error.code === "grant_mismatch"
      );
      await authority.revoke(grant, "cleanup");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem reservation retains revoked, expired, consumed, and issuer refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "runner-grant-reserve-current-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    const authority = createExecutionGrantAuthority();
    const binding = {
      runId: "run-1",
      sessionId: "session-1",
      actor: { role: "worker" as const, id: "worker-1" },
      toolName: "openrouter.apply_patch",
      callId: "call-1",
      permissionProfile: "project" as const,
    };
    const revoked = await authority.issue({
      ...binding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    await authority.revoke(revoked, "cancelled");
    assert.throws(
      () => reserveExecutionGrantForFilesystemMutation(authority, revoked, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_revoked"
    );

    const consumedGrant = await authority.issue({
      ...binding,
      callId: "call-consumed",
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    authority.consume(consumedGrant, { ...binding, callId: "call-consumed" });
    assert.throws(
      () => reserveExecutionGrantForFilesystemMutation(authority, consumedGrant, { ...binding, callId: "call-consumed" }),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_consumed"
    );
    await authority.revoke(consumedGrant, "cleanup");

    const foreign = createExecutionGrantAuthority();
    const crossGrant = await authority.issue({
      ...binding,
      callId: "call-cross",
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    assert.throws(
      () => reserveExecutionGrantForFilesystemMutation(foreign, crossGrant, { ...binding, callId: "call-cross" }),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_forged"
    );
    await authority.revoke(crossGrant, "cleanup");

    let now = new Date("2026-08-28T10:00:00.000Z");
    const expiring = createExecutionGrantAuthority({ clock: () => now, ttlMs: 10 });
    const expiringGrant = await expiring.issue({
      ...binding,
      workspacePath: workspace,
      access: [{ path: workspace, mode: "write" as const }],
      externalApproved: false,
      destructiveApproved: false,
      networkApproved: false,
    });
    now = new Date("2026-08-28T10:00:00.020Z");
    assert.throws(
      () => reserveExecutionGrantForFilesystemMutation(expiring, expiringGrant, binding),
      (error) => error instanceof ExecutionGrantError && error.code === "grant_expired"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
