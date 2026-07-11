import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export interface ArtifactStoreOptions {
  clock?: () => string;
}

export interface ArtifactMetadata {
  hash: string;
  mediaType: string;
  byteLength: number;
  createdAt: string;
  label?: string;
}

export interface ArtifactRecord extends ArtifactMetadata {
  path: string;
  metadataPath: string;
}

export class ArtifactNotFoundError extends Error {
  constructor(hash: string) {
    super(`Artifact ${hash} was not found.`);
    this.name = "ArtifactNotFoundError";
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomicIfMissing(path: string, bytes: Uint8Array): Promise<void> {
  if (await exists(path)) return;
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (!(await exists(path))) throw error;
  }
}

export class ArtifactStore {
  private readonly clock: () => string;

  constructor(
    private readonly root: string,
    options: ArtifactStoreOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async put(
    bytes: Uint8Array,
    mediaType: string,
    label?: string
  ): Promise<ArtifactRecord> {
    if (!mediaType.trim()) throw new Error("Artifact mediaType is required.");
    const hash = digest(bytes);
    const paths = this.paths(hash);
    await mkdir(paths.directory, { recursive: true });
    await writeAtomicIfMissing(paths.payload, bytes);

    const durableBytes = await readFile(paths.payload);
    if (digest(durableBytes) !== hash) {
      throw new Error(`Artifact ${hash} hash mismatch.`);
    }
    const metadata: ArtifactMetadata = {
      hash,
      mediaType,
      byteLength: durableBytes.byteLength,
      createdAt: this.clock(),
      ...(label?.trim() ? { label: label.trim() } : {}),
    };
    await writeAtomicIfMissing(
      paths.metadata,
      Buffer.from(JSON.stringify(metadata, null, 2))
    );
    return { ...(await this.stat(hash)), path: paths.payload, metadataPath: paths.metadata };
  }

  async get(hash: string): Promise<Buffer> {
    const { payload } = this.paths(hash);
    try {
      return await readFile(payload);
    } catch (error) {
      if (!(await exists(payload))) throw new ArtifactNotFoundError(hash);
      throw error;
    }
  }

  async stat(hash: string): Promise<ArtifactRecord> {
    const paths = this.paths(hash);
    let parsed: ArtifactMetadata;
    try {
      parsed = JSON.parse(await readFile(paths.metadata, "utf8")) as ArtifactMetadata;
    } catch (error) {
      if (!(await exists(paths.metadata))) throw new ArtifactNotFoundError(hash);
      throw new Error(`Artifact ${hash} metadata is invalid.`, { cause: error });
    }
    if (parsed.hash !== hash || !Number.isInteger(parsed.byteLength)) {
      throw new Error(`Artifact ${hash} metadata does not match its address.`);
    }
    return { ...parsed, path: paths.payload, metadataPath: paths.metadata };
  }

  async verify(hash: string): Promise<ArtifactRecord> {
    const [bytes, record] = await Promise.all([this.get(hash), this.stat(hash)]);
    if (digest(bytes) !== hash || bytes.byteLength !== record.byteLength) {
      throw new Error(`Artifact ${hash} hash mismatch.`);
    }
    return record;
  }

  private paths(hash: string): {
    directory: string;
    payload: string;
    metadata: string;
  } {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ArtifactNotFoundError(hash);
    const directory = join(this.root, hash.slice(0, 2));
    return {
      directory,
      payload: join(directory, hash),
      metadata: join(directory, `${hash}.json`),
    };
  }
}
