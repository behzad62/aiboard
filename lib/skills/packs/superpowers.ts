import type { SkillCard } from "../types";

export const SUPERPOWERS_SKILLS: SkillCard[] = [
  {
    id: "superpowers:brainstorming",
    source: "superpowers",
    title: "Brainstorming",
    phase: "define",
    actors: ["architect"],
    persistence: "phase",
    triggers: ["vague request", "non-trivial design", "approval gate"],
    compact:
      "Explore context, clarify success criteria, compare approaches, and get design approval before coding when the request is non-trivial or high-risk. In AIBoard this can run as Fast, Balanced, or Strict intake policy.",
  },
  {
    id: "superpowers:writing-plans",
    source: "superpowers",
    title: "Writing Plans",
    phase: "plan",
    actors: ["architect"],
    persistence: "phase",
    triggers: ["implementation plan", "worker handoff", "exact files"],
    compact:
      "Plans must name exact files, interfaces, commands, dependencies, and acceptance criteria. Avoid placeholders. Prefer small steps that an isolated worker can execute and a reviewer can verify.",
  },
  {
    id: "superpowers:systematic-debugging",
    source: "superpowers",
    title: "Systematic Debugging",
    phase: "verify",
    actors: ["worker", "reviewer", "architect"],
    persistence: "task",
    triggers: ["bug", "failure", "regression", "unexpected behavior", "test failure"],
    compact:
      "Find root cause before fixing. Reproduce consistently, read the error, trace the data flow, compare working examples, form one hypothesis, add a failing case, then make the smallest verified fix.",
    evidenceRequirements: [
      "Root cause or reproduction identified before the fix",
      "Fix verified against the reproduced failure",
    ],
  },
  {
    id: "superpowers:strict-test-driven-development",
    source: "superpowers",
    title: "Strict Test-Driven Development",
    phase: "build",
    actors: ["worker"],
    persistence: "task",
    triggers: ["strict mode", "mature test harness", "user requires TDD"],
    conflicts: ["agent:test-driven-development"],
    compact:
      "No production code before a failing test. Watch RED fail for the expected reason, write only enough code for GREEN, then refactor while staying green. If code was written first, discard it and restart from the failing test.",
    evidenceRequirements: [
      "RED failure observed for the expected reason",
      "GREEN pass observed after minimal implementation",
      "Refactor kept checks green or was not needed",
    ],
  },
  {
    id: "superpowers:subagent-driven-development",
    source: "superpowers",
    title: "Subagent-Driven Development",
    phase: "build",
    actors: ["architect"],
    persistence: "phase",
    triggers: ["parallel workers", "fresh task context", "per-task review"],
    compact:
      "Use fresh isolated context per task, keep each worker focused on one deliverable, and review each result before dependent work proceeds. AIBoard workers already provide the isolation; the Architect enforces handoff quality.",
  },
  {
    id: "superpowers:using-git-worktrees",
    source: "superpowers",
    title: "Using Git Worktrees",
    phase: "build",
    actors: ["architect"],
    persistence: "session",
    triggers: ["repo runner", "feature branch", "isolated workspace", "strict mode"],
    riskLevel: "medium",
    compact:
      "Check whether the workspace is already isolated, confirm a clean baseline, then use a feature branch or worktree through AIBoard runner policy. Start with one Build-run workspace; avoid per-worker worktrees until merge handling exists.",
  },
  {
    id: "superpowers:requesting-code-review",
    source: "superpowers",
    title: "Requesting Code Review",
    phase: "review",
    actors: ["architect", "reviewer"],
    persistence: "review",
    triggers: ["task complete", "major feature", "before done"],
    compact:
      "Use review as a required gate after task execution and before final completion. Separate spec compliance from code quality, then feed findings back to the Architect for approve/fix decisions.",
    evidenceRequirements: ["Review findings considered before approval"],
  },
];
