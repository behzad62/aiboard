/**
 * Focused tests for classifyRepoBranchSafety — the pure branch-safety gate used
 * by Build mode (NRW-005). Run: npx tsx scripts/test-repo-branch-safety.mts
 *
 * The helper is pure (no runner / fetch / engine deps) so this script imports it
 * directly, like the other tsx PASS/FAIL scripts.
 */
import { classifyRepoBranchSafety } from "../lib/client/repo-runner";

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

process.exit(failed === 0 ? 0 : 1);
