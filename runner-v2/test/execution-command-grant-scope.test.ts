import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createExecutionGrantAuthority, createExecutionCommandGrantScope,
  assertCurrentConsumedExecutionGrantClaims, registerConsumedExecutionGrantRevoker,
  reserveConsumedExecutionGrantForIsolation, type ExecutionGrantBinding } from "../src/execution-grants.js";

const at = "2026-09-11T00:00:00.000Z";
const binding: ExecutionGrantBinding = { runId: "exact-run", sessionId: "real-worker-session", actor: { role: "worker", id: "real-worker" }, toolName: "git.commit", callId: "parent-call", permissionProfile: "project" };
async function withFixture(t: TestContext, body: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(); let failed = false;
  t.diagnostic(`acquired synthetic command-authority root: ${f.root}`);
  try { await body(f); } catch (error) { failed = true; throw error; }
  finally {
    await f.grants.revokeAll("cleanup");
    if (!failed) { await rm(f.root, { recursive: true }); t.diagnostic(`closed grants; removed exact root: ${f.root}`); }
    else t.diagnostic(`closed grants; diagnostic root retained: ${f.root}`);
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "p6-git-grant-"));
  let now = new Date(at);
  const grants = createExecutionGrantAuthority({ clock: () => now, ttlMs: 2_000 });
  const grant = await grants.issue({ ...binding, workspacePath: root, access: [{ path: root, mode: "write" }],
    credentialNames: ["DECLARED_TOKEN"], externalApproved: false, destructiveApproved: false, networkApproved: false });
  return { root, grants, grant, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}

test("command scope consumes one parent and derives distinct same-authority bounded invocations", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  try {
    const first = scope.next(); const second = scope.next();
    const a = f.grants.consume(first.grant, first.binding); const b = f.grants.consume(second.grant, second.binding);
    assert.notEqual(a.grantId, b.grantId); assert.notEqual(a.callId, b.callId);
    assert.equal(a.runId, binding.runId); assert.equal(a.sessionId, binding.sessionId); assert.deepEqual(a.actor, binding.actor);
    assert.equal(a.toolName, binding.toolName); assert.equal(a.permissionProfile, binding.permissionProfile);
    assert.equal(a.expiresAt, "2026-09-11T00:00:02.000Z");
    assert.deepEqual(a.access, b.access); assert.equal(a.access[0]!.canonicalPath, f.root);
    assert.deepEqual(a.credentialNames, ["DECLARED_TOKEN"]);
    assert.equal(a.externalApproved, false); assert.equal(a.destructiveApproved, false); assert.equal(a.networkApproved, false);
    reserveConsumedExecutionGrantForIsolation(a); reserveConsumedExecutionGrantForIsolation(b);
    assert.throws(() => reserveConsumedExecutionGrantForIsolation(a), (error: unknown) => (error as { code: string }).code === "grant_consumed");
    await first.release(); await second.release();
    assert.equal(f.grants.activeSnapshots().length, 1, "only the original ToolBroker-owned parent remains");
    assert.equal(f.grants.activeSnapshots()[0]!.state, "consumed");
    assert.throws(() => f.grants.consume(f.grant, binding), (error: unknown) => (error as { code: string }).code === "grant_consumed");
  } finally { await scope.close(); }
}));

test("command scope release never revokes its ToolBroker-owned parent", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  const child = scope.next(); await child.release(); await scope.close();
  assert.equal(f.grants.activeSnapshots().length, 1);
  assert.equal(f.grants.activeSnapshots()[0]!.state, "consumed");
  assert.equal(await f.grants.revoke(f.grant, "completed"), true);
  assert.deepEqual(f.grants.activeSnapshots(), []);
}));

test("parent revocation aborts and revokes every derived command before allowing another", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  const a = scope.next(); const b = scope.next();
  const consumed = f.grants.consume(a.grant, a.binding);
  let cleanup = 0; await registerConsumedExecutionGrantRevoker(consumed, async () => { cleanup++; });
  await f.grants.revoke(f.grant, "cancelled");
  assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, true); assert.equal(cleanup, 1);
  assert.throws(() => scope.next(), /revoked|closed/i);
  assert.throws(() => assertCurrentConsumedExecutionGrantClaims(consumed), (error: unknown) => (error as { code: string }).code === "grant_revoked");
  assert.deepEqual(f.grants.activeSnapshots(), []); await scope.close();
}));

test("scope expiry cannot extend the parent lifetime by issuing a later child", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  f.advance(1_500); const child = scope.next(); const claims = f.grants.consume(child.grant, child.binding);
  assert.equal(claims.expiresAt, "2026-09-11T00:00:02.000Z");
  f.advance(500);
  assert.throws(() => scope.next(), (error: unknown) => (error as { code: string }).code === "grant_expired");
  assert.throws(() => assertCurrentConsumedExecutionGrantClaims(claims), (error: unknown) => (error as { code: string }).code === "grant_expired");
  await scope.close();
}));

test("scope rejects a foreign issuing authority without consuming the parent's authority", async (t) => withFixture(t, async (f) => {
  const foreign = createExecutionGrantAuthority();
  await assert.rejects(createExecutionCommandGrantScope({ authority: foreign, parentGrant: f.grant, binding }),
    (error: unknown) => (error as { code: string }).code === "grant_forged");
  assert.equal(f.grants.activeSnapshots()[0]!.state, "issued");
}));

test("scope is permanently closed after an explicit close and cannot be re-created from a consumed parent", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  await scope.close(); await scope.close(); assert.throws(() => scope.next(), /closed/i);
  await assert.rejects(createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding }),
    (error: unknown) => (error as { code: string }).code === "grant_consumed");
}));

test("scope does not mint child authority when the caller signal is already cancelled", async (t) => withFixture(t, async (f) => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding, signal: abort.signal }), /cancelled|revoked/i);
  assert.equal(f.grants.activeSnapshots().length, 1); assert.equal(f.grants.activeSnapshots()[0]!.state, "issued");
}));

test("scope signals active children on cancellation and joins their registered cleanup", async (t) => withFixture(t, async (f) => {
  const abort = new AbortController(); const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding, signal: abort.signal });
  const child = scope.next(); const claims = f.grants.consume(child.grant, child.binding);
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  let entered = false; await registerConsumedExecutionGrantRevoker(claims, async () => { entered = true; await pending; });
  abort.abort(); await Promise.resolve(); assert.equal(child.signal.aborted, true); assert.equal(entered, true);
  let closed = false; const closing = scope.close().then(() => { closed = true; });
  try { await Promise.resolve(); assert.equal(closed, false); }
  finally { release(); await closing; }
  assert.equal(closed, true);
}));

test("scope close preserves an undefined provider-cleanup rejection rather than certifying success", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  const child = scope.next(); const claims = f.grants.consume(child.grant, child.binding);
  await registerConsumedExecutionGrantRevoker(claims, async () => { throw undefined; });
  const result = await scope.close().then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  assert.equal(result.ok, false); if (result.ok) assert.fail("cleanup failure was swallowed");
  assert.ok(result.error instanceof AggregateError);
  const repeated = await scope.close().then(() => undefined, (error: unknown) => error);
  assert.equal(repeated, result.error, "failed retained cleanup is not converted to a later successful replay");
  await assert.rejects(f.grants.revoke(f.grant, "completed"),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === result.error,
    "ToolBroker's parent revocation must observe the same retained cleanup failure");
}));

test("ToolBroker parent revocation joins cleanup already started by caller cancellation", async (t) => withFixture(t, async (f) => {
  const abort = new AbortController();
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding, signal: abort.signal });
  const child = scope.next(); const claims = f.grants.consume(child.grant, child.binding);
  let finish!: () => void; const pending = new Promise<void>((resolve) => { finish = resolve; });
  let entered = false;
  await registerConsumedExecutionGrantRevoker(claims, async () => { entered = true; await pending; });
  abort.abort();
  let parentFinished = false;
  const revoking = f.grants.revoke(f.grant, "cancelled").then(() => { parentFinished = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(entered, true);
    assert.equal(parentFinished, false, "removing the parent callback early must not turn pending cleanup into completed revocation");
  } finally { finish(); await revoking; await scope.close(); }
  assert.equal(parentFinished, true);
  assert.deepEqual(f.grants.activeSnapshots(), []);
}));

test("ToolBroker receives a cancellation cleanup failure even when it revokes after the callback failed", async (t) => withFixture(t, async (f) => {
  const abort = new AbortController();
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding, signal: abort.signal });
  const child = scope.next(); const claims = f.grants.consume(child.grant, child.binding);
  await registerConsumedExecutionGrantRevoker(claims, async () => { throw undefined; });
  abort.abort();
  const scopeFailure = await scope.close().then(() => assert.fail("undefined cleanup must fail"), (error: unknown) => error);
  assert.ok(scopeFailure instanceof AggregateError);
  await assert.rejects(f.grants.revoke(f.grant, "cancelled"),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === scopeFailure);
  assert.deepEqual(f.grants.activeSnapshots(), []);
}));

test("scope copies immutable parent identities and rejects a changed binding", async (t) => withFixture(t, async (f) => {
  const changed = { ...binding, actor: { ...binding.actor } };
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding: changed });
  changed.actor.id = "foreign"; changed.runId = "foreign";
  const child = scope.next(); assert.equal(child.binding.runId, binding.runId); assert.deepEqual(child.binding.actor, binding.actor);
  await child.release(); await scope.close();
}));

test("revocation's synchronous abort callback cannot consume a child before its cleanup callback runs", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  const child = scope.next(); let accepted = false; let code: string | undefined;
  child.signal.addEventListener("abort", () => {
    try { f.grants.consume(child.grant, child.binding); accepted = true; }
    catch (error) { code = (error as { code?: string }).code; }
  }, { once: true });
  await f.grants.revoke(f.grant, "cancelled");
  assert.equal(accepted, false); assert.equal(code, "grant_revoked");
  await scope.close();
}));

test("revocation's synchronous abort callback cannot reserve consumed child authority for a new process", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  const child = scope.next(); const claims = f.grants.consume(child.grant, child.binding);
  let accepted = false; let code: string | undefined;
  child.signal.addEventListener("abort", () => {
    try { reserveConsumedExecutionGrantForIsolation(claims); accepted = true; }
    catch (error) { code = (error as { code?: string }).code; }
  }, { once: true });
  await f.grants.revoke(f.grant, "cancelled");
  assert.equal(accepted, false); assert.equal(code, "grant_revoked");
  await scope.close();
}));

test("command scopes have a fixed invocation cap even when every earlier command is released", async (t) => withFixture(t, async (f) => {
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  try {
    for (let index = 0; index < 1024; index++) await scope.next().release();
    assert.throws(() => scope.next(), (error: unknown) => (error as { code: string }).code === "grant_escalation");
    assert.equal(f.grants.activeSnapshots().length, 1);
  } finally { await scope.close(); }
}));

test("command scope authorizes only canonical directories within its original grant access", async (t) => withFixture(t, async (f) => {
  const nested = join(f.root, "nested"); await mkdir(nested);
  const scope = await createExecutionCommandGrantScope({ authority: f.grants, parentGrant: f.grant, binding });
  try {
    assert.equal(await scope.authorizeDirectory(nested), nested);
    await assert.rejects(scope.authorizeDirectory(tmpdir()), (error: unknown) => (error as { code: string }).code === "grant_escalation");
    await f.grants.revoke(f.grant, "completed");
    await assert.rejects(scope.authorizeDirectory(nested), /revoked|closed/i);
  } finally { await scope.close(); }
}));
