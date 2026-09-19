import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";

/** Descriptor-bound executable hashing in fixed8MiB reads. Whole-file readFile
 * internally yields for hundreds of small reads on a Node executable; a live
 * portable host can spend each intervening turn on identity-safe OS polling.
 * Memory, syscall count and content identity stay bounded without caching away
 * the required re-attestation or extending any request/grant deadline.
 */
export async function hashExecutableDescriptor(path: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > 1024 * 1024 * 1024)
    throw new Error("Executable identity exceeds its supported file bound.");
  const handle = await open(path, "r");
  let failed = false; let primary: unknown; let result: string | undefined;
  const same = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  try {
    const owned = await handle.stat();
    if (!same(before, owned)) throw new Error("Executable identity changed before descriptor hashing.");
    const buffer = Buffer.allocUnsafe(Math.min(before.size, 8 * 1024 * 1024));
    const hash = createHash("sha256");
    for (let offset = 0; offset < before.size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) throw new Error("Executable identity changed while reading.");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (!same(before, await handle.stat()) || !same(before, await lstat(path))) throw new Error("Executable identity changed during descriptor hashing.");
    result = hash.digest("hex");
  } catch (error) { failed = true; primary = error; }
  try { await handle.close(); }
  catch (cleanup) { throw new AggregateError(failed ? [primary, cleanup] : [cleanup], "Executable attestation handle cleanup failed."); }
  if (failed) throw primary;
  return result!;
}
