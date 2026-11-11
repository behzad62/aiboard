import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createManagedProcessTools } from "../src/managed-process-tools.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import { createProcessTools } from "../src/process-tools.js";

/**
 * Build's workers and the MCP servers (Remote, local MCP) run the same tools, so a fix made for one reaches the other.
 * Only the names a model sees differ (process.start for Build, process_start for a client). Provider-native tools that
 * Build offers its own models in place of the generic ones write through the same mutation fence.
 */
const source = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", name), "utf8");

test("Build and the MCP servers build their tools from the same modules", () => {
  const shared = {
    createFilesystemTools: "./filesystem-tools.js",
    createGitTools: "./git-tools.js",
    createImageTools: "./image-tools.js",
    createProcessTools: "./process-tools.js",
    createManagedProcessTools: "./managed-process-tools.js",
  };
  for (const file of ["worker-runtime.ts", "remote-tool-runtime.ts"]) {
    const text = source(file);
    for (const [factory, module] of Object.entries(shared)) {
      assert.match(text, new RegExp(`import \\{[^}]*\\b${factory}\\b[^}]*\\} from "${module.replace(".", "\\.")}"`, "u"), `${file} imports ${factory} from ${module}`);
    }
  }
  // Large output stays readable by processId the same way on both sides.
  for (const file of ["worker-runtime.ts", "subagent-tools.ts", "remote-tool-runtime.ts"]) assert.match(source(file), /processRunSupport\(/u, file);
});

test("the process tools take no option that changes what they do, only the names they are seen by", () => {
  for (const file of ["process-tools.ts", "managed-process-tools.ts"]) {
    assert.doesNotMatch(source(file), /options\.external|external\?: (?:boolean|ProcessTools)/u, `${file} has no Build-or-client switch`);
  }
  const service = new Proxy({}, { get: () => () => { throw new Error("not called"); } }) as unknown as ManagedProcessService;
  const asBuild = (description: string) => description.replace(/process_([a-z_]+)/gu, "process.$1").replace("git add then git commit or ", "");
  const pairs = [
    [createProcessTools(), createProcessTools({ names: "mcp" })],
    [createManagedProcessTools(service), createManagedProcessTools(service, { names: "mcp" })],
  ] as const;
  for (const [build, client] of pairs) {
    assert.deepEqual(build.map((tool) => tool.definition.name), client.map((tool) => tool.definition.name));
    build.forEach((tool, index) => {
      const other = client[index]!.definition;
      assert.deepEqual(tool.definition.inputSchema, other.inputSchema, `${tool.definition.name} takes the same arguments`);
      assert.equal(tool.definition.description, asBuild(other.description), `${tool.definition.name} says the same thing`);
      assert.equal(tool.definition.effect, other.effect);
      assert.equal(tool.definition.readOnly, other.readOnly);
    });
  }
});

test("a provider-native patch writes through the same mutation fence as fs.write and fs.patch", () => {
  const fence = /from "\.\/filesystem-mutation-fence\.js"/u;
  for (const file of ["filesystem-tools.ts", "openrouter-apply-patch-tool.ts"]) {
    assert.match(source(file), fence, file);
    for (const call of ["fencedWrite", "fencedPatch", "fencedDelete"]) assert.match(source(file), new RegExp(`\\b${call}\\(`, "u"), `${file} ${call}`);
  }
  assert.doesNotMatch(source("openrouter-apply-patch-tool.ts"), /\b(?:writeFile|writeFileSync|unlink|unlinkSync|rename|renameSync)\(/u, "no write around the fence");
});
