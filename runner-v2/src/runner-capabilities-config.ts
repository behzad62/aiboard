import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

import {
  parseLanguageProviderDescriptor,
  type LanguageProviderDescriptor,
} from "./language-intelligence.js";
import type { LanguageServerExecutableIdentity } from "./language-server-executable.js";

const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_EXTENSIONS = 64;
const MAX_LANGUAGE_SERVERS = 32;
const MAX_ISOLATION_PROVIDERS = 8;
const TOP_LEVEL_KEYS = new Set([
  "version", "extensions", "languageServers", "isolationProviders",
]);
const ISOLATION_PROVIDER_KEYS = new Set([
  "id", "type", "cliPath", "image", "allowNetwork",
]);
const LANGUAGE_SERVER_KEYS = new Set([
  "id",
  "displayName",
  "extensions",
  "rootMarkers",
  "priority",
  "languageId",
  "command",
  "args",
  "requestTimeoutMs",
  "shutdownTimeoutMs",
  "restartLimit",
  "maxFrameBytes",
  "maxPendingRequests",
  "maxDocumentBytes",
]);

export type RunnerCapabilitiesConfigErrorCode =
  | "invalid_config_path"
  | "config_unavailable"
  | "symbolic_config"
  | "config_too_large"
  | "invalid_json"
  | "invalid_shape"
  | "unknown_field"
  | "unsupported_version"
  | "invalid_extension_path"
  | "duplicate_extension_path"
  | "invalid_language_server"
  | "duplicate_language_provider"
  | "invalid_isolation_provider"
  | "duplicate_isolation_provider";

export class RunnerCapabilitiesConfigError extends Error {
  constructor(
    readonly code: RunnerCapabilitiesConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerCapabilitiesConfigError";
  }
}

export interface ConfiguredLanguageServer {
  descriptor: LanguageProviderDescriptor;
  languageId: string;
  command: string;
  args: string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartLimit?: number;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
  maxDocumentBytes?: number;
  /** Runner-owned attestation; configuration JSON can never provide this field. */
  commandIdentity?: LanguageServerExecutableIdentity;
}

export interface RunnerCapabilitiesConfig {
  extensions: string[];
  languageServers: ConfiguredLanguageServer[];
  isolationProviders?: ConfiguredOciIsolationProvider[];
}

export interface ConfiguredOciIsolationProvider {
  id: string;
  type: "oci";
  cliPath: string;
  image: string;
  allowNetwork: boolean;
  /** Runner-owned executable identity; configuration JSON cannot provide this field. */
  cliIdentity?: Readonly<{ path: string; digest: string }>;
}

export function emptyRunnerCapabilitiesConfig(): RunnerCapabilitiesConfig {
  return { extensions: [], languageServers: [] };
}

export async function resolveRunnerCapabilitiesConfigPath(
  pathValue: string,
): Promise<string> {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue) || pathValue.includes("\0")) {
    throw new RunnerCapabilitiesConfigError(
      "invalid_config_path",
      "Runner capabilities configuration path must be absolute.",
    );
  }
  const requested = resolve(pathValue);
  let metadata;
  try {
    metadata = await lstat(requested);
  } catch (error) {
    throw new RunnerCapabilitiesConfigError(
      "config_unavailable",
      "Runner capabilities configuration does not exist.",
      { cause: error },
    );
  }
  if (metadata.isSymbolicLink()) {
    throw new RunnerCapabilitiesConfigError(
      "symbolic_config",
      "Runner capabilities configuration cannot be a symbolic link.",
    );
  }
  if (!metadata.isFile()) {
    throw new RunnerCapabilitiesConfigError(
      "config_unavailable",
      "Runner capabilities configuration must be a regular file.",
    );
  }
  const actual = resolve(await realpath(requested));
  if (normalizePath(actual) !== normalizePath(requested)) {
    if (await pathHasUntrustedSymbolicParent(requested)) {
      throw new RunnerCapabilitiesConfigError(
        "symbolic_config",
        "Runner capabilities configuration resolves through a symbolic path.",
      );
    }
    const actualMetadata = await stat(actual);
    if (actualMetadata.dev !== metadata.dev || actualMetadata.ino !== metadata.ino) {
      throw new RunnerCapabilitiesConfigError(
        "symbolic_config",
        "Runner capabilities configuration resolves through a symbolic path.",
      );
    }
  }
  return actual;
}

export async function capabilitiesConfigCanonicalTargetIsInsideProject(
  projectPath: string,
  configPath: string,
): Promise<boolean> {
  if (typeof projectPath !== "string" || !isAbsolute(projectPath) || projectPath.includes("\0")) {
    throw new RunnerCapabilitiesConfigError(
      "invalid_config_path",
      "Runner capabilities configuration project path must be absolute.",
    );
  }
  const requested = resolve(configPath);
  const canonicalConfig = await resolveRunnerCapabilitiesConfigPath(requested);
  const canonicalProject = resolve(await realpath(projectPath));
  return isResolvedPathInside(resolve(projectPath), requested)
    || isResolvedPathInside(canonicalProject, canonicalConfig);
}

export async function loadRunnerCapabilitiesConfig(
  pathValue: string,
): Promise<RunnerCapabilitiesConfig> {
  const actual = await resolveRunnerCapabilitiesConfigPath(pathValue);
  const source = await readFile(actual);
  if (source.byteLength > MAX_CONFIG_BYTES) {
    throw new RunnerCapabilitiesConfigError(
      "config_too_large",
      `Runner capabilities configuration exceeds ${MAX_CONFIG_BYTES} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new RunnerCapabilitiesConfigError(
      "invalid_json",
      "Runner capabilities configuration is not valid JSON.",
      { cause: error },
    );
  }
  return parseRunnerCapabilitiesConfig(parsed);
}

export function parseRunnerCapabilitiesConfig(input: unknown): RunnerCapabilitiesConfig {
  const value = exactObject(input, TOP_LEVEL_KEYS, "capabilities configuration");
  if (value.version !== CONFIG_VERSION) {
    throw new RunnerCapabilitiesConfigError(
      "unsupported_version",
      `Runner capabilities configuration requires version ${CONFIG_VERSION}.`,
    );
  }
  if (!Array.isArray(value.extensions) || value.extensions.length > MAX_EXTENSIONS) {
    throw invalidShape(`extensions must be an array of at most ${MAX_EXTENSIONS} paths.`);
  }
  const extensions: string[] = [];
  const extensionKeys = new Set<string>();
  for (const item of value.extensions) {
    if (typeof item !== "string" || !isAbsolute(item) || item.includes("\0")) {
      throw new RunnerCapabilitiesConfigError(
        "invalid_extension_path",
        "Every allowlisted extension path must be absolute.",
      );
    }
    const path = resolve(item);
    const key = normalizePath(path);
    if (extensionKeys.has(key)) {
      throw new RunnerCapabilitiesConfigError(
        "duplicate_extension_path",
        `Duplicate allowlisted extension path ${path}.`,
      );
    }
    extensionKeys.add(key);
    extensions.push(path);
  }
  if (!Array.isArray(value.languageServers) ||
      value.languageServers.length > MAX_LANGUAGE_SERVERS) {
    throw invalidShape(
      `languageServers must be an array of at most ${MAX_LANGUAGE_SERVERS} entries.`,
    );
  }
  const languageServers: ConfiguredLanguageServer[] = [];
  const ids = new Set<string>();
  for (const item of value.languageServers) {
    const server = parseLanguageServer(item);
    if (ids.has(server.descriptor.id)) {
      throw new RunnerCapabilitiesConfigError(
        "duplicate_language_provider",
        `Duplicate language provider ${server.descriptor.id}.`,
      );
    }
    ids.add(server.descriptor.id);
    languageServers.push(server);
  }
  const isolationProviders = parseIsolationProviders(value.isolationProviders);
  return {
    extensions,
    languageServers,
    ...(value.isolationProviders === undefined ? {} : { isolationProviders }),
  };
}

function parseIsolationProviders(input: unknown): ConfiguredOciIsolationProvider[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_ISOLATION_PROVIDERS) {
    throw invalidIsolationProvider(
      `isolationProviders must be an array of at most ${MAX_ISOLATION_PROVIDERS} entries.`,
    );
  }
  const ids = new Set<string>();
  return input.map((entry) => {
    const value = exactObject(entry, ISOLATION_PROVIDER_KEYS, "isolation provider");
    if (value.type !== "oci") {
      throw invalidIsolationProvider("Isolation provider type must be oci.");
    }
    const id = typeof value.id === "string" &&
      /^[a-z][a-z0-9.-]{0,63}$/.test(value.id) ? value.id : undefined;
    if (!id) throw invalidIsolationProvider("Isolation provider id is invalid.");
    if (ids.has(id)) {
      throw new RunnerCapabilitiesConfigError(
        "duplicate_isolation_provider",
        `Duplicate isolation provider ${id}.`,
      );
    }
    ids.add(id);
    if (typeof value.cliPath !== "string" || !isAbsolute(value.cliPath) ||
        value.cliPath.includes("\0")) {
      throw invalidIsolationProvider(`${id} cliPath must be explicit and absolute.`);
    }
    if (typeof value.image !== "string" || !value.image.trim() ||
        value.image.includes("\0") || Buffer.byteLength(value.image) > 1024) {
      throw invalidIsolationProvider(`${id} image is invalid.`);
    }
    if (typeof value.allowNetwork !== "boolean") {
      throw invalidIsolationProvider(`${id} allowNetwork must be boolean.`);
    }
    return {
      id,
      type: "oci" as const,
      cliPath: resolve(value.cliPath),
      image: value.image,
      allowNetwork: value.allowNetwork,
    };
  });
}

function parseLanguageServer(input: unknown): ConfiguredLanguageServer {
  const value = exactObject(input, LANGUAGE_SERVER_KEYS, "language server");
  let descriptor: LanguageProviderDescriptor;
  try {
    descriptor = parseLanguageProviderDescriptor({
      id: value.id,
      displayName: value.displayName,
      extensions: value.extensions,
      rootMarkers: value.rootMarkers,
      priority: value.priority,
    });
  } catch (error) {
    throw new RunnerCapabilitiesConfigError(
      "invalid_language_server",
      boundedError(error),
      { cause: error },
    );
  }
  if (typeof value.languageId !== "string" ||
      !/^[a-z0-9][a-z0-9+_.-]{0,63}$/i.test(value.languageId)) {
    throw invalidLanguageServer(`${descriptor.id} has an invalid languageId.`);
  }
  const command = boundedString(value.command, `${descriptor.id} command`, 4_096);
  if (!Array.isArray(value.args) || value.args.length > 128) {
    throw invalidLanguageServer(`${descriptor.id} args must contain at most 128 strings.`);
  }
  const args = value.args.map((argument) =>
    boundedString(argument, `${descriptor.id} argument`, 4_096));
  return {
    descriptor,
    languageId: value.languageId,
    command,
    args,
    ...optionalInteger(value, "requestTimeoutMs", 1, 600_000, descriptor.id),
    ...optionalInteger(value, "shutdownTimeoutMs", 1, 60_000, descriptor.id),
    ...optionalInteger(value, "restartLimit", 0, 10, descriptor.id),
    ...optionalInteger(value, "maxFrameBytes", 1_024, 16 * 1024 * 1024, descriptor.id),
    ...optionalInteger(value, "maxPendingRequests", 1, 1_024, descriptor.id),
    ...optionalInteger(value, "maxDocumentBytes", 1, 32 * 1024 * 1024, descriptor.id),
  };
}

function optionalInteger(
  value: Record<string, unknown>,
  key: keyof ConfiguredLanguageServer,
  minimum: number,
  maximum: number,
  serverId: string,
): Partial<ConfiguredLanguageServer> {
  const candidate = value[key];
  if (candidate === undefined) return {};
  if (!Number.isSafeInteger(candidate) ||
      (candidate as number) < minimum || (candidate as number) > maximum) {
    throw invalidLanguageServer(
      `${serverId} ${String(key)} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return { [key]: candidate } as Partial<ConfiguredLanguageServer>;
}

function exactObject(
  input: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw invalidShape(`${label} must be an object.`);
  }
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new RunnerCapabilitiesConfigError(
      "unknown_field",
      `${label} contains unknown field ${unknown[0]}.`,
    );
  }
  return value;
}

function boundedString(input: unknown, label: string, maximumBytes: number): string {
  if (typeof input !== "string" || input.includes("\0")) {
    throw invalidLanguageServer(`${label} must be a string.`);
  }
  const value = input.trim();
  if (!value || Buffer.byteLength(value) > maximumBytes) {
    throw invalidLanguageServer(`${label} must contain 1 to ${maximumBytes} bytes.`);
  }
  return value;
}

function invalidShape(message: string): RunnerCapabilitiesConfigError {
  return new RunnerCapabilitiesConfigError("invalid_shape", message);
}

function invalidLanguageServer(message: string): RunnerCapabilitiesConfigError {
  return new RunnerCapabilitiesConfigError("invalid_language_server", message);
}

function invalidIsolationProvider(message: string): RunnerCapabilitiesConfigError {
  return new RunnerCapabilitiesConfigError("invalid_isolation_provider", message);
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isResolvedPathInside(parent: string, candidate: string): boolean {
  const traversal = relative(parent, candidate);
  return traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal));
}

async function pathHasUntrustedSymbolicParent(requested: string): Promise<boolean> {
  let current = dirname(requested);
  const root = parse(current).root || current;
  for (;;) {
    let parentMetadata;
    try {
      parentMetadata = await lstat(current);
    } catch {
      return true;
    }
    if (parentMetadata.isSymbolicLink() && !isTrustedOsAliasPrefix(current)) return true;
    if (current === root || dirname(current) === current) return false;
    current = dirname(current);
  }
}

function isTrustedOsAliasPrefix(pathValue: string): boolean {
  if (process.platform !== "darwin") return false;
  const normalized = resolve(pathValue);
  return normalized === "/var" || normalized === "/tmp" || normalized === "/etc";
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}
