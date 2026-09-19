import type { LanguageInvocationContext } from "./language-intelligence.js";
import { LspClientError } from "./lsp-client.js";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

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
import {
  LspClient,
  type LspClientOptions,
} from "./lsp-client.js";

const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_RESULTS = 200;
const MAX_PREVIEW_LENGTH = 240;
const MAX_TEXT_LENGTH = 4_096;
const MAX_URI_LENGTH = 8_192;

export type LspLanguageProviderErrorCode =
  | "invalid_configuration"
  | "path_outside_workspace"
  | "out_of_workspace_uri"
  | "invalid_position"
  | "invalid_response"
  | "document_too_large";

export class LspLanguageProviderError extends Error {
  constructor(
    readonly code: LspLanguageProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LspLanguageProviderError";
  }
}

export interface LspLanguageProviderOptions {
  descriptor: LanguageProviderDescriptor;
  workspaceRoot: string;
  projectConfig?: string;
  languageId: string;
  maxDocumentBytes?: number;
  client: Omit<LspClientOptions, "workspaceRoot">;
}

interface SynchronizedDocument {
  path: string;
  uri: string;
  text: string;
  version: number;
}

interface QueryContext {
  root: string;
  limit: number;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface ParsedLocation {
  uri: string;
  range: LspRange;
}

/**
 * Adapts one stdio language server to Runner V2's language-neutral contract.
 * The adapter owns document versions and treats every server-originated path as
 * untrusted until it has been resolved inside the active query root.
 */
export class LspLanguageProvider implements LanguageIntelligenceProvider {
  readonly descriptor: LanguageProviderDescriptor;

  private readonly workspaceRoot: string;
  private readonly projectConfig?: string;
  private readonly languageId: string;
  private readonly maxDocumentBytes: number;
  private readonly client: LspClient;
  private readonly documents = new Map<string, SynchronizedDocument>();
  private synchronization: Promise<void> = Promise.resolve();

  constructor(options: LspLanguageProviderOptions) {
    try {
      const descriptor = parseLanguageProviderDescriptor(options.descriptor);
      this.descriptor = Object.freeze({
        ...descriptor,
        extensions: Object.freeze([...descriptor.extensions]),
        rootMarkers: Object.freeze([...descriptor.rootMarkers]),
      });
      this.workspaceRoot = existingDirectory(options.workspaceRoot, "workspace root");
      this.languageId = languageId(options.languageId);
      this.maxDocumentBytes = boundedInteger(
        options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
        "maxDocumentBytes",
        1,
        MAX_DOCUMENT_BYTES,
      );
      if (options.projectConfig !== undefined) {
        const config = existingFile(
          containedInputPath(this.workspaceRoot, options.projectConfig),
          "project config",
        );
        this.projectConfig = config;
      }
      this.client = new LspClient({
        ...options.client,
        workspaceRoot: this.workspaceRoot,
      });
    } catch (error) {
      if (error instanceof LspLanguageProviderError) throw error;
      throw new LspLanguageProviderError(
        "invalid_configuration",
        boundedMessage(error),
        { cause: error },
      );
    }
  }

  /** Configuration is attested before construction. No language server may be
   * started by preflight without an actual ToolBroker invocation. */
  async preflight(): Promise<void> {}

  async workspaceSymbols(query: WorkspaceSymbolsQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext): Promise<CodeIntelligenceResult<WorkspaceSymbol>> {
    if (!invocation) throw new LspClientError("invalid_configuration", "Configured LSP requires the original language invocation grant authority.");
    return await this.client.withInvocation(invocation, () => this.workspaceSymbolsAuthorized(query, signal));
  }

  private async workspaceSymbolsAuthorized(
    query: WorkspaceSymbolsQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<WorkspaceSymbol>> {
    throwIfAborted(signal);
    const context = this.queryContext(query.root, query.limit);
    const response = await this.client.request<unknown>(
      "workspace/symbol",
      { query: boundedString(query.query, "symbol query", MAX_TEXT_LENGTH) },
      signal,
    );
    if (!Array.isArray(response)) throw invalidResponse("workspace/symbol must return an array.");
    const candidates: WorkspaceSymbol[] = [];
    for (const item of boundedItems(response, context.limit)) {
      if (!isObject(item) || typeof item.name !== "string" || !item.name) {
        throw invalidResponse("workspace/symbol returned an invalid symbol.");
      }
      const kind = symbolKind(item.kind);
      if (query.kind && kind !== query.kind) continue;
      const location = parseSymbolLocation(item.location);
      candidates.push({
        name: boundedText(item.name, MAX_TEXT_LENGTH),
        ...this.mapLocation(context.root, location, kind),
      });
    }
    return this.result(
      context,
      deduplicateAndSort(candidates),
      response.length > context.limit,
    );
  }

  async definition(query: PositionQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext): Promise<CodeIntelligenceResult<CodeLocation>> {
    if (!invocation) throw new LspClientError("invalid_configuration", "Configured LSP requires the original language invocation grant authority.");
    return await this.client.withInvocation(invocation, () => this.definitionAuthorized(query, signal));
  }

  private async definitionAuthorized(
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    return await this.positionRequest("textDocument/definition", query, signal);
  }

  async references(query: PositionQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext): Promise<CodeIntelligenceResult<CodeLocation>> {
    if (!invocation) throw new LspClientError("invalid_configuration", "Configured LSP requires the original language invocation grant authority.");
    return await this.client.withInvocation(invocation, () => this.referencesAuthorized(query, signal));
  }

  private async referencesAuthorized(
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    return await this.positionRequest("textDocument/references", query, signal);
  }

  async diagnostics(query: DiagnosticsQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext): Promise<CodeIntelligenceResult<CodeDiagnostic>> {
    if (!invocation) throw new LspClientError("invalid_configuration", "Configured LSP requires the original language invocation grant authority.");
    return await this.client.withInvocation(invocation, () => this.diagnosticsAuthorized(query, signal));
  }

  private async diagnosticsAuthorized(
    query: DiagnosticsQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeDiagnostic>> {
    throwIfAborted(signal);
    const context = this.queryContext(query.root, query.limit);
    if (query.path && !this.supports(query.path)) return unsupported();
    let reports: Array<{ uri: string; diagnostics: unknown[] }>;
    let diagnosticFreshness: "unversioned" | undefined;
    if (query.path) {
      const document = await this.synchronizeDocument(context.root, query.path, signal);
      const support = await this.client.diagnosticSupport();
      if (support.textDocumentPull) {
        const response = await this.client.request<unknown>(
          "textDocument/diagnostic",
          { textDocument: { uri: document.uri } },
          signal,
        );
        reports = [{ uri: document.uri, diagnostics: diagnosticItems(response) }];
      } else {
        const published = await this.client.waitForPublishedDiagnosticsOrUnversioned(
          document.uri,
          document.version,
          signal,
        );
        if (published?.unversioned) diagnosticFreshness = "unversioned";
        reports = [{ uri: document.uri, diagnostics: published?.diagnostics ?? [] }];
      }
    } else {
      const support = await this.client.diagnosticSupport();
      if (support.workspacePull) {
        const response = await this.client.request<unknown>(
          "workspace/diagnostic",
          { previousResultIds: [] },
          signal,
        );
        reports = workspaceDiagnosticReports(response);
      } else {
        const published = this.client.publishedDiagnosticsForOpenDocuments();
        if (published.some((item) => item.unversioned)) diagnosticFreshness = "unversioned";
        reports = published.map((item) => ({
          uri: item.uri,
          diagnostics: item.diagnostics,
        }));
      }
    }
    const values: CodeDiagnostic[] = [];
    let observed = 0;
    for (const report of reports) {
      for (const diagnostic of report.diagnostics) {
        observed += 1;
        if (values.length > context.limit) continue;
        values.push(this.mapDiagnostic(context.root, report.uri, diagnostic));
      }
    }
    const sorted = deduplicateAndSort(values);
    return this.result(context, sorted, observed > context.limit, diagnosticFreshness);
  }

  async close(): Promise<void> {
    await this.synchronization.catch(() => undefined);
    await this.client.close();
    this.documents.clear();
  }

  private async positionRequest(
    method: "textDocument/definition" | "textDocument/references",
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    throwIfAborted(signal);
    if (!this.supports(query.path)) return unsupported();
    const context = this.queryContext(query.root, query.limit);
    const document = await this.synchronizeDocument(context.root, query.path, signal);
    const position = lspPosition(document.text, query.line, query.column);
    const params = {
      textDocument: { uri: document.uri },
      position,
      ...(method === "textDocument/references"
        ? { context: { includeDeclaration: true } }
        : {}),
    };
    const response = await this.client.request<unknown>(method, params, signal);
    const entries = response === null
      ? []
      : Array.isArray(response)
        ? response
        : [response];
    const mapped: CodeLocation[] = [];
    for (const entry of boundedItems(entries, context.limit)) {
      mapped.push(this.mapLocation(context.root, parseLocation(entry)));
    }
    const sorted = deduplicateAndSort(mapped);
    return this.result(context, sorted, entries.length > context.limit);
  }

  private async synchronizeDocument(
    queryRoot: string,
    pathValue: string,
    signal?: AbortSignal,
  ): Promise<SynchronizedDocument> {
    return await this.serialize(async () => {
      throwIfAborted(signal);
      const path = existingFile(containedInputPath(queryRoot, pathValue), "source file");
      if (!contained(this.workspaceRoot, path)) {
        throw new LspLanguageProviderError(
          "path_outside_workspace",
          `Code path escapes the configured workspace: ${boundedText(pathValue, 256)}.`,
        );
      }
      const bytes = await readFile(path);
      if (bytes.byteLength > this.maxDocumentBytes) {
        throw new LspLanguageProviderError(
          "document_too_large",
          `Document ${displayPath(queryRoot, path)} exceeds ${this.maxDocumentBytes} bytes.`,
        );
      }
      const text = bytes.toString("utf8");
      const current = this.documents.get(path);
      if (!current) {
        const document = {
          path,
          uri: this.client.documentUri(path),
          text,
          version: 1,
        };
        await this.client.openDocument({
          path,
          languageId: this.languageId,
          version: document.version,
          text,
        });
        this.documents.set(path, document);
        return document;
      }
      if (current.text === text) return current;
      const document = { ...current, text, version: current.version + 1 };
      await this.client.updateDocument({
        path,
        version: document.version,
        text,
      });
      this.documents.set(path, document);
      return document;
    });
  }

  private mapLocation(
    queryRoot: string,
    location: ParsedLocation,
    kind?: string,
  ): CodeLocation {
    const file = this.fileFromUri(queryRoot, location.uri);
    const text = readText(file, this.maxDocumentBytes);
    const start = validatedServerPosition(text, location.range.start);
    const end = validatedServerPosition(text, location.range.end);
    if (end.line < start.line ||
        (end.line === start.line && end.character < start.character)) {
      throw invalidResponse("Language server returned a reversed range.");
    }
    return {
      path: displayPath(queryRoot, file),
      line: start.line + 1,
      column: start.character + 1,
      preview: previewLine(text, start.line),
      ...(kind ? { symbolKind: kind } : {}),
    };
  }

  private mapDiagnostic(
    queryRoot: string,
    uri: string,
    input: unknown,
  ): CodeDiagnostic {
    if (!isObject(input) || typeof input.message !== "string") {
      throw invalidResponse("Language server returned an invalid diagnostic.");
    }
    const range = parseRange(input.range);
    const location = this.mapLocation(queryRoot, { uri, range });
    return {
      ...location,
      category: diagnosticCategory(input.severity),
      code: typeof input.code === "string" || typeof input.code === "number"
        ? input.code
        : "lsp",
      message: boundedText(input.message, MAX_TEXT_LENGTH),
    };
  }

  private fileFromUri(queryRoot: string, uriValue: string): string {
    if (typeof uriValue !== "string" || uriValue.length > MAX_URI_LENGTH) {
      throw new LspLanguageProviderError(
        "out_of_workspace_uri",
        "Language server returned an invalid or oversized URI.",
      );
    }
    let path: string;
    try {
      const url = new URL(uriValue);
      if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash) {
        throw new Error("Only plain file URIs are accepted.");
      }
      path = existingFile(fileURLToPath(url), "language server result");
    } catch (error) {
      if (error instanceof LspLanguageProviderError && error.code === "invalid_configuration") {
        throw new LspLanguageProviderError(
          "out_of_workspace_uri",
          "Language server URI does not identify an existing file.",
          { cause: error },
        );
      }
      throw new LspLanguageProviderError(
        "out_of_workspace_uri",
        "Language server returned a non-file or invalid URI.",
        { cause: error },
      );
    }
    if (!contained(this.workspaceRoot, path) || !contained(queryRoot, path)) {
      throw new LspLanguageProviderError(
        "out_of_workspace_uri",
        "Language server returned a file URI outside the active workspace.",
      );
    }
    return path;
  }

  private queryContext(rootValue: string, requestedLimit?: number): QueryContext {
    let root: string;
    try {
      root = existingDirectory(rootValue, "query root");
    } catch (error) {
      throw new LspLanguageProviderError(
        "path_outside_workspace",
        "Code query root must be an existing directory inside the configured workspace.",
        { cause: error },
      );
    }
    if (!contained(this.workspaceRoot, root)) {
      throw new LspLanguageProviderError(
        "path_outside_workspace",
        "Code query root escapes the configured workspace.",
      );
    }
    return { root, limit: resultLimit(requestedLimit) };
  }

  private result<T extends CodeLocation>(
    context: QueryContext,
    values: T[],
    truncated: boolean,
    diagnosticFreshness?: "unversioned",
  ): CodeIntelligenceResult<T> {
    const sorted = values.slice(0, context.limit);
    return {
      status: "ok",
      ...(this.projectConfig && contained(context.root, this.projectConfig)
        ? { projectConfig: displayPath(context.root, this.projectConfig) }
        : {}),
      ...(diagnosticFreshness ? { diagnosticFreshness } : {}),
      results: sorted,
      truncated: truncated || values.length > context.limit,
    };
  }

  private supports(path: string): boolean {
    return this.descriptor.extensions.includes(extname(path).toLowerCase());
  }

  private async serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.synchronization.then(work, work);
    this.synchronization = run.then(() => undefined, () => undefined);
    return await run;
  }
}

function parseSymbolLocation(input: unknown): ParsedLocation {
  if (!isObject(input)) throw invalidResponse("Workspace symbol location is invalid.");
  return parseLocation(input);
}

function parseLocation(input: unknown): ParsedLocation {
  if (!isObject(input)) throw invalidResponse("Language server location is invalid.");
  if (typeof input.uri === "string") {
    return { uri: input.uri, range: parseRange(input.range) };
  }
  if (typeof input.targetUri === "string") {
    return {
      uri: input.targetUri,
      range: parseRange(input.targetSelectionRange ?? input.targetRange),
    };
  }
  throw invalidResponse("Language server location is missing a file URI.");
}

function parseRange(input: unknown): LspRange {
  if (!isObject(input)) throw invalidResponse("Language server range is invalid.");
  return {
    start: parsePosition(input.start),
    end: parsePosition(input.end),
  };
}

function parsePosition(input: unknown): LspPosition {
  if (!isObject(input) || !nonNegativeInteger(input.line) || !nonNegativeInteger(input.character)) {
    throw invalidResponse("Language server position is invalid.");
  }
  return { line: input.line, character: input.character };
}

function diagnosticItems(input: unknown): unknown[] {
  if (!isObject(input) || !Array.isArray(input.items)) {
    throw invalidResponse("textDocument/diagnostic returned an invalid report.");
  }
  return input.items;
}

function workspaceDiagnosticReports(
  input: unknown,
): Array<{ uri: string; diagnostics: unknown[] }> {
  if (!isObject(input) || !Array.isArray(input.items)) {
    throw invalidResponse("workspace/diagnostic returned an invalid report.");
  }
  return input.items.map((report) => {
    if (!isObject(report) || typeof report.uri !== "string" || !Array.isArray(report.items)) {
      throw invalidResponse("workspace/diagnostic returned an invalid document report.");
    }
    return { uri: report.uri, diagnostics: report.items };
  });
}

function lspPosition(text: string, lineValue: number, columnValue: number): LspPosition {
  if (!positivePosition(lineValue) || !positivePosition(columnValue)) {
    throw new LspLanguageProviderError(
      "invalid_position",
      "line and column must be positive 1-based integers.",
    );
  }
  const lines = sourceLines(text);
  if (lineValue > lines.length) {
    throw new LspLanguageProviderError(
      "invalid_position",
      `line ${lineValue} exceeds the source file.`,
    );
  }
  const line = lines[lineValue - 1] ?? "";
  const character = columnValue - 1;
  if (character > line.length || splitsSurrogatePair(line, character)) {
    throw new LspLanguageProviderError(
      "invalid_position",
      `column ${columnValue} is not a valid UTF-16 position on line ${lineValue}.`,
    );
  }
  return { line: lineValue - 1, character };
}

function validatedServerPosition(text: string, position: LspPosition): LspPosition {
  const lines = sourceLines(text);
  const line = lines[position.line];
  if (line === undefined || position.character > line.length ||
      splitsSurrogatePair(line, position.character)) {
    throw invalidResponse("Language server returned a position outside its file.");
  }
  return position;
}

function sourceLines(text: string): string[] {
  return text.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function splitsSurrogatePair(line: string, position: number): boolean {
  if (position <= 0 || position >= line.length) return false;
  const left = line.charCodeAt(position - 1);
  const right = line.charCodeAt(position);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function previewLine(text: string, line: number): string {
  return (sourceLines(text)[line] ?? "").trim().slice(0, MAX_PREVIEW_LENGTH);
}

function readText(path: string, maximumBytes: number): string {
  try {
    const source = readFileSync(path);
    if (source.byteLength > maximumBytes) {
      throw new LspLanguageProviderError(
        "document_too_large",
        `Language server result file exceeds ${maximumBytes} bytes.`,
      );
    }
    return source.toString("utf8");
  } catch (error) {
    if (error instanceof LspLanguageProviderError) throw error;
    throw invalidResponse("Language server result file could not be read.", error);
  }
}

function existingDirectory(pathValue: string, label: string): string {
  const path = realpathSync(resolve(pathValue));
  if (!statSync(path).isDirectory()) throw new Error(`${label} must be a directory.`);
  return path;
}

function existingFile(pathValue: string, label: string): string {
  try {
    const path = realpathSync(resolve(pathValue));
    if (!statSync(path).isFile()) throw new Error(`${label} must be a file.`);
    return path;
  } catch (error) {
    throw new LspLanguageProviderError(
      "invalid_configuration",
      `${label} must be an existing file.`,
      { cause: error },
    );
  }
}

function containedInputPath(root: string, pathValue: string): string {
  if (typeof pathValue !== "string" || !pathValue.trim() || pathValue.includes("\0")) {
    throw new LspLanguageProviderError("path_outside_workspace", "Code path is invalid.");
  }
  const requested = isAbsolute(pathValue) ? resolve(pathValue) : resolve(root, pathValue);
  const canonical = canonicalTarget(requested);
  if (!contained(root, canonical)) {
    throw new LspLanguageProviderError(
      "path_outside_workspace",
      `Code path escapes workspace: ${boundedText(pathValue, 256)}.`,
    );
  }
  return canonical;
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
      missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
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

function unsupported<T>(): CodeIntelligenceResult<T> {
  return { status: "unsupported_language", results: [], truncated: false };
}

function resultLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined
    ? Math.max(1, Math.min(MAX_RESULTS, value))
    : MAX_RESULTS;
}

function boundedItems(values: unknown[], limit: number): unknown[] {
  return values.slice(0, Math.min(values.length, limit + 1));
}

function deduplicateAndSort<T extends CodeLocation>(values: T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const extra = "name" in value ? String(value.name) :
      "code" in value ? `${String(value.code)}:${"message" in value ? String(value.message) : ""}` : "";
    unique.set(`${value.path}:${value.line}:${value.column}:${extra}`, value);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(left.path, right.path) || left.line - right.line ||
    left.column - right.column || compareText(
      "name" in left ? String(left.name) : "code" in left ? String(left.code) : "",
      "name" in right ? String(right.name) : "code" in right ? String(right.code) : "",
    ));
}

function symbolKind(value: unknown): string | undefined {
  if (!Number.isSafeInteger(value)) return undefined;
  return SYMBOL_KINDS[value as number];
}

const SYMBOL_KINDS: Readonly<Record<number, string>> = Object.freeze({
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class",
  6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum",
  11: "interface", 12: "function", 13: "variable", 14: "constant",
  15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object",
  20: "key", 21: "null", 22: "enum-member", 23: "struct", 24: "event",
  25: "operator", 26: "type-parameter",
});

function diagnosticCategory(value: unknown): CodeDiagnostic["category"] {
  switch (value) {
    case 1: return "error";
    case 2: return "warning";
    case 4: return "suggestion";
    default: return "message";
  }
}

function languageId(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9+_.-]{0,63}$/i.test(value)) {
    throw new Error("languageId is invalid.");
  }
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw invalidResponse(`${label} must be a string.`);
  return boundedText(value, maximum);
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function boundedMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error), 512);
}

function invalidResponse(message: string, cause?: unknown): LspLanguageProviderError {
  return new LspLanguageProviderError(
    "invalid_response",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function positivePosition(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Code intelligence query cancelled.", "AbortError");
  }
}
