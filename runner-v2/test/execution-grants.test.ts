import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ExecutionGrantError,
  createExecutionGrantAuthority,
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
