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
  {
    id: "aiboard:browser-acceptance",
    source: "aiboard",
    title: "AIBoard Browser Acceptance",
    phase: "verify",
    actors: ["worker", "reviewer", "architect"],
    persistence: "task",
    triggers: ["web app", "UI workflow", "Playwright MCP", "browser verification"],
    riskLevel: "high",
    compact:
      'Use runner commands only for shell work and MCP Playwright only for browser/page inspection. Navigate with {"action":"tool","server":"playwright","tool":"browser_navigate","args":{"url":"http://localhost:<port>"}} using the actual app URL, then use snapshot/evaluate/console tools to prove the settled UI state. Never emit bare browser_* calls, arrays of MCP calls, "arguments" instead of "args", about:blank navigation, or Playwright code that runs npm/Node/fs/shell commands.',
    evidenceRequirements: [
      "Browser action evidence: exact app URL navigated with browser_navigate",
      "Post-action settled evidence: expected content visible and no visible stuck loading, error banner, blank screen, or blocking overlay",
      "Console evidence: browser_console_messages checked for errors",
    ],
  },
];
