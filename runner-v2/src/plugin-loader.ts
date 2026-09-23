import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  CapabilityRegistry,
  type RunnerExtensionRegistration,
} from "./capability-registry.js";
import type {
  RunnerExtensionInstance,
  RunnerExtensionModule,
} from "./runner-extension.js";
import {
  captureRunnerExtensionClosure,
  materializeRunnerExtensionExecutionCopy,
  type RunnerExtensionClosure,
  type RunnerExtensionExecutionCopy,
} from "./runner-capability-contract.js";
import { isTrustedRunnerHostAliasResolution } from "./runner-capabilities-config.js";

export interface LocalPluginLoaderOptions {
  pluginDirectories: readonly string[];
  projectDirectory: string;
  stateDirectory: string;
  reservedToolNames?: readonly string[];
  signal?: AbortSignal;
  /** Revalidates a durable snapshot around every extension execution boundary. */
  verifyExtensionIntegrity?: () => Promise<void>;
  /** Internal deterministic seam for testing capture-to-import TOCTOU defenses. */
  captureClosure?: (directory: string) => Promise<RunnerExtensionClosure>;
  /** Internal deterministic seam for testing post-evaluation integrity checks. */
  afterImport?: (copy: RunnerExtensionExecutionCopy) => Promise<void>;
  importModule?: (entryPath: string) => Promise<unknown>;
}

export interface RunnerExtensionCleanupDisposer {
  close(): Promise<void>;
}

export class RunnerExtensionLoadError extends AggregateError {
  constructor(
    errors: readonly unknown[],
    readonly disposer: RunnerExtensionCleanupDisposer,
  ) {
    super(errors, "Runner extension loading failed and cleanup remains incomplete.");
    this.name = "RunnerExtensionLoadError";
  }
}

export class LoadedRunnerExtensions {
  private closed = false;

  constructor(
    readonly registry: CapabilityRegistry,
    private instances: RunnerExtensionInstance[],
    private executionCopies: RunnerExtensionExecutionCopy[] = [],
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    const result = await closeInstances([...this.instances].reverse());
    this.instances = [...result.failedInstances].reverse();
    if (result.failures.length > 0) {
      throw new AggregateError(
        result.failures,
        "One or more Runner extensions failed to close.",
      );
    }
    const copies = await closeExecutionCopies([...this.executionCopies].reverse());
    this.executionCopies = [...copies.failedCopies].reverse();
    this.closed = this.executionCopies.length === 0;
    if (copies.failures.length > 0) {
      throw new AggregateError(
        copies.failures,
        "One or more Runner extension execution copies failed to close.",
      );
    }
  }
}

export class LocalPluginLoader {
  private readonly options: LocalPluginLoaderOptions;

  constructor(options: LocalPluginLoaderOptions) {
    this.options = {
      ...options,
      pluginDirectories: [...options.pluginDirectories],
      ...(options.reservedToolNames
        ? { reservedToolNames: [...options.reservedToolNames] }
        : {}),
    };
  }

  async load(): Promise<LoadedRunnerExtensions> {
    const created: RunnerExtensionRegistration[] = [];
    const executionCopies: RunnerExtensionExecutionCopy[] = [];
    try {
      throwIfAborted(this.options.signal);
      const projectDirectory = await requiredRealDirectory(
        this.options.projectDirectory,
        "project directory",
        false,
      );
      const requestedStateDirectory = resolve(this.options.stateDirectory);
      if (contained(projectDirectory, requestedStateDirectory)) {
        throw new Error("Runner extension state directory cannot be inside the project directory.");
      }
      const stateDirectory = await prepareStateDirectory(this.options.stateDirectory);
      if (contained(projectDirectory, stateDirectory)) {
        throw new Error("Runner extension state directory cannot be inside the project directory.");
      }
      const directories = await this.resolvePluginDirectories();
      for (const directory of directories) {
        throwIfAborted(this.options.signal);
        await this.options.verifyExtensionIntegrity?.();
        const closure = await (this.options.captureClosure ?? captureRunnerExtensionClosure)(directory);
        const manifest = closure.manifest;
        await this.options.verifyExtensionIntegrity?.();
        let importedModule: unknown;
        if (this.options.importModule) {
          const entryPath = await resolveContainedEntry(directory, manifest.entry);
          importedModule = await this.options.importModule(entryPath);
        } else {
          const copy = await materializeRunnerExtensionExecutionCopy(
            closure,
            stateDirectory,
          );
          executionCopies.push(copy);
          await copy.verify();
          importedModule = await importExtensionModule(copy.entryPath);
          await this.options.afterImport?.(copy);
          await copy.verify();
        }
        await this.options.verifyExtensionIntegrity?.();
        const extensionModule = assertExtensionModule(manifest.id, importedModule);
        const instance = extensionModule.createExtension();
        created.push({ manifest, instance });
        await verifyExecutionCopies(executionCopies);
      }

      const registry = new CapabilityRegistry(created, {
        ...(this.options.reservedToolNames
          ? { reservedToolNames: this.options.reservedToolNames }
          : {}),
      });
      await verifyExecutionCopies(executionCopies);
      for (const registration of created) {
        throwIfAborted(this.options.signal);
        await this.options.verifyExtensionIntegrity?.();
        await verifyExecutionCopies(executionCopies);
        const extensionState = await prepareExtensionState(
          stateDirectory,
          projectDirectory,
          registration.manifest.id,
        );
        await registration.instance.start({
          extensionId: registration.manifest.id,
          stateDirectory: extensionState,
          signal: this.options.signal ?? new AbortController().signal,
        });
      }
      return new LoadedRunnerExtensions(
        registry,
        created.map((registration) => registration.instance),
        executionCopies,
      );
    } catch (error) {
      const disposer = new PendingRunnerExtensionCleanup(
        created.map((registration) => registration.instance).reverse(),
        [...executionCopies].reverse(),
      );
      const cleanup = await boundedCleanup(disposer);
      if (cleanup.incomplete) {
        throw new RunnerExtensionLoadError(
          [error, ...cleanup.failures],
          disposer,
        );
      }
      if (cleanup.failures.length > 0) {
        throw new AggregateError(
          [error, ...cleanup.failures],
          "Runner extension loading failed and cleanup reported errors.",
        );
      }
      throw error;
    }
  }

  private async resolvePluginDirectories(): Promise<string[]> {
    if (!Array.isArray(this.options.pluginDirectories)) {
      throw new Error("Plugin directories must be an explicit allowlist.");
    }
    const directories: string[] = [];
    const seen = new Set<string>();
    for (const candidate of this.options.pluginDirectories) {
      const directory = await requiredRealDirectory(
        candidate,
        "allowlisted plugin directory",
        true,
      );
      const key = process.platform === "win32" ? directory.toLowerCase() : directory;
      if (seen.has(key)) {
        throw new Error(`Duplicate allowlisted plugin directory ${directory}.`);
      }
      seen.add(key);
      directories.push(directory);
    }
    return directories;
  }
}

class PendingRunnerExtensionCleanup implements RunnerExtensionCleanupDisposer {
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(
    private pendingInstances: RunnerExtensionInstance[],
    private pendingCopies: RunnerExtensionExecutionCopy[],
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    const attempt = this.closeOwnedResources();
    this.closePromise = attempt;
    try {
      await attempt;
      this.closed = true;
    } catch (error) {
      if (this.closePromise === attempt) this.closePromise = undefined;
      throw error;
    }
  }

  private async closeOwnedResources(): Promise<void> {
    const instances = await closeInstances(this.pendingInstances);
    this.pendingInstances = instances.failedInstances;
    const copies = await closeExecutionCopies(this.pendingCopies);
    this.pendingCopies = copies.failedCopies;
    const failures = [...instances.failures, ...copies.failures];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more partially loaded Runner extension resources failed to close.",
      );
    }
  }
}

async function boundedCleanup(
  disposer: RunnerExtensionCleanupDisposer,
): Promise<{ failures: unknown[]; incomplete: boolean }> {
  const failures: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await disposer.close();
      return { failures, incomplete: false };
    } catch (error) {
      failures.push(error);
    }
  }
  return { failures, incomplete: true };
}

async function resolveContainedEntry(
  directory: string,
  portableEntry: string,
): Promise<string> {
  const segments = portableEntry.split("/");
  let candidate = directory;
  for (const segment of segments) {
    candidate = join(candidate, segment);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
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

async function requiredRealDirectory(
  input: string,
  label: string,
  rejectSymbolicComponents: boolean,
): Promise<string> {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error(`${label} must be a non-empty path.`);
  }
  const candidate = resolve(input);
  if (rejectSymbolicComponents) {
    await assertNoSymbolicPathComponents(candidate, label);
  }
  const metadata = await lstat(candidate);
  if (rejectSymbolicComponents && metadata.isSymbolicLink()) {
    throw new Error(`${label} ${candidate} cannot be a symbolic link.`);
  }
  if (!metadata.isDirectory()) throw new Error(`${label} ${candidate} is not a directory.`);
  return await realpath(candidate);
}

async function assertNoSymbolicPathComponents(
  candidate: string,
  label: string,
): Promise<void> {
  const root = parse(candidate).root;
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    if (!(await lstat(current)).isSymbolicLink()) continue;
    let actual: string;
    try { actual = resolve(await realpath(current)); }
    catch { throw new Error(`${label} ${candidate} contains a symbolic link at ${current}.`); }
    if (!isTrustedRunnerHostAliasResolution(current, actual)) {
      throw new Error(`${label} ${candidate} contains a symbolic link at ${current}.`);
    }
  }
}

async function prepareStateDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Runner extension state directory must be a non-empty path.");
  }
  const candidate = resolve(input);
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(
        "Runner extension state directory must already exist and be managed by Runner V2.",
      );
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Runner extension state directory must be a real directory.");
  }
  return await realpath(candidate);
}

async function prepareExtensionState(
  stateDirectory: string,
  projectDirectory: string,
  extensionId: string,
): Promise<string> {
  const extensionsDirectory = await prepareContainedStateDirectory(
    join(stateDirectory, "extensions"),
    stateDirectory,
    projectDirectory,
    "Runner extension state root",
  );
  return await prepareContainedStateDirectory(
    join(extensionsDirectory, extensionId),
    extensionsDirectory,
    projectDirectory,
    `Extension ${extensionId} state`,
  );
}

async function prepareContainedStateDirectory(
  candidate: string,
  expectedParent: string,
  projectDirectory: string,
  label: string,
): Promise<string> {
  try {
    await mkdir(candidate);
  } catch (error) {
    if (!isErrno(error, "EEXIST")) throw error;
  }
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link.`);
  }
  if (!metadata.isDirectory()) throw new Error(`${label} must be a real directory.`);
  const actual = await realpath(candidate);
  if (!contained(expectedParent, actual)) {
    throw new Error(`${label} escapes Runner state.`);
  }
  if (contained(projectDirectory, actual)) {
    throw new Error(`${label} cannot be inside the project directory.`);
  }
  return actual;
}

function assertExtensionModule(
  extensionId: string,
  input: unknown,
): RunnerExtensionModule {
  if (
    typeof input !== "object" ||
    input === null ||
    typeof (input as { createExtension?: unknown }).createExtension !== "function"
  ) {
    throw new Error(`Extension ${extensionId} entry must export createExtension.`);
  }
  return input as RunnerExtensionModule;
}

async function importExtensionModule(entryPath: string): Promise<unknown> {
  return await import(pathToFileURL(entryPath).href);
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function closeInstances(
  instances: readonly RunnerExtensionInstance[],
): Promise<{
  failures: unknown[];
  failedInstances: RunnerExtensionInstance[];
}> {
  const failures: unknown[] = [];
  const failedInstances: RunnerExtensionInstance[] = [];
  for (const instance of instances) {
    try {
      await instance.close();
    } catch (error) {
      failures.push(error);
      failedInstances.push(instance);
    }
  }
  return { failures, failedInstances };
}

async function closeExecutionCopies(
  copies: readonly RunnerExtensionExecutionCopy[],
): Promise<{
  failures: unknown[];
  failedCopies: RunnerExtensionExecutionCopy[];
}> {
  const failures: unknown[] = [];
  const failedCopies: RunnerExtensionExecutionCopy[] = [];
  for (const copy of copies) {
    try {
      await copy.close();
    } catch (error) {
      failures.push(error);
      failedCopies.push(copy);
    }
  }
  return { failures, failedCopies };
}

async function verifyExecutionCopies(
  copies: readonly RunnerExtensionExecutionCopy[],
): Promise<void> {
  for (const copy of copies) await copy.verify();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Plugin loading was cancelled.");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
