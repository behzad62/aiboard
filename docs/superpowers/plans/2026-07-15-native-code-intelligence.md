# Native Code Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Git-aware repository discovery and native TypeScript/JavaScript symbol, reference, definition, and diagnostic tools, including automatic diagnostics after text mutations.

**Architecture:** A repository-intelligence service produces bounded, classified snapshots from shell-free Git commands, with a filesystem fallback for non-Git workspaces. A TypeScript compiler-API service consumes those snapshots, while a native-tool adapter exposes stable schemas and existing filesystem tools reuse the services for listing, search, and post-mutation diagnostics.

**Tech Stack:** Node.js 24.18.0, strict TypeScript 6, Node test runner, Git CLI through `runGit`, TypeScript compiler API.

## Global Constraints

- Preserve existing ToolBroker authorization and workspace-path containment.
- Run Git only through argument arrays and `shell: false`; never route native intelligence through `process.run`.
- Keep all repository, symbol, reference, diagnostic, and preview results deterministically sorted and explicitly bounded.
- Preserve exact, revision-aware, atomic `fs.patch` behavior.
- Do not roll back a successful text mutation when diagnostics fail.
- Treat diagnostics as mechanical evidence, never as a completeness decision.
- Return `unsupported_language` for non-TypeScript/JavaScript code-intelligence queries.
- Existing provider-transport behavior and unrelated `.claude/worktrees/` content are out of scope.

---

## File structure

- Create `runner-v2/src/repository-intelligence.ts`: Git-aware discovery, fallback walking, classification, manifest pagination, and repository-map generation.
- Create `runner-v2/src/typescript-intelligence.ts`: compiler-program loading and symbol/definition/reference/diagnostic queries.
- Create `runner-v2/src/code-intelligence-tools.ts`: native tool definitions, schemas, validation, access assessment, and result/error adaptation.
- Create `runner-v2/test/repository-intelligence.test.ts`: real temporary Git repository coverage.
- Create `runner-v2/test/typescript-intelligence.test.ts`: real multi-file TypeScript project coverage.
- Create `runner-v2/test/code-intelligence-tools.test.ts`: native-tool contract and bounds coverage.
- Modify `runner-v2/src/filesystem-tools.ts`: consume repository snapshots for directory list/search and attach mutation diagnostics.
- Modify `runner-v2/src/worker-runtime.ts`: construct and register shared intelligence services.
- Modify `runner-v2/src/native-architect-runtime.ts`: register read-only intelligence tools.
- Modify `runner-v2/src/subagent-tools.ts`: register intelligence tools for read-only and writing subagents.
- Modify corresponding runtime and filesystem tests to prove integration and authority boundaries.

---

### Task 1: Git-aware repository snapshots and classification

**Files:**
- Create: `runner-v2/src/repository-intelligence.ts`
- Create: `runner-v2/test/repository-intelligence.test.ts`

**Interfaces:**
- Produces: `RepositoryIntelligence.snapshot(root, options, signal): Promise<RepositorySnapshot>`
- Produces: `RepositoryIntelligence.manifest(root, options, signal): Promise<RepositoryManifestPage>`
- Produces: `RepositoryIntelligence.map(root, options, signal): Promise<RepositoryMap>`
- Produces: exported `RepositoryEntry`, `RepositorySnapshot`, `RepositoryManifestOptions`, and `RepositoryMap` types.

- [ ] **Step 1: Write the failing Git-discovery test**

Create a temporary repository containing tracked source, tracked generated code,
ignored output, ignored output negated by a nested rule, non-ignored untracked
source, vendored code, and binary content. Assert this contract:

```ts
const snapshot = await intelligence.snapshot(repo, {});
assert.equal(snapshot.source, "git");
assert.deepEqual(snapshot.entries.map((entry) => entry.path), [
  ".gitignore",
  "dist/tracked.generated.ts",
  "src/app.ts",
  "src/extra.ts",
  "vendor/library.js",
]);
assert.equal(snapshot.entries.find((entry) => entry.path === "dist/tracked.generated.ts")?.kind, "generated");
assert.equal(snapshot.entries.find((entry) => entry.path === "vendor/library.js")?.kind, "vendored");
assert.equal(snapshot.entries.find((entry) => entry.path === "src/extra.ts")?.gitState, "untracked");
assert.equal(snapshot.entries.some((entry) => entry.path === "dist/ignored.js"), false);
```

Also call `snapshot(repo, { includeIgnored: true })` and assert that ignored
files are present with `gitState: "ignored"` and a stable
`classificationReasons` entry.

- [ ] **Step 2: Run the repository test and verify RED**

Run:

```powershell
npx tsx --test runner-v2/test/repository-intelligence.test.ts
```

Expected: FAIL because `repository-intelligence.ts` and its exported service do
not exist.

- [ ] **Step 3: Implement the minimal snapshot and classification service**

Define these public shapes exactly:

```ts
export type RepositoryGitState = "tracked" | "untracked" | "ignored" | "not_applicable";
export type RepositoryEntryKind =
  | "source" | "test" | "configuration" | "documentation" | "asset"
  | "generated" | "vendored" | "binary" | "other";

export interface RepositoryEntry {
  path: string;
  gitState: RepositoryGitState;
  kind: RepositoryEntryKind;
  language?: string;
  byteLength: number;
  classificationReasons: string[];
}

export interface RepositorySnapshot {
  root: string;
  source: "git" | "filesystem";
  entries: RepositoryEntry[];
  truncated: boolean;
}

export interface RepositorySnapshotOptions {
  includeIgnored?: boolean;
  maxEntries?: number;
}

export class RepositoryIntelligence {
  async snapshot(
    root: string,
    options: RepositorySnapshotOptions = {},
    signal?: AbortSignal,
  ): Promise<RepositorySnapshot>;
}
```

Use `runGit({ cwd: root, args: ["ls-files", "-z"] })`, the corresponding
`--others --exclude-standard` command, and the ignored command only when
requested. Split on NUL, normalize separators, deduplicate with tracked state
taking precedence, validate resolved paths remain under `root`, classify with
stable reason strings, `lstat` each entry, and sort by path. Detect a non-Git
workspace only from Git's explicit not-a-repository failure and use a bounded
filesystem walker that excludes `.git` and `node_modules`.

- [ ] **Step 4: Verify snapshot GREEN**

Run the focused test again. Expected: PASS with no warnings.

- [ ] **Step 5: Add failing manifest/map bounds tests**

Assert `manifest` pagination uses an opaque numeric cursor and returns stable
counts, while `map` identifies source/test roots, configuration files, and
language counts with cited source paths:

```ts
assert.equal(page.source, "git");
assert.deepEqual(page.entries, snapshot.entries.slice(1, 3));
assert.equal(page.nextCursor, "3");
assert.equal(page.totals.gitState.tracked, 4);
assert.equal(page.totals.gitState.untracked, 1);
assert.deepEqual(map.sourceRoots, [{ path: "src", sources: ["src/app.ts", "src/extra.ts"] }]);
```

- [ ] **Step 6: Verify manifest/map RED, implement, and verify GREEN**

Add `manifest` and `map` using the snapshot as their only discovery source.
Bound page size to 200, total entries to 20,000, and repository-map source lists
to 50 paths per section. Run the focused test and expect PASS.

- [ ] **Step 7: Commit Task 1**

```powershell
git add runner-v2/src/repository-intelligence.ts runner-v2/test/repository-intelligence.test.ts
git commit -m "feat(runner): add git-aware repository snapshots"
```

### Task 2: Git-aware filesystem listing and search

**Files:**
- Modify: `runner-v2/src/filesystem-tools.ts`
- Modify: `runner-v2/test/filesystem-tools.test.ts`

**Interfaces:**
- Consumes: `RepositoryIntelligence.snapshot` from Task 1.
- Produces: `FilesystemToolsOptions.repository?: RepositoryIntelligence`.
- Produces: new `fs.search` booleans `includeGenerated`, `includeVendored`, `includeIgnored`, and `includeBinary`.

- [ ] **Step 1: Write failing integration tests**

Initialize the existing filesystem fixture as a Git repository. Add ignored,
generated, and vendored files containing the same search term. Inject a real
`RepositoryIntelligence`, then assert directory `fs.list` follows the snapshot
and directory `fs.search` excludes classified files by default but includes
them with explicit flags. Retain the existing direct-file search assertion.

```ts
const result = await invoke(broker, "search", "fs.search", {
  path: ".",
  pattern: "needle",
  includeGenerated: true,
});
assert.deepEqual(
  ((result.content.find((block) => block.type === "json")?.value as {
    matches: Array<{ path: string }>;
  }).matches.map((match) => match.path)),
  ["dist/generated.ts", "src/app.ts"],
);
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx tsx --test runner-v2/test/filesystem-tools.test.ts
```

Expected: FAIL because directory tools still use the manual walker and schemas
reject inclusion flags.

- [ ] **Step 3: Implement minimal filesystem integration**

Extend `FilesystemToolsOptions` with the repository service. For directory
paths, obtain a snapshot rooted at `context.workspacePath`, filter entries to
the requested relative subtree, and preserve current result shapes. For a file
path, keep current direct behavior. Extend the JSON schema and runtime
validation for the four inclusion booleans. Ignore binary entries unless
`includeBinary` is true, while still skipping bytes that fail UTF-8 decoding.

- [ ] **Step 4: Verify GREEN and compatibility**

Run the focused test. Expected: every pre-existing filesystem test and new
Git-aware test passes.

- [ ] **Step 5: Commit Task 2**

```powershell
git add runner-v2/src/filesystem-tools.ts runner-v2/test/filesystem-tools.test.ts
git commit -m "feat(runner): make filesystem search git-aware"
```

### Task 3: TypeScript and JavaScript intelligence service

**Files:**
- Create: `runner-v2/src/typescript-intelligence.ts`
- Create: `runner-v2/test/typescript-intelligence.test.ts`

**Interfaces:**
- Consumes: `RepositorySnapshot` from Task 1.
- Produces: `TypeScriptIntelligence.workspaceSymbols`, `definition`, `references`, and `diagnostics`.
- Produces: `CodeLocation`, `WorkspaceSymbol`, `CodeDiagnostic`, and `CodeIntelligenceResult<T>`.

- [ ] **Step 1: Write failing multi-file project tests**

Create `tsconfig.json`, `src/math.ts`, and `src/app.ts`, including an alias import,
one type error, an exported function, and two references. Assert:

```ts
assert.deepEqual(await service.definition(query), {
  status: "ok",
  projectConfig: "tsconfig.json",
  results: [{ path: "src/math.ts", line: 1, column: 17, preview: "export function add..." }],
  truncated: false,
});
assert.equal((await service.references(query)).results.length, 3);
assert.equal((await service.diagnostics({ root, path: "src/app.ts" })).results[0].code, 2322);
```

Also assert an unsupported `.py` request returns
`{ status: "unsupported_language", results: [], truncated: false }` and a
position without a symbol returns a successful empty result.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx tsx --test runner-v2/test/typescript-intelligence.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement compiler-program loading**

Export these result shapes:

```ts
export interface CodeLocation {
  path: string;
  line: number;
  column: number;
  preview: string;
  symbolKind?: string;
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
```

Locate the nearest `tsconfig.json`/`jsconfig.json`, parse it with TypeScript's
configuration APIs, and create a `LanguageService` over real files. When no
config exists, build an inferred project from manifest TypeScript/JavaScript
entries. Normalize every file name back to a contained repository-relative
path and convert offsets to 1-based positions.

- [ ] **Step 4: Implement the four queries minimally**

Use `getNavigateToItems` for workspace symbols,
`getDefinitionAtPosition`, `findReferences`, and syntactic plus semantic
diagnostics. Flatten messages, bound previews to 240 characters, results to 200,
deduplicate by path/position/kind, and sort by path, line, column, then name or
diagnostic code.

- [ ] **Step 5: Verify GREEN**

Run the focused test. Expected: PASS with cross-file definitions/references,
path aliases, configured diagnostics, unsupported-language behavior, and empty
symbol behavior covered.

- [ ] **Step 6: Commit Task 3**

```powershell
git add runner-v2/src/typescript-intelligence.ts runner-v2/test/typescript-intelligence.test.ts
git commit -m "feat(runner): add typescript code intelligence"
```

### Task 4: Native repository and code-intelligence tools

**Files:**
- Create: `runner-v2/src/code-intelligence-tools.ts`
- Create: `runner-v2/test/code-intelligence-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 3 services.
- Produces: `createCodeIntelligenceTools({ repository, typescript }): NativeTool[]`.
- Produces tools `repo.manifest`, `repo.map`, `code.workspace_symbols`, `code.definition`, `code.references`, and `code.diagnostics`.

- [ ] **Step 1: Write failing schema, access, and result tests**

Register tools with a real ToolBroker and assert names, `readOnly: true`,
`effect: "none"`, bounded schema maxima, workspace-read access, 1-based
position validation, structured unsupported-language results, and stable
`repository_scan_failed`/`code_intelligence_failed` error translation.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx tsx --test runner-v2/test/code-intelligence-tools.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement definitions and adapters**

Implement exact tool schemas with `additionalProperties: false`; require `path`
for positional and file diagnostics; accept optional `query`, `kind`, `cursor`,
and bounded `limit` where appropriate. Assess all calls as
`{ capability: "filesystem.read", paths: [{ path, access: "read" }] }`.
Return one JSON content block for successful queries and stable text plus error
objects for service failures.

- [ ] **Step 4: Verify GREEN**

Run the focused test. Expected: PASS with no arbitrary-process permission
requests.

- [ ] **Step 5: Commit Task 4**

```powershell
git add runner-v2/src/code-intelligence-tools.ts runner-v2/test/code-intelligence-tools.test.ts
git commit -m "feat(runner): expose native code intelligence tools"
```

### Task 5: Runtime registration and authority boundaries

**Files:**
- Modify: `runner-v2/src/worker-runtime.ts`
- Modify: `runner-v2/src/native-architect-runtime.ts`
- Modify: `runner-v2/src/subagent-tools.ts`
- Modify: `runner-v2/test/worker-runtime.test.ts`
- Modify: `runner-v2/test/native-architect-runtime.test.ts`
- Modify: `runner-v2/test/subagent-tools.test.ts`

**Interfaces:**
- Consumes: `RepositoryIntelligence`, `TypeScriptIntelligence`, and `createCodeIntelligenceTools`.
- Produces: identical read-only intelligence availability for Architect, worker, read-only subagent, and writing subagent.

- [ ] **Step 1: Write failing registration tests**

Assert each eligible runtime exposes all six new tools. Assert Plan-only
Architect inspection retains them, read-only subagents do not gain `fs.patch`
or process tools, and no role gains a new lifecycle tool.

- [ ] **Step 2: Run focused runtime tests and verify RED**

```powershell
npx tsx --test runner-v2/test/worker-runtime.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/subagent-tools.test.ts
```

Expected: FAIL because the new tools are absent.

- [ ] **Step 3: Register one service pair per runtime broker**

At each broker construction, create a repository service and TypeScript service,
pass the repository service into `createFilesystemTools`, and register all tools
from `createCodeIntelligenceTools`. Architect registration remains read-only;
both subagent modes register the tools because every definition is read-only.

- [ ] **Step 4: Verify GREEN**

Run the focused runtime tests. Expected: PASS with unchanged authority checks.

- [ ] **Step 5: Commit Task 5**

```powershell
git add runner-v2/src/worker-runtime.ts runner-v2/src/native-architect-runtime.ts runner-v2/src/subagent-tools.ts runner-v2/test/worker-runtime.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/subagent-tools.test.ts
git commit -m "feat(runner): register code intelligence tools"
```

### Task 6: Automatic changed-file diagnostics

**Files:**
- Modify: `runner-v2/src/filesystem-tools.ts`
- Modify: `runner-v2/test/filesystem-tools.test.ts`

**Interfaces:**
- Consumes: `TypeScriptIntelligence.diagnostics`.
- Produces: `FilesystemToolsOptions.diagnostics?: Pick<TypeScriptIntelligence, "diagnostics">`.
- Produces: mutation metadata fields `diagnostics`, `diagnosticsSkipped`, or `diagnosticsUnavailable`.

- [ ] **Step 1: Write failing mutation-diagnostic tests**

Inject a real diagnostic service, patch valid TypeScript into a type error, and
assert existing revision metadata plus a code 2322 diagnostic. Write a text file
and assert `diagnosticsSkipped: "unsupported_language"`. Inject a service that
throws and assert the file was still written and
`diagnosticsUnavailable: "code_intelligence_failed"` is returned.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npx tsx --test runner-v2/test/filesystem-tools.test.ts
```

Expected: FAIL because mutation results contain revision metadata only.

- [ ] **Step 3: Implement post-write analysis**

Make `successRevision` asynchronous and accept the optional diagnostics
service. Build revision metadata first, then request diagnostics only for the
changed repository-relative path. Merge one of the three specified diagnostic
outcomes into the JSON block. Catch analysis failures without changing
`isError: false` and without touching the already-written bytes.

- [ ] **Step 4: Verify GREEN and atomicity**

Run filesystem tests. Expected: PASS, including existing revision-conflict,
serialization, CRLF, and atomic multi-edit assertions.

- [ ] **Step 5: Commit Task 6**

```powershell
git add runner-v2/src/filesystem-tools.ts runner-v2/test/filesystem-tools.test.ts
git commit -m "feat(runner): diagnose changed source files"
```

### Task 7: Full verification and review

**Files:**
- Modify only files needed to correct failures attributable to Tasks 1-6.

**Interfaces:**
- Verifies every interface and global constraint above.

- [ ] **Step 1: Run all new focused tests together**

```powershell
npx tsx --test runner-v2/test/repository-intelligence.test.ts runner-v2/test/typescript-intelligence.test.ts runner-v2/test/code-intelligence-tools.test.ts runner-v2/test/filesystem-tools.test.ts runner-v2/test/worker-runtime.test.ts runner-v2/test/native-architect-runtime.test.ts runner-v2/test/subagent-tools.test.ts
```

Expected: PASS, zero failed tests.

- [ ] **Step 2: Run the complete Runner V2 suite**

```powershell
npm run test:runner-v2
```

Expected: PASS, zero failed tests.

- [ ] **Step 3: Run typecheck and lint**

```powershell
npm run typecheck:runner-v2
npm run lint
```

Expected: both commands exit 0.

- [ ] **Step 4: Check for an active development server, then build**

Inspect running Node command lines for `next dev`. If none is active, run:

```powershell
npm run build
```

Expected: exit 0. If a dev server is active, stop here and report that the build
was intentionally not run because repository guidance warns it can corrupt
`.next`; do not stop or restart a user-owned server without authorization.

- [ ] **Step 5: Review the final diff and requirement matrix**

Run `git diff --check`, inspect every changed file, and map each design goal to
its implementation test. Confirm that structural queries, syntax-aware rename,
test discovery, and impacted-test selection remain explicitly deferred rather
than being claimed complete.

- [ ] **Step 6: Commit verification-only corrections if present**

```powershell
git add runner-v2/src runner-v2/test
git commit -m "fix(runner): harden native code intelligence"
```

Skip this commit when verification required no corrections.
