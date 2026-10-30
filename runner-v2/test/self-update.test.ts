import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { extractFiles, writeTarGz, type ArchiveFile } from "../src/release-archive.js";
import {
  INSTALLER_PROTOCOL, PREVIEW_TARGETS, RELEASE_PRODUCT, RELEASE_TARGETS, serializeManifest, signManifestBytes, targetFormat,
  trustedKeyFromPublicKey, type ReleaseChannelConfig,
} from "../src/release-manifest.js";
import {
  acquireInstallLock, runUninstallCommand, runUpdateCommand, stripProfileBlock, windowsCleanupScript, windowsRemovePathScript, type InstallLayout,
} from "../src/self-update.js";

const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
const otherKey = generateKeyPairSync("rsa", { modulusLength: 3072 });
const recoveryKey = generateKeyPairSync("rsa", { modulusLength: 3072 });
const replacementKey = generateKeyPairSync("rsa", { modulusLength: 3072 });
const origin = "http://127.0.0.1:1";
const config: ReleaseChannelConfig = {
  channel: "stable", manifestUrl: `${origin}/release/stable/manifest.json`, artifactPrefix: `${origin}/downloads/`,
  keys: [trustedKeyFromPublicKey("test-key", key.publicKey)], minSequence: 1,
};
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const profileBlock = '# >>> aiboard installer >>>\ncase ":${PATH}:" in *":$HOME/.aiboard/bin:"*) ;; *) export PATH="$HOME/.aiboard/bin:$PATH" ;; esac\n# <<< aiboard installer <<<\n';
const fishConfig = "contains -- $HOME/.aiboard/bin $PATH; or set -gx PATH $HOME/.aiboard/bin $PATH\n";

function bundle(version: string, extra: ArchiveFile[] = []): Buffer {
  const files: ArchiveFile[] = [
    { path: "node/node", data: Buffer.from(`node for ${version}`), mode: 0o755 },
    { path: "app/runner-v2/bin/aiboard.mjs", data: Buffer.from(`// ${version}`), mode: 0o644 },
  ];
  const info = { schemaVersion: 1, product: RELEASE_PRODUCT, version, target: "linux-x64", nodeVersion: "24.18.0", files: Object.fromEntries(files.map((file) => [file.path, sha256(file.data)])) };
  return writeTarGz([...files, ...extra, { path: "release.json", data: Buffer.from(JSON.stringify(info)), mode: 0o644 }]);
}

interface Release { manifest: Buffer; signature: string; archives: Map<string, Buffer> }
function release(version: string, sequence: number, options: { archive?: Buffer; signWith?: typeof key.privateKey; checksumOf?: Buffer; epoch?: number; keyId?: string; signingKeys?: ReleaseChannelConfig["keys"]; createdAt?: string; expiresAt?: string } = {}): Release {
  const archive = options.archive ?? bundle(version);
  const hashed = options.checksumOf ?? archive;
  const manifest = Buffer.from(serializeManifest({
    schemaVersion: options.epoch === undefined ? 1 : 2, product: RELEASE_PRODUCT, channel: "stable", version, sequence,
    ...(options.epoch === undefined ? {} : { epoch: options.epoch, signingKeys: options.signingKeys ?? [] }), createdAt: options.createdAt ?? "2026-10-29T00:00:00Z", expiresAt: options.expiresAt ?? "2027-10-29T00:00:00Z",
    minInstallerVersion: INSTALLER_PROTOCOL, keyId: options.keyId ?? "test-key", nodeVersion: "24.18.0",
    artifacts: RELEASE_TARGETS.map((target) => ({
      target, format: targetFormat(target), preview: PREVIEW_TARGETS.has(target),
      bytes: target === "linux-x64" ? hashed.length : 1, sha256: target === "linux-x64" ? sha256(hashed) : "0".repeat(64),
      url: `${origin}/downloads/aiboard-${version}-${target}.${targetFormat(target)}`,
    })),
  }));
  return { manifest, signature: signManifestBytes(manifest, options.signWith ?? key.privateKey), archives: new Map([[`${origin}/downloads/aiboard-${version}-linux-x64.tar.gz`, archive]]) };
}

function fetchFrom(state: { release: Release; calls: string[]; openings?: Map<number, Release> }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    state.calls.push(url);
    if (url === config.manifestUrl) return new Response(new Uint8Array(state.release.manifest));
    if (url === `${config.manifestUrl}.sig`) return new Response(state.release.signature);
    for (const [epoch, opening] of state.openings ?? []) {
      const history = new URL(`epoch-${epoch}.json`, config.manifestUrl).href;
      if (url === history) return new Response(new Uint8Array(opening.manifest));
      if (url === `${history}.sig`) return new Response(opening.signature);
    }
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
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "previous"), await pointer(layout, "sequence")], ["0.2.0", "0.1.0", "0:2"]);
    assert.deepEqual(smoked, ["0.2.0", "0.2.0"], "staged and final directories are both smoke-checked");
    await runUpdateCommand(["--rollback"], runtime);
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "previous"), await pointer(layout, "sequence")], ["0.1.0", "0.2.0", "0:2"]);
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

test("update follows only bounded secure redirects without contacting a downgrade", async () => {
  const { dir, layout } = await installedLayout();
  const production: ReleaseChannelConfig = { ...config, manifestUrl: "https://aiboard.me/release/stable/manifest.json",
    artifactPrefix: "https://github.com/behzad62/aiboard/releases/download/" };
  const fixture = release("0.2.0", 2);
  const manifest = JSON.parse(fixture.manifest.toString("utf8"));
  for (const artifact of manifest.artifacts) artifact.url = `${production.artifactPrefix}v0.2.0/aiboard-${artifact.target}`;
  const bytes = Buffer.from(serializeManifest(manifest));
  const signature = signManifestBytes(bytes, key.privateKey);
  try {
    const calls: string[] = [];
    const fetchSecure = (async (input: string | URL | Request, options?: RequestInit) => {
      const current = String(input);
      calls.push(current);
      assert.equal(options?.redirect, "manual");
      if (current === production.manifestUrl) return new Response(null, { status: 302, headers: { location: "https://cdn.example.test/manifest?token=abc" } });
      if (current === "https://cdn.example.test/manifest?token=abc") return new Response(new Uint8Array(bytes));
      if (current === `${production.manifestUrl}.sig`) return new Response(null, { status: 307, headers: { location: "/signature" } });
      if (current === "https://aiboard.me/signature") return new Response(signature);
      throw new Error(`Unexpected request: ${current}`);
    }) as typeof fetch;
    await runUpdateCommand(["--check"], { layout, config: production, fetch: fetchSecure, write: () => undefined });
    assert.equal(calls.length, 4, "HTTPS cross-host and relative redirects are followed");

    for (const location of ["http://example.test/file", "http://127.0.0.1:1/file", "https://user:pass@example.test/file", "file:///tmp/file"]) {
      const visited: string[] = [];
      const downgrade = (async (input: string | URL | Request, options?: RequestInit) => {
        visited.push(String(input));
        assert.equal(options?.redirect, "manual");
        return new Response(null, { status: 302, headers: { location } });
      }) as typeof fetch;
      await assert.rejects(runUpdateCommand(["--check"], { layout, config: production, fetch: downgrade, write: () => undefined }), /update_redirect_rejected/);
      assert.deepEqual(visited, [production.manifestUrl], "the rejected redirect target was not contacted");
      assert.equal(await pointer(layout, "current"), "0.1.0");
    }
    const artifactCalls: string[] = [];
    const badArtifact = (async (input: string | URL | Request) => {
      const current = String(input);
      artifactCalls.push(current);
      if (current === production.manifestUrl) return new Response(new Uint8Array(bytes));
      if (current === `${production.manifestUrl}.sig`) return new Response(signature);
      return new Response(null, { status: 302, headers: { location: "http://example.test/payload" } });
    }) as typeof fetch;
    await assert.rejects(runUpdateCommand([], { layout, config: production, fetch: badArtifact, write: () => undefined, smoke: async () => undefined }), /update_redirect_rejected/);
    assert.equal(artifactCalls.length, 3, "the insecure artifact target was not contacted");
    assert.equal(await pointer(layout, "current"), "0.1.0");

    const loopbackCalls: string[] = [];
    const fromLoopback = (async (input: string | URL | Request) => {
      const current = String(input);
      loopbackCalls.push(current);
      const location = current === config.manifestUrl ? "https://cdn.example.test/step" : `${origin}/back`;
      return new Response(null, { status: 302, headers: { location } });
    }) as typeof fetch;
    await assert.rejects(runUpdateCommand(["--check"], { layout, config, fetch: fromLoopback, write: () => undefined }), /update_redirect_rejected/);
    assert.deepEqual(loopbackCalls, [config.manifestUrl, "https://cdn.example.test/step"], "even a test chain cannot downgrade after an HTTPS hop");

    const localCalls: string[] = [];
    const localRedirect = (async (input: string | URL | Request) => {
      const current = String(input);
      localCalls.push(current);
      if (current === config.manifestUrl) return new Response(null, { status: 302, headers: { location: "/mirror" } });
      if (current === `${origin}/mirror`) return new Response(new Uint8Array(fixture.manifest));
      if (current === `${config.manifestUrl}.sig`) return new Response(fixture.signature);
      throw new Error(`Unexpected request: ${current}`);
    }) as typeof fetch;
    await runUpdateCommand(["--check"], { layout, config, fetch: localRedirect, write: () => undefined });
    assert.deepEqual(localCalls, [config.manifestUrl, `${origin}/mirror`, `${config.manifestUrl}.sig`]);

    const wrongPortCalls: string[] = [];
    const wrongPort = (async (input: string | URL | Request) => {
      wrongPortCalls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:2/file" } });
    }) as typeof fetch;
    await assert.rejects(runUpdateCommand(["--check"], { layout, config, fetch: wrongPort, write: () => undefined }), /update_redirect_rejected/);
    assert.deepEqual(wrongPortCalls, [config.manifestUrl]);

    for (const location of [undefined, "https://[invalid"]) {
      const invalid = (async () => new Response(null, { status: 302, headers: location ? { location } : {} })) as typeof fetch;
      await assert.rejects(runUpdateCommand(["--check"], { layout, config: production, fetch: invalid, write: () => undefined }), /invalid redirect/);
    }
    const boundaryCalls: string[] = [];
    const fiveRedirects = (async (input: string | URL | Request) => {
      const current = String(input);
      boundaryCalls.push(current);
      if (current === `${production.manifestUrl}.sig`) return new Response(signature);
      if (current === "https://aiboard.me/chain/5") return new Response(new Uint8Array(bytes));
      return new Response(null, { status: 302, headers: { location: `/chain/${boundaryCalls.length}` } });
    }) as typeof fetch;
    await runUpdateCommand(["--check"], { layout, config: production, fetch: fiveRedirects, write: () => undefined });
    assert.equal(boundaryCalls.length, 7, "five redirects, the manifest, and the signature are fetched");
    const visited: string[] = [];
    const looping = (async (input: string | URL | Request) => {
      visited.push(String(input));
      return new Response(null, { status: 302, headers: { location: `/loop?hop=${visited.length}` } });
    }) as typeof fetch;
    await assert.rejects(runUpdateCommand(["--check"], { layout, config: production, fetch: looping, write: () => undefined }), /too many times/);
    assert.equal(visited.length, 6);

    const signedCdn = "https://release-assets.example.test/bundle?token=abc&expires=123";
    const downloadCalls: string[] = [];
    const archive = [...fixture.archives.values()][0]!;
    const goodArtifact = (async (input: string | URL | Request, options?: RequestInit) => {
      const current = String(input);
      downloadCalls.push(current);
      assert.equal(options?.redirect, "manual");
      if (current === production.manifestUrl) return new Response(new Uint8Array(bytes));
      if (current === `${production.manifestUrl}.sig`) return new Response(signature);
      if (current.startsWith(production.artifactPrefix)) return new Response(null, { status: 302, headers: { location: signedCdn } });
      if (current === signedCdn) return new Response(new Uint8Array(archive));
      throw new Error(`Unexpected request: ${current}`);
    }) as typeof fetch;
    await runUpdateCommand([], { layout, config: production, fetch: goodArtifact, write: () => undefined, smoke: async () => undefined });
    assert.equal(await pointer(layout, "current"), "0.2.0");
    assert.equal(downloadCalls.at(-1), signedCdn, "a signed HTTPS CDN URL works for a bundle");
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

test("a recovery-signed epoch replaces compromised keys and preserves the new high-water mark", async () => {
  const { dir, layout } = await installedLayout();
  const recovery = trustedKeyFromPublicKey("recovery-key", recoveryKey.publicKey);
  const replacement = trustedKeyFromPublicKey("replacement-key", replacementKey.publicKey);
  const initial = { ...config, epoch: 0, recoveryKeys: [recovery] };
  const state = { release: release("0.2.0", 1, { epoch: 1, signingKeys: [replacement] }), calls: [] as string[] };
  const runtime = { layout, config: initial, fetch: fetchFrom(state), write: () => undefined, smoke: async () => undefined };
  try {
    await writeFile(join(layout.root, "sequence"), "1099511627776"); // Legacy bare integer is epoch 0.
    await assert.rejects(runUpdateCommand([], runtime), /recovery history.*reinstall/);
    state.release = release("0.2.0", 1, { epoch: 1, signingKeys: [replacement], keyId: recovery.keyId, signWith: recoveryKey.privateKey });
    await runUpdateCommand([], runtime);
    assert.equal(await pointer(layout, "sequence"), "1:1");
    assert.equal(JSON.parse((await pointer(layout, "trusted-channel.json"))!).keys[0].keyId, replacement.keyId);
    assert.match((await pointer(layout, "sequence-anchor"))!, /^[0-9a-f]{64}$/);

    state.release = release("0.3.0", 2, { epoch: 1, keyId: replacement.keyId, signWith: replacementKey.privateKey });
    await runUpdateCommand([], runtime);
    assert.equal(await pointer(layout, "sequence"), "1:2");
    state.release = release("0.4.0", 3, { epoch: 1 });
    await assert.rejects(runUpdateCommand([], runtime), /signature does not verify/);
    state.release = release("0.4.0", 3, { epoch: 1, keyId: recovery.keyId, signWith: recoveryKey.privateKey });
    await assert.rejects(runUpdateCommand([], runtime), /recovery key cannot sign/);
    state.release = release("0.4.0", 1, { epoch: 1, keyId: replacement.keyId, signWith: replacementKey.privateKey });
    await assert.rejects(runUpdateCommand([], runtime), /already accepted/);
    state.release = release("0.4.0", 999, { epoch: 0, keyId: replacement.keyId, signWith: replacementKey.privateKey });
    await assert.rejects(runUpdateCommand([], runtime), /older.*epoch/);
    assert.equal(await pointer(layout, "current"), "0.3.0");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an offline client follows an expired opening to an ordinary release without changing state on --check", async () => {
  const { dir, layout } = await installedLayout();
  const recovery = trustedKeyFromPublicKey("recovery-key", recoveryKey.publicKey);
  const replacement = trustedKeyFromPublicKey("replacement-key", replacementKey.publicKey);
  const initial = { ...config, epoch: 0, recoveryKeys: [recovery] };
  const opening = release("0.2.0", 1, { epoch: 1, signingKeys: [replacement], keyId: recovery.keyId, signWith: recoveryKey.privateKey });
  const latest = release("0.3.0", 2, { epoch: 1, keyId: replacement.keyId, signWith: replacementKey.privateKey,
    createdAt: "2028-01-01T00:00:00Z", expiresAt: "2029-01-01T00:00:00Z" });
  const state = { release: latest, calls: [] as string[], openings: new Map([[1, opening]]) };
  const runtime = { layout, config: initial, fetch: fetchFrom(state), now: () => new Date("2028-02-01T00:00:00Z"), write: () => undefined, smoke: async () => undefined };
  try {
    state.release = release("0.3.0", 2, { epoch: 1, keyId: replacement.keyId, signWith: replacementKey.privateKey });
    await assert.rejects(runUpdateCommand([], runtime), /expired.*reinstall/);
    assert.equal(await pointer(layout, "trusted-channel.json"), undefined, "an expired current release cannot persist history");
    state.release = latest;
    await runUpdateCommand(["--check"], runtime);
    assert.equal(await pointer(layout, "sequence"), "1");
    assert.equal(await pointer(layout, "trusted-channel.json"), undefined);
    await runUpdateCommand([], runtime);
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "sequence")], ["0.3.0", "1:2"]);
    assert.equal(JSON.parse((await pointer(layout, "trusted-channel.json"))!).keys[0].keyId, replacement.keyId);
    assert.ok(state.calls.includes(`${origin}/release/stable/epoch-1.json`));
    assert.ok(state.calls.includes(`${origin}/release/stable/epoch-1.json.sig`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recovery history verifies successive epochs in order", async () => {
  const { dir, layout } = await installedLayout();
  const recovery = trustedKeyFromPublicKey("recovery-key", recoveryKey.publicKey);
  const replacement = trustedKeyFromPublicKey("replacement-key", replacementKey.publicKey);
  const later = trustedKeyFromPublicKey("later-key", otherKey.publicKey);
  const initial = { ...config, epoch: 0, recoveryKeys: [recovery] };
  const first = release("0.2.0", 1, { epoch: 1, signingKeys: [replacement], keyId: recovery.keyId, signWith: recoveryKey.privateKey });
  const second = release("0.3.0", 1, { epoch: 2, signingKeys: [later], keyId: recovery.keyId, signWith: recoveryKey.privateKey });
  const state = { release: release("0.4.0", 2, { epoch: 2, keyId: later.keyId, signWith: otherKey.privateKey }), calls: [] as string[], openings: new Map([[1, first], [2, second]]) };
  try {
    await runUpdateCommand([], { layout, config: initial, fetch: fetchFrom(state), now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined, smoke: async () => undefined });
    assert.deepEqual(state.calls.slice(2, 6), [1, 2].flatMap((epoch) => [`${origin}/release/stable/epoch-${epoch}.json`, `${origin}/release/stable/epoch-${epoch}.json.sig`]));
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "sequence")], ["0.4.0", "2:2"]);
    assert.equal(JSON.parse((await pointer(layout, "trusted-channel.json"))!).keys[0].keyId, later.keyId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recovery history permits the 16-epoch boundary", async () => {
  const { dir, layout } = await installedLayout();
  const recovery = trustedKeyFromPublicKey("recovery-key", recoveryKey.publicKey);
  const replacement = trustedKeyFromPublicKey("replacement-key", replacementKey.publicKey);
  const later = trustedKeyFromPublicKey("later-key", otherKey.publicKey);
  const initial = { ...config, epoch: 0, recoveryKeys: [recovery] };
  const openings = new Map<number, Release>();
  for (let epoch = 1; epoch <= 16; epoch += 1) {
    openings.set(epoch, release(`0.${epoch}.0`, 1, { epoch, signingKeys: [epoch % 2 ? replacement : later], keyId: recovery.keyId, signWith: recoveryKey.privateKey }));
  }
  const state = { release: release("0.17.0", 2, { epoch: 16, keyId: later.keyId, signWith: otherKey.privateKey }), calls: [] as string[], openings };
  try {
    await runUpdateCommand(["--check"], { layout, config: initial, fetch: fetchFrom(state), now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined });
    assert.equal(state.calls.length, 34);
    assert.equal(await pointer(layout, "trusted-channel.json"), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recovery history uses the manifest transport and size limits", async () => {
  const { dir, layout } = await installedLayout();
  const recovery = trustedKeyFromPublicKey("recovery-key", recoveryKey.publicKey);
  const replacement = trustedKeyFromPublicKey("replacement-key", replacementKey.publicKey);
  const initial = { ...config, epoch: 0, recoveryKeys: [recovery] };
  const opening = release("0.2.0", 1, { epoch: 1, signingKeys: [replacement], keyId: recovery.keyId, signWith: recoveryKey.privateKey });
  const state = { release: release("0.3.0", 2, { epoch: 1, keyId: replacement.keyId, signWith: replacementKey.privateKey }), calls: [] as string[], openings: new Map([[1, opening]]) };
  const baseFetch = fetchFrom(state);
  const history = `${origin}/release/stable/epoch-1.json`;
  try {
    for (const [url, size] of [[history, 64 * 1024 + 1], [`${history}.sig`, 4 * 1024 + 1]] as const) {
      const oversized = (async (input: string | URL | Request, options?: RequestInit) => String(input) === url
        ? new Response(new Uint8Array(size)) : baseFetch(input, options)) as typeof fetch;
      await assert.rejects(runUpdateCommand(["--check"], { layout, config: initial, fetch: oversized, now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined }), /larger than expected.*reinstall/);
    }
    const visited: string[] = [];
    const redirected = (async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      visited.push(url);
      return url === history ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:2/epoch-1.json" } }) : baseFetch(input, options);
    }) as typeof fetch;
    await assert.rejects(runUpdateCommand(["--check"], { layout, config: initial, fetch: redirected, now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined }), /unapproved transport.*reinstall/);
    assert.ok(!visited.includes("http://127.0.0.1:2/epoch-1.json"));
    assert.equal(await pointer(layout, "trusted-channel.json"), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("recovery history refuses forged, ordinary-signed and wrong-epoch openings", async () => {
  const { dir, layout } = await installedLayout();
  const recovery = trustedKeyFromPublicKey("recovery-key", recoveryKey.publicKey);
  const replacement = trustedKeyFromPublicKey("replacement-key", replacementKey.publicKey);
  const initial = { ...config, epoch: 0, recoveryKeys: [recovery] };
  const latest = release("0.3.0", 2, { epoch: 1, keyId: replacement.keyId, signWith: replacementKey.privateKey });
  const candidates = [
    release("0.2.0", 1, { epoch: 1, signingKeys: [replacement], keyId: recovery.keyId, signWith: otherKey.privateKey }),
    release("0.2.0", 1, { epoch: 1, signingKeys: [replacement] }),
    release("0.2.0", 1, { epoch: 2, signingKeys: [replacement], keyId: recovery.keyId, signWith: recoveryKey.privateKey }),
  ];
  try {
    for (const opening of candidates) {
      const state = { release: latest, calls: [] as string[], openings: new Map([[1, opening]]) };
      await assert.rejects(runUpdateCommand([], { layout, config: initial, fetch: fetchFrom(state), now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined }), /recovery history.*reinstall/);
      assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "sequence"), await pointer(layout, "trusted-channel.json")], ["0.1.0", "1", undefined]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a missing epoch or an excessive epoch gap fails closed without persisting partial trust", async () => {
  const { dir, layout } = await installedLayout();
  const recovery = trustedKeyFromPublicKey("recovery-key", recoveryKey.publicKey);
  const replacement = trustedKeyFromPublicKey("replacement-key", replacementKey.publicKey);
  const later = trustedKeyFromPublicKey("later-key", otherKey.publicKey);
  const initial = { ...config, epoch: 0, recoveryKeys: [recovery] };
  const opening = release("0.2.0", 1, { epoch: 1, signingKeys: [replacement], keyId: recovery.keyId, signWith: recoveryKey.privateKey });
  const latest = release("0.3.0", 2, { epoch: 2, keyId: later.keyId, signWith: otherKey.privateKey });
  const state = { release: latest, calls: [] as string[], openings: new Map([[1, opening]]) };
  const runtime = { layout, config: initial, fetch: fetchFrom(state), now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined };
  try {
    await assert.rejects(runUpdateCommand([], runtime), /recovery history.*reinstall/);
    assert.ok(state.calls.includes(`${origin}/release/stable/epoch-2.json`));
    assert.deepEqual([await pointer(layout, "current"), await pointer(layout, "sequence"), await pointer(layout, "trusted-channel.json")], ["0.1.0", "1", undefined]);
    state.calls.length = 0;
    state.release = release("0.3.0", 2, { epoch: 17, keyId: later.keyId, signWith: otherKey.privateKey });
    await assert.rejects(runUpdateCommand([], runtime), /too many epochs.*reinstall/);
    assert.equal(state.calls.length, 2, "the bounded gap is rejected before fetching history");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a pre-existing staging directory is never removed after exclusive creation fails", async () => {
  const { dir, layout } = await installedLayout();
  const originalNow = Date.now;
  Date.now = () => 123456789;
  try {
    const staging = join(layout.versionsDirectory, `.staging-0.2.0-${process.pid}-123456789`);
    await mkdir(staging);
    await writeFile(join(staging, "user-file"), "keep");
    const state = { release: release("0.2.0", 2), calls: [] as string[] };
    await assert.rejects(runUpdateCommand([], { layout, config, fetch: fetchFrom(state), now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined, smoke: async () => undefined }), /EEXIST/);
    assert.equal(await readFile(join(staging, "user-file"), "utf8"), "keep");
    assert.equal(await pointer(layout, "current"), "0.1.0");
    await utimes(staging, new Date(0), new Date(0));
    state.release = release("0.3.0", 3);
    await runUpdateCommand([], { layout, config, fetch: fetchFrom(state), now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined, smoke: async () => undefined });
    assert.equal(await readFile(join(staging, "user-file"), "utf8"), "keep", "old staging names are not swept after another update");
  } finally { Date.now = originalNow; await rm(dir, { recursive: true, force: true }); }
});

test("failed update leaves a staging path that was replaced after creation untouched", async () => {
  const { dir, layout } = await installedLayout();
  let replaced = "";
  try {
    const state = { release: release("0.2.0", 2), calls: [] as string[] };
    await assert.rejects(runUpdateCommand([], {
      layout, config, fetch: fetchFrom(state), now: () => new Date("2026-11-01T00:00:00Z"), write: () => undefined,
      smoke: async (extracted) => {
        replaced = dirname(extracted);
        await rename(replaced, `${replaced}-moved`);
        await mkdir(replaced);
        await writeFile(join(replaced, "user-file"), "keep");
        throw new Error("staging was replaced");
      },
    }), /staging was replaced/);
    assert.equal(await readFile(join(replaced, "user-file"), "utf8"), "keep");
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

test("install lock never reclaims ownerless, stale, or replaced locks", async () => {
  const { dir, layout } = await installedLayout();
  const lock = join(layout.root, "install.lock");
  try {
    for (const owner of [undefined, "not-a-pid", "99999999"]) {
      await mkdir(lock);
      if (owner !== undefined) await writeFile(join(lock, "pid"), owner);
      const old = new Date(Date.now() - 120_000);
      await utimes(lock, old, old);
      await assert.rejects(acquireInstallLock(layout.root), /install_busy/);
      assert.equal(existsSync(lock), true);
      if (owner !== undefined) assert.equal(await readFile(join(lock, "pid"), "utf8"), owner);
      await rm(lock, { recursive: true });
    }
    const release = await acquireInstallLock(layout.root);
    await rm(lock, { recursive: true });
    await mkdir(lock);
    await writeFile(join(lock, "replacement-owner"), "replacement");
    await assert.rejects(release(), /install_lock_unverified/);
    assert.equal(await readFile(join(lock, "replacement-owner"), "utf8"), "replacement");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("uninstall removes program files and the profile PATH block, and keeps state unless asked", async () => {
  for (const removeState of [false, true]) {
    const { dir, layout } = await installedLayout();
    try {
      const home = join(dir, "home");
      await mkdir(join(home, ".local", "share", "aiboard", "projects"), { recursive: true });
      await writeFile(join(home, ".profile"), `alias ll='ls -l'\n${profileBlock}export EDITOR=vi\n`);
      const runtime = { layout, platform: "linux" as const, home, environment: {}, write: () => undefined, interactive: false };
      await assert.rejects(runUninstallCommand([], runtime), /uninstall_confirmation_required/);
      await runUninstallCommand(["--yes", ...(removeState ? ["--remove-state"] : [])], runtime);
      for (const name of ["bin", "versions", "current", "sequence", "install.json"]) assert.ok(!existsSync(join(layout.root, name)), name);
      assert.equal(await readFile(join(home, ".profile"), "utf8"), "alias ll='ls -l'\nexport EDITOR=vi\n");
      assert.equal(existsSync(join(home, ".local", "share", "aiboard")), !removeState);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("uninstall leaves a symlinked profile and its target untouched", { skip: process.platform === "win32" }, async () => {
  const { dir, layout } = await installedLayout();
  try {
    const home = join(dir, "home");
    const target = join(dir, "outside-profile");
    await mkdir(home);
    await writeFile(target, profileBlock);
    await symlink(target, join(home, ".profile"));
    await runUninstallCommand(["--yes"], { layout, platform: "linux", home, environment: {}, write: () => undefined, interactive: false });
    assert.ok((await lstat(join(home, ".profile"))).isSymbolicLink());
    assert.equal(await readFile(target, "utf8"), profileBlock);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("uninstall leaves profiles without the exact installer block untouched", async () => {
  const { dir, layout } = await installedLayout();
  try {
    const home = join(dir, "home");
    await mkdir(home);
    const path = join(home, ".profile");
    const content = "export EDITOR=vi\n";
    const modified = "# >>> aiboard installer >>>\nuser customizations\n# <<< aiboard installer <<<\n";
    const invalidUtf8 = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(profileBlock)]);
    const bomPrefix = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(path, content);
    await writeFile(join(home, ".bashrc"), modified);
    await writeFile(join(home, ".zshrc"), invalidUtf8);
    await writeFile(join(home, ".bash_profile"), Buffer.concat([bomPrefix, Buffer.from(`user config\n${profileBlock}`)]));
    const before = await lstat(path);
    await runUninstallCommand(["--yes"], { layout, platform: "linux", home, environment: {}, write: () => undefined, interactive: false });
    const after = await lstat(path);
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal(await readFile(join(home, ".bashrc"), "utf8"), modified);
    assert.deepEqual(await readFile(join(home, ".zshrc")), invalidUtf8);
    assert.deepEqual(await readFile(join(home, ".bash_profile")), Buffer.concat([bomPrefix, Buffer.from("user config\n")]));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("uninstall keeps a modified fish file and reports it, but removes the exact installer template", async () => {
  for (const modified of [true, false]) {
    const { dir, layout } = await installedLayout();
    try {
      const home = join(dir, "home");
      const parent = join(home, ".config", "fish", "conf.d");
      const fish = join(parent, "aiboard.fish");
      await mkdir(parent, { recursive: true });
      const content = modified ? `${fishConfig}# user customization\n` : fishConfig;
      await writeFile(fish, content);
      const messages: string[] = [];
      await runUninstallCommand(["--yes"], { layout, platform: "linux", home, environment: {}, write: (message) => { messages.push(message); }, interactive: false });
      if (modified) {
        assert.equal(await readFile(fish, "utf8"), content);
        assert.match(messages.join(""), /Kept .*aiboard\.fish/);
      } else assert.equal(existsSync(fish), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("uninstall does not remove a fish file through a parent link outside the home", { skip: process.platform === "win32" }, async () => {
  const { dir, layout } = await installedLayout();
  try {
    const home = join(dir, "home");
    const outside = join(dir, "outside-fish");
    await mkdir(join(home, ".config"), { recursive: true });
    await mkdir(join(outside, "conf.d"), { recursive: true });
    await writeFile(join(outside, "conf.d", "aiboard.fish"), fishConfig);
    await symlink(outside, join(home, ".config", "fish"));
    const messages: string[] = [];
    await runUninstallCommand(["--yes"], { layout, platform: "linux", home, environment: {}, write: (message) => { messages.push(message); }, interactive: false });
    assert.equal(await readFile(join(outside, "conf.d", "aiboard.fish"), "utf8"), fishConfig);
    assert.match(messages.join(""), /Kept .*aiboard\.fish/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function windowsUninstall(removeState: boolean, rootName = "AIBoard") {
  const { dir, layout: base } = await installedLayout();
  const root = join(dir, rootName);
  if (root !== base.root) await rename(base.root, root);
  const layout = { ...base, root, binDirectory: join(root, "bin"), versionsDirectory: join(root, "versions") };
  const home = join(dir, "home");
  await mkdir(join(home, ".aiboard", "runner-extensions"), { recursive: true });
  await mkdir(join(root, "projects"), { recursive: true });
  const messages: string[] = [];
  await runUninstallCommand(["--yes", removeState ? "--remove-state" : "--keep-state"], {
    layout, platform: "win32", home, environment: {}, write: (message) => { messages.push(message); }, interactive: false,
    editUserPath: async () => undefined, shimRoot: root,
  });
  return { dir, layout, home, messages, script: await readFile(join(root, "uninstall-pending.cmd"), "utf8") };
}

test("Windows uninstall hands its install lock to the deferred cleanup instead of releasing it early", async () => {
  for (const removeState of [false, true]) {
    const { dir, layout, home, script } = await windowsUninstall(removeState);
    try {
      // Until the shim has run the cleanup, a new install, update, or uninstall must find the lock held.
      await assert.rejects(acquireInstallLock(layout.root), /install_busy/);
      const owners = (await readdir(join(layout.root, "install.lock"))).filter((name) => name.startsWith("owner-"));
      assert.equal(owners.length, 1);
      // ASCII-only and relative to the script's own folder: no absolute path is serialized through a code page.
      assert.match(script, /^[\x20-\x7e\r\n]*$/);
      assert.ok(!script.includes(layout.root) && !script.includes(dir), script);
      const destructive = script.split("\r\n").filter((line) => /\b(rd|del)\b/.test(line));
      assert.ok(destructive.length >= 3);
      for (const line of destructive) assert.ok(line.includes(`if exist "%~dp0install.lock\\${owners[0]}"`), line);
      assert.equal(existsSync(join(home, ".aiboard", "runner-extensions")), !removeState, "remove-state includes the default extensions directory");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  assert.throws(() => windowsCleanupScript({ ownerName: "owner-x", relativePaths: ["..\\outside"], removeRoot: false }), /uninstall_cleanup_invalid/);
  assert.throws(() => windowsCleanupScript({ ownerName: "owner-x", relativePaths: ["C:\\abs"], removeRoot: false }), /uninstall_cleanup_invalid/);
  assert.throws(() => windowsCleanupScript({ ownerName: "owner-x", relativePaths: ["vers\u00efons"], removeRoot: false }), /uninstall_cleanup_invalid/);
});

const runCleanup = (path: string) => spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${path}""`], { windowsVerbatimArguments: true, encoding: "utf8" });

test("Windows deferred cleanup removes its own files, releases the lock, and handles a Unicode root", { skip: process.platform !== "win32" }, async () => {
  for (const removeState of [false, true]) {
    const { dir, layout } = await windowsUninstall(removeState, "AI B\u00f6ard & ^ ! \u2713");
    try {
      assert.equal(runCleanup(join(layout.root, "uninstall-pending.cmd")).status, 0);
      if (removeState) assert.equal(existsSync(layout.root), false);
      else {
        for (const name of ["bin", "versions", "install.lock", "uninstall-pending.cmd"]) assert.equal(existsSync(join(layout.root, name)), false, name);
        assert.equal(existsSync(join(layout.root, "projects")), true);
      }
      // The lock is free again for the next install.
      if (!removeState) await (await acquireInstallLock(layout.root))();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("Windows deferred cleanup never touches a newer install that replaced its lock", { skip: process.platform !== "win32" }, async () => {
  for (const removeState of [false, true]) {
    const { dir, layout } = await windowsUninstall(removeState);
    try {
      // The owner confirmed nothing is running and removed the lock; a newer install then took it and wrote its files.
      await rm(join(layout.root, "install.lock"), { recursive: true });
      const newer = await acquireInstallLock(layout.root);
      await mkdir(join(layout.root, "versions", "0.1.0", "node"), { recursive: true });
      await writeFile(join(layout.root, "versions", "0.1.0", "node", "node.exe"), "newer install");
      await writeFile(join(layout.root, "bin", "aiboard.cmd"), "newer shim");
      await writeFile(join(layout.root, "current"), "0.1.0");
      assert.equal(runCleanup(join(layout.root, "uninstall-pending.cmd")).status, 0);
      assert.equal(await readFile(join(layout.root, "versions", "0.1.0", "node", "node.exe"), "utf8"), "newer install");
      assert.equal(await readFile(join(layout.root, "bin", "aiboard.cmd"), "utf8"), "newer shim");
      assert.equal(await pointer(layout, "current"), "0.1.0");
      await newer();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("profile and Windows PATH edits only touch the installer's own entries", () => {
  assert.equal(stripProfileBlock(`a\n${profileBlock}b\n`), "a\nb\n");
  assert.equal(stripProfileBlock("a\n# >>> aiboard installer >>>\nx\n# <<< aiboard installer <<<\nb\n"), "a\n# >>> aiboard installer >>>\nx\n# <<< aiboard installer <<<\nb\n");
  assert.equal(stripProfileBlock("a\n# >>> aiboard installer >>>\nunterminated\n"), "a\n# >>> aiboard installer >>>\nunterminated\n");
  const script = windowsRemovePathScript("C:\\Users\\o'brien\\AppData\\Local\\AIBoard\\bin");
  assert.match(script, /\$bin = 'C:\\Users\\o''brien\\AppData\\Local\\AIBoard\\bin'/);
  assert.match(script, /DoNotExpandEnvironmentNames/);
  assert.match(script, /GetValueKind\('Path'\)/);
});

test("Windows PATH removal preserves other entries, empty entries, and registry value kind", { skip: process.platform !== "win32" }, () => {
  const bin = "C:\\AIBoard\\bin";
  for (const scenario of [
    { before: `C:\\Tools;;C:\\Other;;${bin}`, expected: "C:\\Tools;;C:\\Other;", kind: "ExpandString", absent: false },
    { before: `C:\\Tools;${bin};C:\\Other`, expected: "C:\\Tools;C:\\Other", kind: "String", absent: false },
    { before: bin, expected: "", kind: "ExpandString", absent: false },
    { before: bin, expected: null, kind: "ExpandString", absent: true },
  ]) {
    const keyPath = `Software\\AIBoardPathTest-${randomUUID()}`;
    const edit = windowsRemovePathScript(bin, scenario.absent)
      .replace("OpenSubKey('Environment', $true)", `OpenSubKey('${keyPath}', $true)`)
      .replaceAll("  [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', '1', 'User')", "")
      .replaceAll("  [Environment]::SetEnvironmentVariable('AIBOARD_PATH_REFRESH', $null, 'User')", "");
    const script = [
      `$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${keyPath}')`,
      `$k.SetValue('Path', '${scenario.before}', [Microsoft.Win32.RegistryValueKind]::${scenario.kind}); $k.Close()`,
      "try {",
      edit,
      `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${keyPath}')`,
      "$exists = $k.GetValueNames() -contains 'Path'",
      "$value = if ($exists) { [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }",
      "$kind = if ($exists) { [string]$k.GetValueKind('Path') } else { $null }; $k.Close()",
      "[Console]::Out.Write((ConvertTo-Json -Compress @{ value = $value; kind = $kind }))",
      `} finally { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey('${keyPath}', $false) }`,
    ].join("\n");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), { value: scenario.expected, kind: scenario.expected === null ? null : scenario.kind });
  }
});
