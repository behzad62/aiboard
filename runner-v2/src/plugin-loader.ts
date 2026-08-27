import {
  lstat,
  mkdir,
  readFile,
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
import {
  RUNNER_EXTENSION_MANIFEST_FILE,
  parseRunnerExtensionManifest,
  type RunnerExtensionInstance,
  type RunnerExtensionModule,
} from "./runner-extension.js";

const MAX_MANIFEST_BYTES = 64 * 1024;

export interface LocalPluginLoaderOptions {
  pluginDirectories: readonly string[];
  projectDirectory: string;
  stateDirectory: string;
  reservedToolNames?: readonly string[];
  signal?: AbortSignal;
  importModule?: (entryPath: string) => Promise<unknown>;
}

export class LoadedRunnerExtensions {
  private closed = false;

  constructor(
    readonly registry: CapabilityRegistry,
    private instances: RunnerExtensionInstance[],
  ) {}

  async close(): Promise<void> {
    if (this.closed) return;
    const result = await closeInstances([...this.instances].reverse());
    this.instances = [...result.failedInstances].reverse();
    this.closed = this.instances.length === 0;
    if (result.failures.length > 0) {
      throw new AggregateError(
        result.failures,
        "One or more Runner extensions failed to close.",
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
        const manifest = await readManifest(directory);
        const entryPath = await resolveContainedEntry(directory, manifest.entry);
        const importedModule = await (this.options.importModule ?? importExtensionModule)(
          entryPath,
        );
        const extensionModule = assertExtensionModule(manifest.id, importedModule);
        const instance = extensionModule.createExtension();
        created.push({ manifest, instance });
      }

      const registry = new CapabilityRegistry(created, {
        ...(this.options.reservedToolNames
          ? { reservedToolNames: this.options.reservedToolNames }
          : {}),
      });
      for (const registration of created) {
        throwIfAborted(this.options.signal);
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
      );
    } catch (error) {
      const cleanup = await closeInstances(
        created.map((registration) => registration.instance).reverse(),
      );
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

async function readManifest(directory: string) {
  const path = join(directory, RUNNER_EXTENSION_MANIFEST_FILE);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Runner extension manifest ${path} must be a regular non-symbolic file.`);
  }
  const actual = await realpath(path);
  if (actual !== path && resolve(actual) !== resolve(path)) {
    throw new Error(`Runner extension manifest ${path} resolves through a symbolic link.`);
  }
  const source = await readFile(actual, "utf8");
  if (Buffer.byteLength(source) > MAX_MANIFEST_BYTES) {
    throw new Error(`Runner extension manifest ${path} exceeds the size limit.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Runner extension manifest ${path} is not valid JSON.`);
  }
  return parseRunnerExtensionManifest(parsed);
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
    if ((await lstat(current)).isSymbolicLink()) {
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Plugin loading was cancelled.");
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
