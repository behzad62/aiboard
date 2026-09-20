import type { ToolExecutionContext } from "./agent-contracts.js";
import type { McpManager } from "./mcp-tools.js";

/** Agent exit settles only that real identity's MCP resources. Suspension may
 * later resume under fresh call grants; no active child or reusable grant is
 * carried across the exit boundary. Primary and cleanup failures remain visible.
 */
export async function withMcpAgentLifecycle<T>(
  manager: Pick<McpManager, "closeAgent"> | undefined,
  owner: Pick<ToolExecutionContext, "runId" | "sessionId" | "actor">,
  perform: () => Promise<T>,
): Promise<T> {
  const exact = Object.freeze({ runId: owner.runId, sessionId: owner.sessionId, actor: Object.freeze({ ...owner.actor }) });
  let failed = false; let primary: unknown; let result: T | undefined;
  try { result = await perform(); } catch (error) { failed = true; primary = error; }
  try { await manager?.closeAgent(exact); }
  catch (cleanup) { throw new AggregateError(failed ? [primary, cleanup] : [cleanup], "Agent MCP cleanup remains unverified."); }
  if (failed) throw primary;
  return result!;
}
