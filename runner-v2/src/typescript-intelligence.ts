import { readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import * as ts from "typescript";

import { RepositoryIntelligence } from "./repository-intelligence.js";

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
  code: number;
  message: string;
}

export interface CodeIntelligenceResult<T> {
  status: "ok" | "unsupported_language";
  projectConfig?: string;
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

interface LoadedProject {
  root: string;
  configPath?: string;
  service: ts.LanguageService;
  fileNames: string[];
}

const MAX_RESULTS = 200;
const MAX_PREVIEW_LENGTH = 240;

export class TypeScriptIntelligence {
  constructor(
    private readonly repository = new RepositoryIntelligence(),
  ) {}

  async workspaceSymbols(
    query: WorkspaceSymbolsQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<WorkspaceSymbol>> {
    throwIfAborted(signal);
    const project = await this.loadProject(query.root, undefined, signal);
    const limit = resultLimit(query.limit);
    const items = project.service.getNavigateToItems(
      query.query,
      limit + 1,
      undefined,
      true,
      true,
    );
    const results = items
      .filter((item) => !query.kind || item.kind === query.kind)
      .map((item) => ({
        name: item.name,
        ...locationFor(project.root, item.fileName, item.textSpan, item.kind),
      }));
    return result(project, deduplicateAndSort(results).slice(0, limit), results.length > limit);
  }

  async definition(
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    if (!isTypeScriptOrJavaScript(query.path)) return unsupported();
    const project = await this.loadProject(query.root, query.path, signal);
    const fileName = containedFile(project.root, query.path);
    const position = positionFor(project, fileName, query.line, query.column);
    const definitions = project.service.getDefinitionAtPosition(fileName, position) ?? [];
    return locationsResult(project, definitions, query.limit);
  }

  async references(
    query: PositionQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeLocation>> {
    if (!isTypeScriptOrJavaScript(query.path)) return unsupported();
    const project = await this.loadProject(query.root, query.path, signal);
    const fileName = containedFile(project.root, query.path);
    const position = positionFor(project, fileName, query.line, query.column);
    const references = project.service.getReferencesAtPosition(fileName, position) ?? [];
    return locationsResult(project, references, query.limit);
  }

  async diagnostics(
    query: DiagnosticsQuery,
    signal?: AbortSignal,
  ): Promise<CodeIntelligenceResult<CodeDiagnostic>> {
    if (query.path && !isTypeScriptOrJavaScript(query.path)) return unsupported();
    const project = await this.loadProject(query.root, query.path, signal);
    const fileNames = query.path
      ? [containedFile(project.root, query.path)]
      : project.fileNames;
    const limit = resultLimit(query.limit);
    const diagnostics: CodeDiagnostic[] = [];
    for (const fileName of fileNames) {
      throwIfAborted(signal);
      const values = [
        ...project.service.getSyntacticDiagnostics(fileName),
        ...project.service.getSemanticDiagnostics(fileName),
      ];
      for (const diagnostic of values) {
        if (!diagnostic.file || diagnostic.start === undefined) continue;
        diagnostics.push({
          ...locationFor(
            project.root,
            diagnostic.file.fileName,
            { start: diagnostic.start, length: diagnostic.length ?? 0 },
          ),
          category: diagnosticCategory(diagnostic.category),
          code: diagnostic.code,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        });
      }
    }
    const sorted = deduplicateAndSort(diagnostics);
    return result(project, sorted.slice(0, limit), sorted.length > limit);
  }

  private async loadProject(
    rootValue: string,
    requestedPath?: string,
    signal?: AbortSignal,
  ): Promise<LoadedProject> {
    const root = resolve(rootValue);
    const requestedFile = requestedPath ? containedFile(root, requestedPath) : root;
    const configPath = findProjectConfig(root, requestedFile);
    let fileNames: string[];
    let options: ts.CompilerOptions;
    if (configPath) {
      const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
      if (loaded.error) throw new Error(formatDiagnostic(loaded.error));
      const parsed = ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        dirname(configPath),
        undefined,
        configPath,
      );
      if (parsed.errors.length > 0) throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
      fileNames = parsed.fileNames;
      options = parsed.options;
    } else {
      const snapshot = await this.repository.snapshot(root, {}, signal);
      fileNames = snapshot.entries
        .filter((entry) => isTypeScriptOrJavaScript(entry.path))
        .map((entry) => containedFile(root, entry.path));
      options = {
        allowJs: true,
        checkJs: true,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
      };
    }
    fileNames = [...new Set(fileNames.map((fileName) => resolve(fileName)))]
      .sort((left, right) => left.localeCompare(right));
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => options,
      getCurrentDirectory: () => root,
      getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
      getScriptFileNames: () => fileNames,
      getScriptSnapshot: (fileName) => {
        const source = ts.sys.readFile(fileName);
        return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
      },
      getScriptVersion: (fileName) => {
        try {
          return String(statSync(fileName).mtimeMs);
        } catch {
          return "0";
        }
      },
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
    };
    return {
      root,
      ...(configPath ? { configPath } : {}),
      service: ts.createLanguageService(host, ts.createDocumentRegistry()),
      fileNames,
    };
  }
}

function findProjectConfig(root: string, requestedFile: string): string | undefined {
  let directory = requestedFile === root ? root : dirname(requestedFile);
  while (isContained(root, directory)) {
    const tsconfig = resolve(directory, "tsconfig.json");
    if (ts.sys.fileExists(tsconfig)) return tsconfig;
    const jsconfig = resolve(directory, "jsconfig.json");
    if (ts.sys.fileExists(jsconfig)) return jsconfig;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return undefined;
}

function positionFor(
  project: LoadedProject,
  fileName: string,
  line: number,
  column: number,
): number {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
    throw new Error("line and column must be positive 1-based integers.");
  }
  const source = project.service.getProgram()?.getSourceFile(fileName);
  if (!source) throw new Error(`Source file is not part of the TypeScript project: ${fileName}`);
  if (line > source.getLineAndCharacterOfPosition(source.getEnd()).line + 1) {
    throw new Error(`line ${line} exceeds the source file.`);
  }
  const lineStart = source.getPositionOfLineAndCharacter(line - 1, 0);
  const lineEnd = source.getLineEndOfPosition(lineStart);
  const position = lineStart + column - 1;
  if (position > lineEnd) throw new Error(`column ${column} exceeds line ${line}.`);
  return position;
}

function locationsResult(
  project: LoadedProject,
  entries: readonly ts.DocumentSpan[],
  requestedLimit?: number,
): CodeIntelligenceResult<CodeLocation> {
  const limit = resultLimit(requestedLimit);
  const locations = entries
    .filter((entry) => isContained(project.root, entry.fileName))
    .map((entry) => locationFor(
      project.root,
      entry.fileName,
      entry.textSpan,
      "kind" in entry && typeof entry.kind === "string" ? entry.kind : undefined,
    ));
  const sorted = deduplicateAndSort(locations);
  return result(project, sorted.slice(0, limit), sorted.length > limit);
}

function locationFor(
  root: string,
  fileName: string,
  span: ts.TextSpan,
  symbolKind?: string,
): CodeLocation {
  const source = readFileSync(fileName, "utf8");
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const position = sourceFile.getLineAndCharacterOfPosition(span.start);
  const lines = source.split(/\r?\n/);
  const preview = (lines[position.line] ?? "").trim().slice(0, MAX_PREVIEW_LENGTH);
  return {
    path: displayPath(root, fileName),
    line: position.line + 1,
    column: position.character + 1,
    preview,
    ...(symbolKind ? { symbolKind } : {}),
  };
}

function result<T>(
  project: LoadedProject,
  results: T[],
  truncated: boolean,
): CodeIntelligenceResult<T> {
  return {
    status: "ok",
    ...(project.configPath
      ? { projectConfig: displayPath(project.root, project.configPath) }
      : {}),
    results,
    truncated,
  };
}

function unsupported<T>(): CodeIntelligenceResult<T> {
  return { status: "unsupported_language", results: [], truncated: false };
}

function deduplicateAndSort<T extends CodeLocation>(values: T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const extra = "name" in value ? String(value.name) : "code" in value ? String(value.code) : "";
    unique.set(`${value.path}:${value.line}:${value.column}:${extra}`, value);
  }
  return [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path) || left.line - right.line ||
    left.column - right.column ||
    (("name" in left ? String(left.name) : "code" in left ? String(left.code) : "")
      .localeCompare("name" in right ? String(right.name) : "code" in right ? String(right.code) : "")),
  );
}

function diagnosticCategory(category: ts.DiagnosticCategory): CodeDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error: return "error";
    case ts.DiagnosticCategory.Warning: return "warning";
    case ts.DiagnosticCategory.Suggestion: return "suggestion";
    case ts.DiagnosticCategory.Message: return "message";
  }
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function isTypeScriptOrJavaScript(path: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]
    .includes(extname(path).toLowerCase());
}

function containedFile(root: string, path: string): string {
  const fileName = resolve(root, path);
  if (!isContained(root, fileName)) throw new Error(`Code path escapes workspace: ${path}`);
  return fileName;
}

function isContained(root: string, path: string): boolean {
  const relation = relative(root, resolve(path));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`));
}

function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function resultLimit(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined
    ? Math.max(1, Math.min(MAX_RESULTS, value))
    : MAX_RESULTS;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Code intelligence query cancelled.");
}
