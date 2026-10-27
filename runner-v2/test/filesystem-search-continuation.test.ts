import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import type { ToolResult } from "../src/agent-contracts.js";
import { SEARCH_LIMITS, SearchSessionStore, compileGlobs } from "../src/filesystem-search.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { RepositoryIntelligence } from "./support/git-fixture.js";

type Match = { path: string; line: number; column: number; text: string; before?: string[]; after?: string[] };
type Page = { matches: Match[]; truncated: boolean; state: string; exhaustive: boolean; cursor?: string; notes?: string[]; errors?: string[];
  scope: { candidates: number; scanned: number; remaining: number; skipped: Record<string, number>; snapshotTruncated: boolean } };

function workspace(prefix: string) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const project = join(root, "workspace"); mkdirSync(project, { recursive: true });
  return { root, project };
}
function broker(project: string, root: string, options: { repository?: boolean; hiddenPaths?: string[]; sessions?: SearchSessionStore } = {}) {
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const instance = new ToolBroker({ permissionProfile: "full", workspacePath: project, artifacts, maxInlineOutputBytes: 1024 * 1024 });
  for (const tool of createFilesystemTools({ artifacts, ...(options.repository ? { repository: new RepositoryIntelligence() } : {}),
    ...(options.hiddenPaths ? { hiddenPaths: options.hiddenPaths } : {}), ...(options.sessions ? { searchSessions: options.sessions } : {}) })) instance.register(tool);
  let call = 0;
  return async (args: Record<string, unknown>, actor = "worker_1"): Promise<{ page: Page; result: ToolResult }> => {
    const result = await instance.invoke({ type: "tool_call", callId: `search-${++call}`, name: "fs.search", arguments: args },
      { runId: "run_1", sessionId: "session_1", actor: { role: "worker", id: actor } });
    return { page: result.content.find(block => block.type === "json")?.value as Page, result };
  };
}
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true });

test("a target beyond the first page is reached by continuation without rescanning, duplicates or skips", async () => {
  const { root, project } = workspace("search-pages-");
  try {
    for (let index = 0; index < 30; index++) writeFileSync(join(project, `file-${String(index).padStart(2, "0")}.txt`), `alpha\nneedle ${index}\nomega\n`);
    writeFileSync(join(project, "file-99.txt"), "needle TARGET\n");
    const search = broker(project, root);
    const seen: Match[] = [];
    let { page } = await search({ path: ".", pattern: "needle", maxMatches: 10 });
    assert.equal(page.state, "running"); assert.ok(page.cursor); assert.equal(page.matches.length, 10);
    const firstScanned = page.scope.scanned;
    assert.ok(firstScanned < 31, "the first page did not scan the whole tree");
    seen.push(...page.matches);
    // Re-fetching with the same cursor is idempotent.
    const again = await search({ path: ".", pattern: "needle", maxMatches: 10, cursor: page.cursor });
    const second = await search({ path: ".", pattern: "needle", maxMatches: 10, cursor: page.cursor });
    assert.deepEqual(again.page.matches, second.page.matches);
    while (page.cursor) {
      ({ page } = await search({ path: ".", pattern: "needle", maxMatches: 10, cursor: page.cursor }));
      seen.push(...page.matches);
    }
    assert.equal(page.state, "complete"); assert.equal(page.exhaustive, true); assert.equal(page.truncated, false);
    assert.equal(page.scope.scanned, 31, "every candidate was read exactly once across pages");
    assert.equal(seen.length, 31);
    assert.equal(new Set(seen.map(match => `${match.path}:${match.line}`)).size, 31, "no duplicates");
    assert.deepEqual(seen.map(match => match.path), [...seen.map(match => match.path)].sort(), "stable path order");
    assert.equal(seen.at(-1)!.text, "needle TARGET");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("globs, regex, context lines and Git ignore rules shape the declared scope", async () => {
  const { root, project } = workspace("search-scope-");
  try {
    mkdirSync(join(project, "src", "deep"), { recursive: true }); mkdirSync(join(project, "ignored"), { recursive: true });
    writeFileSync(join(project, ".gitignore"), "ignored/\n");
    writeFileSync(join(project, "src", "a.ts"), "one\ntwo\nconst value = 41;\nthree\nfour\n");
    writeFileSync(join(project, "src", "deep", "b.tsx"), "const value = 42;\n");
    writeFileSync(join(project, "src", "c.js"), "const value = 43;\n");
    writeFileSync(join(project, "ignored", "d.ts"), "const value = 44;\n");
    writeFileSync(join(project, "src", "e.ts"), Buffer.from([0x63, 0x00, 0x6f]));
    git(project, "init"); git(project, "add", ".");
    const search = broker(project, root, { repository: true });
    const { page } = await search({ path: ".", pattern: "value = 4\\d", regex: true, include: ["src/**/*.{ts,tsx}"], contextLines: 2 });
    assert.deepEqual(page.matches.map(match => match.path), ["src/a.ts", "src/deep/b.tsx"]);
    assert.deepEqual(page.matches[0]!.before, ["one", "two"]); assert.deepEqual(page.matches[0]!.after, ["three", "four"]);
    assert.equal(page.scope.skipped.excluded, 2, "c.js and .gitignore fall outside include");
    assert.ok(page.scope.skipped.notText >= 1 || page.scope.skipped.binary >= 1, "binary content is counted, not searched");
    assert.equal(page.matches.some(match => match.path.startsWith("ignored/")), false);
    const excluded = await search({ path: ".", pattern: "const value", exclude: ["*.js", "deep/**"] });
    assert.deepEqual(excluded.page.matches.map(match => match.path), ["src/a.ts", "src/deep/b.tsx"]);
    const withIgnored = await search({ path: ".", pattern: "const value", includeIgnored: true, include: ["*.ts"] });
    assert.ok(withIgnored.page.matches.some(match => match.path === "ignored/d.ts"));
    const invalid = await search({ path: ".", pattern: "x", include: ["{unbalanced"] });
    assert.equal(invalid.result.error?.code, "invalid_glob");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hidden paths are never read and an access change blocks later pages", async () => {
  const { root, project } = workspace("search-hidden-");
  try {
    mkdirSync(join(project, "private"));
    writeFileSync(join(project, "private", "keys.txt"), "needle secret\n");
    for (let index = 0; index < 5; index++) writeFileSync(join(project, `n${index}.txt`), "needle\n");
    const search = broker(project, root, { hiddenPaths: ["private"] });
    let { page } = await search({ path: ".", pattern: "needle", maxMatches: 2 });
    const all: Match[] = [...page.matches];
    while (page.cursor) { ({ page } = await search({ path: ".", pattern: "needle", maxMatches: 2, cursor: page.cursor })); all.push(...page.matches); }
    assert.equal(all.some(match => match.path.startsWith("private")), false);
    assert.equal(page.scope.skipped.hidden, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("edits between pages make the session stale instead of mixing revisions", async () => {
  const { root, project } = workspace("search-stale-");
  try {
    for (let index = 0; index < 6; index++) writeFileSync(join(project, `f${index}.txt`), "needle\n");
    const search = broker(project, root);
    const first = await search({ path: ".", pattern: "needle", maxMatches: 2 });
    assert.equal(first.page.state, "running");
    // A not-yet-scanned candidate changes after the session started.
    writeFileSync(join(project, "f5.txt"), "needle changed\n");
    const future = new Date(Date.now() + 5_000); utimesSync(join(project, "f5.txt"), future, future);
    let page = first.page;
    const states: string[] = [];
    while (page.cursor) { ({ page } = await search({ path: ".", pattern: "needle", maxMatches: 2, cursor: page.cursor })); states.push(page.state); }
    assert.equal(page.state, "stale");
    assert.equal(page.exhaustive, false);
    assert.match(page.errors!.join("\n"), /f5\.txt changed after the search started/);
    assert.match(page.notes!.join("\n"), /original snapshot/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancel, expiry, foreign owners and changed queries are typed outcomes, never empty success", async () => {
  const { root, project } = workspace("search-lifecycle-");
  let now = 1_000_000;
  try {
    for (let index = 0; index < 4; index++) writeFileSync(join(project, `f${index}.txt`), "needle\n");
    const sessions = new SearchSessionStore(() => now);
    const search = broker(project, root, { sessions });
    const first = await search({ path: ".", pattern: "needle", maxMatches: 1 });
    const foreign = await search({ path: ".", pattern: "needle", maxMatches: 1, cursor: first.page.cursor }, "intruder");
    assert.equal(foreign.result.error?.code, "search_not_owned");
    const changed = await search({ path: ".", pattern: "other", maxMatches: 1, cursor: first.page.cursor });
    assert.equal(changed.result.error?.code, "search_cursor_mismatch");
    const cancelled = await search({ path: ".", pattern: "needle", maxMatches: 1, cursor: first.page.cursor, cancel: true });
    assert.equal(cancelled.page.state, "cancelled");
    const afterCancel = await search({ path: ".", pattern: "needle", maxMatches: 1, cursor: first.page.cursor });
    assert.equal(afterCancel.result.error?.code, "search_expired");
    const fresh = await search({ path: ".", pattern: "needle", maxMatches: 1 });
    now += SEARCH_LIMITS.idleExpiryMs + 1;
    const expired = await search({ path: ".", pattern: "needle", maxMatches: 1, cursor: fresh.page.cursor });
    assert.equal(expired.result.isError, true); assert.equal(expired.page.state, "expired"); assert.equal(expired.page.exhaustive, false);
    const tampered = await search({ path: ".", pattern: "needle", maxMatches: 1, cursor: `${fresh.page.cursor!.slice(0, -4)}0000` });
    assert.equal(tampered.result.isError, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an exhaustive zero-match result is distinguishable from a capped one", async () => {
  const { root, project } = workspace("search-limits-");
  try {
    writeFileSync(join(project, "few.txt"), "nothing here\n");
    const search = broker(project, root);
    const none = await search({ path: ".", pattern: "absent" });
    assert.equal(none.page.state, "complete"); assert.equal(none.page.exhaustive, true); assert.deepEqual(none.page.matches, []);
    writeFileSync(join(project, "many.txt"), "hit\n".repeat(SEARCH_LIMITS.maxRetainedMatches + 10));
    let { page } = await search({ path: ".", pattern: "hit", maxMatches: 500 });
    let total = page.matches.length;
    while (page.cursor) { ({ page } = await search({ path: ".", pattern: "hit", maxMatches: 500, cursor: page.cursor })); total += page.matches.length; }
    assert.equal(page.state, "capped"); assert.equal(page.exhaustive, false); assert.equal(total, SEARCH_LIMITS.maxRetainedMatches);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("glob compiler matches basenames, paths, braces and character classes", () => {
  const match = compileGlobs(["*.md", "src/**/test-?.{ts,js}", "lib/[ab]*.ts"], "include")!;
  assert.ok(match("docs/readme.md")); assert.ok(match("src/test-1.ts")); assert.ok(match("src/a/b/test-x.js"));
  assert.ok(match("lib/alpha.ts")); assert.ok(!match("lib/gamma.ts")); assert.ok(!match("src/test-10.ts"));
  assert.equal(compileGlobs([], "include"), undefined);
  assert.throws(() => compileGlobs(["a{b"], "include"), /Unbalanced/);
});
