import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
const source = readFileSync(new URL("./fixtures/lsp-server.mjs", import.meta.url), "utf8");
const start = source.indexOf("function startDescendantFixture() {"), end = source.indexOf("\nasync function ", start);
for (const platform of ["linux", "win32"]) test(`LSP native descendant fixture remains in its attested ${platform} ownership domain`, () => {
  const launches: Array<{ detached: boolean }> = [];
  runInNewContext(source.slice(start, end) + "\nstartDescendantFixture();", {
    process: { platform, execPath: "node", env: { LSP_FIXTURE_DESCENDANT_PID_FILE: "exact-marker" } },
    spawn: (_command: string, _args: string[], options: { detached: boolean }) => { launches.push(options); return { unref: () => undefined }; },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0]!.detached, platform === "win32");
});