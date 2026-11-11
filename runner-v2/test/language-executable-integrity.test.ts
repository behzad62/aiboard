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

// A Microsoft Store app execution alias is a link Windows cannot open (realpath
// fails with EACCES) yet CreateProcess launches. Its link data names the real
// package program, which is what must be pinned and launched.
async function withAliasedFilesystem(
  t: import("node:test").TestContext,
  alias: string,
  realpathError: NodeJS.ErrnoException,
  linkTarget: string,
  body: (counts: { readlink: number }) => Promise<void>,
) {
  const originals = { lstat: filesystem.lstat, realpath: filesystem.realpath, readlink: filesystem.readlink };
  const counts = { readlink: 0 };
  t.mock.method(filesystem, "lstat", async (...args: Parameters<typeof filesystem.lstat>) => {
    if (String(args[0]) === alias) return { isFile: () => false, isSymbolicLink: () => true } as Awaited<ReturnType<typeof filesystem.lstat>>;
    return Reflect.apply(originals.lstat, filesystem, args);
  });
  t.mock.method(filesystem, "realpath", async (...args: Parameters<typeof filesystem.realpath>) => {
    if (String(args[0]) === alias) throw realpathError;
    return Reflect.apply(originals.realpath, filesystem, args);
  });
  t.mock.method(filesystem, "readlink", async (...args: Parameters<typeof filesystem.readlink>) => {
    if (String(args[0]) === alias) { counts.readlink++; return linkTarget; }
    return Reflect.apply(originals.readlink, filesystem, args);
  });
  syncBuiltinESMExports();
  try { await body(counts); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

const errno = (code: string) => Object.assign(new Error(`${code}: permission denied, realpath`), { code });

test("a Windows app execution alias pins and launches its real target program", async (t) => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "store-alias-"));
  try {
    const target = join(root, "package", "pwsh.exe");
    await filesystem.mkdir(join(root, "package"));
    const bytes = Buffer.alloc(4096, 7); await filesystem.writeFile(target, bytes); await filesystem.chmod(target, 0o700);
    const alias = join(root, "WindowsApps", "pwsh.exe");
    await withAliasedFilesystem(t, alias, errno("EACCES"), target, async (counts) => {
      const identity = await resolveLanguageServerExecutable(alias, { environment: {}, platform: "win32" });
      assert.equal(identity.path, await filesystem.realpath(target));
      assert.equal(identity.digest, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(identity.launcher, "native");
      assert.equal(counts.readlink, 1);
      await assertLanguageServerExecutableIdentity(identity);
    });
    // EPERM is the same refusal on some Windows builds.
    await withAliasedFilesystem(t, alias, errno("EPERM"), target, async (counts) => {
      assert.equal((await resolveLanguageServerExecutable(alias, { environment: {}, platform: "win32" })).path, await filesystem.realpath(target));
      assert.equal(counts.readlink, 1);
    });
  } finally { await filesystem.rm(root, { recursive: true, force: true }); }
});

test("an unopenable link is not followed off Windows, for other errors, or to a relative target", async (t) => {
  const root = await filesystem.mkdtemp(join(tmpdir(), "store-alias-refused-"));
  try {
    const target = join(root, "real.exe");
    await filesystem.writeFile(target, Buffer.alloc(64, 1)); await filesystem.chmod(target, 0o700);
    const alias = join(root, "alias.exe");
    await withAliasedFilesystem(t, alias, errno("EACCES"), target, async (counts) => {
      await assert.rejects(resolveLanguageServerExecutable(alias, { environment: {}, platform: "linux" }), /EACCES/);
      assert.equal(counts.readlink, 0);
    });
    await withAliasedFilesystem(t, alias, errno("ELOOP"), target, async (counts) => {
      await assert.rejects(resolveLanguageServerExecutable(alias, { environment: {}, platform: "win32" }), /ELOOP/);
      assert.equal(counts.readlink, 0);
    });
    await withAliasedFilesystem(t, alias, errno("EACCES"), "real.exe", async (counts) => {
      await assert.rejects(resolveLanguageServerExecutable(alias, { environment: {}, platform: "win32" }), /EACCES/);
      assert.equal(counts.readlink, 1);
    });
  } finally { await filesystem.rm(root, { recursive: true, force: true }); }
});

const storePwsh = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe") : "";
const hasStorePwsh = process.platform === "win32" && !!storePwsh && await filesystem.lstat(storePwsh).then((s) => s.isSymbolicLink(), () => false);
test("the installed Store pwsh alias resolves to its WindowsApps package program", { skip: !hasStorePwsh && "no Microsoft Store pwsh alias on this host" }, async () => {
  const identity = await resolveLanguageServerExecutable(storePwsh, { environment: {} });
  assert.match(identity.path, /[\\/]WindowsApps[\\/]Microsoft\.PowerShell_[^\\/]+[\\/]pwsh\.exe$/i);
  assert.equal(identity.path.toLowerCase().startsWith(join(process.env.LOCALAPPDATA!, "Microsoft").toLowerCase()), false);
  await assertLanguageServerExecutableIdentity(identity);
});
