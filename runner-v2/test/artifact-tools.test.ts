import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createArtifactTools } from "../src/artifact-tools.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("agents can reopen bounded content-addressed artifact ranges", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-tools-"));
  const store = new ArtifactStore(root);
  try {
    const artifact = await store.put(
      Buffer.from("hello durable artifact world"),
      "text/plain",
      "large tool output"
    );
    const registry = new ToolRegistry();
    for (const tool of createArtifactTools(store)) registry.register(tool);
    const result = await registry.invoke(
      {
        type: "tool_call",
        callId: "artifact_1",
        name: "artifact.read",
        arguments: { hash: artifact.hash, offset: 6, maxBytes: 16 },
      },
      {
        runId: "run_1",
        sessionId: "worker_1",
        actor: { role: "worker", id: "worker_1" },
      }
    );
    assert.equal(result.isError, false);
    const metadata = result.content.find((block) => block.type === "json");
    assert.deepEqual(metadata?.type === "json" ? metadata.value : undefined, {
      hash: artifact.hash,
      mediaType: "text/plain",
      label: "large tool output",
      byteLength: 28,
      offset: 6,
      returnedBytes: 16,
      truncated: true,
      encoding: "utf8",
    });
    assert.equal(
      result.content.find((block) => block.type === "text")?.type === "text"
        ? result.content.find((block) => block.type === "text")?.text
        : undefined,
      "durable artifact"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
