import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cliRootCaptureArgs, forwardCliRootRecords } from "./support/cli-root-capture.js";

const tsxPath = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
test("C5 tsx capture requires its explicit launcher only when enabled", () => {
  assert.throws(() => cliRootCaptureArgs([], true, "tsx"), /exact launcher path/);
  assert.deepEqual(cliRootCaptureArgs([], false, "tsx"), []);
});
// The same installed tsx launcher hop as the real CLI fixture. The finite child
// creates only two empty directories, removes exactly those directories, and
// disconnects IPC. The wrapper must join its child; no product/provider runs.
const calibration = `
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
(async () => { const roots = []; try {
  process.send({event:'loader',active:process.execArgv.some(v=>v.includes('tsx'))});
  roots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'aiboard-c5-round9-tsx-sync-')));
  process.send({event:'created',path:roots.at(-1)});
  roots.push(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aiboard-c5-round9-tsx-async-')));
  process.send({event:'created',path:roots.at(-1)});
  process.stdout.write(JSON.stringify({ready:true})+'\\n');
  process.stderr.write('private child diagnostic\\n');
} finally { for (const root of roots) { fs.rmSync(root,{recursive:true}); process.send({event:'removed',path:root}); } process.disconnect(); }
})().catch(() => { process.exitCode = 1; });`;

for (const enabled of [true, false]) {
  test(`C5 round9 actual tsx CLI hop enabled=${enabled} observes only safe exact child roots`, { timeout: 10_000 }, async (t) => {
    const originalArgs = [tsxPath, "-e", calibration];
    const args = cliRootCaptureArgs(originalArgs, enabled, "tsx");
    if (!enabled) assert.deepEqual(args, originalArgs, "disabled observation must not change the actual launch vector");
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    const records: string[] = []; const acquired: string[] = []; const removed: string[] = [];
    let stdout = ""; let spawnError: Error | undefined; let actualLoader = false;
    child.once("error", (error) => { spawnError = error; });
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.on("message", (message: { event?: string; path?: string; active?: boolean }) => {
      if (message.event === "loader") actualLoader = message.active === true;
      if (message.event === "created" && typeof message.path === "string") acquired.push(message.path);
      if (message.event === "removed" && typeof message.path === "string") removed.push(message.path);
      t.diagnostic(`C5 round9 finite child event: ${JSON.stringify(message)}`);
    });
    forwardCliRootRecords(child.stderr!, (record) => { records.push(record); process.stderr.write(record); });
    // On timeout leave the finite child's own finalizer in control. Never use a
    // numeric PID or guessed process tree as fallback cleanup authority.
    let timer: NodeJS.Timeout | undefined;
    const close = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal }))),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Finite tsx calibration did not join; exact acquisition ledger retained.")), 8_000); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    assert.equal(spawnError, undefined); assert.deepEqual(close, { code: 0, signal: null });
    assert.equal(actualLoader, true, "the calibration must run below the installed tsx loader, not direct Node");
    assert.equal(stdout, '{"ready":true}\n');
    assert.equal(acquired.length, 2); assert.deepEqual(removed, acquired);
    for (const root of acquired) assert.equal(existsSync(root), false);
    assert.equal(records.length, enabled ? 4 : 0, "the actual child, not just the tsx wrapper, must be observed");
    if (enabled) {
      const values = records.map((record) => JSON.parse(record.slice("C5 CLI root: ".length)) as { event: string; path: string; existsAtExit?: boolean });
      assert.deepEqual(values.map(({ event }) => event), ["created", "created", "exit", "exit"]);
      assert.deepEqual(values.slice(0, 2).map(({ path }) => path), acquired);
      assert.deepEqual(values.slice(2).map(({ path }) => path), acquired);
      assert.deepEqual(values.slice(2).map(({ existsAtExit }) => existsAtExit), [false, false]);
    }
  });
}
