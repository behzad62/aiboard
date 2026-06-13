/** GitHub workflow build-mode checks (run: npx tsx scripts/test-github-workflow.mts) */
import {
  githubWorkflowRequested,
  isGitHubWorkflowCommand,
  runBudgetStatus,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

check(
  "detects GitHub issue to PR request with repo URL",
  githubWorkflowRequested(
    "Please handle https://github.com/example/project issues and publish a PR."
  )
);

check(
  "does not trigger GitHub workflow for ordinary build prompt",
  !githubWorkflowRequested("Build a markdown preview app with tests.")
);

for (const command of [
  "gh issue list --repo example/project",
  "gh issue view 42 --repo example/project --comments",
  "git status --short",
  "git switch -c issue-42-fix",
  "git commit -m \"Fix issue 42\"",
  "git push -u origin issue-42-fix",
  "gh pr create --repo example/project --fill",
]) {
  check(`treats ${command} as GitHub workflow command`, isGitHubWorkflowCommand(command));
}

for (const command of ["npm test", "node scripts/check.mjs", "npx tsc --noEmit"]) {
  check(`does not exempt ${command}`, !isGitHubWorkflowCommand(command));
}

const budget = runBudgetStatus({
  runnerAvailable: true,
  totalRuns: 8,
  githubWorkflow: true,
});
check("normal run budget is doubled to 8 per phase", budget.normalRunsLeft === 8, budget);
check("normal total budget is doubled to 24", budget.totalNormalRunsLeft === 16, budget);
check("GitHub workflow commands are unlimited when active", budget.githubCommandsUnlimited, budget);
check("run tool remains available for GitHub workflow", budget.toolAvailable, budget);

process.exit(failed === 0 ? 0 : 1);
