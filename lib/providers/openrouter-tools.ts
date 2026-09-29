import type {
  ChatParams,
  HostedToolDefinition,
  NativeToolChoice,
  NativeToolDefinition,
} from "./base";
import {
  DEFAULT_TOOL_SEARCH_THRESHOLD,
  resolveToolLoadingPolicy,
  type LogicalToolEntry,
} from "./tool-inventory";

export type OpenRouterToolApi = "chat-completions" | "responses";

export const OPENROUTER_TOOL_SEARCH_THRESHOLD = DEFAULT_TOOL_SEARCH_THRESHOLD;

export const DEFAULT_OPENROUTER_BUILD_HOSTED_TOOLS: HostedToolDefinition[] = [
  { type: "web_search" },
  { type: "web_fetch" },
  { type: "shell", parameters: { engine: "openrouter" } },
  { type: "datetime" },
];

const CHAT_COMPLETIONS_HOSTED_TOOLS = new Set<HostedToolDefinition["type"]>([
  "web_search",
  "web_fetch",
  "datetime",
  "image_generation",
  "advisor",
  "subagent",
  "fusion",
]);

export function openRouterHostedToolsForApi(
  tools: readonly HostedToolDefinition[] | undefined,
  api: OpenRouterToolApi
): Array<Record<string, unknown>> {
  if (!tools?.length) return [];
  const seen = new Set<string>();
  const result: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (api === "chat-completions" && !CHAT_COMPLETIONS_HOSTED_TOOLS.has(tool.type)) {
      continue;
    }
    const type = `openrouter:${tool.type}`;
    if (seen.has(type)) continue;
    seen.add(type);
    result.push({
      type,
      ...(tool.parameters ? { parameters: tool.parameters } : {}),
    });
  }
  return result;
}

function nativeToolInventory(tools: readonly NativeToolDefinition[]): LogicalToolEntry[] {
  return tools.map((tool) => ({
    logicalName: tool.name,
    capabilityId: "function_calling",
    execution: "client",
    deferLoading: tool.deferLoading,
    payload: tool,
  }));
}

export function openRouterFunctionToolsForResponses(
  tools: readonly NativeToolDefinition[] | undefined,
  threshold = OPENROUTER_TOOL_SEARCH_THRESHOLD
): { tools: Array<Record<string, unknown>>; toolSearchEnabled: boolean } {
  if (!tools?.length) return { tools: [], toolSearchEnabled: false };
  const loading = resolveToolLoadingPolicy({
    entries: nativeToolInventory(tools),
    threshold,
    nativeToolSearchAvailable: true,
  });
  const mapped = loading.modelVisibleTools.map((entry) => {
    const tool = entry.payload as NativeToolDefinition;
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: tool.strict ?? false,
      ...(entry.deferLoading ? { defer_loading: true } : {}),
    };
  });
  const toolSearchEnabled = loading.strategy === "native_tool_search";
  return {
    tools: toolSearchEnabled
      ? [{ type: "openrouter:tool_search" }, ...mapped]
      : mapped,
    toolSearchEnabled,
  };
}

function openRouterEnabledPlanTool(params: ChatParams, id: string) {
  return params.callPlan?.enabledTools.find((tool) => tool.intent.id === id);
}

function openRouterIntentParameters(
  params: ChatParams,
  id: string,
): Record<string, unknown> {
  return openRouterEnabledPlanTool(params, id)?.intent.parameters ?? {};
}

function planInventory(params: ChatParams): LogicalToolEntry[] {
  if (params.toolInventory?.length) {
    return params.toolInventory.filter(
      (entry) => entry.capabilityId === "function_calling",
    );
  }
  return nativeToolInventory(params.nativeTools ?? []);
}

const OPENROUTER_PLAN_HOSTED_CAPABILITIES = [
  "web_search",
  "web_fetch",
  "shell",
  "apply_patch",
  "datetime",
  "image_generation",
  "advisor",
  "subagent",
  "fusion",
] as const;

export function openRouterResponsesToolField(params: ChatParams): {
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  parallel_tool_calls?: boolean;
} {
  const plan = params.callPlan;
  if (!plan || plan.transport !== "responses") return {};

  const tools: Array<Record<string, unknown>> = [];
  let toolSearchAdded = false;
  if (openRouterEnabledPlanTool(params, "function_calling")) {
    const loading = resolveToolLoadingPolicy({
      entries: planInventory(params),
      plan,
      threshold: OPENROUTER_TOOL_SEARCH_THRESHOLD,
      nativeToolSearchAvailable:
        openRouterEnabledPlanTool(params, "tool_search") !== undefined,
    });
    for (const entry of loading.modelVisibleTools) {
      const tool = entry.payload as NativeToolDefinition | undefined;
      if (!tool) continue;
      tools.push({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
        ...(entry.deferLoading ? { defer_loading: true } : {}),
      });
    }
    if (loading.strategy === "native_tool_search") {
      tools.unshift({ type: "openrouter:tool_search" });
      toolSearchAdded = true;
    }
  }

  for (const capabilityId of OPENROUTER_PLAN_HOSTED_CAPABILITIES) {
    if (!openRouterEnabledPlanTool(params, capabilityId)) continue;
    tools.push({
      type: `openrouter:${capabilityId}`,
      ...(Object.keys(openRouterIntentParameters(params, capabilityId)).length
        ? { parameters: openRouterIntentParameters(params, capabilityId) }
        : {}),
    });
  }
  if (openRouterEnabledPlanTool(params, "tool_search") && !toolSearchAdded) {
    tools.push({ type: "openrouter:tool_search" });
  }

  const seen = new Set<string>();
  const deduped = tools.filter((tool, index) => {
    const type = String(tool.type ?? "unknown");
    const key = type === "function" ? `${type}:${String(tool.name ?? index)}` : type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!deduped.length) return {};
  return {
    tools: deduped,
    tool_choice:
      typeof plan.toolChoice === "object"
        ? { type: "function", name: plan.toolChoice.name }
        : plan.toolChoice,
    parallel_tool_calls: plan.parallelToolCalls,
  };
}
export function toolChoiceForResponses(
  choice: NativeToolChoice | undefined
): string | Record<string, unknown> {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

export function toolChoiceForChatCompletions(
  choice: NativeToolChoice | undefined
): string | Record<string, unknown> {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}
