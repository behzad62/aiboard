import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  RUNNER_EXTENSION_MANIFEST_FILE,
  parseRunnerExtensionManifest,
  type RunnerExtensionManifest,
} from "./runner-extension.js";
import type {
  ConfiguredLanguageServer,
  RunnerCapabilitiesConfig,
} from "./runner-capabilities-config.js";

export const RUNNER_CAPABILITY_CONTRACT_VERSION = 1 as const;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const BUILTIN_TYPESCRIPT_IDENTITY = "runner-v2/typescript-intelligence@1";

export type RunnerCapabilityContractErrorCode =
  | "capability_contract_missing"
  | "capability_contract_invalid"
  | "capability_contract_mismatch";

export class RunnerCapabilityContractError extends Error {
  constructor(
    readonly code: RunnerCapabilityContractErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerCapabilityContractError";
  }
}

export interface RunnerCapabilityExtensionContract {
  id: string;
  version: string;
  apiVersion: 1;
  capabilities: string[];
  manifestDigest: string;
  entryDigest: string;
}

export interface RunnerCapabilityLanguageServerContract {
  id: string;
  descriptorDigest: string;
}

export interface RunnerCapabilityContract {
  version: typeof RUNNER_CAPABILITY_CONTRACT_VERSION;
  builtin: {
    id: "builtin.typescript";
    identity: string;
  };
  extensions: RunnerCapabilityExtensionContract[];
  languageServers: RunnerCapabilityLanguageServerContract[];
  digest: string;
}

/**
 * Captures the identity of executable Runner capabilities without persisting
 * configuration arguments or environment values in the durable Build spec.
 */
export async function createRunnerCapabilityContract(
  config: RunnerCapabilitiesConfig,
): Promise<RunnerCapabilityContract> {
  const extensions = await Promise.all(
    config.extensions.map(async (directory) => await captureExtension(directory)),
  );
  extensions.sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(extensions.map((extension) => extension.id), "extension");

  const languageServers = config.languageServers
    .map((server) => ({
      id: server.descriptor.id,
      descriptorDigest: digest(canonicalLanguageServer(server)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(languageServers.map((server) => server.id), "language server");

  const payload = {
    version: RUNNER_CAPABILITY_CONTRACT_VERSION,
    builtin: {
      id: "builtin.typescript" as const,
      identity: BUILTIN_TYPESCRIPT_IDENTITY,
    },
    extensions,
    languageServers,
  };
  return {
    ...payload,
    digest: digest(payload),
  };
}

export async function validateRunnerCapabilityContract(
  expected: RunnerCapabilityContract | undefined,
  config: RunnerCapabilitiesConfig,
): Promise<void> {
  if (!expected) {
    throw new RunnerCapabilityContractError(
      "capability_contract_missing",
      "Active Build recovery requires a persisted Runner capability contract.",
    );
  }
  assertRunnerCapabilityContract(expected);
  const actual = await createRunnerCapabilityContract(config);
  if (actual.digest !== expected.digest) {
    throw new RunnerCapabilityContractError(
      "capability_contract_mismatch",
      "Runner capability configuration differs from the active Build's persisted contract.",
    );
  }
}

export function assertRunnerCapabilityContract(
  value: unknown,
): asserts value is RunnerCapabilityContract {
  if (!isObject(value) || value.version !== RUNNER_CAPABILITY_CONTRACT_VERSION) {
    throw invalidContract("Runner capability contract version is invalid.");
  }
  if (!isObject(value.builtin) ||
      value.builtin.id !== "builtin.typescript" ||
      value.builtin.identity !== BUILTIN_TYPESCRIPT_IDENTITY) {
    throw invalidContract("Runner capability contract built-in identity is invalid.");
  }
  if (!isDigest(value.digest)) {
    throw invalidContract("Runner capability contract digest is invalid.");
  }
  if (!Array.isArray(value.extensions) || !Array.isArray(value.languageServers)) {
    throw invalidContract("Runner capability contract entries are invalid.");
  }
  const extensionIds: string[] = [];
  const extensions: RunnerCapabilityExtensionContract[] = [];
  for (const extension of value.extensions) {
    if (!isObject(extension) ||
        typeof extension.id !== "string" ||
        typeof extension.version !== "string" ||
        extension.apiVersion !== 1 ||
        !Array.isArray(extension.capabilities) ||
        extension.capabilities.some((capability) => typeof capability !== "string") ||
        !isDigest(extension.manifestDigest) ||
        !isDigest(extension.entryDigest)) {
      throw invalidContract("Runner capability contract extension entry is invalid.");
    }
    extensionIds.push(extension.id);
    extensions.push({
      id: extension.id,
      version: extension.version,
      apiVersion: extension.apiVersion,
      capabilities: [...extension.capabilities],
      manifestDigest: extension.manifestDigest,
      entryDigest: extension.entryDigest,
    });
  }
  assertUnique(extensionIds, "extension");
  const serverIds: string[] = [];
  const languageServers: RunnerCapabilityLanguageServerContract[] = [];
  for (const server of value.languageServers) {
    if (!isObject(server) ||
        typeof server.id !== "string" ||
        !isDigest(server.descriptorDigest)) {
      throw invalidContract("Runner capability contract language-server entry is invalid.");
    }
    serverIds.push(server.id);
    languageServers.push({
      id: server.id,
      descriptorDigest: server.descriptorDigest,
    });
  }
  assertUnique(serverIds, "language server");
  const payload = {
    version: RUNNER_CAPABILITY_CONTRACT_VERSION,
    builtin: {
      id: "builtin.typescript" as const,
      identity: BUILTIN_TYPESCRIPT_IDENTITY,
    },
    extensions,
    languageServers,
  };
  if (digest(payload) !== value.digest) {
    throw invalidContract("Runner capability contract digest does not match its entries.");
  }
}

export function cloneRunnerCapabilityContract(
  contract: RunnerCapabilityContract,
): RunnerCapabilityContract {
  assertRunnerCapabilityContract(contract);
  return {
    version: RUNNER_CAPABILITY_CONTRACT_VERSION,
    builtin: { ...contract.builtin },
    extensions: contract.extensions.map((extension) => ({
      ...extension,
      capabilities: [...extension.capabilities],
    })),
    languageServers: contract.languageServers.map((server) => ({ ...server })),
    digest: contract.digest,
  };
}

async function captureExtension(directory: string): Promise<RunnerCapabilityExtensionContract> {
  const root = await requiredRealDirectory(directory);
  const manifestPath = join(root, RUNNER_EXTENSION_MANIFEST_FILE);
  const manifestMetadata = await lstat(manifestPath);
  if (manifestMetadata.isSymbolicLink() || !manifestMetadata.isFile()) {
    throw new Error(`Runner extension manifest ${manifestPath} must be a regular non-symbolic file.`);
  }
  const actualManifestPath = await realpath(manifestPath);
  if (normalizePath(actualManifestPath) !== normalizePath(manifestPath)) {
    throw new Error(`Runner extension manifest ${manifestPath} resolves through a symbolic link.`);
  }
  if (manifestMetadata.size > MAX_MANIFEST_BYTES) {
    throw new Error(`Runner extension manifest ${manifestPath} exceeds the size limit.`);
  }
  const manifestSource = await readFile(actualManifestPath);
  let manifest: RunnerExtensionManifest;
  try {
    manifest = parseRunnerExtensionManifest(JSON.parse(manifestSource.toString("utf8")));
  } catch (error) {
    throw new Error(
      `Runner extension manifest ${manifestPath} is invalid: ${boundedError(error)}.`,
      { cause: error },
    );
  }
  const entryPath = await resolveContainedEntry(root, manifest.entry);
  const entryMetadata = await lstat(entryPath);
  if (entryMetadata.size > MAX_ENTRY_BYTES) {
    throw new Error(`Runner extension entry ${manifest.entry} exceeds the size limit.`);
  }
  const entrySource = await readFile(entryPath);
  return {
    id: manifest.id,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    capabilities: [...manifest.capabilities],
    manifestDigest: digest(manifestSource),
    entryDigest: digest(entrySource),
  };
}

async function requiredRealDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input) || input.includes("\0")) {
    throw new Error("Runner capability extension directory must be an absolute non-empty path.");
  }
  const candidate = resolve(input);
  const root = parse(candidate).root;
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`Runner capability extension directory ${candidate} contains a symbolic link at ${current}.`);
    }
  }
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Runner capability extension directory ${candidate} must be a real directory.`);
  }
  return await realpath(candidate);
}

async function resolveContainedEntry(
  directory: string,
  portableEntry: string,
): Promise<string> {
  let candidate = directory;
  for (const segment of portableEntry.split("/")) {
    candidate = join(candidate, segment);
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new Error(`Runner extension entry ${portableEntry} contains a symbolic link.`);
    }
  }
  const metadata = await lstat(candidate);
  if (!metadata.isFile()) {
    throw new Error(`Runner extension entry ${portableEntry} must be a regular file.`);
  }
  const actual = await realpath(candidate);
  if (!contained(directory, actual)) {
    throw new Error(`Runner extension entry ${portableEntry} escapes its plugin directory.`);
  }
  return actual;
}

function canonicalLanguageServer(server: ConfiguredLanguageServer): Record<string, unknown> {
  return {
    id: server.descriptor.id,
    displayName: server.descriptor.displayName,
    extensions: [...server.descriptor.extensions].sort(),
    rootMarkers: [...server.descriptor.rootMarkers],
    priority: server.descriptor.priority,
    languageId: server.languageId,
    command: server.command,
    args: [...server.args],
    requestTimeoutMs: server.requestTimeoutMs ?? null,
    shutdownTimeoutMs: server.shutdownTimeoutMs ?? null,
    restartLimit: server.restartLimit ?? null,
    maxFrameBytes: server.maxFrameBytes ?? null,
    maxPendingRequests: server.maxPendingRequests ?? null,
    maxDocumentBytes: server.maxDocumentBytes ?? null,
  };
}

function digest(value: unknown): string {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(stableJson(value), "utf8");
  return createHash("sha256").update(source).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Runner capability contract contains an unsupported value.");
}

function assertUnique(values: readonly string[], label: string): void {
  if (values.some((value) => !value) || new Set(values).size !== values.length) {
    throw invalidContract(`Runner capability contract contains a duplicate or invalid ${label} identity.`);
  }
}

function invalidContract(message: string): RunnerCapabilityContractError {
  return new RunnerCapabilityContractError("capability_contract_invalid", message);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function normalizePath(path: string): string {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}
