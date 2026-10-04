import { createHash } from "node:crypto";
import { posix } from "node:path";
import * as ts from "typescript";
import { isTestFile } from "./affected-tests.js";
import type { GitRunner } from "./git-repository.js";

export interface ReviewRunnerSignals {
  unreferencedSourceFiles: string[];
  testOnlyDiff: boolean;
}
export interface ReviewSignalsRecord {
  version: 1;
  runId: string;
  taskId: string;
  baselineRevision: string;
  taskRevision: string;
  changeSetId: string;
  signals: ReviewRunnerSignals;
}

const sourceExtension = /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|fs|vb|c|h|cc|cpp|hpp|hxx|hh|kt|swift|rb|php)$/i;
export function isReviewTestConfig(path: string): boolean {
  const name = posix.basename(path).toLowerCase();
  return /^(?:jest|vitest|playwright|cypress|karma|ava|mocha|nyc)\.config\./.test(name) ||
    ["pytest.ini", "conftest.py", ".coveragerc", "tox.ini", ".mocharc.json", ".mocharc.yml", ".nycrc.json"].includes(name);
}

/** Conservative reference facts: unsupported source syntax leaves a finding. */
export function reviewRunnerSignals(files: readonly { path: string; added: boolean }[], contents: ReadonlyMap<string, string>): ReviewRunnerSignals {
  const testOnlyDiff = files.length > 0 && files.every((file) => isTestFile(file.path) || isReviewTestConfig(file.path));
  const candidates = files.filter((file) => file.added && sourceExtension.test(file.path) && !isTestFile(file.path) && !isReviewTestConfig(file.path));
  const productFiles = [...contents].filter(([path]) => sourceExtension.test(path) && !isTestFile(path) && !isReviewTestConfig(path));
  const unreferencedSourceFiles = candidates.filter((file) => !productFiles.some(([path, content]) => {
    if (path === file.path) return false;
    for (const specifier of referenceSpecifiers(path, content)) {
      const resolved = specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), specifier)) : specifier;
      const withoutExtension = file.path.replace(sourceExtension, "");
      if (resolved === file.path || resolved === withoutExtension || resolved.replace(/\.[cm]?js$/, "") === withoutExtension || `${resolved}/index` === withoutExtension) return true;
    }
    return false;
  })).map((file) => file.path).sort();
  return { unreferencedSourceFiles, testOnlyDiff };
}

function referenceSpecifiers(path: string, content: string): string[] {
  if (/\.[cm]?[jt]sx?$/i.test(path)) {
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) specifiers.push(node.moduleReference.expression.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) specifiers.push((node.arguments[0] as ts.StringLiteral).text);
      ts.forEachChild(node, visit);
    };
    visit(source); return specifiers;
  }
  if (/\.(?:c|h|cc|cpp|hpp|hxx|hh)$/i.test(path)) {
    // Raw literals and preprocessor line splices need a full C lexer. Leave
    // ambiguous files unreferenced rather than manufacture a wiring fact.
    if (content.includes('R"') || /\\\r?\n/.test(content)) return [];
    const uncommented = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
    return [...uncommented.matchAll(/^\s*#\s*include\s*["<]([^">]+)[">]/gm)].map((match) => match[1]!);
  }
  return [];
}

export async function captureReviewSignals(input: {
  git: GitRunner; workspacePath: string; runId: string; taskId: string; baselineRevision: string; taskRevision: string;
}): Promise<ReviewSignalsRecord> {
  const git = async (args: string[]) => {
    const result = await input.git({ cwd: input.workspacePath, args, maxOutputBytes: 64 * 1024 * 1024 });
    if (result.exitCode !== 0) throw new Error("Review-integrity inventory is unavailable.");
    return result.stdout;
  };
  const rows = (await git(["diff", "--name-status", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", input.baselineRevision, input.taskRevision, "--"])).split("\0");
  if (rows.pop() !== "" || rows.length % 2) throw new Error("Review-integrity inventory is malformed.");
  const files: Array<{ path: string; added: boolean }> = [];
  for (let index = 0; index < rows.length; index += 2) {
    if (!/^[AMDT]$/.test(rows[index]!) || !safePath(rows[index + 1]!)) throw new Error("Review-integrity inventory has an unsupported path or status.");
    files.push({ path: rows[index + 1]!, added: rows[index] === "A" });
  }
  const listed = (await git(["ls-tree", "-r", "--name-only", "-z", input.taskRevision])).split("\0");
  if (listed.pop() !== "") throw new Error("Review-integrity tree inventory is malformed.");
  const contents = new Map<string, string>();
  for (const path of listed) {
    if (!safePath(path)) throw new Error("Review-integrity tree path is invalid.");
    if (sourceExtension.test(path) && !isTestFile(path) && !isReviewTestConfig(path)) contents.set(path, await git(["show", `${input.taskRevision}:${path}`]));
  }
  return { version: 1, runId: input.runId, taskId: input.taskId, baselineRevision: input.baselineRevision,
    taskRevision: input.taskRevision, changeSetId: reviewChangeSetId(input.runId, input.taskId, input.taskRevision), signals: reviewRunnerSignals(files, contents) };
}

export function reviewChangeSetId(runId: string, taskId: string, revision: string): string {
  return `changeset_${createHash("sha256").update(`${runId}\0${taskId}\0${revision}`).digest("hex")}`;
}
export function validateReviewSignals(value: unknown, identity: { runId: string; taskId: string; baselineRevision: string; changeSetId: string }): ReviewSignalsRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review-integrity submission record is required.");
  const record = value as ReviewSignalsRecord;
  if (record.version !== 1 || record.runId !== identity.runId || record.taskId !== identity.taskId || record.baselineRevision !== identity.baselineRevision ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.taskRevision) || record.changeSetId !== identity.changeSetId || record.changeSetId !== reviewChangeSetId(identity.runId, identity.taskId, record.taskRevision) ||
    !record.signals || typeof record.signals.testOnlyDiff !== "boolean" || !Array.isArray(record.signals.unreferencedSourceFiles) ||
    record.signals.unreferencedSourceFiles.some((path) => typeof path !== "string" || !safePath(path)) || new Set(record.signals.unreferencedSourceFiles).size !== record.signals.unreferencedSourceFiles.length) throw new Error("Review-integrity submission record differs from its exact authority.");
  return structuredClone(record);
}
function safePath(path: string): boolean {
  return !!path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !/[\\\x00-\x1f\x7f]/.test(path) && !path.split("/").some((part) => !part || part === "." || part === "..");
}
