import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactStore } from "./artifact-store.js";
import type { AgentMediaAttachment } from "./agent-contracts.js";

export const MAX_VISUAL_FILES = 3;
export const MAX_VISUAL_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_VISUAL_TOTAL_BYTES = 12 * 1024 * 1024;
const allowed = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;

type MediaMime = (typeof allowed)[number];
export interface UserMediaInput {
  filename: string;
  mimeType: string;
  base64Data: string;
}
export interface StoredMediaReference {
  filename: string;
  mimeType: MediaMime;
  hash: string;
  byteLength: number;
}
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function verifySignature(bytes: Buffer, mime: MediaMime): boolean {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === "image/jpeg") return bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === "image/webp") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  return bytes.subarray(0, 5).toString() === "%PDF-";
}
function decodeMedia(input: UserMediaInput): { bytes: Buffer; mimeType: MediaMime; filename: string } {
  if (!input || !allowed.includes(input.mimeType as MediaMime) || typeof input.filename !== "string" ||
      !input.filename.trim() || input.filename.length > 160 || typeof input.base64Data !== "string") {
    throw new Error("Unsupported visual attachment. Use PNG, JPEG, WebP, or PDF.");
  }
  if (input.base64Data.length > Math.ceil(MAX_VISUAL_FILE_BYTES * 4 / 3) + 8 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64Data)) {
    throw new Error("Invalid visual file encoding or size.");
  }
  const bytes = Buffer.from(input.base64Data, "base64");
  if (!bytes.length || bytes.length > MAX_VISUAL_FILE_BYTES || bytes.toString("base64") !== input.base64Data ||
      !verifySignature(bytes, input.mimeType as MediaMime)) {
    throw new Error("Visual file contents do not match the declared type or exceed 8 MiB.");
  }
  return { bytes, mimeType: input.mimeType as MediaMime, filename: input.filename.replace(/[\x00-\x1f\\/]/g, "_") };
}

export function validateVisualInputs(inputs: readonly UserMediaInput[]): Array<{
  media: AgentMediaAttachment; bytes: Buffer; hash: string
}> {
  if (inputs.length > MAX_VISUAL_FILES) throw new Error("Attach at most 3 images/PDFs per message.");
  const entries = inputs.map((input) => {
    const { bytes, mimeType, filename } = decodeMedia(input);
    return { bytes, hash: hashText(bytes.toString("base64")), media: { filename, mimeType, base64Data: bytes.toString("base64") } };
  });
  if (entries.reduce((sum, entry) => sum + entry.bytes.length, 0) > MAX_VISUAL_TOTAL_BYTES) {
    throw new Error("Images and PDFs must total 12 MiB or less.");
  }
  return entries;
}

/** Runner-owned separate user-input artifact directory; never project file paths. */
export class BuildUserMediaStore {
  private readonly artifacts: ArtifactStore;
  constructor(private readonly directory: string) {
    this.artifacts = new ArtifactStore(join(directory, "objects"));
  }

  async save(runId: string, messageId: string, inputs: readonly UserMediaInput[]): Promise<StoredMediaReference[]> {
    const entries = validateVisualInputs(inputs);
    if (!entries.length) return [];
    const folder = join(this.directory, "manifests", hashText(runId));
    const manifest = join(folder, hashText(messageId) + ".json");
    await mkdir(folder, { recursive: true });
    // Run-scoped disk budget: bound cumulative user-upload persistence.
    const prior = await readdir(folder);
    if (!prior.includes(hashText(messageId) + ".json")) {
      if (prior.length >= 100) throw new Error("This build has reached its visual-message retention limit.");
      let consumed = 0;
      for (const name of prior.filter((entry) => entry.endsWith(".json"))) {
        const old = JSON.parse(await readFile(join(folder, name), "utf8")) as { files: StoredMediaReference[] };
        consumed += old.files.reduce((total, file) => total + file.byteLength, 0);
        if (consumed > 100 * 1024 * 1024) break;
      }
      if (consumed + entries.reduce((total, entry) => total + entry.bytes.length, 0) > 100 * 1024 * 1024) {
        throw new Error("This build has reached its 100 MiB visual attachment storage budget.");
      }
    }
    const refs = await Promise.all(entries.map(async ({ bytes, media }) => {
      const stored = await this.artifacts.put(bytes, media.mimeType, media.filename);
      return { filename: media.filename, mimeType: media.mimeType, hash: stored.hash, byteLength: bytes.length };
    }));
    const serialized = JSON.stringify({ runId, messageId, files: refs });
    try {
      await writeFile(manifest, serialized, { flag: "wx" });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
      const previous = await readFile(manifest, "utf8");
      if (previous !== serialized) throw new Error("Message attachment identity already belongs to a different payload.");
    }
    return refs;
  }
  referenceToken(messageId: string, hash: string): string {
    return `AIBOARD_USER_MEDIA:${hashText(messageId)}:${hash}`;
  }

  async loadByReference(runId: string, manifestDigest: string, hash: string): Promise<AgentMediaAttachment | null> {
    if (!/^[a-f0-9]{64}$/.test(manifestDigest) || !/^[a-f0-9]{64}$/.test(hash)) return null;
    const path = join(this.directory, "manifests", hashText(runId), manifestDigest + ".json");
    let stored: { runId: string; messageId: string; files: StoredMediaReference[] };
    try { stored = JSON.parse(await readFile(path, "utf8")) as typeof stored; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    if (stored.runId !== runId || hashText(stored.messageId) !== manifestDigest) return null;
    const file = stored.files.find((entry) => entry.hash === hash);
    if (!file) return null;
    const verified = await this.artifacts.verify(hash);
    if (verified.byteLength !== file.byteLength || verified.mediaType !== file.mimeType) throw new Error("Visual artifact integrity mismatch.");
    return { filename: file.filename, mimeType: file.mimeType, base64Data: (await this.artifacts.get(hash)).toString("base64") };
  }

  async load(runId: string, messageId: string, refs: readonly StoredMediaReference[]): Promise<AgentMediaAttachment[]> {
    if (!refs.length) return [];
    const manifest = join(this.directory, "manifests", hashText(runId), hashText(messageId) + ".json");
    const stored = JSON.parse(await readFile(manifest, "utf8")) as { runId: string; messageId: string; files: StoredMediaReference[] };
    if (stored.runId !== runId || stored.messageId !== messageId || JSON.stringify(refs) !== JSON.stringify(stored.files)) {
      throw new Error("Visual attachment ownership or manifest mismatch.");
    }
    return await Promise.all(refs.map(async (item) => {
      const verified = await this.artifacts.verify(item.hash);
      if (verified.byteLength !== item.byteLength || verified.mediaType !== item.mimeType) throw new Error("Visual artifact integrity mismatch.");
      return { filename: item.filename, mimeType: item.mimeType, base64Data: (await this.artifacts.get(item.hash)).toString("base64") };
    }));
  }
}
