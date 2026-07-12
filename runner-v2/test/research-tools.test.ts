import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createResearchTools } from "../src/research-tools.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";

test("research fetch records bounded HTTP facts and content as an artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-research-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "x-secret-header": "must-not-be-returned",
    });
    response.end("documentation body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const broker = new ToolBroker({
      permissionProfile: "full",
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createResearchTools({ artifacts })) broker.register(tool);
    const result = await broker.invoke({
      type: "tool_call",
      callId: "fetch-docs",
      name: "research.fetch",
      arguments: { url: `http://127.0.0.1:${address.port}/docs`, maxBytes: 1024 },
    }, {
      runId: "run_research",
      sessionId: "session_research",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(result.isError, false);
    const block = result.content.find((item) => item.type === "json");
    assert.ok(block?.type === "json");
    const fact = block.value as {
      status: number;
      mediaType: string;
      byteLength: number;
      artifactHash: string;
      excerpt: string;
      headers: Record<string, string>;
    };
    assert.equal(fact.status, 200);
    assert.equal(fact.mediaType, "text/plain; charset=utf-8");
    assert.equal(fact.byteLength, 18);
    assert.equal(fact.excerpt, "documentation body");
    assert.equal(fact.headers["x-secret-header"], undefined);
    assert.equal((await artifacts.get(fact.artifactHash)).toString(), "documentation body");
  } finally {
    ledger.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("research fetch requires approval outside Full Access and rejects non-HTTP URLs", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-research-permission-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  try {
    const broker = new ToolBroker({
      permissionProfile: "project",
      workspacePath: root,
      artifacts,
      ledger,
    });
    for (const tool of createResearchTools({ artifacts })) broker.register(tool);
    const denied = await broker.invoke({
      type: "tool_call",
      callId: "fetch-external",
      name: "research.fetch",
      arguments: { url: "https://example.com" },
    }, {
      runId: "run_research",
      sessionId: "session_research",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(denied.error?.code, "approval_required");

    const invalid = await broker.invoke({
      type: "tool_call",
      callId: "fetch-file",
      name: "research.fetch",
      arguments: { url: "file:///etc/passwd" },
    }, {
      runId: "run_research",
      sessionId: "session_research",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: root,
    });
    assert.equal(invalid.error?.code, "invalid_arguments");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
