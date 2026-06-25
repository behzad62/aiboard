import type { SkillCard } from "../types";

export const AIBOARD_CORE_SKILLS: SkillCard[] = [
  {
    id: "aiboard:build-os",
    source: "aiboard",
    title: "AIBoard Build OS",
    phase: "meta",
    actors: ["all"],
    persistence: "always",
    triggers: ["every Build-mode prompt"],
    riskLevel: "medium",
    compact:
      "The Architect is the senior engineer. It plans bounded work, workers implement assigned tasks, and the Architect reviews, fixes, and decides completion. Preserve AIBoard authority: the engine owns context packing, file writes, runner calls, repository actions, approvals, and final handoff.",
  },
  {
    id: "aiboard:tool-protocol",
    source: "aiboard",
    title: "AIBoard Tool Protocol",
    phase: "meta",
    actors: ["all"],
    persistence: "always",
    triggers: ["file, shell, fetch, MCP, and repo operations"],
    riskLevel: "high",
    compact:
      "Use AIBoard typed actions for reads, searches, patches, appends, commands, MCP tools, fetches, and repo workflow. Do not bypass approval gates or replace typed repo actions with raw git/gh commands. Tool results are evidence; do not claim a result before the engine reports it.",
  },
  {
    id: "aiboard:repo-safety",
    source: "aiboard",
    title: "AIBoard Repo Safety",
    phase: "meta",
    actors: ["architect", "worker", "reviewer"],
    persistence: "always",
    triggers: ["runner writes, git, GitHub, local folders, project files"],
    riskLevel: "high",
    compact:
      "Keep writes scoped to declared output paths and project-safe locations. Mutating repo actions require the typed workflow and feature-branch discipline. Treat paths, shell commands, API keys, local files, and LLM-generated patches as trust boundaries that require explicit verification.",
  },
];
