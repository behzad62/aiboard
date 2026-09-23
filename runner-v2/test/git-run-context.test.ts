import { ToolBroker } from "../src/tool-broker.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createRunGitExecutionContext, gitWorkingRootsForRun } from "../src/git-run-context.js";
import { createExecutionGrantAuthority, type ConsumedExecutionGrantClaims } from "../src/execution-grants.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { ArtifactStore } from "../src/artifact-store.js";
import type { OneShotCommandRequest, OneShotCommandResult } from "../src/one-shot-command-executor.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function canonicalPath(path: string): string {
  return realpathSync.native(path);
}
function hostNativeAliasDirectory(created: string): string | undefined {
  if (process.platform === "darwin") {
    const canonical = canonicalPath(created);
    return created === canonical ? undefined : created;
  }
  if (process.platform !== "win32") return undefined;
  try {
    const short = execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$fso = New-Object -ComObject Scripting.FileSystemObject; $fso.GetFolder(${JSON.stringify(created)}).ShortPath`,
    ], { encoding: "utf8" }).trim();
    if (!short || !existsSync(short)) return undefined;
    if (short.toLowerCase() === canonicalPath(created).toLowerCase()) return undefined;
    return short;
  } catch {
    return undefined;
  }
}
async function fixture(rootDirectory?: string) {
  const root = rootDirectory ?? await mkdtemp(join(tmpdir(), "p6-git-context-"));
  const project = join(root, "project"); const state = join(root, "state"); const foreign = join(root, "foreign");
  await mkdir(project); await mkdir(state); await mkdir(foreign);
  const grants = createExecutionGrantAuthority();
  const bytes = Buffer.from("exact Git result\n"); const digest = hash(bytes);
  const requests: OneShotCommandRequest[] = []; const claims: ConsumedExecutionGrantClaims[] = [];
  const gate = { open: true, fail: false };
  const runId = "actual-run";
  const git = createRunGitExecutionContext({ runId, projectRoot: project, stateDirectory: state,
    permissionProfile: "project", executionGrants: grants,
    assertOpen: () => { if (!gate.open) throw new Error("real run is closed"); },
    execution: { execute: async (request) => {
      requests.push(request);
      assert.ok(request.context.executionGrant);
      claims.push(grants.consume(request.context.executionGrant, { ...request.context, permissionProfile: "project" }));
      if (gate.fail) throw Object.assign(new Error("strict provider unavailable"), { code: "isolation_capability_unavailable" });
      return { process: { logicalProcessId: "exact", outcome: "exited", exitCode: 0,
        finishedAt: new Date().toISOString(), cleanup: { state: "verified_empty", verifiedAt: new Date().toISOString() },
        output: [{ stream: "stdout", tail: "display", totalBytes: bytes.length, truncated: false, spillBytes: bytes.length, spillArtifactId: digest, lossyBytes: 0 },
          { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 }] },
        enforcement: "write_confinement_exact_grant", disclosure: "provider_specific_not_universal_boundary", providerId: "synthetic-attested" } as OneShotCommandResult;
    } },
    artifacts: { stat: async () => ({ byteLength: bytes.length, hash: digest, mediaType: "application/octet-stream",
      path: join(state, "synthetic-artifact"), metadataPath: join(state, "synthetic-artifact.json"), createdAt: new Date().toISOString() }),
      get: async () => Buffer.from(bytes) } satisfies Pick<ArtifactStore, "get" | "stat">,
  });
  const context: ToolExecutionContext = { runId, sessionId: "worker-session", actor: { role: "worker", id: "worker-id" },
    callId: "actual-tool-call", toolName: "git.commit", workspacePath: project };
  context.executionGrant = await grants.issue({ ...context, callId: context.callId!, toolName: context.toolName!, permissionProfile: "project",
    workspacePath: project, access: [{ path: project, mode: "write" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
  return { root, project, state, foreign, runId, grants, git, context, gate, requests, claims };
}
async function use(t: TestContext, body: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>, rootDirectory?: string) {
  const f = await fixture(rootDirectory); let failed = false;
  t.diagnostic(`new synthetic Git context root: ${f.root}`);
  try { await body(f); } catch (error) { failed = true; throw error; }
  finally { await f.grants.revokeAll("cleanup"); if (!failed) { await rm(f.root, { recursive: true }); t.diagnostic(`released grants; removed exact root: ${f.root}`); } else t.diagnostic(`released grants; retained diagnostic root: ${f.root}`); }
}

test("run Git context gives several commands distinct child authority under the same real ToolBroker call", async (t) => use(t, async (f) => {
  const call = f.git.forCall(f.context);
  await call.run({ cwd: f.project, args: ["status"] });
  await f.git.forCall(f.context).run({ cwd: f.project, args: ["diff"] });
  assert.equal(f.requests.length, 2);
  assert.notEqual(f.claims[0]!.grantId, f.claims[1]!.grantId);
  assert.notEqual(f.claims[0]!.callId, f.claims[1]!.callId);
  for (const claims of f.claims) {
    assert.equal(claims.runId, f.runId); assert.deepEqual(claims.actor, f.context.actor);
    assert.equal(claims.sessionId, f.context.sessionId); assert.equal(claims.permissionProfile, "project");
    assert.deepEqual(claims.access, [{ canonicalPath: f.project, mode: "write" }]);
    assert.equal(claims.networkApproved, false); assert.equal(claims.externalApproved, false);
  }
  assert.equal(f.grants.activeSnapshots().length, 1);
  await f.grants.revoke(f.context.executionGrant!, "completed");
  await assert.rejects(call.run({ cwd: f.project, args: ["status"] }), /closed|revoked/i);
  assert.equal(f.requests.length, 2);
}));

test("run Git context rejects changed actor/run/call identity even when reusing a genuine token", async (t) => use(t, async (f) => {
  await f.git.forCall(f.context).run({ cwd: f.project, args: ["status"] });
  for (const changed of [{ runId: "another-run" }, { callId: "another-call" }, { actor: { ...f.context.actor, id: "another-worker" } }, { sessionId: "another-session" }, { toolName: "git.push" }]) {
    assert.throws(() => f.git.forCall({ ...f.context, ...changed }), /authority|identity/i);
  }
  assert.equal(f.requests.length, 1);
}));

test("model Git authority cannot escape its original access through the working directory", async (t) => use(t, async (f) => {
  await assert.rejects(f.git.forCall(f.context).run({ cwd: f.foreign, args: ["status"] }), /outside|access/i);
  assert.equal(f.requests.length, 0);
}));

test("Git lifecycle uses declared run ownership, never a fabricated model actor or the unrestricted host state root", async (t) => use(t, async (f) => {
  const roots = gitWorkingRootsForRun(f.project, f.state, f.runId);
  const workspace = roots.find((path) => path.includes("workspaces"))!;
  await mkdir(workspace, { recursive: true });
  await f.git.lifecycle("workspace").run({ cwd: workspace, args: ["status"] });
  const claims = f.claims[0]!;
  assert.equal(claims.actor.role, "runner_internal"); assert.match(claims.actor.id, /git.*workspace/);
  assert.equal(claims.runId, f.runId); assert.equal(claims.permissionProfile, "project");
  assert.equal(claims.networkApproved, false); assert.deepEqual(claims.credentialNames, []);
  assert.deepEqual(claims.access.map((item) => item.canonicalPath), roots);
  assert.equal(claims.access.some((item) => item.canonicalPath === f.state), false);
  assert.equal(f.grants.activeSnapshots().length, 1, "the unrelated ToolBroker token was not affected");
}));

test("Git lifecycle refuses a foreign working directory and network command before grant issuance", async (t) => use(t, async (f) => {
  const lifecycle = f.git.lifecycle("inspection");
  await assert.rejects(lifecycle.run({ cwd: f.foreign, args: ["status"] }), /owned|directory/);
  await assert.rejects(lifecycle.run({ cwd: f.project, args: ["push", "origin", "HEAD"] }), /purpose|command/i);
  assert.equal(f.requests.length, 0); assert.equal(f.grants.activeSnapshots().length, 1);
}));

test("Git lifecycle canonicalization refuses a junction escape from an owned working root", async (t) => use(t, async (f) => {
  const link = join(f.project, "foreign-link"); await symlink(f.foreign, link, "junction");
  await assert.rejects(f.git.lifecycle("inspection").run({ cwd: link, args: ["status"] }), /directory|owned|link/i);
  assert.equal(f.requests.length, 0);
}));

test("Git lifecycle accepts host-native aliases of declared roots including not-yet-created run workspaces", async (t) => {
  const created = await mkdtemp(join(process.platform === "darwin" ? "/var/tmp" : tmpdir(), "p6-git-alias-"));
  const alias = hostNativeAliasDirectory(created);
  if (!alias) {
    await rm(created, { recursive: true, force: true });
    t.skip("Host did not expose a native 8.3 or Darwin /var alias for the fixture root.");
    return;
  }
  await use(t, async (f) => {
    assert.notEqual(f.project, canonicalPath(f.project));
    const roots = gitWorkingRootsForRun(f.project, f.state, f.runId);
    const workspace = roots.find((path) => path.includes("workspaces"))!;
    assert.equal(existsSync(workspace), false, "per-run workspace must still be missing when roots are declared");
    await mkdir(workspace, { recursive: true });
    await f.git.lifecycle("workspace").run({ cwd: canonicalPath(workspace), args: ["status"] });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.workingDirectory, canonicalPath(workspace));
    assert.deepEqual(f.claims[0]!.access.map((item) => item.canonicalPath), roots.map((path) => {
      const existing = [f.project, f.state].find((root) => path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`));
      return existing ? join(canonicalPath(existing), path.slice(existing.length)) : path;
    }));
  }, alias);
});

test("Git lifecycle refuses a declared-root parent junction instead of widening the grant", async (t) => use(t, async (f) => {
  const roots = gitWorkingRootsForRun(f.project, f.state, f.runId);
  const workspace = roots.find((path) => path.includes("workspaces"))!;
  await symlink(f.foreign, dirname(workspace), "junction");
  await mkdir(join(f.foreign, basename(workspace)), { recursive: true });
  await assert.rejects(f.git.lifecycle("workspace").run({ cwd: workspace, args: ["status"] }), /directory|owned|link|symbolic/i);
  await assert.rejects(f.git.lifecycle("workspace").run({ cwd: canonicalPath(join(f.foreign, basename(workspace))), args: ["status"] }), /directory|owned|link|symbolic/i);
  assert.equal(f.requests.length, 0);
  assert.equal(f.grants.activeSnapshots().length, 1, "escaped parent junction must not mint a run-owned grant");
}));

test("Git lifecycle refuses a nested cwd alias even when the target stays inside an owned root", async (t) => use(t, async (f) => {
  const roots = gitWorkingRootsForRun(f.project, f.state, f.runId);
  const workspace = roots.find((path) => path.includes("workspaces"))!;
  const inner = join(workspace, "inner");
  const nested = join(inner, "nested");
  const alias = join(workspace, "alias");
  await mkdir(nested, { recursive: true });
  await symlink(inner, alias, "junction");
  await assert.rejects(f.git.lifecycle("inspection").run({ cwd: join(alias, "nested"), args: ["status"] }), /directory|owned|link|symbolic/i);
  assert.equal(f.requests.length, 0);
}));

test("strict Git isolation unavailability is retained without another executable or Full retry", async (t) => use(t, async (f) => {
  f.gate.fail = true;
  await assert.rejects(f.git.forCall(f.context).run({ cwd: f.project, args: ["status"] }), (error: unknown) => (error as { code: string }).code === "isolation_capability_unavailable");
  assert.equal(f.requests.length, 1); assert.equal(f.claims[0]!.permissionProfile, "project");
}));

test("closed run and missing ToolBroker authority never fall back to stateless Git execution", async (t) => use(t, async (f) => {
  assert.throws(() => f.git.forCall({ ...f.context, executionGrant: undefined }), /authority|grant/i);
  f.gate.open = false;
  assert.throws(() => f.git.forCall(f.context), /closed/);
  await assert.rejects(f.git.lifecycle("inspection").run({ cwd: f.project, args: ["status"] }), /closed/);
  assert.equal(f.requests.length, 0);
}));


test("nested repository Git reads retain separate call identity across asynchronous interleaving", async (t) => use(t, async (f) => {
  const other = { ...f.context, callId: "other-call", sessionId: "other-worker" };
  other.executionGrant = await f.grants.issue({ ...other, callId: other.callId!, toolName: other.toolName!, permissionProfile: "project",
    workspacePath: f.project, access: [{ path: f.project, mode: "write" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const first = f.git.withCall(f.context, async () => { await held; await f.git.current().run({ cwd: f.project, args: ["status"] }); });
  try { await f.git.withCall(other, async () => { await Promise.resolve(); await f.git.current().run({ cwd: f.project, args: ["diff"] }); }); }
  finally { release(); await first; }
  assert.deepEqual(f.claims.map((value) => value.sessionId), ["other-worker", "worker-session"]);
  assert.throws(() => f.git.current(), /call|context|authority/i);
  await f.grants.revoke(other.executionGrant!, "completed");
}));

test("evidence revision read and its command share one original call without consuming it twice", async (t) => use(t, async (f) => {
  await f.git.forCall(f.context).run({ cwd: f.project, args: ["rev-parse", "HEAD"] });
  await f.git.executeForCall(f.context, { executable: "declared-evidence-command", arguments: ["test"], workingDirectory: f.project, timeoutMs: 1000 });
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1]!.executable, "declared-evidence-command");
  assert.notEqual(f.claims[0]!.grantId, f.claims[1]!.grantId);
  for (const claims of f.claims) { assert.equal(claims.sessionId, f.context.sessionId); assert.deepEqual(claims.actor, f.context.actor); }
  assert.equal(f.grants.activeSnapshots().length, 1);
  await f.grants.revoke(f.context.executionGrant!, "completed");
  await assert.rejects(f.git.executeForCall(f.context, { executable: "declared-evidence-command", arguments: [], workingDirectory: f.project, timeoutMs: 1000 }), /closed|revoked/i);
  assert.equal(f.requests.length, 2);
}));

test("scoped nested Git reads never manufacture lifecycle authority when no call is active", async (t) => use(t, async (f) => {
  assert.throws(() => f.git.current(), /call|context|authority/i);
  assert.equal(f.requests.length, 0); assert.equal(f.grants.activeSnapshots()[0]!.state, "issued");
}));


test("run-owned workspace cleanup permits its required exact ref inventory", async (t) => use(t, async (f) => {
  await f.git.lifecycle("cleanup").run({ cwd: f.project, args: ["for-each-ref", "--format=%(refname)", "refs/heads/aiboard/exact/tasks/"] });
  assert.equal(f.requests.length, 1); assert.equal(f.claims[0]!.actor.id, "git:cleanup");
}));

test("historical inspection cannot reinterpret an admitted read verb as a ref mutation", async (t) => use(t, async (f) => {
  for (const args of [["branch", "-D", "owned"], ["symbolic-ref", "HEAD", "refs/heads/other"], ["symbolic-ref", "--delete", "HEAD"]])
    await assert.rejects(f.git.lifecycle("inspection").run({ cwd: f.project, args }), /purpose|command|inspection/i);
  assert.equal(f.requests.length, 0);
}));


test("actual ToolBroker carries exact per-call Git authority without changing guarded approval policy", async (t) => use(t, async (f) => {
  const broker = new ToolBroker({ permissionProfile: "guarded", workspacePath: f.project, executionGrants: f.grants, git: f.git });
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  broker.register({
    definition: { name: "repo.read", description: "controlled repository inspection", inputSchema: { type: "object" }, readOnly: true, effect: "none" },
    validate: (value) => ({ ok: true, value }),
    execute: async (_value, context) => {
      if (context.sessionId === "first-reader") { entered(); await pending; }
      const result = await f.git.current().run({ cwd: f.project, args: ["status"] });
      return { isError: false, content: [{ type: "text", text: result.stdout }] };
    },
  });
  broker.register({
    definition: { name: "repo.publish", description: "external operation denied by guarded", inputSchema: { type: "object" }, readOnly: false, effect: "external" },
    validate: (value) => ({ ok: true, value }), assessAccess: () => ({ capability: "repo.publish", external: true }),
    execute: async () => assert.fail("run isolation profile must not override guarded tool approval"),
  });
  const base = { runId: f.runId, actor: { role: "worker" as const, id: "broker-worker" }, workspacePath: f.project };
  const first = broker.invoke({ type: "tool_call", callId: "first", name: "repo.read", arguments: {} }, { ...base, sessionId: "first-reader" });
  await started;
  try {
    const second = await broker.invoke({ type: "tool_call", callId: "second", name: "repo.read", arguments: {} }, { ...base, sessionId: "second-reader" });
    assert.equal(second.isError, false);
  } finally { release(); }
  assert.equal((await first).isError, false);
  assert.deepEqual(f.claims.map((claim) => claim.sessionId), ["second-reader", "first-reader"]);
  for (const claim of f.claims) {
    assert.equal(claim.permissionProfile, "project", "exact execution profile comes from the owning run");
    assert.deepEqual(claim.actor, base.actor); assert.equal(claim.toolName, "repo.read");
    assert.deepEqual(claim.access, [{ canonicalPath: f.project, mode: "read" }]);
  }
  assert.equal(f.grants.activeSnapshots().length, 1, "both broker parents and every command child are revoked");
  const denied = await broker.invoke({ type: "tool_call", callId: "denied", name: "repo.publish", arguments: {} }, { ...base, sessionId: "first-reader" });
  assert.equal(denied.isError, true); assert.equal(denied.error?.code, "approval_required");
  assert.equal(f.requests.length, 2);
  assert.throws(() => f.git.current(), /call|context|authority/i);
}));
