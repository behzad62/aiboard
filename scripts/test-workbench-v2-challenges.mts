/* WorkBench v2 verified challenge checks (run: npx tsx scripts/test-workbench-v2-challenges.mts) */
import {
  WORKBENCH_V2_CHALLENGES,
  runWorkBenchV2ChallengeVerifier,
} from "../lib/benchmark/workbench";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

check(
  "WorkBench v2 has 12 verified challenges",
  WORKBENCH_V2_CHALLENGES.length === 12,
  WORKBENCH_V2_CHALLENGES.map((item) => item.id)
);

const kinds = new Set(WORKBENCH_V2_CHALLENGES.map((item) => item.kind));
for (const kind of [
  "large-file-surgical-patch",
  "multi-file-contract",
  "parser-edge-case",
  "react-accessibility",
  "large-json-config",
  "no-whole-file-rewrite",
]) {
  check(`WorkBench v2 includes ${kind}`, kinds.has(kind as never), [...kinds]);
}

for (const challenge of WORKBENCH_V2_CHALLENGES) {
  const reference = runWorkBenchV2ChallengeVerifier({
    challenge,
    files: challenge.referenceFiles,
  });
  const negative = runWorkBenchV2ChallengeVerifier({
    challenge,
    files: challenge.negativeControlFiles,
  });
  check(
    `${challenge.id} reference solution passes`,
    reference.passed && reference.score === 1,
    reference
  );
  check(
    `${challenge.id} negative control fails`,
    !negative.passed && negative.score < 1,
    negative
  );
}

const largeFileChallenges = WORKBENCH_V2_CHALLENGES.filter((challenge) =>
  challenge.tags.includes("large-file-surgical-patch") ||
  challenge.kind === "no-whole-file-rewrite" ||
  challenge.kind === "large-json-config" ||
  challenge.kind === "react-accessibility"
);
check(
  "large-file WorkBench v2 challenges contain large files and diff limits",
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
