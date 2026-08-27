import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { createCodeIntelligenceTools } from "../src/code-intelligence-tools.js";
import type {
  LanguageIntelligenceProvider,
  PositionQuery,
} from "../src/language-intelligence.js";
import { RepositoryIntelligence } from "../src/repository-intelligence.js";
import { ToolBroker } from "../src/tool-broker.js";
import { TypeScriptIntelligence } from "../src/typescript-intelligence.js";

test("code.* tools preserve their contracts while dispatching through a generic provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-language-provider-"));
  const calls: string[] = [];
  try {
    writeFileSync(join(root, "main.py"), "value = 1\nprint(value)\n");
    const provider: LanguageIntelligenceProvider = {
      descriptor: {
        id: "fixture.python",
        displayName: "Fixture Python",
        extensions: [".py"],
        rootMarkers: ["pyproject.toml"],
        priority: 10,
      },
      workspaceSymbols: async (query) => {
        calls.push(`symbols:${query.query}`);
        return {
          status: "ok",
          projectConfig: "pyproject.toml",
          results: [{
            name: "value",
            path: "main.py",
            line: 1,
            column: 1,
            preview: "value = 1",
            symbolKind: "variable",
          }],
          truncated: false,
        };
      },
      definition: async (query) => locationResult("definition", query, calls),
      references: async (query) => locationResult("references", query, calls),
      diagnostics: async (query) => {
        calls.push(`diagnostics:${query.path}`);
        return {
          status: "ok",
          results: [{
            path: "main.py",
            line: 2,
            column: 1,
            preview: "print(value)",
            category: "warning",
            code: "fixture-warning",
            message: "Fixture diagnostic",
          }],
          truncated: false,
        };
      },
      close: async () => {
        calls.push("close");
      },
    };
    const broker = new ToolBroker({ permissionProfile: "project", workspacePath: root });
    for (const tool of createCodeIntelligenceTools({
      repository: new RepositoryIntelligence(),
      language: provider,
    })) {
      broker.register(tool);
    }

    assert.deepEqual(
      broker.definitions().map((definition) => definition.name),
      [
        "code.definition",
        "code.diagnostics",
        "code.references",
        "code.workspace_symbols",
        "repo.manifest",
        "repo.map",
      ],
    );
    assert.deepEqual(json(await invoke(broker, "symbols", "code.workspace_symbols", {
      path: ".",
      query: "value",
    })), {
      status: "ok",
      projectConfig: "pyproject.toml",
      results: [{
        name: "value",
        path: "main.py",
        line: 1,
        column: 1,
        preview: "value = 1",
        symbolKind: "variable",
      }],
      truncated: false,
    });
    assert.equal((json(await invoke(broker, "definition", "code.definition", {
      path: "main.py",
      line: 2,
      column: 7,
    })) as { results: unknown[] }).results.length, 1);
    assert.equal((json(await invoke(broker, "references", "code.references", {
      path: "main.py",
      line: 2,
      column: 7,
    })) as { results: unknown[] }).results.length, 1);
    assert.equal((json(await invoke(broker, "diagnostics", "code.diagnostics", {
      path: "main.py",
    })) as { results: Array<{ code: string }> }).results[0]?.code, "fixture-warning");
    assert.deepEqual(calls, [
      "symbols:value",
      "definition:main.py:2:7",
      "references:main.py:2:7",
      "diagnostics:main.py",
    ]);
    await provider.close();
    assert.equal(calls.at(-1), "close");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the built-in TypeScript engine satisfies the provider contract without an external server", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-typescript-provider-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, target: "ES2022", module: "ESNext" },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(join(root, "src", "value.ts"), "export const value = 1;\n");
    const provider: LanguageIntelligenceProvider = new TypeScriptIntelligence();
    assert.equal(provider.descriptor.id, "builtin.typescript");
    assert.equal(provider.descriptor.extensions.includes(".ts"), true);
    assert.deepEqual(await provider.definition({
      root,
      path: "src/value.ts",
      line: 1,
      column: 14,
    }), {
      status: "ok",
      projectConfig: "tsconfig.json",
      results: [{
        path: "src/value.ts",
        line: 1,
        column: 14,
        preview: "export const value = 1;",
        symbolKind: "const",
      }],
      truncated: false,
    });
    await provider.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function locationResult(
  operation: string,
  query: PositionQuery,
  calls: string[],
) {
  calls.push(`${operation}:${query.path}:${query.line}:${query.column}`);
  return {
    status: "ok" as const,
    results: [{
      path: "main.py",
      line: 1,
      column: 1,
      preview: "value = 1",
      symbolKind: "variable",
    }],
    truncated: false,
  };
}

async function invoke(
  broker: ToolBroker,
  callId: string,
  name: string,
  argumentsValue: unknown,
): Promise<ToolResult> {
  return await broker.invoke({
    type: "tool_call",
    callId,
    name,
    arguments: argumentsValue,
  }, {
    runId: "run_language",
    sessionId: "session_language",
    actor: { role: "worker", id: "worker_language" },
  });
}

function json(result: ToolResult): unknown {
  return result.content.find((block) => block.type === "json")?.value;
}
