import type { NativeToolChoice, NativeToolDefinition } from "./base";
import type { ToolIntent } from "./tool-capabilities";
import {
  DEFAULT_TOOL_SEARCH_THRESHOLD,
  type LogicalToolEntry,
} from "./tool-inventory";

export interface ProviderToolRequest {
  toolIntents: ToolIntent[];
  toolInventory: LogicalToolEntry[];
  functionTools?: NativeToolDefinition[];
  toolChoice?: NativeToolChoice;
}

function addIntent(intents: ToolIntent[], intent: ToolIntent): void {
  const existing = intents.find((candidate) => candidate.id === intent.id);
  if (!existing) {
    intents.push({
      ...intent,
      ...(intent.parameters ? { parameters: { ...intent.parameters } } : {}),
    });
    return;
  }
  if (intent.requirement === "required") existing.requirement = "required";
  if (existing.parameters === undefined && intent.parameters !== undefined) {
    existing.parameters = { ...intent.parameters };
  }
}

function functionRequirement(choice: NativeToolChoice | undefined): ToolIntent["requirement"] {
  return choice === "required" || (choice !== undefined && typeof choice === "object")
    ? "required"
    : "optional";
}

export function buildProviderToolRequest(input: {
  toolIntents?: readonly ToolIntent[];
  toolInventory?: readonly LogicalToolEntry[];
  functionTools?: readonly NativeToolDefinition[];
  toolChoice?: NativeToolChoice;
}): ProviderToolRequest {
  const toolIntents = (input.toolIntents ?? []).map((intent) => ({
    ...intent,
    ...(intent.parameters ? { parameters: { ...intent.parameters } } : {}),
  }));
  const toolInventory = (input.toolInventory ?? []).map((entry) => ({ ...entry }));
  const existingFunctionNames = new Set(
    toolInventory
      .filter((entry) => entry.capabilityId === "function_calling")
      .map((entry) => entry.logicalName),
  );
  for (const tool of input.functionTools ?? []) {
    if (existingFunctionNames.has(tool.name)) continue;
    existingFunctionNames.add(tool.name);
    toolInventory.push({
      logicalName: tool.name,
      capabilityId: "function_calling",
      execution: "client",
      deferLoading: tool.deferLoading,
      payload: tool,
    });
  }
  if ((input.functionTools?.length ?? 0) > 0 || existingFunctionNames.size > 0) {
    addIntent(toolIntents, {
      id: "function_calling",
      requirement: functionRequirement(input.toolChoice),
    });
  }
  if (toolInventory.length > DEFAULT_TOOL_SEARCH_THRESHOLD) {
    addIntent(toolIntents, { id: "tool_search", requirement: "optional" });
  }
  return {
    toolIntents,
    toolInventory,
    ...(input.functionTools?.length ? { functionTools: [...input.functionTools] } : {}),
    ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
  };
}
