/**
 * Build final-result split-storage checks.
 *
 * Run: npx tsx scripts/test-build-final-result-storage.mts
 */

import assert from "node:assert/strict";
import {
  FileSystemAdapter,
  IndexedDBAdapter,
  type StorageAdapter,
} from "../lib/client/storage-adapter";

class MemoryAdapter implements StorageAdapter {
  readonly kind = "indexeddb" as const;
  files = new Map<string, string>();
  deleted: string[] = [];

  async load(): Promise<string | null> {
    return null;
  }

  async save(): Promise<void> {}

  async listDiscussionIds(): Promise<string[]> {
    return ["d1"];
  }

  async loadDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<string | null> {
    return this.files.get(`${discussionId}/${relativePath}`) ?? null;
  }

  async saveDiscussionFile(
    discussionId: string,
    relativePath: string,
    blob: string
  ): Promise<void> {
    this.files.set(`${discussionId}/${relativePath}`, blob);
  }

  async deleteDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<void> {
    this.deleted.push(`${discussionId}/${relativePath}`);
    this.files.delete(`${discussionId}/${relativePath}`);
  }

  async deleteDiscussion(discussionId: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${discussionId}/`)) this.files.delete(key);
    }
  }

  async listBenchmarkRunIds(): Promise<string[]> {
    return [];
  }

  async loadBenchmarkRun(): Promise<string | null> {
    return null;
  }

  async saveBenchmarkRun(): Promise<void> {}

  async deleteBenchmarkRun(): Promise<void> {}

  label(): string {
    return "memory";
  }
}

const adapter: StorageAdapter = new MemoryAdapter();
await adapter.deleteDiscussionFile("d1", "final-result.json");

assert.equal(
  await adapter.loadDiscussionFile("d1", "final-result.json"),
  null,
  "storage adapters must support deleting one split discussion file"
);

assert.equal(
  typeof IndexedDBAdapter.prototype.deleteDiscussionFile,
  "function",
  "IndexedDBAdapter must implement per-file discussion deletion"
);
assert.equal(
  typeof FileSystemAdapter.prototype.deleteDiscussionFile,
  "function",
  "FileSystemAdapter must implement per-file discussion deletion"
);

console.log("PASS build final-result storage adapter supports per-file delete");
