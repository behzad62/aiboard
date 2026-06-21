/**
 * NRW-008: Build-mode GitHub workflow integration — pure/parse-able logic only
 * (no live model or runner). Covers the three new typed actions, safe-first
 * classification, the repoToolDoc gh-CLI gating, the typed-actions-vs-raw-command
 * prompt switch, the pr_create precondition, and the Repository-workflow summary
 * block. Run: npx tsx scripts/test-build-repo-workflow.mts
 */
import {
  buildArchitectPlanPrompt,
  buildArchitectReviewPrompt,
  buildRepoWorkflowSummary,
  isSafeFirstToolAction,
  parseArchitectAction,
  prCreateRefusalReason,
  REPO_PR_TITLE_MAX,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// ── 1. The three new actions parse with correct fields ──────────────────────
const parseCases: Array<[string, string, (a: ReturnType<typeof parseArchitectAction>) => boolean]> = [
  [
    "repo_issue_list parses repo + labels + limit",
    '{"action":"repo_issue_list","repo":"owner/repo","labels":["bug","aiboard"],"limit":12,"reason":"choose work"}',
    (a) =>
      a?.action === "repo_issue_list" &&
      (a as { repo: string }).repo === "owner/repo" &&
      (a as { labels?: string[] }).labels?.length === 2 &&
      (a as { limit?: number }).limit === 12,
  ],
  [
    "repo_milestone_create parses title and description",
    '{"action":"repo_milestone_create","repo":"owner/repo","title":"Games: Chess","description":"Track chess delivery","reason":"plan"}',
    (a) =>
      a?.action === "repo_milestone_create" &&
      (a as { repo: string }).repo === "owner/repo" &&
      (a as { title: string }).title === "Games: Chess",
  ],
  [
    "repo_issue_create parses milestone + labels",
    '{"action":"repo_issue_create","repo":"owner/repo","title":"Add chess board","body":"Implement board","milestone":"Games: Chess","labels":["aiboard"],"reason":"task"}',
    (a) =>
      a?.action === "repo_issue_create" &&
      (a as { repo: string }).repo === "owner/repo" &&
      (a as { milestone?: string }).milestone === "Games: Chess" &&
      (a as { labels?: string[] }).labels?.[0] === "aiboard",
  ],
  [
    "repo_issue_read parses repo + issue + reason",
    '{"action":"repo_issue_read","repo":"owner/repo","issue":42,"reason":"context"}',
    (a) =>
      a?.action === "repo_issue_read" &&
      (a as { repo: string }).repo === "owner/repo" &&
      (a as { issue: number }).issue === 42,
  ],
  [
    "repo_issue_read trims the repo slug",
    '{"action":"repo_issue_read","repo":"  owner/repo  ","issue":7}',
    (a) => a?.action === "repo_issue_read" && (a as { repo: string }).repo === "owner/repo",
  ],
  [
    "repo_push parses branch + remote + setUpstream",
    '{"action":"repo_push","branch":"codex/fix-42","remote":"origin","setUpstream":true,"reason":"ship"}',
    (a) =>
      a?.action === "repo_push" &&
      (a as { branch: string }).branch === "codex/fix-42" &&
      (a as { remote?: string }).remote === "origin" &&
      (a as { setUpstream?: boolean }).setUpstream === true,
  ],
  [
    "repo_push minimal (branch only)",
    '{"action":"repo_push","branch":"feature/x"}',
    (a) =>
      a?.action === "repo_push" &&
      (a as { branch: string }).branch === "feature/x" &&
      (a as { remote?: string }).remote === undefined,
  ],
  [
    "repo_pr_create parses and defaults draft to true when unspecified",
    '{"action":"repo_pr_create","title":"Fix settings","body":"Closes #42","base":"main","head":"codex/fix-42"}',
    (a) =>
      a?.action === "repo_pr_create" &&
      (a as { title: string }).title === "Fix settings" &&
      (a as { body: string }).body === "Closes #42" &&
      (a as { base?: string }).base === "main" &&
      (a as { head?: string }).head === "codex/fix-42" &&
      (a as { draft?: boolean }).draft === true,
  ],
  [
    "repo_pr_create honors explicit draft:false",
    '{"action":"repo_pr_create","title":"Ship it","body":"","draft":false}',
    (a) => a?.action === "repo_pr_create" && (a as { draft?: boolean }).draft === false,
  ],
  [
    "repo_pr_create with optional repo slug",
    '{"action":"repo_pr_create","repo":"owner/repo","title":"X","body":"y"}',
    (a) => a?.action === "repo_pr_create" && (a as { repo?: string }).repo === "owner/repo",
  ],
];

// ── 2. Malformed input is rejected (null) ───────────────────────────────────
const rejectCases: Array<[string, string]> = [
  ["repo_issue_list rejects bad repo slug", '{"action":"repo_issue_list","repo":"not-a-slug"}'],
  ["repo_milestone_create rejects empty title", '{"action":"repo_milestone_create","repo":"o/r","title":"   "}'],
  ["repo_issue_create rejects empty title", '{"action":"repo_issue_create","repo":"o/r","title":"   ","body":"x"}'],
  ["repo_issue_create rejects bad repo slug", '{"action":"repo_issue_create","repo":"bad","title":"X","body":"y"}'],
  ["repo_issue_read rejects bad repo slug", '{"action":"repo_issue_read","repo":"not-a-slug","issue":1}'],
  ["repo_issue_read rejects multi-slash slug", '{"action":"repo_issue_read","repo":"a/b/c","issue":1}'],
  ["repo_issue_read rejects zero issue", '{"action":"repo_issue_read","repo":"o/r","issue":0}'],
  ["repo_issue_read rejects negative issue", '{"action":"repo_issue_read","repo":"o/r","issue":-3}'],
  ["repo_issue_read rejects non-integer issue", '{"action":"repo_issue_read","repo":"o/r","issue":4.5}'],
  ["repo_issue_read rejects missing issue", '{"action":"repo_issue_read","repo":"o/r"}'],
  ["repo_push rejects leading-dash branch", '{"action":"repo_push","branch":"-evil"}'],
  ["repo_push rejects branch with space", '{"action":"repo_push","branch":"foo bar"}'],
  ["repo_push rejects missing branch", '{"action":"repo_push","remote":"origin"}'],
  ["repo_push rejects bad remote", '{"action":"repo_push","branch":"ok","remote":"-bad"}'],
  ["repo_pr_create rejects empty title", '{"action":"repo_pr_create","title":"   ","body":"y"}'],
  ["repo_pr_create rejects missing title", '{"action":"repo_pr_create","body":"y"}'],
  [
    "repo_pr_create rejects over-length title",
    `{"action":"repo_pr_create","title":"${"x".repeat(REPO_PR_TITLE_MAX + 1)}","body":"y"}`,
  ],
  ["repo_pr_create rejects bad repo slug", '{"action":"repo_pr_create","repo":"bad","title":"X","body":"y"}'],
  ["repo_pr_create rejects bad base ref", '{"action":"repo_pr_create","title":"X","body":"y","base":"-x"}'],
  ["repo_pr_create rejects bad head ref", '{"action":"repo_pr_create","title":"X","body":"y","head":"a..b"}'],
];

for (const [name, input, predicate] of parseCases) {
  const result = parseArchitectAction(input);
  check(name, predicate(result), result);
}
for (const [name, input] of rejectCases) {
  check(name, parseArchitectAction(input) === null, parseArchitectAction(input));
}

// ── 3. isSafeFirstToolAction includes ONLY repo_issue_read among the trio ────
check(
  "repo_issue_read is safe-first (read-only)",
  isSafeFirstToolAction({ action: "repo_issue_read", repo: "o/r", issue: 1 })
);
check(
  "repo_push is NOT safe-first (mutates external state)",
  !isSafeFirstToolAction({ action: "repo_push", branch: "x" })
);
check(
  "repo_pr_create is NOT safe-first (mutates external state)",
  !isSafeFirstToolAction({ action: "repo_pr_create", title: "x", body: "y" })
);

// ── 4. repoToolDoc gh-CLI gating via the plan prompt ────────────────────────
const ghAuthed = { available: true, authenticated: true };
const ghUnauthed = { available: true, authenticated: false };
const ghMissing = { available: false, authenticated: false };

const promptWith = (githubCli?: { available: boolean; authenticated: boolean }) =>
  buildArchitectPlanPrompt({
    request: "fix a bug",
    treeText: "src/index.ts",
    fileContext: "",
    maxTasks: 3,
    workerNames: ["W1"],
    readHopsLeft: 2,
    repoWorkflow: true,
    githubCli,
  });

const withGh = promptWith(ghAuthed);
const withUnauthedGh = promptWith(ghUnauthed);
const withMissingGh = promptWith(ghMissing);
const withoutGhArg = promptWith(undefined);

check(
  "repoToolDoc advertises issue planning/push/PR when gh available+authenticated",
  withGh.includes('"action":"repo_issue_list"') &&
    withGh.includes('"action":"repo_milestone_create"') &&
    withGh.includes('"action":"repo_issue_create"') &&
    withGh.includes('"action":"repo_issue_read"') &&
    withGh.includes('"action":"repo_push"') &&
    withGh.includes('"action":"repo_pr_create"')
);
check(
  "repoToolDoc still advertises base repo_status/repo_commit with gh authed",
  withGh.includes('"action":"repo_status"') && withGh.includes('"action":"repo_commit"')
);
check(
  "repoToolDoc hides issue/push/PR when gh unauthenticated",
  !withUnauthedGh.includes('"action":"repo_issue_list"') &&
    !withUnauthedGh.includes('"action":"repo_issue_create"') &&
    !withUnauthedGh.includes('"action":"repo_issue_read"') &&
    !withUnauthedGh.includes('"action":"repo_push"') &&
    !withUnauthedGh.includes('"action":"repo_pr_create"')
);
check(
  "repoToolDoc hides issue/push/PR when gh not installed",
  !withMissingGh.includes('"action":"repo_issue_list"') &&
    !withMissingGh.includes('"action":"repo_issue_create"') &&
    !withMissingGh.includes('"action":"repo_issue_read"') &&
    !withMissingGh.includes('"action":"repo_pr_create"')
);
check(
  "repoToolDoc hides issue/push/PR when githubCli arg omitted",
  !withoutGhArg.includes('"action":"repo_issue_list"') &&
    !withoutGhArg.includes('"action":"repo_issue_create"') &&
    !withoutGhArg.includes('"action":"repo_issue_read"') &&
    !withoutGhArg.includes('"action":"repo_pr_create"')
);
check(
  "repoToolDoc tells the Architect to PREFER DRAFT PRs (gh authed)",
  /draft/i.test(withGh) && /approval/i.test(withGh)
);

// The review prompt mirrors the same gating.
const reviewWithGh = buildArchitectReviewPrompt({
  request: "fix a bug",
  treeText: "src/index.ts",
  executedText: "",
  maxNewTasks: 3,
  cyclesLeft: 1,
  repoWorkflow: true,
  githubCli: ghAuthed,
});
check(
  "review prompt advertises issue/push/PR when gh authed",
  reviewWithGh.includes('"action":"repo_issue_list"') &&
    reviewWithGh.includes('"action":"repo_issue_create"') &&
    reviewWithGh.includes('"action":"repo_issue_read"') &&
    reviewWithGh.includes('"action":"repo_pr_create"')
);

// ── 5. Typed-actions-vs-raw-command doc switch ──────────────────────────────
// When typed /repo endpoints are available (repoWorkflow true) AND a GitHub
// workflow was requested, the prompt must NOT instruct raw `gh pr create` /
// `git push`.
const typedGithubPrompt = buildArchitectPlanPrompt({
  request: "Handle https://github.com/owner/repo issues and open a PR.",
  treeText: "src/index.ts",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["W1"],
  readHopsLeft: 2,
  runsLeft: 8,
  githubWorkflow: true,
  repoWorkflow: true,
  githubCli: ghAuthed,
});
check(
  "typed endpoints available: prompt has NO raw `gh pr create` instruction",
  !/gh pr create/i.test(typedGithubPrompt),
  typedGithubPrompt.match(/gh pr create/i)?.[0]
);
check(
  "typed endpoints available: prompt has NO raw `git push` instruction",
  !/git push/i.test(typedGithubPrompt),
  typedGithubPrompt.match(/git push/i)?.[0]
);
check(
  "typed endpoints available: workflow doc references the typed actions",
  typedGithubPrompt.includes("repo_issue_create") &&
    typedGithubPrompt.includes("repo_milestone_create") &&
    typedGithubPrompt.includes("repo_pr_create") &&
    typedGithubPrompt.includes("repo_push")
);
check(
  "typed endpoints available: prompt keeps human gate at PR review/merge",
  typedGithubPrompt.includes("without an extra in-app approval prompt") &&
    typedGithubPrompt.includes("PR review/merge is the human gate") &&
    !typedGithubPrompt.includes("require the user's in-app approval"),
  typedGithubPrompt
);
check(
  "typed endpoints available: prompt uses the correct #aiboard marker",
  typedGithubPrompt.includes("#aiboard") && !typedGithubPrompt.includes("#aoboard"),
  typedGithubPrompt
);

// When typed endpoints are NOT available but the GitHub workflow IS requested,
// the fallback raw-command doc still appears.
const fallbackGithubPrompt = buildArchitectPlanPrompt({
  request: "Handle https://github.com/owner/repo issues and open a PR.",
  treeText: "src/index.ts",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["W1"],
  readHopsLeft: 2,
  runsLeft: 8,
  githubWorkflow: true,
  repoWorkflow: false,
});
check(
  "no typed endpoints + GitHub requested: fallback raw-command doc still appears",
  /gh.*git.*non-interactive/i.test(fallbackGithubPrompt) ||
    /non-interactive `gh` and `git`/i.test(fallbackGithubPrompt),
  fallbackGithubPrompt
);
check(
  "fallback doc references the budget exemption for gh/git commands",
  /do not count against the normal command budget/i.test(fallbackGithubPrompt)
);

// ── 6. pr_create precondition (pure) ────────────────────────────────────────
check(
  "PR allowed when a commit landed this run",
  prCreateRefusalReason({ commitsThisRun: 1, clean: false, ahead: 0 }) === null
);
check(
  "PR allowed when clean branch ahead of upstream (no commit this run)",
  prCreateRefusalReason({ commitsThisRun: 0, clean: true, ahead: 2 }) === null
);
check(
  "PR refused when safe branch workflow is disabled even if branch is clean-ahead",
  prCreateRefusalReason({
    commitsThisRun: 0,
    clean: true,
    ahead: 2,
    repoCommitWorkflowEnabled: false,
  }) !== null
);
check(
  "PR refused when no commit and not clean-ahead",
  prCreateRefusalReason({ commitsThisRun: 0, clean: false, ahead: 0 }) !== null
);
check(
  "PR refused when clean but not ahead and no commit",
  prCreateRefusalReason({ commitsThisRun: 0, clean: true, ahead: 0 }) !== null
);
check(
  "PR refused when ahead but dirty and no commit",
  prCreateRefusalReason({ commitsThisRun: 0, clean: false, ahead: 3 }) !== null
);

// ── 7. Repository-workflow summary block (pure) ─────────────────────────────
const fullSummary = buildRepoWorkflowSummary({
  branch: "codex/fix-42-settings",
  commits: [{ hash: "abc1234", subject: "Fix settings storage regression" }],
  issueNumber: 42,
  pushedBranch: "codex/fix-42-settings",
  prUrl: "https://github.com/owner/repo/pull/123",
  verification: "npm run build passed",
});
check("summary has the heading", fullSummary.includes("## Repository workflow"));
check("summary lists the branch", fullSummary.includes("- Branch: `codex/fix-42-settings`"));
check(
  "summary lists the commit hash + subject",
  fullSummary.includes("- Commit `abc1234` Fix settings storage regression")
);
check("summary lists the issue", fullSummary.includes("- Issue: #42"));
check(
  "summary lists the PR url",
  fullSummary.includes("- Pull request: https://github.com/owner/repo/pull/123")
);
check("summary lists the verification line", fullSummary.includes("- Verification: npm run build passed"));

check("summary is empty when nothing happened", buildRepoWorkflowSummary({}) === "");
const branchOnly = buildRepoWorkflowSummary({ branch: "codex/x", commits: [] });
check(
  "summary on a branch with no commits says so",
  branchOnly.includes("- Branch: `codex/x`") && branchOnly.includes("- No commits were made this run.")
);
const issueOnly = buildRepoWorkflowSummary({ issueNumber: 9 });
check(
  "summary renders an issue even without a branch",
  issueOnly.includes("## Repository workflow") && issueOnly.includes("- Issue: #9")
);

process.exit(failed === 0 ? 0 : 1);
