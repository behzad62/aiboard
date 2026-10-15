import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {ArtifactStore} from "../src/artifact-store.js";
import {SqliteEvidenceStore} from "../src/sqlite-evidence-store.js";
import {createExecutionHost} from "../src/execution-host.js";
import {snapshotNativeBuildAmbientEnvironment} from "../src/native-build-factory.js";
import {emptyRunnerCapabilitiesConfig} from "../src/runner-capabilities-config.js";
import {createRunnerCapabilityContract} from "../src/runner-capability-contract.js";
import {bindCommandEvidenceReuse} from "../src/one-shot-command-executor.js";
import {workingTreeForRunner} from "../src/command-evidence-identity.js";
import {findReusableCommand} from "../src/command-evidence-reuse.js";
import {createEvidenceTools} from "../src/evidence-tools.js";
import {openSqliteDurableProcessKernel} from "../src/durable-process-store.js";
import {runGit, captureGitBaseline} from "./support/git-fixture.js";

test("V2 native exact tuple reuses real Node test with durable no-launch restart honesty", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-native-reuse-")); const project = join(root, "project"); const state = join(root, "state"); mkdirSync(project); mkdirSync(state);
  writeFileSync(join(project, "actual.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('actual native test',()=>assert.equal(2,2));\n");
  await runGit({cwd: project, args: ["init"]}); await captureGitBaseline({projectPath: project, stateDirectory: state, runId: "native-reuse"});
  const artifacts = new ArtifactStore(join(state, "artifacts")); const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const ambient = {...snapshotNativeBuildAmbientEnvironment()}; delete ambient.NODE_TEST_CONTEXT;
  const host = createExecutionHost({projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: ambient});
  try {
    const config = emptyRunnerCapabilitiesConfig(); const capabilityContract = await createRunnerCapabilityContract(config);
    const binding = await host.bindRun({runId: "native-reuse", permissionProfile: "full", capabilityContract, capabilitiesConfig: config});
    const reportPath = join(state, "actual-report.xml");
    const captures: unknown[] = [];
    bindCommandEvidenceReuse(binding.commandExecution, "native-reuse", {store: evidence, artifacts, captureTree: async (cwd, request) => {
      const tree = await binding.git.workingTreeForCurrentCall?.(cwd) ?? await workingTreeForRunner(binding.git.lifecycle("verification").run, cwd);
      captures.push({callId: request.context.callId, tree}); return tree;
    }});
    const tool = createEvidenceTools({git: binding.git, store: evidence, artifacts, taskId: "task", execution: binding.commandExecution}).find((tool) => tool.definition.name === "run_evidence_command")!;
    const call = async (callId: string) => {
      const actor = {role: "worker" as const, id: "worker"}; const identity = {runId: "native-reuse", sessionId: "session", actor, callId, toolName: "run_evidence_command", permissionProfile: "full" as const};
      const grant = await binding.executionGrants.issue({...identity, workspacePath: project, access: [{path: project, mode: "write"}, {path: reportPath, mode: "write"}], externalApproved: true, destructiveApproved: false, networkApproved: false});
      const context = {...identity, workspacePath: project, executionGrant: grant}; const valid = tool.validate({label: callId, command: process.execPath, args: ["--test", "--test-reporter=junit", `--test-reporter-destination=${reportPath}`, "actual.test.mjs"]});
      assert.equal(valid.ok, true); if (!valid.ok) throw new Error("fixture validation failed");
      try {const result = await binding.git.withCall(context, () => tool.execute(valid.value, context)); assert.equal(result.isError, false, JSON.stringify(result));}
      finally {await binding.executionGrants.revoke(grant, "completed");}
    };
    await call("original");
    const original = evidence.list({runId: "native-reuse"})[0]!;
    assert.equal(original.fact.kind, "command"); if (original.fact.kind !== "command") throw new Error("missing command");
    const fact = original.fact;
    const diagnostic = {captures, fact, output: fact.executionSnapshot?.process.output.map((output) => ({...output, tailSha: createHash("sha256").update(output.tail).digest("hex")}))};
    writeFileSync(join(tmpdir(), "p6-6", "codex-v2-writer-native-diagnostic.json"), JSON.stringify(diagnostic, null, 2));
    assert.ok(fact.executionSnapshot, JSON.stringify(diagnostic));
    assert.equal((await findReusableCommand(evidence, artifacts, "native-reuse", fact.executionSnapshot.key))?.id, original.id, JSON.stringify(diagnostic));
    const reportBytes = readFileSync(reportPath); const report = reportBytes.toString("utf8");
    assert.match(report, /<!-- tests 1 -->/); assert.match(report, /<!-- fail 0 -->/); assert.match(report, /name="actual native test"/);
    const reportArtifact = await artifacts.put(reportBytes, "application/xml", "actual native Node test report");
    assert.deepEqual(await artifacts.get(reportArtifact.hash), reportBytes);
    await call("repeat");
    assert.deepEqual(readFileSync(reportPath), reportBytes, "reuse preserves original real test report bytes");
    const rows = evidence.list({runId: "native-reuse"}); const repeated = rows.find((row) => row.fact.kind === "command" && row.fact.label === "repeat")!;
    writeFileSync(join(tmpdir(), "p6-6", "codex-v2-writer-native-diagnostic.json"), JSON.stringify({captures, rows}, null, 2));
    assert.equal(repeated.fact.kind === "command" && repeated.fact.reused_from, original.id, JSON.stringify({captures, rows}));
    const reopened = openSqliteDurableProcessKernel(binding.snapshot().subprocessStatePath, readFileSync(join(binding.runRoot, "subprocess-runtime.key")), {readOnly: true});
    try {
      const processes = reopened.store.listRowIds().map((id) => reopened.store.readByInvocation(id)!);
      const reused = processes.filter((process) => process.state === "reused"); assert.equal(reused.length, 1); assert.equal(reused[0]!.reused_from, original.id);
      assert.equal(reused[0]!.backendBinding, undefined); assert.equal(reused[0]!.result, undefined); assert.equal(reused[0]!.observation, undefined); assert.equal(reused[0]!.output, undefined); assert.equal(reused[0]!.cleanup.state, "not_required");
    } finally {reopened.store.close();}
  } finally {await host.close(); evidence.close(); rmSync(root, {recursive: true, force: true});}
});
