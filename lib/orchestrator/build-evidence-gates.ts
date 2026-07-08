import type { SkillEvidence } from "@/lib/skills/types";

function evidenceKey(record: SkillEvidence): string {
  return `${record.taskId ?? ""}\u0000${record.skillId}`;
}

function isBlocking(record: SkillEvidence): boolean {
  return record.missingEvidence.length > 0 || record.violations.length > 0;
}

export function getLatestSkillEvidence(
  records: SkillEvidence[],
  taskId?: string
): SkillEvidence[] {
  const latest = new Map<string, SkillEvidence>();
  for (const record of records) {
    if (taskId != null && record.taskId !== taskId) continue;
    latest.set(evidenceKey(record), record);
  }
  return [...latest.values()];
}

export function getBlockingSkillEvidence(
  records: SkillEvidence[],
  taskId?: string
): SkillEvidence[] {
  return getLatestSkillEvidence(records, taskId).filter(isBlocking);
}

export function hasBlockingSkillEvidence(
  records: SkillEvidence[],
  taskId?: string
): boolean {
  return getBlockingSkillEvidence(records, taskId).length > 0;
}

export function formatBlockingSkillEvidence(records: SkillEvidence[]): string {
  const blocking = getBlockingSkillEvidence(records);
  if (blocking.length === 0) return "";
  return blocking
    .map((record) => {
      const target = record.taskId ? `${record.taskId} ` : "";
      const missing = record.missingEvidence.length
        ? record.missingEvidence.join("; ")
        : record.violations.join("; ");
      return `- ${target}${record.skillId}: ${missing}`;
    })
    .join("\n");
}

export function buildSkillEvidenceFixInstructions(
  records: SkillEvidence[],
  taskId: string
): string {
  const blocking = getBlockingSkillEvidence(records, taskId);
  if (blocking.length === 0) return "";
  const missing = formatBlockingSkillEvidence(blocking);
  return [
    "Required skill evidence is missing for this task.",
    "Do not rewrite the implementation blindly; inspect the current work, run or add the missing checks, and make the smallest needed correction.",
    "If the implementation already landed and no file change is required, return evidence only; do not emit dummy patches or repeat identical file writes.",
    "Return a concise `Skill evidence:` section that includes the missing RED/GREEN, root-cause, verification, review, or exemption evidence.",
    missing,
  ]
    .filter(Boolean)
    .join("\n");
}

export function evidenceOnlyRetryFiles(input: {
  emittedFiles: string[];
  priorFiles: string[];
  declaredOutputPaths?: string[];
  evidence: SkillEvidence[];
  taskId: string;
  maxFiles?: number;
  workerOutput?: string;
  ignoreBlockingSkillEvidence?: boolean;
}): string[] {
  if (input.emittedFiles.length > 0) return [...new Set(input.emittedFiles)];
  if (
    (input.declaredOutputPaths?.length ?? 0) === 0 &&
    input.priorFiles.length > 0 &&
    isScopedVerificationGapReport(input.workerOutput ?? "")
  ) {
    return [...new Set(input.priorFiles)].slice(0, input.maxFiles ?? input.priorFiles.length);
  }
  if (isWorkerOutputBlockedByToolBudget(input.workerOutput ?? "")) return [];
  if (input.priorFiles.length === 0) return [];
  if (input.evidence.length === 0) return [];
  if (!input.ignoreBlockingSkillEvidence && hasBlockingSkillEvidence(input.evidence, input.taskId)) {
    return [];
  }
  return [...new Set(input.priorFiles)].slice(0, input.maxFiles ?? input.priorFiles.length);
}

export function isWorkerOutputBlockedByToolBudget(workerOutput: string): boolean {
  const text = workerOutput.toLowerCase();
  if (!text.trim()) return false;
  const mentionsBudget =
    /no (?:worker )?command runs left/.test(text) ||
    /no (?:mcp|web fetch|fetch|tool) .*left/.test(text) ||
    /tool budget (?:was |is )?exhausted/.test(text) ||
    /command budget (?:was |is )?exhausted/.test(text);
  if (!mentionsBudget) return false;
  return /\b(blocked|could not|cannot|can't|unable|not complete|not completed|did not complete|could not complete)\b/.test(
    text
  );
}

export function isScopedVerificationGapReport(workerOutput: string): boolean {
  const text = workerOutput.trim().toLowerCase();
  if (text.length < 120) return false;
  const isVerificationReport =
    /\bverification\b/.test(text) &&
    /\b(gap|incomplete|blocked|not complete|still required|could not run|unable to run)\b/.test(
      text
    );
  if (!isVerificationReport) return false;
  const hasActionableSections =
    /evidence already obtained/.test(text) ||
    /commands? that could not run/.test(text) ||
    /final acceptance still required/.test(text) ||
    /acceptance still required/.test(text) ||
    /recommendation/.test(text);
  const namesRemainingChecks =
    /syntax checks?/.test(text) ||
    /smoke test/.test(text) ||
    /browser acceptance/.test(text) ||
    /browser_navigate/.test(text) ||
    /browser_console_messages/.test(text);
  return hasActionableSections && namesRemainingChecks;
}

export function shouldReviewEvidenceOnlyTask(input: {
  emittedFiles: string[];
  priorFiles: string[];
  declaredOutputPaths: string[];
  evidence: SkillEvidence[];
  taskId: string;
  workerOutput: string;
  ignoreBlockingSkillEvidence?: boolean;
}): boolean {
  if (input.emittedFiles.length > 0) return true;
  if (
    input.declaredOutputPaths.length === 0 &&
    isScopedVerificationGapReport(input.workerOutput)
  ) {
    return true;
  }
  if (input.priorFiles.length > 0) return false;
  if (input.declaredOutputPaths.length > 0) return false;
  if (!input.ignoreBlockingSkillEvidence && hasBlockingSkillEvidence(input.evidence, input.taskId)) {
    return false;
  }

  const text = input.workerOutput.trim();
  if (text.length < 40) return false;
  if (isWorkerOutputBlockedByToolBudget(text)) return false;
  return /\b(verified|verification|confirmed|complete|passed|clean|commit|status|no action required)\b/i.test(
    text
  );
}

export function shouldAllowEvidenceOnlySkillExemptions(input: {
  emittedFiles: string[];
  declaredOutputPaths: string[];
  taskInstructions?: string;
  taskKind?: "modify" | "audit" | "verify" | "repo";
  completionMode?: "files" | "evidence" | "either";
  verificationPolicy?: "architect" | "tool" | "external" | "none";
}): boolean {
  if (input.emittedFiles.length > 0) return false;
  if (input.verificationPolicy === "tool") return false;
  if (input.declaredOutputPaths.length === 0) return true;
  const acceptsEvidence =
    input.completionMode === "evidence" || input.completionMode === "either";
  if (
    acceptsEvidence &&
    (input.taskKind === "audit" ||
      input.taskKind === "verify" ||
      input.verificationPolicy === "architect" ||
      input.verificationPolicy === "none")
  ) {
    return true;
  }
  return /FIX \(from (?:final Build quality gate|skill evidence gate)\):/i.test(
    input.taskInstructions ?? ""
  );
}

function isWriteLandingIssue(issue: string): boolean {
  return /\b(WRITE REJECTED|CONFLICT:|Patch to|patch op\(s\)|Append to|Rewrite of|Edit to|edit\(s\)|Output was cut off mid-block|suspicious rewrite|did NOT match)\b/i.test(
    issue
  );
}

export function splitEvidenceOnlyReviewIssues(issues: string[]): {
  blocking: string[];
  warnings: string[];
} {
  const blocking: string[] = [];
  const warnings: string[] = [];
  for (const issue of issues) {
    if (isWriteLandingIssue(issue)) {
      blocking.push(issue);
    } else {
      warnings.push(issue);
    }
  }
  return { blocking, warnings };
}
