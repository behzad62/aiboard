import { z } from "zod/v4";

export interface McpProgress { progress: number; total?: number }
export type McpDispatchAuthorization = () => boolean | Promise<boolean>;
export type McpProgressReporter = (value: McpProgress) => void;

export function acceptMcpProgress(message: Record<string, unknown>, token: number, report: McpProgressReporter): void {
  if (message.method !== "notifications/progress" || "id" in message || typeof message.params !== "object" || !message.params) return;
  const { progressToken, progress, total } = message.params as Record<string, unknown>;
  if (progressToken !== token || typeof progress !== "number" || !Number.isFinite(progress) || progress < 0) return;
  report({ progress, ...(typeof total === "number" && Number.isFinite(total) && total >= progress ? { total } : {}) });
}

const serverId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const gatewayCallSchema = z.object({
  serverId,
  toolName: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
  // Internal signed relay capability, never exposed as a public MCP tool argument.
  forwardMcpInput: z.literal(true).optional(),
}).strict();
export type GatewayInput = z.infer<typeof gatewayCallSchema>;

export const MCP_GATEWAY_TOOLS = [
  { name: "mcp_servers_list", description: "List managed MCP servers exposed by the Runner and their connection status.", schema: z.object({}).strict() },
  { name: "mcp_tools_list", description: "List the currently approved tools, descriptions, and input schemas for an MCP server.", schema: z.object({ serverId }).strict() },
  { name: "mcp_tool_call", description: "Call an approved downstream tool by its exact server ID and tool name.", schema: gatewayCallSchema },
] as const;

export function isMcpGatewayTool(name: string): boolean {
  return MCP_GATEWAY_TOOLS.some((tool) => tool.name === name);
}
