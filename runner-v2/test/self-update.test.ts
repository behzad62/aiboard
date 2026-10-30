import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractFiles, writeTarGz, type ArchiveFile } from "../src/release-archive.js";
import {
  INSTALLER_PROTOCOL, PREVIEW_TARGETS, RELEASE_PRODUCT, RELEASE_TARGETS, serializeManifest, signManifestBytes, targetFormat,
  trustedKeyFromPublicKey, type ReleaseChannelConfig,
} from "../src/release-manifest.js";
import {
  acquireInstallLock, runUninstallCommand, runUpdateCommand, stripProfileBlock, windowsRemovePathScript, type InstallLayout,
} from "../src/self-update.js";

const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 3072 });
const origin = "http://127.0.0.1:1";
const config: ReleaseChannelConfig = {
  channel: "stable", manifestUrl: `${origin}/release/stable/manifest.json`, artifactPrefix: `${origin}/downloads/`,
  keys: [trustedKeyFromPublicKey("test-key", key.publicKey)], minSequence: 1,
};
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function bundle(version: string, extra: ArchiveFile[] = []): Buffer {
  const files: ArchiveFile[] = [
    { path: "node/node", data: Buffer.from(`node for ${version}`), mode: 0o755 },
    { path: "app/runner-v2/bin/aiboard.mjs", data: Buffer.from(`// ${version}`), mode: 0o644 },
  ];
  const info = { schemaVersion: 1, product: RELEASE_PRODUCT, version, target: "linux-x64", nodeVersion: "24.18.0", files: Object.fromEntries(files.map((file) => [file.path, sha256(file.data)])) };
  return writeTarGz([...files, ...extra, { path: "release.json", data: Buffer.from(JSON.stringify(info)), mode: 0o644 }]);
}

interface Release { manifest: Buffer; signature: string; archives: Map<string, Buffer> }
function release(version: string, sequence: number, options: { archive?: Buffer; signWith?: typeof key.privateKey; checksumOf?: Buffer } = {}): Release {
  const archive = options.archive ?? bundle(version);
  const hashed = options.checksumOf ?? archive;
  const manifest = Buffer.from(serializeManifest({
    schemaVersion: 1, product: RELEASE_PRODUCT, channel: "stable", version, sequence, createdAt: "2026-10-29T00:00:00Z", expiresAt: "2027-10-29T00:00:00Z",
    minInstallerVersion: INSTALLER_PROTOCOL, keyId: "test-key", nodeVersion: "24.18.0",
    artifacts: RELEASE_TARGETS.map((target) => ({
      target, format: targetFormat(target), preview: PREVIEW_TARGETS.has(target),
      bytes: target === "linux-x64" ? hashed.length : 1, sha256: target === "linux-x64" ? sha256(hashed) : "0".repeat(64),
      url: `${origin}/downloads/aiboard-${version}-${target}.${targetFormat(target)}`,
    })),
  }));
  return { manifest, signature: signManifestBytes(manifest, options.signWith ?? key.privateKey), archives: new Map([[`${origin}/downloads/aiboard-${version}-linux-x64.tar.gz`, archive]]) };
}

function fetchFrom(state: { release: Release; calls: string[] }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    state.calls.push(url);
    if (url === config.manifestUrl) return new Response(new Uint8Array(state.release.manifest));
    if (url === `${config.manifestUrl}.sig`) return new Response(state.release.signature);
    const archive = state.release.archives.get(url);
    return archive ? new Response(new Uint8Array(archive)) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

async function installedLayout(): Promise<{ dir: string; layout: InstallLayout }> {
  const dir = await mkdtemp(join(tmpdir(), "aiboard-update-"));
  const root = join(dir, "AIBoard");
  await mkdir(join(root, "versions"), { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "aiboard"), "shim");
  await writeFile(join(root, "install.json"), "{}");
  await extractFiles((await import("../src/release-archive.js")).readTarGz(bundle("0.1.0")), join(root, "versions", "0.1.0"));
  await writeFile(join(root, "current"), "0.1.0");
  await writeFile(join(root, "sequence"), "1");
  return { dir, layout: { root, binDirectory: join(root, "bin"), versionsDirectory: join(root, "versions"), runningVersion: "0.1.0" } };
}

const pointer = (layout: InstallLayout, name: string) => readFile(join(layout.root, name), "utf8").then((value) => value.trim()).catch(() => undefined);

test("update verifies, smoke-checks and atomically switches; rollback returns without lowering the sequence", async () => {
  const { dir, layout } = await installedLayout();
  try {
    const state = { release: release("0.2.0", 2), calls: [] as string[] };
    const smoked: string[] = [];
    const runtime = { layout, config, fetch: fetchFrom(state), write: () => undefined, smoke: async (_dir: string, version: string) => { smoked.push(version); } };
    await runUpdateCommand(["--check"], runtime);
    assert.equal(await pointer(layout, "current"), "0.1.0", "--check changes nothing");
    await runUpdateCommand([], runtime);
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "previous"), await pointer(layout, "sequence")], ["0.2.0", "0.1.0", "2"]);
    assert.deepEqual(smoked, ["0.2.0", "0.2.0"], "staged and final directories are both smoke-checked");
    await runUpdateCommand(["--rollback"], runtime);
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "previous"), await pointer(layout, "sequence")], ["0.1.0", "0.2.0", "2"]);
    // Updating again re-proves the retained directory instead of downloading it.
    state.calls.length = 0;
    await runUpdateCommand([], runtime);
    assert.equal(await pointer(layout, "current"), "0.2.0");
    assert.ok(!state.calls.some((url) => url.includes("/downloads/")));
    // A third release keeps active + previous, plus the version this process runs; anything else is removed.
    await mkdir(join(layout.versionsDirectory, "0.0.9"));
    state.release = release("0.3.0", 3);
    await runUpdateCommand([], runtime);
    assert.ok(existsSync(join(layout.versionsDirectory, "0.1.0")), "the running version is kept");
    assert.ok(!existsSync(join(layout.versionsDirectory, "0.0.9")), "an unused old version is removed");
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "previous")], ["0.3.0", "0.2.0"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("update fails closed and leaves the active version untouched", async () => {
  const { dir, layout } = await installedLayout();
  try {
    const cases: { name: string; release: Release; error: RegExp; smoke?: () => Promise<void> }[] = [
      { name: "wrong key", release: release("0.2.0", 2, { signWith: otherKey.privateKey }), error: /signature does not verify/ },
      { name: "tampered bundle", release: release("0.2.0", 2, { checksumOf: bundle("0.2.0", [{ path: "x", data: Buffer.from("other"), mode: 0o644 }]) }), error: /update_checksum_mismatch/ },
      { name: "inventory mismatch", release: release("0.2.0", 2, { archive: bundle("0.2.0", [{ path: "unlisted.js", data: Buffer.from("x"), mode: 0o644 }]) }), error: /differ from its release inventory/ },
      { name: "failed smoke", release: release("0.2.0", 2), error: /did not start/, smoke: async () => { throw new Error("update_smoke_failed: The new version did not start"); } },
    ];
    for (const entry of cases) {
      const state = { release: entry.release, calls: [] as string[] };
      await assert.rejects(runUpdateCommand([], { layout, config, fetch: fetchFrom(state), write: () => undefined, smoke: entry.smoke ?? (async () => undefined) }), entry.error, entry.name);
      assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "previous"), await pointer(layout, "sequence")], ["0.1.0", undefined, "1"], entry.name);
      assert.ok(!existsSync(join(layout.versionsDirectory, "0.2.0")), entry.name);
    }
    // Replay: the machine accepted sequence 5; a validly signed older manifest is refused.
    await writeFile(join(layout.root, "sequence"), "5");
    const replay = { release: release("0.2.0", 4), calls: [] as string[] };
    await assert.rejects(runUpdateCommand([], { layout, config, fetch: fetchFrom(replay), write: () => undefined, smoke: async () => undefined }), /already accepted/);
    // Offline: actionable message, nothing changed.
    const offline = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await assert.rejects(runUpdateCommand([], { layout, config, fetch: offline, write: () => undefined }), /update_offline: .*nothing was changed/);
    assert.equal(await pointer(layout, "current"), "0.1.0");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("rollback refuses a tampered retained version; the install lock refuses a live owner", async () => {
  const { dir, layout } = await installedLayout();
  try {
    const state = { release: release("0.2.0", 2), calls: [] as string[] };
    await runUpdateCommand([], { layout, config, fetch: fetchFrom(state), write: () => undefined, smoke: async () => undefined });
    await writeFile(join(layout.versionsDirectory, "0.1.0", "node", "node"), "modified after install");
    await assert.rejects(runUpdateCommand(["--rollback"], { layout, config, write: () => undefined }), /does not match its release inventory/);
    assert.equal(await pointer(layout, "current"), "0.2.0");
    const release1 = await acquireInstallLock(layout.root);
    await assert.rejects(runUpdateCommand(["--check"], { layout, config, fetch: fetchFrom(state), write: () => undefined }), /install_busy/);
    await release1();
    await assert.rejects(runUpdateCommand(["--check", "--rollback"], { layout }), /invalid_arguments/);
    await assert.rejects(runUpdateCommand([]), /not_managed_install/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("uninstall removes program files and the profile PATH block, and keeps state unless asked", async () => {
  for (const removeState of [false, true]) {
    const { dir, layout } = await installedLayout();
    try {
      const home = join(dir, "home");
      await mkdir(join(home, ".local", "share", "aiboard", "projects"), { recursive: true });
      const block = "# >>> aiboard installer >>>\nexport PATH=\"$HOME/.aiboard/bin:$PATH\"\n# <<< aiboard installer <<<\n";
      await writeFile(join(home, ".profile"), `alias ll='ls -l'\n${block}export EDITOR=vi\n`);
      const runtime = { layout, platform: "linux" as const, home, environment: {}, write: () => undefined, interactive: false };
      await assert.rejects(runUninstallCommand([], runtime), /uninstall_confirmation_required/);
      await runUninstallCommand(["--yes", ...(removeState ? ["--remove-state"] : [])], runtime);
      for (const name of ["bin", "versions", "current", "sequence", "install.json"]) assert.ok(!existsSync(join(layout.root, name)), name);
      assert.equal(await readFile(join(home, ".profile"), "utf8"), "alias ll='ls -l'\nexport EDITOR=vi\n");
      assert.equal(existsSync(join(home, ".local", "share", "aiboard")), !removeState);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("profile and Windows PATH edits only touch the installer's own entries", () => {
  assert.equal(stripProfileBlock("a\n# >>> aiboard installer >>>\nx\n# <<< aiboard installer <<<\nb\n"), "a\nb\n");
  assert.equal(stripProfileBlock("a\n# >>> aiboard installer >>>\nunterminated\n"), "a\n# >>> aiboard installer >>>\nunterminated\n");
  const script = windowsRemovePathScript("C:\\Users\\o'brien\\AppData\\Local\\AIBoard\\bin");
  assert.match(script, /\$bin = 'C:\\Users\\o''brien\\AppData\\Local\\AIBoard\\bin'/);
  assert.match(script, /DoNotExpandEnvironmentNames/);
  assert.match(script, /GetValueKind\('Path'\)/);
});
