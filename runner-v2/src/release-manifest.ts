// Signed release manifest (ADR-E): exact UTF-8 bytes, detached RSA-3072/SHA-256 PKCS#1 v1.5 signature.
// The signature is verified against the pinned keys BEFORE the bytes are parsed or any URL/hash is trusted.
import { createPublicKey, sign as rsaSign, verify as rsaVerify, constants, type KeyObject } from "node:crypto";

export const RELEASE_PRODUCT = "aiboard-runner";
export const RELEASE_SCHEMA_VERSION = 1;
/** Bumped when installers/updaters must refuse manifests they cannot fully honor. */
export const INSTALLER_PROTOCOL = 1;
export const RELEASE_TARGETS = ["win-x64", "win-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"] as const;
export type ReleaseTarget = typeof RELEASE_TARGETS[number];
/** win-arm64 ships as preview until its Windows helper is qualified on arm64 (plan §1.2). */
export const PREVIEW_TARGETS: ReadonlySet<ReleaseTarget> = new Set(["win-arm64"]);
export const MIN_KEY_BITS = 3072;

export interface TrustedReleaseKey {
  keyId: string;
  /** RSA modulus and public exponent, base64url (JWK `n` / `e`). */
  n: string;
  e: string;
}

export interface ReleaseChannelConfig {
  channel: string;
  manifestUrl: string;
  /** Every artifact URL must start with this prefix. */
  artifactPrefix: string;
  keys: TrustedReleaseKey[];
  /** Bootstrap replay bound: the lowest sequence a fresh install accepts. */
  minSequence: number;
}

export interface ReleaseArtifact {
  target: ReleaseTarget;
  format: "zip" | "tar.gz";
  preview: boolean;
  bytes: number;
  sha256: string;
  url: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: string;
  channel: string;
  version: string;
  sequence: number;
  createdAt: string;
  expiresAt: string;
  minInstallerVersion: number;
  keyId: string;
  nodeVersion: string;
  artifacts: ReleaseArtifact[];
}

const VERSION_PATTERN = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})(-[0-9A-Za-z][0-9A-Za-z.]{0,31})?$/;
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,63}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const URL_PATTERN = /^https?:\/\/[A-Za-z0-9.:[\]-]+\/[A-Za-z0-9._~/%+-]*$/;
const MANIFEST_KEYS = ["schemaVersion", "product", "channel", "version", "sequence", "createdAt", "expiresAt", "minInstallerVersion", "keyId", "nodeVersion", "artifacts"] as const;
const ARTIFACT_KEYS = ["target", "format", "preview", "bytes", "sha256", "url"] as const;
/** Clock skew tolerated for a manifest created "in the future". */
const CREATED_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

export class ReleaseVerificationError extends Error {
  constructor(message: string) { super(`release_manifest_rejected: ${message}`); this.name = "ReleaseVerificationError"; }
}

export function isReleaseVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

export function targetFormat(target: ReleaseTarget): "zip" | "tar.gz" {
  return target.startsWith("win-") ? "zip" : "tar.gz";
}

/**
 * Canonical bytes: one top-level member per line and one artifact per line, fixed key order.
 * install.sh parses this layout with grep/sed after the signature verifies, and the Node
 * verifier refuses any manifest that is not byte-identical to this rendering, so both
 * parsers always read the same values.
 */
export function serializeManifest(manifest: ReleaseManifest): string {
  const artifacts = [...manifest.artifacts].sort((left, right) => left.target.localeCompare(right.target));
  const lines = [
    `"schemaVersion":${JSON.stringify(manifest.schemaVersion)},`,
    `"product":${JSON.stringify(manifest.product)},`,
    `"channel":${JSON.stringify(manifest.channel)},`,
    `"version":${JSON.stringify(manifest.version)},`,
    `"sequence":${JSON.stringify(manifest.sequence)},`,
    `"createdAt":${JSON.stringify(manifest.createdAt)},`,
    `"expiresAt":${JSON.stringify(manifest.expiresAt)},`,
    `"minInstallerVersion":${JSON.stringify(manifest.minInstallerVersion)},`,
    `"keyId":${JSON.stringify(manifest.keyId)},`,
    `"nodeVersion":${JSON.stringify(manifest.nodeVersion)},`,
    `"artifacts":[`,
    artifacts.map((artifact) => JSON.stringify(Object.fromEntries(ARTIFACT_KEYS.map((key) => [key, artifact[key]])))).join(",\n"),
    "]",
  ];
  return `{\n${lines.join("\n")}\n}\n`;
}

export function publicKeyFromTrusted(key: TrustedReleaseKey): KeyObject {
  const object = createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
  const bits = object.asymmetricKeyDetails?.modulusLength ?? 0;
  if (object.asymmetricKeyType !== "rsa" || bits < MIN_KEY_BITS) throw new ReleaseVerificationError(`trusted key ${key.keyId} is not RSA-${MIN_KEY_BITS} or larger`);
  return object;
}

export function trustedKeyFromPublicKey(keyId: string, key: KeyObject): TrustedReleaseKey {
  if (!KEY_ID_PATTERN.test(keyId)) throw new Error("invalid_key_id: Key ids are lowercase letters, digits and dashes (3-64 characters).");
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("invalid_key: Release keys must be RSA.");
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_KEY_BITS) throw new Error(`invalid_key: Release keys must be RSA-${MIN_KEY_BITS} or larger.`);
  return { keyId, n: jwk.n, e: jwk.e };
}

export function signManifestBytes(bytes: Uint8Array, privateKey: KeyObject): string {
  return rsaSign("sha256", bytes, { key: privateKey, padding: constants.RSA_PKCS1_PADDING }).toString("base64");
}

export interface VerifyManifestOptions {
  now: Date;
  /** Highest sequence already accepted on this machine (updater); undefined on first install. */
  highWaterSequence?: number;
}

/** Verifies the detached signature first, then parses and validates the exact signed bytes. */
export function verifyReleaseManifest(bytes: Uint8Array, signatureText: string, config: ReleaseChannelConfig, options: VerifyManifestOptions): ReleaseManifest {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) throw new ReleaseVerificationError("manifest size is out of range");
  if (config.keys.length === 0) throw new ReleaseVerificationError("no trusted release key is configured; this build cannot install or update");
  const trimmed = signatureText.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) throw new ReleaseVerificationError("signature is not base64");
  const signature = Buffer.from(trimmed, "base64");
  let signer: TrustedReleaseKey | undefined;
  for (const key of config.keys) {
    const publicKey = publicKeyFromTrusted(key);
    if (rsaVerify("sha256", bytes, { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature)) { signer = key; break; }
  }
  if (!signer) throw new ReleaseVerificationError("signature does not verify against any trusted release key");

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ReleaseVerificationError("manifest is not UTF-8"); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new ReleaseVerificationError("manifest is not JSON"); }
  const manifest = validateManifestShape(value);
  if (serializeManifest(manifest) !== text) throw new ReleaseVerificationError("manifest is not in canonical form");
  if (manifest.keyId !== signer.keyId) throw new ReleaseVerificationError("manifest names a different key than the one that signed it");
  if (manifest.product !== RELEASE_PRODUCT) throw new ReleaseVerificationError("manifest is for another product");
  if (manifest.channel !== config.channel) throw new ReleaseVerificationError(`manifest is for channel ${manifest.channel}, expected ${config.channel}`);
  if (manifest.minInstallerVersion > INSTALLER_PROTOCOL) throw new ReleaseVerificationError("this release needs a newer installer; reinstall with the one-line installer");
  const now = options.now.getTime();
  if (Date.parse(manifest.expiresAt) <= now) throw new ReleaseVerificationError("manifest has expired");
  if (Date.parse(manifest.createdAt) > now + CREATED_SKEW_MS) throw new ReleaseVerificationError("manifest creation time is in the future");
  if (Date.parse(manifest.createdAt) >= Date.parse(manifest.expiresAt)) throw new ReleaseVerificationError("manifest expires before it was created");
  if (manifest.sequence < config.minSequence) throw new ReleaseVerificationError("manifest sequence is older than this installer's minimum");
  if (options.highWaterSequence !== undefined && manifest.sequence < options.highWaterSequence) {
    throw new ReleaseVerificationError("manifest sequence is older than a release this machine already accepted");
  }
  for (const artifact of manifest.artifacts) {
    if (!artifact.url.startsWith(config.artifactPrefix)) throw new ReleaseVerificationError(`artifact ${artifact.target} is not hosted on the approved release origin`);
    if (!artifact.url.startsWith("https://") && !isLoopbackUrl(artifact.url)) throw new ReleaseVerificationError(`artifact ${artifact.target} is not served over HTTPS`);
  }
  return manifest;
}

export function isLoopbackUrl(url: string): boolean {
  return /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\//.test(url);
}

function validateManifestShape(value: unknown): ReleaseManifest {
  const record = exactRecord(value, MANIFEST_KEYS, "manifest");
  if (record.schemaVersion !== RELEASE_SCHEMA_VERSION) throw new ReleaseVerificationError("unsupported manifest schemaVersion");
  const text = (key: string, pattern: RegExp) => {
    const field = record[key];
    if (typeof field !== "string" || !pattern.test(field)) throw new ReleaseVerificationError(`manifest ${key} is invalid`);
    return field;
  };
  const integer = (key: string, min: number, max: number) => {
    const field = record[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < min || field > max) throw new ReleaseVerificationError(`manifest ${key} is invalid`);
    return field;
  };
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    product: text("product", /^[a-z-]{1,32}$/),
    channel: text("channel", CHANNEL_PATTERN),
    version: text("version", VERSION_PATTERN),
    sequence: integer("sequence", 1, 2 ** 40),
    createdAt: text("createdAt", TIMESTAMP_PATTERN),
    expiresAt: text("expiresAt", TIMESTAMP_PATTERN),
    minInstallerVersion: integer("minInstallerVersion", 1, 1000),
    keyId: text("keyId", KEY_ID_PATTERN),
    nodeVersion: text("nodeVersion", /^24\.[0-9]{1,3}\.[0-9]{1,3}$/),
    artifacts: [],
  };
  if (Number.isNaN(Date.parse(manifest.createdAt)) || Number.isNaN(Date.parse(manifest.expiresAt))) throw new ReleaseVerificationError("manifest timestamps are invalid");
  if (!Array.isArray(record.artifacts) || record.artifacts.length !== RELEASE_TARGETS.length) throw new ReleaseVerificationError(`manifest must list exactly ${RELEASE_TARGETS.length} artifacts`);
  const seen = new Set<string>();
  for (const entry of record.artifacts) {
    const artifact = exactRecord(entry, ARTIFACT_KEYS, "artifact");
    const target = artifact.target;
    if (typeof target !== "string" || !(RELEASE_TARGETS as readonly string[]).includes(target) || seen.has(target)) throw new ReleaseVerificationError("artifact target is unknown or repeated");
    seen.add(target);
    const typedTarget = target as ReleaseTarget;
    if (artifact.format !== targetFormat(typedTarget)) throw new ReleaseVerificationError(`artifact ${target} has the wrong format`);
    if (artifact.preview !== PREVIEW_TARGETS.has(typedTarget)) throw new ReleaseVerificationError(`artifact ${target} has the wrong preview flag`);
    if (typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > MAX_ARTIFACT_BYTES) throw new ReleaseVerificationError(`artifact ${target} size is invalid`);
    if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new ReleaseVerificationError(`artifact ${target} sha256 is invalid`);
    if (typeof artifact.url !== "string" || artifact.url.length > 512 || !URL_PATTERN.test(artifact.url)) throw new ReleaseVerificationError(`artifact ${target} url is invalid`);
    manifest.artifacts.push({ target: typedTarget, format: targetFormat(typedTarget), preview: PREVIEW_TARGETS.has(typedTarget), bytes: artifact.bytes, sha256: artifact.sha256, url: artifact.url });
  }
  return manifest;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReleaseVerificationError(`${label} is not an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new ReleaseVerificationError(`${label} has unexpected or missing fields`);
  return value as Record<string, unknown>;
}

/** Validates a channel configuration file (release/channel.json or a test channel). */
export function parseReleaseChannelConfig(value: unknown): ReleaseChannelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_release_config: not an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["channel", "manifestUrl", "artifactPrefix", "keys", "minSequence", "$comment"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error("invalid_release_config: unexpected field");
  const { channel, manifestUrl, artifactPrefix, keys, minSequence } = record;
  if (typeof channel !== "string" || !CHANNEL_PATTERN.test(channel)) throw new Error("invalid_release_config: channel");
  for (const [name, url] of [["manifestUrl", manifestUrl], ["artifactPrefix", artifactPrefix]] as const) {
    if (typeof url !== "string" || !URL_PATTERN.test(url) || (!url.startsWith("https://") && !isLoopbackUrl(url))) throw new Error(`invalid_release_config: ${name} must be https (or http://127.0.0.1 for tests)`);
  }
  if (!(artifactPrefix as string).endsWith("/")) throw new Error("invalid_release_config: artifactPrefix must end with /");
  if (typeof minSequence !== "number" || !Number.isSafeInteger(minSequence) || minSequence < 1) throw new Error("invalid_release_config: minSequence");
  if (!Array.isArray(keys)) throw new Error("invalid_release_config: keys");
  const parsed: TrustedReleaseKey[] = keys.map((key: unknown) => {
    if (typeof key !== "object" || key === null) throw new Error("invalid_release_config: key");
    const { keyId, n, e } = key as Record<string, unknown>;
    if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId) || typeof n !== "string" || typeof e !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(n) || !/^[A-Za-z0-9_-]+$/.test(e) || Object.keys(key).length !== 3) throw new Error("invalid_release_config: key");
    const trusted = { keyId, n, e };
    publicKeyFromTrusted(trusted);
    return trusted;
  });
  if (new Set(parsed.map((key) => key.keyId)).size !== parsed.length) throw new Error("invalid_release_config: duplicate keyId");
  return { channel, manifestUrl: manifestUrl as string, artifactPrefix: artifactPrefix as string, keys: parsed, minSequence };
}
