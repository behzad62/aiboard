import { lstat, open, unlink } from "node:fs/promises";
import { createNodeOutputSpillStorage, type OutputSpillStorage } from "../../src/bounded-output-spool.js";

/** Test-only linked-file adapter for fixtures exercising linked-entry identity
 * and restart cleanup. Production POSIX storage intentionally unlinks on open;
 * advertising linked entries while borrowing that opener contradicts its contract.
 * The fixture owns its private root; this is not a production privacy claim. */
export function createLinkedTestOutputSpillStorage(): OutputSpillStorage {
  return {
    ...createNodeOutputSpillStorage(),
    attest: async () => ({ currentPrincipalPrivacy: true, identityStableDeletion: true, unlinkedEntries: false }),
    openExclusive: async (path) => {
      const handle = await open(path, "wx+", 0o600);
      try {
        const entry = await handle.stat();
        const identity = `${entry.dev.toString()}:${entry.ino.toString()}`;
        return {
          identity,
          write: async (bytes) => (await handle.write(bytes)).bytesWritten,
          sealAndRead: async (expectedBytes, maximumBytes) => {
            if (expectedBytes > maximumBytes) throw new Error("Output spill exceeds its bound.");
            await handle.sync();
            const current = await handle.stat();
            if (`${current.dev.toString()}:${current.ino.toString()}` !== identity || current.size !== expectedBytes)
              throw new Error("Output spill identity or length changed.");
            const bytes = Buffer.alloc(expectedBytes);
            let offset = 0;
            while (offset < expectedBytes) {
              const next = await handle.read(bytes, offset, expectedBytes - offset, offset);
              if (next.bytesRead === 0) throw new Error("Output spill ended early.");
              offset += next.bytesRead;
            }
            return bytes;
          },
          close: async () => await handle.close(),
        };
      } catch (error) { await handle.close(); throw error; }
    },
    removeIdentityStable: async (path, expectedIdentity) => {
      const entry = await lstat(path);
      if (`${entry.dev.toString()}:${entry.ino.toString()}` !== expectedIdentity)
        throw new Error("Output spill entry identity changed.");
      await unlink(path);
    },
  };
}
