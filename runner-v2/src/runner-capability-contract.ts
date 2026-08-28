import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
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

const EXTENSION_CLOSURE_VERSION = 1 as const;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_EXTENSION_FILES = 4_096;
const MAX_EXTENSION_BYTES = 64 * 1024 * 1024;
const BUILTIN_TYPESCRIPT_IDENTITY = "runner-v2/typescript-intelligence@1";

export type RunnerCapabilityContractErrorCode =
  | "capability_contract_missing"
  | "capability_contract_invalid"
  | "capability_contract_mismatch"
  | "capability_preflight_failed";

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
  /** Present only in immutable-snapshot contracts created by current Runner V2. */
  closureDigest?: string;
}

export interface RunnerCapabilityLanguageServerContract {
  id: string;
  descriptorDigest: string;
}

export interface RunnerCapabilityContract {
  version: typeof RUNNER_CAPABILITY_CONTRACT_VERSION;
  /**
   * Older durable contracts omit this field. They remain readable for
   * historical projections but cannot recover an active Build.
   */
  extensionClosureVersion?: typeof EXTENSION_CLOSURE_VERSION;
  builtin: {
    id: "builtin.typescript";
    identity: string;
  };
  extensions: RunnerCapabilityExtensionContract[];
  languageServers: RunnerCapabilityLanguageServerContract[];
  digest: string;
}

interface CapturedExtensionFile {
  path: string;
  source: Buffer;
}

interface CapturedExtension {
  contract: RunnerCapabilityExtensionContract;
  files: readonly CapturedExtensionFile[];
}

interface CapturedRunnerCapabilities {
  contract: RunnerCapabilityContract;
  extensions: readonly CapturedExtension[];
}

/**
 * Captures the identity of executable Runner capabilities without persisting
 * configuration arguments or environment values in the durable Build spec.
 */
export async function createRunnerCapabilityContract(
  config: RunnerCapabilitiesConfig,
): Promise<RunnerCapabilityContract> {
  return (await captureRunnerCapabilities(config)).contract;
}

/**
 * Captures extension bytes once, persists an immutable content-addressed copy
 * outside the project, and returns the durable contract naming that snapshot.
 */
export async function createRunnerCapabilityContractSnapshot(
  config: RunnerCapabilitiesConfig,
  stateDirectory: string,
): Promise<RunnerCapabilityContract> {
  const captured = await captureRunnerCapabilities(config);
  await persistRunnerCapabilitySnapshot(captured, stateDirectory);
  return captured.contract;
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
  assertCurrentExtensionClosure(expected);
  const actual = await createRunnerCapabilityContract(config);
  if (actual.digest !== expected.digest) {
    throw new RunnerCapabilityContractError(
      "capability_contract_mismatch",
      "Runner capability configuration differs from the active Build's persisted contract.",
    );
  }
}

/** Verifies the immutable snapshot before a runtime imports any extension code. */
export async function validateRunnerCapabilityContractSnapshot(
  contract: RunnerCapabilityContract,
  stateDirectory: string,
): Promise<void> {
  assertRunnerCapabilityContract(contract);
  assertCurrentExtensionClosure(contract);
  if (contract.extensions.length === 0) return;
  try {
    await assertSnapshotAtRoot(
      contract,
      runnerCapabilitySnapshotRoot(contract, stateDirectory),
    );
  } catch (error) {
    if (error instanceof RunnerCapabilityContractError) throw error;
    throw new RunnerCapabilityContractError(
      "capability_contract_mismatch",
      "The active Build's immutable extension capability snapshot is unavailable or differs from its persisted contract.",
      { cause: error },
    );
  }
}

/** Snapshot plugin roots for LocalPluginLoader; only current contracts can use them. */
export function runnerCapabilitySnapshotExtensionDirectories(
  contract: RunnerCapabilityContract,
  stateDirectory: string,
): string[] {
  assertRunnerCapabilityContract(contract);
  assertCurrentExtensionClosure(contract);
  const root = runnerCapabilitySnapshotRoot(contract, stateDirectory);
  return contract.extensions.map((extension, index) =>
    join(root, "extensions", snapshotExtensionDirectoryName(index, extension)),
  );
}

export function assertRunnerCapabilityContract(
  value: unknown,
): asserts value is RunnerCapabilityContract {
  if (!isObject(value) || value.version !== RUNNER_CAPABILITY_CONTRACT_VERSION) {
    throw invalidContract("Runner capability contract version is invalid.");
  }
  if (
    value.extensionClosureVersion !== undefined &&
    value.extensionClosureVersion !== EXTENSION_CLOSURE_VERSION
  ) {
    throw invalidContract("Runner capability contract extension closure version is invalid.");
  }
  const currentClosure = value.extensionClosureVersion === EXTENSION_CLOSURE_VERSION;
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
        !isDigest(extension.entryDigest) ||
        (currentClosure
          ? !isDigest(extension.closureDigest)
          : extension.closureDigest !== undefined)) {
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
      ...(currentClosure ? { closureDigest: extension.closureDigest as string } : {}),
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
    ...(currentClosure ? { extensionClosureVersion: EXTENSION_CLOSURE_VERSION } : {}),
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
    ...(contract.extensionClosureVersion === EXTENSION_CLOSURE_VERSION
      ? { extensionClosureVersion: EXTENSION_CLOSURE_VERSION }
      : {}),
    builtin: { ...contract.builtin },
    extensions: contract.extensions.map((extension) => ({
      ...extension,
      capabilities: [...extension.capabilities],
    })),
    languageServers: contract.languageServers.map((server) => ({ ...server })),
    digest: contract.digest,
  };
}

async function captureRunnerCapabilities(
  config: RunnerCapabilitiesConfig,
): Promise<CapturedRunnerCapabilities> {
  const extensions = await Promise.all(
    config.extensions.map(async (directory) => await captureExtension(directory)),
  );
  extensions.sort((left, right) => left.contract.id.localeCompare(right.contract.id));
  const extensionContracts = extensions.map((extension) => extension.contract);
  assertUnique(extensionContracts.map((extension) => extension.id), "extension");

  const languageServers = config.languageServers
    .map((server) => ({
      id: server.descriptor.id,
      descriptorDigest: digest(canonicalLanguageServer(server)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(languageServers.map((server) => server.id), "language server");

  const payload = {
    version: RUNNER_CAPABILITY_CONTRACT_VERSION,
    extensionClosureVersion: EXTENSION_CLOSURE_VERSION,
    builtin: {
      id: "builtin.typescript" as const,
      identity: BUILTIN_TYPESCRIPT_IDENTITY,
    },
    extensions: extensionContracts,
    languageServers,
  };
  return {
    contract: {
      ...payload,
      digest: digest(payload),
    },
    extensions,
  };
}

async function captureExtension(directory: string): Promise<CapturedExtension> {
  const root = await requiredRealDirectory(directory);
  const files = await captureExtensionFiles(root);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifestSource = byPath.get(RUNNER_EXTENSION_MANIFEST_FILE)?.source;
  if (!manifestSource) {
    throw new Error(`Runner extension manifest ${join(root, RUNNER_EXTENSION_MANIFEST_FILE)} is missing.`);
  }
  if (manifestSource.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(`Runner extension manifest ${join(root, RUNNER_EXTENSION_MANIFEST_FILE)} exceeds the size limit.`);
  }
  let manifest: RunnerExtensionManifest;
  try {
    manifest = parseRunnerExtensionManifest(JSON.parse(manifestSource.toString("utf8")));
  } catch (error) {
    throw new Error(
      `Runner extension manifest ${join(root, RUNNER_EXTENSION_MANIFEST_FILE)} is invalid: ${boundedError(error)}.`,
      { cause: error },
    );
  }
  const entrySource = byPath.get(manifest.entry)?.source;
  if (!entrySource) {
    throw new Error(`Runner extension entry ${manifest.entry} must be a regular contained file.`);
  }
  if (entrySource.byteLength > MAX_ENTRY_BYTES) {
    throw new Error(`Runner extension entry ${manifest.entry} exceeds the size limit.`);
  }
  return {
    contract: {
      id: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      capabilities: [...manifest.capabilities],
      manifestDigest: digest(manifestSource),
      entryDigest: digest(entrySource),
      closureDigest: digest(files.map((file) => ({
        path: file.path,
        digest: digest(file.source),
      }))),
    },
    files,
  };
}

async function captureExtensionFiles(root: string): Promise<CapturedExtensionFile[]> {
  const files: CapturedExtensionFile[] = [];
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory);
    entries.sort(compareCodeUnits);
    for (const name of entries) {
      const candidate = join(directory, name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Runner extension ${candidate} cannot be a symbolic link.`);
      }
      const actual = await realpath(candidate);
      if (!contained(root, actual) || normalizePath(actual) !== normalizePath(candidate)) {
        throw new Error(`Runner extension ${candidate} resolves outside its plugin directory.`);
      }
      if (metadata.isDirectory()) {
        await visit(candidate);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`Runner extension ${candidate} must contain only regular files and directories.`);
      }
      if (files.length >= MAX_EXTENSION_FILES) {
        throw new Error(`Runner extension exceeds the ${MAX_EXTENSION_FILES} file limit.`);
      }
      const source = await readFile(actual);
      totalBytes += source.byteLength;
      if (totalBytes > MAX_EXTENSION_BYTES) {
        throw new Error(`Runner extension exceeds the ${MAX_EXTENSION_BYTES} byte limit.`);
      }
      files.push({
        path: relative(root, candidate).split(sep).join("/"),
        source,
      });
    }
  };
  await visit(root);
  return files;
}

async function persistRunnerCapabilitySnapshot(
  captured: CapturedRunnerCapabilities,
  stateDirectory: string,
): Promise<void> {
  if (captured.extensions.length === 0) return;
  const stateRoot = await requiredRealStateDirectory(stateDirectory);
  const snapshots = join(stateRoot, "capability-snapshots");
  await mkdir(snapshots, { recursive: true });
  await requiredRealStateDirectory(snapshots);
  const target = runnerCapabilitySnapshotRoot(captured.contract, stateRoot);
  if (await pathExists(target)) {
    await assertSnapshotAtRoot(captured.contract, target);
    return;
  }
  const staging = await mkdtemp(join(snapshots, ".staging-"));
  let renamed = false;
  try {
    for (const [index, extension] of captured.extensions.entries()) {
      const output = join(
        staging,
        "extensions",
        snapshotExtensionDirectoryName(index, extension.contract),
      );
      await writeCapturedExtension(output, extension.files);
    }
    await assertSnapshotAtRoot(captured.contract, staging);
    try {
      await rename(staging, target);
      renamed = true;
    } catch (error) {
      if (!(await pathExists(target))) throw error;
      await assertSnapshotAtRoot(captured.contract, target);
    }
  } finally {
    if (!renamed) await rm(staging, { recursive: true, force: true });
  }
}

async function writeCapturedExtension(
  output: string,
  files: readonly CapturedExtensionFile[],
): Promise<void> {
  for (const file of files) {
    const destination = join(output, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.source, { flag: "wx" });
  }
}

async function assertSnapshotAtRoot(
  contract: RunnerCapabilityContract,
  root: string,
): Promise<void> {
  for (const [index, expected] of contract.extensions.entries()) {
    const directory = join(
      root,
      "extensions",
      snapshotExtensionDirectoryName(index, expected),
    );
    const actual = await captureExtension(directory);
    if (!sameExtensionContract(expected, actual.contract)) {
      throw new Error(`Runner extension snapshot for ${expected.id} differs from its persisted contract.`);
    }
  }
}

function sameExtensionContract(
  expected: RunnerCapabilityExtensionContract,
  actual: RunnerCapabilityExtensionContract,
): boolean {
  return expected.id === actual.id &&
    expected.version === actual.version &&
    expected.apiVersion === actual.apiVersion &&
    expected.manifestDigest === actual.manifestDigest &&
    expected.entryDigest === actual.entryDigest &&
    expected.closureDigest === actual.closureDigest &&
    expected.capabilities.length === actual.capabilities.length &&
    expected.capabilities.every((capability, index) => capability === actual.capabilities[index]);
}

function runnerCapabilitySnapshotRoot(
  contract: RunnerCapabilityContract,
  stateDirectory: string,
): string {
  return join(resolve(stateDirectory), "capability-snapshots", contract.digest);
}

function snapshotExtensionDirectoryName(
  index: number,
  extension: RunnerCapabilityExtensionContract,
): string {
  return `${String(index).padStart(3, "0")}-${extension.closureDigest}`;
}

function assertCurrentExtensionClosure(
  contract: RunnerCapabilityContract,
): void {
  if (contract.extensionClosureVersion !== EXTENSION_CLOSURE_VERSION) {
    throw new RunnerCapabilityContractError(
      "capability_contract_missing",
      "Active Build recovery requires a persisted immutable extension capability contract.",
    );
  }
}

async function requiredRealDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input) || input.includes("\0")) {
    throw new Error("Runner capability extension directory must be an absolute non-empty path.");
  }
  const candidate = resolve(input);
  await assertNoSymbolicPathComponents(candidate, "Runner capability extension directory");
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Runner capability extension directory ${candidate} must be a real directory.`);
  }
  return await realpath(candidate);
}

async function requiredRealStateDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim() || !isAbsolute(input) || input.includes("\0")) {
    throw new Error("Runner capability snapshot state directory must be an absolute non-empty path.");
  }
  const candidate = resolve(input);
  await assertNoSymbolicPathComponents(candidate, "Runner capability snapshot state directory");
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Runner capability snapshot state directory ${candidate} must be a real directory.`);
  }
  return await realpath(candidate);
}

async function assertNoSymbolicPathComponents(candidate: string, label: string): Promise<void> {
  const root = parse(candidate).root;
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`${label} ${candidate} contains a symbolic link at ${current}.`);
    }
  }
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 512 ? value : `${value.slice(0, 512)}…`;
}
