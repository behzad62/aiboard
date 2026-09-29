import type {
  CapabilityDecision,
  ProviderCallPlan,
  ToolCapabilityId,
  ToolExecutionLocation,
} from "./tool-capabilities";

export const DEFAULT_TOOL_SEARCH_THRESHOLD = 16;

export interface LogicalToolEntry {
  logicalName: string;
  capabilityId: ToolCapabilityId;
  execution: ToolExecutionLocation;
  namespace?: string;
  deferLoading?: boolean;
  lifecycleCritical?: boolean;
  safetyCritical?: boolean;
  mcpSourceId?: string;
  payload?: unknown;
}

export interface ResolvedToolInventoryEntry extends LogicalToolEntry {
  deferLoading: boolean;
}

export type ToolLoadingStrategy =
  | "eager"
  | "native_tool_search"
  | "orchestrator_preselection";

export interface ToolLoadingPolicyInput {
  entries: readonly LogicalToolEntry[];
  plan?: ProviderCallPlan;
  threshold?: number;
  nativeToolSearchAvailable?: boolean;
}

export interface ToolLoadingPolicyResult {
  strategy: ToolLoadingStrategy;
  tools: ResolvedToolInventoryEntry[];
  modelVisibleTools: ResolvedToolInventoryEntry[];
  orchestratorCandidates: ResolvedToolInventoryEntry[];
  namespaceGroups: Record<string, string[]>;
  decisions: CapabilityDecision[];
}

function planSupportsCapability(
  plan: ProviderCallPlan | undefined,
  capabilityId: ToolCapabilityId,
): boolean {
  return (
    plan?.enabledTools.some(
      (tool) =>
        tool.intent.id === capabilityId &&
        tool.transport === plan.transport &&
        tool.readiness === "available",
    ) ?? false
  );
}

function shouldPreferProviderMcp(plan: ProviderCallPlan | undefined): boolean {
  return planSupportsCapability(plan, "remote_mcp");
}

function dedupeMcpEntries(
  entries: readonly LogicalToolEntry[],
  plan: ProviderCallPlan | undefined,
): { entries: LogicalToolEntry[]; decisions: CapabilityDecision[] } {
  const grouped = new Map<string, LogicalToolEntry[]>();
  const ungrouped: LogicalToolEntry[] = [];

  for (const entry of entries) {
    if (!entry.mcpSourceId) {
      ungrouped.push(entry);
      continue;
    }
    const group = grouped.get(entry.mcpSourceId) ?? [];
    group.push(entry);
    grouped.set(entry.mcpSourceId, group);
  }

  const kept: LogicalToolEntry[] = [...ungrouped];
  const decisions: CapabilityDecision[] = [];
  const preferProvider = shouldPreferProviderMcp(plan);

  for (const [sourceId, group] of grouped) {
    const selected =
      group.find((entry) =>
        preferProvider ? entry.execution === "provider" : entry.execution !== "provider",
      ) ?? group[0];
    kept.push(selected);
    for (const entry of group) {
      if (entry === selected) continue;
      decisions.push({
        capabilityId: entry.capabilityId,
        code: "duplicate_mcp_path",
        reason: `MCP source ${sourceId} is already surfaced through ${selected.logicalName}.`,
        ...(plan ? { transport: plan.transport } : {}),
      });
    }
  }

  return { entries: kept, decisions };
}

function namespaceGroups(entries: readonly LogicalToolEntry[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const entry of entries) {
    if (!entry.namespace) continue;
    (result[entry.namespace] ??= []).push(entry.logicalName);
  }
  return result;
}

export function resolveToolLoadingPolicy(
  input: ToolLoadingPolicyInput,
): ToolLoadingPolicyResult {
  const threshold = input.threshold ?? DEFAULT_TOOL_SEARCH_THRESHOLD;
  const deduped = dedupeMcpEntries(input.entries, input.plan);
  const largeInventory = deduped.entries.length > threshold;
  const nativeSearchAvailable =
    input.nativeToolSearchAvailable === true ||
    planSupportsCapability(input.plan, "tool_search");
  const strategy: ToolLoadingStrategy = !largeInventory
    ? "eager"
    : nativeSearchAvailable
      ? "native_tool_search"
      : "orchestrator_preselection";

  const tools = deduped.entries.map<ResolvedToolInventoryEntry>((entry) => ({
    ...entry,
    deferLoading:
      strategy !== "eager" &&
      entry.deferLoading !== false &&
      entry.lifecycleCritical !== true &&
      entry.safetyCritical !== true,
  }));

  const modelVisibleTools =
    strategy === "orchestrator_preselection"
      ? tools.filter((entry) => !entry.deferLoading)
      : tools;
  const orchestratorCandidates =
    strategy === "orchestrator_preselection"
      ? tools.filter((entry) => entry.deferLoading)
      : [];

  return {
    strategy,
    tools,
    modelVisibleTools,
    orchestratorCandidates,
    namespaceGroups: namespaceGroups(deduped.entries),
    decisions: deduped.decisions,
  };
}
