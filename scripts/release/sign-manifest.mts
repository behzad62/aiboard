// Creates and signs the release manifest for six built bundles (plan D18, ADR-E).
// Runs in the manual-dispatch release workflow inside the protected `release` environment:
//   AIBOARD_RELEASE_SIGNING_KEY=<PKCS#8 PEM> npx tsx scripts/release/sign-manifest.mts \
//     --bundles dist/release --version 0.2.0 --out dist/release
// The private key is read from the environment (or --key-file for offline/test use), never printed,
// and must match a public key already pinned in the channel config. The result is self-verified
// with the same verifier the updater uses before anything is written.
// With --reserve-remote <remote> (the release workflow passes origin) the sequence is reserved durably
// on that remote before signing (sequence-reservation.mts) and --require-commit must be the tip of
// --reserve-branch (default main).
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALLER_PROTOCOL, isReleaseVersion, parseReleaseChannelConfig, RELEASE_PRODUCT, RELEASE_SCHEMA_VERSION, RELEASE_TARGETS,
  serializeManifest, signManifestBytes, trustedKeyFromPublicKey, verifyReleaseManifest, type ReleaseManifest,
} from "../../runner-v2/src/release-manifest.js";
import type { BuildReport } from "./build-bundle.mjs";
import { gitRunner, reserveReleaseSequence } from "./sequence-reservation.mjs";
import { selectReleaseSequence } from "./signing-sequence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return value;
}

function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

const version = option("version");
if (!isReleaseVersion(version)) throw new Error("--version must be a release version such as 0.2.0.");
const bundles = resolve(option("bundles") ?? join(root, "dist", "release"));
const out = resolve(option("out") ?? bundles);
const configPath = resolve(option("channel-config") ?? join(root, "release", "channel.json"));
const config = parseReleaseChannelConfig(JSON.parse(readFileSync(configPath, "utf8")));
const urlPrefix = option("url-prefix") ?? `${config.artifactPrefix}v${version}/`;
if (!urlPrefix.startsWith(config.artifactPrefix) || !urlPrefix.endsWith("/")) throw new Error("--url-prefix must extend the channel's artifactPrefix and end with /.");
const expiresDays = Number(option("expires-days") ?? "180");
if (!Number.isInteger(expiresDays) || expiresDays < 7 || expiresDays > 400) throw new Error("--expires-days must be 7-400.");

const sequenceOption = option("sequence") ?? "auto";
// The prior manifest must be authenticated even if an explicit sequence is used.
const published = join(root, "public", "release", config.channel, "manifest.json");
const hasManifest = existsSync(published);
const hasSignature = existsSync(`${published}.sig`);
if (hasManifest !== hasSignature) throw new Error(`The previous manifest or signature is missing at ${published}; refusing to sign.`);
const previous = hasManifest ? { bytes: readFileSync(published), signature: readFileSync(`${published}.sig`, "utf8") } : undefined;
// Optional repository-reviewed previous trust configuration is only a history witness;
// it is never included in installers or the new release's bundled trust anchors.
const historicalPath = join(root, "release", "previous-channel.json");
const historicalConfig = existsSync(historicalPath) ? parseReleaseChannelConfig(JSON.parse(readFileSync(historicalPath, "utf8"))) : undefined;
const selectSequence = (reservedFloor: number) => {
  try { return selectReleaseSequence(sequenceOption, config, previous, new Date(), historicalConfig, reservedFloor); }
  catch (error) { throw new Error(`Cannot select a release sequence (${error instanceof Error ? error.message : String(error)}). An expired prior manifest requires an explicit higher --sequence.`); }
};
// Dry selection first so bad input fails before anything is reserved; the reserved run repeats it against the reservations.
selectSequence(0);

const keyPem = option("key-file") ? readFileSync(resolve(option("key-file")!), "utf8") : process.env.AIBOARD_RELEASE_SIGNING_KEY;
if (!keyPem) throw new Error("No signing key: set AIBOARD_RELEASE_SIGNING_KEY (release environment secret) or pass --key-file.");
const privateKey = createPrivateKey(keyPem);
const publicJwk = trustedKeyFromPublicKey("derived-key", createPublicKey(keyPem));
const pinned = config.keys.find((key) => key.n === publicJwk.n && key.e === publicJwk.e);
if (!pinned) throw new Error(`The signing key's public half is not pinned in ${configPath}; refusing to sign a manifest no installer would trust.`);

const requireCommit = option("require-commit");
const reports = readdirSync(bundles).filter((name) => name.startsWith(`aiboard-${version}-`) && name.endsWith(".build.json"))
  .map((name) => JSON.parse(readFileSync(join(bundles, name), "utf8")) as BuildReport);
const nodeVersions = new Set(reports.map((report) => report.nodeVersion));
if (reports.length !== RELEASE_TARGETS.length || nodeVersions.size !== 1) throw new Error(`Expected ${RELEASE_TARGETS.length} bundle reports for ${version} with one Node version; found ${reports.length}.`);
for (const report of reports) {
  const archive = readFileSync(join(bundles, report.file));
  if (archive.length !== report.bytes || createHash("sha256").update(archive).digest("hex") !== report.sha256) throw new Error(`${report.file} does not match its build report.`);
  if (report.dirty) process.stderr.write(`warning: ${report.file} was built from a dirty working tree\n`);
  // The release workflow passes the dispatched commit: every bundle must come from exactly that clean tree.
  if (requireCommit && (report.dirty || report.commit !== requireCommit)) throw new Error(`${report.file} was not built from a clean checkout of ${requireCommit}.`);
}

const reserveRemote = option("reserve-remote");
let sequence: number;
if (reserveRemote) {
  if (!requireCommit) throw new Error("--reserve-remote needs --require-commit (the dispatched commit).");
  sequence = reserveReleaseSequence({
    git: gitRunner(root), remote: reserveRemote, branch: option("reserve-branch") ?? "main", channel: config.channel, commit: requireCommit,
    choose: selectSequence, runLabel: process.env.GITHUB_RUN_ID ? `run ${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT ?? "1"}` : undefined,
  });
  process.stdout.write(`Reserved ${config.channel} release sequence ${sequence} on ${reserveRemote}.
`);
} else sequence = selectSequence(0);

const now = new Date();
const manifest: ReleaseManifest = {
  schemaVersion: RELEASE_SCHEMA_VERSION,
  product: RELEASE_PRODUCT,
  channel: config.channel,
  version,
  sequence,
  createdAt: isoSeconds(now),
  expiresAt: isoSeconds(new Date(now.getTime() + expiresDays * 24 * 60 * 60 * 1000)),
  minInstallerVersion: INSTALLER_PROTOCOL,
  keyId: pinned.keyId,
  nodeVersion: [...nodeVersions][0]!,
  artifacts: reports.map((report) => ({
    target: report.target, format: report.format, preview: report.preview, bytes: report.bytes, sha256: report.sha256,
    url: `${urlPrefix}${report.file}`,
  })),
};
const bytes = Buffer.from(serializeManifest(manifest), "utf8");
const signature = signManifestBytes(bytes, privateKey);
verifyReleaseManifest(bytes, signature, config, { now });
writeFileSync(join(out, "manifest.json"), bytes);
writeFileSync(join(out, "manifest.json.sig"), `${signature}\n`);
process.stdout.write(`Signed manifest ${version} sequence ${sequence} with ${pinned.keyId}, expires ${manifest.expiresAt}.\n`);
