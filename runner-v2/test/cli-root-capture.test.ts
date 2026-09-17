import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import test from "node:test";
import { cliRootCaptureArgs, forwardCliRootRecords } from "./support/cli-root-capture.js";

// This finite child acquires only two empty roots and pipe handles. The direct
// child handle is retained until close; no product runner, port or tree exists.
const calibration = `
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
(async () => { const roots = []; try {
  roots.push(fs.mkdtempSync(path.join(os.tmpdir(), 'aiboard-c5-round8-sync-')));
  process.send({event:'created',path:roots.at(-1)});
  roots.push(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aiboard-c5-round8-async-')));
  process.send({event:'created',path:roots.at(-1)});
  process.stdout.write(JSON.stringify({ready:true})+'\\n');
  process.stderr.write('private diagnostic must remain private\\n');
} finally { for (const root of roots) { fs.rmSync(root, {recursive:true}); process.send({event:'removed',path:root}); } process.disconnect(); }
})().catch(() => { process.exitCode = 1; });`;

for (const enabled of [true, false]) {
  test(`CLI root capture real child enabled=${enabled} keeps stdout clean and accounts sync/async roots`, async () => {
    const child = spawn(process.execPath, cliRootCaptureArgs(["-e", calibration], enabled), { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    child.on("message", (message) => { console.log(`C5 round8 calibration root: ${JSON.stringify(message)}`); });
    const records: string[] = [];
    let stdout = "";
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    forwardCliRootRecords(child.stderr!, (record) => { records.push(record); process.stderr.write(record); });
    let timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 5_000);
    let joinTimer: NodeJS.Timeout | undefined;
    const close = await Promise.race([
      new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) => child.once("close", (code, signal) => resolve({code, signal}))),
      new Promise<never>((_resolve, reject) => { joinTimer = setTimeout(() => reject(new Error("Calibration child close remains uncertain; root ledger retained.")), 7_000); }),
    ]).finally(() => { clearTimeout(timer); if (joinTimer) clearTimeout(joinTimer); });
    assert.equal(spawnError, undefined);
    assert.equal(timeout, false);
    assert.deepEqual(close, {code: 0, signal: null});
    assert.equal(stdout, '{"ready":true}\n');
    assert.equal(records.length, enabled ? 4 : 0);
    if (enabled) {
      const parsed = records.map((line) => JSON.parse(line.slice("C5 CLI root: ".length)) as { event: string; path: string; existsAtExit?: boolean });
      assert.deepEqual(parsed.map((record) => record.event), ["created", "created", "exit", "exit"]);
      assert.match(parsed[0]!.path, /aiboard-c5-round8-sync-/);
      assert.match(parsed[1]!.path, /aiboard-c5-round8-async-/);
      assert.deepEqual(parsed.slice(2).map((record) => record.existsAtExit), [false, false]);
      for (const record of parsed) assert.equal(existsSync(record.path), false);
    }
  });
}

test("CLI root forwarding preserves chunked valid records only, excluding diagnostics and malformed records", async () => {
  const input = new PassThrough();
  const records: string[] = [];
  forwardCliRootRecords(input, (record) => records.push(record));
  const valid = 'C5 CLI root: {"event":"created","path":"D:/exact/new-root"}\n';
  input.write("secret diagnostic\nC5 CLI root: {bad}\n");
  input.write('C5 CLI root: {"event":"created","path":"D:/x","token":"secret"}\n');
  input.write(valid.slice(0, 19)); input.write(valid.slice(19));
  input.end('C5 CLI root: {"event":"exit","path":"D:/exact/new-root","existsAtExit":false}\n');
  await new Promise((resolve) => input.once("end", resolve));
  assert.deepEqual(records, [valid, 'C5 CLI root: {"event":"exit","path":"D:/exact/new-root","existsAtExit":false}\n']);
});
