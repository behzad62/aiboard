import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  INSTALLER_PROTOCOL, parseReleaseChannelConfig, PREVIEW_TARGETS, RELEASE_PRODUCT, RELEASE_TARGETS, serializeManifest, signManifestBytes,
  targetFormat, trustedKeyFromPublicKey, verifyReleaseManifest, type ReleaseChannelConfig, type ReleaseManifest,
} from "../src/release-manifest.js";

const keyA = generateKeyPairSync("rsa", { modulusLength: 3072 });
const keyB = generateKeyPairSync("rsa", { modulusLength: 3072 });
const trustedA = trustedKeyFromPublicKey("release-a", keyA.publicKey);
const trustedB = trustedKeyFromPublicKey("release-b", keyB.publicKey);
const now = new Date("2026-10-30T12:00:00Z");
const config: ReleaseChannelConfig = {
  channel: "stable", manifestUrl: "https://aiboard.me/release/stable/manifest.json",
  artifactPrefix: "https://github.com/behzad62/aiboard/releases/download/", keys: [trustedA], minSequence: 3,
};

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schemaVersion: 1, product: RELEASE_PRODUCT, channel: "stable", version: "0.2.0", sequence: 5,
    createdAt: "2026-10-29T00:00:00Z", expiresAt: "2027-04-27T00:00:00Z", minInstallerVersion: INSTALLER_PROTOCOL,
    keyId: "release-a", nodeVersion: "24.18.0",
    artifacts: RELEASE_TARGETS.map((target) => ({
      target, format: targetFormat(target), preview: PREVIEW_TARGETS.has(target), bytes: 1000,
      sha256: "a".repeat(64), url: `https://github.com/behzad62/aiboard/releases/download/v0.2.0/aiboard-0.2.0-${target}.${targetFormat(target)}`,
    })),
    ...overrides,
  };
}

function signed(value: ReleaseManifest | string, key = keyA.privateKey): { bytes: Buffer; signature: string } {
  const bytes = Buffer.from(typeof value === "string" ? value : serializeManifest(value), "utf8");
  return { bytes, signature: signManifestBytes(bytes, key) };
}

function rejects(value: ReleaseManifest | string, pattern: RegExp, options: { key?: typeof keyA.privateKey; config?: ReleaseChannelConfig; hwm?: number } = {}): void {
  const { bytes, signature } = signed(value, options.key);
  assert.throws(() => verifyReleaseManifest(bytes, signature, options.config ?? config, { now, ...(options.hwm ? { highWaterSequence: options.hwm } : {}) }), pattern);
}

test("a canonical manifest signed by a pinned key verifies and round-trips", () => {
  const { bytes, signature } = signed(manifest());
  const result = verifyReleaseManifest(bytes, signature, config, { now, highWaterSequence: 5 });
  assert.equal(result.version, "0.2.0");
  assert.equal(result.artifacts.length, 6);
  assert.equal(result.artifacts.find((artifact) => artifact.target === "win-arm64")?.preview, true);
  // One artifact per line: install.sh greps these lines.
  assert.match(bytes.toString("utf8"), /^\{"target":"linux-x64","format":"tar\.gz","preview":false,"bytes":1000,"sha256":"a{64}","url":"https:[^"]+"\},?$/m);
});

test("signature failures refuse before parsing: tampered byte, wrong key, garbage signature, no pinned key", () => {
  const { bytes, signature } = signed(manifest());
  const tampered = Buffer.from(bytes);
  tampered[tampered.indexOf("5")]! = "6".charCodeAt(0);
  assert.throws(() => verifyReleaseManifest(tampered, signature, config, { now }), /signature does not verify/);
  rejects(manifest(), /signature does not verify/, { key: keyB.privateKey });
  assert.throws(() => verifyReleaseManifest(bytes, "not base64!", config, { now }), /not base64/);
  assert.throws(() => verifyReleaseManifest(bytes, signature, { ...config, keys: [] }, { now }), /no trusted release key/);
  // Non-JSON bytes are only reached after a valid signature, and still refused.
  rejects("not json", /not JSON/);
});

test("a signer must match the manifest's own keyId even when both keys are trusted", () => {
  rejects(manifest({ keyId: "release-b" }), /different key/, { config: { ...config, keys: [trustedA, trustedB] } });
  const { bytes, signature } = signed(manifest({ keyId: "release-b" }), keyB.privateKey);
  assert.equal(verifyReleaseManifest(bytes, signature, { ...config, keys: [trustedA, trustedB] }, { now }).keyId, "release-b");
});

test("non-canonical bytes, unknown fields and malformed artifacts are refused", () => {
  rejects(serializeManifest(manifest()).replace('"sequence":5,', '"sequence": 5,'), /canonical/);
  rejects(serializeManifest(manifest()).replace('"sequence":5,', '"sequence":5,\n"sequence":6,'), /canonical|unexpected/);
  rejects(serializeManifest(manifest()).replace('"keyId":', '"extra":1,\n"keyId":'), /unexpected or missing/);
  const artifacts = manifest().artifacts;
  rejects(manifest({ artifacts: artifacts.slice(1) }), /exactly 6 artifacts/);
  rejects(manifest({ artifacts: [...artifacts.slice(1), { ...artifacts[1]! }] }), /unknown or repeated/);
  rejects(manifest({ artifacts: artifacts.map((artifact) => artifact.target === "win-arm64" ? { ...artifact, preview: false } : artifact) }), /preview flag/);
  rejects(manifest({ artifacts: artifacts.map((artifact) => artifact.target === "win-x64" ? { ...artifact, format: "tar.gz" } : artifact) }), /wrong format/);
  rejects(manifest({ artifacts: artifacts.map((artifact) => ({ ...artifact, sha256: "A".repeat(64) })) }), /sha256/);
  rejects(manifest({ version: "v0.2.0" }), /version is invalid/);
});

test("expiry, creation time, replay floor and high-water mark are enforced", () => {
  rejects(manifest({ expiresAt: "2026-10-30T11:59:59Z" }), /expired/);
  rejects(manifest({ createdAt: "2026-11-02T00:00:00Z" }), /future/);
  rejects(manifest({ sequence: 2 }), /older than this installer's minimum/);
  rejects(manifest({ sequence: 4 }), /already accepted/, { hwm: 5 });
  rejects(manifest({ minInstallerVersion: INSTALLER_PROTOCOL + 1 }), /newer installer/);
  rejects(manifest({ channel: "beta" }), /channel beta/);
  rejects(manifest({ product: "other" }), /another product/);
});

test("artifact URLs must stay on the approved origin and use HTTPS", () => {
  const artifacts = manifest().artifacts;
  rejects(manifest({ artifacts: artifacts.map((artifact) => ({ ...artifact, url: artifact.url.replace("behzad62/aiboard", "attacker/aiboard") })) }), /approved release origin/);
  const loopback = { ...config, artifactPrefix: "http://example.com/" };
  rejects(manifest({ artifacts: artifacts.map((artifact) => ({ ...artifact, url: `http://example.com/${artifact.target}` })) }), /HTTPS/, { config: loopback });
});

test("channel configs refuse plain-HTTP origins, weak keys and duplicates", () => {
  const raw = { channel: "stable", manifestUrl: config.manifestUrl, artifactPrefix: config.artifactPrefix, keys: [trustedA], minSequence: 1 };
  assert.equal(parseReleaseChannelConfig(raw).keys[0]!.keyId, "release-a");
  assert.throws(() => parseReleaseChannelConfig({ ...raw, manifestUrl: "http://aiboard.me/m.json" }), /https/);
  assert.equal(parseReleaseChannelConfig({ ...raw, manifestUrl: "http://127.0.0.1:8765/m.json", artifactPrefix: "http://127.0.0.1:8765/d/" }).channel, "stable");
  assert.throws(() => parseReleaseChannelConfig({ ...raw, keys: [trustedA, { ...trustedA }] }), /duplicate/);
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => trustedKeyFromPublicKey("weak-key", weak.publicKey), /RSA-3072/);
  const weakJwk = weak.publicKey.export({ format: "jwk" });
  assert.throws(() => parseReleaseChannelConfig({ ...raw, keys: [{ keyId: "weak-key", n: weakJwk.n, e: weakJwk.e }] }), /RSA-3072/);
});
