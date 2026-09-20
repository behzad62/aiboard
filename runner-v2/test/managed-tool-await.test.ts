import assert from "node:assert/strict";
import test from "node:test";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { ManagedProcessError, type ManagedProcessService } from "../src/managed-process.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
const snapshot = { processId: "owned", pid: 1, status: "running" as const, exitCode: null, signal: null,
  startedAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z", stdout: "ready", stderr: "" };
for (const name of ["process.poll", "process.list"] as const) {
  test(`managed ${name} awaits its bounded shared observation before forming public JSON`, async () => {
    const service = { poll: async () => snapshot, list: async () => [snapshot] } as unknown as ManagedProcessService;
    const tool = createManagedProcessTools(service).find(tool => tool.definition.name === name)!;
    const result = await tool.execute({ processId: "owned" }, {} as ToolExecutionContext);
    assert.equal(result.isError, false);
    const json = result.content.find(block => block.type === "json"); assert.ok(json?.type === "json");
    if (name === "process.list") assert.deepEqual(json.value, { processes: [snapshot] });
    else { const { stdout: _stdout, stderr: _stderr, ...metadata } = snapshot; assert.deepEqual(json.value, metadata); }
  });
  test(`managed ${name} translates an asynchronous observation refusal into the existing typed tool error`, async () => {
    const fail = async () => { throw new ManagedProcessError("process_not_owned", "Exact owner refused"); };
    const service = { poll: fail, list: fail } as unknown as ManagedProcessService;
    const tool = createManagedProcessTools(service).find(tool => tool.definition.name === name)!;
    const result = await tool.execute({ processId: "owned" }, {} as ToolExecutionContext);
    assert.equal(result.isError, true); assert.equal(result.error?.code, "process_not_owned");
  });
}
