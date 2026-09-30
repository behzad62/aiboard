import type {
  ProviderTransportId,
  ToolCapabilityDescriptor,
  ToolCapabilityId,
  ToolExecutionLocation,
} from "./tool-capabilities";

export const CUSTOM_DECLARABLE_TOOL_CAPABILITIES = [
  "function_calling",
  "web_search",
  "file_search",
  "remote_mcp",
  "tool_search",
  "code_execution",
  "shell",
  "computer_use",
  "image_generation",
] as const satisfies readonly ToolCapabilityId[];

export type CustomDeclarableToolCapabilityId =
  (typeof CUSTOM_DECLARABLE_TOOL_CAPABILITIES)[number];

const RESPONSES_ONLY = new Set<CustomDeclarableToolCapabilityId>([
  "web_search",
  "file_search",
  "remote_mcp",
  "tool_search",
  "code_execution",
  "shell",
  "computer_use",
  "image_generation",
]);

function executionFor(id: CustomDeclarableToolCapabilityId): ToolExecutionLocation {
  return id === "function_calling" || id === "computer_use" ? "client" : "provider";
}

export function customToolCapabilityDescriptor(
  id: CustomDeclarableToolCapabilityId,
): ToolCapabilityDescriptor {
  return {
    id,
    support: "supported",
    execution: executionFor(id),
    transports: RESPONSES_ONLY.has(id)
      ? ["responses"]
      : ["chat_completions", "responses"],
    supportSource: "user-override",
  };
}

export function buildCustomToolCapabilityOverrides(
  ids: readonly CustomDeclarableToolCapabilityId[],
): ToolCapabilityDescriptor[] {
  const seen = new Set<CustomDeclarableToolCapabilityId>();
  const descriptors: ToolCapabilityDescriptor[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    descriptors.push(customToolCapabilityDescriptor(id));
  }
  return descriptors;
}

export function customCompatibleTransports(
  transports: readonly ProviderTransportId[] | undefined,
): ProviderTransportId[] {
  const allowed = new Set<ProviderTransportId>(["chat_completions", "responses"]);
  const normalized = (transports ?? ["chat_completions"]).filter((transport) =>
    allowed.has(transport),
  );
  return normalized.length > 0 ? [...new Set(normalized)] : ["chat_completions"];
}
