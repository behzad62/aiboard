import assert from "node:assert/strict";
import test from "node:test";

import type {
  NativeTool,
  ToolExecutionOutput,
} from "../src/agent-contracts.js";
import {
  RUNNER_EXTENSION_API_VERSION,
  RUNNER_EXTENSION_CONTEXT_MAX_BYTES,
  RUNNER_EXTENSION_MANIFEST_FILE,
  parseRunnerExtensionManifest,
  type RunnerExtensionContextContributor,
  type RunnerExtensionInstance,
  type RunnerExtensionTool,
} from "../src/runner-extension.js";
import {
  parseLanguageProviderDescriptor,
  type LanguageIntelligenceProvider,
} from "../src/language-intelligence.js";

test("extension manifests are versioned, exact, portable, and canonical", () => {
  assert.equal(RUNNER_EXTENSION_API_VERSION, 1);
  assert.equal(RUNNER_EXTENSION_MANIFEST_FILE, "runner-extension.json");
  const manifest = parseRunnerExtensionManifest({
    apiVersion: 1,
    id: "example.python-tools",
    name: "Python tools",
    version: "1.2.3",
    entry: "dist/index.mjs",
    capabilities: ["language_intelligence", "tools", "context"],
  });
  assert.deepEqual(manifest, {
    apiVersion: 1,
    id: "example.python-tools",
    name: "Python tools",
    version: "1.2.3",
    entry: "dist/index.mjs",
    capabilities: ["tools", "context", "language_intelligence"],
  });
  assert.throws(
    () => parseRunnerExtensionManifest({ ...manifest, apiVersion: 2 }),
    /incompatible.*API version/i,
  );
  assert.throws(
    () => parseRunnerExtensionManifest({ ...manifest, entry: "../escape.mjs" }),
    /entry/i,
  );
  assert.throws(
    () => parseRunnerExtensionManifest({ ...manifest, entry: "C:\\escape.mjs" }),
    /entry/i,
  );
  assert.throws(
    () => parseRunnerExtensionManifest({ ...manifest, capabilities: ["tools", "tools"] }),
    /duplicate.*capability/i,
  );
  assert.throws(
    () => parseRunnerExtensionManifest({ ...manifest, unexpected: true }),
    /unknown.*unexpected/i,
  );
});

test("extension capabilities expose ordinary tools, bounded optional context, and lifecycle only", async () => {
  const tool: RunnerExtensionTool<{ query: string }> = {
    definition: {
      name: "python.lookup",
      description: "Look up a Python symbol",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: (input) =>
      typeof input === "object" && input !== null &&
      typeof (input as { query?: unknown }).query === "string"
        ? { ok: true, value: input as { query: string } }
        : { ok: false, issues: ["query is required"] },
    execute: async (): Promise<ToolExecutionOutput> => ({
      content: [{ type: "text", text: "found" }],
      isError: false,
    }),
  };
  const contributor: RunnerExtensionContextContributor = {
    id: "python-project",
    kind: "extension",
    priority: 10,
    maxBytes: Math.min(4_096, RUNNER_EXTENSION_CONTEXT_MAX_BYTES),
    contribute: async () => ({ content: "Python project context" }),
  };
  const languageProvider = fixtureLanguageProvider();
  const lifecycle: string[] = [];
  const extension: RunnerExtensionInstance = {
    capabilities: () => ({
      tools: [tool],
      contextContributors: [contributor],
      languageProviders: [languageProvider],
    }),
    start: async (context) => {
      lifecycle.push(`start:${context.extensionId}:${context.stateDirectory}`);
      assert.deepEqual(
        Object.keys(context).sort(),
        ["extensionId", "signal", "stateDirectory"],
        "extension startup must not receive kernel stores",
      );
    },
    close: async () => {
      lifecycle.push("close");
    },
  };
  const capabilities = extension.capabilities();
  assert.equal(capabilities.tools[0]?.definition.lifecycle, undefined);
  assert.equal(capabilities.contextContributors[0]?.maxBytes, 4_096);
  assert.equal(capabilities.languageProviders[0]?.descriptor.id, "python-lsp");
  await extension.start({
    extensionId: "example.python-tools",
    stateDirectory: "C:\\runner-state\\extensions\\example.python-tools",
    signal: new AbortController().signal,
  });
  await extension.close();
  assert.deepEqual(lifecycle, [
    "start:example.python-tools:C:\\runner-state\\extensions\\example.python-tools",
    "close",
  ]);

  const unsafeNativeTool: NativeTool = {
    ...tool,
    definition: { ...tool.definition, lifecycle: true },
  };
  assert.equal(unsafeNativeTool.definition.lifecycle, true);
});

test("language provider descriptors use deterministic contained routing metadata", () => {
  assert.deepEqual(
    parseLanguageProviderDescriptor({
      id: "python-lsp",
      displayName: "Python LSP",
      extensions: [".PYI", ".py"],
      rootMarkers: ["pyproject.toml", "config/python/root.json"],
      priority: 20,
    }),
    {
      id: "python-lsp",
      displayName: "Python LSP",
      extensions: [".py", ".pyi"],
      rootMarkers: ["config/python/root.json", "pyproject.toml"],
      priority: 20,
    },
  );
  assert.throws(
    () => parseLanguageProviderDescriptor({
      id: "bad",
      displayName: "Bad",
      extensions: [".py"],
      rootMarkers: ["../outside"],
      priority: 0,
    }),
    /root marker/i,
  );
  assert.throws(
    () => parseLanguageProviderDescriptor({
      id: "duplicate",
      displayName: "Duplicate",
      extensions: [".PY", ".py"],
      rootMarkers: [],
      priority: 0,
    }),
    /duplicate.*extension/i,
  );
});

function fixtureLanguageProvider(): LanguageIntelligenceProvider {
  const descriptor = parseLanguageProviderDescriptor({
    id: "python-lsp",
    displayName: "Python LSP",
    extensions: [".py"],
    rootMarkers: ["pyproject.toml"],
    priority: 20,
  });
  const empty = { status: "ok" as const, results: [], truncated: false };
  return {
    descriptor,
    workspaceSymbols: async () => empty,
    definition: async () => empty,
    references: async () => empty,
    diagnostics: async () => empty,
    close: async () => undefined,
  };
}
