// Renders the one-line installers (scripts/install/install.{ps1,sh}) with the channel's pinned release
// keys, URLs and replay floor baked in. publish-downloads writes the production render to public/;
// installer tests render against a local test channel.
//   node scripts/release/render-installers.mjs [--channel-config release/channel.json] [--out public] [--min-sequence N]
import { createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAFE_URL = /^(https:\/\/[A-Za-z0-9.-]+|http:\/\/127\.0\.0\.1:[0-9]{1,5})\/[A-Za-z0-9._~/%+-]*$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\//;

function validated(config) {
  const fail = (field) => { throw new Error(`render-installers: invalid ${field} in the channel config.`); };
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(config.channel ?? "")) fail("channel");
  if (!SAFE_URL.test(config.manifestUrl ?? "")) fail("manifestUrl");
  if (!SAFE_URL.test(config.artifactPrefix ?? "") || !config.artifactPrefix.endsWith("/")) fail("artifactPrefix");
  if (!Number.isSafeInteger(config.minSequence) || config.minSequence < 1) fail("minSequence");
  if (!Array.isArray(config.keys)) fail("keys");
  const loopback = LOOPBACK.test(config.manifestUrl);
  if (loopback !== LOOPBACK.test(config.artifactPrefix)) fail("origins (test and production URLs cannot be mixed)");
  const keys = config.keys.map((key) => {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(key.keyId ?? "") || !/^[A-Za-z0-9_-]+$/.test(key.n ?? "") || !/^[A-Za-z0-9_-]+$/.test(key.e ?? "")) fail("key");
    const publicKey = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) fail(`key ${key.keyId} (RSA-3072 or larger required)`);
    return {
      keyId: key.keyId,
      modulus: Buffer.from(key.n, "base64url").toString("base64"),
      exponent: Buffer.from(key.e, "base64url").toString("base64"),
      spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    };
  });
  return { ...config, keys, loopback };
}

/** The highest sequence already published with this site raises the installers' replay floor. */
export function publishedSequence(channel, publicDirectory = path.join(root, "public")) {
  const manifest = path.join(publicDirectory, "release", channel, "manifest.json");
  if (!fs.existsSync(manifest)) return undefined;
  const match = /^"sequence":([0-9]+),$/m.exec(fs.readFileSync(manifest, "utf8"));
  if (!match) throw new Error(`render-installers: cannot read the sequence of ${manifest}.`);
  return Number(match[1]);
}

export function renderInstallers(rawConfig, options = {}) {
  const config = validated(rawConfig);
  const minSequence = Math.max(config.minSequence, options.minSequence ?? 0);
  const values = {
    __AIBOARD_MANIFEST_URL__: config.manifestUrl,
    __AIBOARD_ARTIFACT_PREFIX__: config.artifactPrefix,
    __AIBOARD_CHANNEL__: config.channel,
    __AIBOARD_MIN_SEQUENCE__: String(minSequence),
    __AIBOARD_ALLOW_LOOPBACK_PS__: config.loopback ? "$true" : "$false",
    __AIBOARD_ALLOW_LOOPBACK_SH__: config.loopback ? "1" : "0",
    __AIBOARD_TRUSTED_KEYS_PS__: config.keys.map((key) => `    @{ Id = '${key.keyId}'; Modulus = '${key.modulus}'; Exponent = '${key.exponent}' }`).join(",\n"),
    __AIBOARD_TRUSTED_KEYS_SH__: config.keys.map((key) => `${key.keyId} ${key.spki}`).join("\n"),
  };
  const templates = options.templateDirectory ?? path.join(root, "scripts", "install");
  const render = (name) => {
    let text = fs.readFileSync(path.join(templates, name), "utf8").replace(/\r\n/g, "\n");
    for (const [placeholder, value] of Object.entries(values)) text = text.split(placeholder).join(value);
    if (/__AIBOARD_[A-Z_]+__/.test(text)) throw new Error(`render-installers: ${name} has an unknown placeholder.`);
    return text;
  };
  return { ps1: render("install.ps1"), sh: render("install.sh"), minSequence, keyIds: config.keys.map((key) => key.keyId) };
}

export function writeInstallers(outDirectory, rawConfig, options = {}) {
  const rendered = renderInstallers(rawConfig, options);
  fs.mkdirSync(outDirectory, { recursive: true });
  fs.writeFileSync(path.join(outDirectory, "install.ps1"), rendered.ps1);
  fs.writeFileSync(path.join(outDirectory, "install.sh"), rendered.sh, { mode: 0o755 });
  return rendered;
}

if (path.basename(process.argv[1] ?? "") === "render-installers.mjs" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index < 0 ? undefined : process.argv[index + 1];
  };
  const configPath = path.resolve(option("channel-config") ?? path.join(root, "release", "channel.json"));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const out = path.resolve(option("out") ?? path.join(root, "public"));
  const minSequence = option("min-sequence") !== undefined ? Number(option("min-sequence")) : publishedSequence(config.channel);
  const rendered = writeInstallers(out, config, { minSequence });
  console.log(`Rendered install.ps1 and install.sh to ${path.relative(root, out) || "."} (keys: ${rendered.keyIds.join(", ") || "none - installers refuse to install"}; min sequence ${rendered.minSequence}).`);
}
