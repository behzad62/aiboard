import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureGitBaseline, runGit } from "./support/git-fixture.js";
import { inspectFinalVerificationExecutionProfile } from "../src/final-verification-profile.js";
import { inspectTestIntegrityPin } from "../src/test-integrity-profile.js";
import { captureWorkingTreeIdentity, fingerprintChildEnvironment } from "../src/command-evidence-identity.js";
import { commandReuseKey } from "../src/command-evidence-reuse.js";

// PHASE-R2-EXIT owns these composition scenarios. V1/V2/V3 packet gates
// are reconciled from their accepted evidence, never rerun as a broad suite.
const context = { requiredLifecycleScope: "process_group", implementationDigest: "b".repeat(64), configDigest: "c".repeat(64) };
async function repository(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "p66-r2-exit-")), project = join(root, "project"), state = join(root, "state");
  mkdirSync(project); mkdirSync(state);
  for (const [path, content] of Object.entries(files)) { mkdirSync(resolve(project, path, ".."), { recursive: true }); writeFileSync(join(project, path), content); }
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "r2-exit" });
  return { root, project, state, revision: baseline.revision };
}

test("R2 exit: non-JS transitive selector changes bind both immutable pins and actual trees without SDK reuse", async () => {
  const fixture = await repository({
    "Calc.Tests.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" /></ItemGroup><Import Project="selector.txt" /></Project>',
    "selector.txt": '<Project><Import Project="transitive.inc" /></Project>',
    "transitive.inc": '<Project><PropertyGroup><DefineConstants>FIRST</DefineConstants></PropertyGroup></Project>',
  });
  try {
    const profile = await inspectFinalVerificationExecutionProfile({ repositoryRoot: fixture.project, targetRevision: fixture.revision, execute: runGit });
    assert.deepEqual(profile.commands.tests?.[0]?.args, ["test", "Calc.Tests.csproj", "--disable-build-servers"]);
    assert.equal(profile.reports, undefined, "unresolved nonstandard imports retain commands but cannot qualify report counts");
    const commands = profile.commands.tests!;
    const pin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: fixture.project, revision: fixture.revision, commands });
    const indexPath = resolve(fixture.project, (await runGit({ cwd: fixture.project, args: ["rev-parse", "--git-path", "index"] })).stdout.trim());
    const indexBefore = readFileSync(indexPath);
    const firstTree = await captureWorkingTreeIdentity(fixture.project, join(fixture.state, "private-index"), runGit);
    assert.equal(firstTree.status, "known");
    const command = { executable: commands[0]!.executable, arguments: commands[0]!.args, workingDirectory: fixture.project, timeoutMs: 60_000 };
    const sdk = await fingerprintChildEnvironment({ environment: {}, executable: command.executable, cwd: fixture.project });
    assert.equal(sdk.status, "unknown"); assert.equal(commandReuseKey(command, firstTree, sdk, context), undefined, "detected language does not mint a runtime version");
    writeFileSync(join(fixture.project, "transitive.inc"), '<Project><PropertyGroup><DefineConstants>SECOND</DefineConstants></PropertyGroup></Project>');
    const dirtyTree = await captureWorkingTreeIdentity(fixture.project, join(fixture.state, "private-index"), runGit);
    assert.notDeepEqual(dirtyTree, firstTree); assert.deepEqual(readFileSync(indexPath), indexBefore, "R2 composition preserves the owner staging index");
    await runGit({ cwd: fixture.project, args: ["add", "-A"] }); await runGit({ cwd: fixture.project, args: ["commit", "-m", "only transitive selector"] });
    const changed = (await runGit({ cwd: fixture.project, args: ["rev-parse", "HEAD"] })).stdout.trim();
    const changedProfile = await inspectFinalVerificationExecutionProfile({ repositoryRoot: fixture.project, targetRevision: changed, execute: runGit });
    assert.deepEqual(changedProfile.commands.tests, commands, "literal launch stays constant while configuration changes");
    const nextPin = await inspectTestIntegrityPin({ git: runGit, repositoryRoot: fixture.project, revision: changed, commands });
    assert.notEqual(nextPin.configDigest, pin.configDigest);
    assert.equal(commandReuseKey(command, dirtyTree, sdk, context), undefined);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("R2 exit: package authority and exact Node reuse coexist with non-JS detection", async () => {
  const fixture = await repository({
    "package.json": JSON.stringify({ packageManager: "npm@11.0.0", scripts: { test: "node --test" } }),
    "actual.test.mjs": 'import test from "node:test"; test("value",()=>{});\n',
    "pytest.ini": "[pytest]\n",
  });
  try {
    const profile = await inspectFinalVerificationExecutionProfile({ repositoryRoot: fixture.project, targetRevision: fixture.revision, execute: runGit });
    assert.deepEqual(profile.commands.tests?.map(command => command.label), ["package tests"], "family detection never overrides an explicit package script");
    const tree = await captureWorkingTreeIdentity(fixture.project, join(fixture.state, "private-index"), runGit);
    const environment = await fingerprintChildEnvironment({ environment: {}, executable: process.execPath, cwd: fixture.project });
    const request = { executable: process.execPath, arguments: ["--test", "actual.test.mjs"], workingDirectory: fixture.project, timeoutMs: 60_000 };
    const key = commandReuseKey(request, tree, environment, context); assert.ok(key);
    assert.equal(commandReuseKey({ ...request }, tree, environment, context), key);
    assert.notEqual(commandReuseKey({ ...request, arguments: [...request.arguments, "--test-reporter=spec"] }, tree, environment, context), key);
    writeFileSync(join(fixture.project, "pytest.ini"), "[pytest]\naddopts = -q\n");
    const nextTree = await captureWorkingTreeIdentity(fixture.project, join(fixture.state, "private-index"), runGit);
    assert.notEqual(commandReuseKey(request, nextTree, environment, context), key, "non-JS configuration changes remain actual-tree novelty");
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});
