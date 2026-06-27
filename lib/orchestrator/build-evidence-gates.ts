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
  evidence: SkillEvidence[];
  taskId: string;
  maxFiles?: number;
}): string[] {
  if (input.emittedFiles.length > 0) return [...new Set(input.emittedFiles)];
  if (input.priorFiles.length === 0) return [];
  if (input.evidence.length === 0) return [];
  if (hasBlockingSkillEvidence(input.evidence, input.taskId)) return [];
  return [...new Set(input.priorFiles)].slice(0, input.maxFiles ?? input.priorFiles.length);
}
