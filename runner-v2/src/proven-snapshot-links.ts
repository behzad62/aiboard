import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync } from "node:fs";

/**
 * Snapshot links already audited for a run, kept across runner restarts. A link key names
 * content-addressed commits plus the receipt it was audited under, so a proven link stays proven.
 * The in-memory set was cold after every restart, and re-auditing a 49-link chain through
 * supervised git calls held the first verifier step for about ten minutes (tunnel run).
 *
 * Each line carries an HMAC under the run's state key. A line that is malformed or fails its HMAC
 * is dropped, so a damaged or edited file only costs a re-audit, never skips one.
 */
export function openProvenSnapshotLinks(path: string, key: Uint8Array): Set<string> {
  const proven = new Set<string>();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const { link, mac } = (record ?? {}) as { link?: unknown; mac?: unknown };
    if (typeof link !== "string" || typeof mac !== "string") continue;
    const expected = Buffer.from(linkMac(key, link), "hex");
    const actual = Buffer.from(mac, "hex");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) proven.add(link);
  }
  return new PersistedLinkSet(proven, path, key);
}

class PersistedLinkSet extends Set<string> {
  private readonly path: string;
  private readonly key: Uint8Array;

  constructor(initial: Iterable<string>, path: string, key: Uint8Array) {
    super();
    this.path = path;
    this.key = key;
    // Seeded without the override: these lines are already on disk.
    for (const link of initial) super.add(link);
  }

  override add(link: string): this {
    if (this.has(link)) return this;
    // A failed write only loses the shortcut: the link is re-audited after the next restart.
    try {
      try {
        if (lstatSync(this.path).isSymbolicLink()) throw new Error("Snapshot link log is a symbolic link.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      appendFileSync(this.path, `${JSON.stringify({ link, mac: linkMac(this.key, link) })}\n`, { mode: 0o600 });
    } catch {
      // Keep the in-memory proof for this process.
    }
    return super.add(link);
  }
}

function linkMac(key: Uint8Array, link: string): string {
  return createHmac("sha256", key).update("proven-snapshot-link@1\0").update(link).digest("hex");
}
