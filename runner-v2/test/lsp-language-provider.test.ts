import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { LanguageProviderDescriptor } from "../src/language-intelligence.js";
import {
  LspLanguageProvider,
  LspLanguageProviderError,
} from "../src/lsp-language-provider.js";

const fixtureServer = resolve("runner-v2/test/fixtures/lsp-server.mjs");
const descriptor: LanguageProviderDescriptor = {
  id: "fixture.python-lsp",
  displayName: "Fixture Python LSP",
  extensions: [".py"],
  rootMarkers: ["pyproject.toml"],
  priority: 20,
};

test("LSP provider maps non-TypeScript symbols, UTF-16 locations, references, and diagnostics", async () => {
  const fixture = providerFixture("provider Ω", {
    LSP_FIXTURE_EXPECT_CHARACTER: "2",
  });
  try {
    const symbols = await fixture.provider.workspaceSymbols({
      root: fixture.workspace,
      query: "value",
    });
    assert.deepEqual(symbols, {
      status: "ok",
      projectConfig: "pyproject.toml",
      results: [{
        name: "value",
        path: "main.py",
        line: 1,
        column: 3,
        preview: "😀value = 1",
        symbolKind: "variable",
      }],
      truncated: false,
    });

    const definition = await fixture.provider.definition({
      root: fixture.workspace,
      path: "main.py",
      line: 1,
      column: 3,
    });
    assert.deepEqual(definition.results, [{
      path: "main.py",
      line: 1,
      column: 3,
      preview: "😀value = 1",
    }]);

    const references = await fixture.provider.references({
      root: fixture.workspace,
      path: "main.py",
      line: 1,
      column: 3,
      limit: 1,
    });
    assert.equal(references.results.length, 1);
    assert.equal(references.truncated, true);

    const diagnostics = await fixture.provider.diagnostics({
      root: fixture.workspace,
      path: "main.py",
    });
    assert.deepEqual(diagnostics, {
      status: "ok",
      projectConfig: "pyproject.toml",
      results: [{
        path: "main.py",
        line: 2,
        column: 1,
        preview: "print(value)",
        category: "warning",
        code: "fixture-warning",
        message: `Fixture diagnostic for ${pathToFileURL(fixture.file).href}`,
      }],
      truncated: false,
    });

    const workspaceDiagnostics = await fixture.provider.diagnostics({
      root: fixture.workspace,
      limit: 10,
    });
    assert.equal(workspaceDiagnostics.results[0]?.path, "main.py");

    const unsupported = await fixture.provider.definition({
      root: fixture.workspace,
      path: "note.txt",
      line: 1,
      column: 1,
    });
    assert.deepEqual(unsupported, {
      status: "unsupported_language",
      results: [],
      truncated: false,
    });
  } finally {
    await fixture.close();
  }
});

test("LSP provider rejects escaped inputs and out-of-workspace server URIs", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-lsp-containment-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const file = join(workspace, "main.py");
  const outside = join(root, "outside.py");
  writeFileSync(file, "value = 1\n");
  writeFileSync(outside, "secret = True\n");
  writeFileSync(join(workspace, "pyproject.toml"), "[project]\nname='fixture'\n");
  const provider = createProvider(workspace, {
    LSP_FIXTURE_OUTSIDE_URI: pathToFileURL(outside).href,
  });
  try {
    await assert.rejects(
      provider.definition({
        root: workspace,
        path: "../outside.py",
        line: 1,
        column: 1,
      }),
      isProviderError("path_outside_workspace"),
    );
    await assert.rejects(
      provider.definition({
        root: workspace,
        path: "main.py",
        line: 1,
        column: 1,
      }),
      isProviderError("out_of_workspace_uri"),
    );
  } finally {
    await provider.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LSP provider rejects malformed ranges and oversized server-result files", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-lsp-hostile-result-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const file = join(workspace, "main.py");
  const large = join(workspace, "large.py");
  writeFileSync(file, "value = 1\n");
  writeFileSync(large, "x".repeat(256));
  writeFileSync(join(workspace, "pyproject.toml"), "[project]\nname='fixture'\n");

  const badRange = createProvider(workspace, { LSP_FIXTURE_BAD_RANGE: "1" });
  try {
    await assert.rejects(
      badRange.definition({ root: workspace, path: "main.py", line: 1, column: 1 }),
      isProviderError("invalid_response"),
    );
  } finally {
    await badRange.close().catch(() => undefined);
  }

  const oversized = createProvider(
    workspace,
    { LSP_FIXTURE_OUTSIDE_URI: pathToFileURL(large).href },
    32,
  );
  try {
    await assert.rejects(
      oversized.definition({ root: workspace, path: "main.py", line: 1, column: 1 }),
      isProviderError("document_too_large"),
    );
  } finally {
    await oversized.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("LSP provider uses bounded, version-matched publish diagnostics when pull is unavailable", async () => {
  const fixture = providerFixture("push diagnostics", {
    LSP_FIXTURE_DIAGNOSTICS_MODE: "push",
    LSP_FIXTURE_DIAGNOSTIC_COUNT: "3",
  });
  try {
    const result = await fixture.provider.diagnostics({
      root: fixture.workspace,
      path: "main.py",
      limit: 1,
    });
    assert.deepEqual(result.results.map((diagnostic) => diagnostic.code), ["fixture-warning"]);
    assert.equal(result.truncated, true);
  } finally {
    await fixture.close();
  }
});

test("LSP provider preserves push-only versionless diagnostics with explicit freshness metadata", async () => {
  const fixture = providerFixture("versionless push diagnostics", {
    LSP_FIXTURE_DIAGNOSTICS_MODE: "push",
    LSP_FIXTURE_PUBLISH_WITHOUT_VERSION: "1",
  }, 1_000, 80);
  try {
    const result = await fixture.provider.diagnostics({
      root: fixture.workspace,
      path: "main.py",
    });
    assert.equal(result.results[0]?.code, "fixture-warning");
    assert.equal(result.diagnosticFreshness, "unversioned");
  } finally {
    await fixture.close();
  }
});

test("LSP provider uses cached publish diagnostics when only document pull is negotiated", async () => {
  const fixture = providerFixture("partial diagnostics", {
    LSP_FIXTURE_DIAGNOSTICS_MODE: "partial",
  });
  try {
    const document = await fixture.provider.diagnostics({
      root: fixture.workspace,
      path: "main.py",
    });
    assert.equal(document.results[0]?.code, "fixture-warning");

    const workspace = await fixture.provider.diagnostics({
      root: fixture.workspace,
    });
    assert.equal(workspace.results[0]?.path, "main.py");
  } finally {
    await fixture.close();
  }
});

test("LSP provider ignores stale publish diagnostics after a bounded wait", async () => {
  const fixture = providerFixture("stale push diagnostics", {
    LSP_FIXTURE_DIAGNOSTICS_MODE: "push",
    LSP_FIXTURE_PUBLISH_STALE_VERSION: "1",
  }, 1_000, 80);
  try {
    await fixture.provider.definition({
      root: fixture.workspace,
      path: "main.py",
      line: 1,
      column: 1,
    });
    const startedAt = performance.now();
    const result = await fixture.provider.diagnostics({
      root: fixture.workspace,
      path: "main.py",
    });
    const elapsedMs = performance.now() - startedAt;
    assert.deepEqual(result.results, []);
    assert.equal(result.truncated, false);
    assert.ok(
      elapsedMs >= 50 && elapsedMs < 400,
      `stale publish diagnostics wait should use its 80ms bound, received ${elapsedMs.toFixed(1)}ms`,
    );
  } finally {
    await fixture.close();
  }
});

function providerFixture(
  name: string,
  environment: Record<string, string>,
  requestTimeoutMs = 500,
  publishDiagnosticsWaitTimeoutMs?: number,
) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-lsp-${name}-`));
  const workspace = join(root, "workspace Ω");
  mkdirSync(workspace);
  const file = join(workspace, "main.py");
  writeFileSync(file, "😀value = 1\nprint(value)\n");
  writeFileSync(join(workspace, "note.txt"), "not supported\n");
  writeFileSync(join(workspace, "pyproject.toml"), "[project]\nname='fixture'\n");
  const provider = createProvider(
    workspace,
    environment,
    128 * 1024,
    requestTimeoutMs,
    publishDiagnosticsWaitTimeoutMs,
  );
  return {
    root,
    workspace,
    file,
    provider,
    close: async () => {
      await provider.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createProvider(
  workspaceRoot: string,
  environment: Record<string, string>,
  maxDocumentBytes = 128 * 1024,
  requestTimeoutMs = 500,
  publishDiagnosticsWaitTimeoutMs?: number,
): LspLanguageProvider {
  return new LspLanguageProvider({
    descriptor,
    workspaceRoot,
    projectConfig: join(workspaceRoot, "pyproject.toml"),
    languageId: "python",
    maxDocumentBytes,
    client: {
      command: process.execPath,
      args: [fixtureServer],
      requestTimeoutMs,
      ...(publishDiagnosticsWaitTimeoutMs === undefined
        ? {}
        : { publishDiagnosticsWaitTimeoutMs }),
      shutdownTimeoutMs: 500,
      restartLimit: 1,
      env: { ...process.env, ...environment },
    },
  });
}

function isProviderError(code: string) {
  return (error: unknown) =>
    error instanceof LspLanguageProviderError && error.code === code;
}
