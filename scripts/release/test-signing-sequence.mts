import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  INSTALLER_PROTOCOL, PREVIEW_TARGETS, RELEASE_PRODUCT, RELEASE_TARGETS, serializeManifest,
  signManifestBytes, targetFormat, trustedKeyFromPublicKey, verifyReleaseManifest, type ReleaseManifest,
} from "../../runner-v2/src/release-manifest.js";
import { selectReleaseSequence } from "./signing-sequence.mjs";

const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
const wrong = generateKeyPairSync("rsa", { modulusLength: 3072 });
const config = {
  channel: "stable", manifestUrl: "https://aiboard.me/release/stable/manifest.json",
  artifactPrefix: "https://github.com/behzad62/aiboard/releases/download/",
  keys: [trustedKeyFromPublicKey("release-test", key.publicKey)], minSequence: 1,
};
const now = new Date("2026-10-30T12:00:00Z");
function signed(overrides: Partial<ReleaseManifest> = {}, signer = key.privateKey) {
  const manifest: ReleaseManifest = {
    schemaVersion: 1, product: RELEASE_PRODUCT, channel: "stable", version: "0.1.0", sequence: 7,
    createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z",
    minInstallerVersion: INSTALLER_PROTOCOL, keyId: "release-test", nodeVersion: "24.18.0",
    artifacts: RELEASE_TARGETS.map((target) => ({
      target, format: targetFormat(target), preview: PREVIEW_TARGETS.has(target), bytes: 1,
      sha256: "a".repeat(64), url: `${config.artifactPrefix}v0.1.0/${target}`,
    })),
    ...overrides,
  };
  const bytes = Buffer.from(serializeManifest(manifest));
  return { bytes, signature: signManifestBytes(bytes, signer) };
}

assert.equal(selectReleaseSequence("auto", config, undefined, now), 1);
assert.equal(selectReleaseSequence("3", config, undefined, now), 3);
const previous = signed();
assert.equal(selectReleaseSequence("auto", config, previous, now), 8);
assert.equal(selectReleaseSequence("8", config, previous, now), 8);
for (const sequence of ["1", "6", "7"]) assert.throws(() => selectReleaseSequence(sequence, config, previous, now), /higher than.*7/);
for (const sequence of ["0", "1e2", "NaN", "1099511627777"]) assert.throws(() => selectReleaseSequence(sequence, config, previous, now));
assert.throws(() => selectReleaseSequence("8", config, signed({}, wrong.privateKey), now), /signature does not verify/);
const tampered = { bytes: Buffer.from(previous.bytes.toString().replace('"sequence":7,', '"sequence":2,')), signature: previous.signature };
assert.throws(() => selectReleaseSequence("8", config, tampered, now), /signature does not verify/);
const expired = signed({ expiresAt: "2026-10-20T00:00:00Z" });
assert.throws(() => selectReleaseSequence("auto", config, expired, now), /expired/);
assert.throws(() => selectReleaseSequence("7", config, expired, now), /higher than.*7/);
assert.equal(selectReleaseSequence("8", config, expired, now), 8);
assert.throws(() => verifyReleaseManifest(expired.bytes, expired.signature, config, { now }), /expired/);
assert.throws(() => selectReleaseSequence("8", config, signed({ createdAt: "2026-11-10T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z" }), now), /future/);
const replacement = generateKeyPairSync("rsa", { modulusLength: 3072 });
const replacementConfig = { ...config, keys: [trustedKeyFromPublicKey("release-new", replacement.publicKey)], minSequence: 9,
  artifactPrefix: "https://github.com/behzad62/aiboard-new/releases/download/" };
assert.throws(() => selectReleaseSequence("10", replacementConfig, previous, now), /signature does not verify/);
assert.equal(selectReleaseSequence("10", replacementConfig, previous, now, config), 10);
assert.equal(selectReleaseSequence("auto", replacementConfig, previous, now, config), 9);
assert.throws(() => selectReleaseSequence("7", replacementConfig, previous, now, config), /--sequence/);
assert.throws(() => selectReleaseSequence("10", replacementConfig, signed({}, wrong.privateKey), now, config), /signature does not verify/);
assert.throws(() => selectReleaseSequence("10", replacementConfig, previous, now, { ...config, channel: "beta" }), /historical channel/);
console.log("PASS signed release sequences strictly increase, including after expiry");
