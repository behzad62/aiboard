import { statSync } from "node:fs";

import type { AiboardHomeLocation } from "./aiboard-home-paths.js";
import { readAiboardHome, readAiboardHomeSync, type AiboardHomeSnapshot } from "./aiboard-home-store.js";

/**
 * A home reader for the Runner's hot paths (HM3): the model proxy reads the home on every call, and
 * a home-backed provider config on every runtime it builds. Decrypting the credentials costs a scrypt
 * derivation (about 30 ms of blocked event loop), so the last snapshot is reused while the home's
 * files are exactly the files it was read from: the home folder, config.json, credentials.json and the
 * home key, each by identity, size, modification time, mode and owner. Every write replaces a file
 * by an atomic rename, which changes its identity, so a key removed or replaced with
 * `aiboard keys …`, the web or another Runner is seen by the next call. Errors are never cached.
 *
 * Owned filesystem targets: none (stat and the home store's reads only).
 */
export class CachedHomeReader {
  private cached: { signature: string; snapshot: AiboardHomeSnapshot } | undefined;

  constructor(readonly location: AiboardHomeLocation) {}

  async read(): Promise<AiboardHomeSnapshot> {
    // Taken before the read: a write during the read changes the files, so the next call reads again.
    const signature = this.signature();
    if (this.cached?.signature === signature) return this.cached.snapshot;
    const snapshot = await readAiboardHome(this.location);
    this.cached = { signature, snapshot };
    return snapshot;
  }

  readSync(): AiboardHomeSnapshot {
    const signature = this.signature();
    if (this.cached?.signature === signature) return this.cached.snapshot;
    const snapshot = readAiboardHomeSync(this.location);
    this.cached = { signature, snapshot };
    return snapshot;
  }

  private signature(): string {
    return [this.location.home, this.location.configPath, this.location.credentialsPath, this.location.keyPath].map((path) => {
      try {
        const info = statSync(path, { bigint: true });
        return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}:${info.uid}`;
      } catch {
        return "absent";
      }
    }).join("|");
  }
}
