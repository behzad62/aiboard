import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ArtifactNotFoundError,
  ArtifactStore,
} from "../src/artifact-store.js";

test("artifacts deduplicate by SHA-256 and verify corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aiboard-runner-v2-artifacts-"));
  const store = new ArtifactStore(directory, {
    clock: () => "2026-07-11T00:00:00.000Z",
  });

  try {
    const first = await store.put(Buffer.from("tool output"), "text/plain");
    const second = await store.put(Buffer.from("tool output"), "text/plain");
    assert.equal(first.hash, second.hash);
    assert.equal((await store.get(first.hash)).toString(), "tool output");
    assert.equal((await store.stat(first.hash)).byteLength, 11);

    await writeFile(first.path, "corrupt");
    await assert.rejects(store.verify(first.hash), /hash mismatch/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent identical puts create one durable artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aiboard-runner-v2-concurrent-"));
  const store = new ArtifactStore(directory);

  try {
    const records = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.put(Buffer.from("same bytes"), "application/octet-stream", "trace")
      )
    );
    assert.equal(new Set(records.map((record) => record.hash)).size, 1);
    await store.verify(records[0]!.hash);
    await assert.rejects(
      store.get("0".repeat(64)),
      (error: unknown) => error instanceof ArtifactNotFoundError
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removing an artifact deletes payload and metadata idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aiboard-runner-v2-remove-"));
  const store = new ArtifactStore(directory);

  try {
    const record = await store.put(
      Buffer.from("superseded checkpoint"),
      "application/json"
    );
    await store.remove(record.hash);
    await store.remove(record.hash);
    await assert.rejects(
      store.get(record.hash),
      (error: unknown) => error instanceof ArtifactNotFoundError
    );
    await assert.rejects(
      store.stat(record.hash),
      (error: unknown) => error instanceof ArtifactNotFoundError
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
