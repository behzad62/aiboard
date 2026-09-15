import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodeIntelligenceTools } from "../src/code-intelligence-tools.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import type { LanguageIntelligenceProvider } from "../src/language-intelligence.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { ToolBroker } from "../src/tool-broker.js";
import type { RepositoryIntelligence } from "../src/repository-intelligence.js";

for (const name of ["code.workspace_symbols", "code.definition", "code.references", "code.diagnostics", "fs.write"] as const) {
  test(`LSP invocation propagates the exact original ${name} grant and identity`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p683-context-")); t.diagnostic(`invocation root acquired: ${root}`);
    const authority = createExecutionGrantAuthority();
    const context: ToolExecutionContext = { runId: "actual-run", sessionId: "actual-agent", actor: { role: "subagent", id: "actual-subagent" } };
    let original: ToolExecutionContext | undefined; let observed: ToolExecutionContext | undefined; let consumed = false;
    const invoke = async (_query: unknown, _signal?: AbortSignal, invocation?: ToolExecutionContext) => {
      observed = invocation;
      assert.ok(invocation?.executionGrant);
      authority.consume(invocation.executionGrant, { runId: context.runId, sessionId: context.sessionId,
        actor: context.actor, callId: "original-call", toolName: name, permissionProfile: "full" });
      consumed = true;
      return { status: "ok" as const, results: [], truncated: false };
    };
    const language = { descriptor: { id: "internal-router", displayName: "Router", extensions: [".py"], rootMarkers: [], priority: 0 }, workspaceSymbols: invoke, definition: invoke, references: invoke, diagnostics: invoke, close: async () => undefined } as LanguageIntelligenceProvider;
    let passed = false;
    try {
      const tools = name === "fs.write" ? createFilesystemTools({ diagnostics: language }) : createCodeIntelligenceTools({ language, repository: {} as RepositoryIntelligence });
      const tool = tools.find((tool) => tool.definition.name === name)!;
      const broker = new ToolBroker({ workspacePath: root, permissionProfile: "full", executionGrants: authority });
      broker.register({ ...tool, execute: async (input, call) => { original = call; return tool.execute(input, call); } });
      const result = await broker.invoke({ type: "tool_call", callId: "original-call", name,
        arguments: { path: name === "code.workspace_symbols" ? "." : "file.py", query: "value", line: 1, column: 1, content: "value = 1\n" } }, context);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(original?.executionGrant); assert.ok(observed, "LSP must receive the original real Broker authority");
      assert.equal(observed.executionGrant, original.executionGrant); assert.equal(observed.callId, "original-call"); assert.equal(observed.toolName, name);
      assert.deepEqual(observed.actor, context.actor); assert.equal(observed.sessionId, context.sessionId); assert.equal(observed.runId, context.runId);
      assert.equal(Object.isFrozen(observed), true); assert.equal(Object.isFrozen(observed.actor), true);
      assert.equal(consumed, true, "filesystem reservation must leave original authority consumable by diagnostics");
      assert.equal(authority.activeSnapshots().length, 0);
      if (name === "fs.write") assert.equal(await readFile(join(root, "file.py"), "utf8"), "value = 1\n");
      passed = true;
    } finally {
      await authority.revokeAll("cleanup");
      if (passed) { await rm(root, { recursive: true }); t.diagnostic(`invocation root removed: ${root}`); }
      else t.diagnostic(`invocation failure retained: ${root}`);
    }
  });
}
