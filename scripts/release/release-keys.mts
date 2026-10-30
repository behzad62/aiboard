// Release key helper (owner setup, docs/remote/l2-release-owner-setup.md). Only PUBLIC key material is written to the repo.
//   npx tsx scripts/release/release-keys.mts pin --key-id aiboard-release-2026a --public-key release-2026a.pub.pem
//       adds the public key to release/channel.json (the installers and updater trust anchor)
//   npx tsx scripts/release/release-keys.mts show --public-key release-2026a.pub.pem
//       prints the {keyId, n, e} entry without editing anything
//   npx tsx scripts/release/release-keys.mts generate-test --out <dir>
//       ephemeral TEST key pair + channel for local/CI installer tests (never for releases)
//   npx tsx scripts/release/release-keys.mts verify --manifest manifest.json [--sig manifest.json.sig] [--bundles dir]
//       checks a signed manifest exactly as the updater does (and, with --bundles, every archive's size + SHA-256)
//       before it is committed to public/release/<channel>/, and refuses one whose sequence is not higher than
//       the manifest already committed there (publication order)
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTALLER_PROTOCOL, parseReleaseChannelConfig, RELEASE_SCHEMA_VERSION, serializeManifest, signManifestBytes, trustedKeyFromPublicKey,
  verifyHistoricalReleaseManifest, verifyReleaseManifest, type ReleaseManifest,
} from "../../runner-v2/src/release-manifest.js";
import { assertPublicationOrder } from "./signing-sequence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [command] = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
  return value;
}

if (command === "pin" || command === "pin-recovery" || command === "show") {
  const pem = readFileSync(resolve(option("public-key") ?? ""), "utf8");
  if (/PRIVATE KEY/.test(pem)) throw new Error("This is a PRIVATE key. Pass the .pub.pem public half; the private key never enters the repository.");
  const entry = trustedKeyFromPublicKey(option("key-id") ?? "unnamed-key", createPublicKey(pem));
  if (command === "show") {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
  } else {
    const path = resolve(option("config") ?? join(root, "release", "channel.json"));
    const raw = JSON.parse(readFileSync(path, "utf8")) as { keys: unknown[]; recoveryKeys?: unknown[] };
    const config = parseReleaseChannelConfig(raw);
    if ([...config.keys, ...(config.recoveryKeys ?? [])].some((key) => key.keyId === entry.keyId || key.n === entry.n)) throw new Error(`${entry.keyId} (or the same key) is already pinned.`);
    if (command === "pin-recovery") raw.recoveryKeys = [...(raw.recoveryKeys ?? []), entry];
    else raw.keys = [...raw.keys, entry];
    parseReleaseChannelConfig(raw);
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
    process.stdout.write(`Pinned ${entry.keyId} in ${path}. Commit it, then rebuild the installers and bundles.\n`);
  }
} else if (command === "sign-epoch") {
  // The template supplies the known-good bundle descriptions. No private key is read from the environment.
  const config = parseReleaseChannelConfig(JSON.parse(readFileSync(resolve(option("config") ?? join(root, "release", "previous-channel.json")), "utf8")));
  const next = parseReleaseChannelConfig(JSON.parse(readFileSync(resolve(option("new-config") ?? join(root, "release", "channel.json")), "utf8")));
  if (next.channel !== config.channel || next.manifestUrl !== config.manifestUrl || next.artifactPrefix !== config.artifactPrefix || (next.epoch ?? 0) !== (config.epoch ?? 0) + 1 ||
      JSON.stringify(next.recoveryKeys ?? []) !== JSON.stringify(config.recoveryKeys ?? []) || !next.keys.length) throw new Error("The new configuration must advance exactly one epoch, retain the channel, manifest URL, artifact origin and recovery keys, and contain new signing keys.");
  if (next.keys.some((key) => config.keys.some((old) => old.n === key.n && old.e === key.e))) throw new Error("The new epoch must not retain a previous ordinary signing key.");
  const keyFile = option("key-file");
  if (!keyFile) throw new Error("sign-epoch requires the offline recovery --key-file.");
  const privateKey = createPrivateKey(readFileSync(resolve(keyFile)));
  const publicKey = trustedKeyFromPublicKey("derived-key", createPublicKey(privateKey));
  const signer = (config.recoveryKeys ?? []).find((key) => key.n === publicKey.n && key.e === publicKey.e);
  if (!signer) throw new Error("The supplied recovery key is not pinned in the previous channel configuration.");
  const template = JSON.parse(readFileSync(resolve(option("manifest") ?? ""), "utf8")) as ReleaseManifest;
  const manifest: ReleaseManifest = { ...template, schemaVersion: RELEASE_SCHEMA_VERSION, epoch: next.epoch, sequence: 1,
    signingKeys: next.keys, keyId: signer.keyId, minInstallerVersion: INSTALLER_PROTOCOL };
  const bytes = Buffer.from(serializeManifest(manifest));
  const signature = signManifestBytes(bytes, privateKey);
  verifyReleaseManifest(bytes, signature, config, { now: new Date() });
  const out = resolve(option("out") ?? ".");
  const history = join(out, `epoch-${next.epoch}.json`);
  writeFileSync(history, bytes, { flag: "wx" });
  try { writeFileSync(`${history}.sig`, `${signature}\n`, { flag: "wx" }); }
  catch (error) { unlinkSync(history); throw error; }
  writeFileSync(join(out, "manifest.json"), bytes);
  writeFileSync(join(out, "manifest.json.sig"), `${signature}\n`);
  process.stdout.write(`Signed recovery manifest for epoch ${next.epoch}, sequence 1, with ${signer.keyId}. Publish manifest.json(.sig) and keep epoch-${next.epoch}.json(.sig) permanently.\n`);
} else if (command === "generate-test") {
  const out = resolve(option("out") ?? "");
  const origin = option("origin") ?? "http://127.0.0.1:8765";
  mkdirSync(out, { recursive: true });
  const keyId = option("key-id") ?? "test-release-key";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  writeFileSync(join(out, `${keyId}.pem`), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const channel = {
    $comment: "TEST channel generated by scripts/release/release-keys.mts generate-test. Never use for a release.",
    channel: "stable",
    manifestUrl: `${origin}/release/stable/manifest.json`,
    artifactPrefix: `${origin}/downloads/`,
    keys: [trustedKeyFromPublicKey(keyId, publicKey)],
    minSequence: 1,
  };
  parseReleaseChannelConfig(channel);
  writeFileSync(join(out, "channel.json"), `${JSON.stringify(channel, null, 2)}\n`);
  process.stdout.write(`Test key ${keyId} and channel written to ${out}.\n`);
} else if (command === "verify") {
  const manifestPath = resolve(option("manifest") ?? "");
  const config = parseReleaseChannelConfig(JSON.parse(readFileSync(resolve(option("config") ?? join(root, "release", "channel.json")), "utf8")));
  const bytes = readFileSync(manifestPath);
  const signature = readFileSync(option("sig") ?? `${manifestPath}.sig`, "utf8");
  const historicalPath = join(root, "release", "previous-channel.json");
  let manifest: ReleaseManifest;
  try { manifest = verifyReleaseManifest(bytes, signature, config, { now: new Date() }); }
  catch (error) {
    if (!existsSync(historicalPath)) throw error;
    const previousConfig = parseReleaseChannelConfig(JSON.parse(readFileSync(historicalPath, "utf8")));
    const opening = verifyReleaseManifest(bytes, signature, previousConfig, { now: new Date() });
    if ((opening.epoch ?? 0) !== (config.epoch ?? 0) || (opening.epoch ?? 0) <= (previousConfig.epoch ?? 0) ||
        JSON.stringify(opening.signingKeys) !== JSON.stringify(config.keys) || JSON.stringify(config.recoveryKeys ?? []) !== JSON.stringify(previousConfig.recoveryKeys ?? [])) throw error;
    manifest = opening;
  }
  process.stdout.write(`OK ${manifest.version} epoch ${manifest.epoch ?? 0} sequence ${manifest.sequence}, signed by ${manifest.keyId}, expires ${manifest.expiresAt}\n`);
  // Publication order: the committed manifest (authenticated, even if expired, under the current or the
  // reviewed previous trust configuration) must have a lower sequence than the one about to replace it.
  const committedPath = resolve(option("committed") ?? join(root, "public", "release", manifest.channel, "manifest.json"));
  if (existsSync(committedPath) && !readFileSync(committedPath).equals(bytes)) {
    const committedBytes = readFileSync(committedPath);
    const committedSignature = readFileSync(`${committedPath}.sig`, "utf8");
    let committed: ReleaseManifest;
    try { committed = verifyHistoricalReleaseManifest(committedBytes, committedSignature, config, new Date()); }
    catch (error) {
      if (!existsSync(historicalPath)) throw error;
      committed = verifyHistoricalReleaseManifest(committedBytes, committedSignature, parseReleaseChannelConfig(JSON.parse(readFileSync(historicalPath, "utf8"))), new Date());
    }
    assertPublicationOrder(manifest, committed);
    process.stdout.write(`  replaces committed sequence ${committed.sequence}\n`);
  }
  const bundles = option("bundles");
  for (const artifact of manifest.artifacts) {
    let note = "";
    if (bundles) {
      const bytes = readFileSync(join(resolve(bundles), basename(new URL(artifact.url).pathname)));
      if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`${artifact.url} does not match the manifest.`);
      note = " (local archive matches)";
    }
    process.stdout.write(`  ${artifact.target.padEnd(13)} ${artifact.sha256} ${artifact.url}${note}\n`);
  }
} else {
  throw new Error("Usage: release-keys.mts pin|pin-recovery|sign-epoch|show|generate-test|verify ...");
}
