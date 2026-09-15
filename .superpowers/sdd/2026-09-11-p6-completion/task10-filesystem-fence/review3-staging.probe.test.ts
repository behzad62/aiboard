import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import type { NativeTool, ToolExecutionContext, ToolResult } from "../../../../runner-v2/src/agent-contracts.js";
import { createExecutionGrantAuthority } from "../../../../runner-v2/src/execution-grants.js";
import { createFilesystemTools } from "../../../../runner-v2/src/filesystem-tools.js";
import { ToolBroker } from "../../../../runner-v2/src/tool-broker.js";
import { SqliteToolLedger } from "../../../../runner-v2/src/sqlite-tool-ledger.js";
import { captureFilesystemMutation, authorizeFilesystemMutation, fencedDelete } from "../../../../runner-v2/src/filesystem-mutation-fence.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
interface Fixture {
  t: TestContext;
  root: string;
  workspace: string;
  outside: string;
  authority: ReturnType<typeof createExecutionGrantAuthority>;
  beforeIssue?: () => void;
  beforeExecute?: (tool: NativeTool<unknown>, input: unknown, context: ToolExecutionContext) => Promise<void>;
  invoke(name: string, input: unknown): Promise<ToolResult>;
}
function fixtureTest(name: string, run: (fixture: Fixture) => Promise<void>): void {
  test(`filesystem fence: ${name}`, async (t) => {
    const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task10-fence-"));
    const workspace = join(root, "workspace"); const outside = join(root, "outside");
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, "sentinel.txt"), "outside-original");
    const f = { t, root, workspace, outside } as Fixture;
    const authority = createExecutionGrantAuthority({ beforeIssueCommit: async () => f.beforeIssue?.() });
    f.authority = authority;
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, executionGrants: authority });
    for (const tool of createFilesystemTools()) broker.register({
      ...tool,
      execute: async (input, context) => {
        await f.beforeExecute?.(tool, input, context);
        return tool.execute(input, context);
      },
    });
    let ordinal = 0;
    f.invoke = (name, input) => broker.invoke({ type: "tool_call", callId: `call-${++ordinal}`, name, arguments: input }, {
      runId: "fence-run", sessionId: "fence-session", actor: { role: "worker", id: "fence-worker" },
    });
    let passed = false;
    try { await run(f); assert.equal(authority.activeSnapshots().length, 0); passed = true; }
    finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await authority.revokeAll("cleanup");
      if (passed) fs.rmSync(root, { recursive: true, force: true });
      else t.diagnostic(`Task 10 RED/diagnostic root retained: ${root}`);
    }
  });
}
function refused(result: ToolResult, code: string | readonly string[]): void {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.ok((typeof code === "string" ? [code] : code).includes(result.error?.code ?? ""), JSON.stringify(result));
}


for (const mode of ["create", "replace"] as const) for (const phase of ["flush", "publication"] as const)
  fixtureTest(`review3: ${mode} refuses staged-byte tampering at ${phase}`, async (f) => {
    const path = join(f.workspace, "value.txt");
    if (mode === "replace") fs.writeFileSync(path, "original");
    const flush = fs.fsyncSync, stat = fs.lstatSync; let flushed = false; let injected = false;
    const tamper = () => {
      const temporary = fs.readdirSync(f.workspace).find((name) => name.startsWith(".aiboard-") && name.endsWith(".tmp"));
      assert.ok(temporary);
      fs.writeFileSync(join(f.workspace, temporary), "tampered");
      injected = true;
    };
    f.t.mock.method(fs, "fsyncSync", (fd: number) => {
      flush(fd); flushed = true;
      if (phase === "flush") tamper();
    });
    f.t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
      if (phase === "publication" && flushed && !injected && resolve(String(args[0])) === path) tamper();
      return stat(...args);
    });
    const result = await f.invoke("fs.write", { path: "value.txt", content: "replacement",
      ...(mode === "replace" ? { expectedSha256: hash("original") } : {}) });
    assert.equal(injected, true);
    refused(result, "filesystem_identity_changed");
    assert.ok(result.content.some((block) => block.type === "json" &&
      (block.value as { partialMutation?: boolean }).partialMutation === false));
    if (mode === "replace") assert.equal(fs.readFileSync(path, "utf8"), "original");
    else assert.equal(fs.existsSync(path), false);
    assert.deepEqual(fs.readdirSync(f.workspace), mode === "replace" ? ["value.txt"] : []);
  });
