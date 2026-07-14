import { resolve } from "node:path";

import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { RepositoryIntelligence } from "./repository-intelligence.js";
import type { TypeScriptIntelligence } from "./typescript-intelligence.js";

export interface CodeIntelligenceToolsOptions {
  repository: RepositoryIntelligence;
  typescript: TypeScriptIntelligence;
}

type Input = Record<string, unknown>;

export function createCodeIntelligenceTools(
  options: CodeIntelligenceToolsOptions,
): NativeTool<unknown>[] {
  const tools: NativeTool<Input>[] = [
    readTool(
      "repo.manifest",
      "Return a bounded Git-aware repository manifest with file classifications",
      manifestSchema(),
      validateManifest,
      async (input, context) => await options.repository.manifest(
        workspacePath(context, input.path as string),
        {
          ...(input.cursor !== undefined ? { cursor: input.cursor as string } : {}),
          ...(input.pageSize !== undefined ? { pageSize: input.pageSize as number } : {}),
          includeIgnored: input.includeIgnored === true,
        },
        context.signal,
      ),
    ),
    readTool(
      "repo.map",
      "Return a compact deterministic repository map with source citations",
      objectSchema({
        path: pathSchema(),
        includeIgnored: { type: "boolean" },
      }, ["path"]),
      validatePathAndOptionalBooleans("includeIgnored"),
      async (input, context) => await options.repository.map(
        workspacePath(context, input.path as string),
        { includeIgnored: input.includeIgnored === true },
        context.signal,
      ),
    ),
    readTool(
      "code.workspace_symbols",
      "Search TypeScript and JavaScript workspace symbols",
      objectSchema({
        path: pathSchema(),
        query: { type: "string" },
        kind: { type: "string", minLength: 1 },
        limit: limitSchema(),
      }, ["path", "query"]),
      validateWorkspaceSymbols,
      async (input, context) => await options.typescript.workspaceSymbols({
        root: workspacePath(context, input.path as string),
        query: input.query as string,
        ...(input.kind !== undefined ? { kind: input.kind as string } : {}),
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
      }, context.signal),
    ),
    positionTool("code.definition", "Resolve the symbol definition at a source position", options),
    positionTool("code.references", "Find references to the symbol at a source position", options),
    readTool(
      "code.diagnostics",
      "Return bounded TypeScript or JavaScript syntactic and semantic diagnostics",
      objectSchema({
        path: pathSchema(),
        limit: limitSchema(),
      }, ["path"]),
      validatePathAndLimit,
      async (input, context) => {
        const path = input.path as string;
        return await options.typescript.diagnostics({
          root: requiredWorkspace(context),
          ...(path === "." ? {} : { path }),
          ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
        }, context.signal);
      },
    ),
  ];
  return tools as NativeTool<unknown>[];
}

function positionTool(
  name: "code.definition" | "code.references",
  description: string,
  options: CodeIntelligenceToolsOptions,
): NativeTool<Input> {
  return readTool(
    name,
    description,
    objectSchema({
      path: pathSchema(),
      line: { type: "integer", minimum: 1 },
      column: { type: "integer", minimum: 1 },
      limit: limitSchema(),
    }, ["path", "line", "column"]),
    validatePosition,
    async (input, context) => {
      const query = {
        root: requiredWorkspace(context),
        path: input.path as string,
        line: input.line as number,
        column: input.column as number,
        ...(input.limit !== undefined ? { limit: input.limit as number } : {}),
      };
      return name === "code.definition"
        ? await options.typescript.definition(query, context.signal)
        : await options.typescript.references(query, context.signal);
    },
  );
}

function readTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  validate: (input: unknown) => ValidationResult<Input>,
  execute: (input: Input, context: ToolExecutionContext) => Promise<unknown>,
): NativeTool<Input> {
  return {
    definition: { name, description, inputSchema, readOnly: true, effect: "none" },
    validate,
    assessAccess: (input) => ({
      capability: "filesystem.read",
      paths: [{ path: input.path as string, access: "read" }],
    }),
    execute: async (input, context) => {
      try {
        return { content: [json(await execute(input, context))], isError: false };
      } catch (cause) {
        const code = name.startsWith("repo.")
          ? "repository_scan_failed"
          : "code_intelligence_failed";
        return error(code, cause instanceof Error ? cause.message : "Code intelligence query failed.");
      }
    },
  };
}

function manifestSchema(): Record<string, unknown> {
  return objectSchema({
    path: pathSchema(),
    cursor: { type: "string", pattern: "^[0-9]+$" },
    pageSize: { type: "integer", minimum: 1, maximum: 200 },
    includeIgnored: { type: "boolean" },
  }, ["path"]);
}

function validateManifest(input: unknown): ValidationResult<Input> {
  const base = validatePathAndOptionalBooleans("includeIgnored")(input);
  if (!base.ok) return base;
  const value = base.value;
  if (value.cursor !== undefined &&
    (typeof value.cursor !== "string" || !/^\d+$/.test(value.cursor))) {
    return invalid("cursor must contain only digits");
  }
  if (value.pageSize !== undefined && !boundedInteger(value.pageSize, 1, 200)) {
    return invalid("pageSize must be an integer from 1 to 200");
  }
  return base;
}

function validateWorkspaceSymbols(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.path !== "string" || typeof input.query !== "string") {
    return invalid("path and query must be strings");
  }
  if (input.kind !== undefined && (typeof input.kind !== "string" || input.kind.length === 0)) {
    return invalid("kind must be a non-empty string");
  }
  if (input.limit !== undefined && !boundedInteger(input.limit, 1, 200)) {
    return invalid("limit must be an integer from 1 to 200");
  }
  return { ok: true, value: input };
}

function validatePosition(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.path !== "string") {
    return invalid("path must be a string");
  }
  if (!boundedInteger(input.line, 1, Number.MAX_SAFE_INTEGER) ||
    !boundedInteger(input.column, 1, Number.MAX_SAFE_INTEGER)) {
    return invalid("line and column must be positive 1-based integers");
  }
  if (input.limit !== undefined && !boundedInteger(input.limit, 1, 200)) {
    return invalid("limit must be an integer from 1 to 200");
  }
  return { ok: true, value: input };
}

function validatePathAndLimit(input: unknown): ValidationResult<Input> {
  if (!isObject(input) || typeof input.path !== "string") {
    return invalid("path must be a string");
  }
  if (input.limit !== undefined && !boundedInteger(input.limit, 1, 200)) {
    return invalid("limit must be an integer from 1 to 200");
  }
  return { ok: true, value: input };
}

function validatePathAndOptionalBooleans(...keys: string[]) {
  return (input: unknown): ValidationResult<Input> => {
    if (!isObject(input) || typeof input.path !== "string") {
      return invalid("path must be a string");
    }
    for (const key of keys) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") {
        return invalid(`${key} must be a boolean`);
      }
    }
    return { ok: true, value: input };
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function pathSchema(): Record<string, unknown> {
  return { type: "string", minLength: 1 };
}

function limitSchema(): Record<string, unknown> {
  return { type: "integer", minimum: 1, maximum: 200 };
}

function workspacePath(context: ToolExecutionContext, path: string): string {
  return resolve(requiredWorkspace(context), path);
}

function requiredWorkspace(context: ToolExecutionContext): string {
  if (!context.workspacePath) throw new Error("Code intelligence tool requires a workspace.");
  return context.workspacePath;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) &&
    (value as number) >= minimum && (value as number) <= maximum;
}

function isObject(input: unknown): input is Input {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function invalid(issue: string): ValidationResult<Input> {
  return { ok: false, issues: [issue] };
}

function json(value: unknown) {
  return { type: "json" as const, value };
}

function error(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}
