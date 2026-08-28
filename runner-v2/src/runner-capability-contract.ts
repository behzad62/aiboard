import { createHash } from "node:crypto";
import {
  chmod,
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
  extname,
  isAbsolute,
  join,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { builtinModules } from "node:module";
import * as ts from "typescript";

import {
  RUNNER_EXTENSION_MANIFEST_FILE,
  parseRunnerExtensionManifest,
  type RunnerExtensionManifest,
} from "./runner-extension.js";
import type {
  ConfiguredLanguageServer,
  RunnerCapabilitiesConfig,
} from "./runner-capabilities-config.js";
import {
  assertLanguageServerExecutableIdentity,
  cloneLanguageServerExecutableIdentity,
  resolveLanguageServerExecutable,
  type LanguageServerExecutableIdentity,
  type LanguageServerExecutableResolutionOptions,
} from "./language-server-executable.js";

export const RUNNER_CAPABILITY_CONTRACT_VERSION = 1 as const;

const EXTENSION_CLOSURE_VERSION = 1 as const;
const LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION = 1 as const;
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
  executable?: LanguageServerExecutableIdentity;
}

export interface RunnerCapabilityContract {
  version: typeof RUNNER_CAPABILITY_CONTRACT_VERSION;
  /**
   * Older durable contracts omit this field. They remain readable for
   * historical projections but cannot recover an active Build.
   */
  extensionClosureVersion?: typeof EXTENSION_CLOSURE_VERSION;
  /** Older contracts remain readable but cannot activate configured servers. */
  languageServerExecutableIdentityVersion?: typeof LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION;
  builtin: {
    id: "builtin.typescript";
    identity: string;
  };
  extensions: RunnerCapabilityExtensionContract[];
  languageServers: RunnerCapabilityLanguageServerContract[];
  digest: string;
}

export interface RunnerExtensionClosureFile {
  path: string;
  source: Buffer;
}

/**
 * A bounded, statically validated ESM extension closure captured from one
 * allowlisted local directory.  Runner does not treat the original directory
 * as an execution source after this capture completes.
 */
export interface RunnerExtensionClosure {
  directory: string;
  manifest: RunnerExtensionManifest;
  contract: RunnerCapabilityExtensionContract;
  files: readonly RunnerExtensionClosureFile[];
}

/** A unique Runner-owned execution copy made only from a captured closure. */
export interface RunnerExtensionExecutionCopy {
  directory: string;
  entryPath: string;
  /** Rehashes the sealed copy before an extension crosses a lifecycle boundary. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

interface CapturedExtension {
  contract: RunnerCapabilityExtensionContract;
  files: readonly RunnerExtensionClosureFile[];
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
  options: LanguageServerExecutableResolutionOptions = {},
): Promise<RunnerCapabilityContract> {
  return (await captureRunnerCapabilities(config, options)).contract;
}

/**
 * Captures extension bytes once, persists an immutable content-addressed copy
 * outside the project, and returns the durable contract naming that snapshot.
 */
export async function createRunnerCapabilityContractSnapshot(
  config: RunnerCapabilitiesConfig,
  stateDirectory: string,
  options: LanguageServerExecutableResolutionOptions = {},
): Promise<RunnerCapabilityContract> {
  const captured = await captureRunnerCapabilities(config, options);
  await persistRunnerCapabilitySnapshot(captured, stateDirectory);
  return captured.contract;
}

export async function validateRunnerCapabilityContract(
  expected: RunnerCapabilityContract | undefined,
  config: RunnerCapabilitiesConfig,
  options: LanguageServerExecutableResolutionOptions = {},
): Promise<void> {
  if (!expected) {
    throw new RunnerCapabilityContractError(
      "capability_contract_missing",
      "Active Build recovery requires a persisted Runner capability contract.",
    );
  }
  assertRunnerCapabilityContract(expected);
  assertCurrentExtensionClosure(expected);
  assertCurrentLanguageServerExecutableIdentity(expected);
  let actual: RunnerCapabilityContract;
  try {
    actual = await createRunnerCapabilityContract(config, options);
  } catch (error) {
    throw new RunnerCapabilityContractError(
      "capability_contract_mismatch",
      "Runner capability configuration differs from the active Build's persisted contract and can no longer resolve its attested capabilities.",
      { cause: error },
    );
  }
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
  if (
    value.languageServerExecutableIdentityVersion !== undefined &&
    value.languageServerExecutableIdentityVersion !== LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION
  ) {
    throw invalidContract("Runner capability contract language-server executable identity version is invalid.");
  }
  const currentClosure = value.extensionClosureVersion === EXTENSION_CLOSURE_VERSION;
  const currentLanguageServerIdentity =
    value.languageServerExecutableIdentityVersion === LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION;
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
        !isDigest(server.descriptorDigest) ||
        (currentLanguageServerIdentity && !isLanguageServerExecutableIdentity(server.executable)) ||
        (!currentLanguageServerIdentity && server.executable !== undefined)) {
      throw invalidContract("Runner capability contract language-server entry is invalid.");
    }
    serverIds.push(server.id);
    languageServers.push({
      id: server.id,
      descriptorDigest: server.descriptorDigest,
      ...(currentLanguageServerIdentity
        ? { executable: cloneLanguageServerExecutableIdentity(server.executable as LanguageServerExecutableIdentity) }
        : {}),
    });
  }
  assertUnique(serverIds, "language server");
  const payload = {
    version: RUNNER_CAPABILITY_CONTRACT_VERSION,
    ...(currentClosure ? { extensionClosureVersion: EXTENSION_CLOSURE_VERSION } : {}),
    ...(currentLanguageServerIdentity
      ? { languageServerExecutableIdentityVersion: LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION }
      : {}),
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
    ...(contract.languageServerExecutableIdentityVersion === LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION
      ? { languageServerExecutableIdentityVersion: LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION }
      : {}),
    builtin: { ...contract.builtin },
    extensions: contract.extensions.map((extension) => ({
      ...extension,
      capabilities: [...extension.capabilities],
    })),
    languageServers: contract.languageServers.map((server) => ({
      ...server,
      ...(server.executable
        ? { executable: cloneLanguageServerExecutableIdentity(server.executable) }
        : {}),
    })),
    digest: contract.digest,
  };
}

async function captureRunnerCapabilities(
  config: RunnerCapabilitiesConfig,
  options: LanguageServerExecutableResolutionOptions,
): Promise<CapturedRunnerCapabilities> {
  const extensions = await Promise.all(
    config.extensions.map(async (directory) => await captureExtension(directory)),
  );
  extensions.sort((left, right) => left.contract.id.localeCompare(right.contract.id));
  const extensionContracts = extensions.map((extension) => extension.contract);
  assertUnique(extensionContracts.map((extension) => extension.id), "extension");

  const attested = await attestRunnerCapabilitiesLanguageServers(config, options);
  const languageServers = attested.languageServers
    .map((server) => ({
      id: server.descriptor.id,
      descriptorDigest: digest(canonicalLanguageServer(server)),
      executable: cloneLanguageServerExecutableIdentity(server.commandIdentity!),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  assertUnique(languageServers.map((server) => server.id), "language server");

  const payload = {
    version: RUNNER_CAPABILITY_CONTRACT_VERSION,
    extensionClosureVersion: EXTENSION_CLOSURE_VERSION,
    languageServerExecutableIdentityVersion: LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION,
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

/**
 * Converts configured server commands into canonical absolute identities that
 * are safe to pass to a process launcher. This is Runner-owned metadata and is
 * deliberately absent from the strict JSON configuration schema.
 */
export async function attestRunnerCapabilitiesLanguageServers(
  config: RunnerCapabilitiesConfig,
  options: LanguageServerExecutableResolutionOptions = {},
): Promise<RunnerCapabilitiesConfig> {
  const languageServers = await Promise.all(config.languageServers.map(async (server) => {
    const identity = server.commandIdentity
      ? await verifiedConfiguredLanguageServerIdentity(server)
      : await resolveLanguageServerExecutable(server.command, options);
    return {
      ...server,
      descriptor: {
        ...server.descriptor,
        extensions: [...server.descriptor.extensions],
        rootMarkers: [...server.descriptor.rootMarkers],
      },
      command: identity.path,
      args: [...server.args],
      commandIdentity: identity,
    };
  }));
  return {
    extensions: [...config.extensions],
    languageServers,
  };
}

/**
 * Binds live configured-server launch data to a previously validated durable
 * contract. This prevents a validate-to-launch race from replacing a bare PATH
 * command with a newly resolved executable after the active contract passed.
 */
export function runnerCapabilitiesForContract(
  config: RunnerCapabilitiesConfig,
  contract: RunnerCapabilityContract,
): RunnerCapabilitiesConfig {
  assertRunnerCapabilityContract(contract);
  assertCurrentLanguageServerExecutableIdentity(contract);
  const byId = new Map(contract.languageServers.map((server) => [server.id, server]));
  const languageServers = config.languageServers.map((server) => {
    const expected = byId.get(server.descriptor.id);
    if (!expected?.executable) {
      throw new RunnerCapabilityContractError(
        "capability_contract_mismatch",
        `Runner capability contract has no executable identity for language server ${server.descriptor.id}.`,
      );
    }
    return {
      ...server,
      descriptor: {
        ...server.descriptor,
        extensions: [...server.descriptor.extensions],
        rootMarkers: [...server.descriptor.rootMarkers],
      },
      command: expected.executable.path,
      args: [...server.args],
      commandIdentity: cloneLanguageServerExecutableIdentity(expected.executable),
    };
  });
  return { extensions: [...config.extensions], languageServers };
}

async function verifiedConfiguredLanguageServerIdentity(
  server: ConfiguredLanguageServer,
): Promise<LanguageServerExecutableIdentity> {
  const identity = server.commandIdentity!;
  if (normalizePath(server.command) !== normalizePath(identity.path)) {
    throw new Error(
      `Language server ${server.descriptor.id} command does not match its Runner-owned executable identity.`,
    );
  }
  await assertLanguageServerExecutableIdentity(identity);
  return cloneLanguageServerExecutableIdentity(identity);
}

async function captureExtension(directory: string): Promise<CapturedExtension> {
  const closure = await captureRunnerExtensionClosure(directory);
  return { contract: closure.contract, files: closure.files };
}

/**
 * Captures and validates every executable extension module before anything is
 * imported. Only contained relative ESM modules and explicit `node:` built-ins
 * are supported in the trusted-local extension boundary; Node package and
 * dynamic resolution are deliberately excluded because they escape a durable
 * closure without a sandbox.
 */
export async function captureRunnerExtensionClosure(
  directory: string,
): Promise<RunnerExtensionClosure> {
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
  validateCapturedExtensionModuleGraph(files, manifest.entry);
  return {
    directory: root,
    manifest,
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

async function captureExtensionFiles(root: string): Promise<RunnerExtensionClosureFile[]> {
  const files: RunnerExtensionClosureFile[] = [];
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

const ALLOWED_NODE_BUILTINS = new Set(
  builtinModules.map((name) => name.replace(/^node:/, "")),
);

/**
 * Validates the complete conventional ESM graph from captured bytes. This is
 * intentionally stricter than Node's resolver: extensions must vendor any
 * dependency inside their allowlisted directory, and dynamic imports are not
 * executable under the trusted-local/no-sandbox extension model.
 */
function validateCapturedExtensionModuleGraph(
  files: readonly RunnerExtensionClosureFile[],
  entry: string,
): void {
  const sources = new Map(files.map((file) => [file.path, file.source]));
  const checked = new Set<string>();
  const visit = (path: string): void => {
    if (checked.has(path)) return;
    checked.add(path);
    const source = sources.get(path);
    if (!source) {
      throw new Error(`Runner extension module ${path} is not part of the captured closure.`);
    }
    if (!isExecutableExtensionModule(path)) {
      throw new Error(
        `Runner extension module ${path} must use a contained .mjs or .js ESM file.`,
      );
    }
    const parsed = ts.createSourceFile(
      path,
      source.toString("utf8"),
      ts.ScriptTarget.ES2023,
      true,
      ts.ScriptKind.JS,
    );
    const parseDiagnostics = (parsed as unknown as {
      parseDiagnostics: readonly ts.Diagnostic[];
    }).parseDiagnostics;
    if (parseDiagnostics.length > 0) {
      throw new Error(
        `Runner extension module ${path} has invalid syntax: ${parseDiagnostics[0]!.messageText}.`,
      );
    }
    const resolveSpecifier = (specifier: string): void => {
      if (specifier.startsWith("node:")) {
        const builtin = specifier.slice("node:".length);
        if (!ALLOWED_NODE_BUILTINS.has(builtin)) {
          throw new Error(`Runner extension module ${path} imports unsupported node builtin ${specifier}.`);
        }
        return;
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(
          `Runner extension module ${path} imports bare external package ${specifier}; vendor it inside the extension instead.`,
        );
      }
      const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/")) {
        throw new Error(`Runner extension module ${path} escapes its captured closure via ${specifier}.`);
      }
      if (!isExecutableExtensionModule(resolved) || !sources.has(resolved)) {
        throw new Error(
          `Runner extension module ${path} imports unresolved contained module ${specifier}.`,
        );
      }
      visit(resolved);
    };
    const inspect = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          if (!ts.isStringLiteral(node.moduleSpecifier)) {
            throw new Error(`Runner extension module ${path} has an unresolved module specifier.`);
          }
          resolveSpecifier(node.moduleSpecifier.text);
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        throw new Error(`Runner extension module ${path} uses unsupported require-style module resolution.`);
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          throw new Error(`Runner extension module ${path} uses unsupported dynamic import resolution.`);
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          throw new Error(`Runner extension module ${path} uses unsupported require-style module resolution.`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    ts.forEachChild(parsed, inspect);
  };
  visit(entry);
}

function isExecutableExtensionModule(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === ".mjs" || extension === ".js";
}

/**
 * Materializes a unique execution directory solely from already-verified
 * closure bytes. The original/snapshot directory is never imported directly,
 * so a mutation after capture cannot change the code evaluated for this run.
 */
export async function materializeRunnerExtensionExecutionCopy(
  closure: RunnerExtensionClosure,
  stateDirectory: string,
): Promise<RunnerExtensionExecutionCopy> {
  const stateRoot = await requiredRealStateDirectory(stateDirectory);
  const executions = join(stateRoot, "extension-executions");
  await mkdir(executions, { recursive: true });
  const executionRoot = await requiredRealStateDirectory(executions);
  const directory = await mkdtemp(join(
    executionRoot,
    `.${closure.contract.closureDigest?.slice(0, 16) ?? "extension"}-`,
  ));
  let retained = false;
  try {
    await writeCapturedExtension(directory, closure.files);
    const verified = await captureRunnerExtensionClosure(directory);
    if (!sameExtensionContract(closure.contract, verified.contract)) {
      throw new Error("Runner extension execution copy differs from its captured closure.");
    }
    await sealExecutionCopy(directory, closure.files);
    retained = true;
    return new CapturedExecutionCopy(
      directory,
      closure.manifest.entry,
      closure.files,
      closure.contract,
    );
  } finally {
    if (!retained) await removeExecutionCopy(directory, closure.files);
  }
}

class CapturedExecutionCopy implements RunnerExtensionExecutionCopy {
  private closed = false;
  readonly entryPath: string;

  constructor(
    readonly directory: string,
    entry: string,
    private readonly files: readonly RunnerExtensionClosureFile[],
    private readonly contract: RunnerCapabilityExtensionContract,
  ) {
    this.entryPath = join(directory, ...entry.split("/"));
  }

  async verify(): Promise<void> {
    if (this.closed) throw new Error("Runner extension execution copy is already closed.");
    const actual = await captureRunnerExtensionClosure(this.directory);
    if (!sameExtensionContract(this.contract, actual.contract)) {
      throw new Error("Runner extension execution copy changed after it was captured.");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await removeExecutionCopy(this.directory, this.files);
    this.closed = true;
  }
}

async function sealExecutionCopy(
  directory: string,
  files: readonly RunnerExtensionClosureFile[],
): Promise<void> {
  for (const file of files) {
    await chmod(join(directory, ...file.path.split("/")), 0o444);
  }
  const directories = new Set<string>([directory]);
  for (const file of files) {
    let current = dirname(join(directory, ...file.path.split("/")));
    while (contained(directory, current)) {
      directories.add(current);
      if (normalizePath(current) === normalizePath(directory)) break;
      current = dirname(current);
    }
  }
  for (const candidate of [...directories].sort((left, right) => right.length - left.length)) {
    await chmod(candidate, 0o555);
  }
}

async function removeExecutionCopy(
  directory: string,
  files: readonly RunnerExtensionClosureFile[],
): Promise<void> {
  for (const file of files) {
    try {
      await chmod(join(directory, ...file.path.split("/")), 0o600);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  const directories = new Set<string>([directory]);
  for (const file of files) {
    let current = dirname(join(directory, ...file.path.split("/")));
    while (contained(directory, current)) {
      directories.add(current);
      if (normalizePath(current) === normalizePath(directory)) break;
      current = dirname(current);
    }
  }
  for (const candidate of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      await chmod(candidate, 0o700);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
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
  files: readonly RunnerExtensionClosureFile[],
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

function assertCurrentLanguageServerExecutableIdentity(
  contract: RunnerCapabilityContract,
): void {
  if (
    contract.languageServerExecutableIdentityVersion !==
    LANGUAGE_SERVER_EXECUTABLE_IDENTITY_VERSION
  ) {
    throw new RunnerCapabilityContractError(
      "capability_contract_missing",
      "Active Build recovery requires a persisted language-server executable capability contract.",
    );
  }
}

function isLanguageServerExecutableIdentity(
  value: unknown,
): value is LanguageServerExecutableIdentity {
  return isObject(value) &&
    typeof value.path === "string" &&
    isDigest(value.digest) &&
    (value.launcher === "native" || value.launcher === "batch");
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
