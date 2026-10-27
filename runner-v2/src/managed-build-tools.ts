import type { NativeTool, ToolCallBlock, ToolExecutionContext, ToolResult } from "./agent-contracts.js";
import type { ToolBrokerOptions } from "./tool-broker.js";
import { ToolBroker } from "./tool-broker.js";
import type { AgentToolRuntime } from "./tool-registry.js";

export interface ManagedBuildToolSource {
  generation(): Promise<number>;
  tools(generation: number): Promise<{ tools: NativeTool<unknown>[]; close(): Promise<void> }>;
}

/** One agent's managed tools. Refresh occurs only at a model-turn boundary;
 * in-flight calls never move between generations or get replayed. */
export class ManagedBuildToolRuntime implements AgentToolRuntime {
  private current?: { generation: number; broker: ToolBroker; names: Set<string>; close(): Promise<void> };
  private inFlight = 0;

  constructor(private readonly base: AgentToolRuntime, private readonly source: ManagedBuildToolSource,
    private readonly brokerOptions: ToolBrokerOptions, private readonly admit: (tool: NativeTool<unknown>) => boolean) {}

  async prepare(): Promise<void> {
    if (this.inFlight) throw new Error("Cannot change managed capabilities while a call is in flight.");
    const generation = await this.source.generation();
    if (generation === this.current?.generation) return;
    const resource = await this.source.tools(generation);
    const broker = new ToolBroker(this.brokerOptions);
    const names = new Set<string>();
    const reserved = new Set(this.base.definitions().map(tool => tool.name));
    try {
      for (const tool of resource.tools) {
        if (!this.admit(tool)) continue;
        if (reserved.has(tool.definition.name)) throw new Error(`Managed tool ${tool.definition.name} conflicts with an existing tool.`);
        broker.register(tool); names.add(tool.definition.name);
      }
      // This runtime is per agent; other workers have their own lazy managers.
      // A failed exact cleanup prevents this agent from admitting the new surface.
      await this.current?.close();
    } catch (error) {
      try { await resource.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Managed capability transition cleanup failed."); }
      throw error;
    }
    this.current = { generation, broker, names, close: () => resource.close() };
  }

  definitions() { return [...this.base.definitions(), ...(this.current?.broker.definitions() ?? [])]; }
  isLifecycleTool(name: string) { return this.owner(name).isLifecycleTool(name); }
  isReadOnlyTool(name: string) { return this.owner(name).isReadOnlyTool(name); }
  assertUniqueCallIds(calls: readonly ToolCallBlock[], seen: ReadonlySet<string>) { this.base.assertUniqueCallIds(calls, seen); }
  async invoke(call: ToolCallBlock, context: ToolExecutionContext): Promise<ToolResult> {
    this.inFlight++;
    try { return await this.owner(call.name).invoke(call, context); }
    finally { this.inFlight--; }
  }
  async close(): Promise<void> { await this.current?.close(); this.current = undefined; }
  private owner(name: string): AgentToolRuntime { return this.current?.names.has(name) ? this.current.broker : this.base; }
}


/** Preserve the primary failure if capability cleanup also fails. */
export async function withManagedBuildToolLifecycle<T>(runtime: ManagedBuildToolRuntime | undefined, perform: () => Promise<T>): Promise<T> {
  let failed = false;
  let primary: unknown;
  let result: T | undefined;
  try { await runtime?.prepare(); result = await perform(); }
  catch (error) { failed = true; primary = error; }
  try { await runtime?.close(); }
  catch (cleanup) { throw new AggregateError(failed ? [primary, cleanup] : [cleanup], "Managed Build tool cleanup remains unverified."); }
  if (failed) throw primary;
  return result!;
}
