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

test("one artifact.read returns the whole artifact up to the caller's inline budget (tunnel run)", async () => {
  // A fixed 6 KB paged a 7 KB test log, and a paged read never counted as a complete evidence read.
  const root = mkdtempSync(join(tmpdir(), "aiboard-artifact-budget-"));
  const store = new ArtifactStore(root);
  try {
    const artifact = await store.put(Buffer.from("x".repeat(7_349)), "text/plain", "root npm test stdout");
    const registry = new ToolRegistry();
    for (const tool of createArtifactTools(store)) registry.register(tool);
    const read = async (args: Record<string, unknown>, inlineOutputBytes?: number) => {
      const result = await registry.invoke(
        { type: "tool_call", callId: `artifact_${Math.random()}`, name: "artifact.read", arguments: { hash: artifact.hash, ...args } },
        { runId: "run_1", sessionId: "verifier_1", actor: { role: "verifier", id: "verifier_1" }, ...(inlineOutputBytes ? { inlineOutputBytes } : {}) },
      );
      const metadata = result.content.find((block) => block.type === "json");
      return (metadata?.type === "json" ? metadata.value : undefined) as { returnedBytes: number; truncated: boolean };
    };
    assert.deepEqual(await read({}), { ...(await read({})), returnedBytes: 7_349, truncated: false });
    assert.equal((await read({ maxBytes: 1_000_000 })).truncated, false, "a large request is clamped, not refused");
    const small = await read({}, 6 * 1024);
    assert.equal(small.truncated, true, "the caller's inline budget still bounds one result");
    assert.equal(small.returnedBytes, 6 * 1024 - 2 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
