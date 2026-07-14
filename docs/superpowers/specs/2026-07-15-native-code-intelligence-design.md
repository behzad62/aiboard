# Native Code Intelligence Design

## Purpose

Runner V2 currently gives agents bounded, revision-aware filesystem reads and
writes, but directory search and listing use a textual recursive walker that
only excludes `.git` and `node_modules`. This project adds repository-aware
discovery and native TypeScript/JavaScript code intelligence without weakening
the existing permission, path-containment, result-bounding, or mutation-safety
contracts.

This is the first independently deliverable project from the broader Runner V2
review. Later projects will cover semantic context retrieval, isolated writing
subagents, provider capability extensions, adaptive scheduling, and expanded
MCP/browser/research surfaces. Those projects do not block this one.

## Goals

- Make repository-wide listing and search follow Git's tracked and ignore
  semantics.
- Expose a bounded repository manifest and compact repository map.
- Classify source, generated, vendored, binary, tracked, untracked, and ignored
  paths with auditable reasons.
- Provide native workspace-symbol, definition, reference, and diagnostic
  queries for TypeScript and JavaScript repositories.
- Attach changed-file diagnostics to successful text mutations.
- Keep exact, revision-aware `fs.patch` behavior unchanged.
- Return explicit capability limitations for unsupported languages instead of
  silently falling back to unreliable textual guesses.

## Non-goals

- A generic LSP process manager or language-server installer.
- Tree-sitter grammars for every supported programming language.
- Syntax-aware rename or structural editing in this increment.
- Test discovery and impacted-test selection in this increment.
- Persisting a long-lived cross-run index. The initial implementation builds a
  bounded snapshot per tool invocation and may add safe in-process caching only
  when invalidation is tied to the Git/worktree state and relevant file
  revisions.

These remain planned native code-intelligence increments rather than being
represented as completed by this project.

## Architecture

### Module boundaries

`runner-v2/src/repository-intelligence.ts` owns repository discovery,
classification, manifests, and repository-map generation. It uses the existing
shell-free `runGit` helper and filesystem metadata; it does not invoke a shell or
route through `process.run`.

`runner-v2/src/typescript-intelligence.ts` owns TypeScript compiler-program
creation and TypeScript/JavaScript symbol, definition, reference, and diagnostic
queries. It imports the repository manifest interface but does not know about
tool permissions or model-facing schemas.

`runner-v2/src/code-intelligence-tools.ts` adapts both services into audited
native tools. It validates and bounds inputs and translates service failures
into stable tool error codes.

`runner-v2/src/filesystem-tools.ts` continues to own reads and mutations. It
accepts an optional repository-intelligence service so directory `fs.list` and
`fs.search` can consume repository manifests. Direct single-file reads and
searches keep their current behavior. Successful `fs.write` and `fs.patch`
calls optionally request diagnostics for the changed file and include the
bounded result beside the existing revision metadata.

The Architect, worker, and both subagent registries receive the same read-only
code-intelligence tools. Existing role and permission restrictions remain in
force; code-intelligence queries require workspace read access and mutation
tools retain their current write access.

### Repository snapshot

For a Git worktree, discovery combines:

1. `git ls-files -z` for tracked files;
2. `git ls-files -z --others --exclude-standard` for non-ignored untracked
   files;
3. `git ls-files -z --others --ignored --exclude-standard` only when the caller
   explicitly requests ignored-path classification.

The commands use argument arrays, bounded output, `shell: false`, and the
current task workspace as `cwd`. Paths are decoded from NUL-delimited output,
normalized to repository-relative forward-slash form, deduplicated, sorted,
and revalidated against workspace containment before filesystem access.

For a non-Git workspace, discovery uses the existing bounded walker with a
documented fallback exclusion set. The response reports `source: "filesystem"`
so the caller can distinguish fallback semantics from Git semantics.

Each manifest entry contains:

- repository-relative `path`;
- `gitState`: `tracked`, `untracked`, `ignored`, or `not_applicable`;
- `kind`: `source`, `test`, `configuration`, `documentation`, `asset`,
  `generated`, `vendored`, `binary`, or `other`;
- `language` when recognized;
- `byteLength`;
- `classificationReasons`, using stable machine-readable reason strings.

Generated and vendored classification is conservative. It uses well-known path
segments and file-name patterns plus explicit generated-file markers in a
bounded prefix. Classification never excludes a tracked file from a manifest;
it annotates it. Directory search excludes ignored, generated, vendored, and
binary entries by default, with explicit boolean options to include each class.

### Repository map

`repo.manifest` returns paginated manifest entries plus counts by state, kind,
and language. Inputs include a relative root, inclusion flags, cursor, and a
bounded page size.

`repo.map` returns a compact, deterministic overview containing top-level
directories, package/configuration files, source roots, test roots, language
counts, and declared symbols up to fixed per-section and total limits. Every
summary item carries source paths so later context retrieval can cite the files
from which the map was derived.

### TypeScript and JavaScript intelligence

The TypeScript service locates the nearest applicable `tsconfig.json` or
`jsconfig.json` for the requested file or workspace. It uses the TypeScript
compiler API and respects project references and configured module resolution.
If no configuration exists, it creates an inferred project from manifest files
with `allowJs` and `checkJs` appropriate to the queried file set.

Native tools are:

- `code.workspace_symbols`: search declared symbols by name and optional kind;
- `code.definition`: resolve the symbol at a 1-based line and column;
- `code.references`: return bounded reference locations for that symbol;
- `code.diagnostics`: return syntactic and semantic diagnostics for one file or
  the bounded workspace.

Locations contain repository-relative path, 1-based line and column, symbol
kind where available, and a bounded source preview. Results are sorted
deterministically. Responses report truncation and the project configuration
used. A request outside TypeScript/JavaScript returns
`unsupported_language`; a missing symbol returns a successful empty result,
not a tool failure.

### Mutation diagnostics

After an atomic `fs.write` or `fs.patch` succeeds, the filesystem tool requests
syntactic and semantic diagnostics for the changed TypeScript/JavaScript file.
The write is never rolled back because of a diagnostic or analysis failure.
The mutation response keeps its existing `path`, `sha256`, and `byteLength`
fields and adds one of:

- `diagnostics`: a bounded list and truncation metadata;
- `diagnosticsSkipped`: a stable reason such as `unsupported_language`;
- `diagnosticsUnavailable`: a stable error code when analysis failed.

This makes changed-code checks automatic and auditable while preserving the
semantic distinction that diagnostics are evidence, not a completeness
decision.

## Error handling and bounds

- Git absence remains a Runner startup failure under existing preflight rules.
- A command failure caused by a non-Git workspace triggers the documented
  filesystem fallback; other Git failures return `repository_scan_failed`.
- Manifest command output, entry counts, file prefix reads, symbol counts,
  reference counts, diagnostics, and previews all have explicit hard limits.
- Abort signals are checked between expensive phases and passed into supported
  operations.
- Invalid paths and positions use existing argument/path-containment error
  behavior.
- TypeScript configuration and compiler failures return structured diagnostics
  or stable tool errors without crashing the Runner process.
- No native read-only intelligence query requires the arbitrary-process
  approval used by `process.run`.

## Data flow

1. A tool call is validated by the existing registry and authorized by the
   existing broker.
2. The repository service creates a bounded snapshot using Git-aware discovery.
3. Manifest/map tools classify and summarize that snapshot directly.
4. Code tools pass the snapshot and query to the TypeScript service.
5. The adapter bounds and serializes deterministic results for the model.
6. For mutations, the atomic write completes first, then the same TypeScript
   service analyzes the resulting file and augments the revision response.

## Testing strategy

All behavior is implemented test-first.

Repository tests use temporary Git repositories and prove that:

- tracked files remain visible even when generated or vendored;
- `.gitignore`, nested ignore files, negation, and non-ignored untracked files
  match Git's own results;
- ignored files appear only when explicitly requested;
- classification reasons are stable;
- manifests and maps are deterministic, paginated, bounded, and path-safe;
- non-Git workspaces report filesystem fallback semantics.

TypeScript intelligence tests use small real multi-file projects and prove:

- workspace symbols include exported and local declarations as specified;
- definitions and references cross files and honor path aliases;
- 1-based positions and deterministic ordering are correct;
- diagnostics include syntax and type errors and respect project configuration;
- unsupported languages and missing symbols have the specified outcomes.

Filesystem integration tests prove that:

- directory listing and search consume Git-aware manifests;
- direct file search remains compatible;
- default and opt-in generated/vendor/ignored search behavior is correct;
- successful writes retain revision metadata and attach changed-file
  diagnostics;
- diagnostic-service failure does not undo a successful atomic mutation.

Runtime registration tests prove that Architect, worker, and eligible subagent
roles receive the intended read-only tools without gaining mutation authority.
The focused Runner V2 suite, typecheck, lint, and build are run after the new
tests pass. Because the repository warns that a build can disrupt an active
development server's `.next` directory, verification records whether a dev
server is active before running the build.

## Delivery sequence

1. Repository snapshot, manifest, and classification.
2. Git-aware `fs.list` and `fs.search` integration.
3. TypeScript/JavaScript symbol and diagnostic service.
4. Native code-intelligence tool registration.
5. Changed-file diagnostics on text mutations.
6. Focused and full regression verification.

Each step is independently testable and preserves existing filesystem-tool
contracts. Subsequent native-intelligence projects can add structural queries,
syntax-aware rename/editing, test discovery, and impacted-test selection on the
same repository snapshot and language-service boundaries.
