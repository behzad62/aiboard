import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodeIntelligenceTools } from "../src/code-intelligence-tools.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import type { LanguageIntelligenceProvider } from "../src/language-intelligence.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import type { RepositoryIntelligence } from "../src/repository-intelligence.js";

for (const name of ["code.workspace_symbols", "code.definition", "code.references", "code.diagnostics", "fs.write"] as const) {
  test(`LSP invocation propagates the exact original ${name} grant and identity`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p683-context-")); t.diagnostic(`synthetic invocation root acquired: ${root}`);
    const grant = Object.freeze({}) as OpaqueExecutionGrant;
    const context: ToolExecutionContext = { runId: "actual-run", sessionId: "actual-agent", actor: { role: "subagent", id: "actual-subagent" }, callId: "original-call", toolName: name, workspacePath: root, executionGrant: grant };
    let observed: ToolExecutionContext | undefined;
    const invoke = async (_query: unknown, _signal?: AbortSignal, invocation?: ToolExecutionContext) => { observed = invocation; return { status: "ok" as const, results: [], truncated: false }; };
    const language = { descriptor: { id: "internal-router", displayName: "Router", extensions: [".py"], rootMarkers: [], priority: 0 }, workspaceSymbols: invoke, definition: invoke, references: invoke, diagnostics: invoke, close: async () => undefined } as LanguageIntelligenceProvider;
    let passed = false;
    try {
      const tools = name === "fs.write" ? createFilesystemTools({ diagnostics: language }) : createCodeIntelligenceTools({ language, repository: {} as RepositoryIntelligence });
      const tool = tools.find((tool) => tool.definition.name === name)!;
      const result = await tool.execute({ path: name === "code.workspace_symbols" ? "." : "file.py", query: "value", line: 1, column: 1, content: "value = 1\n" }, context);
      assert.equal(result.isError, false); assert.ok(observed, "configured LSP must receive actual call authority, not mint an internal replacement");
      assert.equal(observed.executionGrant, grant); assert.equal(observed.callId, context.callId); assert.equal(observed.toolName, name);
      assert.deepEqual(observed.actor, context.actor); assert.equal(observed.sessionId, context.sessionId); assert.equal(observed.runId, context.runId);
      assert.equal(Object.isFrozen(observed), true); assert.equal(Object.isFrozen(observed.actor), true);
      if (name === "fs.write") assert.equal(await readFile(join(root, "file.py"), "utf8"), "value = 1\n");
      passed = true;
    } finally { if (passed) { await rm(root, { recursive: true }); t.diagnostic(`synthetic invocation root removed: ${root}`); } else t.diagnostic(`synthetic invocation failure retained: ${root}`); }
  });
}
