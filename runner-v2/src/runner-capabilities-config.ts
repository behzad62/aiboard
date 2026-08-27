import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  parseLanguageProviderDescriptor,
  type LanguageProviderDescriptor,
} from "./language-intelligence.js";

const CONFIG_VERSION = 1;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_EXTENSIONS = 64;
const MAX_LANGUAGE_SERVERS = 32;
const TOP_LEVEL_KEYS = new Set(["version", "extensions", "languageServers"]);
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
  | "duplicate_language_provider";

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
}

export interface RunnerCapabilitiesConfig {
  extensions: string[];
  languageServers: ConfiguredLanguageServer[];
}

export function emptyRunnerCapabilitiesConfig(): RunnerCapabilitiesConfig {
  return { extensions: [], languageServers: [] };
}

export async function loadRunnerCapabilitiesConfig(
  pathValue: string,
): Promise<RunnerCapabilitiesConfig> {
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
  const actual = await realpath(requested);
  if (normalizePath(actual) !== normalizePath(requested)) {
    throw new RunnerCapabilitiesConfigError(
      "symbolic_config",
      "Runner capabilities configuration resolves through a symbolic path.",
    );
  }
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
  return { extensions, languageServers };
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

function normalizePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}
