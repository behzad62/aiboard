/**
 * Project-folder access for Build mode (File System Access API).
 *
 * The user grants a directory; the engine lists/reads files to give models
 * context and writes the files they produce. Everything is sandboxed to the
 * granted handle: paths are sanitized (no `..`, no absolute paths) and the
 * browser itself cannot escape the directory the user picked.
 *
 * Browser-only.
 */

import {
  fileSystemAccessSupported,
  idbGet,
  idbSet,
  verifyPermission,
} from "./storage-adapter";

export { fileSystemAccessSupported };

const HANDLE_KEY_PREFIX = "projectHandle:";

// Folders that are never worth showing to a model.
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "out",
  "build",
  "coverage",
  ".vs",
  ".idea",
  "__pycache__",
  ".venv",
  "venv",
  // .NET / JVM / other build outputs — large, churn while an IDE is open
  // (a file vanishing mid-listing throws NotFoundError), and useless as context.
  "bin",
  "obj",
  "target",
  ".gradle",
  "packages",
  "Pods",
  ".dart_tool",
  ".turbo",
  ".cache",
  "vendor",
]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif",
  "mp3", "wav", "ogg", "mp4", "webm", "mov", "avi",
  "zip", "gz", "tar", "rar", "7z",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "wasm", "bin", "class", "pyc",
]);

export const MAX_TREE_ENTRIES = 500;
export const MAX_TREE_DEPTH = 8;
export const MAX_READ_BYTES = 48 * 1024;

// ── Pending handle (dashboard picks before the discussion exists) ────────────

let pendingHandle: FileSystemDirectoryHandle | null = null;

export function setPendingProjectFolder(
  handle: FileSystemDirectoryHandle | null
): void {
  pendingHandle = handle;
}

export function getPendingProjectFolder(): FileSystemDirectoryHandle | null {
  return pendingHandle;
}

/** After the discussion is created, bind the picked folder to its id. */
export async function claimPendingProjectFolder(
  discussionId: string
): Promise<void> {
  if (!pendingHandle) return;
  await idbSet(HANDLE_KEY_PREFIX + discussionId, pendingHandle);
  pendingHandle = null;
}

export async function pickProjectFolder(): Promise<FileSystemDirectoryHandle> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (opts?: {
        mode?: "read" | "readwrite";
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  if (!picker) throw new Error("Folder access is not supported in this browser.");
  return picker({ mode: "readwrite" });
}

export async function getProjectHandle(
  discussionId: string
): Promise<FileSystemDirectoryHandle | null> {
  return (
    (await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY_PREFIX + discussionId)) ??
    null
  );
}

/** Quietly check permission without prompting (no user gesture needed). */
export async function queryProjectPermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
  };
  return (await h.queryPermission?.({ mode: "readwrite" })) === "granted";
}

/** Request permission — must be called from a user gesture. */
export async function requestProjectPermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  return verifyPermission(handle);
}

// ── Path handling ─────────────────────────────────────────────────────────────

/** Split + sanitize a relative path. Throws on absolute paths and `..`. */
function toSegments(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized || /^([A-Za-z]:|\/)/.test(normalized)) {
    throw new Error(`Refusing path outside the project folder: ${path}`);
  }
  const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(`Refusing path outside the project folder: ${path}`);
  }
  if (segments.length === 0) {
    throw new Error(`Invalid path: ${path}`);
  }
  return segments;
}

function isBinaryPath(path: string): boolean {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return !!ext && BINARY_EXTENSIONS.has(ext);
}

// ── Tree / read / write ───────────────────────────────────────────────────────

export interface ProjectTree {
  /** Relative file paths, sorted. */
  files: string[];
  truncated: boolean;
}

export async function listProjectTree(
  dir: FileSystemDirectoryHandle
): Promise<ProjectTree> {
  const files: string[] = [];
  let truncated = false;

  async function walk(
    handle: FileSystemDirectoryHandle,
    prefix: string,
    depth: number
  ): Promise<void> {
    if (files.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      return;
    }
    if (depth > MAX_TREE_DEPTH) {
      truncated = true;
      return;
    }
    try {
      for await (const [name, entry] of handle as unknown as AsyncIterable<
        [string, FileSystemHandle]
      >) {
        if (files.length >= MAX_TREE_ENTRIES) {
          truncated = true;
          return;
        }
        const path = prefix ? `${prefix}/${name}` : name;
        if (entry.kind === "directory") {
          if (IGNORED_DIRS.has(name) || name.startsWith(".")) continue;
          // A single unreadable subtree (locked/transient build dir, junction)
          // must not abort the whole listing.
          try {
            await walk(entry as FileSystemDirectoryHandle, path, depth + 1);
          } catch {
            truncated = true;
          }
        } else {
          files.push(path);
        }
      }
    } catch {
      // Iteration itself can throw if entries vanish mid-scan; keep what we have.
      truncated = true;
    }
  }

  await walk(dir, "", 0);
  files.sort();
  return { files, truncated };
}

/** Read a text file; returns null when missing/binary. Truncates large files. */
export async function readProjectFile(
  dir: FileSystemDirectoryHandle,
  path: string
): Promise<string | null> {
  if (isBinaryPath(path)) return null;
  const segments = toSegments(path);
  try {
    let current: FileSystemDirectoryHandle = dir;
    for (const segment of segments.slice(0, -1)) {
      current = await current.getDirectoryHandle(segment);
    }
    const fileHandle = await current.getFileHandle(segments.at(-1)!);
    const file = await fileHandle.getFile();
    if (file.size > MAX_READ_BYTES) {
      const text = await file.slice(0, MAX_READ_BYTES).text();
      return `${text}\n…[truncated: file is ${file.size} bytes]`;
    }
    return await file.text();
  } catch {
    return null;
  }
}

/** Write a file, creating intermediate folders. Returns bytes written. */
export async function writeProjectFile(
  dir: FileSystemDirectoryHandle,
  path: string,
  content: string
): Promise<number> {
  const segments = toSegments(path);
  let current: FileSystemDirectoryHandle = dir;
  for (const segment of segments.slice(0, -1)) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  const fileHandle = await current.getFileHandle(segments.at(-1)!, {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
  return new TextEncoder().encode(content).length;
}
