import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  NativeTool,
  ToolExecutionContext,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";

export interface OpenRouterApplyPatchToolOptions {
  protectedPaths?: readonly string[];
}

type ApplyPatchOperation =
  | { type: "create_file"; path: string; diff: string }
  | { type: "update_file"; path: string; diff: string }
  | { type: "delete_file"; path: string };

interface ApplyPatchInput {
  status?: "completed" | "failed";
  operation: ApplyPatchOperation;
}

interface UpdateHunk {
  header: string;
  lines: Array<{ kind: " " | "+" | "-"; text: string }>;
}

export function createOpenRouterApplyPatchTool(
  options: OpenRouterApplyPatchToolOptions = {}
): NativeTool<ApplyPatchInput> {
  return {
    definition: {
      name: "openrouter.apply_patch",
      description: "Apply an OpenRouter validated V4A patch operation.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["completed", "failed"] },
          operation: { type: "object" },
        },
        required: ["operation"],
        additionalProperties: false,
      },
      readOnly: false,
      effect: "workspace",
      modelVisible: false,
    },
    validate: validateApplyPatchInput,
    assessAccess: (input) => ({
      capability: "workspace",
      paths: [
        {
          path: brokerAccessPath(input.operation.path),
          access: input.operation.type === "delete_file" ? "delete" : "write",
        },
      ],
    }),
    execute: async (input, context) =>
      await executeApplyPatch(input, context, options),
  };
}

function validateApplyPatchInput(input: unknown): ValidationResult<ApplyPatchInput> {
  if (!isRecord(input) || !isRecord(input.operation)) {
    return { ok: false, issues: ["operation must be an object"] };
  }
  const operation = input.operation;
  if (
    operation.type !== "create_file" &&
    operation.type !== "update_file" &&
    operation.type !== "delete_file"
  ) {
    return { ok: false, issues: ["operation.type is invalid"] };
  }
  if (typeof operation.path !== "string" || !operation.path.trim()) {
    return { ok: false, issues: ["operation.path must be a non-empty string"] };
  }
  if (
    (operation.type === "create_file" || operation.type === "update_file") &&
    typeof operation.diff !== "string"
  ) {
    return { ok: false, issues: ["operation.diff must be a string"] };
  }
  if (
    input.status !== undefined &&
    input.status !== "completed" &&
    input.status !== "failed"
  ) {
    return { ok: false, issues: ["status must be completed or failed"] };
  }
  return {
    ok: true,
    value: {
      ...(input.status ? { status: input.status } : {}),
      operation: operation as ApplyPatchOperation,
    },
  };
}

async function executeApplyPatch(
  input: ApplyPatchInput,
  context: ToolExecutionContext,
  options: OpenRouterApplyPatchToolOptions
): Promise<ToolExecutionOutput> {
  if (input.status === "failed") {
    return failure("openrouter_patch_rejected", "OpenRouter returned a failed patch operation.");
  }
  if (!context.workspacePath) {
    return failure("workspace_required", "OpenRouter apply_patch requires a workspace.");
  }
  let target: string;
  try {
    target = await safeWorkspaceTarget(context.workspacePath, input.operation.path);
  } catch (error) {
    return failure(
      "path_outside_workspace",
      error instanceof Error ? error.message : "Patch path is outside the workspace."
    );
  }
  const displayPath = relative(context.workspacePath, target).split(sep).join("/");
  if (matchesProtectedPath(displayPath, options.protectedPaths)) {
    return failure(
      "protected_path",
      `${displayPath} is protected and cannot be modified.`
    );
  }

  try {
    switch (input.operation.type) {
      case "create_file": {
        if (await pathExists(target)) {
          return failure("file_exists", `${displayPath} already exists.`);
        }
        const content = applyCreateDiff(input.operation.diff);
        await mkdir(dirname(target), { recursive: true });
        await atomicWrite(target, Buffer.from(content));
        return success(`Created ${displayPath}`);
      }
      case "update_file": {
        const current = await readFile(target, "utf8");
        const next = applyUpdateDiff(current, input.operation.diff);
        await atomicWrite(target, Buffer.from(next));
        return success(`Updated ${displayPath}`);
      }
      case "delete_file": {
        await rm(target, { force: false });
        return success(`Deleted ${displayPath}`);
      }
    }
  } catch (error) {
    return failure(
      "patch_apply_failed",
      error instanceof Error ? error.message : "Failed to apply OpenRouter patch."
    );
  }
}

export function applyCreateDiff(diff: string): string {
  const trailingNewline = /\r?\n$/.test(diff);
  const lines = normalizeDiffLines(diff);
  const output: string[] = [];
  for (const line of lines) {
    if (line === "*** End of File") continue;
    if (!line.startsWith("+")) {
      throw new Error("Create-file patch lines must start with '+'.");
    }
    output.push(line.slice(1));
  }
  return output.join("\n") + (trailingNewline && output.length > 0 ? "\n" : "");
}

export function applyUpdateDiff(input: string, diff: string): string {
  const newline = input.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = input.endsWith("\n");
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  if (trailingNewline) lines.pop();
  const hunks = parseUpdateHunks(diff);
  let cursor = 0;
  for (const hunk of hunks) {
    const oldLines = hunk.lines
      .filter((line) => line.kind !== "+")
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind !== "-")
      .map((line) => line.text);
    const index = locateHunk(lines, oldLines, hunk.header, cursor);
    lines.splice(index, oldLines.length, ...newLines);
    cursor = index + newLines.length;
  }
  return lines.join(newline) + (trailingNewline ? newline : "");
}

function parseUpdateHunks(diff: string): UpdateHunk[] {
  const lines = normalizeDiffLines(diff);
  const hunks: UpdateHunk[] = [];
  let current: UpdateHunk | undefined;
  for (const line of lines) {
    if (line === "*** End of File") continue;
    if (line === "@@" || line.startsWith("@@ ")) {
      if (current) hunks.push(current);
      current = {
        header: line === "@@" ? "" : line.slice(3).trim(),
        lines: [],
      };
      continue;
    }
    if (!current) {
      throw new Error("Update patch must start with an @@ hunk marker.");
    }
    const kind = line[0] as " " | "+" | "-";
    if (kind !== " " && kind !== "+" && kind !== "-") {
      throw new Error(`Invalid V4A update line: ${line}`);
    }
    current.lines.push({ kind, text: line.slice(1) });
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) throw new Error("Update patch contains no hunks.");
  return hunks;
}

function locateHunk(
  lines: string[],
  oldLines: string[],
  header: string,
  cursor: number
): number {
  if (oldLines.length === 0) {
    if (!header) return cursor;
    const headerIndex = findHeaderLine(lines, header, cursor);
    if (headerIndex < 0) throw new Error(`Patch context '${header}' was not found.`);
    return headerIndex + 1;
  }

  let start = cursor;
  if (header) {
    const headerIndex = findHeaderLine(lines, header, cursor);
    if (headerIndex >= 0) start = headerIndex;
  }
  const strategies: Array<(value: string) => string> = [
    (value) => value,
    (value) => value.trimEnd(),
    (value) => value.trim(),
  ];
  for (const normalize of strategies) {
    const matches: number[] = [];
    for (let index = start; index <= lines.length - oldLines.length; index += 1) {
      let matchesAll = true;
      for (let offset = 0; offset < oldLines.length; offset += 1) {
        if (normalize(lines[index + offset]) !== normalize(oldLines[offset])) {
          matchesAll = false;
          break;
        }
      }
      if (matchesAll) matches.push(index);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && header) return matches[0];
  }
  throw new Error(
    `Patch hunk could not be matched${header ? ` near '${header}'` : ""}.`
  );
}

function findHeaderLine(lines: string[], header: string, cursor: number): number {
  const needle = header.trim();
  for (let index = cursor; index < lines.length; index += 1) {
    if (lines[index].includes(needle)) return index;
  }
  return -1;
}

function normalizeDiffLines(diff: string): string[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function safeWorkspaceTarget(workspacePath: string, requestedPath: string): Promise<string> {
  const normalizedPath = normalizeHostedPatchPath(requestedPath);
  const root = await realpath(workspacePath);
  const target = resolve(workspacePath, normalizedPath);
  const lexical = relative(root, target);
  if (lexical.startsWith("..") || isAbsolute(lexical)) {
    throw new Error("Patch path escapes the workspace root.");
  }

  let probe = target;
  while (!(await pathExists(probe))) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const canonicalProbe = await realpath(probe);
  const canonicalRelative = relative(root, canonicalProbe);
  if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
    throw new Error("Patch path resolves outside the workspace root.");
  }
  return target;
}

function brokerAccessPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed.replace(/^\/+/, "");
  }
  return trimmed;
}

function normalizeHostedPatchPath(path: string): string {
  const trimmed = path.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\") || trimmed.startsWith("//")) {
    throw new Error("Patch paths must be workspace-relative, not drive or UNC paths.");
  }
  const normalized = trimmed.startsWith("/") ? trimmed.replace(/^\/+/, "") : trimmed;
  if (!normalized || normalized === ".") {
    throw new Error("Patch path must name a file inside the workspace.");
  }
  if (isAbsolute(normalized)) {
    throw new Error("Patch paths must be relative to the workspace root.");
  }
  return normalized;
}

function matchesProtectedPath(
  path: string,
  protectedPaths: readonly string[] | undefined
): boolean {
  const candidate = normalizePolicyPath(path);
  return (protectedPaths ?? []).some((entry) => {
    const protectedPath = normalizePolicyPath(entry);
    if (!protectedPath.includes("/")) {
      return candidate.split("/").includes(protectedPath);
    }
    return candidate === protectedPath || candidate.startsWith(`${protectedPath}/`);
  });
}

function normalizePolicyPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.aiboard-openrouter-${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function success(message: string): ToolExecutionOutput {
  return { content: [{ type: "text", text: message }], isError: false };
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
