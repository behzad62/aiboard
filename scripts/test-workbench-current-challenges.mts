/* Current WorkBench verified challenge checks (run: npx tsx scripts/test-workbench-current-challenges.mts) */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  WORKBENCH_CHALLENGES,
  runWorkBenchChallengeVerifier,
  type WorkBenchChallenge,
} from "../lib/benchmark/workbench/challenges";
import {
  listWorkBenchCaseOptions,
  listWorkBenchChallenges,
  WORKBENCH_VERIFIER,
} from "../lib/benchmark/workbench/corpus";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

function runRuntimeVerifier(
  challenge: WorkBenchChallenge,
  files: Record<string, string>
): { passed: boolean; score: number; assertions?: unknown[] } {
  const dir = mkdtempSync(join(tmpdir(), "workbench-verifier-"));
  try {
    writeFileSync(
      join(dir, "case-meta.json"),
      JSON.stringify(
        {
          id: challenge.id,
          baseFiles: challenge.baseFiles,
          verifier: challenge.verifier,
        },
        null,
        2
      )
    );
    writeFileSync(join(dir, "verifier.mjs"), WORKBENCH_VERIFIER);
    for (const [relativePath, content] of Object.entries({
      ...challenge.baseFiles,
      ...files,
    })) {
      const target = join(dir, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    try {
      execFileSync("node", ["verifier.mjs"], { cwd: dir });
    } catch {
      // Failing candidates exit nonzero after writing verifier-result.json.
    }
    return JSON.parse(
      readFileSync(join(dir, "verifier-result.json"), "utf8")
    ) as { passed: boolean; score: number; assertions?: unknown[] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

check(
  "WorkBench has 19 current verified challenges",
  listWorkBenchChallenges().length === 19,
  listWorkBenchChallenges().map((item) => item.id)
);

const currentChallenges = listWorkBenchChallenges();
for (const { case: challengeCase } of listWorkBenchCaseOptions()) {
  check(
    `${challengeCase.id} uses the expanded token safety caps`,
    challengeCase.budget.maxInputTokens === 3_500_000 &&
      challengeCase.budget.maxOutputTokens === 1_000_000,
    challengeCase.budget
  );
  check(
    `${challengeCase.id} keeps the model and tool safety caps`,
    challengeCase.budget.maxModelCalls === 60 && challengeCase.budget.maxToolCalls === 180,
    challengeCase.budget
  );
}
const kinds = new Set(currentChallenges.map((item) => item.kind));
for (const kind of [
  "large-file-surgical-patch",
  "multi-file-contract",
  "parser-edge-case",
  "react-accessibility",
  "large-json-config",
  "no-whole-file-rewrite",
]) {
  check(`WorkBench includes ${kind}`, kinds.has(kind as never), [...kinds]);
}

for (const challenge of currentChallenges) {
  const reference = runWorkBenchChallengeVerifier({
    challenge,
    files: challenge.referenceFiles,
  });
  const negative = runWorkBenchChallengeVerifier({
    challenge,
    files: challenge.negativeControlFiles,
  });
  // A genuinely different but equally-correct implementation (not a byte copy
  // of the reference) must pass; this guards against snippet assertions that
  // only accept the reference's exact spelling.
  const alternate = runWorkBenchChallengeVerifier({
    challenge,
    files: challenge.alternateSolutionFiles,
  });
  const alternateIsDistinct = Object.entries(challenge.alternateSolutionFiles).some(
    ([path, content]) => content !== challenge.referenceFiles[path]
  );
  const runtimeReference = runRuntimeVerifier(
    challenge,
    challenge.referenceFiles
  );
  const runtimeNegative = runRuntimeVerifier(
    challenge,
    challenge.negativeControlFiles
  );
  const runtimeAlternate = runRuntimeVerifier(
    challenge,
    challenge.alternateSolutionFiles
  );
  check(
    `${challenge.id} reference solution passes`,
    reference.passed && reference.score === 1,
    reference
  );
  check(
    `${challenge.id} alternate correct solution differs from the reference`,
    alternateIsDistinct,
    challenge.alternateSolutionFiles
  );
  check(
    `${challenge.id} verifier accepts an equally-correct alternate solution`,
    alternate.passed && alternate.score === 1,
    alternate
  );
  check(
    `${challenge.id} runtime verifier accepts the alternate solution`,
    runtimeAlternate.passed === true,
    runtimeAlternate
  );
  check(
    `${challenge.id} negative control fails`,
    !negative.passed && negative.score < 1,
    negative
  );
  check(
    `${challenge.id} verifier does not use exact-reference assertion ids`,
    reference.assertions.every((assertion) => !assertion.id.includes("reference")),
    reference.assertions
  );
  check(
    `${challenge.id} runtime verifier matches TS on reference`,
    runtimeReference.passed === reference.passed &&
      Math.abs(runtimeReference.score - reference.score) < 1e-9,
    { runtimeReference, reference }
  );
  check(
    `${challenge.id} runtime verifier matches TS on negative control`,
    runtimeNegative.passed === negative.passed &&
      Math.abs(runtimeNegative.score - negative.score) < 1e-9,
    { runtimeNegative, negative }
  );
  check(
    `${challenge.id} runtime verifier rejects negative control`,
    runtimeNegative.passed === false,
    runtimeNegative
  );
  if (challenge.kind === "large-file-surgical-patch") {
    const path = Object.keys(challenge.referenceFiles)[0];
    const content = path ? challenge.referenceFiles[path] : "";
    const tampered = path
      ? {
          ...challenge.referenceFiles,
          [path]: content.replace(
            "return raw; // non-target sentinel 060",
            "return CORRUPTED; // non-target sentinel 060"
          ),
        }
      : challenge.referenceFiles;
    const tamperedResult = runWorkBenchChallengeVerifier({
      challenge,
      files: tampered,
    });
    check(
      `${challenge.id} detects corruption of a single non-target branch`,
      !tamperedResult.passed,
      tamperedResult
    );
  }
}

const duplicateSentinelChallenge: WorkBenchChallenge = {
  id: "workbench-duplicate-sentinel-test",
  title: "Duplicate sentinel corruption test",
  kind: "large-file-surgical-patch",
  difficulty: "hard",
  prompt: "Patch only the target branch and preserve both duplicated sentinels.",
  tags: ["workbench", "test"],
  baseFiles: {
    "src/app.ts": [
      "export function first() {",
      "  return SHARED_SENTINEL;",
      "}",
      "export function target() {",
      "  return 'old';",
      "}",
      "export function second() {",
      "  return SHARED_SENTINEL;",
      "}",
    ].join("\n"),
  },
  referenceFiles: {
    "src/app.ts": [
      "export function first() {",
      "  return SHARED_SENTINEL;",
      "}",
      "export function target() {",
      "  return 'new';",
      "}",
      "export function second() {",
      "  return SHARED_SENTINEL;",
      "}",
    ].join("\n"),
  },
  negativeControlFiles: {
    "src/app.ts": [
      "export function first() {",
      "  return SHARED_SENTINEL;",
      "}",
      "export function target() {",
      "  return 'new';",
      "}",
      "export function second() {",
      "  return CORRUPTED_SENTINEL;",
      "}",
    ].join("\n"),
  },
  alternateSolutionFiles: {
    "src/app.ts": [
      "export function first() {",
      "  return SHARED_SENTINEL;",
      "}",
      "export function target() {",
      "  return 'new';",
      "}",
      "export function second() {",
      "  return SHARED_SENTINEL;",
      "}",
    ].join("\n"),
  },
  verifier: {
    requiredSnippets: { "src/app.ts": ["return 'new';"] },
    requiredUnchangedSnippets: { "src/app.ts": ["return SHARED_SENTINEL;"] },
  },
};
const duplicateSentinelTs = runWorkBenchChallengeVerifier({
  challenge: duplicateSentinelChallenge,
  files: duplicateSentinelChallenge.negativeControlFiles,
});
const duplicateSentinelRuntime = runRuntimeVerifier(
  duplicateSentinelChallenge,
  duplicateSentinelChallenge.negativeControlFiles
);
check(
  "WorkBench verifier detects when one of several identical unchanged snippets is corrupted",
  !duplicateSentinelTs.passed && duplicateSentinelTs.score < 1,
  duplicateSentinelTs
);
check(
  "runtime WorkBench verifier detects duplicate unchanged snippet corruption",
  !duplicateSentinelRuntime.passed && duplicateSentinelRuntime.score < 1,
  duplicateSentinelRuntime
);

const largeFileChallenges = WORKBENCH_CHALLENGES.filter((challenge) =>
  challenge.tags.includes("large-file-surgical-patch") ||
  challenge.kind === "no-whole-file-rewrite" ||
  challenge.kind === "large-json-config" ||
  challenge.kind === "react-accessibility"
);
check(
  "large-file WorkBench challenges contain large files and diff limits",
  largeFileChallenges.every((challenge) => {
    const lineCounts = Object.values(challenge.baseFiles).map((content) => content.split("\n").length);
    return Math.max(...lineCounts) >= 300 && (challenge.verifier.maxChangedLines ?? 999) <= 10;
  }),
  largeFileChallenges.map((challenge) => ({
    id: challenge.id,
    lines: Object.values(challenge.baseFiles).map((content) => content.split("\n").length),
    maxChangedLines: challenge.verifier.maxChangedLines,
  }))
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
