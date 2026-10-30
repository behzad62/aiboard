// Durable sequence reservation, current-policy (branch tip) check, and publication order, against a real
// local bare Git remote. Run: npx tsx scripts/release/test-sequence-reservation.mts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALLER_PROTOCOL, PREVIEW_TARGETS, RELEASE_PRODUCT, RELEASE_TARGETS, serializeManifest, signManifestBytes, targetFormat,
  trustedKeyFromPublicKey, type ReleaseManifest,
} from "../../runner-v2/src/release-manifest.js";
import { checkPublicationOrder } from "./check-publication-order.mjs";
import { gitRunner, listReservations, reserveReleaseSequence } from "./sequence-reservation.mjs";
import { assertPublicationOrder, selectReleaseSequence } from "./signing-sequence.mjs";

const key = generateKeyPairSync("rsa", { modulusLength: 3072 });
const config = {
  channel: "stable", manifestUrl: "https://aiboard.me/release/stable/manifest.json",
  artifactPrefix: "https://github.com/behzad62/aiboard/releases/download/",
  keys: [trustedKeyFromPublicKey("release-test", key.publicKey)], minSequence: 1,
};
const now = new Date();
function signed(sequence: number) {
  const manifest: ReleaseManifest = {
    schemaVersion: 1, product: RELEASE_PRODUCT, channel: "stable", version: `0.${sequence}.0`, sequence,
    createdAt: "2026-10-01T00:00:00Z", expiresAt: "2099-12-01T00:00:00Z",
    minInstallerVersion: INSTALLER_PROTOCOL, keyId: "release-test", nodeVersion: "24.18.0",
    artifacts: RELEASE_TARGETS.map((target) => ({
      target, format: targetFormat(target), preview: PREVIEW_TARGETS.has(target), bytes: 1,
      sha256: "a".repeat(64), url: `${config.artifactPrefix}v0.${sequence}.0/${target}`,
    })),
  };
  const bytes = Buffer.from(serializeManifest(manifest));
  return { manifest, bytes, signature: signManifestBytes(bytes, key.privateKey) };
}

const work = mkdtempSync(join(tmpdir(), "aiboard-seq-"));
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"];
const sh = (cwd: string, args: string[]) => execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
try {
  const remote = join(work, "remote.git");
  sh(work, ["init", "--bare", "-b", "main", remote]);
  const clone = (name: string) => { sh(work, ["clone", "-q", remote, name]); return join(work, name); };
  const signer = clone("signer");
  writeFileSync(join(signer, "README"), "one\n");
  sh(signer, ["add", "README"]);
  sh(signer, ["commit", "-qm", "one"]);
  sh(signer, ["push", "-q", "origin", "HEAD:main"]);
  const commit = sh(signer, ["rev-parse", "HEAD"]);
  const git = gitRunner(signer);
  const reserve = (choose = (floor: number) => selectReleaseSequence("auto", config, previous, now, undefined, floor), at = commit) =>
    reserveReleaseSequence({ git, remote: "origin", branch: "main", channel: "stable", commit: at, choose, runLabel: "test" });

  // Before: selection from the committed manifest alone gives two serialized drafts the same sequence.
  const previous = { bytes: signed(7).bytes, signature: signed(7).signature };
  assert.equal(selectReleaseSequence("auto", config, previous, now), 8);
  assert.equal(selectReleaseSequence("auto", config, previous, now), 8);
  // After: each signing run reserves durably on the remote, so the second draft gets a fresh sequence.
  assert.equal(reserve(), 8);
  assert.equal(reserve(), 9);
  assert.deepEqual([...listReservations(git, "origin", "stable").keys()].sort(), [8, 9]);
  assert.throws(() => selectReleaseSequence("9", config, previous, now, undefined, 9), /highest reserved sequence 9/);
  assert.equal(reserve(() => selectReleaseSequence("12", config, previous, now, undefined, 9)), 12);
  assert.throws(() => reserve(() => 12), /already reserved/);

  // A concurrent run that creates the same reservation between the listing and the push wins; this run fails closed.
  const rival = clone("rival");
  assert.throws(() => reserve((floor) => {
    sh(rival, ["tag", "-a", "-m", "rival", "release-sequence/stable/13", commit]);
    sh(rival, ["push", "-q", "origin", "refs/tags/release-sequence/stable/13"]);
    return floor + 1;
  }), /Could not reserve sequence 13/);
  assert.equal(execFileSync("git", ["tag", "-l"], { cwd: signer, encoding: "utf8" }).trim(), "", "the local scratch tag is removed");

  // A queued run whose commit is no longer the branch tip must not sign with obsolete policy.
  writeFileSync(join(rival, "README"), "two\n");
  sh(rival, ["commit", "-qam", "two"]);
  sh(rival, ["push", "-q", "origin", "HEAD:main"]);
  assert.throws(() => reserve(), /main moved to .* re-dispatch/);
  assert.equal(listReservations(git, "origin", "stable").has(14), false, "nothing is reserved for a stale commit");
  sh(signer, ["fetch", "-q", "origin", "main"]);
  assert.equal(reserve(undefined, sh(rival, ["rev-parse", "HEAD"])), 14);

  // A malformed reservation is not ignored: the floor cannot be established.
  sh(rival, ["tag", "release-sequence/stable/not-a-number", commit]);
  sh(rival, ["push", "-q", "origin", "refs/tags/release-sequence/stable/not-a-number"]);
  assert.throws(() => listReservations(git, "origin", "stable"), /Malformed reservation/);

  // Publication order: the owner's verify step and the deploy guard refuse to move the committed manifest backwards.
  assert.doesNotThrow(() => assertPublicationOrder(signed(10).manifest, signed(9).manifest));
  for (const older of [8, 9]) assert.throws(() => assertPublicationOrder(signed(older).manifest, signed(9).manifest), /not higher than the committed/);
  assert.doesNotThrow(() => assertPublicationOrder(signed(1).manifest, undefined));

  const site = clone("site");
  const published = join(site, "public", "release", "stable");
  mkdirSync(published, { recursive: true });
  writeFileSync(join(published, "manifest.json"), signed(9).bytes);
  writeFileSync(join(published, "manifest.json.sig"), `${signed(9).signature}\n`);
  sh(site, ["add", "public"]);
  sh(site, ["commit", "-qm", "publish 9"]);
  const deployed = sh(site, ["rev-parse", "HEAD"]);
  assert.deepEqual(checkPublicationOrder(site, deployed), ["public/release/stable/manifest.json: unchanged"]);
  writeFileSync(join(published, "manifest.json"), signed(8).bytes);
  assert.throws(() => checkPublicationOrder(site, deployed), /sequence 8 does not exceed the previously deployed 9/);
  writeFileSync(join(published, "manifest.json"), signed(10).bytes);
  assert.deepEqual(checkPublicationOrder(site, deployed), ["public/release/stable/manifest.json: 9 -> 10"]);
  rmSync(join(published, "manifest.json"));
  assert.throws(() => checkPublicationOrder(site, deployed), /was removed/);

  const releaseKeys = fileURLToPath(new URL("./release-keys.mts", import.meta.url));
  const tsx = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const configPath = join(work, "channel.json");
  writeFileSync(configPath, JSON.stringify(config));
  const committed = join(work, "committed.json");
  writeFileSync(committed, signed(9).bytes);
  writeFileSync(`${committed}.sig`, signed(9).signature);
  const verify = (sequence: number) => {
    const path = join(work, `candidate-${sequence}.json`);
    writeFileSync(path, signed(sequence).bytes);
    writeFileSync(`${path}.sig`, signed(sequence).signature);
    return spawnSync(process.execPath, [tsx, releaseKeys, "verify", "--manifest", path, "--config", configPath, "--committed", committed], { encoding: "utf8" });
  };
  assert.notEqual(verify(8).status, 0);
  assert.match(verify(8).stderr, /not higher than the committed manifest's 9/);
  assert.equal(verify(10).status, 0, verify(10).stderr);
  assert.match(verify(10).stdout, /replaces committed sequence 9/);

  // The workflows actually use the reservation and the deploy guard.
  const release = readFileSync(new URL("../../.github/workflows/runner-release.yml", import.meta.url), "utf8");
  assert.match(release, /--require-commit "\$GITHUB_SHA"\s+--reserve-remote origin --reserve-branch main/);
  const deploy = readFileSync(new URL("../../.github/workflows/deploy-aiboard.yml", import.meta.url), "utf8");
  const guard = deploy.indexOf("scripts/release/check-publication-order.mts --base");
  assert.ok(guard > 0 && guard < deploy.indexOf("npm run publish-downloads"), "deploy checks publication order before rendering installers");
  console.log("PASS release sequences are reserved durably, refused for stale commits, and published only in order");
} finally {
  rmSync(work, { recursive: true, force: true });
}
