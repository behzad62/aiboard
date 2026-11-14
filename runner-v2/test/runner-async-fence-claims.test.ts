// FL3 (docs/plans/2026-11-14-fence-lock-design.md): every owned fence claim the Runner process makes is async, so a
// held lock never blocks the Runner's event loop (a sync wait there also kept the Runner from reaping a dead
// supervisor). Only the processes the Runner spawns by path, the portable supervisor and the POSIX child, keep sync
// claims: they run in their own processes, through runPortableFenceEffectSync.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const RUNNER_ENTRIES = ["cli.ts", "launcher.ts"];
const SYNC_CLAIMS = new Set(["withOwnedFenceLockSync", "runPortableFenceEffectSync"]);
// The two definitions, and the one sync claim that runs in the supervisor and child: nothing in the Runner calls it.
const DEFINITIONS: Record<string, ReadonlySet<string>> = {
  "owned-fence-lock.mjs": new Set(["withOwnedFenceLockSync"]),
  "portable-process-protocol.mjs": new Set(["withOwnedFenceLockSync", "runPortableFenceEffectSync"]),
};
const SPAWNED_BY_PATH = ["portable-process-supervisor.mjs", "portable-process-child.mjs"];

test("no sync owned fence claim is reachable from the Runner process", () => {
  const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const reachable = reachableModules(RUNNER_ENTRIES.map((entry) => join(SOURCE_ROOT, entry)), read);
  const names = [...reachable.keys()].map((path) => relative(SOURCE_ROOT, path).replaceAll("\\", "/"));
  assert.ok(names.includes("native-process-backend.ts") && names.includes("owned-fence-lock.mjs"), "the walk reaches the fence modules");
  for (const spawned of SPAWNED_BY_PATH) assert.equal(names.includes(spawned), false, `${spawned} runs in its own process, never imported`);
  assert.deepEqual(syncClaimReferences(reachable), []);
});

// The guard must see a sync claim wherever the Runner could make one: imported directly, re-exported, or reached
// through a module the Runner imports.
test("the reachability guard catches a planted sync claim", () => {
  const planted = (files: Record<string, string>) => {
    const sources = new Map(Object.entries(files).map(([name, text]) => [resolve("/virtual", name), text]));
    return syncClaimReferences(reachableModules([resolve("/virtual", "cli.ts")], (path) => sources.get(path)));
  };
  assert.equal(planted({
    "cli.ts": 'import { claim } from "./helper.js"; claim();',
    "helper.ts": 'import { withOwnedFenceLockSync } from "./owned-fence-lock.mjs"; export const claim = () => withOwnedFenceLockSync("x", () => 1);',
    "owned-fence-lock.mjs": "export function withOwnedFenceLockSync() {}",
  }).length, 2);
  assert.equal(planted({
    "cli.ts": 'import * as protocol from "./portable-process-protocol.mjs"; protocol.runPortableFenceEffectSync({});',
    "portable-process-protocol.mjs": "export function runPortableFenceEffectSync() {}",
  }).length, 1);
  assert.equal(planted({
    "cli.ts": 'await import("./late.js");',
    "late.ts": 'export { runPortableFenceEffectSync as run } from "./portable-process-protocol.mjs";',
    "portable-process-protocol.mjs": "export function runPortableFenceEffectSync() {}",
  }).length, 1);
  assert.deepEqual(planted({
    "cli.ts": 'import { withOwnedFenceLock } from "./owned-fence-lock.mjs"; await withOwnedFenceLock("x", () => 1);',
    "owned-fence-lock.mjs": "export async function withOwnedFenceLock() {} export function withOwnedFenceLockSync() {}",
  }), []);
});

/** The modules the entries import, statically or by a literal dynamic import, resolved within the source tree. */
function reachableModules(entries: readonly string[], read: (path: string) => string | undefined): Map<string, ts.SourceFile> {
  const modules = new Map<string, ts.SourceFile>();
  const queue = [...entries];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (modules.has(path)) continue;
    const text = read(path);
    if (text === undefined) throw new Error(`unresolved Runner module ${path}`);
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, /\.(?:mjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    modules.set(path, file);
    const visit = (node: ts.Node): void => {
      let specifier: string | undefined;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
        specifier = node.moduleSpecifier.text;
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]))
        specifier = node.arguments[0].text;
      if (specifier?.startsWith(".")) {
        const target = resolveModule(resolve(dirname(path), specifier), read);
        if (target) queue.push(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return modules;
}

function resolveModule(path: string, read: (path: string) => string | undefined): string | undefined {
  const candidates = path.endsWith(".js") ? [path.slice(0, -3) + ".ts", path] : [path];
  return candidates.find((candidate) => read(candidate) !== undefined);
}

/** Every reference to a sync claim outside its definitions, as `module:line name`. */
function syncClaimReferences(modules: ReadonlyMap<string, ts.SourceFile>): string[] {
  const found: string[] = [];
  for (const [path, file] of modules) {
    const name = path.slice(path.lastIndexOf(path.includes("\\") ? "\\" : "/") + 1);
    const allowed = DEFINITIONS[name] ?? new Set<string>();
    const visit = (node: ts.Node): void => {
      const text = ts.isIdentifier(node) ? node.text : undefined;
      if (text && SYNC_CLAIMS.has(text) && !allowed.has(text)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
        found.push(`${name}:${line + 1} ${text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  // Inside the protocol module, the sync claim is reached only through runPortableFenceEffectSync, which the Runner
  // never imports (checked above).
  for (const [path, file] of modules) {
    if (!path.endsWith("portable-process-protocol.mjs")) continue;
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === "runPortableFenceEffectSync") continue;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && SYNC_CLAIMS.has(node.text) && !ts.isImportDeclaration(statement)) {
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          found.push(`portable-process-protocol.mjs:${line + 1} ${node.text} outside runPortableFenceEffectSync`);
        }
        ts.forEachChild(node, visit);
      };
      visit(statement);
    }
  }
  return found;
}
