import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type { RegisteredLanguageProvider } from "./capability-registry.js";
import type {
  CodeDiagnostic,
  CodeIntelligenceResult,
  CodeLocation,
  DiagnosticsQuery,
  LanguageIntelligenceProvider,
  LanguageProviderDescriptor,
  PositionQuery,
  WorkspaceSymbol,
  WorkspaceSymbolsQuery,
} from "./language-intelligence.js";
import { parseLanguageProviderDescriptor } from "./language-intelligence.js";
import { LspLanguageProvider } from "./lsp-language-provider.js";
import type { ConfiguredLanguageServer } from "./runner-capabilities-config.js";

const DEFAULT_MAX_AUDIT_RECORDS = 1_000;

export type LanguageProviderSource = "builtin" | "configured" | `extension:${string}`;
export type LanguageRouteOperation =
  | "workspace_symbols"
  | "definition"
  | "references"
  | "diagnostics";

export interface LanguageRouteAuditRecord {
  sequence: number;
  operation: LanguageRouteOperation;
  providerId: string;
  source: LanguageProviderSource;
  matchedRootMarker?: string;
}

export interface LanguageProviderAuditMetadata {
  providerId: string;
  displayName: string;
  source: LanguageProviderSource;
  extensions: string[];
  rootMarkers: string[];
  priority: number;
}

export interface LanguageProviderRouterOptions {
  builtInProvider: LanguageIntelligenceProvider;
  extensionProviders: readonly RegisteredLanguageProvider[];
  configuredServers: readonly ConfiguredLanguageServer[];
  maxAuditRecords?: number;
}

interface ProviderCandidate {
  descriptor: LanguageProviderDescriptor;
  source: LanguageProviderSource;
  provider?: LanguageIntelligenceProvider;
  configured?: ConfiguredLanguageServer;
}

interface ProviderSelection {
  candidate: ProviderCandidate;
  callerRoot: string;
  providerRoot: string;
  path?: string;
  matchedRootMarker?: string;
  projectConfig?: string;
}

interface RootMarkerMatch {
  marker: string;
  projectRoot: string;
  projectConfig?: string;
}

export class LanguageProviderRoutingError extends Error {
  constructor(readonly code: "router_closed" | "path_outside_workspace", message: string) {
    super(message);
    this.name = "LanguageProviderRoutingError";
  }
}

/** Selects protected providers and owns their language-provider lifecycles. */
export class LanguageProviderRouter implements LanguageIntelligenceProvider {
  readonly descriptor: LanguageProviderDescriptor;

  private readonly candidates: ProviderCandidate[];
  private readonly builtInProvider: LanguageIntelligenceProvider;
  private readonly extensionProviderInstances: LanguageIntelligenceProvider[];
  private readonly configuredProviders = new Map<string, LspLanguageProvider>();
  private readonly ownedProviders: LanguageIntelligenceProvider[] = [];
  private readonly records: LanguageRouteAuditRecord[] = [];
  private readonly maxAuditRecords: number;
  private nextSequence = 1;
  private closePromise?: Promise<void>;
  private pendingCloseProviders?: LanguageIntelligenceProvider[];
  private closed = false;

  constructor(options: LanguageProviderRouterOptions) {
    this.maxAuditRecords = boundedInteger(
      options.maxAuditRecords ?? DEFAULT_MAX_AUDIT_RECORDS,
      "maxAuditRecords",
      1,
      10_000,
    );
    this.builtInProvider = options.builtInProvider;
    this.extensionProviderInstances = options.extensionProviders.map(
      (registration) => registration.provider,
    );
    const builtin = candidate(
      options.builtInProvider.descriptor,
      "builtin",
      options.builtInProvider,
    );
    const extensions = options.extensionProviders.map((registration) =>
      candidate(
        registration.descriptor,
        `extension:${registration.extensionId}`,
        registration.provider,
      ));
    const configured = options.configuredServers.map((server) => ({
      ...candidate(server.descriptor, "configured"),
      configured: cloneConfiguredServer(server),
    }));
    this.candidates = [builtin, ...extensions, ...configured];
    const identities = new Set<string>();
    for (const item of this.candidates) {
      if (identities.has(item.descriptor.id)) {
        throw new Error(`Duplicate language provider ${item.descriptor.id}.`);
      }
      identities.add(item.descriptor.id);
    }
    const extensionsUnion = [...new Set(this.candidates.flatMap(
      (item) => item.descriptor.extensions,
    ))].sort(compareText);
    const markerUnion = [...new Set(this.candidates.flatMap(
      (item) => item.descriptor.rootMarkers,
    ))].sort(compareText);
    this.descriptor = Object.freeze({
      id: "runner.language-router",
      displayName: "Runner language provider router",
      extensions: Object.freeze(extensionsUnion),
      rootMarkers: Object.freeze(markerUnion),
      priority: Math.max(...this.candidates.map((item) => item.descriptor.priority)),
    });
  }

  async workspaceSymbols(
    query: WorkspaceSymbolsQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<WorkspaceSymbol>> {
    const selection = this.select("workspace_symbols", query.root);
    if (!selection) return unsupported();
    const provider = this.provider(selection);
    this.audit("workspace_symbols", selection);
    const providerRoot = this.queryRoot(selection);
    return this.rebaseResult(
      await provider.workspaceSymbols({ ...query, root: providerRoot }, signal),
      selection,
      providerRoot,
    );
  }

  async definition(
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    return await this.positionQuery("definition", query, signal);
  }

  async references(
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    return await this.positionQuery("references", query, signal);
  }

  async diagnostics(
    query: DiagnosticsQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeDiagnostic>> {
    const selection = this.select("diagnostics", query.root, query.path);
    if (!selection) return unsupported();
    const provider = this.provider(selection);
    this.audit("diagnostics", selection);
    const providerRoot = this.queryRoot(selection);
    return this.rebaseResult(await provider.diagnostics({
      ...query,
      root: providerRoot,
      ...(selection.path ? { path: selection.path } : {}),
    }, signal), selection, providerRoot);
  }

  providerMetadata(): LanguageProviderAuditMetadata[] {
    return this.candidates.map((item) => ({
      providerId: item.descriptor.id,
      displayName: item.descriptor.displayName,
      source: item.source,
      extensions: [...item.descriptor.extensions],
      rootMarkers: [...item.descriptor.rootMarkers],
      priority: item.descriptor.priority,
    }));
  }

  auditRecords(): LanguageRouteAuditRecord[] {
    return this.records.map((record) => ({ ...record }));
  }

  /** Starts every configured stdio server so startup rejects an unusable capability atomically. */
  async preflightConfiguredServers(workspaceRoot: string): Promise<void> {
    this.assertOpen();
    const root = existingDirectory(workspaceRoot);
    for (const candidate of this.candidates) {
      if (candidate.source !== "configured") continue;
      const marker = matchedRootMarker(root, undefined, candidate.descriptor.rootMarkers);
      const provider = this.provider({
        candidate,
        callerRoot: root,
        providerRoot: marker?.projectRoot ?? root,
        ...(marker?.projectConfig ? { projectConfig: marker.projectConfig } : {}),
      });
      if (!(provider instanceof LspLanguageProvider)) {
        throw new Error(`Configured language provider ${candidate.descriptor.id} has an invalid implementation.`);
      }
      await provider.preflight();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.closePromise) return await this.closePromise;
    const attempt = this.closeOwnedProviders();
    this.closePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (this.closePromise === attempt) this.closePromise = undefined;
      throw error;
    }
  }

  private async closeOwnedProviders(): Promise<void> {
    this.pendingCloseProviders ??= uniqueProviders([
      ...this.ownedProviders.slice().reverse(),
      ...this.extensionProviderInstances.slice().reverse(),
      this.builtInProvider,
    ]);
    const failures: unknown[] = [];
    const failedProviders: LanguageIntelligenceProvider[] = [];
    for (const provider of this.pendingCloseProviders) {
      try {
        await provider.close();
      } catch (error) {
        failures.push(error);
        failedProviders.push(provider);
      }
    }
    this.pendingCloseProviders = failedProviders;
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more language providers failed to close.");
    }
    this.configuredProviders.clear();
    this.ownedProviders.length = 0;
  }

  private async positionQuery(
    operation: "definition" | "references",
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    const selection = this.select(operation, query.root, query.path);
    if (!selection) return unsupported();
    const provider = this.provider(selection);
    this.audit(operation, selection);
    const providerRoot = this.queryRoot(selection);
    const routed = {
      ...query,
      root: providerRoot,
      ...(selection.path ? { path: selection.path } : {}),
    };
    const result = operation === "definition"
      ? await provider.definition(routed, signal)
      : await provider.references(routed, signal);
    return this.rebaseResult(result, selection, providerRoot);
  }

  private select(
    _operation: LanguageRouteOperation,
    rootValue: string,
    pathValue?: string,
  ): ProviderSelection | undefined {
    this.assertOpen();
    const callerRoot = existingDirectory(rootValue);
    const path = pathValue === undefined ? undefined : containedTarget(callerRoot, pathValue);
    const extension = path ? extname(path).toLowerCase() : undefined;
    const ranked = this.candidates.flatMap((item) => {
      if (extension && !item.descriptor.extensions.includes(extension)) return [];
      const marker = matchedRootMarker(callerRoot, path, item.descriptor.rootMarkers);
      if (!extension && item.descriptor.rootMarkers.length > 0 && !marker) return [];
      return [{
        candidate: item,
        callerRoot,
        providerRoot: marker?.projectRoot ?? callerRoot,
        ...(path ? { path } : {}),
        ...(marker ? {
          matchedRootMarker: marker.marker,
          ...(marker.projectConfig ? { projectConfig: marker.projectConfig } : {}),
        } : {}),
      }];
    }).sort((left, right) =>
      Number(Boolean(right.matchedRootMarker)) - Number(Boolean(left.matchedRootMarker)) ||
      right.candidate.descriptor.priority - left.candidate.descriptor.priority ||
      compareText(left.candidate.descriptor.id, right.candidate.descriptor.id));
    if (ranked.length > 0) return ranked[0];
    if (!extension) {
      return {
        candidate: this.candidates[0]!,
        callerRoot,
        providerRoot: callerRoot,
      };
    }
    return undefined;
  }

  private provider(selection: ProviderSelection): LanguageIntelligenceProvider {
    if (selection.candidate.provider) return selection.candidate.provider;
    const configured = selection.candidate.configured;
    if (!configured) throw new Error("Language provider candidate has no implementation.");
    const key = `${configured.descriptor.id}\0${pathKey(selection.providerRoot)}`;
    const existing = this.configuredProviders.get(key);
    if (existing) return existing;
    this.assertOpen();
    const provider = new LspLanguageProvider({
      descriptor: configured.descriptor,
      workspaceRoot: selection.providerRoot,
      ...(selection.projectConfig ? { projectConfig: selection.projectConfig } : {}),
      languageId: configured.languageId,
      ...(configured.maxDocumentBytes !== undefined
        ? { maxDocumentBytes: configured.maxDocumentBytes }
        : {}),
      client: {
        command: configured.command,
        args: configured.args,
        ...(configured.commandIdentity
          ? { attestedCommand: { ...configured.commandIdentity } }
          : {}),
        ...(configured.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: configured.requestTimeoutMs }
          : {}),
        ...(configured.shutdownTimeoutMs !== undefined
          ? { shutdownTimeoutMs: configured.shutdownTimeoutMs }
          : {}),
        ...(configured.restartLimit !== undefined
          ? { restartLimit: configured.restartLimit }
          : {}),
        ...(configured.maxFrameBytes !== undefined
          ? { maxFrameBytes: configured.maxFrameBytes }
          : {}),
        ...(configured.maxPendingRequests !== undefined
          ? { maxPendingRequests: configured.maxPendingRequests }
          : {}),
      },
    });
    this.configuredProviders.set(key, provider);
    this.ownedProviders.push(provider);
    return provider;
  }

  private queryRoot(selection: ProviderSelection): string {
    // The built-in provider historically owns the caller workspace and uses it
    // to discover nested TypeScript projects. Configured and extension providers
    // instead start at their matched project root, then have results rebased.
    return selection.candidate.source === "builtin"
      ? selection.callerRoot
      : selection.providerRoot;
  }

  private rebaseResult<T extends CodeLocation>(
    result: CodeIntelligenceResult<T>,
    selection: ProviderSelection,
    providerRoot: string,
  ): CodeIntelligenceResult<T> {
    return {
      ...result,
      ...(result.projectConfig === undefined
        ? {}
        : {
            projectConfig: rebaseProviderPath(
              selection.callerRoot,
              providerRoot,
              result.projectConfig,
            ),
          }),
      results: result.results.map((value) => ({
        ...value,
        path: rebaseProviderPath(selection.callerRoot, providerRoot, value.path),
      })),
    };
  }

  private audit(operation: LanguageRouteOperation, selection: ProviderSelection): void {
    this.records.push(Object.freeze({
      sequence: this.nextSequence++,
      operation,
      providerId: selection.candidate.descriptor.id,
      source: selection.candidate.source,
      ...(selection.matchedRootMarker
        ? { matchedRootMarker: selection.matchedRootMarker }
        : {}),
    }));
    if (this.records.length > this.maxAuditRecords) this.records.shift();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new LanguageProviderRoutingError("router_closed", "Language provider router is closed.");
    }
  }
}

function uniqueProviders(
  providers: readonly LanguageIntelligenceProvider[],
): LanguageIntelligenceProvider[] {
  const seen = new Set<LanguageIntelligenceProvider>();
  return providers.filter((provider) => {
    if (seen.has(provider)) return false;
    seen.add(provider);
    return true;
  });
}

function candidate(
  descriptorValue: LanguageProviderDescriptor,
  source: LanguageProviderSource,
  provider?: LanguageIntelligenceProvider,
): ProviderCandidate {
  const descriptor = parseLanguageProviderDescriptor(descriptorValue);
  return {
    descriptor: Object.freeze({
      ...descriptor,
      extensions: Object.freeze([...descriptor.extensions]),
      rootMarkers: Object.freeze([...descriptor.rootMarkers]),
    }),
    source,
    ...(provider ? { provider } : {}),
  };
}

function cloneConfiguredServer(input: ConfiguredLanguageServer): ConfiguredLanguageServer {
  return {
    descriptor: {
      ...input.descriptor,
      extensions: [...input.descriptor.extensions],
      rootMarkers: [...input.descriptor.rootMarkers],
    },
    languageId: input.languageId,
    command: input.command,
    args: [...input.args],
    ...(input.commandIdentity ? { commandIdentity: { ...input.commandIdentity } } : {}),
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
    ...(input.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: input.shutdownTimeoutMs } : {}),
    ...(input.restartLimit !== undefined ? { restartLimit: input.restartLimit } : {}),
    ...(input.maxFrameBytes !== undefined ? { maxFrameBytes: input.maxFrameBytes } : {}),
    ...(input.maxPendingRequests !== undefined
      ? { maxPendingRequests: input.maxPendingRequests }
      : {}),
    ...(input.maxDocumentBytes !== undefined ? { maxDocumentBytes: input.maxDocumentBytes } : {}),
  };
}

function matchedRootMarker(
  root: string,
  path: string | undefined,
  markers: readonly string[],
): RootMarkerMatch | undefined {
  if (markers.length === 0) return undefined;
  let directory = path ? dirname(path) : root;
  while (contained(root, directory)) {
    for (const marker of markers) {
      const candidate = resolve(directory, ...marker.split("/"));
      try {
        const actual = realpathSync(candidate);
        const metadata = statSync(actual);
        if (
          contained(root, actual) &&
          contained(directory, actual) &&
          (metadata.isFile() || metadata.isDirectory())
        ) {
          return {
            marker: displayPath(root, candidate),
            projectRoot: directory,
            ...(metadata.isFile() ? { projectConfig: actual } : {}),
          };
        }
      } catch {}
    }
    if (path === undefined || directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
}

function existingDirectory(pathValue: string): string {
  try {
    const path = realpathSync(resolve(pathValue));
    if (!statSync(path).isDirectory()) throw new Error("not a directory");
    return path;
  } catch {
    throw new LanguageProviderRoutingError(
      "path_outside_workspace",
      "Language query root must be an existing directory.",
    );
  }
}

function containedTarget(root: string, pathValue: string): string {
  if (typeof pathValue !== "string" || !pathValue.trim() || pathValue.includes("\0")) {
    throw new LanguageProviderRoutingError("path_outside_workspace", "Language path is invalid.");
  }
  const requested = isAbsolute(pathValue) ? resolve(pathValue) : resolve(root, pathValue);
  const actual = canonicalTarget(requested);
  if (!contained(root, actual)) {
    throw new LanguageProviderRoutingError(
      "path_outside_workspace",
      "Language path escapes the active workspace.",
    );
  }
  return actual;
}

function canonicalTarget(target: string): string {
  let current = target;
  const missing: string[] = [];
  while (true) {
    try {
      lstatSync(current);
      return resolve(realpathSync(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function rebaseProviderPath(
  callerRoot: string,
  providerRoot: string,
  value: string,
): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new LanguageProviderRoutingError(
      "path_outside_workspace",
      "Language provider returned an invalid path.",
    );
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(providerRoot, value);
  if (!contained(callerRoot, path)) {
    throw new LanguageProviderRoutingError(
      "path_outside_workspace",
      "Language provider returned a path outside the caller workspace.",
    );
  }
  return displayPath(callerRoot, path);
}

function unsupported<T>(): CodeIntelligenceResult<T> {
  return { status: "unsupported_language", results: [], truncated: false };
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
