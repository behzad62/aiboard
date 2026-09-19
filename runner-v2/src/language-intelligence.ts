import type { ToolExecutionContext } from "./agent-contracts.js";

/** Internal call identity. Router forwards this only to configured LSP, never
 * to built-in or extension providers. The original opaque grant is retained. */
export type LanguageInvocationContext = Readonly<ToolExecutionContext>;
export function languageInvocation(context: ToolExecutionContext): LanguageInvocationContext {
  return Object.freeze({ ...context, actor: Object.freeze({ ...context.actor }) });
}

export interface CodeLocation {
  path: string;
  line: number;
  column: number;
  preview: string;
  symbolKind?: string;
}

export interface WorkspaceSymbol extends CodeLocation {
  name: string;
}

export interface CodeDiagnostic extends CodeLocation {
  category: "error" | "warning" | "suggestion" | "message";
  code: number | string;
  message: string;
}

export interface CodeIntelligenceResult<T> {
  status: "ok" | "unsupported_language";
  projectConfig?: string;
  /** Present only when push diagnostics omitted the LSP document version. */
  diagnosticFreshness?: "unversioned";
  results: T[];
  truncated: boolean;
}

export interface WorkspaceSymbolsQuery {
  root: string;
  query: string;
  kind?: string;
  limit?: number;
}

export interface PositionQuery {
  root: string;
  path: string;
  line: number;
  column: number;
  limit?: number;
}

export interface DiagnosticsQuery {
  root: string;
  path?: string;
  limit?: number;
}

export interface LanguageProviderDescriptor {
  id: string;
  displayName: string;
  extensions: readonly string[];
  rootMarkers: readonly string[];
  priority: number;
}

export interface LanguageIntelligenceProvider {
  readonly descriptor: LanguageProviderDescriptor;
  workspaceSymbols(
    query: WorkspaceSymbolsQuery,
    signal?: AbortSignal,
    invocation?: LanguageInvocationContext,
  ): Promise<CodeIntelligenceResult<WorkspaceSymbol>>;
  definition(
    query: PositionQuery,
    signal?: AbortSignal,
    invocation?: LanguageInvocationContext,
  ): Promise<CodeIntelligenceResult<CodeLocation>>;
  references(
    query: PositionQuery,
    signal?: AbortSignal,
    invocation?: LanguageInvocationContext,
  ): Promise<CodeIntelligenceResult<CodeLocation>>;
  diagnostics(
    query: DiagnosticsQuery,
    signal?: AbortSignal,
    invocation?: LanguageInvocationContext,
  ): Promise<CodeIntelligenceResult<CodeDiagnostic>>;
  closeAgent?(owner: Pick<ToolExecutionContext, "runId" | "sessionId" | "actor">): Promise<void>;
  close(): Promise<void>;
}

const DESCRIPTOR_KEYS = new Set([
  "id",
  "displayName",
  "extensions",
  "rootMarkers",
  "priority",
]);
const PROVIDER_ID = /^[a-z][a-z0-9.-]{0,63}$/;
const FILE_EXTENSION = /^\.[a-z0-9][a-z0-9+_.-]{0,31}$/;
const MAX_ROUTING_VALUES = 64;

export function parseLanguageProviderDescriptor(
  input: unknown,
): LanguageProviderDescriptor {
  const value = exactObject(input, DESCRIPTOR_KEYS, "language provider descriptor");
  const id = boundedString(value.id, "language provider id", 64);
  if (!PROVIDER_ID.test(id)) {
    throw new Error(`Language provider id ${id} is invalid.`);
  }
  const displayName = boundedString(
    value.displayName,
    "language provider display name",
    128,
  );
  const extensions = normalizedStrings(
    value.extensions,
    "language provider extension",
    (item) => item.toLowerCase(),
  );
  if (extensions.length < 1) {
    throw new Error("Language provider requires at least one extension.");
  }
  for (const extension of extensions) {
    if (!FILE_EXTENSION.test(extension)) {
      throw new Error(`Language provider extension ${extension} is invalid.`);
    }
  }
  const rootMarkers = normalizedStrings(
    value.rootMarkers,
    "language provider root marker",
    (item) => item.replaceAll("\\", "/"),
  );
  for (const marker of rootMarkers) {
    if (!portableRelativePath(marker)) {
      throw new Error(`Language provider root marker ${marker} is invalid.`);
    }
  }
  if (
    !Number.isSafeInteger(value.priority) ||
    (value.priority as number) < -1_000 ||
    (value.priority as number) > 1_000
  ) {
    throw new Error("Language provider priority must be an integer from -1000 to 1000.");
  }
  return {
    id,
    displayName,
    extensions,
    rootMarkers,
    priority: value.priority as number,
  };
}

function normalizedStrings(
  input: unknown,
  label: string,
  normalize: (value: string) => string,
): string[] {
  if (!Array.isArray(input) || input.length > MAX_ROUTING_VALUES) {
    throw new Error(`${label}s must be an array of at most ${MAX_ROUTING_VALUES} items.`);
  }
  const values = input.map((item) => {
    if (typeof item !== "string") throw new Error(`${label} must be a string.`);
    return normalize(item.trim());
  });
  if (values.some((item) => !item)) throw new Error(`${label} must be non-empty.`);
  if (new Set(values).size !== values.length) {
    const noun = label.endsWith("extension") ? "extension" : "root marker";
    throw new Error(`Language provider contains a duplicate ${noun}.`);
  }
  return values.sort(compareCodeUnits);
}

function portableRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function exactObject(
  input: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object.`);
  }
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown field ${unknown.sort(compareCodeUnits)[0]}.`);
  }
  return value;
}

function boundedString(input: unknown, label: string, maxBytes: number): string {
  if (typeof input !== "string") throw new Error(`${label} must be a string.`);
  const value = input.trim();
  if (!value || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`${label} must contain 1 to ${maxBytes} bytes.`);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
