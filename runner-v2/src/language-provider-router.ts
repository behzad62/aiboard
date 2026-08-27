import { lstatSync, realpathSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
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
  root: string;
  matchedRootMarker?: string;
}

export class LanguageProviderRoutingError extends Error {
  constructor(readonly code: "router_closed" | "path_outside_workspace", message: string) {
    super(message);
    this.name = "LanguageProviderRoutingError";
  }
}

/** Selects a protected provider per query while owning only built-in/configured lifecycles. */
export class LanguageProviderRouter implements LanguageIntelligenceProvider {
  readonly descriptor: LanguageProviderDescriptor;

  private readonly candidates: ProviderCandidate[];
  private readonly builtInProvider: LanguageIntelligenceProvider;
  private readonly configuredProviders = new Map<string, LspLanguageProvider>();
  private readonly ownedProviders: LanguageIntelligenceProvider[] = [];
  private readonly records: LanguageRouteAuditRecord[] = [];
  private readonly maxAuditRecords: number;
  private nextSequence = 1;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(options: LanguageProviderRouterOptions) {
    this.maxAuditRecords = boundedInteger(
      options.maxAuditRecords ?? DEFAULT_MAX_AUDIT_RECORDS,
      "maxAuditRecords",
      1,
      10_000,
    );
    this.builtInProvider = options.builtInProvider;
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
    return await provider.workspaceSymbols({ ...query, root: selection.root }, signal);
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
    return await provider.diagnostics({ ...query, root: selection.root }, signal);
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

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closePromise = this.closeOwnedProviders();
    return await this.closePromise;
  }

  private async closeOwnedProviders(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    for (const provider of [this.builtInProvider, ...this.ownedProviders].reverse()) {
      try {
        await provider.close();
      } catch (error) {
        failures.push(error);
      }
    }
    this.configuredProviders.clear();
    this.ownedProviders.length = 0;
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more language providers failed to close.");
    }
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
    return operation === "definition"
      ? await provider.definition({ ...query, root: selection.root }, signal)
      : await provider.references({ ...query, root: selection.root }, signal);
  }

  private select(
    _operation: LanguageRouteOperation,
    rootValue: string,
    pathValue?: string,
  ): ProviderSelection | undefined {
    this.assertOpen();
    const root = existingDirectory(rootValue);
    const path = pathValue === undefined ? undefined : containedTarget(root, pathValue);
    const extension = path ? extname(path).toLowerCase() : undefined;
    const ranked = this.candidates.flatMap((item) => {
      if (extension && !item.descriptor.extensions.includes(extension)) return [];
      const marker = matchedRootMarker(root, path, item.descriptor.rootMarkers);
      if (!extension && item.descriptor.rootMarkers.length > 0 && !marker) return [];
      return [{
        candidate: item,
        root,
        ...(marker ? { matchedRootMarker: marker } : {}),
      }];
    }).sort((left, right) =>
      Number(Boolean(right.matchedRootMarker)) - Number(Boolean(left.matchedRootMarker)) ||
      right.candidate.descriptor.priority - left.candidate.descriptor.priority ||
      compareText(left.candidate.descriptor.id, right.candidate.descriptor.id));
    if (ranked.length > 0) return ranked[0];
    if (!extension) {
      return { candidate: this.candidates[0]!, root };
    }
    return undefined;
  }

  private provider(selection: ProviderSelection): LanguageIntelligenceProvider {
    if (selection.candidate.provider) return selection.candidate.provider;
    const configured = selection.candidate.configured;
    if (!configured) throw new Error("Language provider candidate has no implementation.");
    const key = `${configured.descriptor.id}\0${pathKey(selection.root)}`;
    const existing = this.configuredProviders.get(key);
    if (existing) return existing;
    this.assertOpen();
    const projectConfig = selection.matchedRootMarker
      ? join(selection.root, ...selection.matchedRootMarker.split("/"))
      : undefined;
    const provider = new LspLanguageProvider({
      descriptor: configured.descriptor,
      workspaceRoot: selection.root,
      ...(projectConfig ? { projectConfig } : {}),
      languageId: configured.languageId,
      ...(configured.maxDocumentBytes !== undefined
        ? { maxDocumentBytes: configured.maxDocumentBytes }
        : {}),
      client: {
        command: configured.command,
        args: configured.args,
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
): string | undefined {
  if (markers.length === 0) return undefined;
  let directory = path ? dirname(path) : root;
  while (contained(root, directory)) {
    for (const marker of markers) {
      const candidate = resolve(directory, ...marker.split("/"));
      try {
        const actual = realpathSync(candidate);
        if (contained(root, actual)) return displayPath(root, candidate);
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
