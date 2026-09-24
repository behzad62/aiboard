import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  RECOVERABLE_JOB_SERVICE_FAMILIES,
  RECOVERABLE_JOB_SERVICE_INPUT_HASHES,
  RECOVERABLE_JOB_SERVICE_METADATA,
  RECOVERABLE_JOB_SERVICE_PUBLIC_FILES,
} from "../lib/benchmark/workbench/recoverable-job-service/fixture";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFile(resolve(root, path), "utf8");
const json = async (path: string) => JSON.parse(await read(path));
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

const admission = await json("docs/benchmarks/recoverable-job-service/scoring-admission.json");
const validation = await json("docs/benchmarks/recoverable-job-service/design-validation.json");
const qualification = await json("benchmarks/recoverable-job-service/private/calibration/qualification-metadata.json");
const sourceMap = await json("docs/benchmarks/recoverable-job-service/source-map.json");
const evaluationCases = await read("docs/benchmarks/recoverable-job-service/evaluation-cases.md");

assert.equal(qualification.status, "accepted");
assert.equal(qualification.admission, "calibrated");
assert.equal(qualification.method, "rjs-simplification-audit-1");
assert.match(
  qualification.evidenceManifest,
  /^benchmarks\/recoverable-job-service\/private\/calibration\/final-acceptance-review\.md#sha256-[a-f0-9]{64}$/
);
assert.equal(admission.admittedFamilies, 69);
assert.equal(admission.families.length, 69);
assert.deepEqual(
  admission.families.map((family: { id: string }) => family.id).sort(),
  RECOVERABLE_JOB_SERVICE_FAMILIES.map((family) => family.id).sort()
);
assert.equal(admission.families.every((family: {
  status: string;
  affectsScore: boolean;
  instructionSufficiency: string;
}) =>
  family.status === "admitted" &&
  family.affectsScore === true &&
  family.instructionSufficiency === "qualified"
), true);
assert.equal(admission.qualification.mandatoryVariants, 302);
assert.equal(admission.qualification.contractHash, RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash);
assert.equal(admission.qualification.suiteHash, RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash);
assert.equal(admission.qualification.contractVersion, RECOVERABLE_JOB_SERVICE_METADATA.contractVersion);
assert.equal(admission.qualification.suiteVersion, RECOVERABLE_JOB_SERVICE_METADATA.suiteVersion);
assert.deepEqual(admission.qualification.evaluatorOnlyChecks, [
  "H01", "H02", "H03", "H04", "H05", "H06", "H07", "H08", "H09",
]);
assert.equal(
  sourceMap.reviewCorpus.every((record: { findingLevelReconciliation: string }) =>
    record.findingLevelReconciliation === "reconciled-in-final-302-row-predicate-ledger"
  ),
  true
);
const candidateCases = sourceMap.cases.filter((record: { group: string }) => record.group !== "H");
const evaluatorCases = sourceMap.cases.filter((record: { group: string }) => record.group === "H");
assert.equal(candidateCases.length, 69);
assert.equal(evaluatorCases.length, 9);
assert.equal(candidateCases.every((record: { admission: string; candidateScored: boolean }) =>
  record.admission === "admitted" && record.candidateScored === true
), true);
assert.equal(evaluatorCases.every((record: { admission: string; candidateScored: boolean }) =>
  record.admission === "evaluator-qualified" && record.candidateScored === false
), true);
assert.doesNotMatch(sourceMap.currentExecutionStatus, /pending|2\.0\.0/i);
assert.doesNotMatch(evaluationCases, /B17[\s\S]{0,240}before admitting it/i);
assert.match(evaluationCases, /B17[\s\S]{0,240}accepted successful reference/i);

const calibrationFixture = await json(
  "benchmarks/recoverable-job-service/private/fixtures/qualified-calibration-verifier-result.json"
);
assert.equal(calibrationFixture.passed, true);
assert.equal(calibrationFixture.score, 1);
assert.equal(calibrationFixture.recoverableJobService.families.length, 69);
assert.equal(calibrationFixture.recoverableJobService.provenance.variantIds.length, 302);
assert.equal(
  calibrationFixture.recoverableJobService.contractHash,
  RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash
);
assert.equal(
  calibrationFixture.recoverableJobService.suiteHash,
  RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash
);

for (const name of ["problem.md", "acceptance-contract.md", "runtime-contract.md", "source-bootstrap.md"]) {
  assert.equal(
    await read(`docs/benchmarks/recoverable-job-service/${name}`),
    await read(`benchmarks/recoverable-job-service/public/${name}`),
    `${name} documentation mirror is current`
  );
}
assert.equal(
  Object.keys(RECOVERABLE_JOB_SERVICE_PUBLIC_FILES).filter((name) => name !== "verify.mjs").length,
  11
);
for (const [name, content] of Object.entries(RECOVERABLE_JOB_SERVICE_PUBLIC_FILES)) {
  if (name === "verify.mjs") continue;
  assert.equal(content, await read(`benchmarks/recoverable-job-service/public/${name}`), `${name} generated fixture is current`);
}

assert.equal(validation.qualification, "accepted");
assert.equal(validation.candidateFamilies, 69);
assert.equal(validation.mandatoryVariants, 302);
assert.equal(validation.admittedFamilies, 69);
assert.equal(validation.modelVisibleFiles, 11);
assert.equal(validation.contractHash, RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash);
assert.equal(validation.suiteHash, RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash);
for (const file of validation.files) {
  assert.equal(sha256(await readFile(resolve(root, file.path))), file.sha256, `${file.path} validation hash is current`);
}

const readme = await read("docs/benchmarks/recoverable-job-service/README.md");
for (const fact of ["Node.js 24.18.0", "69 mandatory families", "302 mandatory variants", "11 model-visible files", "Scoring is binary", "H01–H09"]) {
  assert.match(readme, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

console.log("PASS");
