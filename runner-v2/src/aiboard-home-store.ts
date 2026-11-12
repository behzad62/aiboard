import { createCipheriv, createHash, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { AiboardHomeError, type AiboardHomeLocation } from "./aiboard-home-paths.js";
import { openEncryptedJson } from "./encrypted-provider-config-store.js";
import { migrateHomeConfigModelIds } from "./home-model-policy.js";
import { acquireLockFile } from "./launcher-instance.js";
import { FileStorageKeyProvider } from "./storage-key.js";

/**
 * The AIBoard home store (Simple Build plan §5.8, packet HM1): the user's settings in
 * `<home>/config.json` (no secrets) and keys in `<home>/credentials.json` (an AES-256-GCM envelope
 * under the home key, which lives in the user data root, outside the home). Writers take
 * `<home>/home-lock.sqlite`, re-read both files, apply one batch of ops all or nothing, and replace
 * each changed file atomically (credentials first). Readers take no lock.
 *
 * Owned filesystem targets (filesystem-owner review 2026-11-12, HM1): `<home>` itself when missing,
 * its config.json and credentials.json with their exclusive random temporaries, the user data root
 * when missing, and `<data root>/home-key` (created or replaced only through FileStorageKeyProvider
 * and resetHomeCredentials). Nothing else.
 */

export const HOME_CONTRACT_VERSION = "aiboard.home.v1";
export const HOME_CREDENTIALS_CONTRACT_VERSION = "aiboard.home-credentials.v1";
const HOME_CONTRACT_NUMBER = 1;
const HOME_CREDENTIALS_CONTRACT_NUMBER = 1;
const LOCK_WAIT_MS = 5_000;
const READ_RETRY_MS = 2_000;
const RENAME_RETRY_MS = 2_000;
const RETRY_DELAY_MS = 50;
const MAX_OPS = 256;
const MAX_SECRET_LENGTH = 16_384;
const CREDENTIALS_KEY_INFO = "aiboard/home/credentials/v1";

// ------------------------------------------------------------------ field lists

/**
 * The UserSettings fields the home keeps (lib/db/schema.ts UserSettings): an explicit allow-list,
 * never "UserSettings minus a few". `modelCapabilityProfiles` is written through a cast today
 * (lib/client/capability-api.ts). A UserSettings field named in none of the lists below fails
 * test/aiboard-home-store.test.ts, so a new field stays per browser until it is named here.
 */
export const HOME_SETTINGS_FIELDS = [
  "defaultEffort", "defaultMode", "judgeModelId", "defaultVerbosity", "defaultStyleNote",
  "defaultReasoningEffort", "defaultBuildRunPolicy", "defaultBuildSkillMode", "defaultBuildBudgetUsd",
  "defaultBuildTimeLimitMinutes", "defaultBuildAlwaysRequireIndependentVerifier",
  "modelPricingOverrides", "modelContextOverrides", "discoveredModelMetadata", "providerToolCapabilityEvidence",
  "modelCapabilityProfiles", "toolRuntime",
] as const;
export type HomeSettingsField = typeof HOME_SETTINGS_FIELDS[number];
/** Settings fields whose single entries are their own sections (`settings.<field>.<entryId>`). */
export const HOME_SETTINGS_MAP_FIELDS = ["modelPricingOverrides", "modelContextOverrides", "discoveredModelMetadata", "modelCapabilityProfiles"] as const;
/** UserSettings fields kept at the top level of config.json instead of under `settings`. */
export const HOME_TOP_LEVEL_SETTINGS_FIELDS = ["openAIConnectionMode"] as const;
/** UserSettings fields that stay in each browser: they name a browser or a Runner, not a user. */
export const BROWSER_ONLY_SETTINGS_FIELDS = ["id", "chatDefaultApplied", "benchmarkRunner"] as const;
/** UserSettings fields the home drops. */
export const DROPPED_SETTINGS_FIELDS = ["discoveredModelCapabilities"] as const;
/** ToolRuntimeSettings: `runner` names a Runner and its token, so it stays in the browser. */
export const HOME_TOOL_RUNTIME_FIELDS = ["remoteMcpServer", "openaiFileSearch"] as const;
export const BROWSER_ONLY_TOOL_RUNTIME_FIELDS = ["runner"] as const;
/** RemoteMcpServerSettings: the token goes to credentials.remoteMcpAuthorizationToken. */
export const REMOTE_MCP_SERVER_HOME_FIELDS = ["enabled", "name", "url"] as const;
export const REMOTE_MCP_SERVER_SECRET_FIELDS = ["authorizationToken"] as const;

/** ProviderKey (schema.ts) → the home's provider entry. */
export const PROVIDER_KEY_HOME_FIELDS: Readonly<Record<string, keyof HomeProviderFields>> = Object.freeze({
  enabled: "enabled", baseURL: "baseUrl", models: "models", enabledModelIds: "enabledModelIds",
  defaultModel: "defaultModel", lastValidationSucceeded: "lastValidationSucceeded", lastValidatedAt: "lastValidatedAt",
});
export const PROVIDER_KEY_SECRET_FIELDS = ["apiKey"] as const;
/**
 * Not stored: the id is the entry's key; "has a key" and the hint are derived from credentials.json;
 * the account-peer token changes with every launch (OD-32); the encrypted fields are the old server form.
 */
export const PROVIDER_KEY_NOT_STORED_FIELDS = ["providerId", "keyHint", "updatedAt", "runnerToken", "runnerTokenHint", "encryptedKey", "iv", "authTag"] as const;
/** CustomModel (schema.ts) without apiKey and the legacy server fields. */
export const CUSTOM_MODEL_HOME_FIELDS = [
  "id", "label", "baseURL", "model", "capabilities", "toolCapabilityOverrides", "compatibleTransports",
  "reasoningEffort", "lastValidationSucceeded", "lastValidatedAt", "createdAt",
] as const;
export const CUSTOM_MODEL_SECRET_FIELDS = ["apiKey"] as const;
export const CUSTOM_MODEL_NOT_STORED_FIELDS = ["encryptedKey", "iv", "authTag", "hasKey"] as const;

// ------------------------------------------------------------------ types

export interface HomeProviderFields {
  enabled: boolean;
  baseUrl: string | null;
  models: string[] | null;
  enabledModelIds: string[] | null;
  defaultModel: string | null;
  lastValidationSucceeded: boolean | null;
  lastValidatedAt: string | null;
}
/** A provider entry; fields a newer writer added are kept verbatim. */
export type HomeProviderV1 = HomeProviderFields & Record<string, unknown>;

export interface HomeCustomModelV1 {
  id: string;
  label: string;
  baseURL: string;
  model: string;
  createdAt: string;
  capabilities?: { image: boolean; document: boolean; audio: boolean; video: boolean };
  toolCapabilityOverrides?: unknown[];
  compatibleTransports?: string[];
  reasoningEffort?: string;
  lastValidationSucceeded?: boolean | null;
  lastValidatedAt?: string | null;
  [unknown: string]: unknown;
}

export type HomeSettingsV1 = { [field in HomeSettingsField]?: unknown } & Record<string, unknown>;

/** `<home>/config.json`. The `exec` section is DX1's (OD-33); until then it is an unknown field, kept verbatim. */
export interface AiboardHomeConfigV1 {
  contractVersion: string;
  revision: number;
  pathRevisions: Record<string, number>;
  updatedAt: string;
  providers: Record<string, HomeProviderV1>;
  openAIConnectionMode: "api" | "subscription";
  customModels: HomeCustomModelV1[];
  settings: HomeSettingsV1;
  [unknown: string]: unknown;
}

export interface HomeCredentialV1 {
  secret: string;
  /** The normalized upstream the secret was entered for (normalizeUpstream, or `default:<providerId>`). */
  boundUpstream: string;
  savedAt: string;
  [unknown: string]: unknown;
}

/** The plaintext inside credentials.json's envelope. */
export interface AiboardHomeCredentialsV1 {
  contractVersion: string;
  providers: Record<string, HomeCredentialV1>;
  customModels: Record<string, HomeCredentialV1>;
  remoteMcpAuthorizationToken?: HomeCredentialV1;
  [unknown: string]: unknown;
}

interface CredentialsEnvelope {
  version: 1;
  keyId: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface HomeKeyStatus { keyHint: string }
/** What a reader may show about the keys: never a secret. Only keys bound to their current upstream. */
export interface HomeCredentialStatusV1 {
  providers: Record<string, HomeKeyStatus>;
  customModels: Record<string, HomeKeyStatus>;
  remoteMcpAuthorizationToken?: HomeKeyStatus;
}

export interface AiboardHomeSnapshot {
  readonly location: AiboardHomeLocation;
  /** False when config.json does not exist yet. */
  readonly exists: boolean;
  readonly revision: number;
  readonly config: AiboardHomeConfigV1;
  /** False when config.json or credentials.json has a newer contractVersion: writes refuse with home_newer. */
  readonly writable: boolean;
  /** Undefined when the read was made with `credentials: false`. */
  readonly credentials?: HomeCredentialStatusV1;
  /** The secret at a credential path, only while it is bound to its section's current upstream. */
  secret(path: string): string | undefined;
}

export type HomeOpKind = "set" | "merge" | "remove";
export interface HomeOp { path: string; op: HomeOpKind; value?: unknown }
export interface HomeBatch { baseRevision: number; ops: readonly HomeOp[] }

export interface HomeConflictDetails {
  currentRevision: number;
  /** The current value of every conflicting section; credential sections show only whether a key is saved. */
  sections: Record<string, unknown>;
}

export interface HomeWriteResult {
  revision: number;
  /** Every section this write changed, the base-URL rule's key removals included. */
  touched: string[];
  /** Credential paths removed because their section's upstream changed. */
  removedCredentials: string[];
}

export interface HomeWriteOptions {
  now?: () => Date;
  lockWaitMs?: number;
  /** Test seam: runs after credentials.json is replaced and before config.json is. */
  afterCredentialsWrite?: () => void | Promise<void>;
}

// ------------------------------------------------------------------ paths and sections

type Section =
  | { kind: "provider"; id: string }
  | { kind: "customModel"; id: string }
  | { kind: "openAIConnectionMode" }
  | { kind: "setting"; field: HomeSettingsField }
  | { kind: "settingEntry"; field: typeof HOME_SETTINGS_MAP_FIELDS[number]; entry: string }
  | { kind: "credential"; target: "providers" | "customModels"; id: string }
  | { kind: "credentialRemoteMcp" };

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CUSTOM_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function validEntryId(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) && !RESERVED_KEYS.has(value);
}

export function parseHomePath(path: string): Section {
  if (typeof path !== "string") throw invalid("A path must be a string.");
  const after = (prefix: string): string | undefined => (path.startsWith(prefix) ? path.slice(prefix.length) : undefined);
  let rest: string | undefined;
  if ((rest = after("credentials.providers.")) !== undefined) {
    if (!PROVIDER_ID.test(rest)) throw invalid(`Unknown provider id in ${path}.`);
    return { kind: "credential", target: "providers", id: rest };
  }
  if ((rest = after("credentials.customModels.")) !== undefined) {
    if (!CUSTOM_MODEL_ID.test(rest)) throw invalid(`Invalid custom model id in ${path}.`);
    return { kind: "credential", target: "customModels", id: rest };
  }
  if (path === "credentials.remoteMcpAuthorizationToken") return { kind: "credentialRemoteMcp" };
  if ((rest = after("providers.")) !== undefined) {
    if (!PROVIDER_ID.test(rest)) throw invalid(`Unknown provider id in ${path}.`);
    return { kind: "provider", id: rest };
  }
  if ((rest = after("customModels.")) !== undefined) {
    if (!CUSTOM_MODEL_ID.test(rest)) throw invalid(`Invalid custom model id in ${path}.`);
    return { kind: "customModel", id: rest };
  }
  if (path === "openAIConnectionMode") return { kind: "openAIConnectionMode" };
  if ((rest = after("settings.")) !== undefined) {
    for (const field of HOME_SETTINGS_MAP_FIELDS) {
      const entry = rest.startsWith(`${field}.`) ? rest.slice(field.length + 1) : undefined;
      if (entry !== undefined) {
        if (!validEntryId(entry)) throw invalid(`Invalid entry id in ${path}.`);
        return { kind: "settingEntry", field, entry };
      }
    }
    if ((HOME_SETTINGS_FIELDS as readonly string[]).includes(rest)) return { kind: "setting", field: rest as HomeSettingsField };
    throw invalid(`settings.${rest} is not a setting the AIBoard home keeps.`);
  }
  throw invalid(`${path} is not a section of the AIBoard home.`);
}

function sectionSegments(section: Section): string[] {
  switch (section.kind) {
    case "provider": return ["providers", section.id];
    case "customModel": return ["customModels", section.id];
    case "openAIConnectionMode": return ["openAIConnectionMode"];
    case "setting": return ["settings", section.field];
    case "settingEntry": return ["settings", section.field, section.entry];
    case "credential": return ["credentials", section.target, section.id];
    case "credentialRemoteMcp": return ["credentials", "remoteMcpAuthorizationToken"];
  }
}

function sectionPath(section: Section): string {
  return sectionSegments(section).join(".");
}

/** Two sections overlap when one contains the other (a whole map and one of its entries). */
function overlaps(left: string[], right: string[]): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

// ------------------------------------------------------------------ upstreams

/** The normalized form a key is bound to: scheme, host, port and path, without credentials or a fragment. */
export function normalizeUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("A base URL must be an absolute http or https URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("A base URL must use http or https.");
  if (url.username || url.password) throw invalid("A base URL must not contain a user name or password; enter the key as the key.");
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * A provider with no base URL uses its default upstream, and its key is bound to the sentinel
 * `default:<providerId>`. HM2 keeps the sentinel rather than binding to the default URL itself: the
 * default comes from the catalog snapshot of the AI Board release (home-runtime.ts
 * `homeProviderUpstream`), so a key the user saved for "the provider's own API" follows a default that a
 * signed release changes, while any base URL the user saves still rebinds and removes the key.
 */
export function providerUpstream(config: AiboardHomeConfigV1, providerId: string): string {
  const baseUrl = config.providers[providerId]?.baseUrl;
  return typeof baseUrl === "string" && baseUrl ? normalizeUpstream(baseUrl) : `default:${providerId}`;
}

function currentUpstream(config: AiboardHomeConfigV1, section: Section): string | undefined {
  try {
    if (section.kind === "credential" && section.target === "providers") return providerUpstream(config, section.id);
    if (section.kind === "credential") {
      const model = config.customModels.find((entry) => entry.id === section.id);
      return model && typeof model.baseURL === "string" ? normalizeUpstream(model.baseURL) : undefined;
    }
    if (section.kind === "credentialRemoteMcp") {
      const server = (config.settings.toolRuntime as { remoteMcpServer?: { url?: unknown } | null } | undefined)?.remoteMcpServer;
      return server && typeof server.url === "string" ? normalizeUpstream(server.url) : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// ------------------------------------------------------------------ errors and helpers

function invalid(message: string): AiboardHomeError {
  return new AiboardHomeError("home_invalid_op", message);
}

const KEYS_ADVICE = "Enter the keys again with `aiboard keys reset` or in Settings.";

function configAdvice(path: string): string {
  return `Fix or remove ${path}; without it, settings start from their defaults and the saved keys are kept.`;
}

function unreadable(message: string, cause?: unknown, advice = KEYS_ADVICE): AiboardHomeError {
  const error = new AiboardHomeError("home_unreadable", `${message} ${advice}`);
  if (cause !== undefined) (error as { cause?: unknown }).cause = cause;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isRecord(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.entries(value).every(([key, item]) => !RESERVED_KEYS.has(key) && isJsonValue(item, depth + 1));
  }
  return false;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function keyHint(secret: string): string {
  return secret.length <= 8 ? "••••••••" : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function contractNumber(value: unknown, prefix: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = new RegExp(`^${prefix.replaceAll(".", "\\.")}v([1-9][0-9]{0,5})$`).exec(value);
  return match ? Number(match[1]) : undefined;
}

// ------------------------------------------------------------------ files

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function assertPrivateFile(path: string, platform: NodeJS.Platform, secret: boolean): void {
  if (platform === "win32") return;
  const info = lstatSync(path);
  if (!info.isFile()) throw new AiboardHomeError("home_unsafe", `${path} is not a regular file.`);
  if (info.uid !== process.getuid?.()) throw new AiboardHomeError("home_unsafe", `${path} belongs to another user.`);
  if ((info.mode & (secret ? 0o077 : 0o022)) !== 0) {
    throw new AiboardHomeError("home_unsafe", `${path} is readable or writable by other users; it must be ${secret ? "0600" : "writable only by you"}.`);
  }
}

/** The home folder must be the user's own: owned by them and not group- or world-writable on POSIX. */
export function verifyHomeDirectory(location: AiboardHomeLocation, options: { create: boolean }): boolean {
  let info;
  try { info = statSync(location.home); }
  catch (error) {
    if (errnoCode(error) !== "ENOENT") throw new AiboardHomeError("home_unsafe", `The AIBoard home ${location.home} cannot be checked (${errnoCode(error) ?? "error"}).`);
    if (!options.create) return false;
    mkdirSync(location.home, { recursive: true, mode: 0o700 });
    info = statSync(location.home);
  }
  if (!info.isDirectory()) throw new AiboardHomeError("home_unsafe", `The AIBoard home ${location.home} is not a folder.`);
  if (location.platform !== "win32") {
    if (info.uid !== process.getuid?.()) throw new AiboardHomeError("home_unsafe", `The AIBoard home ${location.home} belongs to another user.`);
    if ((info.mode & 0o022) !== 0) throw new AiboardHomeError("home_unsafe", `The AIBoard home ${location.home} is writable by other users.`);
  }
  return true;
}

/** Read a file, retrying any error but a missing file for up to 2 s (a sync client or an antivirus scan). */
async function readWithRetry<T>(path: string, parse: (bytes: Buffer) => T, label: string, advice: string): Promise<T | undefined> {
  const deadline = Date.now() + READ_RETRY_MS;
  for (;;) {
    try {
      return parse(readFileSync(path));
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return undefined;
      if (error instanceof AiboardHomeError) throw error;
      if (Date.now() >= deadline) throw unreadable(`The AIBoard home's ${label} could not be read (${errnoCode(error) ?? (error instanceof Error ? error.message : "error")}).`, error, advice);
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function renameWithRetry(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  const deadline = Date.now() + RENAME_RETRY_MS;
  const attempt = async (): Promise<void> => {
    for (;;) {
      try { renameSync(from, to); return; }
      catch (error) {
        const code = errnoCode(error);
        if (platform !== "win32" || !code || !["EPERM", "EACCES", "EBUSY"].includes(code) || Date.now() >= deadline) throw error;
        await sleep(RETRY_DELAY_MS);
      }
    }
  };
  return attempt();
}

/** Exclusive random temporary, fsync, rename over the old file (retried on Windows), then fsync the folder on POSIX. */
async function writeAtomic(path: string, bytes: Buffer | string, platform: NodeJS.Platform): Promise<void> {
  const temporary = `${path}.tmp-${randomBytes(16).toString("hex")}`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    await renameWithRetry(temporary, path, platform);
    created = false;
    if (platform !== "win32") {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) rmSync(temporary, { force: true });
  }
}

// ------------------------------------------------------------------ config

function defaultConfig(now: string): AiboardHomeConfigV1 {
  return {
    contractVersion: HOME_CONTRACT_VERSION,
    revision: 0,
    pathRevisions: {},
    updatedAt: now,
    providers: {},
    openAIConnectionMode: "api",
    customModels: [],
    settings: {},
  };
}

interface ConfigRead { config: AiboardHomeConfigV1; exists: boolean; newer: boolean }

function parseConfig(bytes: Buffer): { config: AiboardHomeConfigV1; newer: boolean } {
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("config.json is not an object");
  const version = contractNumber(parsed.contractVersion, "aiboard.home.");
  if (version === undefined) throw new Error("config.json has no known contractVersion");
  const newer = version > HOME_CONTRACT_NUMBER;
  const config = parsed as AiboardHomeConfigV1;
  // A newer file is read with the fields this reader knows: one whose shape changed reads as its default.
  const check = (valid: boolean, field: string, fallback: () => void): void => {
    if (valid) return;
    if (!newer) throw new Error(`config.json ${field} is invalid`);
    fallback();
  };
  check(Number.isSafeInteger(config.revision) && config.revision >= 0, "revision", () => { config.revision = 0; });
  check(isRecord(config.pathRevisions) && Object.values(config.pathRevisions).every((value) => Number.isSafeInteger(value)), "pathRevisions", () => { config.pathRevisions = {}; });
  check(isRecord(config.providers) && Object.values(config.providers).every(isRecord), "providers", () => { config.providers = {}; });
  check(Array.isArray(config.customModels) && config.customModels.every((entry) => isRecord(entry) && typeof entry.id === "string"), "customModels", () => { config.customModels = []; });
  check(isRecord(config.settings), "settings", () => { config.settings = {}; });
  check(config.openAIConnectionMode === "api" || config.openAIConnectionMode === "subscription", "openAIConnectionMode", () => { config.openAIConnectionMode = "api"; });
  return { config, newer };
}

async function readConfig(location: AiboardHomeLocation, now: string): Promise<ConfigRead> {
  const read = await readWithRetry(location.configPath, (bytes) => {
    assertPrivateFile(location.configPath, location.platform, false);
    return parseConfig(bytes);
  }, "config.json", configAdvice(location.configPath));
  if (!read) return { config: defaultConfig(now), exists: false, newer: false };
  // §5.8 "Model ids": every read sees renamed model ids migrated, so the next write saves them (HM2).
  migrateHomeConfigModelIds(read.config);
  return { config: read.config, exists: true, newer: read.newer };
}

// ------------------------------------------------------------------ credentials

function homeKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function credentialsKey(homeKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", homeKey, Buffer.alloc(0), CREDENTIALS_KEY_INFO, 32));
}

function emptyCredentials(): AiboardHomeCredentialsV1 {
  return { contractVersion: HOME_CREDENTIALS_CONTRACT_VERSION, providers: {}, customModels: {} };
}

type KeyRead = { key: Buffer } | { missing: true } | { corrupt: true };

function readHomeKey(location: AiboardHomeLocation): KeyRead {
  try {
    const key = new FileStorageKeyProvider(location.keyDirectory, "home-key").getKey({ createIfMissing: false });
    assertPrivateFile(location.keyPath, location.platform, true);
    return { key };
  } catch (error) {
    if (error instanceof AiboardHomeError) throw error;
    if (errnoCode(error) === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
}

function createHomeKey(location: AiboardHomeLocation): Buffer {
  mkdirSync(location.keyDirectory, { recursive: true, mode: 0o700 });
  let key: Buffer;
  try { key = new FileStorageKeyProvider(location.keyDirectory, "home-key").getKey({ createIfMissing: true }); }
  catch (error) { throw unreadable(`The home key ${location.keyPath} is corrupt.`, error); }
  assertPrivateFile(location.keyPath, location.platform, true);
  return key;
}

function parseEnvelope(bytes: Buffer): CredentialsEnvelope {
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  // A newer AI Board's envelope: never "enter the keys again", which would lead the user to wipe them.
  if (isRecord(parsed) && Number.isSafeInteger(parsed.version) && (parsed.version as number) > 1) {
    throw new AiboardHomeError("home_newer", "The saved keys were written by a newer AI Board; update AI Board to use or change them.");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.keyId !== "string" || !/^[0-9a-f]{16}$/.test(parsed.keyId)) {
    throw new Error("credentials.json is not a version 1 envelope");
  }
  return parsed as unknown as CredentialsEnvelope;
}

type CredentialsRead =
  | { state: "absent" }
  | { state: "ok"; credentials: AiboardHomeCredentialsV1; newer: boolean; key: Buffer }
  | { state: "error"; error: AiboardHomeError };

/** Never a partial read: either every credential is decrypted with the local key, or a typed error. */
async function readCredentials(location: AiboardHomeLocation): Promise<CredentialsRead> {
  let envelope: CredentialsEnvelope | undefined;
  try {
    envelope = await readWithRetry(location.credentialsPath, (bytes) => {
      assertPrivateFile(location.credentialsPath, location.platform, true);
      return parseEnvelope(bytes);
    }, "credentials.json", KEYS_ADVICE);
  } catch (error) {
    if (error instanceof AiboardHomeError) return { state: "error", error };
    throw error;
  }
  if (!envelope) return { state: "absent" };
  let keyRead: KeyRead;
  try { keyRead = readHomeKey(location); }
  catch (error) { if (error instanceof AiboardHomeError) return { state: "error", error }; throw error; }
  if ("missing" in keyRead) return { state: "error", error: unreadable(`The home key ${location.keyPath} is missing, so the saved keys cannot be read.`) };
  if ("corrupt" in keyRead) return { state: "error", error: unreadable(`The home key ${location.keyPath} is corrupt, so the saved keys cannot be read.`) };
  const key = keyRead.key;
  if (homeKeyId(key) !== envelope.keyId) {
    key.fill(0);
    return { state: "error", error: new AiboardHomeError("home_key_mismatch", "These keys were saved on another computer; enter them again here with `aiboard keys reset`.") };
  }
  const subkey = credentialsKey(key);
  let plaintext: unknown;
  try {
    plaintext = openEncryptedJson(subkey, JSON.stringify({ version: 1, salt: envelope.salt, iv: envelope.iv, tag: envelope.tag, ciphertext: envelope.ciphertext }));
  } catch (error) {
    key.fill(0);
    return { state: "error", error: unreadable("The saved keys could not be decrypted with this computer's home key.", error) };
  } finally {
    subkey.fill(0);
  }
  const version = isRecord(plaintext) ? contractNumber(plaintext.contractVersion, "aiboard.home-credentials.") : undefined;
  if (!isRecord(plaintext) || version === undefined || !isRecord(plaintext.providers) || !isRecord(plaintext.customModels)) {
    key.fill(0);
    return { state: "error", error: unreadable("The saved keys are not in a known format.") };
  }
  const credentials = plaintext as AiboardHomeCredentialsV1;
  for (const group of [credentials.providers, credentials.customModels]) {
    for (const [id, entry] of Object.entries(group)) if (!isCredential(entry)) delete group[id];
  }
  if (credentials.remoteMcpAuthorizationToken !== undefined && !isCredential(credentials.remoteMcpAuthorizationToken)) delete credentials.remoteMcpAuthorizationToken;
  return { state: "ok", credentials, newer: version > HOME_CREDENTIALS_CONTRACT_NUMBER, key };
}

function isCredential(value: unknown): value is HomeCredentialV1 {
  return isRecord(value) && typeof value.secret === "string" && value.secret.length > 0 && typeof value.boundUpstream === "string" && typeof value.savedAt === "string";
}

function encryptCredentials(key: Buffer, credentials: AiboardHomeCredentialsV1): string {
  const subkey = credentialsKey(key);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derived = scryptSync(subkey, salt, 32);
  const plaintext = Buffer.from(JSON.stringify(credentials));
  try {
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: CredentialsEnvelope = {
      version: 1,
      keyId: homeKeyId(key),
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return `${JSON.stringify(envelope)}\n`;
  } finally {
    plaintext.fill(0);
    derived.fill(0);
    subkey.fill(0);
  }
}

function credentialEntries(credentials: AiboardHomeCredentialsV1): Array<[Section, HomeCredentialV1]> {
  const entries: Array<[Section, HomeCredentialV1]> = [];
  for (const [id, entry] of Object.entries(credentials.providers)) entries.push([{ kind: "credential", target: "providers", id }, entry]);
  for (const [id, entry] of Object.entries(credentials.customModels)) entries.push([{ kind: "credential", target: "customModels", id }, entry]);
  if (credentials.remoteMcpAuthorizationToken) entries.push([{ kind: "credentialRemoteMcp" }, credentials.remoteMcpAuthorizationToken]);
  return entries;
}

function getCredential(credentials: AiboardHomeCredentialsV1, section: Section): HomeCredentialV1 | undefined {
  if (section.kind === "credential") return Object.hasOwn(credentials[section.target], section.id) ? credentials[section.target][section.id] : undefined;
  if (section.kind === "credentialRemoteMcp") return credentials.remoteMcpAuthorizationToken;
  return undefined;
}

function setCredential(credentials: AiboardHomeCredentialsV1, section: Section, value: HomeCredentialV1 | undefined): void {
  if (section.kind === "credential") {
    if (value) credentials[section.target][section.id] = value;
    else delete credentials[section.target][section.id];
  } else if (section.kind === "credentialRemoteMcp") {
    if (value) credentials.remoteMcpAuthorizationToken = value;
    else delete credentials.remoteMcpAuthorizationToken;
  }
}

function statusOf(config: AiboardHomeConfigV1, credentials: AiboardHomeCredentialsV1): { status: HomeCredentialStatusV1; secrets: Map<string, string> } {
  const status: HomeCredentialStatusV1 = { providers: {}, customModels: {} };
  const secrets = new Map<string, string>();
  for (const [section, entry] of credentialEntries(credentials)) {
    if (entry.boundUpstream !== currentUpstream(config, section)) continue;
    secrets.set(sectionPath(section), entry.secret);
    const hint = { keyHint: keyHint(entry.secret) };
    if (section.kind === "credential") status[section.target][section.id] = hint;
    else status.remoteMcpAuthorizationToken = hint;
  }
  return { status, secrets };
}

// ------------------------------------------------------------------ reads

/**
 * Reads take no lock: a rename is atomic, so each file is whole. Credentials are read only when asked
 * (`aiboard config` reads settings alone). A key is returned only while bound to its current upstream,
 * so a new config.json beside an old credentials.json never sends an old key to a new host.
 */
export async function readAiboardHome(location: AiboardHomeLocation, options: { credentials?: boolean } = {}): Promise<AiboardHomeSnapshot> {
  const now = new Date().toISOString();
  const exists = verifyHomeDirectory(location, { create: false });
  const configRead: ConfigRead = exists ? await readConfig(location, now) : { config: defaultConfig(now), exists: false, newer: false };
  let status: HomeCredentialStatusV1 | undefined;
  let secrets = new Map<string, string>();
  let credentialsNewer = false;
  if (options.credentials !== false) {
    const read: CredentialsRead = exists ? await readCredentials(location) : { state: "absent" };
    if (read.state === "error") throw read.error;
    if (read.state === "ok") {
      read.key.fill(0);
      credentialsNewer = read.newer;
      ({ status, secrets } = statusOf(configRead.config, read.credentials));
    } else {
      status = { providers: {}, customModels: {} };
    }
  }
  const config = configRead.config;
  return Object.freeze({
    location,
    exists: configRead.exists,
    revision: config.revision,
    config,
    writable: !configRead.newer && !credentialsNewer,
    ...(status ? { credentials: status } : {}),
    secret: (path: string) => secrets.get(path),
  });
}

// ------------------------------------------------------------------ op validation

function stringOrNull(value: unknown, label: string, max = 2048): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) throw invalid(`${label} must be a string or null.`);
  return value;
}

function stringArrayOrNull(value: unknown, label: string): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 4096 || !value.every((item) => typeof item === "string" && item.length <= 512)) throw invalid(`${label} must be a list of strings or null.`);
  return [...value];
}

function booleanOrNull(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") throw invalid(`${label} must be true, false or null.`);
  return value;
}

const PROVIDER_FIELD_VALIDATORS: Readonly<Record<keyof HomeProviderFields, (value: unknown, label: string) => unknown>> = {
  enabled: (value, label) => { if (typeof value !== "boolean") throw invalid(`${label} must be true or false.`); return value; },
  baseUrl: (value, label) => { const url = stringOrNull(value, label); if (url === null || url === "") return null; normalizeUpstream(url); return url; },
  models: stringArrayOrNull,
  enabledModelIds: stringArrayOrNull,
  defaultModel: (value, label) => stringOrNull(value, label, 512),
  lastValidationSucceeded: booleanOrNull,
  lastValidatedAt: (value, label) => stringOrNull(value, label, 64),
};

function providerDefaults(): HomeProviderFields {
  return { enabled: false, baseUrl: null, models: null, enabledModelIds: null, defaultModel: null, lastValidationSucceeded: null, lastValidatedAt: null };
}

function validatedFields<T extends string>(value: unknown, validators: Readonly<Record<T, (value: unknown, label: string) => unknown>>, label: string): Partial<Record<T, unknown>> {
  if (!isRecord(value)) throw invalid(`${label} must be an object.`);
  const result: Partial<Record<T, unknown>> = {};
  for (const [field, item] of Object.entries(value)) {
    if (!Object.hasOwn(validators, field)) throw invalid(`${label}.${field} is not a field the AIBoard home keeps.`);
    result[field as T] = validators[field as T](item, `${label}.${field}`);
  }
  return result;
}

const CUSTOM_MODEL_FIELD_VALIDATORS: Readonly<Record<string, (value: unknown, label: string) => unknown>> = {
  id: (value, label) => { if (typeof value !== "string") throw invalid(`${label} must be a string.`); return value; },
  label: (value, label) => { if (typeof value !== "string" || value.length > 512) throw invalid(`${label} must be a string.`); return value; },
  baseURL: (value, label) => { if (typeof value !== "string") throw invalid(`${label} must be a URL.`); normalizeUpstream(value); return value; },
  model: (value, label) => { if (typeof value !== "string" || value.length === 0 || value.length > 512) throw invalid(`${label} must be a model name.`); return value; },
  createdAt: (value, label) => { if (typeof value !== "string" || value.length > 64) throw invalid(`${label} must be a timestamp.`); return value; },
  capabilities: (value, label) => {
    if (!isRecord(value) || !["image", "document", "audio", "video"].every((key) => typeof value[key] === "boolean") || Object.keys(value).some((key) => !["image", "document", "audio", "video"].includes(key))) {
      throw invalid(`${label} must name image, document, audio and video as true or false.`);
    }
    return { ...value };
  },
  toolCapabilityOverrides: (value, label) => { if (!Array.isArray(value) || !isJsonValue(value)) throw invalid(`${label} must be a list.`); return clone(value); },
  compatibleTransports: (value, label) => { const list = stringArrayOrNull(value, label); if (list === null) throw invalid(`${label} must be a list.`); return list; },
  reasoningEffort: (value, label) => { if (typeof value !== "string" || value.length > 64) throw invalid(`${label} must be a string.`); return value; },
  lastValidationSucceeded: booleanOrNull,
  lastValidatedAt: (value, label) => stringOrNull(value, label, 64),
};

const SETTING_VALIDATORS: Readonly<Record<HomeSettingsField, (value: unknown, label: string) => unknown>> = {
  defaultEffort: shortString, defaultMode: shortString, defaultVerbosity: shortString, defaultReasoningEffort: shortString,
  defaultBuildRunPolicy: shortString, defaultBuildSkillMode: shortString,
  judgeModelId: (value, label) => stringOrNull(value, label, 512),
  defaultStyleNote: (value, label) => { if (typeof value !== "string" || value.length > 8192) throw invalid(`${label} must be a string.`); return value; },
  defaultBuildBudgetUsd: nonNegativeNumber, defaultBuildTimeLimitMinutes: nonNegativeNumber,
  defaultBuildAlwaysRequireIndependentVerifier: (value, label) => { if (typeof value !== "boolean") throw invalid(`${label} must be true or false.`); return value; },
  modelPricingOverrides: jsonObject, modelContextOverrides: jsonObject, discoveredModelMetadata: jsonObject, modelCapabilityProfiles: jsonObject,
  providerToolCapabilityEvidence: (value, label) => { if (!Array.isArray(value) || !isJsonValue(value)) throw invalid(`${label} must be a list.`); return clone(value); },
  toolRuntime: toolRuntimeValue,
};

function shortString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64) throw invalid(`${label} must be a short string.`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw invalid(`${label} must be a number of zero or more.`);
  return value;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || !isJsonValue(value)) throw invalid(`${label} must be an object of plain JSON values.`);
  return clone(value);
}

function toolRuntimeValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(`${label} must be an object.`);
  const result: Record<string, unknown> = {};
  for (const [field, item] of Object.entries(value)) {
    if ((BROWSER_ONLY_TOOL_RUNTIME_FIELDS as readonly string[]).includes(field)) throw invalid(`${label}.${field} names a Runner and stays in the browser.`);
    if (field === "remoteMcpServer") {
      if (item === null) { result[field] = null; continue; }
      if (!isRecord(item)) throw invalid(`${label}.remoteMcpServer must be an object or null.`);
      for (const key of Object.keys(item)) {
        if ((REMOTE_MCP_SERVER_SECRET_FIELDS as readonly string[]).includes(key)) throw invalid(`${label}.remoteMcpServer.${key} is a secret; save it at credentials.remoteMcpAuthorizationToken.`);
        if (!(REMOTE_MCP_SERVER_HOME_FIELDS as readonly string[]).includes(key)) throw invalid(`${label}.remoteMcpServer.${key} is not a field the AIBoard home keeps.`);
      }
      if (typeof item.enabled !== "boolean" || typeof item.name !== "string" || typeof item.url !== "string") throw invalid(`${label}.remoteMcpServer needs enabled, name and url.`);
      if (item.url) normalizeUpstream(item.url);
      result[field] = { enabled: item.enabled, name: item.name, url: item.url };
    } else if (field === "openaiFileSearch") {
      if (item === null) { result[field] = null; continue; }
      if (!isRecord(item) || typeof item.enabled !== "boolean" || stringArrayOrNull(item.vectorStoreIds, `${label}.openaiFileSearch.vectorStoreIds`) === null || Object.keys(item).some((key) => key !== "enabled" && key !== "vectorStoreIds")) {
        throw invalid(`${label}.openaiFileSearch needs enabled and vectorStoreIds.`);
      }
      result[field] = { enabled: item.enabled, vectorStoreIds: [...(item.vectorStoreIds as string[])] };
    } else {
      throw invalid(`${label}.${field} is not a field the AIBoard home keeps.`);
    }
  }
  return result;
}

function secretValue(value: unknown, label: string): string {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "secret")) throw invalid(`${label} takes {"secret": "..."} only.`);
  const secret = value.secret;
  // eslint-disable-next-line no-control-regex
  if (typeof secret !== "string" || secret.length === 0 || secret.length > MAX_SECRET_LENGTH || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw invalid(`${label}.secret must be a non-empty single-line string.`);
  }
  return secret;
}

// ------------------------------------------------------------------ op application

function unknownFields(entry: Record<string, unknown> | undefined, known: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!entry) return result;
  for (const [key, value] of Object.entries(entry)) if (!known.includes(key)) result[key] = value;
  return result;
}

function applyConfigOp(config: AiboardHomeConfigV1, section: Section, op: HomeOp, now: string): void {
  const label = op.path;
  if (op.value !== undefined && !isJsonValue(op.value)) throw invalid(`${label}: the value must be plain JSON.`);
  switch (section.kind) {
    case "provider": {
      const existing = Object.hasOwn(config.providers, section.id) ? config.providers[section.id] : undefined;
      if (op.op === "remove") { delete config.providers[section.id]; return; }
      const fields = validatedFields(op.value, PROVIDER_FIELD_VALIDATORS, label);
      const known = Object.keys(PROVIDER_FIELD_VALIDATORS);
      const base: HomeProviderFields = op.op === "set" || !existing ? providerDefaults() : pickFields(existing, known) as unknown as HomeProviderFields;
      config.providers[section.id] = { ...unknownFields(existing, known), ...base, ...fields } as HomeProviderV1;
      return;
    }
    case "customModel": {
      const index = config.customModels.findIndex((entry) => entry.id === section.id);
      const existing = index >= 0 ? config.customModels[index] : undefined;
      if (op.op === "remove") { if (index >= 0) config.customModels.splice(index, 1); return; }
      const fields = validatedFields(op.value, CUSTOM_MODEL_FIELD_VALIDATORS, label);
      if (fields.id !== undefined && fields.id !== section.id) throw invalid(`${label}.id must equal the id in the path.`);
      const known = Object.keys(CUSTOM_MODEL_FIELD_VALIDATORS);
      const base = op.op === "set" || !existing ? {} : pickFields(existing, known);
      const next = { ...unknownFields(existing, known), ...base, ...fields, id: section.id } as Record<string, unknown>;
      next.createdAt ??= now;
      if (typeof next.label !== "string" || typeof next.baseURL !== "string" || typeof next.model !== "string") {
        throw invalid(`${label} needs label, baseURL and model.`);
      }
      if (index >= 0) config.customModels[index] = next as HomeCustomModelV1;
      else config.customModels.push(next as HomeCustomModelV1);
      return;
    }
    case "openAIConnectionMode": {
      if (op.op === "remove") { config.openAIConnectionMode = "api"; return; }
      if (op.op !== "set" || (op.value !== "api" && op.value !== "subscription")) throw invalid(`${label} takes set with "api" or "subscription".`);
      config.openAIConnectionMode = op.value;
      return;
    }
    case "setting": {
      const field = section.field;
      if (op.op === "remove" || (op.op === "set" && op.value === null && field !== "judgeModelId")) { delete config.settings[field]; return; }
      if (op.op === "set") { config.settings[field] = SETTING_VALIDATORS[field](op.value, label); return; }
      // merge: named fields of an object-valued setting; a null value removes that field.
      if (!isRecord(op.value)) throw invalid(`${label}: merge takes an object.`);
      const current = isRecord(config.settings[field]) ? clone(config.settings[field] as Record<string, unknown>) : {};
      for (const [key, value] of Object.entries(op.value)) {
        if (value === null && field !== "toolRuntime") delete current[key];
        else current[key] = value;
      }
      config.settings[field] = SETTING_VALIDATORS[field](current, label);
      return;
    }
    case "settingEntry": {
      const map = isRecord(config.settings[section.field]) ? clone(config.settings[section.field] as Record<string, unknown>) : {};
      if (op.op === "remove" || (op.op === "set" && op.value === null)) delete map[section.entry];
      else if (op.op === "set") map[section.entry] = clone(op.value);
      else {
        if (!isRecord(op.value)) throw invalid(`${label}: merge takes an object.`);
        const current = isRecord(map[section.entry]) ? map[section.entry] as Record<string, unknown> : {};
        for (const [key, value] of Object.entries(op.value)) {
          if (value === null) delete current[key];
          else current[key] = value;
        }
        map[section.entry] = current;
      }
      config.settings[section.field] = jsonObject(map, `settings.${section.field}`);
      return;
    }
    default:
      throw invalid(`${label} is not a settings section.`);
  }
}

function pickFields(entry: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of known) if (Object.hasOwn(entry, key)) result[key] = entry[key];
  return result;
}

function sectionValue(config: AiboardHomeConfigV1, credentials: AiboardHomeCredentialsV1 | undefined, section: Section): unknown {
  switch (section.kind) {
    case "provider": return Object.hasOwn(config.providers, section.id) ? clone(config.providers[section.id]) : null;
    case "customModel": return clone(config.customModels.find((entry) => entry.id === section.id) ?? null);
    case "openAIConnectionMode": return config.openAIConnectionMode;
    case "setting": return Object.hasOwn(config.settings, section.field) ? clone(config.settings[section.field] ?? null) : null;
    case "settingEntry": {
      const map = config.settings[section.field];
      return isRecord(map) && Object.hasOwn(map, section.entry) ? clone(map[section.entry]) : null;
    }
    case "credential":
    case "credentialRemoteMcp": {
      if (!credentials) return { hasKey: null };
      const entry = getCredential(credentials, section);
      return entry && entry.boundUpstream === currentUpstream(config, section) ? { hasKey: true, keyHint: keyHint(entry.secret) } : { hasKey: false };
    }
  }
}

function validateBatch(batch: HomeBatch): Array<{ op: HomeOp; section: Section }> {
  if (!isRecord(batch) || !Number.isSafeInteger(batch.baseRevision) || batch.baseRevision < 0) throw invalid("A batch needs a baseRevision of zero or more.");
  if (!Array.isArray(batch.ops) || batch.ops.length === 0 || batch.ops.length > MAX_OPS) throw invalid(`A batch needs 1 to ${MAX_OPS} ops.`);
  return batch.ops.map((candidate: unknown) => {
    if (!isRecord(candidate) || typeof candidate.path !== "string" || !["set", "merge", "remove"].includes(candidate.op as string)) {
      throw invalid("Each op needs a path and an op of set, merge or remove.");
    }
    const op = candidate as unknown as HomeOp;
    if (op.op !== "remove" && op.value === undefined) throw invalid(`${op.path}: ${op.op} needs a value.`);
    return { op, section: parseHomePath(op.path) };
  });
}

/** The section that holds a credential's upstream: a key is bound to the URL its writer saw there. */
function upstreamSection(section: Section): Section | undefined {
  if (section.kind === "credential") return section.target === "providers" ? { kind: "provider", id: section.id } : { kind: "customModel", id: section.id };
  if (section.kind === "credentialRemoteMcp") return { kind: "setting", field: "toolRuntime" };
  return undefined;
}

/**
 * The sections whose current values a home_conflict reports: every touched section that changed after
 * baseRevision, and for a credential also the section holding its upstream when that changed, so a key
 * entered against URL A is never bound to a URL B the writer did not see.
 */
function conflictingSections(config: AiboardHomeConfigV1, baseRevision: number, touched: Section[]): Section[] {
  const conflicts = new Map<string, Section>();
  const recorded = Object.entries(config.pathRevisions).filter(([, revision]) => revision > baseRevision).map(([recordedPath]) => {
    let segments: string[] | undefined;
    try { segments = sectionSegments(parseHomePath(recordedPath)); } catch { segments = undefined; }
    return { recordedPath, segments };
  });
  const changed = (section: Section): boolean => {
    const segments = sectionSegments(section);
    const path = sectionPath(section);
    return recorded.some((entry) => entry.recordedPath === path || (entry.segments !== undefined && overlaps(segments, entry.segments)));
  };
  for (const section of touched) {
    const holder = upstreamSection(section);
    const holderChanged = holder !== undefined && changed(holder);
    if (changed(section) || holderChanged) conflicts.set(sectionPath(section), section);
    if (holder && holderChanged) conflicts.set(sectionPath(holder), holder);
  }
  return [...conflicts.values()];
}

// ------------------------------------------------------------------ writes

/**
 * Apply one batch, all or nothing. Refusals: home_unsafe, home_busy (the lock stayed held for 5 s),
 * home_newer, home_conflict (a touched section changed after baseRevision; details carry the current
 * revision and values), home_invalid_op, and for a batch that touches credentials home_key_mismatch
 * or home_unreadable. A batch that changes a base URL also removes the key bound to the old one.
 */
export async function applyHomeBatch(location: AiboardHomeLocation, batch: HomeBatch, options: HomeWriteOptions = {}): Promise<HomeWriteResult> {
  const parsed = validateBatch(batch);
  return await withHomeLock(location, options, async (now) => {
    const configRead = await readConfig(location, now);
    if (configRead.newer) throw new AiboardHomeError("home_newer", "The AIBoard home was saved by a newer AI Board; update AI Board to change it.");
    const config = configRead.config;
    const touchesCredentials = parsed.some(({ section }) => section.kind === "credential" || section.kind === "credentialRemoteMcp");
    const read = await readCredentials(location);
    let credentials: AiboardHomeCredentialsV1 | undefined;
    let key: Buffer | undefined;
    if (read.state === "ok") {
      if (read.newer && touchesCredentials) { read.key.fill(0); throw new AiboardHomeError("home_newer", "The saved keys were written by a newer AI Board; update AI Board to change them."); }
      if (!read.newer) { credentials = read.credentials; key = read.key; }
      else read.key.fill(0);
    } else if (read.state === "absent") {
      credentials = emptyCredentials();
    } else if (touchesCredentials) {
      throw read.error;
    }
    try {
      const conflicts = conflictingSections(config, batch.baseRevision, parsed.map(({ section }) => section));
      if (conflicts.length > 0) {
        const sections: Record<string, unknown> = {};
        for (const section of conflicts) sections[sectionPath(section)] = sectionValue(config, credentials, section);
        throw new AiboardHomeError("home_conflict", "A section of this batch changed after its base revision; re-apply the change to the current values.",
          { currentRevision: config.revision, sections } satisfies HomeConflictDetails);
      }
      const nextConfig = clone(config);
      const nextCredentials = credentials ? clone(credentials) : undefined;
      const touched = new Set<string>();
      const credentialOps: Array<{ op: HomeOp; section: Section }> = [];
      for (const entry of parsed) {
        touched.add(sectionPath(entry.section));
        if (entry.section.kind === "credential" || entry.section.kind === "credentialRemoteMcp") credentialOps.push(entry);
        else applyConfigOp(nextConfig, entry.section, entry.op, now);
      }
      const setInBatch = new Set<string>();
      for (const { op, section } of credentialOps) {
        if (!nextCredentials) throw new Error("credentials were not read");
        if (op.op === "merge") throw invalid(`${op.path}: a credential takes set or remove.`);
        if (op.op === "remove" || op.value === null) { setCredential(nextCredentials, section, undefined); setInBatch.delete(sectionPath(section)); continue; }
        const secret = secretValue(op.value, op.path);
        const upstream = currentUpstream(nextConfig, section);
        if (upstream === undefined) throw invalid(`${op.path}: there is no ${section.kind === "credentialRemoteMcp" ? "remote MCP server URL" : "custom model"} to bind this key to.`);
        setCredential(nextCredentials, section, { ...unknownFields(getCredential(nextCredentials, section), ["secret", "boundUpstream", "savedAt"]), secret, boundUpstream: upstream, savedAt: now });
        setInBatch.add(sectionPath(section));
      }
      // The base-URL rule: a key no longer bound to its section's current upstream is removed.
      const removedCredentials: string[] = [];
      if (nextCredentials) {
        for (const [section, entry] of credentialEntries(nextCredentials)) {
          const path = sectionPath(section);
          if (setInBatch.has(path)) continue;
          if (entry.boundUpstream !== currentUpstream(nextConfig, section)) {
            setCredential(nextCredentials, section, undefined);
            removedCredentials.push(path);
            touched.add(path);
          }
        }
      }
      const credentialsChanged = nextCredentials !== undefined && credentials !== undefined && JSON.stringify(nextCredentials) !== JSON.stringify(credentials);
      const revision = config.revision + 1;
      nextConfig.revision = revision;
      nextConfig.updatedAt = now;
      nextConfig.pathRevisions = { ...nextConfig.pathRevisions };
      for (const path of touched) nextConfig.pathRevisions[path] = revision;
      if (credentialsChanged && nextCredentials) {
        key ??= createHomeKey(location);
        await writeAtomic(location.credentialsPath, encryptCredentials(key, nextCredentials), location.platform);
        await options.afterCredentialsWrite?.();
      }
      await writeAtomic(location.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, location.platform);
      return { revision, touched: [...touched], removedCredentials };
    } finally {
      key?.fill(0);
    }
  });
}

/**
 * `aiboard keys reset` (§6.6), after the user confirmed: replaces every saved key with none, under
 * this computer's home key (created when missing, replaced when corrupt). Used after home_key_mismatch
 * or home_unreadable; settings in config.json are kept.
 */
export async function resetHomeCredentials(location: AiboardHomeLocation, options: HomeWriteOptions = {}): Promise<HomeWriteResult> {
  return await withHomeLock(location, options, async (now) => {
    const configRead = await readConfig(location, now);
    if (configRead.newer) throw new AiboardHomeError("home_newer", "The AIBoard home was saved by a newer AI Board; update AI Board to change it.");
    const keyRead = readHomeKey(location);
    if ("corrupt" in keyRead) unlinkSync(location.keyPath);
    const key = "key" in keyRead ? keyRead.key : createHomeKey(location);
    try {
      const config = clone(configRead.config);
      const revision = config.revision + 1;
      const touched = Object.keys(config.pathRevisions).filter((path) => path.startsWith("credentials."));
      config.revision = revision;
      config.updatedAt = now;
      for (const path of touched) config.pathRevisions[path] = revision;
      await writeAtomic(location.credentialsPath, encryptCredentials(key, emptyCredentials()), location.platform);
      await options.afterCredentialsWrite?.();
      await writeAtomic(location.configPath, `${JSON.stringify(config, null, 2)}\n`, location.platform);
      return { revision, touched, removedCredentials: [] };
    } finally {
      key.fill(0);
    }
  });
}

/**
 * This process's writers, queued per lock file. On POSIX, closing ANY descriptor of a file releases every
 * fcntl lock the process holds on it, SQLite's included, and acquireLockFile's identity check opens and
 * closes the lock file on every poll. So a second writer in this process must never probe the file while
 * the first holds it, or a writer in another process could enter at the same time. The in-process wait
 * shares the lock budget and ends in home_busy like the file lock's.
 */
const inProcessHomeWriters = new Map<string, Promise<void>>();

function inProcessLockKey(location: AiboardHomeLocation): string {
  const path = location.lockPath;
  return location.platform === "win32" || location.platform === "darwin" ? path.toLowerCase() : path;
}

function homeBusy(): AiboardHomeError {
  return new AiboardHomeError("home_busy", "Another AI Board surface is saving the AIBoard home; try again in a moment.");
}

async function withHomeLock<T>(location: AiboardHomeLocation, options: HomeWriteOptions, action: (now: string) => Promise<T>): Promise<T> {
  verifyHomeDirectory(location, { create: true });
  const deadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  const key = inProcessLockKey(location);
  const previous = inProcessHomeWriters.get(key) ?? Promise.resolve();
  let finishLocal!: () => void;
  const local = new Promise<void>((resolveLocal) => { finishLocal = resolveLocal; });
  // The next writer waits for this one AND every one before it, even if this one gives up early.
  const tail = previous.then(() => local);
  inProcessHomeWriters.set(key, tail);
  try {
    let timer: NodeJS.Timeout | undefined;
    const turn = await Promise.race([
      previous.then(() => true),
      new Promise<false>((resolveWait) => { timer = setTimeout(() => resolveWait(false), Math.max(0, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    if (!turn) throw homeBusy();
    const release = await acquireLockFile(location.lockPath, Math.max(0, deadline - Date.now()));
    if (!release) throw homeBusy();
    try {
      return await action((options.now?.() ?? new Date()).toISOString());
    } finally {
      release();
    }
  } finally {
    finishLocal();
    if (inProcessHomeWriters.get(key) === tail) inProcessHomeWriters.delete(key);
  }
}

// ------------------------------------------------------------------ web shapes

/** The web's settings shapes (lib/db/schema.ts), as far as the home needs them; runner code never imports lib/. */
export interface WebSettingsInput {
  settings?: Record<string, unknown>;
  providerKeys?: ReadonlyArray<Record<string, unknown>>;
  customModels?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * The ops that save the web's UserSettings, ProviderKey and CustomModel records to the home: only the
 * allow-listed fields go to config.json, every secret goes to a credential path, and the browser-only
 * and not-stored fields go nowhere.
 */
export function homeOpsFromWebState(input: WebSettingsInput): HomeOp[] {
  const ops: HomeOp[] = [];
  const settings = input.settings ?? {};
  for (const field of HOME_SETTINGS_FIELDS) {
    const value = settings[field];
    if (value === undefined) continue;
    if (field === "toolRuntime") {
      if (!isRecord(value)) continue;
      const runtime: Record<string, unknown> = {};
      for (const key of HOME_TOOL_RUNTIME_FIELDS) {
        const item = value[key];
        if (item === undefined) continue;
        if (key === "remoteMcpServer" && isRecord(item)) runtime[key] = pickFields(item, REMOTE_MCP_SERVER_HOME_FIELDS);
        else runtime[key] = item;
      }
      ops.push({ path: "settings.toolRuntime", op: "set", value: runtime });
      continue;
    }
    ops.push({ path: `settings.${field}`, op: "set", value });
  }
  if (settings.openAIConnectionMode !== undefined) ops.push({ path: "openAIConnectionMode", op: "set", value: settings.openAIConnectionMode });
  const remote = isRecord(settings.toolRuntime) && isRecord(settings.toolRuntime.remoteMcpServer) ? settings.toolRuntime.remoteMcpServer : undefined;
  if (remote && typeof remote.authorizationToken === "string" && remote.authorizationToken) {
    ops.push({ path: "credentials.remoteMcpAuthorizationToken", op: "set", value: { secret: remote.authorizationToken } });
  }
  for (const key of input.providerKeys ?? []) {
    const id = key.providerId;
    if (typeof id !== "string") continue;
    const value: Record<string, unknown> = {};
    for (const [webField, homeField] of Object.entries(PROVIDER_KEY_HOME_FIELDS)) {
      if (key[webField] !== undefined) value[homeField] = key[webField];
    }
    ops.push({ path: `providers.${id}`, op: "set", value });
    if (typeof key.apiKey === "string" && key.apiKey) ops.push({ path: `credentials.providers.${id}`, op: "set", value: { secret: key.apiKey } });
  }
  for (const model of input.customModels ?? []) {
    const id = model.id;
    if (typeof id !== "string") continue;
    ops.push({ path: `customModels.${id}`, op: "set", value: pickFields(model, CUSTOM_MODEL_HOME_FIELDS) });
    if (typeof model.apiKey === "string" && model.apiKey) ops.push({ path: `credentials.customModels.${id}`, op: "set", value: { secret: model.apiKey } });
  }
  return ops;
}
