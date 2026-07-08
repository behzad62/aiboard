import {
  formatBlockingSkillEvidence,
  getBlockingSkillEvidence,
} from "@/lib/orchestrator/build-evidence-gates";
import type { SkillEvidence } from "@/lib/skills/types";
import {
  normalizeBuildTaskContract,
  taskRequiresToolVerification,
  type BuildTask,
} from "./build";

export type BuildQualityCheckStatus = "passed" | "failed" | "missing";
export type BuildQualityGateStatus = "ready" | "blocked";

export interface BuildQualityGateRepoStatus {
  isRepo: boolean;
  currentBranch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  clean: boolean;
}

export interface BuildQualityRequiredCheck {
  name: string;
  command: string;
  status: BuildQualityCheckStatus;
  outputPreview?: string;
}

export interface BuildQualityGateItem {
  code:
    | "repo_unavailable"
    | "repo_not_git"
    | "repo_conflicted"
    | "repo_dirty"
    | "repo_unpushed"
    | "repo_behind"
    | "pr_missing"
    | "check_missing"
    | "check_failed"
    | "skill_evidence_missing"
    | "browser_acceptance_missing"
    | "request_fulfillment_missing"
    | "issues_close_on_merge";
  message: string;
  details?: string;
}

export interface BuildQualityGateInput {
  githubWorkflow: boolean;
  expectedPr: boolean;
  repoStatus: BuildQualityGateRepoStatus | null;
  repoPrUrl?: string | null;
  repoPushedBranch?: string | null;
  requiredChecks: BuildQualityRequiredCheck[];
  issueNumbers?: number[];
  tasks?: BuildTask[];
  skillEvidence?: SkillEvidence[];
  browserAcceptance?: {
    required: boolean;
    observed: boolean;
    reason?: string;
  };
  requestFulfillment?: {
    required: boolean;
    observed: boolean;
    reason?: string;
  };
}

export interface BuildQualityGateResult {
  status: BuildQualityGateStatus;
  blockers: BuildQualityGateItem[];
  warnings: BuildQualityGateItem[];
}

export function shouldRequireBrowserAcceptance(input: {
  request: string;
  treeText?: string;
  changedFiles?: string[];
}): boolean {
  const request = input.request.toLowerCase();
  const treeText = input.treeText ?? "";
  const tree = treeText.toLowerCase();
  const uiPath = /(^|\/)(app\/page\.(tsx|jsx|ts|js)|pages\/|public\/index\.html|public\/app\.js|src\/app\/|src\/main\.(tsx|jsx|ts|js)|src\/app\.(tsx|jsx|ts|js)|vite\.config\.|next\.config\.)|(^|\/)(components|app|pages|public)\/|\.((tsx|jsx|css|scss|html))$/i;
  const changedFiles = input.changedFiles;
  const changedFilesAffectUi = changedFiles?.some((file) => uiPath.test(file)) ?? false;
  const verificationOnlyRequest =
    /\b(verification|test|tests|check|lint|typecheck|compile|syntax|contract)\b/.test(
      request
    ) &&
    (/\bonly\b/.test(request) ||
      /\bcurrent\b/.test(request) ||
      /do not implement unrelated/.test(request));
  if (changedFiles && !changedFilesAffectUi && verificationOnlyRequest) {
    return false;
  }
  if (
    /\b(web app|website|browser app|frontend|front-end|user interface|ui|dashboard|landing page|single page app|spa)\b/.test(
      request
    )
  ) {
    return true;
  }
  if (/\b(react|next\.?js|vite|vue|svelte|angular)\b/.test(request)) {
    return true;
  }
  if (changedFiles) {
    return changedFilesAffectUi;
  }
  return /(^|\n)(app\/page\.(tsx|jsx|ts|js)|pages\/|public\/index\.html|public\/app\.js|src\/app\/|src\/main\.(tsx|jsx|ts|js)|src\/app\.(tsx|jsx|ts|js)|vite\.config\.|next\.config\.)/i.test(tree);
}

export function shouldRequireRequestFulfillment(input: {
  request: string;
  treeText?: string;
  changedFiles?: string[];
}): boolean {
  void input.treeText;
  void input.changedFiles;
  return input.request.trim().length > 0;
}

function uniqueSortedIssues(issueNumbers: number[] | undefined): number[] {
  return [
    ...new Set(
      (issueNumbers ?? []).filter(
        (issue) => Number.isInteger(issue) && issue > 0
      )
    ),
  ].sort((a, b) => a - b);
}

function compactFiles(files: string[]): string {
  if (files.length === 0) return "(none)";
  const shown = files.slice(0, 8).join(", ");
  return files.length > 8 ? `${shown}, +${files.length - 8} more` : shown;
}

function dirtyFiles(status: BuildQualityGateRepoStatus): string[] {
  return [
    ...status.staged,
    ...status.unstaged,
    ...status.untracked,
    ...status.conflicted,
  ];
}

function skillEvidenceRequiresHardGate(
  record: SkillEvidence,
  tasks: BuildTask[] | undefined
): boolean {
  if (!tasks) return true;
  if (!record.taskId) return true;
  const task = tasks.find((candidate) => candidate.id === record.taskId);
  if (!task) return true;
  return taskRequiresToolVerification(normalizeBuildTaskContract(task));
}

export function evaluateBuildQualityGate(
  input: BuildQualityGateInput
): BuildQualityGateResult {
  const blockers: BuildQualityGateItem[] = [];
  const warnings: BuildQualityGateItem[] = [];
  const status = input.repoStatus;

  if (input.githubWorkflow && !status) {
    blockers.push({
      code: "repo_unavailable",
      message:
        "GitHub workflow cannot be marked done because repo status is unavailable. Attach a local runner with Git support so the engine can verify branch, dirty tree, push, and PR state.",
    });
  }

  if (status && input.githubWorkflow && !status.isRepo) {
    blockers.push({
      code: "repo_not_git",
      message:
        "GitHub workflow cannot be marked done because the runner folder is not a Git repository.",
    });
  }

  if (status?.isRepo) {
    if (status.conflicted.length > 0) {
      blockers.push({
        code: "repo_conflicted",
        message: `Repository has conflicted files: ${compactFiles(status.conflicted)}.`,
      });
    }

    const pending = dirtyFiles(status);
    if (!status.clean || pending.length > 0) {
      blockers.push({
        code: "repo_dirty",
        message: `Repository has uncommitted changes: ${compactFiles(pending)}.`,
        details:
          "Build mode must commit or explicitly report pending files before it can mark the job done.",
      });
    }

    if (status.ahead > 0) {
      const hasPr = !!input.repoPrUrl;
      blockers.push({
        code: "repo_unpushed",
        message: hasPr
          ? `Local branch is ahead of ${status.upstream ?? "its upstream"} by ${status.ahead} commit(s), so the PR is stale until the branch is pushed.`
          : `Local branch is ahead of ${status.upstream ?? "its upstream"} by ${status.ahead} commit(s); push it before marking the GitHub workflow done.`,
      });
    }

    if (status.behind > 0) {
      warnings.push({
        code: "repo_behind",
        message: `Local branch is behind ${status.upstream ?? "its upstream"} by ${status.behind} commit(s).`,
      });
    }
  }

  if (input.expectedPr && !input.repoPrUrl) {
    blockers.push({
      code: "pr_missing",
      message:
        "A pull request was requested, but the engine has no record of a PR being opened.",
    });
  }

  if (input.requiredChecks.length === 0) {
    blockers.push({
      code: "check_missing",
      message:
        "No final verification checks ran. At least one compile, lint, build, or test command must pass before Build mode can mark the job done.",
    });
  }

  for (const check of input.requiredChecks) {
    if (check.status === "missing") {
      blockers.push({
        code: "check_missing",
        message: `Required final check did not run: ${check.name} (${check.command}).`,
      });
    }
    if (check.status === "failed") {
      blockers.push({
        code: "check_failed",
        message: `Required final check failed: ${check.name} (${check.command}).`,
        details: check.outputPreview,
      });
    }
  }

  const blockingEvidence = getBlockingSkillEvidence(input.skillEvidence ?? []);
  const hardBlockingEvidence = blockingEvidence.filter((record) =>
    skillEvidenceRequiresHardGate(record, input.tasks)
  );
  const advisoryEvidence = blockingEvidence.filter(
    (record) => !skillEvidenceRequiresHardGate(record, input.tasks)
  );
  if (hardBlockingEvidence.length > 0) {
    const taskIds = [
      ...new Set(hardBlockingEvidence.map((record) => record.taskId).filter(Boolean)),
    ];
    blockers.push({
      code: "skill_evidence_missing",
      message:
        taskIds.length > 0
          ? `Required skill evidence is missing for ${taskIds.join(", ")}.`
          : "Required skill evidence is missing.",
      details: formatBlockingSkillEvidence(hardBlockingEvidence),
    });
  }
  if (advisoryEvidence.length > 0) {
    const taskIds = [
      ...new Set(advisoryEvidence.map((record) => record.taskId).filter(Boolean)),
    ];
    warnings.push({
      code: "skill_evidence_missing",
      message:
        taskIds.length > 0
          ? `Skill evidence gaps were recorded for architect-reviewed task(s) ${taskIds.join(", ")}.`
          : "Skill evidence gaps were recorded for architect-reviewed task(s).",
      details: formatBlockingSkillEvidence(advisoryEvidence),
    });
  }

  if (
    input.browserAcceptance?.required &&
    !input.browserAcceptance.observed
  ) {
    blockers.push({
      code: "browser_acceptance_missing",
      message:
        "A web app or UI-affecting build cannot be marked done because no real-browser acceptance evidence was recorded.",
      details:
        input.browserAcceptance.reason ??
        "Start the app, navigate to the local server in a browser, exercise the main workflow, and verify the settled UI has no visible stuck loading, error state, blank screen, blocking overlay, or console errors.",
    });
  }

  if (input.requestFulfillment?.required && !input.requestFulfillment.observed) {
    blockers.push({
      code: "request_fulfillment_missing",
      message:
        "Build cannot be marked done because no explicit evidence shows the landed output was compared against the original user request.",
      details:
        input.requestFulfillment.reason ??
        "Review the original user request, the Architect spec, the landed files, and verification evidence. Report requestFulfillment.reviewed=true and requestFulfillment.satisfied=true only when the delivered result satisfies the request; list any gaps otherwise.",
    });
  }

  const issues = uniqueSortedIssues(input.issueNumbers);
  if (issues.length > 0 && input.repoPrUrl) {
    warnings.push({
      code: "issues_close_on_merge",
      message:
        issues.length === 1
          ? `Issue #${issues[0]} will close on merge; it remains open while the PR is open.`
          : `Issues ${issues.map((issue) => `#${issue}`).join(", ")} will close on merge; they remain open while the PR is open.`,
    });
  }

  return {
    status: blockers.length > 0 ? "blocked" : "ready",
    blockers,
    warnings,
  };
}

function renderItems(items: BuildQualityGateItem[]): string[] {
  return items.flatMap((item) => {
    const lines = [`- ${item.message}`];
    if (item.details?.trim()) {
      lines.push("  ```");
      lines.push(`  ${item.details.trim().replace(/\n/g, "\n  ")}`);
      lines.push("  ```");
    }
    return lines;
  });
}

export function formatBuildQualityGateSummary(
  result: BuildQualityGateResult
): string {
  const lines = ["## Build quality gate", ""];
  lines.push(
    result.status === "ready"
      ? "- Status: ready"
      : "- Status: blocked"
  );
  if (result.blockers.length > 0) {
    lines.push("", "### Blockers", ...renderItems(result.blockers));
  }
  if (result.warnings.length > 0) {
    lines.push("", "### Warnings", ...renderItems(result.warnings));
  }
  return lines.join("\n");
}
