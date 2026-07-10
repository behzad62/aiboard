import { getSkillCards } from "./registry";
import type { SkillEvidence } from "./types";

function evidenceLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => {
    const normalized = line
      .trim()
      .replace(/^#{1,6}\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    return /^skill evidence\s*:?\s*$/i.test(normalized) || /^skill evidence\s*:/i.test(normalized);
  });
  if (startIndex < 0) return [];

  const startLine = lines[startIndex]
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
  const sameLine = /^skill evidence\s*:\s*(.+)$/i.exec(startLine)?.[1];
  const rawEvidence = sameLine ? [sameLine, ...lines.slice(startIndex + 1)] : lines.slice(startIndex + 1);

  return rawEvidence
    .map((line) =>
      line
        .trim()
        .replace(/^[-*]\s*/, "")
        .replace(/^\d+\.\s*/, "")
        .replace(/\*\*/g, "")
        .trim()
    )
    .filter(Boolean)
    .filter((line) => !line.startsWith("```"))
    .slice(0, 8);
}

function hasExplicitExemption(joined: string): boolean {
  return /\b(exemption|exempt|not applicable|n\/a|not needed)\b/.test(joined);
}

function hasVerificationOnlyTddExemption(joined: string): boolean {
  return (
    hasExplicitExemption(joined) &&
    /\b(verification[- ]only|audit[- ]only|audit task|no[- ]change audit|no behavior changes?|no file modifications?|no file changes?|no source changes?|no (?:production[- ]?)?code changes?|no (?:production[- ]?)?code (?:was )?(?:added|modified|added or modified)|no implementation|not implementation|no testable behavior|without testable behavior|no executable behavior|without executable behavior|static (?:html|css|markup|documentation|docs|artifacts?))\b/.test(
      joined
    )
  );
}

function hasVerificationOnlyDebuggingExemption(joined: string): boolean {
  return (
    hasExplicitExemption(joined) &&
    /\b(verification[- ]only|no bugs? identified|no bugs?|no fixes? required|no debugging required|no implementation|not implementation)\b/.test(
      joined
    )
  );
}

function isEvidenceOnlyOptionalSkill(skillId: string): boolean {
  return (
    skillId === "aiboard:browser-acceptance" ||
    skillId === "agent:test-driven-development" ||
    skillId === "superpowers:strict-test-driven-development" ||
    skillId === "superpowers:systematic-debugging" ||
    skillId === "agent:security-and-hardening"
  );
}

function normalizeEvidencePath(rawPath: string): string {
  return rawPath.trim().replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

function isLikelyPersistedTestPath(rawPath: string): boolean {
  const path = normalizeEvidencePath(rawPath);
  if (!path) return false;
  const filename = path.split("/").pop() ?? path;
  return (
    path.startsWith("tests/") ||
    path.startsWith("test/") ||
    path.includes("/tests/") ||
    path.includes("/test/") ||
    path.includes("/__tests__/") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
    /^test[-_.].*\.[cm]?[jt]sx?$/.test(filename)
  );
}

function hasPersistedStrictTddTestEvidence(
  joined: string,
  context: SkillEvidenceContext
): boolean {
  if ((context.landedPaths ?? []).some(isLikelyPersistedTestPath)) return true;
  const declaredTestPaths = (context.declaredOutputPaths ?? [])
    .map(normalizeEvidencePath)
    .filter(isLikelyPersistedTestPath);
  if (declaredTestPaths.length === 0) return false;
  const mentionsPersistedTest =
    /\b(existing|persisted|test file|added|created|updated|modified|landed|wrote|committed)\b/.test(
      joined
    );
  return (
    mentionsPersistedTest &&
    declaredTestPaths.some((path) => joined.includes(path))
  );
}

interface SkillEvidenceContext {
  landedPaths?: string[];
  declaredOutputPaths?: string[];
  tddPhase?: "red" | "full";
}

function hasObservedRedFailure(joined: string): boolean {
  return joined.split("\n").some((line) => {
    if (!/\bred\b|\bfail(?:ed|ing|s|ure)?\b/.test(line)) return false;
    return !/\b(?:expected once|will fail|would fail|should fail|not (?:yet )?(?:run|executed)|once .{0,120}\b(?:run|executed))\b/.test(
      line
    );
  });
}

function missingForSkill(
  skillId: string,
  required: string[],
  reported: string[],
  allowVerificationOnlyExemptions: boolean,
  context: SkillEvidenceContext
): string[] {
  if (reported.length === 0) {
    if (
      context.tddPhase === "red" &&
      (skillId === "agent:test-driven-development" ||
        skillId === "superpowers:strict-test-driven-development")
    ) {
      return [
        "RED test/check failure before implementation",
        ...(skillId === "superpowers:strict-test-driven-development"
          ? [
              "Persisted test file evidence (added/updated or identified existing test file)",
            ]
          : []),
      ];
    }
    return allowVerificationOnlyExemptions && isEvidenceOnlyOptionalSkill(skillId)
      ? []
      : required;
  }
  const joined = reported.join("\n").toLowerCase();
  if (
    skillId === "agent:test-driven-development" ||
    skillId === "superpowers:strict-test-driven-development"
  ) {
    if (allowVerificationOnlyExemptions && hasVerificationOnlyTddExemption(joined)) {
      return [];
    }
    const missing: string[] = [];
    if (!hasObservedRedFailure(joined)) {
      missing.push("RED test/check failure before implementation");
    }
    if (
      context.tddPhase !== "red" &&
      !/\bgreen\b|pass|passed|passing/.test(joined)
    ) {
      missing.push("GREEN test/check pass after implementation");
    }
    if (
      skillId === "superpowers:strict-test-driven-development" &&
      context.tddPhase !== "red" &&
      !/refactor|no refactor|kept.*green/.test(joined)
    ) {
      missing.push("Refactor kept checks green or was not needed");
    }
    if (
      skillId === "superpowers:strict-test-driven-development" &&
      !hasPersistedStrictTddTestEvidence(joined, context)
    ) {
      missing.push("Persisted test file evidence (added/updated or identified existing test file)");
    }
    return missing;
  }
  if (skillId === "superpowers:systematic-debugging") {
    if (allowVerificationOnlyExemptions && hasVerificationOnlyDebuggingExemption(joined)) {
      return [];
    }
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
    if (allowVerificationOnlyExemptions) return [];
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
  wave?: number;
  actor: string;
  activeSkillIds: string[];
  workerOutput: string;
  landedPaths?: string[];
  declaredOutputPaths?: string[];
  allowVerificationOnlyExemptions?: boolean;
  tddPhase?: "red" | "full";
}): SkillEvidence[] {
  const reported = evidenceLines(input.workerOutput);
  return getSkillCards(input.activeSkillIds)
    .filter((skill) => (skill.evidenceRequirements ?? []).length > 0)
    .map((skill) => {
      const required = skill.evidenceRequirements ?? [];
      const missingEvidence = missingForSkill(
        skill.id,
        required,
        reported,
        input.allowVerificationOnlyExemptions ?? false,
        {
          landedPaths: input.landedPaths,
          declaredOutputPaths: input.declaredOutputPaths,
          tddPhase: input.tddPhase,
        }
      );
      return {
        taskId: input.taskId,
        wave: Number.isFinite(input.wave) ? input.wave : undefined,
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
