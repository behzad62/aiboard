import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertSubmissionHasNoSecrets, inspectSubmissionScope } from "../src/submission-guard.js";
import { inspectSubmissionTree } from "../src/submission-guard-git.js";
import { WorkspaceManager } from "../src/workspace-manager.js";
import { runGit } from "./support/git-fixture.js";
import { createChangeSet } from "../src/change-set.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { SubmissionScopeIdentity } from "../src/submission-scope-contracts.js";
import { reduceSchedulerEvent, type SchedulerEvent } from "../src/scheduler-store.js";

const claim = { writableSurfaces: ["src", "test"], forbiddenSurfaces: ["src/private"] };
const file = (path: string, added = false, addedLines: string[] = []) => ({ path, added, addedLines });

test("E2 activation retains the historical absent-policy projection and refuses unknown versions or user activation", () => {
  const event: SchedulerEvent = { runId: "e2-legacy", eventId: "e1", sequence: 1, type: "run.initialized", occurredAt: "2026-10-04T00:00:00.000Z", actor: { role: "runner", id: "factory" }, idempotencyKey: "init", payload: { objective: "Build" } };
  const legacy = reduceSchedulerEvent(undefined, event);
  assert.equal(Object.hasOwn(legacy, "submissionScopePolicyVersion"), false);
  assert.equal(Object.hasOwn(legacy, "testIntegrity"), false);
  const active = reduceSchedulerEvent(undefined, { ...event, payload: { ...event.payload, submissionScopePolicyVersion: 1 } });
  const { submissionScopePolicyVersion: version, ...unchanged } = active;
  assert.equal(version, 1); assert.deepEqual(unchanged, legacy);
  assert.throws(() => reduceSchedulerEvent(undefined, { ...event, payload: { submissionScopePolicyVersion: 2 } }), /initialization authority or version/);
  assert.throws(() => reduceSchedulerEvent(undefined, { ...event, actor: { role: "user", id: "owner" }, payload: { submissionScopePolicyVersion: 1 } }), /initialization authority or version/);
});

test("E2 stored diff retains inspected raw bytes despite textconv and forced color", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-e2-transport-")); const project = join(root, "project"); mkdirSync(project);
  const git = (args: string[]) => runGit({ cwd: project, args });
  try {
    await git(["init"]); await git(["config", "user.email", "fixture@example.invalid"]); await git(["config", "user.name", "fixture"]);
    writeFileSync(join(project, "value.txt"), "initial\n"); writeFileSync(join(project, ".gitattributes"), "value.txt diff=e2\n");
    await git(["add", "-A"]); await git(["commit", "-m", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const converter = join(root, "converter.cjs"); writeFileSync(converter, "process.stdout.write('CONVERTER_PRIVATE_OUTPUT\\n');\n");
    await git(["config", "diff.e2.textconv", `${JSON.stringify(process.execPath.replace(/\\/g, "/"))} ${JSON.stringify(converter.replace(/\\/g, "/"))}`]);
    await git(["config", "color.diff", "always"]);
    writeFileSync(join(project, "value.txt"), "allowed\n"); await git(["add", "-A"]); await git(["commit", "-m", "candidate"]);
    const revision = (await git(["rev-parse", "HEAD"])).stdout.trim();
    assert.match((await git(["show", "--textconv", `${revision}:value.txt`])).stdout, /CONVERTER_PRIVATE_OUTPUT/);
    const identity: SubmissionScopeIdentity = { version: 1, runId: "e2-transport", taskId: "T1", attempt: 1,
      sessionId: "s1", workerId: "w1", baselineRevision: baseline, contractRef: { revisionId: "r1", digest: "a".repeat(64), taskId: "T1" },
      claim: { id: "c1", packetId: "T1", laneId: "b", workerOrSessionId: "w1", acceptedBaseRevision: baseline,
        branchOrWorktree: project, writableSurfaces: ["value.txt"], forbiddenSurfaces: [], ownershipGeneration: 1, state: "claimed" } };
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const result = await createChangeSet({ execute: runGit, workspacePath: project, artifacts, evidenceArtifactHashes: ["b".repeat(64)],
      submissionScopeIdentity: identity, taskCommit: { runId: identity.runId, taskId: "T1", baselineRevision: baseline,
        revision, commits: [revision], changedPaths: ["value.txt"] } });
    const stored = (await artifacts.get(result.diffArtifactHash)).toString("utf8");
    assert.match(stored, /\+allowed/); assert.ok(!stored.includes("CONVERTER_PRIVATE_OUTPUT")); assert.ok(!stored.includes("\u001b"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E2 scope guard flags every out-of-claim, forbidden, instruction and new diary class without refusing the submission", () => {
  const findings = inspectSubmissionScope([file("outside.txt"), file("src/private/value.ts"), file("AGENTS.md"), file(".github/workflows/ci.yml"), file(".gitignore"), file("src/progress.md", true), file("src/evidence.json", true), file("src/review.md", true), file("src/test-output.txt", true)], claim);
  assert.ok(findings.some((finding) => finding.path === "outside.txt" && finding.code === "outside_claim"));
  assert.ok(findings.some((finding) => finding.path === "src/private/value.ts" && finding.code === "forbidden_surface"));
  for (const path of ["AGENTS.md", ".github/workflows/ci.yml", ".gitignore"]) assert.ok(findings.some((finding) => finding.path === path && finding.code === "instruction_surface"));
  for (const path of ["src/progress.md", "src/evidence.json", "src/review.md", "src/test-output.txt"]) assert.ok(findings.some((finding) => finding.path === path && finding.code === "harness_diary"));
  assert.ok(findings.every((finding) => finding.severity === "blocking"));
});

test("E2 scope control permits claimed product files and only flags new diary records", () => {
  assert.deepEqual(inspectSubmissionScope([file("src/value.ts", true, ["export const value = 2;"]), file("test/value.test.ts"), file("src/progress.md")], claim), []);
});

test("E2 secret refusal is redacted for each token class and newly added env/key files", () => {
  const examples = [
    "-----BEGIN RSA PRIVATE KEY-----",
    `AKIA${"A".repeat(16)}`,
    `sk-${"a".repeat(30)}`,
    `ghp_${"b".repeat(36)}`,
    `xoxb-${"1234567890".repeat(3)}`,
    `api_key = '${"literal".repeat(5)}'`,
    `{"clientSecret": "${"literal".repeat(5)}"}`,
    `API_KEY=${"literal".repeat(5)}`,
    `password: ${"literal".repeat(5)}`,
    `const api_key = \`${"literal".repeat(5)}\`;`,
    "api_key = 'hardcodedcredential${suffix}'",
    'password: "hardcodedcredential{{suffix}}"',
  ];
  for (const secret of examples) {
    assert.throws(() => assertSubmissionHasNoSecrets([file("src/settings.ts", false, [secret])]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Submission refused: secret or key material detected [REDACTED].");
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  for (const path of [".env", ".env.local", "keys/identity.pem", "keys/id_rsa", "keys/id_ed25519", "keys/certificate.p12"]) assert.throws(() => assertSubmissionHasNoSecrets([file(path, true)]), /\[REDACTED\]/);
});

test("E2 secret control ignores removed lines and nonliteral references; invalid path aliases fail closed", () => {
  assert.doesNotThrow(() => assertSubmissionHasNoSecrets([file("src/settings.ts", false, ["api_key = process.env.API_KEY;", "const value = 2;"])]));
  for (const path of ["../src/value.ts", "src/../outside.ts", "C:\\src\\value.ts", "src/./value.ts", "src//value.ts", "bad\npath"]) assert.throws(() => inspectSubmissionScope([file(path)], claim), /path identity/);
});

test("E2 real Git guard scans immutable text despite binary attributes, before task commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-e2-secret-"));
  const project = join(root, "project"); mkdirSync(project);
  const git = (args: string[]) => runGit({ cwd: project, args });
  const managerFor = (baselineRevision: string) => new WorkspaceManager({ repositoryRoot: project, stateDirectory: join(root, "state"), runId: "e2-secret", baselineRevision, execute: runGit });
  let manager: WorkspaceManager | undefined;
  try {
    await git(["init"]); await git(["config", "user.email", "fixture@example.invalid"]); await git(["config", "user.name", "fixture"]);
    await git(["config", "color.diff", "always"]);
    writeFileSync(join(project, "value.txt"), "initial\n"); await git(["add", "-A"]); await git(["commit", "-m", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim(); manager = managerFor(baseline);
    const workspace = await manager.createTaskWorkspace("T1");
    writeFileSync(join(workspace.path, ".gitattributes"), "*.txt -diff\n");
    writeFileSync(join(workspace.path, "value.txt"), `API_KEY=${"literal".repeat(5)}\n`);
    await assert.rejects(() => manager!.commitWorkspace(workspace, "worker", async (candidateRevision) => {
      await inspectSubmissionTree({ git: runGit, workspacePath: workspace.path, baselineRevision: baseline, candidateRevision, claim: { writableSurfaces: ["."], forbiddenSurfaces: [] } });
    }), /\[REDACTED\]/);
    assert.equal((await runGit({ cwd: workspace.path, args: ["rev-parse", "HEAD"] })).stdout.trim(), baseline, "secret bytes never become a task commit");
    await runGit({ cwd: workspace.path, args: ["reset", "--hard", baseline] });
  } finally { await manager?.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("E2 real Git guarded commit consumes inspected tree when the mutable index changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-e2-tree-")); const project = join(root, "project"); mkdirSync(project);
  let manager: WorkspaceManager | undefined;
  const git = (args: string[]) => runGit({ cwd: project, args });
  try {
    await git(["init"]); await git(["config", "user.email", "fixture@example.invalid"]); await git(["config", "user.name", "fixture"]);
    writeFileSync(join(project, "value.txt"), "initial\n"); await git(["add", "-A"]); await git(["commit", "-m", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim();
    manager = new WorkspaceManager({ repositoryRoot: project, stateDirectory: join(root, "state"), runId: "e2-tree", baselineRevision: baseline, execute: runGit });
    const workspace = await manager.createTaskWorkspace("T1"); writeFileSync(join(workspace.path, "value.txt"), "allowed\n");
    const committed = await manager.commitWorkspace(workspace, "worker", async (candidateRevision) => {
      assert.deepEqual(await inspectSubmissionTree({ git: runGit, workspacePath: workspace.path, baselineRevision: baseline, candidateRevision, claim: { writableSurfaces: [join(workspace.path, "value.txt")], forbiddenSurfaces: [] } }), []);
      writeFileSync(join(workspace.path, "value.txt"), `API_KEY=${"literal".repeat(5)}\n`);
      await runGit({ cwd: workspace.path, args: ["add", "-A"] });
    });
    assert.equal((await runGit({ cwd: workspace.path, args: ["show", `${committed.revision}:value.txt`] })).stdout, "allowed\n");
    const message = (await runGit({ cwd: workspace.path, args: ["log", "-1", "--format=%B"] })).stdout;
    assert.match(message, /AIBoard-Run: e2-tree/); assert.match(message, /AIBoard-Task: T1/);
    await runGit({ cwd: workspace.path, args: ["reset", "--hard", committed.revision] });
  } finally { await manager?.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("E2 real Git guarded commit refuses unsettled operations and parent replacement during inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-e2-parent-")); const project = join(root, "project"); mkdirSync(project);
  let manager: WorkspaceManager | undefined;
  const git = (args: string[]) => runGit({ cwd: project, args });
  try {
    await git(["init"]); await git(["config", "user.email", "fixture@example.invalid"]); await git(["config", "user.name", "fixture"]);
    writeFileSync(join(project, "value.txt"), "initial\n"); await git(["add", "-A"]); await git(["commit", "-m", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim();
    manager = new WorkspaceManager({ repositoryRoot: project, stateDirectory: join(root, "state"), runId: "e2-parent", baselineRevision: baseline, execute: runGit });
    const workspace = await manager.createTaskWorkspace("T1");
    const mergeHead = resolve(workspace.path, (await runGit({ cwd: workspace.path, args: ["rev-parse", "--git-path", "MERGE_HEAD"] })).stdout.trim());
    writeFileSync(mergeHead, `${baseline}\n`);
    await assert.rejects(() => manager!.commitWorkspace(workspace, "worker", async () => undefined), /settled Git operation/);
    unlinkSync(mergeHead);
    writeFileSync(join(workspace.path, "value.txt"), "allowed\n");
    const tree = (await git(["rev-parse", `${baseline}^{tree}`])).stdout.trim();
    const foreign = (await git(["commit-tree", tree, "-m", "foreign"])).stdout.trim();
    await assert.rejects(() => manager!.commitWorkspace(workspace, "worker", async () => {
      await runGit({ cwd: workspace.path, args: ["update-ref", workspace.branch, foreign, baseline] });
    }), /escaped its baseline|parent changed/);
    assert.equal((await runGit({ cwd: workspace.path, args: ["rev-parse", "HEAD"] })).stdout.trim(), foreign, "guard produced no commit after replacement");
    await runGit({ cwd: workspace.path, args: ["update-ref", workspace.branch, baseline, foreign] });
    await runGit({ cwd: workspace.path, args: ["reset", "--hard", baseline] });
    await assert.rejects(() => manager!.commitWorkspace(workspace, "existing-head", async () => {
      await runGit({ cwd: workspace.path, args: ["update-ref", workspace.branch, foreign, baseline] });
    }), /escaped its baseline|parent changed/);
    await runGit({ cwd: workspace.path, args: ["update-ref", workspace.branch, baseline, foreign] });
  } finally { await manager?.cleanup(); rmSync(root, { recursive: true, force: true }); }
});
