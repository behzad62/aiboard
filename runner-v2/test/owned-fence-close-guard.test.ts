// FL2's POSIX close guard (docs/plans/2026-11-14-fence-lock-design.md, §6 item 8). The owned fence lock is a POSIX
// record lock, and on Linux and macOS ANY close() of the lock file in the holding process ends every lock that process
// holds on it: one readFileSync of a held lock file silently ends mutual exclusion (measured, design note §4.5). So
// nothing in runner-v2/src but owned-fence-lock.mjs (and launcher-instance.ts, the launcher's own lock) may open a lock
// file: no read, open, copy, stream or watch API takes a lock path. lstat, exists, rm and unlink are fine; they open
// nothing. And node:sqlite stays the only SQLite library: a second copy would not share SQLite's per-inode lock tracking,
// so its closes would end the first one's locks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { ArtifactReachabilityGuard } from "../src/artifact-reachability.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { withOwnedFenceLock } from "../src/owned-fence-lock.mjs";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_ROOT = join(REPOSITORY_ROOT, "runner-v2", "src");
const HOLDER = fileURLToPath(new URL("./fixtures/owned-fence-lock-holder.mjs", import.meta.url));
const EXEMPT = new Set(["owned-fence-lock.mjs", "launcher-instance.ts"]);
const OPENING_APIS = new Set([
  "readFileSync", "readFile", "openSync", "open", "openAsBlob", "createReadStream", "createWriteStream", "copyFileSync", "copyFile",
  "cpSync", "cp", "appendFileSync", "appendFile", "writeFileSync", "writeFile", "truncateSync", "truncate", "watch", "watchFile",
]);
// The names the Runner gives its own lock paths (lockPath, fenceLockPath, pairingLockPath, lockFile...), never a
// project's package lockfile.
const LOCK_NAME = /^(?:[a-z]+[A-Z]?)?[lL]ock(?:Path|File)$/;

test("no Runner module but the lock's own opens a lock file", () => {
  const sources = sourceFiles(SOURCE_ROOT)
    .map((path) => ({ name: relative(SOURCE_ROOT, path).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }))
    .filter((source) => !EXEMPT.has(source.name));
  assert.deepEqual(lockFileOpens(sources), []);
});

// Acceptance: the static close guard fails on a planted readFileSync of a lock path.
test("the close guard catches a planted open of a lock path, in every spelling the Runner uses", () => {
  const planted = [
    'import { readFileSync } from "node:fs"; export const x = (directory: string) => readFileSync(join(directory, ".fence.lock"));',
    'import { readFileSync } from "node:fs"; export function f(lockPath: string) { return readFileSync(lockPath); }',
    'import fs from "node:fs"; export function f(config: { fenceLockPath: string }) { fs.copyFileSync(config.fenceLockPath, "copy"); }',
    'import { createReadStream } from "node:fs"; export const f = (statePath: string) => createReadStream(`${statePath}.lock`);',
    'import { readFile } from "node:fs/promises"; export async function f(d: string) { const lock = join(d, ".fence.lock"); return await readFile(lock); }',
    'import { readFileSync } from "node:fs"; export function f(location: { lockPath: string }) { const path = location.lockPath; return readFileSync(path); }',
    'import { openSync } from "node:fs"; export const f = (host: { containedProcessPath(id: string, s: string): string }) => openSync(host.containedProcessPath("p", ".fence.lock"), "r");',
  ];
  for (const text of planted) assert.equal(lockFileOpens([{ name: "planted.ts", text }]).length, 1, text);
  // What a holder may do near its lock: look at it, remove it, or read the files beside it. A name that held a lock
  // path in one function is not one in another.
  const allowed = [
    'import { lstatSync, rmSync, existsSync, unlinkSync } from "node:fs"; export function f(lockPath: string, d: string) { lstatSync(lockPath); existsSync(lockPath); unlinkSync(lockPath); rmSync(join(d, ".fence.lock"), { force: true }); }',
    'import { readFileSync } from "node:fs"; export const f = (lockHolderPath: string, d: string) => [readFileSync(lockHolderPath), readFileSync(join(d, "fence.json"))];',
    'import { readFileSync } from "node:fs"; export const f = (root: string) => readFileSync(join(root, "yarn.lock"), "utf8") + readFileSync(join(root, "package-lock.json"));',
    'import { readFileSync, lstatSync } from "node:fs"; function a(location: { lockPath: string }) { const path = location.lockPath; return lstatSync(path); } function b(path: string) { return readFileSync(path); } export { a, b };',
  ];
  for (const text of allowed) assert.deepEqual(lockFileOpens([{ name: "allowed.ts", text }]), [], text);
});

// The static guard sees lock paths by name; a directory walk reaches them by readdir. The artifact scan walks the
// whole state directory while the Runner may hold any lock in it, so: hold the locks it would meet, run the scan, and
// another process must still find every one held.
test("the artifact scan leaves a lock this process holds held", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-close-guard-scan-"));
  try {
    const fenceLock = join(root, "builds", "run", "process-backend", "owned-1", ".fence.lock");
    const stateLock = join(root, "builds", "run", "oci-leases.json.lock");
    mkdirSync(dirname(fenceLock), { recursive: true });
    writeFileSync(join(root, "builds", "run", "oci-leases.json"), "[]");
    const guard = new ArtifactReachabilityGuard(root, new ArtifactStore(join(root, "artifacts")));
    const outcomes = await withOwnedFenceLock(fenceLock, async () => await withOwnedFenceLock(stateLock, async () => {
      await guard.runQuiescent(async () => { await guard.prepareReachabilityIndex(); });
      return await Promise.all([fenceLock, stateLock].map((path) => claimElsewhere(path)));
    }));
    assert.equal(guard.scanCount, 1);
    for (const outcome of outcomes) assert.equal(outcome.state, "refused", JSON.stringify(outcome));
    for (const outcome of outcomes) assert.equal(outcome.name, "OwnedFenceContentionError", JSON.stringify(outcome));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** One claim from another process with a short deadline: what the fixture holder reports. */
async function claimElsewhere(lockPath: string): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [HOLDER, "hold", lockPath, "", "300", "0"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
  return JSON.parse(output.split("\n")[0]!) as Record<string, unknown>;
}

test("node:sqlite is the Runner's only SQLite library", () => {
  const foreign = sourceFiles(SOURCE_ROOT).flatMap((path) => {
    const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, scriptKind(path));
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        specifiers.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")))
        specifiers.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    // The Runner's own modules (./sqlite-*.js) use node:sqlite; only a package could bring another copy of SQLite.
    return specifiers.filter((specifier) => !specifier.startsWith(".") && /sqlite|sql\.js|libsql/i.test(specifier) && specifier !== "node:sqlite")
      .map((specifier) => `${relative(SOURCE_ROOT, path)}: ${specifier}`);
  });
  assert.deepEqual(foreign, []);
  for (const manifest of ["package.json", join("runner-v2", "package.json")]) {
    let parsed: Record<string, Record<string, string> | undefined>;
    try { parsed = JSON.parse(readFileSync(join(REPOSITORY_ROOT, manifest), "utf8")); } catch { continue; }
    const dependencies = ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((key) => Object.keys(parsed[key] ?? {}));
    assert.deepEqual(dependencies.filter((name) => /sqlite|sql\.js|libsql/i.test(name)), [], manifest);
  }
});

/**
 * Every call of an opening API whose arguments name a lock path: a `.fence.lock` literal, a template ending in `.lock`,
 * a lock-path name (LOCK_NAME), or a variable that was given one of those. Variables are resolved by TypeScript's own
 * binder, so a name means a lock path only where it was given one.
 */
function lockFileOpens(sources: ReadonlyArray<{ readonly name: string; readonly text: string }>): string[] {
  const texts = new Map(sources.map((source) => [`/virtual/${source.name}`, source.text]));
  const options: ts.CompilerOptions = { allowJs: true, noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (fileName, languageVersion) => {
    const text = texts.get(fileName);
    return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true, scriptKind(fileName));
  };
  host.fileExists = (fileName) => texts.has(fileName);
  host.readFile = (fileName) => texts.get(fileName);
  host.getCanonicalFileName = (fileName) => fileName;
  host.useCaseSensitiveFileNames = () => true;
  host.getCurrentDirectory = () => "/virtual";
  const program = ts.createProgram({ rootNames: [...texts.keys()], options, host });
  const checker = program.getTypeChecker();
  const lockSymbols = new Set<ts.Symbol>();
  const namesLock = (node: ts.Node): boolean => {
    if (ts.isStringLiteralLike(node)) return /\.fence\.lock$/.test(node.text);
    if (ts.isTemplateExpression(node) && /\.lock$/.test(node.templateSpans.at(-1)?.literal.text ?? "")) return true;
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      return LOCK_NAME.test(node.text) || (symbol !== undefined && lockSymbols.has(symbol));
    }
    if (ts.isPropertyAccessExpression(node) && LOCK_NAME.test(node.name.text)) return true;
    let found = false;
    ts.forEachChild(node, (child) => { if (!found && !ts.isFunctionLike(child)) found = namesLock(child); });
    return found;
  };
  const files = program.getSourceFiles().filter((file) => texts.has(file.fileName));
  // Variables given a lock path, and variables given those, until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && namesLock(node.initializer)) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol && !lockSymbols.has(symbol)) { lockSymbols.add(symbol); changed = true; }
      }
      ts.forEachChild(node, collect);
    };
    for (const file of files) collect(file);
  }
  const found: string[] = [];
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const api = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (OPENING_APIS.has(api) && node.arguments.some(namesLock)) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          found.push(`${file.fileName.slice("/virtual/".length)}:${line + 1} ${node.getText(file).slice(0, 120)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found;
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".mts", ".mjs", ".js", ".cjs"].includes(extname(entry.name)) && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".d.mts")
      ? [path] : [];
  });
}

function scriptKind(path: string): ts.ScriptKind {
  return /\.(?:mjs|js|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}
