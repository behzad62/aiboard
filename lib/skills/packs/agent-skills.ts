import type { SkillCard } from "../types";

export const AGENT_SKILLS: SkillCard[] = [
  {
    id: "agent:spec-driven-development",
    source: "agent-skills",
    title: "Spec-Driven Development",
    phase: "define",
    actors: ["architect"],
    persistence: "phase",
    triggers: ["new feature", "ambiguous request", "multi-file change"],
    compact:
      "Turn intent into explicit acceptance criteria before implementation. Surface assumptions, define scope, identify non-goals, and keep the spec small enough that workers can verify it task by task.",
  },
  {
    id: "agent:planning-and-task-breakdown",
    source: "agent-skills",
    title: "Planning And Task Breakdown",
    phase: "plan",
    actors: ["architect"],
    persistence: "phase",
    triggers: ["Architect planning", "task graph", "parallel build"],
    compact:
      "Create small vertical tasks with clear dependencies, context files, output paths, acceptance criteria, verification commands, and risk flags. Maximize independent work, but never let concurrent tasks own the same output file.",
  },
  {
    id: "agent:context-engineering",
    source: "agent-skills",
    title: "Context Engineering",
    phase: "plan",
    actors: ["architect"],
    persistence: "phase",
    triggers: ["large project", "many files", "worker context packing"],
    compact:
      "Give each actor only the context it needs: request, task, relevant file excerpts, active skill overlays, and evidence requirements. Prefer compact summaries over old full transcripts once evidence has been captured.",
  },
  {
    id: "agent:incremental-implementation",
    source: "agent-skills",
    title: "Incremental Implementation",
    phase: "build",
    actors: ["worker"],
    persistence: "task",
    triggers: ["worker coding", "task execution", "feature slice"],
    compact:
      "Build the thinnest complete slice that satisfies the assigned task. Keep the project buildable, avoid unrelated refactors, stay inside output paths, and verify the slice before claiming it is ready.",
  },
  {
    id: "agent:test-driven-development",
    source: "agent-skills",
    title: "Test-Driven Development",
    phase: "build",
    actors: ["worker"],
    persistence: "task",
    triggers: ["behavior change", "bug fix", "regression", "new logic"],
    compact:
      "For behavior-changing work, create or identify a failing check first, implement the smallest change, then show the passing check. If TDD is not practical, state the exemption reason and use the strongest available verification.",
    evidenceRequirements: [
      "RED test/check failure before implementation",
      "GREEN test/check pass after implementation",
    ],
  },
  {
    id: "agent:code-review-and-quality",
    source: "agent-skills",
    title: "Code Review And Quality",
    phase: "review",
    actors: ["reviewer", "architect"],
    persistence: "review",
    triggers: ["Architect review", "task approval", "final review"],
    compact:
      "Review correctness, readability, architecture, security, and performance. Approve only work that satisfies the task acceptance criteria and stays in scope; send precise fix instructions for gaps.",
    evidenceRequirements: [
      "Spec compliance verdict",
      "Quality verdict covering correctness, simplicity, architecture, security, and performance as relevant",
    ],
  },
  {
    id: "agent:security-and-hardening",
    source: "agent-skills",
    title: "Security And Hardening",
    phase: "verify",
    actors: ["worker", "reviewer", "architect"],
    persistence: "task",
    triggers: ["auth", "keys", "storage", "shell", "local files", "network", "LLM output"],
    riskLevel: "high",
    compact:
      "Treat untrusted input, generated code, file paths, command execution, API keys, storage, and network calls as trust boundaries. Validate inputs, keep secrets out of logs, prefer least privilege, and verify unsafe cases are rejected.",
    evidenceRequirements: ["Trust boundary reviewed and unsafe case considered"],
  },
  {
    id: "agent:frontend-ui-engineering",
    source: "agent-skills",
    title: "Frontend UI Engineering",
    phase: "build",
    actors: ["worker", "reviewer"],
    persistence: "task",
    triggers: ["React component", "UI", "CSS", "layout", "accessibility"],
    compact:
      "Follow the existing component system, make states clear, keep layout stable across viewport sizes, use semantic controls, avoid text overflow, and verify important interactions or rendering paths when tools are available.",
  },
  {
    id: "agent:api-and-interface-design",
    source: "agent-skills",
    title: "API And Interface Design",
    phase: "build",
    actors: ["architect", "worker", "reviewer"],
    persistence: "task",
    triggers: ["public function", "type contract", "provider interface", "event shape"],
    compact:
      "Keep interfaces explicit, typed, and stable. Make data contracts easy to test, keep compatibility at boundaries, and update all consumers when changing shared event or provider shapes.",
  },
  {
    id: "agent:documentation-and-adrs",
    source: "agent-skills",
    title: "Documentation And ADRs",
    phase: "ship",
    actors: ["architect", "worker"],
    persistence: "task",
    triggers: ["docs", "architecture decision", "README", "operational note"],
    compact:
      "Document decisions and operational behavior where future maintainers will look. Keep docs concise, current with code, and focused on choices that affect usage, safety, or maintenance.",
  },
  {
    id: "agent:shipping-and-launch",
    source: "agent-skills",
    title: "Shipping And Launch",
    phase: "ship",
    actors: ["architect", "reviewer"],
    persistence: "phase",
    triggers: ["finalization", "release", "handoff", "deployment"],
    compact:
      "Before handoff, verify the requested outcome, summarize changed files, note test/build evidence, document risks, and use the native AIBoard repo workflow for branch, commit, push, and PR operations.",
  },
];
