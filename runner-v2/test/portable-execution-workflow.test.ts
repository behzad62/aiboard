import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowPath = join(repoRoot, ".github", "workflows", "runner-v2-portable-execution.yml");
const qualificationWorkflowPath = join(repoRoot, ".github", "workflows", "runner-v2-qualification.yml");
const nativeSmokeScript = "scripts/runner-v2-native-smoke.mts";

const deterministicPrTests = [
  "runner-v2/test/process-backend-contract.test.ts",
  "runner-v2/test/runner-capabilities-config.test.ts",
  "runner-v2/test/native-build-manager.test.ts",
  "runner-v2/test/runner-resource-cleanup.test.ts",
  "runner-v2/test/static-adapter-policy.test.ts",
  "runner-v2/test/package-parity.test.ts",
  "runner-v2/test/runner-entrypoints.test.ts",
  "runner-v2/test/node-version.test.ts",
  "runner-v2/test/portable-execution-workflow.test.ts",
] as const;

const posixHostedTests = [
  "runner-v2/test/portable-process-protocol.test.ts",
  "runner-v2/test/portable-process-channel.test.ts",
] as const;

const qualificationOnlyTests = [
  "runner-v2/test/cli-capabilities-config.test.ts",
  "runner-v2/test/runner-capability-contract.test.ts",
  "runner-v2/test/plugin-loader.test.ts",
  "runner-v2/test/recovery-smoke.test.ts",
  "runner-v2/test/windows-process-backend.test.ts",
  "runner-v2/test/windows-job-process-channel.test.ts",
  "runner-v2/test/posix-process-backend.test.ts",
  "runner-v2/test/managed-shared-native.test.ts",
  "runner-v2/test/mcp-lazy-native.test.ts",
  "runner-v2/test/oci-execution-isolation-provider.test.ts",
  "runner-v2/test/managed-strict-oci.test.ts",
  "runner-v2/test/mcp-tools.test.ts",
] as const;

const qualificationTests = [
  "runner-v2/test/runner-capabilities-config.test.ts",
  ...qualificationOnlyTests,
] as const;

test("required PR CI stays deterministic on every supported Node 24 host", () => {
  assert.equal(existsSync(workflowPath), true, "Task 12 portable execution workflow is missing.");
  const source = readFileSync(workflowPath, "utf8");
  assert.match(source, /^\s*pull_request:/m);
  const portable = jobBlock(source, "portable-contract");
  const nativeSmoke = jobBlock(source, "native-smoke");
  const packages = jobBlock(source, "package-gate");

  for (const block of [portable, nativeSmoke, packages]) {
    for (const host of ["windows-latest", "ubuntu-latest", "macos-latest"]) assert.match(block, new RegExp(host));
    assert.match(block, /node-version:\s*\[24\.x\]/);
  }
  for (const testPath of deterministicPrTests) {
    assert.equal(source.includes(testPath), true, `Required PR CI omits deterministic test ${testPath}.`);
  }
  for (const testPath of posixHostedTests) {
    assert.equal(source.includes(testPath), true, `Required POSIX PR CI omits ${testPath}.`);
  }
  assert.match(portable,
    /if:\s*runner\.os\s*!=\s*'Windows'[\s\S]*portable-process-protocol\.test\.ts[\s\S]*portable-process-channel\.test\.ts/,
    "Real owned-fence protocol/channel files must stay off required Windows PR CI and run there in qualification.");
  for (const testPath of qualificationOnlyTests) {
    assert.equal(source.includes(testPath), false, `Host-sensitive qualification-only test leaked into required PR CI: ${testPath}.`);
  }
  assert.equal(source.includes(nativeSmokeScript), true, "Required PR CI must retain one lightweight native-host smoke probe.");
  assert.doesNotMatch(source, /^  docker-oci-integration:/m,
    "Full Docker integration belongs to qualification, not the required hosted-runner PR gate.");
  assertWorkflowTestPathsExist(source);
});

test("host-sensitive lifecycle and Docker coverage is retained in scheduled/manual qualification", () => {
  assert.equal(existsSync(qualificationWorkflowPath), true, "Runner V2 qualification workflow is missing.");
  const source = readFileSync(qualificationWorkflowPath, "utf8");
  assert.match(source, /^\s*workflow_dispatch:/m);
  assert.match(source, /^\s*schedule:/m);
  assert.match(source, /^\s*pull_request:\s*\n\s*types:\s*\[labeled\]/m,
    "Qualification needs a label-only PR trigger so a pre-merge tip can be qualified explicitly.");
  const labelGuards = source.match(/github\.event\.label\.name\s*==\s*'runner-v2-qualification'/g) ?? [];
  assert.equal(labelGuards.length, 5,
    "Every qualification job must stay gated behind the explicit runner-v2-qualification PR label.");
  assert.match(source, /node-version:\s*\[24\.x\]/);
  for (const testPath of [...qualificationTests, ...posixHostedTests]) {
    assert.equal(source.includes(testPath), true, `Qualification coverage omits ${testPath}.`);
  }
  assert.match(source, /RUNNER_V2_REQUIRE_DOCKER:\s*["']?1["']?/);
  assert.match(source, /docker\s+info/i);
  assertWorkflowTestPathsExist(source);
});

test("required native smoke is an adapter probe rather than a lifecycle timing test", () => {
  const source = readFileSync(workflowPath, "utf8");
  const nativeSmoke = jobBlock(source, "native-smoke");
  assert.match(nativeSmoke, new RegExp(nativeSmokeScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(nativeSmoke, /--test\b/);
  for (const testPath of qualificationTests) assert.equal(nativeSmoke.includes(testPath), false);
});

test("package parity remains cross-host and reproducible on Node 24", () => {
  const source = readFileSync(workflowPath, "utf8");
  const packages = jobBlock(source, "package-gate");
  const crossHost = jobBlock(source, "package-cross-host");
  assert.match(packages, /actions\/upload-artifact@v4/);
  assert.match(packages, /runner-v2-package-hashes\.mjs\s+write/);
  assert.match(crossHost, /needs:\s*package-gate/);
  assert.match(crossHost, /node-version:\s*\[24\.x\]/);
  assert.match(crossHost, /actions\/download-artifact@v4/);
  assert.match(crossHost, /runner-v2-package-hashes\.mjs\s+compare/);
});

function jobBlock(source: string, name: string): string {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `Missing workflow job ${name}.`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[index]!)) { end = index; break; }
  }
  return lines.slice(start, end).join("\n");
}

function assertWorkflowTestPathsExist(source: string): void {
  for (const match of source.matchAll(/runner-v2\/test\/[A-Za-z0-9_./-]+\.test\.ts/g)) {
    assert.equal(existsSync(join(repoRoot, match[0])), true, `Workflow references missing test file ${match[0]}.`);
  }
}
