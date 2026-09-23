import type { ToolEffect } from "./agent-contracts.js";

/**
 * Explicit per-role tool allow-lists. A1 records today's static surfaces and
 * admits against them. It does not add tools. Server-named MCP tools are not
 * static entries; `mcpPolicy` is the dynamic group A2 can tighten.
 */
export type RoleCapabilityRole = "architect" | "verifier" | "plan-critic" | "worker";

export type RoleCapabilityBroker = "inspection" | "planOnly" | "expectations" | "task";

/**
 * `all` registers every MCP tool the manager exposes (Architect inspection and
 * the worker, as today). `none` registers none (verifier and plan critic).
 * `read-only-non-workspace` is today's Plan-only predicate for dynamic tools:
 * `readOnly && effect !== "workspace"`. It is not A2's MCP class filter.
 */
export type McpPolicy = "all" | "none" | "read-only-non-workspace";

export interface RoleToolSurface {
  readonly role: RoleCapabilityRole;
  readonly broker: RoleCapabilityBroker;
  /** Sorted static tools that are always registered for this broker. */
  readonly tools: readonly string[];
  /** Sorted static tools registered only when their dependency is configured. */
  readonly optionalTools: readonly string[];
  readonly mcpPolicy: McpPolicy;
}

export const ROLE_CAPABILITY_BROKERS = [
  { role: "architect", broker: "inspection" },
  { role: "architect", broker: "planOnly" },
  { role: "verifier", broker: "inspection" },
  { role: "verifier", broker: "expectations" },
  { role: "plan-critic", broker: "inspection" },
  { role: "worker", broker: "task" },
] as const satisfies readonly { role: RoleCapabilityRole; broker: RoleCapabilityBroker }[];

const ARCHITECT_INSPECTION_BROWSER_TOOLS = [
  "browser.click",
  "browser.close",
  "browser.drag",
  "browser.events",
  "browser.fill",
  "browser.navigate",
  "browser.open",
  "browser.screenshot",
  "browser.snapshot",
  "browser.wheel",
] as const;

const ARCHITECT_PLAN_ONLY_BROWSER_TOOLS = [
  "browser.events",
  "browser.navigate",
  "browser.open",
  "browser.screenshot",
  "browser.snapshot",
] as const;

const SURFACES: Readonly<Record<string, RoleToolSurface>> = {
  "architect:inspection": surface("architect", "inspection", "all", [
    "archive_project_memory",
    "artifact.read",
    "code.definition",
    "code.diagnostics",
    "code.references",
    "code.workspace_symbols",
    "fs.list",
    "fs.read",
    "fs.search",
    "fs.stat",
    "git.diff",
    "git.log",
    "git.remotes",
    "git.show",
    "git.status",
    "inspect_evidence",
    "list_memory_proposals",
    "list_skills",
    "promote_project_memory",
    "propose_project_memory",
    "read_skill",
    "recall_project_memory",
    "repo.manifest",
    "repo.map",
    "research.fetch",
    "search_session_history",
  ], ARCHITECT_INSPECTION_BROWSER_TOOLS),
  "architect:planOnly": surface("architect", "planOnly", "read-only-non-workspace", [
    "artifact.read",
    "code.definition",
    "code.diagnostics",
    "code.references",
    "code.workspace_symbols",
    "fs.list",
    "fs.read",
    "fs.search",
    "fs.stat",
    "git.diff",
    "git.log",
    "git.remotes",
    "git.show",
    "git.status",
    "inspect_evidence",
    "list_memory_proposals",
    "list_skills",
    "read_skill",
    "recall_project_memory",
    "repo.manifest",
    "repo.map",
    "research.fetch",
    "search_session_history",
  ], ARCHITECT_PLAN_ONLY_BROWSER_TOOLS),
  "verifier:inspection": surface("verifier", "inspection", "none", [
    "artifact.read",
    "fs.list",
    "fs.read",
    "fs.search",
    "fs.stat",
    "git.diff",
    "git.log",
    "git.show",
    "git.status",
    "inspect_evidence",
  ], ["submit_verifier_verdict"]),
  "verifier:expectations": surface("verifier", "expectations", "none", [
    "artifact.read",
    "fs.list",
    "fs.read",
    "fs.search",
    "fs.stat",
    "git.status",
    "inspect_evidence",
    "record_verification_expectations",
  ], []),
  "plan-critic:inspection": surface("plan-critic", "inspection", "none", [
    "artifact.read",
    "fs.list",
    "fs.read",
    "fs.search",
    "fs.stat",
    "git.diff",
    "git.log",
    "git.show",
    "git.status",
    "submit_plan_critique",
  ], []),
  "worker:task": surface("worker", "task", "all", [
    "artifact.read",
    "code.definition",
    "code.diagnostics",
    "code.references",
    "code.workspace_symbols",
    "fs.delete",
    "fs.list",
    "fs.move",
    "fs.patch",
    "fs.read",
    "fs.search",
    "fs.stat",
    "fs.write",
    "git.commit",
    "git.diff",
    "git.log",
    "git.push",
    "git.remotes",
    "git.show",
    "git.status",
    "process.run",
    "repo.manifest",
    "repo.map",
    "research.fetch",
    "search_session_history",
    "spawn_readonly_subagent",
    "spawn_subagent",
    "submit_task",
  ], [
    "archive_project_memory",
    "ask_architect",
    "browser.click",
    "browser.close",
    "browser.drag",
    "browser.events",
    "browser.fill",
    "browser.navigate",
    "browser.open",
    "browser.screenshot",
    "browser.snapshot",
    "browser.wheel",
    "challenge_guidance",
    "inspect_evidence",
    "list_memory_proposals",
    "list_skills",
    "process.list",
    "process.poll",
    "process.signal",
    "process.start",
    "promote_project_memory",
    "propose_project_memory",
    "read_skill",
    "recall_project_memory",
    "request_replan",
    "run_evidence_command",
  ]),
};

const CATALOG_TOOL_NAMES = new Set<string>(
  Object.values(SURFACES).flatMap((entry) => [...entry.tools, ...entry.optionalTools]),
);

/** Lifecycle and authorship tools AC-9a keeps off the verifier and plan critic. */
export const READER_AUTHORITY_FORBIDDEN_TOOLS = Object.freeze([
  "complete_run",
  "git.commit",
  "plan_final_verification",
  "plan_tasks",
  "plan_verification_repairs",
  "plan_verifier_repairs",
  "reconcile_plan",
  "request_integration",
  "resolve_plan_critique",
  "review_final_verification",
  "review_task",
  "revise_task",
  "upgrade_acceptance_contract",
]);

/** Architect lifecycle tools that live on `createArchitectTools`, not the inspection broker. */
export const ARCHITECT_LIFECYCLE_TOOLS = Object.freeze([
  "complete_run",
  "request_integration",
  "review_task",
]);

export function roleToolSurface(
  role: RoleCapabilityRole,
  broker: RoleCapabilityBroker,
): RoleToolSurface {
  const surface = SURFACES[`${role}:${broker}`];
  if (!surface) {
    throw new Error(`Role ${role} has no tool surface for broker ${broker}.`);
  }
  return surface;
}

/** Sorted union of required and optional static tools. */
export function roleAllowList(
  role: RoleCapabilityRole,
  broker: RoleCapabilityBroker,
): readonly string[] {
  const entry = roleToolSurface(role, broker);
  return Object.freeze([...entry.tools, ...entry.optionalTools].sort(compareNames));
}

export function staticToolAdmitted(
  role: RoleCapabilityRole,
  broker: RoleCapabilityBroker,
  name: string,
): boolean {
  const entry = roleToolSurface(role, broker);
  return entry.tools.includes(name) || entry.optionalTools.includes(name);
}

export function isCatalogToolName(name: string): boolean {
  return CATALOG_TOOL_NAMES.has(name);
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp.");
}

export function mcpToolAdmitted(
  policy: McpPolicy,
  definition: { readonly readOnly: boolean; readonly effect: ToolEffect },
): boolean {
  if (policy === "none") return false;
  if (policy === "all") return true;
  return definition.readOnly === true && definition.effect !== "workspace";
}

/**
 * Fails closed when a registered static name is not allow-listed, when a
 * required name is absent, or when MCP policy is `none` and an MCP name appears.
 * MCP names under `all` or `read-only-non-workspace` are dynamic and are not
 * static allow-list entries; callers admit those definitions with `mcpToolAdmitted`.
 */
export function assertRoleToolSurface(
  role: RoleCapabilityRole,
  broker: RoleCapabilityBroker,
  registeredNames: readonly string[],
): void {
  const entry = roleToolSurface(role, broker);
  const allowed = new Set<string>([...entry.tools, ...entry.optionalTools]);
  const registered = new Set<string>();
  for (const name of registeredNames) {
    if (isMcpToolName(name)) {
      if (entry.mcpPolicy === "none") {
        throw new Error(
          `Role ${role} broker ${broker} MCP tool ${name} is not admitted by policy none.`,
        );
      }
      continue;
    }
    if (!allowed.has(name)) {
      throw new Error(
        `Role ${role} broker ${broker} registered tool ${name} is not on the allow-list.`,
      );
    }
    registered.add(name);
  }
  for (const name of entry.tools) {
    if (!registered.has(name)) {
      throw new Error(`Role ${role} broker ${broker} required tool ${name} is missing.`);
    }
  }
}

function surface(
  role: RoleCapabilityRole,
  broker: RoleCapabilityBroker,
  mcpPolicy: McpPolicy,
  tools: readonly string[],
  optionalTools: readonly string[],
): RoleToolSurface {
  const required = freezeSorted(`${role}:${broker} required`, tools);
  const optional = freezeSorted(`${role}:${broker} optional`, optionalTools);
  const requiredSet = new Set<string>(required);
  for (const name of optional) {
    if (requiredSet.has(name)) {
      throw new Error(`Role ${role} broker ${broker} tool ${name} is both required and optional.`);
    }
  }
  return Object.freeze({ role, broker, tools: required, optionalTools: optional, mcpPolicy });
}

function freezeSorted(label: string, names: readonly string[]): readonly string[] {
  const sorted = [...names].sort(compareNames);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) {
      throw new Error(`Duplicate tool ${sorted[index]} on ${label}.`);
    }
  }
  return Object.freeze(sorted);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right);
}
