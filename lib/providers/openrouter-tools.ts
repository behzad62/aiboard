import type {
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
