/* WorkBench anti-gaming guard checks (run: npx tsx scripts/test-workbench-anti-gaming.mts)
 *
 * Guards the review findings:
 * - a no-op patch must fail every case;
 * - pasting required snippets / the fix inside comments must fail (comment-aware checks);
 * - the reference plus one inserted blank line must still pass (alignment diff, not positional);
 * - the oracle (reference files, negative control, grading spec) must not ship in
 *   the model-visible fixture workspace.
 */
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
  runWorkBenchChallengeVerifier,
  type WorkBenchChallenge,
} from "../lib/benchmark/workbench/challenges";
import {
  listWorkBenchChallenges,
  listWorkBenchCaseOptions,
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
): { passed: boolean; score: number } {
  const dir = mkdtempSync(join(tmpdir(), "workbench-antigaming-"));
  try {
    writeFileSync(
      join(dir, "case-meta.json"),
      JSON.stringify(
        { id: challenge.id, baseFiles: challenge.baseFiles, verifier: challenge.verifier },
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
    return JSON.parse(readFileSync(join(dir, "verifier-result.json"), "utf8")) as {
      passed: boolean;
      score: number;
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function commentize(path: string, text: string): string | null {
  if (path.endsWith(".json")) return null;
  const prefix = path.endsWith(".py") ? "# " : "// ";
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/** Lines present in the reference file but not in the base file (the "fix"). */
function referenceDiffLines(base: string, reference: string): string[] {
  const baseLines = new Set(base.split("\n"));
  return reference.split("\n").filter((line) => line.trim() && !baseLines.has(line));
}

function buildCommentAttack(challenge: WorkBenchChallenge): Record<string, string> | null {
  const attack: Record<string, string> = { ...challenge.baseFiles };
  let appendedAnything = false;
  const paths = new Set([
    ...Object.keys(challenge.verifier.requiredSnippets),
    ...Object.keys(challenge.referenceFiles),
  ]);
  for (const path of paths) {
    const base = challenge.baseFiles[path];
    if (base === undefined) continue;
    const pieces: string[] = [];
    for (const snippet of challenge.verifier.requiredSnippets[path] ?? []) {
      const variants = typeof snippet === "string" ? [snippet] : snippet.anyOf;
      pieces.push(...variants);
    }
    pieces.push(...referenceDiffLines(base, challenge.referenceFiles[path] ?? base));
    const commented = pieces
      .map((piece) => commentize(path, piece))
      .filter((piece): piece is string => piece !== null);
    if (commented.length === 0) continue;
    attack[path] = `${base}\n${commented.join("\n")}`;
    appendedAnything = true;
  }
  return appendedAnything ? attack : null;
}

const challenges = listWorkBenchChallenges();

for (const challenge of challenges) {
  const noop = runWorkBenchChallengeVerifier({ challenge, files: challenge.baseFiles });
  check(
    `${challenge.id} no-op patch fails`,
    !noop.passed && noop.score < 1,
    { passed: noop.passed, score: noop.score }
  );

  const attackFiles = buildCommentAttack(challenge);
  if (attackFiles) {
    const attack = runWorkBenchChallengeVerifier({ challenge, files: attackFiles });
    check(
      `${challenge.id} comment-only patch containing required snippets fails`,
      !attack.passed,
      { passed: attack.passed, score: attack.score }
    );
    const runtimeAttack = runRuntimeVerifier(challenge, attackFiles);
    check(
      `${challenge.id} runtime verifier rejects the comment-only patch`,
      runtimeAttack.passed === false,
      runtimeAttack
    );
  }

  // Insertion tolerance: the reference solution with one extra blank line must
  // still pass; a positional line diff would count every shifted line.
  const changedPath = Object.keys(challenge.referenceFiles).find(
    (path) => challenge.referenceFiles[path] !== challenge.baseFiles[path]
  );
  if (changedPath) {
    const padded = {
      ...challenge.referenceFiles,
      [changedPath]: `${challenge.referenceFiles[changedPath]}\n`,
    };
    const paddedResult = runWorkBenchChallengeVerifier({ challenge, files: padded });
    check(
      `${challenge.id} reference plus one inserted blank line still passes`,
      paddedResult.passed,
      {
        passed: paddedResult.passed,
        changedLines: paddedResult.changedLines,
        limit: challenge.verifier.maxChangedLines,
        failed: paddedResult.assertions.filter((item) => !item.passed).map((item) => item.id),
      }
    );
  }
}

// Regression: the go-error one-line "return nil // fmt.Errorf(...%w...)" trick
// must fail (the %w lives in a comment and the behavior is broken).
const goError = challenges.find((challenge) => challenge.id === "workbench-go-error-0002");
if (goError) {
  const path = Object.keys(goError.baseFiles)[0];
  const cheat = {
    [path]: goError.baseFiles[path].replace(
      'return errors.New("load failed")',
      'return nil // fmt.Errorf("load failed: %w", err)'
    ),
  };
  const result = runWorkBenchChallengeVerifier({ challenge: goError, files: cheat });
  check("workbench-go-error-0002 comment-trick nil return fails", !result.passed, result);
} else {
  check("workbench-go-error-0002 exists", false);
}

// Regression: the JSON duplicate-key trick (replace an unguarded sentinel line
// with a duplicate "betaCheckout": true while the original false line stays)
// must fail.
const jsonConfig = challenges.find((challenge) => challenge.id === "workbench-json-config-0001");
if (jsonConfig) {
  const path = Object.keys(jsonConfig.baseFiles)[0];
  const cheat = {
    [path]: jsonConfig.baseFiles[path].replace(
      '"sentinel_0001_300": "keep"',
      '"betaCheckout_0001": true'
    ),
  };
  const result = runWorkBenchChallengeVerifier({ challenge: jsonConfig, files: cheat });
  check("workbench-json-config-0001 duplicate-key injection fails", !result.passed, result);
  const runtime = runRuntimeVerifier(jsonConfig, cheat);
  check(
    "workbench-json-config-0001 runtime verifier rejects duplicate-key injection",
    runtime.passed === false,
    runtime
  );
} else {
  check("workbench-json-config-0001 exists", false);
}

// Regression: block comments (/* ... */) are stripped too.
const csRole = challenges.find((challenge) => challenge.id === "workbench-cs-role-0002");
if (csRole) {
  const path = Object.keys(csRole.baseFiles)[0];
  const cheat = {
    [path]: `${csRole.baseFiles[path]}\n/*\nclaim.Type == "role"\nStringComparison.OrdinalIgnoreCase\n*/`,
  };
  const result = runWorkBenchChallengeVerifier({ challenge: csRole, files: cheat });
  check("workbench-cs-role-0002 block-comment snippet paste fails", !result.passed, result);
} else {
  check("workbench-cs-role-0002 exists", false);
}

// The oracle must not ship in the model-visible fixture workspace.
const options = listWorkBenchCaseOptions();
check("WorkBench exposes 20 case options", options.length === 20, options.map((item) => item.id));
for (const option of options) {
  const fixtureFiles = option.case.fixtureFiles ?? {};
  check(
    `${option.id} fixture does not ship reference-solution.md or negative-control.json`,
    !("reference-solution.md" in fixtureFiles) && !("negative-control.json" in fixtureFiles),
    Object.keys(fixtureFiles)
  );
  const caseMetaRaw = fixtureFiles["case-meta.json"] ?? "";
  let caseMeta: Record<string, unknown> = {};
  try {
    caseMeta = JSON.parse(caseMetaRaw) as Record<string, unknown>;
  } catch {
    // handled by the next check
  }
  check(
    `${option.id} case-meta.json carries no referenceFiles oracle`,
    Boolean(caseMetaRaw) && !("referenceFiles" in caseMeta) && "verifier" in caseMeta,
    Object.keys(caseMeta)
  );
  check(
    `${option.id} contamination flag matches reality`,
    option.case.contamination.referenceSolutionPrivate === true,
    option.case.contamination
  );
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
