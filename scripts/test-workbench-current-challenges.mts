/* Current WorkBench verified challenge checks (run: npx tsx scripts/test-workbench-current-challenges.mts) */
import {
  WORKBENCH_CHALLENGES,
  runWorkBenchChallengeVerifier,
} from "../lib/benchmark/workbench/challenges";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check(
  "WorkBench has 12 current verified challenges",
  WORKBENCH_CHALLENGES.length === 12,
  WORKBENCH_CHALLENGES.map((item) => item.id)
);

const kinds = new Set(WORKBENCH_CHALLENGES.map((item) => item.kind));
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

for (const challenge of WORKBENCH_CHALLENGES) {
  const reference = runWorkBenchChallengeVerifier({
    challenge,
    files: challenge.referenceFiles,
  });
  const negative = runWorkBenchChallengeVerifier({
    challenge,
    files: challenge.negativeControlFiles,
  });
  const alternate = runWorkBenchChallengeVerifier({
    challenge,
    files: Object.fromEntries(
      Object.entries(challenge.referenceFiles).map(([path, content]) => [
        path,
        content.replace(/\r\n/g, "\n"),
      ])
    ),
  });
  check(
    `${challenge.id} reference solution passes`,
    reference.passed && reference.score === 1,
    reference
  );
  check(
    `${challenge.id} behavioral verifier accepts equivalent non-reference formatting`,
    alternate.passed && alternate.score === 1,
    alternate
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
}

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
