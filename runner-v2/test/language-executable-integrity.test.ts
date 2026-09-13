import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolveLanguageServerExecutable, assertLanguageServerExecutableIdentity } from "../src/language-server-executable.js";

test("LSP re-attestation uses bounded descriptor reads and revalidates replacement bytes without ambient lookup", async (t) => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "p683-executable-"));
  t.diagnostic(`exact non-native executable identity root acquired: ${root}`);
  const path = join(root, process.platform === "win32" ? "unexecuted.exe" : "unexecuted");
  const bytes = Buffer.alloc(128 * 1024, 81); await filesystem.writeFile(path, bytes); await filesystem.chmod(path, 0o700);
  const original = filesystem.readFile; let forbidden = 0; let passed = false;
  t.mock.method(filesystem, "readFile", async (...args: Parameters<typeof filesystem.readFile>) => {
    if (String(args[0]) === path) { forbidden++; throw new Error("whole executable readFile is not the bounded descriptor path"); }
    return Reflect.apply(original, filesystem, args);
  });
  syncBuiltinESMExports();
  try {
    const identity = await resolveLanguageServerExecutable(path, { environment: {} });
    assert.equal(identity.digest, createHash("sha256").update(bytes).digest("hex"));
    await assertLanguageServerExecutableIdentity(identity);
    await filesystem.writeFile(path, Buffer.alloc(bytes.length, 82));
    await assert.rejects(assertLanguageServerExecutableIdentity(identity), /attested|identity/);
    assert.equal(forbidden, 0); passed = true;
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (passed) { await filesystem.rm(root, { recursive: true }); t.diagnostic(`closed non-native executable identity root removed: ${root}`); }
    else t.diagnostic(`non-native executable failure evidence retained: ${root}`);
  }
});
