/**
 * Client-side storage backends for the whole app store (a single JSON blob).
 * IndexedDB works everywhere (default). File System Access (desktop Chromium)
 * writes a `store.json` into a user-picked folder so multiple browsers — or a
 * cloud-synced folder — can share the same state.
 *
 * Browser-only: do not import from server code.
 */

export type StorageKind = "indexeddb" | "filesystem";

export interface StorageAdapter {
  readonly kind: StorageKind;
  /** Raw envelope JSON string, or null when nothing is stored yet. */
  load(): Promise<string | null>;
  save(blob: string): Promise<void>;
  listDiscussionIds(): Promise<string[]>;
  loadDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<string | null>;
  saveDiscussionFile(
    discussionId: string,
    relativePath: string,
    blob: string
  ): Promise<void>;
  deleteDiscussionFile(discussionId: string, relativePath: string): Promise<void>;
  deleteDiscussion(discussionId: string): Promise<void>;
  listBenchmarkRunIds(): Promise<string[]>;
  loadBenchmarkRun(runId: string): Promise<string | null>;
  saveBenchmarkRun(runId: string, blob: string): Promise<void>;
  deleteBenchmarkRun(runId: string): Promise<void>;
  label(): string;
}

export const DISCUSSION_FILE_PATHS = [
  "discussion.json",
  "messages.json",
  "final-result.json",
  "attachments.json",
  "build/files.json",
  "build/checkpoint.json",
  "build/context-blobs.json",
] as const;

// ── Low-level IndexedDB kv (also used to persist the directory handle/config) ─

const DB_NAME = "ai-discussion-board";
const STORE_KEY = "store";
const HANDLE_KEY = "dirHandle";
const CONFIG_KEY = "config";
const BENCHMARK_RUN_IDS_KEY = "benchmarkRunIds";
const DISCUSSION_IDS_KEY = "discussionIds";

function benchmarkRunStoreKey(runId: string): string {
  return `benchmark:run:${runId}`;
}

function discussionFileStoreKey(discussionId: string, relativePath: string): string {
  return `discussion:${discussionId}:${relativePath}`;
}

function benchmarkRunFileName(runId: string): string {
  return `${encodeURIComponent(runId)}.json`;
}

function benchmarkRunIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -".json".length));
  } catch {
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ── Adapters ────────────────────────────────────────────────────────────────

export class IndexedDBAdapter implements StorageAdapter {
  readonly kind = "indexeddb" as const;
  async load(): Promise<string | null> {
    return (await idbGet<string>(STORE_KEY)) ?? null;
  }
  async save(blob: string): Promise<void> {
    await idbSet(STORE_KEY, blob);
  }
  async listDiscussionIds(): Promise<string[]> {
    return (await idbGet<string[]>(DISCUSSION_IDS_KEY)) ?? [];
  }
  async loadDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<string | null> {
    return (
      (await idbGet<string>(discussionFileStoreKey(discussionId, relativePath))) ??
      null
    );
  }
  async saveDiscussionFile(
    discussionId: string,
    relativePath: string,
    blob: string
  ): Promise<void> {
    await idbSet(discussionFileStoreKey(discussionId, relativePath), blob);
    const discussionIds = new Set(await this.listDiscussionIds());
    discussionIds.add(discussionId);
    await idbSet(DISCUSSION_IDS_KEY, Array.from(discussionIds).sort());
  }
  async deleteDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<void> {
    await idbDelete(discussionFileStoreKey(discussionId, relativePath));
  }
  async deleteDiscussion(discussionId: string): Promise<void> {
    for (const relativePath of DISCUSSION_FILE_PATHS) {
      await idbDelete(discussionFileStoreKey(discussionId, relativePath));
    }
    const discussionIds = (await this.listDiscussionIds()).filter(
      (id) => id !== discussionId
    );
    await idbSet(DISCUSSION_IDS_KEY, discussionIds);
  }
  async listBenchmarkRunIds(): Promise<string[]> {
    return (await idbGet<string[]>(BENCHMARK_RUN_IDS_KEY)) ?? [];
  }
  async loadBenchmarkRun(runId: string): Promise<string | null> {
    return (await idbGet<string>(benchmarkRunStoreKey(runId))) ?? null;
  }
  async saveBenchmarkRun(runId: string, blob: string): Promise<void> {
    await idbSet(benchmarkRunStoreKey(runId), blob);
    const runIds = new Set(await this.listBenchmarkRunIds());
    runIds.add(runId);
    await idbSet(BENCHMARK_RUN_IDS_KEY, Array.from(runIds).sort());
  }
  async deleteBenchmarkRun(runId: string): Promise<void> {
    await idbDelete(benchmarkRunStoreKey(runId));
    const runIds = (await this.listBenchmarkRunIds()).filter((id) => id !== runId);
    await idbSet(BENCHMARK_RUN_IDS_KEY, runIds);
  }
  label(): string {
    return "This browser (IndexedDB)";
  }
}

export class FileSystemAdapter implements StorageAdapter {
  readonly kind = "filesystem" as const;
  constructor(private readonly dir: FileSystemDirectoryHandle) {}

  async load(): Promise<string | null> {
    try {
      const fileHandle = await this.dir.getFileHandle("store.json");
      const text = await (await fileHandle.getFile()).text();
      return text.trim() ? text : null;
    } catch {
      return null; // not created yet
    }
  }

  async save(blob: string): Promise<void> {
    const fileHandle = await this.dir.getFileHandle("store.json", {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  }

  async listDiscussionIds(): Promise<string[]> {
    const discussionsDir = await this.getDiscussionsDir(false);
    if (!discussionsDir) return [];
    const entries = (
      discussionsDir as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }
    ).entries();
    const discussionIds: string[] = [];
    for await (const [name, handle] of entries) {
      if (handle.kind !== "directory") continue;
      try {
        discussionIds.push(decodeURIComponent(name));
      } catch {
        discussionIds.push(name);
      }
    }
    return discussionIds.sort();
  }

  async loadDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<string | null> {
    const discussionDir = await this.getDiscussionDir(discussionId, false);
    if (!discussionDir) return null;
    try {
      const resolved = await this.resolveRelativeFile(
        discussionDir,
        relativePath,
        false
      );
      if (!resolved.dir) return null;
      const fileHandle = await resolved.dir.getFileHandle(resolved.fileName);
      const text = await (await fileHandle.getFile()).text();
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  async saveDiscussionFile(
    discussionId: string,
    relativePath: string,
    blob: string
  ): Promise<void> {
    const discussionDir = await this.getDiscussionDir(discussionId, true);
    if (!discussionDir) throw new Error("Discussion directory is unavailable.");
    const resolved = await this.resolveRelativeFile(
      discussionDir,
      relativePath,
      true
    );
    if (!resolved.dir) throw new Error("Discussion file directory is unavailable.");
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    await this.saveDiscussionIndex();
  }

  async deleteDiscussionFile(
    discussionId: string,
    relativePath: string
  ): Promise<void> {
    const discussionDir = await this.getDiscussionDir(discussionId, false);
    if (!discussionDir) return;
    const resolved = await this.resolveRelativeFile(
      discussionDir,
      relativePath,
      false
    );
    if (!resolved.dir) return;
    try {
      await resolved.dir.removeEntry(resolved.fileName);
    } catch {
      // File already gone.
    }
    await this.saveDiscussionIndex();
  }

  async deleteDiscussion(discussionId: string): Promise<void> {
    const discussionsDir = await this.getDiscussionsDir(false);
    if (!discussionsDir) return;
    try {
      await discussionsDir.removeEntry(encodeURIComponent(discussionId), {
        recursive: true,
      });
    } catch {
      // Folder already gone.
    }
    await this.saveDiscussionIndex();
  }

  async listBenchmarkRunIds(): Promise<string[]> {
    const runsDir = await this.getBenchmarkRunsDir(false);
    if (!runsDir) return [];
    const entries = (
      runsDir as unknown as {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }
    ).entries();
    const runIds: string[] = [];
    for await (const [name, handle] of entries) {
      if (handle.kind !== "file") continue;
      const runId = benchmarkRunIdFromFileName(name);
      if (runId) runIds.push(runId);
    }
    return runIds.sort();
  }

  async loadBenchmarkRun(runId: string): Promise<string | null> {
    const runsDir = await this.getBenchmarkRunsDir(false);
    if (!runsDir) return null;
    try {
      const fileHandle = await runsDir.getFileHandle(benchmarkRunFileName(runId));
      const text = await (await fileHandle.getFile()).text();
      return text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  async saveBenchmarkRun(runId: string, blob: string): Promise<void> {
    const runsDir = await this.getBenchmarkRunsDir(true);
    if (!runsDir) throw new Error("Benchmark run directory is unavailable.");
    const fileHandle = await runsDir.getFileHandle(benchmarkRunFileName(runId), {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    await this.saveBenchmarkIndex();
  }

  async deleteBenchmarkRun(runId: string): Promise<void> {
    const runsDir = await this.getBenchmarkRunsDir(false);
    if (!runsDir) return;
    try {
      await runsDir.removeEntry(benchmarkRunFileName(runId));
    } catch {
      // File already gone.
    }
    await this.saveBenchmarkIndex();
  }

  private async getBenchmarkRunsDir(
    create: boolean
  ): Promise<FileSystemDirectoryHandle | null> {
    try {
      const benchmarksDir = await this.dir.getDirectoryHandle("benchmarks", {
        create,
      });
      return await benchmarksDir.getDirectoryHandle("runs", { create });
    } catch {
      return null;
    }
  }

  private async getDiscussionsDir(
    create: boolean
  ): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await this.dir.getDirectoryHandle("discussions", { create });
    } catch {
      return null;
    }
  }

  private async getDiscussionDir(
    discussionId: string,
    create: boolean
  ): Promise<FileSystemDirectoryHandle | null> {
    const discussionsDir = await this.getDiscussionsDir(create);
    if (!discussionsDir) return null;
    try {
      return await discussionsDir.getDirectoryHandle(encodeURIComponent(discussionId), {
        create,
      });
    } catch {
      return null;
    }
  }

  private async resolveRelativeFile(
    root: FileSystemDirectoryHandle,
    relativePath: string,
    create: boolean
  ): Promise<{ dir: FileSystemDirectoryHandle | null; fileName: string }> {
    const segments = relativePath
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (
      segments.length === 0 ||
      segments.some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(`Invalid discussion file path: ${relativePath}`);
    }
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      try {
        current = await current.getDirectoryHandle(segment, { create });
      } catch {
        return { dir: null, fileName: segments[segments.length - 1] };
      }
    }
    return { dir: current, fileName: segments[segments.length - 1] };
  }

  private async saveDiscussionIndex(): Promise<void> {
    const discussionsDir = await this.getDiscussionsDir(true);
    if (!discussionsDir) return;
    const discussionIds = await this.listDiscussionIds();
    const fileHandle = await discussionsDir.getFileHandle("index.json", {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          discussions: discussionIds.map((id) => ({
            id,
            folder: encodeURIComponent(id),
          })),
        },
        null,
        2
      )
    );
    await writable.close();
  }

  private async saveBenchmarkIndex(): Promise<void> {
    const benchmarksDir = await this.dir.getDirectoryHandle("benchmarks", {
      create: true,
    });
    const runIds = await this.listBenchmarkRunIds();
    const fileHandle = await benchmarksDir.getFileHandle("index.json", {
      create: true,
    });
    const writable = await fileHandle.createWritable();
    await writable.write(
      JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          runs: runIds.map((id) => ({ id, file: `runs/${benchmarkRunFileName(id)}` })),
        },
        null,
        2
      )
    );
    await writable.close();
  }

  label(): string {
    return `Local folder (${this.dir.name})`;
  }
}

// ── File System Access helpers ────────────────────────────────────────────────

interface DirectoryPickerWindow {
  showDirectoryPicker?: (opts?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
}

interface PermissionHandle {
  queryPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
}

export function fileSystemAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker ===
      "function"
  );
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("File System Access is not supported here.");
  const handle = await picker({ mode: "readwrite" });
  await idbSet(HANDLE_KEY, handle);
  return handle;
}

export async function getSavedDirectory(): Promise<FileSystemDirectoryHandle | null> {
  return (await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY)) ?? null;
}

export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  userActivationOverride?: { isActive: boolean }
): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  const opts = { mode: "readwrite" as const };
  try {
    if (await queryPermissionGranted(handle)) return true;
    const userActivation =
      userActivationOverride ??
      (typeof navigator !== "undefined" ? navigator.userActivation : undefined);
    if (userActivation && !userActivation.isActive) return false;
    return (await h.requestPermission?.(opts)) === "granted";
  } catch {
    // Chromium rejects requestPermission() without a fresh user gesture. App
    // startup must fall back to IndexedDB instead of hanging on an unhandled
    // SecurityError; the Storage page can request access from a real click.
    return false;
  }
}

export async function queryPermissionGranted(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  try {
    return (await h.queryPermission?.({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

// ── Storage configuration ─────────────────────────────────────────────────────

export interface StorageConfig {
  kind: StorageKind;
  encryptionEnabled: boolean;
  /** Salt (base64) for the passphrase KDF; set when encryption is enabled. */
  salt?: string;
}

const DEFAULT_CONFIG: StorageConfig = {
  kind: "indexeddb",
  encryptionEnabled: false,
};

export async function getStorageConfig(): Promise<StorageConfig> {
  return (await idbGet<StorageConfig>(CONFIG_KEY)) ?? { ...DEFAULT_CONFIG };
}

export async function setStorageConfig(config: StorageConfig): Promise<void> {
  await idbSet(CONFIG_KEY, config);
}

/** Build the adapter for a config, falling back to IndexedDB if a folder is unavailable. */
export async function createAdapter(
  config: StorageConfig
): Promise<StorageAdapter> {
  if (config.kind === "filesystem") {
    const dir = await getSavedDirectory();
    if (dir && (await queryPermissionGranted(dir))) {
      return new FileSystemAdapter(dir);
    }
  }
  return new IndexedDBAdapter();
}
