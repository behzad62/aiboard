// A file replaced by renaming a temporary over it waits, on Windows, while another process holds the destination
// open (windows-file-replace.ts). The first tests drive the retry with an injected rename and clock on any OS; the
// last one holds a real file open from a child process on Windows.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { replaceFileWhenFree, WINDOWS_REPLACE_CEILING_MS } from "../src/windows-file-replace.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation failed, rename`), { code });
}

/** A rename that fails with the given codes in turn, then succeeds, on a clock the sleeps advance. */
function scripted(failures: readonly string[]) {
  let clock = 0;
  const renames: string[] = [];
  const sleeps: number[] = [];
  return {
    renames,
    sleeps,
    options: {
      platform: "win32" as const,
      now: () => clock,
      sleep: async (milliseconds: number) => { sleeps.push(milliseconds); clock += milliseconds; },
      rename: (from: string, to: string) => {
        renames.push(`${from}->${to}`);
        const code = failures[renames.length - 1];
        if (code !== undefined) throw errno(code);
      },
    },
  };
}

test("a Windows replace retries EPERM, EACCES and EBUSY until the rename lands", async () => {
  const run = scripted(["EPERM", "EACCES", "EBUSY", "EPERM"]);
  await replaceFileWhenFree("record.json.tmp", "record.json", run.options);
  assert.equal(run.renames.length, 5);
  assert.deepEqual(run.sleeps, [1, 2, 4, 8], "polls start at 1 ms and back off");
});

test("a Windows replace backs off to 25 ms and gives up at the ceiling with the last error", async () => {
  const run = scripted(Array.from({ length: 10_000 }, () => "EPERM"));
  await assert.rejects(replaceFileWhenFree("record.json.tmp", "record.json", run.options), (error: NodeJS.ErrnoException) => error.code === "EPERM");
  assert.equal(Math.max(...run.sleeps), 25, "the poll interval stops growing at 25 ms");
  assert.equal(run.sleeps.reduce((sum, value) => sum + value, 0), WINDOWS_REPLACE_CEILING_MS,
    "the last sleep is cut to what is left of the ceiling, and nothing sleeps past it");
});

test("a replace never retries another error, or any error off Windows", async () => {
  const missing = scripted(["ENOENT"]);
  await assert.rejects(replaceFileWhenFree("a.tmp", "a", missing.options), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  assert.deepEqual(missing.sleeps, []);
  for (const platform of ["linux", "darwin"] as const) {
    const posix = scripted(["EPERM"]);
    await assert.rejects(replaceFileWhenFree("a.tmp", "a", { ...posix.options, platform }), (error: NodeJS.ErrnoException) => error.code === "EPERM");
    assert.deepEqual(posix.sleeps, [], `${platform} renames over an open file, so an EPERM there is final`);
  }
  const custom = scripted(["EPERM", "EPERM"]);
  await assert.rejects(replaceFileWhenFree("a.tmp", "a", { ...custom.options, ceilingMs: 0 }), (error: NodeJS.ErrnoException) => error.code === "EPERM");
  assert.equal(custom.renames.length, 1, "a spent ceiling fails on the first refusal");
});

test("on Windows a replace waits for another process to close the destination, with the event loop free", { timeout: 20_000 }, async (t) => {
  if (process.platform !== "win32") { t.skip("Holding a file open blocks a rename over it only on Windows."); return; }
  const root = mkdtempSync(join(tmpdir(), "aiboard-replace-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  const destination = join(root, "record.json");
  writeFileSync(destination, "old");
  const holder = spawn(process.execPath, ["-e",
    "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');process.stdout.write('held\\n');setTimeout(()=>{fs.closeSync(fd);process.exit(0)},400)",
    destination], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => holder.on("exit", () => resolve()));
  for await (const line of createInterface({ input: holder.stdout! })) if (line === "held") break;
  const temporary = `${destination}.next.tmp`;
  writeFileSync(temporary, "new");
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 20);
  const started = Date.now();
  try {
    await replaceFileWhenFree(temporary, destination);
  } finally {
    clearInterval(ticker);
  }
  await exited;
  assert.equal(readFileSync(destination, "utf8"), "new");
  assert.deepEqual(readdirSync(root), ["record.json"], "the temporary was renamed into place");
  assert.ok(Date.now() - started >= 100, "the rename waited for the holder to close the file");
  assert.ok(ticks >= 3, `timers ran while the replace waited (${ticks} ticks)`);
});
