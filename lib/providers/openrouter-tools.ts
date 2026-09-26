import type {
  HostedToolDefinition,
  NativeToolChoice,
  NativeToolDefinition,
} from "./base";

export type OpenRouterToolApi = "chat-completions" | "responses";

export const OPENROUTER_TOOL_SEARCH_THRESHOLD = 16;

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

export function openRouterFunctionToolsForResponses(
  tools: readonly NativeToolDefinition[] | undefined,
  threshold = OPENROUTER_TOOL_SEARCH_THRESHOLD
): { tools: Array<Record<string, unknown>>; toolSearchEnabled: boolean } {
  if (!tools?.length) return { tools: [], toolSearchEnabled: false };
  const toolSearchEnabled = tools.length > threshold;
  const mapped = tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict ?? false,
    ...(toolSearchEnabled && tool.deferLoading !== false
      ? { defer_loading: true }
      : {}),
  }));
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
