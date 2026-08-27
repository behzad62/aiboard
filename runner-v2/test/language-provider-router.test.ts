import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  CodeIntelligenceResult,
  CodeLocation,
  LanguageIntelligenceProvider,
  LanguageProviderDescriptor,
} from "../src/language-intelligence.js";
import { LanguageProviderRouter } from "../src/language-provider-router.js";
import type { ConfiguredLanguageServer } from "../src/runner-capabilities-config.js";

const fixtureServer = resolve("runner-v2/test/fixtures/lsp-server.mjs");

test("language routing prefers a matching root marker, then priority, with deterministic audit metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-language-route-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.fixture"), "value\n");
  writeFileSync(join(root, "fixture.project"), "fixture\n");
  const calls: string[] = [];
  const marked = fakeProvider("marked.provider", [".fixture"], ["fixture.project"], 1, calls);
  const highPriority = fakeProvider("priority.provider", [".fixture"], [], 100, calls);
  const builtin = fakeProvider("builtin.typescript", [".ts"], [], 0, calls);
  const router = new LanguageProviderRouter({
    builtInProvider: builtin,
    extensionProviders: [
      { extensionId: "marked.extension", descriptor: marked.descriptor, provider: marked },
      { extensionId: "priority.extension", descriptor: highPriority.descriptor, provider: highPriority },
    ],
    configuredServers: [],
  });
  try {
    const result = await router.definition({
      root,
      path: "src/main.fixture",
      line: 1,
      column: 1,
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(calls, ["marked.provider"]);
    assert.deepEqual(router.auditRecords().map((record) => ({
      operation: record.operation,
      providerId: record.providerId,
      source: record.source,
      matchedRootMarker: record.matchedRootMarker,
    })), [{
      operation: "definition",
      providerId: "marked.provider",
      source: "extension:marked.extension",
      matchedRootMarker: "fixture.project",
    }]);
  } finally {
    await router.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured non-TypeScript LSP routes by extension and closes every owned process", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-language-lsp-Ω-"));
  const marker = join(root, "lsp-exit.json");
  const file = join(root, "main.py");
  writeFileSync(file, "value = 1\n");
  writeFileSync(join(root, "pyproject.toml"), "[project]\nname='fixture'\n");
  const configured: ConfiguredLanguageServer = {
    descriptor: {
      id: "configured.python",
      displayName: "Configured Python",
      extensions: [".py"],
      rootMarkers: ["pyproject.toml"],
      priority: 50,
    },
    languageId: "python",
    command: process.execPath,
    args: [fixtureServer, "--fixture-exit-file", marker],
    requestTimeoutMs: 500,
    shutdownTimeoutMs: 500,
    restartLimit: 1,
    maxDocumentBytes: 128 * 1024,
  };
  const builtin = fakeProvider("builtin.typescript", [".ts"], [], 0, []);
  const router = new LanguageProviderRouter({
    builtInProvider: builtin,
    extensionProviders: [],
    configuredServers: [configured],
  });
  try {
    const definition = await router.definition({
      root,
      path: "main.py",
      line: 1,
      column: 1,
    });
    assert.equal(definition.results[0]?.path, "main.py");
    assert.equal(router.auditRecords()[0]?.source, "configured");
  } finally {
    await router.close();
  }
  await waitFor(() => existsSync(marker));
  rmSync(root, { recursive: true, force: true });
});

test("configured LSP creates a distinct inner-root provider for each nested file marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-language-nested-roots-"));
  const first = join(root, "first project");
  const second = join(root, "second project");
  const rootLog = join(root, "lsp-roots.jsonl");
  mkdirSync(join(first, "src"), { recursive: true });
  mkdirSync(join(second, "src"), { recursive: true });
  writeFileSync(join(first, "pyproject.toml"), "[project]\nname='first'\n");
  writeFileSync(join(second, "pyproject.toml"), "[project]\nname='second'\n");
  writeFileSync(join(first, "src", "main.py"), "first = 1\n");
  writeFileSync(join(second, "src", "main.py"), "second = 2\n");
  const router = new LanguageProviderRouter({
    builtInProvider: fakeProvider("builtin.typescript", [".ts"], [], 0, []),
    extensionProviders: [],
    configuredServers: [configuredPythonServer([fixtureServer, "--fixture-root-log", rootLog])],
  });
  try {
    const firstResult = await router.definition({
      root,
      path: "first project/src/main.py",
      line: 1,
      column: 1,
    });
    const secondResult = await router.definition({
      root,
      path: "second project/src/main.py",
      line: 1,
      column: 1,
    });

    assert.deepEqual(
      [firstResult.projectConfig, secondResult.projectConfig],
      ["pyproject.toml", "pyproject.toml"],
    );
    assert.deepEqual(
      [firstResult.results[0]?.path, secondResult.results[0]?.path],
      ["src/main.py", "src/main.py"],
    );
    await waitFor(() => rootRecords(rootLog).length === 2);
    assert.deepEqual(
      rootRecords(rootLog).map((record) => record.rootUri),
      [pathToFileURL(first).href, pathToFileURL(second).href],
    );
  } finally {
    await router.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured LSP treats a directory root marker as the project root", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-language-directory-marker-"));
  const project = join(root, "nested project");
  const rootLog = join(root, "lsp-roots.jsonl");
  mkdirSync(join(project, ".fixture-root"), { recursive: true });
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "src", "main.py"), "value = 1\n");
  const router = new LanguageProviderRouter({
    builtInProvider: fakeProvider("builtin.typescript", [".ts"], [], 0, []),
    extensionProviders: [],
    configuredServers: [configuredPythonServer([
      fixtureServer,
      "--fixture-root-log",
      rootLog,
    ], [".fixture-root"])],
  });
  try {
    const result = await router.definition({
      root,
      path: "nested project/src/main.py",
      line: 1,
      column: 1,
    });
    assert.equal(result.projectConfig, undefined);
    assert.equal(result.results[0]?.path, "src/main.py");
    await waitFor(() => rootRecords(rootLog).length === 1);
    assert.deepEqual(rootRecords(rootLog)[0]?.rootUri, pathToFileURL(project).href);
  } finally {
    await router.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("language routing rejects provider identity collisions before any query", () => {
  const builtin = fakeProvider("builtin.typescript", [".ts"], [], 0, []);
  assert.throws(
    () => new LanguageProviderRouter({
      builtInProvider: builtin,
      extensionProviders: [],
      configuredServers: [{
        descriptor: { ...builtin.descriptor },
        languageId: "typescript",
        command: process.execPath,
        args: [],
      }],
    }),
    /duplicate language provider.*builtin\.typescript/i,
  );
});

function fakeProvider(
  id: string,
  extensions: string[],
  rootMarkers: string[],
  priority: number,
  calls: string[],
): LanguageIntelligenceProvider {
  const descriptor: LanguageProviderDescriptor = {
    id,
    displayName: id,
    extensions,
    rootMarkers,
    priority,
  };
  const result = (): CodeIntelligenceResult<CodeLocation> => ({
    status: "ok",
    results: [{ path: "src/main.fixture", line: 1, column: 1, preview: "value" }],
    truncated: false,
  });
  return {
    descriptor,
    workspaceSymbols: async () => ({ status: "ok", results: [], truncated: false }),
    definition: async () => { calls.push(id); return result(); },
    references: async () => result(),
    diagnostics: async () => ({ status: "ok", results: [], truncated: false }),
    close: async () => undefined,
  };
}

function configuredPythonServer(
  args: string[],
  rootMarkers = ["pyproject.toml"],
): ConfiguredLanguageServer {
  return {
    descriptor: {
      id: "configured.python",
      displayName: "Configured Python",
      extensions: [".py"],
      rootMarkers,
      priority: 50,
    },
    languageId: "python",
    command: process.execPath,
    args,
    requestTimeoutMs: 500,
    shutdownTimeoutMs: 500,
    restartLimit: 1,
    maxDocumentBytes: 128 * 1024,
  };
}

function rootRecords(path: string): Array<{ rootUri: string }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { rootUri: string });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for language server cleanup.");
}
