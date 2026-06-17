/**
 * Focused tests for the pure Build-mode repo helpers (NRW-005):
 * classifyRepoBranchSafety (the branch-safety gate) and branchNameForTopic
 * (the auto-derived `codex/<slug>` branch name). Both are pure (no runner /
 * fetch / engine deps) so this script imports them directly, like the other
 * tsx PASS/FAIL scripts. Run: npx tsx scripts/test-repo-branch-safety.mts
 */
import {
  classifyRepoBranchSafety,
  branchNameForTopic,
  repoCommitWorkflowEnabledFromStatus,
} from "../lib/client/repo-runner";
import { isValidGitRefName } from "../lib/orchestrator/build";

type Decision = ReturnType<typeof classifyRepoBranchSafety>;

const cases: Array<[string, Parameters<typeof classifyRepoBranchSafety>[0], (d: Decision) => boolean]> =
  [
    [
      "non-repo folder is safe and needs no branch (repo workflow N/A)",
      {
        isRepo: false,
        currentBranch: null,
        defaultBranch: null,
        clean: true,
        conflicted: [],
      },
      (d) => d.safe === true && d.needsBranch === false && /not a git repo/i.test(d.reason),
    ],
    [
      "conflicted files make repo workflow unsafe",
      {
        isRepo: true,
        currentBranch: "feature/x",
        defaultBranch: "main",
        clean: false,
        conflicted: ["src/a.ts", "src/b.ts"],
      },
      (d) => d.safe === false && /conflict/i.test(d.reason),
    ],
    [
      "currentBranch === defaultBranch needs a branch",
      {
        isRepo: true,
        currentBranch: "develop",
        defaultBranch: "develop",
        clean: true,
        conflicted: [],
      },
      (d) => d.safe === false && d.needsBranch === true,
    ],
    [
      "on main with null default still needs a branch",
      {
        isRepo: true,
        currentBranch: "main",
        defaultBranch: null,
        clean: true,
        conflicted: [],
      },
      (d) => d.safe === false && d.needsBranch === true,
    ],
    [
      "on master with null default still needs a branch",
      {
        isRepo: true,
        currentBranch: "master",
        defaultBranch: null,
        clean: true,
        conflicted: [],
      },
      (d) => d.safe === false && d.needsBranch === true,
    ],
    [
      "feature branch, clean, no conflicts is safe and needs no branch",
      {
        isRepo: true,
        currentBranch: "feature/login",
        defaultBranch: "main",
        clean: true,
        conflicted: [],
      },
      (d) => d.safe === true && d.needsBranch === false,
    ],
    [
      "dirty feature branch is still safe (dirty does not block) but reason mentions dirty",
      {
        isRepo: true,
        currentBranch: "feature/login",
        defaultBranch: "main",
        clean: false,
        conflicted: [],
      },
      (d) => d.safe === true && d.needsBranch === false && /dirty/i.test(d.reason),
    ],
    [
      "detached HEAD (null branch) needs a branch",
      {
        isRepo: true,
        currentBranch: null,
        defaultBranch: "main",
        clean: true,
        conflicted: [],
      },
      (d) => d.safe === false && d.needsBranch === true,
    ],
    [
      "conflicts win over a clean feature branch (unsafe, not needsBranch)",
      {
        isRepo: true,
        currentBranch: "feature/x",
        defaultBranch: "main",
        clean: true,
        conflicted: ["src/merge.ts"],
      },
      (d) => d.safe === false && d.needsBranch === false,
    ],
  ];

let failed = 0;
for (const [name, input, check] of cases) {
  const result = classifyRepoBranchSafety(input);
  const ok = check(result);
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → got ${JSON.stringify(result)}`}`);
  if (!ok) failed++;
}

// ── branchNameForTopic: the output must ALWAYS be a valid git ref ───────────
// Adversarial corpus — every generated name must satisfy isValidGitRefName.
const branchInputs: Array<[string, string]> = [
  ["empty string", ""],
  ["whitespace only", "   "],
  ["all symbols", "!!!@@@"],
  ["dashes only", "----"],
  ["leading + trailing dashes", "  --hello world--  "],
  ["contains ..", "a..b..c"],
  ["contains //", "a//b"],
  ["contains @{", "ref@{0}"],
  ["contains backslash", "a\\b\\c"],
  ["contains whitespace", "fix the broken thing"],
  ["emoji only", "💥🎉🚀"],
  ["CJK unicode", "修复登录错误"],
  ["accented unicode", "déjà vu accénts ünïcode"],
  ["200-char string", "a".repeat(200)],
  ["realistic request", "Fix issue #42: the @{weird} thing\\with/slashes..and dots"],
];

for (const [name, input] of branchInputs) {
  const branch = branchNameForTopic(input);
  const ok = isValidGitRefName(branch);
  console.log(
    `${ok ? "PASS" : "FAIL"} — branchNameForTopic(${name}) is a valid git ref${ok ? "" : ` → got ${JSON.stringify(branch)}`}`
  );
  if (!ok) failed++;
}

// Empty / all-symbol inputs must still yield a sensible non-empty fallback name.
const fallbackInputs: Array<[string, string]> = [
  ["empty string", ""],
  ["whitespace only", "   "],
  ["all symbols", "!!!@@@"],
  ["dashes only", "----"],
];
for (const [name, input] of fallbackInputs) {
  const branch = branchNameForTopic(input);
  const ok = branch.startsWith("codex/") && branch.length > "codex/".length;
  console.log(
    `${ok ? "PASS" : "FAIL"} — branchNameForTopic(${name}) falls back to a non-empty codex/ name${ok ? "" : ` → got ${JSON.stringify(branch)}`}`
  );
  if (!ok) failed++;
}

const commitWorkflowCases: Array<
  [
    string,
    Parameters<typeof repoCommitWorkflowEnabledFromStatus>[0],
    boolean,
  ]
> = [
  [
    "enables commit workflow on a safe feature branch",
    {
      isRepo: true,
      currentBranch: "codex/fix-42",
      defaultBranch: "main",
      clean: false,
      conflicted: [],
    },
    true,
  ],
  [
    "keeps commit workflow off on main",
    {
      isRepo: true,
      currentBranch: "main",
      defaultBranch: "main",
      clean: true,
      conflicted: [],
    },
    false,
  ],
  [
    "keeps commit workflow off with conflicts",
    {
      isRepo: true,
      currentBranch: "codex/fix-42",
      defaultBranch: "main",
      clean: false,
      conflicted: ["app/page.tsx"],
    },
    false,
  ],
];

for (const [name, input, expected] of commitWorkflowCases) {
  const actual = repoCommitWorkflowEnabledFromStatus(input);
  const ok = actual === expected;
  console.log(
    `${ok ? "PASS" : "FAIL"} — repoCommitWorkflowEnabledFromStatus ${name}${ok ? "" : ` → got ${actual}`}`
  );
  if (!ok) failed++;
}

process.exit(failed === 0 ? 0 : 1);
