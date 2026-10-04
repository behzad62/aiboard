import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ToolBroker } from "../src/tool-broker.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";

for (const operation of ["fs.patch", "fs.write"] as const) {
  test(`E4 ${operation} preserves an existing UTF-8 BOM and CRLF through real authorization`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aiboard-e4-bom-"));
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    const path = join(workspace, "value.txt");
    const original = Buffer.from("\ufeffcaf\u00e9 = 1;\r\nsecond line\r\n");
    const expected = Buffer.from("\ufeffcaf\u00e9 = 2;\r\nsecond line\r\n");
    writeFileSync(path, original);
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace });
    for (const tool of createFilesystemTools()) broker.register(tool);
    try {
      const result = await broker.invoke({ type: "tool_call", callId: "e4-write", name: operation,
        arguments: { path: "value.txt", expectedSha256: createHash("sha256").update(original).digest("hex"),
          ...(operation === "fs.patch" ? { search: "caf\u00e9 = 1;\nsecond line", replace: "caf\u00e9 = 2;\nsecond line" } : { content: "caf\u00e9 = 2;\r\nsecond line\r\n" }) } },
      { runId: "e4-bom", sessionId: "s1", actor: { role: "worker", id: "w1" } });
      assert.equal(result.isError, false);
      assert.deepEqual(readFileSync(path), expected);
      const metadata = result.content.find((block) => block.type === "json")?.value as { sha256: string; byteLength: number };
      assert.equal(metadata.sha256, createHash("sha256").update(expected).digest("hex"));
      assert.equal(metadata.byteLength, expected.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
