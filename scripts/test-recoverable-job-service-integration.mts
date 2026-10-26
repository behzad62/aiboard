import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getWorkBenchCaseOption,
  getWorkBenchCasePack,
  listWorkBenchCaseOptions,
  listWorkBenchCasePacks,
  listWorkBenchChallenges,
} from "../lib/benchmark/workbench/corpus";
import { getNativeBenchmarkPack, HARNESSBENCH_SUITE, WORKBENCH_SMOKE_SUITE } from "../lib/benchmark/native-suites";
import {
  RECOVERABLE_JOB_SERVICE_CASE_ID,
  RECOVERABLE_JOB_SERVICE_CONTRACT_VERSION,
  RECOVERABLE_JOB_SERVICE_EDITABLE_FILES,
  RECOVERABLE_JOB_SERVICE_HIDDEN_FILES,
  RECOVERABLE_JOB_SERVICE_INPUT_HASHES,
  RECOVERABLE_JOB_SERVICE_METADATA,
  RECOVERABLE_JOB_SERVICE_PACK_ID,
  RECOVERABLE_JOB_SERVICE_PROFILE,
  RECOVERABLE_JOB_SERVICE_PROTECTED_FILES,
  RECOVERABLE_JOB_SERVICE_PUBLIC_COMMANDS,
  RECOVERABLE_JOB_SERVICE_PUBLIC_FILES,
  RECOVERABLE_JOB_SERVICE_SUITE_VERSION,
} from "../lib/benchmark/workbench/recoverable-job-service/fixture";
import { createWorkBenchPublicContractArtifact } from "../lib/benchmark/workbench/artifacts";
import { getTrustedBenchRunnerReadiness } from "../lib/client/bench-runner";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baseline = JSON.parse(
  await readFile(
    resolve(
      repoRoot,
      "benchmarks/recoverable-job-service/private/fixtures/standard-packs-before.json"
    ),
    "utf8"
  )
);

const currentCases = listWorkBenchCaseOptions();
assert.deepEqual(
  listWorkBenchChallenges().map(({ id }) => id).sort(),
  baseline.cases.map(({ id }: { id: string }) => id).sort(),
  "legacy challenge definitions remain available to regression controls"
);
assert.deepEqual(
  currentCases.map(({ id }) => id),
  ["workbench-pipeline-0001", "workbench-pipeline-cache-0001", "workbench-pipeline-inventory-0001"],
  "current WorkBench contains only three executed behavioral integration fixtures"
);
assert.deepEqual(listWorkBenchCasePacks().map(({ id }) => id), [WORKBENCH_SMOKE_SUITE]);
assert.equal(getWorkBenchCaseOption("workbench-react-a11y-0001"), null, "static-only cases cannot enter a current run");

const option = getWorkBenchCaseOption(RECOVERABLE_JOB_SERVICE_CASE_ID);
const pack = getWorkBenchCasePack(RECOVERABLE_JOB_SERVICE_PACK_ID);
assert.ok(option, "the RJS case is directly resolvable");
assert.ok(pack, "the RJS pack is directly resolvable");
assert.equal(pack.label, "Recoverable Job Service");
assert.deepEqual(pack.caseIds, [RECOVERABLE_JOB_SERVICE_CASE_ID]);
assert.equal(
  currentCases.some((candidate) => candidate.id === RECOVERABLE_JOB_SERVICE_CASE_ID),
  false,
  "RJS does not alter grouped current-case packs"
);

const workBenchCase = option.case as typeof option.case & { trustedPolicy?: unknown };
assert.equal(workBenchCase.benchmarkTrack, "harnessbench");
assert.deepEqual(getNativeBenchmarkPack("harnessbench", HARNESSBENCH_SUITE)?.caseIds, [RECOVERABLE_JOB_SERVICE_CASE_ID]);
assert.equal(workBenchCase.caseVersion, RECOVERABLE_JOB_SERVICE_SUITE_VERSION);
assert.equal(workBenchCase.budget.maxUsd, undefined);
assert.deepEqual(workBenchCase.budget, {
  maxWallClockSeconds: 3600,
  maxModelCalls: 120,
  maxToolCalls: 500,
  maxInputTokens: 3_000_000,
  maxOutputTokens: 200_000,
});
assert.equal(workBenchCase.verifier.command, "node verify.mjs");
assert.equal(workBenchCase.verifier.resultFile, "verifier-result.json");
assert.equal(workBenchCase.verifier.timeoutSeconds, 660);
assert.deepEqual(workBenchCase.allowedCommands, RECOVERABLE_JOB_SERVICE_PUBLIC_COMMANDS);
assert.equal(RECOVERABLE_JOB_SERVICE_PUBLIC_COMMANDS.length, 79);

for (const name of [
  "problem.md",
  "acceptance-contract.md",
  "runtime-contract.md",
  "contract.d.ts",
  "source-bootstrap.md",
  "service.js",
  "families.json",
  "examples.mjs",
  "source-examples.mjs",
  "source-variants.json",
  "public-test.mjs",
]) {
  assert.match(workBenchCase.prompt.userRequest, new RegExp(name.replace(".", "\\.")));
}
assert.match(workBenchCase.prompt.userRequest, /are illustrative/i);
assert.match(workBenchCase.prompt.userRequest, /only editable file is `service\.js`/i);
assert.doesNotMatch(workBenchCase.prompt.userRequest, /reference solution|repair report/i);

assert.deepEqual(Object.keys(RECOVERABLE_JOB_SERVICE_PUBLIC_FILES).sort(), [
  "acceptance-contract.md",
  "contract.d.ts",
  "examples.mjs",
  "families.json",
  "problem.md",
  "public-test.mjs",
  "runtime-contract.md",
  "service.js",
  "source-bootstrap.md",
  "source-examples.mjs",
  "source-variants.json",
  "verify.mjs",
].sort());
assert.deepEqual(Object.keys(workBenchCase.fixtureFiles ?? {}).sort(), [
  ...Object.keys(RECOVERABLE_JOB_SERVICE_PUBLIC_FILES),
  "case-meta.json",
  "package.json",
].sort());
assert.deepEqual(workBenchCase.trustedPolicy, {
  kind: "recoverable-job-service",
  runtimeModule: "benchmarks/recoverable-job-service/private/runtime.mjs",
  requiredNodeVersion: "24.18.0",
  requiredQuickJsVersion: "0.32.0",
  contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
  suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
  hiddenPaths: [...RECOVERABLE_JOB_SERVICE_HIDDEN_FILES],
  protectedPaths: [...RECOVERABLE_JOB_SERVICE_PROTECTED_FILES],
  editablePaths: [...RECOVERABLE_JOB_SERVICE_EDITABLE_FILES],
});
assert.equal(RECOVERABLE_JOB_SERVICE_PROFILE, RECOVERABLE_JOB_SERVICE_METADATA.profile);
assert.equal(
  RECOVERABLE_JOB_SERVICE_CONTRACT_VERSION,
  RECOVERABLE_JOB_SERVICE_METADATA.contractVersion
);
assert.equal(
  RECOVERABLE_JOB_SERVICE_SUITE_VERSION,
  RECOVERABLE_JOB_SERVICE_METADATA.suiteVersion
);
assert.equal(RECOVERABLE_JOB_SERVICE_METADATA.familyCount, 69);
assert.equal(RECOVERABLE_JOB_SERVICE_METADATA.variantCount, 302);

const contractArtifact = createWorkBenchPublicContractArtifact({
  id: "attempt-1:public-contract",
  attemptId: "attempt-1",
  case: workBenchCase,
});
const contractSnapshot = JSON.parse(contractArtifact.content);
assert.equal(contractSnapshot.benchmark, "recoverable-job-service");
assert.equal(contractSnapshot.contractHash, RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash);
assert.equal(contractSnapshot.suiteHash, RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash);
assert.equal(contractSnapshot.profile, RECOVERABLE_JOB_SERVICE_METADATA.profile);
assert.equal(contractSnapshot.families.length, RECOVERABLE_JOB_SERVICE_METADATA.familyCount);
assert.equal(
  contractSnapshot.documents["acceptance-contract.md"],
  RECOVERABLE_JOB_SERVICE_PUBLIC_FILES["acceptance-contract.md"]
);
assert.match(contractSnapshot.families[0].contract, /^acceptance-contract\.md#/);

const exactHealth = {
  ok: true,
  nodeVersion: "24.18.0", platform: "win32",
  runnerV2: { ready: true, sourceDigest: "a".repeat(64) },
  rjs: {
    ready: true,
    nodeVersion: "24.18.0",
    quickjsVersion: "0.32.0",
    contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
    suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
    profile: RECOVERABLE_JOB_SERVICE_METADATA.profile,
  },
};
assert.deepEqual(
  getTrustedBenchRunnerReadiness(exactHealth, workBenchCase),
  { ready: true }
);
assert.match(
  getTrustedBenchRunnerReadiness(
    { ...exactHealth, rjs: { ...exactHealth.rjs, suiteHash: "0".repeat(64) } },
    workBenchCase
  ).error ?? "",
  /suite identity/i
);

console.log("PASS");
