import { compactSkillIndexIds, getSkillCards } from "./registry";
import type {
  BuildSkillMode,
  SkillActivation,
  SkillActivationInput,
  SkillTaskLike,
} from "./types";

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

export interface SkillSetResolution {
  ids: string[];
  warnings: string[];
}

function conflictWinner(
  left: string,
  right: string,
  skillMode: BuildSkillMode
): string {
  const pair = new Set([left, right]);
  if (
    pair.has("agent:test-driven-development") &&
    pair.has("superpowers:strict-test-driven-development")
  ) {
    return skillMode === "strict" || left === "superpowers:strict-test-driven-development"
      ? "superpowers:strict-test-driven-development"
      : right === "superpowers:strict-test-driven-development"
        ? "superpowers:strict-test-driven-development"
        : "agent:test-driven-development";
  }
  return left;
}

export function resolveSkillSet(
  ids: string[],
  options: { skillMode?: BuildSkillMode } = {}
): SkillSetResolution {
  const skillMode = options.skillMode ?? "balanced";
  const warnings: string[] = [];
  const selected: string[] = [];
  const visit = (id: string) => {
    const skill = getSkillCards([id])[0];
    if (!skill) {
      warnings.push(`Unknown skill "${id}" was ignored.`);
      return;
    }
    for (const dependency of skill.dependencies ?? []) visit(dependency);
    if (!selected.includes(id)) selected.push(id);
  };
  for (const id of ids) visit(id);

  for (const skill of getSkillCards([...selected])) {
    for (const conflict of skill.conflicts ?? []) {
      if (!selected.includes(skill.id) || !selected.includes(conflict)) continue;
      const winner = conflictWinner(skill.id, conflict, skillMode);
      const loser = winner === skill.id ? conflict : skill.id;
      selected.splice(selected.indexOf(loser), 1);
      warnings.push(`Resolved skill conflict: kept ${winner}, removed ${loser}.`);
    }
  }

  return { ids: selected, warnings };
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
    ...(task.testOutputPaths ?? []),
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
    ...(input.task?.testOutputPaths ?? []),
  ].map((path) => path.toLowerCase());
}

function writableTaskPaths(input: SkillActivationInput): string[] {
  const outputs = [
    ...(input.task?.outputPaths ?? []),
    ...(input.task?.testOutputPaths ?? []),
  ];
  return (outputs.length > 0 ? outputs : taskPaths(input)).map((path) =>
    path.toLowerCase()
  );
}

function docsOnlyTask(input: SkillActivationInput): boolean {
  const paths = writableTaskPaths(input);
  const text = taskText(input.task);
  if (paths.length === 0) return /\bdocs?\b|documentation|readme|adr/.test(text);
  const docsOnlyPaths = paths.every((path) =>
    /\.(md|mdx|txt|rst)$/.test(path) || path.includes("/docs/") || path.startsWith("docs/")
  );
  return (
    docsOnlyPaths &&
    !/\bbehavior change|implementation|source code|code path|component logic|api handler|test file|runner code\b/.test(
      text
    )
  );
}

function repoWorkflowTask(input: SkillActivationInput): boolean {
  return input.task?.kind === "repo";
}

function evidenceOnlyVerificationTask(input: SkillActivationInput): boolean {
  const kind = input.task?.kind;
  if (kind !== "audit" && kind !== "verify") return false;
  const completionMode = input.task?.completionMode;
  if (completionMode !== "evidence" && completionMode !== "either") return false;
  return (
    (input.task?.outputPaths ?? []).length === 0 &&
    (input.task?.testOutputPaths ?? []).length === 0
  );
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
    /\bui\b|frontend|web app|browser|playwright|component|layout|css|accessibility|render|tsx|jsx/.test(text) ||
    paths.some((path) =>
      path.startsWith("public/") ||
      path.startsWith("app/") ||
      path.startsWith("components/") ||
      /\.(tsx|jsx|css|scss|html)$/.test(path)
    )
  );
}

function hasBrowserMcp(input: SkillActivationInput): boolean {
  return (input.mcpServers ?? []).some((server) =>
    /playwright|browser/i.test(server)
  );
}

function needsBrowserAcceptance(input: SkillActivationInput): boolean {
  if (!hasBrowserMcp(input)) return false;
  const text = taskText(input.task);
  return (
    pathsIncludeUi(input) ||
    /\bweb app|browser acceptance|playwright|localhost|local server|ui workflow\b/.test(text)
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

function evidenceFor(ids: string[]): string[] {
  return getSkillCards(ids).flatMap((skill) =>
    (skill.evidenceRequirements ?? []).map((item) => `${skill.id}: ${item}`)
  );
}

function selectWorkerOverlays(input: SkillActivationInput): string[] {
  const skillMode = input.skillMode ?? "balanced";
  if (repoWorkflowTask(input)) {
    return needsBrowserAcceptance(input) ? ["aiboard:browser-acceptance"] : [];
  }
  if (docsOnlyTask(input)) {
    return ["agent:incremental-implementation", "agent:documentation-and-adrs"];
  }
  const verificationOnly = evidenceOnlyVerificationTask(input);

  const workflow = verificationOnly ? [] : ["agent:incremental-implementation"];
  if (!verificationOnly && changesBehavior(input)) {
    workflow.push(
      skillMode === "strict"
        ? "superpowers:strict-test-driven-development"
        : "agent:test-driven-development"
    );
  }
  if (!verificationOnly && taskLooksLikeBugFix(input)) {
    workflow.push("superpowers:systematic-debugging");
  }

  const domains: string[] = [];
  if (verificationOnly && needsBrowserAcceptance(input)) {
    domains.push("aiboard:browser-acceptance");
  }
  if (
    touchesSecurityBoundary(input) ||
    (skillMode === "safe" && (input.runnerAvailable || input.repoAvailable))
  ) {
    domains.push("agent:security-and-hardening");
  }
  if (pathsIncludeUi(input)) domains.push("agent:frontend-ui-engineering");
  if (!verificationOnly && needsBrowserAcceptance(input)) {
    domains.push("aiboard:browser-acceptance");
  }
  if (touchesApiOrContract(input)) domains.push("agent:api-and-interface-design");
  if (touchesDocs(input)) domains.push("agent:documentation-and-adrs");

  return dedupe([...workflow, ...domains]).slice(0, 4);
}

export function selectSkills(input: SkillActivationInput): SkillActivation {
  const skillMode = input.skillMode ?? "balanced";
  let overlays: string[] = [];

  if (input.phase === "intake") {
    overlays = ["agent:spec-driven-development", "superpowers:brainstorming"];
  } else if (input.phase === "plan") {
    overlays = PLAN_SKILLS;
    if (
      skillMode === "strict" ||
      input.riskFlags.some((flag) => /strict|worktree|isolation/i.test(flag))
    ) {
      overlays = [...overlays, "superpowers:using-git-worktrees"];
    }
  } else if (input.phase === "worker") {
    overlays = selectWorkerOverlays(input);
  } else if (input.phase === "review") {
    overlays = REVIEW_SKILLS;
    if (
      touchesSecurityBoundary(input) ||
      (skillMode === "safe" && (input.runnerAvailable || input.repoAvailable))
    ) {
      overlays = [...overlays, "agent:security-and-hardening"];
    }
  } else if (input.phase === "summary" || input.phase === "ship") {
    overlays = ["agent:shipping-and-launch", "agent:documentation-and-adrs"];
  }

  overlays = dedupe([...(overlays ?? []), ...(input.requestedSkillIds ?? [])]).filter(
    (id) => !ALWAYS_SKILLS.includes(id)
  );
  const resolved = resolveSkillSet(overlays, { skillMode });
  overlays = resolved.ids;
  if (input.phase === "plan") overlays = overlays.slice(0, 4);
  if (input.phase === "review") overlays = overlays.slice(0, 3);

  return {
    always: ALWAYS_SKILLS,
    index: compactSkillIndexIds(),
    overlays,
    evidenceRequired: [
      ...evidenceFor(overlays),
      ...(input.phase === "worker" && docsOnlyTask(input)
        ? [
            "agent:test-driven-development: TDD exemption - docs-only task; verify documentation content instead.",
          ]
        : []),
    ],
    warnings: resolved.warnings,
  };
}
