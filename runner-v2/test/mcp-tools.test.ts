import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { McpManager, createMcpTools } from "../src/mcp-tools.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";

const here = dirname(fileURLToPath(import.meta.url));

test("MCP stdio schemas become audited native tools with artifact-backed images", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const fixture = join(here, "fixtures", "mcp-server.mjs");
  const manager = new McpManager({
    cwd: root,
    servers: [{ name: "docs", command: `"${process.execPath}" "${fixture}"` }],
  });
  try {
    await manager.start();
    assert.deepEqual(manager.status().map((server) => ({ name: server.name, status: server.status, toolCount: server.toolCount })), [
      { name: "docs", status: "ready", toolCount: 1 },
    ]);
    const broker = new ToolBroker({
      permissionProfile: "full",
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createMcpTools(manager, artifacts)) broker.register(tool);
    assert.equal(broker.definitions()[0].name, "mcp.docs.lookup");
    const result = await broker.invoke({
      type: "tool_call",
      callId: "mcp-lookup",
      name: "mcp.docs.lookup",
      arguments: { query: "runner" },
    }, {
      runId: "run_mcp",
      sessionId: "session_mcp",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(result.isError, false);
    assert.equal(result.content.some((block) => block.type === "text" && block.text === "found:runner"), true);
    const image = result.content.find((block) => block.type === "artifact");
    assert.ok(image?.type === "artifact");
    assert.equal(image.mediaType, "image/png");
    assert.equal((await artifacts.get(image.hash)).toString(), "image-bytes");
  } finally {
    await manager.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP calls require approval outside Full Access", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-mcp-permission-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const fixture = join(here, "fixtures", "mcp-server.mjs");
  const manager = new McpManager({
    cwd: root,
    servers: [{ name: "docs", command: `"${process.execPath}" "${fixture}"` }],
  });
  try {
    await manager.start();
    const broker = new ToolBroker({
      permissionProfile: "project",
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createMcpTools(manager, artifacts)) broker.register(tool);
    const result = await broker.invoke({
      type: "tool_call",
      callId: "mcp-lookup",
      name: "mcp.docs.lookup",
      arguments: { query: "runner" },
    }, {
      runId: "run_mcp",
      sessionId: "session_mcp",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(result.error?.code, "approval_required");
  } finally {
    await manager.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
