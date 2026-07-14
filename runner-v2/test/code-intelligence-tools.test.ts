import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock, ToolResult } from "../src/agent-contracts.js";
import { createCodeIntelligenceTools } from "../src/code-intelligence-tools.js";
import { RepositoryIntelligence } from "../src/repository-intelligence.js";
import { ToolBroker } from "../src/tool-broker.js";
import { TypeScriptIntelligence } from "../src/typescript-intelligence.js";

test("code intelligence tools expose bounded read-only native contracts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-code-tools-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "value.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "script.py"), "print('hello')\n");
    const repository = new RepositoryIntelligence();
    const typescript = new TypeScriptIntelligence(repository);
    const broker = new ToolBroker({ permissionProfile: "project", workspacePath: root });
    for (const tool of createCodeIntelligenceTools({ repository, typescript })) {
      broker.register(tool);
    }

    assert.deepEqual(broker.definitions().map((item) => item.name), [
      "code.definition",
      "code.diagnostics",
      "code.references",
      "code.workspace_symbols",
      "repo.manifest",
      "repo.map",
    ]);
    assert.equal(broker.definitions().every((item) => item.readOnly), true);
    assert.equal(broker.definitions().every((item) => item.effect === "none"), true);
    const manifestSchema = broker.definitions().find(
      (item) => item.name === "repo.manifest",
    )?.inputSchema as {
      properties: { pageSize: { maximum: number } };
      additionalProperties: boolean;
    };
    assert.equal(manifestSchema.properties.pageSize.maximum, 200);
    assert.equal(manifestSchema.additionalProperties, false);

    const manifest = await invoke(broker, "manifest", "repo.manifest", {
      path: ".",
      pageSize: 2,
    });
    assert.equal(manifest.isError, false);
    assert.equal((json(manifest) as { entries: unknown[] }).entries.length, 2);

    const definition = await invoke(broker, "definition", "code.definition", {
      path: "src/value.ts",
      line: 1,
      column: 14,
    });
    assert.equal(definition.isError, false);
    assert.equal((json(definition) as { status: string }).status, "ok");

    const unsupported = await invoke(broker, "unsupported", "code.definition", {
      path: "script.py",
      line: 1,
      column: 1,
    });
    assert.deepEqual(json(unsupported), {
      status: "unsupported_language",
      results: [],
      truncated: false,
    });

    const invalid = await invoke(broker, "invalid", "code.references", {
      path: "src/value.ts",
      line: 0,
      column: 1,
    });
    assert.equal(invalid.isError, true);
    assert.equal(invalid.error?.code, "invalid_arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function invoke(
  broker: ToolBroker,
  callId: string,
  name: string,
  argumentsValue: unknown,
): Promise<ToolResult> {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId,
    name,
    arguments: argumentsValue,
  };
  return await broker.invoke(call, {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "worker", id: "worker_1" },
  });
}

function json(result: ToolResult): unknown {
  return result.content.find((block) => block.type === "json")?.value;
}
