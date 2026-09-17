import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NativeTool } from "../src/agent-contracts.js";
import { LocalPluginLoader } from "../src/plugin-loader.js";
import { captureRunnerExtensionClosure } from "../src/runner-capability-contract.js";
import type {
  RunnerExtensionCapabilities,
  RunnerExtensionInstance,
  RunnerExtensionModule,
  RunnerExtensionTool,
} from "../src/runner-extension.js";

test("allowlisted local plugins preflight atomically, start in order, and close in reverse", async () => {
  const fixture = createFixture("valid paths Ω");
  const lifecycle: string[] = [];
  try {
    const first = fixture.plugin("first", {
      capabilities: ["tools", "context"],
    });
    const second = fixture.plugin("second", {
      capabilities: ["language_intelligence"],
    });
    const modules = new Map<string, RunnerExtensionModule>([
      [first.entry, extensionModule("first", lifecycle, {
        tools: [ordinaryTool("first.inspect")],
        contextContributors: [{
          id: "first-context",
          kind: "extension",
          priority: 1,
          maxBytes: 1_024,
          contribute: async () => ({ content: "first" }),
        }],
        languageProviders: [],
      })],
      [second.entry, extensionModule("second", lifecycle, {
        tools: [],
        contextContributors: [],
        languageProviders: [languageProvider("second-language")],
      })],
    ]);
    const loaded = await new LocalPluginLoader({
      pluginDirectories: [first.directory, second.directory],
      projectDirectory: fixture.project,
      stateDirectory: fixture.state,
      reservedToolNames: ["filesystem.read"],
      importModule: async (entryPath) => modules.get(entryPath),
    }).load();

    assert.deepEqual(lifecycle, ["start:first", "start:second"]);
    assert.deepEqual(
      loaded.registry.manifests().map((manifest) => manifest.id),
      ["first", "second"],
    );
    assert.deepEqual(
      loaded.registry.tools().map((item) => [item.extensionId, item.tool.definition.name]),
      [["first", "first.inspect"]],
    );
    assert.deepEqual(
      loaded.registry.contextContributors().map((item) => item.extensionId),
      ["first"],
    );
    assert.deepEqual(
      loaded.registry.languageProviders().map((item) => item.provider.descriptor.id),
      ["second-language"],
    );

    await loaded.close();
    await loaded.close();
    assert.deepEqual(lifecycle, [
      "start:first",
      "start:second",
      "close:second",
      "close:first",
    ]);
  } finally {
    fixture.close();
  }
});

test("the production importer loads an allowlisted module from a path with spaces and Unicode", async () => {
  const fixture = createFixture("real import Ω");
  try {
    const plugin = fixture.plugin("real-import", {
      directoryName: "plugin module Ω",
    });
    writeFileSync(join(plugin.directory, "helper.mjs"), 'export const suffix = "contained-helper";\n');
    writeFileSync(plugin.entry, `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      import { suffix } from "./helper.mjs";
      export function createExtension() {
        return {
          capabilities() {
            return { tools: [], contextContributors: [], languageProviders: [] };
          },
          async start({ extensionId, stateDirectory }) {
            await writeFile(join(stateDirectory, "started.txt"), extensionId + ":" + suffix, "utf8");
          },
          async close() {}
        };
      }
    `);

    const loaded = await new LocalPluginLoader({
      pluginDirectories: [plugin.directory],
      projectDirectory: fixture.project,
      stateDirectory: fixture.state,
    }).load();
    assert.equal(
      readFileSync(
        join(fixture.state, "extensions", "real-import", "started.txt"),
        "utf8",
      ),
      "real-import:contained-helper",
    );
    await loaded.close();
  } finally {
    fixture.close();
  }
});

test("the production importer rejects escaped, bare, unresolved, and dynamic module resolution before evaluation", async () => {
  for (const scenario of [
    {
      name: "relative escape",
      entry: (_marker: string) => `
        import "../outside.mjs";
        export function createExtension() {
          return { capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }), start: async () => {}, close: async () => {} };
        }
      `,
      setup: (root: string, marker: string) => writeFileSync(join(root, "outside.mjs"), `
        import { appendFileSync } from "node:fs";
        appendFileSync(${JSON.stringify(marker)}, "outside evaluated\\n");
      `),
    },
    {
      name: "bare package",
      entry: () => `
        import "outside-package";
        export function createExtension() {
          return { capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }), start: async () => {}, close: async () => {} };
        }
      `,
      setup: (root: string, marker: string) => {
        const packageRoot = join(root, "node_modules", "outside-package");
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
          name: "outside-package",
          type: "module",
          exports: "./index.mjs",
        }));
        writeFileSync(join(packageRoot, "index.mjs"), `
          import { appendFileSync } from "node:fs";
          appendFileSync(${JSON.stringify(marker)}, "bare evaluated\\n");
        `);
      },
    },
    {
      name: "dynamic import",
      entry: () => `
        await import("./helper.mjs");
        export function createExtension() {
          return { capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }), start: async () => {}, close: async () => {} };
        }
      `,
      setup: (root: string, marker: string, directory: string) => writeFileSync(join(directory, "helper.mjs"), `
        import { appendFileSync } from "node:fs";
        appendFileSync(${JSON.stringify(marker)}, "dynamic evaluated\\n");
      `),
    },
    {
      name: "computed dynamic import",
      entry: () => `
        const target = "./helper.mjs";
        await import(target);
        export function createExtension() {
          return { capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }), start: async () => {}, close: async () => {} };
        }
      `,
      setup: (root: string, marker: string, directory: string) => writeFileSync(join(directory, "helper.mjs"), `
        import { appendFileSync } from "node:fs";
        appendFileSync(${JSON.stringify(marker)}, "computed dynamic evaluated\\n");
      `),
    },
    {
      name: "unresolved contained module",
      entry: () => `
        import "./missing.mjs";
        export function createExtension() {
          return { capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }), start: async () => {}, close: async () => {} };
        }
      `,
      setup: () => undefined,
    },
  ] as const) {
    const fixture = createFixture(`module graph ${scenario.name}`);
    const marker = join(fixture.root, "unexpected-evaluation.log");
    try {
      const plugin = fixture.plugin("module-graph", {});
      scenario.setup(fixture.root, marker, plugin.directory);
      writeFileSync(plugin.entry, scenario.entry(marker));

      await assert.rejects(
        new LocalPluginLoader({
          pluginDirectories: [plugin.directory],
          projectDirectory: fixture.project,
          stateDirectory: fixture.state,
        }).load(),
        /module.*(?:escape|bare|dynamic|unresolved)|(?:escape|bare|dynamic|unresolved).*module/i,
      );
      assert.equal(existsSync(marker), false);
    } finally {
      fixture.close();
    }
  }
});

test("the production importer executes only captured bytes and removes its execution copy", async () => {
  const fixture = createFixture("captured execution copy");
  try {
    const plugin = fixture.plugin("captured-copy", {});
    const marker = join(fixture.root, "unexpected-live-source-evaluation.log");
    writeFileSync(plugin.entry, `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      export function createExtension() {
        return {
          capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }),
          async start({ stateDirectory }) { await writeFile(join(stateDirectory, "executed.txt"), "captured", "utf8"); },
          async close() {}
        };
      }
    `);
    const loaded = await new LocalPluginLoader({
      pluginDirectories: [plugin.directory],
      projectDirectory: fixture.project,
      stateDirectory: fixture.state,
      captureClosure: async (directory) => {
        const closure = await captureRunnerExtensionClosure(directory);
        writeFileSync(plugin.entry, `
          import { appendFileSync } from "node:fs";
          import { join } from "node:path";
          appendFileSync(${JSON.stringify(marker)}, "live source evaluated\\n");
          export function createExtension() {
            return {
              capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }),
              async start({ stateDirectory }) { appendFileSync(join(stateDirectory, "executed.txt"), "live"); },
              async close() {}
            };
          }
        `);
        return closure;
      },
    }).load();

    assert.equal(readFileSync(join(fixture.state, "extensions", "captured-copy", "executed.txt"), "utf8"), "captured");
    assert.equal(existsSync(marker), false, "the source changed after capture must never be imported");
    await loaded.close();
    assert.deepEqual(
      readdirSync(join(fixture.state, "extension-executions")),
      [],
      "a unique execution copy is removed after extension cleanup",
    );
  } finally {
    fixture.close();
  }
});

test("the production importer removes its execution copy after a failed start", async () => {
  const fixture = createFixture("failed execution copy cleanup");
  try {
    const plugin = fixture.plugin("failed-copy", {});
    writeFileSync(plugin.entry, `
      export function createExtension() {
        return {
          capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }),
          async start() { throw new Error("expected start failure"); },
          async close() {}
        };
      }
    `);
    await assert.rejects(
      new LocalPluginLoader({
        pluginDirectories: [plugin.directory],
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
      }).load(),
      /expected start failure/i,
    );
    assert.deepEqual(
      readdirSync(join(fixture.state, "extension-executions")),
      [],
      "a failed load must not retain executable extension bytes",
    );
  } finally {
    fixture.close();
  }
});

test("the production importer rehashes its sealed execution copy after evaluation", async () => {
  const fixture = createFixture("post import execution mutation");
  try {
    const plugin = fixture.plugin("post-import-copy", {});
    const started = join(fixture.root, "unexpected-start.log");
    writeFileSync(plugin.entry, `
      import { appendFileSync } from "node:fs";
      export function createExtension() {
        return {
          capabilities: () => ({ tools: [], contextContributors: [], languageProviders: [] }),
          async start() { appendFileSync(${JSON.stringify(started)}, "started\\n"); },
          async close() {}
        };
      }
    `);
    await assert.rejects(
      new LocalPluginLoader({
        pluginDirectories: [plugin.directory],
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        afterImport: async (copy) => {
          chmodSync(copy.entryPath, 0o600);
          writeFileSync(copy.entryPath, "export const changed = true;\n");
        },
      }).load(),
      /execution copy changed/i,
    );
    assert.equal(existsSync(started), false, "a changed execution copy cannot reach extension start");
    assert.deepEqual(readdirSync(join(fixture.state, "extension-executions")), []);
  } finally {
    fixture.close();
  }
});

test("duplicate extension IDs and tool names reject before any plugin starts", async () => {
  const fixture = createFixture("duplicates");
  const lifecycle: string[] = [];
  try {
    const first = fixture.plugin("same", { directoryName: "one", capabilities: ["tools"] });
    const second = fixture.plugin("same", { directoryName: "two", capabilities: ["tools"] });
    const modules = new Map<string, RunnerExtensionModule>([
      [first.entry, extensionModule("one", lifecycle, capabilities(ordinaryTool("shared.tool")))],
      [second.entry, extensionModule("two", lifecycle, capabilities(ordinaryTool("other.tool")))],
    ]);
    await assert.rejects(
      new LocalPluginLoader({
        pluginDirectories: [first.directory, second.directory],
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        importModule: async (entryPath) => modules.get(entryPath),
      }).load(),
      /duplicate extension id/i,
    );
    assert.deepEqual(lifecycle, ["close:two", "close:one"]);

    lifecycle.length = 0;
    fixture.manifest(second.directory, "different", ["tools"]);
    modules.set(second.entry, extensionModule(
      "two",
      lifecycle,
      capabilities(ordinaryTool("shared.tool")),
    ));
    await assert.rejects(
      new LocalPluginLoader({
        pluginDirectories: [first.directory, second.directory],
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        importModule: async (entryPath) => modules.get(entryPath),
      }).load(),
      /duplicate tool.*shared\.tool/i,
    );
    assert.deepEqual(lifecycle, ["close:two", "close:one"]);
  } finally {
    fixture.close();
  }
});

test("plugins cannot register lifecycle tools or impersonate protected and built-in names", async () => {
  const fixture = createFixture("authority");
  try {
    const plugin = fixture.plugin("authority", { capabilities: ["tools"] });
    for (const [tool, pattern] of [
      [{
        ...ordinaryTool("harmless.name"),
        definition: {
          ...ordinaryTool("harmless.name").definition,
          lifecycle: true,
        },
      }, /lifecycle tool/i],
      [ordinaryTool("complete_run"), /protected lifecycle tool.*complete_run/i],
      [ordinaryTool("return_to_parent"), /protected lifecycle tool.*return_to_parent/i],
      [ordinaryTool("filesystem.read"), /reserved tool.*filesystem\.read/i],
    ] as const) {
      await assert.rejects(
        new LocalPluginLoader({
          pluginDirectories: [plugin.directory],
          projectDirectory: fixture.project,
          stateDirectory: fixture.state,
          reservedToolNames: ["filesystem.read"],
          importModule: async () => extensionModule(
            "authority",
            [],
            capabilities(tool as NativeTool),
          ),
        }).load(),
        pattern,
      );
    }
  } finally {
    fixture.close();
  }
});

test("plugin discovery rejects incompatible manifests, path escapes, and symlinks", async () => {
  const fixture = createFixture("containment");
  try {
    const incompatible = fixture.plugin("incompatible", { apiVersion: 2 });
    await assert.rejects(
      loaderFor(fixture, incompatible.directory).load(),
      /incompatible.*API version/i,
    );

    const escaped = fixture.plugin("escaped", { entry: "../outside.mjs" });
    writeFileSync(join(fixture.root, "outside.mjs"), "export const outside = true;\n");
    await assert.rejects(
      loaderFor(fixture, escaped.directory).load(),
      /entry/i,
    );

    const outsideDirectory = join(fixture.root, "outside-directory");
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, "index.mjs"), "export const outside = true;\n");
    const linked = fixture.plugin("linked", { entry: "linked/index.mjs" });
    symlinkSync(outsideDirectory, join(linked.directory, "linked"), "junction");
    await assert.rejects(
      loaderFor(fixture, linked.directory).load(),
      /symbolic link|escape/i,
    );

    const realPlugin = fixture.plugin("real", {});
    const alias = join(fixture.root, "plugin-alias");
    symlinkSync(realPlugin.directory, alias, "junction");
    await assert.rejects(
      loaderFor(fixture, alias).load(),
      /symbolic link/i,
    );

    const parented = fixture.plugin("parented", {
      directoryName: "real-plugins/parented",
    });
    const parentAlias = join(fixture.root, "plugin-parent-alias");
    symlinkSync(join(fixture.root, "real-plugins"), parentAlias, "junction");
    await assert.rejects(
      loaderFor(fixture, join(parentAlias, "parented")).load(),
      /symbolic link/i,
    );
    assert.equal(existsSync(parented.directory), true);
  } finally {
    fixture.close();
  }
});

test("plugin state containment rejects a junction before writing into the project", async () => {
  const fixture = createFixture("state containment");
  try {
    const plugin = fixture.plugin("state-escape", {});
    symlinkSync(fixture.project, join(fixture.state, "extensions"), "junction");

    await assert.rejects(
      loaderFor(fixture, plugin.directory).load(),
      /state.*(?:symbolic link|escape|project directory)/i,
    );
    assert.equal(
      existsSync(join(fixture.project, "state-escape")),
      false,
      "the loader must reject the state junction before creating extension state",
    );
  } finally {
    fixture.close();
  }
});

test("plugin state containment rejects a parent junction before creating Runner state", async () => {
  const fixture = createFixture("state parent containment");
  try {
    const plugin = fixture.plugin("state-parent-escape", {});
    const alias = join(fixture.root, "state-parent-alias");
    const escapedState = join(alias, "runner-state");
    symlinkSync(fixture.project, alias, "junction");

    await assert.rejects(
      new LocalPluginLoader({
        pluginDirectories: [plugin.directory],
        projectDirectory: fixture.project,
        stateDirectory: escapedState,
        importModule: async () => extensionModule("fixture", [], emptyCapabilities()),
      }).load(),
      /state.*(?:exist|project directory)/i,
    );
    assert.equal(
      existsSync(join(fixture.project, "runner-state")),
      false,
      "the loader must not create Runner state through a parent junction",
    );
  } finally {
    fixture.close();
  }
});

test("partial start failure closes the failing plugin and every earlier plugin in reverse", async () => {
  const fixture = createFixture("start failure");
  const lifecycle: string[] = [];
  try {
    const first = fixture.plugin("first", {});
    const second = fixture.plugin("second", {});
    await assert.rejects(
      new LocalPluginLoader({
        pluginDirectories: [first.directory, second.directory],
        projectDirectory: fixture.project,
        stateDirectory: fixture.state,
        importModule: async (entryPath) =>
          entryPath === first.entry
            ? extensionModule("first", lifecycle, emptyCapabilities())
            : extensionModule("second", lifecycle, emptyCapabilities(), true),
      }).load(),
      /second start failed/i,
    );
    assert.deepEqual(lifecycle, [
      "start:first",
      "start:second",
      "close:second",
      "close:first",
    ]);
  } finally {
    fixture.close();
  }
});

test("a failed close retains only the failed extension for an exact retry", async () => {
  const fixture = createFixture("close retry");
  const lifecycle: string[] = [];
  let closeAttempts = 0;
  try {
    const first = fixture.plugin("first", {});
    const second = fixture.plugin("second", {});
    const loaded = await new LocalPluginLoader({
      pluginDirectories: [first.directory, second.directory],
      projectDirectory: fixture.project,
      stateDirectory: fixture.state,
      importModule: async (entryPath) =>
        entryPath === first.entry
          ? extensionModule("first", lifecycle, emptyCapabilities())
          : {
              createExtension: () => ({
                capabilities: emptyCapabilities,
                start: async () => lifecycle.push("start:second"),
                close: async () => {
                  closeAttempts += 1;
                  lifecycle.push(`close:second:${closeAttempts}`);
                  if (closeAttempts === 1) throw new Error("second close failed");
                },
              }),
            },
    }).load();
    await assert.rejects(loaded.close(), /failed to close/i);
    await loaded.close();
    await loaded.close();
    assert.deepEqual(lifecycle, [
      "start:first",
      "start:second",
      "close:second:1",
      "close:first",
      "close:second:2",
    ]);
  } finally {
    fixture.close();
  }
});

function loaderFor(
  fixture: ReturnType<typeof createFixture>,
  directory: string,
): LocalPluginLoader {
  return new LocalPluginLoader({
    pluginDirectories: [directory],
    projectDirectory: fixture.project,
    stateDirectory: fixture.state,
    importModule: async () => extensionModule("fixture", [], emptyCapabilities()),
  });
}

function createFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-plugin-${name}-`));
  const project = join(root, "project");
  const state = join(root, "runner state");
  mkdirSync(project);
  mkdirSync(state);
  return {
    root,
    project,
    state,
    plugin(
      id: string,
      options: {
        directoryName?: string;
        apiVersion?: number;
        entry?: string;
        capabilities?: string[];
      },
    ) {
      const directory = join(root, options.directoryName ?? `plugin ${id}`);
      mkdirSync(directory, { recursive: true });
      const entryName = options.entry ?? "index.mjs";
      if (!entryName.includes("..") && !entryName.includes("linked/")) {
        writeFileSync(join(directory, entryName), "export const fixture = true;\n");
      }
      this.manifest(
        directory,
        id,
        options.capabilities ?? [],
        options.apiVersion ?? 1,
        entryName,
      );
      return { directory, entry: join(directory, entryName) };
    },
    manifest(
      directory: string,
      id: string,
      declaredCapabilities: string[],
      apiVersion = 1,
      entry = "index.mjs",
    ) {
      writeFileSync(join(directory, "runner-extension.json"), JSON.stringify({
        apiVersion,
        id,
        name: id,
        version: "1.0.0",
        entry,
        capabilities: declaredCapabilities,
      }));
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function extensionModule(
  id: string,
  lifecycle: string[],
  provided: RunnerExtensionCapabilities,
  failStart = false,
): RunnerExtensionModule {
  return {
    createExtension: (): RunnerExtensionInstance => ({
      capabilities: () => provided,
      start: async ({ extensionId, stateDirectory }) => {
        assert.equal(extensionId.length > 0, true);
        assert.equal(stateDirectory.includes("runner state"), true);
        lifecycle.push(`start:${id}`);
        if (failStart) throw new Error(`${id} start failed`);
      },
      close: async () => {
        lifecycle.push(`close:${id}`);
      },
    }),
  };
}

function emptyCapabilities(): RunnerExtensionCapabilities {
  return { tools: [], contextContributors: [], languageProviders: [] };
}

function capabilities(tool: NativeTool): RunnerExtensionCapabilities {
  return {
    tools: [tool],
    contextContributors: [],
    languageProviders: [],
  } as RunnerExtensionCapabilities;
}

function ordinaryTool(name: string): RunnerExtensionTool {
  return {
    definition: {
      name,
      description: `${name} fixture`,
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ content: [], isError: false }),
  };
}

function languageProvider(id: string) {
  const empty = { status: "ok" as const, results: [], truncated: false };
  return {
    descriptor: {
      id,
      displayName: id,
      extensions: [".fixture"],
      rootMarkers: [],
      priority: 0,
    },
    workspaceSymbols: async () => empty,
    definition: async () => empty,
    references: async () => empty,
    diagnostics: async () => empty,
    close: async () => undefined,
  };
}
