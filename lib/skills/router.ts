import { compactSkillIndexIds, getSkillCards } from "./registry";
import type { SkillActivation, SkillActivationInput, SkillTaskLike } from "./types";

const ALWAYS_SKILLS = [
  "aiboard:build-os",
  "aiboard:tool-protocol",
  "aiboard:repo-safety",
];

const PLAN_SKILLS = [
  "agent:planning-and-task-breakdown",
  "superpowers:writing-plans",
  "agent:context-engineering",
];

const REVIEW_SKILLS = [
  "agent:code-review-and-quality",
  "superpowers:requesting-code-review",
];

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

function taskText(task?: SkillTaskLike): string {
  if (!task) return "";
  return [
    task.id,
    task.title,
    task.instructions,
    task.expectedOutputs,
    ...(task.contextFiles ?? []),
    ...(task.outputPaths ?? []),
    task.status,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function taskPaths(input: SkillActivationInput): string[] {
  return [
    ...(input.touchedPaths ?? []),
    ...(input.task?.contextFiles ?? []),
    ...(input.task?.outputPaths ?? []),
  ].map((path) => path.toLowerCase());
}

function docsOnlyTask(input: SkillActivationInput): boolean {
  const paths = taskPaths(input);
  const text = taskText(input.task);
  if (paths.length === 0) return /\bdocs?\b|documentation|readme|adr/.test(text);
  const docsOnlyPaths = paths.every((path) =>
    /\.(md|mdx|txt|rst)$/.test(path) || path.includes("/docs/") || path.startsWith("docs/")
  );
  return docsOnlyPaths && !/\bbug|fix|behavior|logic|component|api|test|runner\b/.test(text);
}

function configOnlyTask(input: SkillActivationInput): boolean {
  const paths = taskPaths(input);
  return (
    paths.length > 0 &&
    paths.every((path) =>
      /(^|\/)(package-lock\.json|\.env\.example|\.gitignore|\.npmrc)$/.test(path) ||
      /\.(json|yaml|yml|toml|ini)$/.test(path)
    )
  );
}

function changesBehavior(input: SkillActivationInput): boolean {
  if (docsOnlyTask(input) || configOnlyTask(input)) return false;
  const text = taskText(input.task);
  if (!text) return input.phase === "worker";
  return !/\bcopy edit|comment only|docs only|documentation only\b/.test(text);
}

function taskLooksLikeBugFix(input: SkillActivationInput): boolean {
  const text = taskText(input.task);
  return (
    input.task?.status === "fixing" ||
    /\bbug|fix|regression|failing|failure|error|broken|crash|exception|unexpected\b/.test(text)
  );
}

function pathsIncludeUi(input: SkillActivationInput): boolean {
  const text = taskText(input.task);
  const paths = taskPaths(input);
  return (
    /\bui\b|frontend|component|layout|css|accessibility|render|tsx|jsx/.test(text) ||
    paths.some((path) =>
      path.startsWith("app/") ||
      path.startsWith("components/") ||
      /\.(tsx|jsx|css|scss)$/.test(path)
    )
  );
}

function touchesSecurityBoundary(input: SkillActivationInput): boolean {
  const text = taskText(input.task);
  const paths = taskPaths(input);
  return (
    input.riskFlags.some((flag) => /security|trust|runner|repo|github|shell|storage/i.test(flag)) ||
    /\bauth|api key|secret|encrypt|decrypt|crypto|token|storage|indexeddb|file system|filesystem|path|shell|command|runner|mcp|git|github|network|fetch|cors|sanitize|untrusted\b/.test(text) ||
    paths.some((path) =>
      path.includes("runner") ||
      path.includes("crypto") ||
      path.includes("storage") ||
      path.includes("project-fs") ||
      path.includes("repo") ||
      path.includes("providers")
    )
  );
}

function touchesApiOrContract(input: SkillActivationInput): boolean {
  const text = taskText(input.task);
  const paths = taskPaths(input);
  return (
    /\bapi\b|interface|contract|schema|event|provider|registry|type\b/.test(text) ||
    paths.some((path) =>
      path.includes("providers") ||
      path.includes("schema") ||
      path.includes("orchestrator") ||
      path.endsWith(".d.ts")
    )
  );
}

function touchesDocs(input: SkillActivationInput): boolean {
  const text = taskText(input.task);
  return docsOnlyTask(input) || /\bdocs?\b|documentation|readme|adr|handoff/.test(text);
}

function evidenceFor(ids: string[], input: SkillActivationInput): string[] {
  const requirements = getSkillCards(ids).flatMap((skill) =>
    (skill.evidenceRequirements ?? []).map((item) => `${skill.id}: ${item}`)
  );
  if (
    input.phase === "worker" &&
    !ids.includes("agent:test-driven-development") &&
    (docsOnlyTask(input) || configOnlyTask(input))
  ) {
    requirements.push(
      "TDD exemption: state why this task is docs/config-only and list the verification used instead"
    );
  }
  return requirements;
}

function selectWorkerOverlays(input: SkillActivationInput): string[] {
  if (docsOnlyTask(input)) {
    return ["agent:incremental-implementation", "agent:documentation-and-adrs"];
  }

  const workflow = ["agent:incremental-implementation"];
  if (changesBehavior(input)) workflow.push("agent:test-driven-development");
  if (taskLooksLikeBugFix(input)) workflow.push("superpowers:systematic-debugging");

  const domains: string[] = [];
  if (touchesSecurityBoundary(input)) domains.push("agent:security-and-hardening");
  if (pathsIncludeUi(input)) domains.push("agent:frontend-ui-engineering");
  if (touchesApiOrContract(input)) domains.push("agent:api-and-interface-design");
  if (touchesDocs(input)) domains.push("agent:documentation-and-adrs");

  return dedupe([...workflow, ...domains]).slice(0, 3);
}

export function selectSkills(input: SkillActivationInput): SkillActivation {
  let overlays: string[] = [];

  if (input.phase === "intake") {
    overlays = ["agent:spec-driven-development", "superpowers:brainstorming"];
  } else if (input.phase === "plan") {
    overlays = PLAN_SKILLS;
    if (input.riskFlags.some((flag) => /strict|worktree|isolation/i.test(flag))) {
      overlays = [...overlays, "superpowers:using-git-worktrees"];
    }
  } else if (input.phase === "worker") {
    overlays = selectWorkerOverlays(input);
  } else if (input.phase === "review") {
    overlays = REVIEW_SKILLS;
    if (touchesSecurityBoundary(input)) overlays = [...overlays, "agent:security-and-hardening"];
  } else if (input.phase === "summary" || input.phase === "ship") {
    overlays = ["agent:shipping-and-launch", "agent:documentation-and-adrs"];
  }

  overlays = dedupe(overlays).filter((id) => !ALWAYS_SKILLS.includes(id));
  if (input.phase === "plan") overlays = overlays.slice(0, 4);
  if (input.phase === "review") overlays = overlays.slice(0, 3);

  return {
    always: ALWAYS_SKILLS,
    index: compactSkillIndexIds(),
    overlays,
    evidenceRequired: evidenceFor(overlays, input),
  };
}
