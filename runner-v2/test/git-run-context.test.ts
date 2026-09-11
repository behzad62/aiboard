import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createRunGitExecutionContext, gitWorkingRootsForRun } from "../src/git-run-context.js";
import { createExecutionGrantAuthority, type ConsumedExecutionGrantClaims } from "../src/execution-grants.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { ArtifactStore } from "../src/artifact-store.js";
import type { OneShotCommandRequest, OneShotCommandResult } from "../src/one-shot-command-executor.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "p6-git-context-"));
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
async function use(t: TestContext, body: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(); let failed = false;
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
