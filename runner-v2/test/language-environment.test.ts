import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import test from "node:test";
import { languageServerCommandCandidates, resolveLanguageServerExecutable, assertLanguageServerExecutableIdentity } from "../src/language-server-executable.js";

test("LSP executable resolution uses only the explicitly prepared environment, never ambient PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-env-")); t.diagnostic(`static language environment fixture acquired: ${root}`);
  let passed = false;
  try {
    const candidates = languageServerCommandCandidates("p683-fixture", { commandSearchDirectory: root });
    assert.ok(candidates.every((path) => dirname(path) === resolve(root)), "an omitted environment must not acquire ambient command search authority");
    const path = join(root, process.platform === "win32" ? "p683-fixture.exe" : "p683-fixture");
    await writeFile(path, "static unexecuted identity-v1"); await chmod(path, 0o700);
    const identity = await resolveLanguageServerExecutable("p683-fixture", { commandSearchDirectory: root, environment: { PATH: root, PATHEXT: ".EXE" } });
    assert.equal(identity.path, path);
    await assertLanguageServerExecutableIdentity(identity);
    await writeFile(path, "static unexecuted identity-v2"); await assert.rejects(assertLanguageServerExecutableIdentity(identity), /attested|identity/);
    passed = true;
  } finally { if (passed) { await rm(root, { recursive: true }); t.diagnostic(`static language environment fixture removed: ${root}`); } }
});
