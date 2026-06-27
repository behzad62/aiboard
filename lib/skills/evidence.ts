import { getSkillCards } from "./registry";
import type { SkillEvidence } from "./types";

function evidenceLines(text: string): string[] {
  const match = /skill evidence\s*:([\s\S]*)/i.exec(text);
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"))
    .slice(0, 8);
}

function missingForSkill(skillId: string, required: string[], reported: string[]): string[] {
  if (reported.length === 0) return required;
  const joined = reported.join("\n").toLowerCase();
  if (
    skillId === "agent:test-driven-development" ||
    skillId === "superpowers:strict-test-driven-development"
  ) {
    const missing: string[] = [];
    if (!/\bred\b|fail|failed|failing/.test(joined)) {
      missing.push("RED test/check failure before implementation");
    }
    if (!/\bgreen\b|pass|passed|passing/.test(joined)) {
      missing.push("GREEN test/check pass after implementation");
    }
    if (
      skillId === "superpowers:strict-test-driven-development" &&
      !/refactor|no refactor|kept.*green/.test(joined)
    ) {
      missing.push("Refactor kept checks green or was not needed");
    }
    return missing;
  }
  if (skillId === "superpowers:systematic-debugging") {
    const missing: string[] = [];
    if (!/root cause|repro|reproduce|hypothesis|trace/.test(joined)) {
      missing.push("Root cause or reproduction identified before the fix");
    }
    if (!/verify|verified|pass|passed|fixed/.test(joined)) {
      missing.push("Fix verified against the reproduced failure");
    }
    return missing;
  }
  if (skillId === "aiboard:browser-acceptance") {
    const missing: string[] = [];
    if (!/browser_navigate/.test(joined) || !/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)/.test(joined)) {
      missing.push("Browser action evidence: exact app URL navigated with browser_navigate");
    }
    if (
      !/(browser_snapshot|browser_evaluate|snapshot|evaluate)/.test(joined) ||
      !/(expected content|content visible|visible)/.test(joined) ||
      !/(no visible stuck loading|no stuck loading|no loading)/.test(joined) ||
      !/(no error|no error banner|no visible error)/.test(joined) ||
      !/(no blank screen|not blank)/.test(joined) ||
      !/(no blocking overlay|no overlay)/.test(joined)
    ) {
      missing.push("Post-action settled evidence: expected content visible and no visible stuck loading, error banner, blank screen, or blocking overlay");
    }
    if (!/browser_console_messages/.test(joined) || !/(no console errors|console.*no errors|0 console errors|returned no)/.test(joined)) {
      missing.push("Console evidence: browser_console_messages checked for errors");
    }
    return missing;
  }
  if (skillId === "agent:security-and-hardening") {
    if (
      !/(trust boundary|unsafe case|untrusted|secret|api key|token|path traversal|file path|shell|command|network|storage|sanitize|validated|rejected)/.test(
        joined
      )
    ) {
      return required;
    }
    return [];
  }
  return [];
}

export function createSkillEvidence(input: {
  taskId?: string;
  actor: string;
  activeSkillIds: string[];
  workerOutput: string;
}): SkillEvidence[] {
  const reported = evidenceLines(input.workerOutput);
  return getSkillCards(input.activeSkillIds)
    .filter((skill) => (skill.evidenceRequirements ?? []).length > 0)
    .map((skill) => {
      const required = skill.evidenceRequirements ?? [];
      const missingEvidence = missingForSkill(skill.id, required, reported);
      return {
        taskId: input.taskId,
        skillId: skill.id,
        actor: input.actor,
        required,
        reportedEvidence: reported,
        missingEvidence,
        violations:
          missingEvidence.length > 0
            ? [`Missing required evidence for ${skill.id}: ${missingEvidence.join("; ")}`]
            : [],
      };
    });
}

export function formatSkillEvidenceDigest(records: SkillEvidence[]): string {
  if (records.length === 0) return "";
  return [
    "Skill evidence:",
    ...records.map((record) => {
      const target = record.taskId ? `${record.taskId} ` : "";
      const reported =
        record.reportedEvidence.length > 0
          ? `reported ${record.reportedEvidence.join(" | ")}`
          : "reported no evidence";
      const missing =
        record.missingEvidence.length > 0
          ? `; missing ${record.missingEvidence.join("; ")}`
          : "; complete";
      return `- ${target}${record.skillId} (${record.actor}): ${reported}${missing}`;
    }),
  ].join("\n");
}
