import type {
  ChatParams,
  HostedToolDefinition,
  NativeToolChoice,
} from "./base";
import type { LogicalToolEntry } from "./tool-inventory";
import type { ToolCapabilityId, ToolIntent } from "./tool-capabilities";

export interface LegacyToolRequest {
  toolIntents: ToolIntent[];
  toolInventory: LogicalToolEntry[];
}

const LEGACY_HOSTED_BUILD_CAPABILITIES: ToolCapabilityId[] = [
  "web_search",
  "web_fetch",
  "code_execution",
  "shell",
  "datetime",
];

function nativeToolRequirement(
  choice: NativeToolChoice | undefined,
): ToolIntent["requirement"] {
  return choice === "required" || (choice !== undefined && typeof choice === "object")
    ? "required"
    : "optional";
}

function addIntent(
  intents: ToolIntent[],
  intent: ToolIntent,
): void {
  const existing = intents.find((candidate) => candidate.id === intent.id);
  if (!existing) {
    intents.push(intent);
    return;
  }
  if (intent.requirement === "required") existing.requirement = "required";
  if (existing.parameters === undefined && intent.parameters !== undefined) {
    existing.parameters = { ...intent.parameters };
  }
}

function hostedToolIntent(tool: HostedToolDefinition): ToolIntent {
  return {
    id: tool.type,
    requirement: "optional",
    ...(tool.parameters ? { parameters: { ...tool.parameters } } : {}),
  };
}

export function legacyChatParamsToToolRequest(
  params: Pick<
    ChatParams,
    | "webSearch"
    | "nativeTools"
    | "toolChoice"
    | "hostedTools"
    | "hostedBuildTools"
    | "toolIntents"
    | "toolInventory"
  >,
): LegacyToolRequest {
  if (params.toolIntents || params.toolInventory) {
    return {
      toolIntents: (params.toolIntents ?? []).map((intent) => ({
        ...intent,
        ...(intent.parameters ? { parameters: { ...intent.parameters } } : {}),
      })),
      toolInventory: (params.toolInventory ?? []).map((entry) => ({ ...entry })),
    };
  }

  const toolIntents: ToolIntent[] = [];
  if (params.webSearch) {
    addIntent(toolIntents, { id: "web_search", requirement: "optional" });
  }
  if (params.nativeTools?.length) {
    addIntent(toolIntents, {
      id: "function_calling",
      requirement: nativeToolRequirement(params.toolChoice),
    });
  }
  for (const tool of params.hostedTools ?? []) {
    addIntent(toolIntents, hostedToolIntent(tool));
  }
  if (params.hostedBuildTools) {
    for (const capabilityId of LEGACY_HOSTED_BUILD_CAPABILITIES) {
      addIntent(toolIntents, { id: capabilityId, requirement: "optional" });
    }
  }

  const toolInventory: LogicalToolEntry[] = (params.nativeTools ?? []).map((tool) => ({
    logicalName: tool.name,
    capabilityId: "function_calling",
    execution: "client",
    deferLoading: tool.deferLoading,
    payload: tool,
  }));

  return { toolIntents, toolInventory };
}

export function legacyHostedBuildCapabilities(): readonly ToolCapabilityId[] {
  return LEGACY_HOSTED_BUILD_CAPABILITIES;
}
