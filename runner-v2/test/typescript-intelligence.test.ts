import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TypeScriptIntelligence } from "../src/typescript-intelligence.js";

test("TypeScript intelligence resolves symbols, aliases, references, and diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-typescript-intelligence-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["src/**/*.ts"],
    }));
    writeFileSync(
      join(root, "src", "math.ts"),
      "export function add(left: number, right: number): number { return left + right; }\n",
    );
    writeFileSync(
      join(root, "src", "app.ts"),
      [
        'import { add } from "@/math";',
        "export const total: string = add(1, 2);",
        "export const doubled = add(3, 4);",
        "",
      ].join("\n"),
    );

    const service = new TypeScriptIntelligence();
    const symbols = await service.workspaceSymbols({ root, query: "add" });
    assert.equal(symbols.status, "ok");
    assert.equal(symbols.projectConfig, "tsconfig.json");
    assert.ok(symbols.results.some((symbol) =>
      symbol.name === "add" && symbol.path === "src/math.ts" && symbol.line === 1
    ));

    const definition = await service.definition({
      root,
      path: "src/app.ts",
      line: 1,
      column: 10,
    });
    assert.deepEqual(definition.results.map((item) => ({
      path: item.path,
      line: item.line,
      column: item.column,
    })), [{ path: "src/math.ts", line: 1, column: 17 }]);

    const references = await service.references({
      root,
      path: "src/app.ts",
      line: 1,
      column: 10,
    });
    assert.ok(references.results.some((item) => item.path === "src/math.ts"));
    assert.equal(references.results.filter((item) => item.path === "src/app.ts").length, 3);

    const diagnostics = await service.diagnostics({ root, path: "src/app.ts" });
    assert.equal(diagnostics.status, "ok");
    assert.ok(diagnostics.results.some((item) => item.code === 2322));

    const missing = await service.definition({
      root,
      path: "src/app.ts",
      line: 4,
      column: 1,
    });
    assert.deepEqual(missing.results, []);

    writeFileSync(join(root, "script.py"), "print('hello')\n");
    const unsupported = await service.definition({
      root,
      path: "script.py",
      line: 1,
      column: 1,
    });
    assert.deepEqual(unsupported, {
      status: "unsupported_language",
      results: [],
      truncated: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
