import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tryAcquireLock } from "../src/launcher-instance.js";

const PROBE = fileURLToPath(new URL("./fixtures/launcher-lock-probe.ts", import.meta.url));

function probe(directory: string, kind: "discovery" | "lifetime"): string {
  const result = spawnSync(process.execPath, ["--import", "tsx", PROBE, directory, kind], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// POSIX record locks are dropped when any descriptor of the file closes in the owning process; the
// post-acquire identity check once re-opened the lock file and silently freed every launcher lock on macOS/Linux.
test("a held launcher lock excludes other processes on every OS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aiboard-lock-"));
  try {
    for (const kind of ["discovery", "lifetime"] as const) {
      const release = tryAcquireLock(directory, kind);
      assert.ok(release, `${kind} lock acquired`);
      try {
        assert.equal(probe(directory, kind), "refused", `${kind} lock stays exclusive while held`);
      } finally { release(); }
      assert.equal(probe(directory, kind), "acquired", `${kind} lock is free after release`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
