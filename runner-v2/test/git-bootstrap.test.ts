import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureRunGitBaseline } from "../src/git-bootstrap.js";
import { createExecutionHost } from "../src/execution-host.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ExecutionHost } from "../src/execution-host.js";

for (const profile of ["full", "project", "guarded"] as const) test(`baseline bootstrap ${profile} binds the real run/profile and closes its owner before returning`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p6-git-bootstrap-"));
  t.diagnostic(`exact synthetic bootstrap acquired: ${root}`);
  const project = join(root, "project"); const state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const order: string[] = [];
  const revision = "a".repeat(40);
  const host = { bindRun: async (input: { runId: string; permissionProfile: string }) => {
    assert.equal(input.runId, "actual-bootstrap-run"); assert.equal(input.permissionProfile, profile); order.push("bind");
    return { git: { lifecycle: (purpose: string) => { assert.equal(purpose, "baseline"); return { run: async (request: { cwd: string; args: readonly string[] }) => {
      order.push(request.args[0]!); assert.equal(request.cwd, project);
      const key = request.args.join(" ");
      if (key.includes("--is-inside-work-tree")) return { exitCode: 0, stdout: "true\n", stderr: "" };
      if (key.includes("--show-toplevel")) return { exitCode: 0, stdout: project, stderr: "" };
      if (request.args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (request.args[0] === "symbolic-ref") return { exitCode: 0, stdout: "main\n", stderr: "" };
      if (request.args[0] === "show") return { exitCode: 0, stdout: "existing baseline\n", stderr: "" };
      return { exitCode: 0, stdout: revision, stderr: "" };
    } }; } }, close: async () => { order.push("close"); } };
  } } as unknown as ExecutionHost;
  try {
    const result = await captureRunGitBaseline({ host, projectPath: project, stateDirectory: state, runId: "actual-bootstrap-run",
      permissionProfile: profile, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    assert.equal(result.revision, revision); assert.equal(order[0], "bind"); assert.equal(order.at(-1), "close");
    assert.deepEqual(await readdir(project), [], "a recovered existing baseline must not mutate project files");
  } finally { await rm(root, { recursive: true }); t.diagnostic(`synthetic bootstrap fixture removed: ${root}`); }
});

test("historical Git query owns separate transient state and exposes no active-run writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p6-git-history-"));
  const project = join(root, "project"); const state = join(root, "state");
  await mkdir(project); await mkdir(state); await writeFile(join(state, "historical.json"), "immutable-history");
  t.diagnostic(`exact non-native historical fixture acquired: ${root}`);
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), platform: "posix" });
  const before = await readdir(state); // Existing CLI-host roots are outside this query's delta.
  let passed = false;
  try {
    const config = emptyRunnerCapabilitiesConfig();
    const contract = await createRunnerCapabilityContract(config);
    const result = await host.withGitInspection({ runId: "closed-historical-run", permissionProfile: "full", capabilitiesConfig: config, capabilityContract: contract }, async (git) => {
      assert.deepEqual(Object.keys(git).sort(), ["run", "runBytes"]);
      assert.deepEqual(host.activeRunIds(), []);
      await assert.rejects(git.run({ cwd: project, args: ["reset", "--hard"] }), /purpose|command/i);
      return "query-finished";
    });
    assert.equal(result, "query-finished");
    assert.equal(await host.withGitInspection({ runId: "legacy-terminal-run", permissionProfile: "full", capabilitiesConfig: config }, async () => "legacy-query"), "legacy-query", "a read-only historical query cannot require an active Build capability snapshot");
    assert.deepEqual(await readdir(state), before);
    assert.equal(await readFile(join(state, "historical.json"), "utf8"), "immutable-history");
    await assert.rejects(host.withGitInspection({ runId: "closed-historical-run", permissionProfile: "full", capabilitiesConfig: config, capabilityContract: contract }, async () => { throw undefined; }),
      (reason: unknown) => reason === undefined);
    assert.deepEqual(await readdir(state), before);
    passed = true;
  } finally {
    await host.close();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`historical fixture removed, original history unchanged: ${root}`); }
  }
});
