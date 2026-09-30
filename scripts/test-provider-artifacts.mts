import assert from "node:assert/strict";
import {
  FileSystemAdapter,
  IndexedDBAdapter,
  type KeyValueStorage,
  type ProviderArtifactStorage,
} from "../lib/client/storage-adapter";
import { StorageProviderArtifactSink } from "../lib/client/provider-artifacts";

class MemoryKv implements KeyValueStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class FakeFileHandle {
  readonly kind = "file" as const;
  bytes = new Uint8Array();
  async getFile(): Promise<File> {
    const snapshot = this.bytes.slice();
    return {
      text: async () => new TextDecoder().decode(snapshot),
      arrayBuffer: async () => snapshot.buffer.slice(
        snapshot.byteOffset,
        snapshot.byteOffset + snapshot.byteLength,
      ),
    } as unknown as File;
  }
  async createWritable(): Promise<FileSystemWritableFileStream> {
    return {
      write: async (value: unknown) => {
        if (typeof value === "string") {
          this.bytes = new TextEncoder().encode(value);
        } else if (value instanceof Uint8Array) {
          this.bytes = value.slice();
        } else if (value instanceof ArrayBuffer) {
          this.bytes = new Uint8Array(value.slice(0));
        } else {
          throw new Error(`Unsupported fake write: ${typeof value}`);
        }
      },
      close: async () => undefined,
    } as unknown as FileSystemWritableFileStream;
  }
}

class FakeDirectoryHandle {
  readonly kind = "directory" as const;
  readonly directories = new Map<string, FakeDirectoryHandle>();
  readonly files = new Map<string, FakeFileHandle>();
  constructor(readonly name: string) {}

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FileSystemDirectoryHandle> {
    const existing = this.directories.get(name);
    if (existing) return existing as unknown as FileSystemDirectoryHandle;
    if (!options.create) throw new Error("missing directory");
    const created = new FakeDirectoryHandle(name);
    this.directories.set(name, created);
    return created as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FileSystemFileHandle> {
    const existing = this.files.get(name);
    if (existing) return existing as unknown as FileSystemFileHandle;
    if (!options.create) throw new Error("missing file");
    const created = new FakeFileHandle();
    this.files.set(name, created);
    return created as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
    this.directories.delete(name);
  }
}

async function verifyArtifactStorage(
  label: string,
  storage: ProviderArtifactStorage & {
    save(blob: string): Promise<void>;
    load(): Promise<string | null>;
  },
): Promise<void> {
  const mainStore = JSON.stringify({ settings: { theme: "dark" } });
  await storage.save(mainStore);
  const sink = new StorageProviderArtifactSink(storage, () => `${label}-artifact`);
  const ref = await sink.persist({
    bytes: new Uint8Array([0, 1, 2, 254, 255]),
    mimeType: "image/png",
    filename: "generated.png",
  });

  assert.deepEqual(ref, {
    id: `${label}-artifact`,
    mimeType: "image/png",
    filename: "generated.png",
    size: 5,
    storageRef: `provider-artifact:${encodeURIComponent(`${label}-artifact`)}`,
  });
  assert.equal(await storage.load(), mainStore);
  assert.equal(JSON.stringify(ref).includes("AAEC/v8"), false);
  const loaded = await storage.loadProviderArtifact(ref.storageRef);
  assert.deepEqual(Array.from(loaded ?? []), [0, 1, 2, 254, 255]);
  await storage.deleteProviderArtifact(ref.storageRef);
  assert.equal(await storage.loadProviderArtifact(ref.storageRef), null);
  console.log(`PASS ${label} stores provider binary bytes outside the main JSON store`);
}

const kv = new MemoryKv();
await verifyArtifactStorage("indexeddb", new IndexedDBAdapter(kv));
assert.equal(
  [...kv.values.keys()].some((key) => key.startsWith("provider:artifact:")),
  false,
  "deleted artifact bytes should no longer remain in the IndexedDB key-value store",
);

const root = new FakeDirectoryHandle("root");
const fsAdapter = new FileSystemAdapter(root as unknown as FileSystemDirectoryHandle);
await verifyArtifactStorage("filesystem", fsAdapter);
assert.ok(root.files.has("store.json"));
assert.ok(root.directories.has("provider-artifacts"));
console.log("PASS filesystem provider artifacts use a dedicated directory");

console.log("PASS");
