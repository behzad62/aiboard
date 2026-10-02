# T5 independent review — round 4 (narrow)

Reviewer: an independent reviewer, not the cycle-3 worker (MiMo). I have no memory of rounds 1–3 and read them from `T5-review-r3.md` and the evidence.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`, branch `codex/runner-v2-p6-6-t5`, base `57e80f45`, T5 uncommitted.
No source or test file was edited and nothing was committed. This file is the only file written in the repo.
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r4\`
- `rerun-probes-r2.txt`, `rerun-probes-r2b.txt`, `rerun-probes-r3.txt`, `rerun-probes-r3b.txt`: the earlier probe files re-run unchanged.
- `probes-r4.test.mts` and `probes-r4.out.txt`: the new round-4 probes.
- `wt/`: a byte-identical copy of `runner-v2/src` and `runner-v2/test`, used for the prove-red.

## Scope

- Read:
  - `T5-review-r3.md`
  - the brief `t5-repair3.txt`
  - evidence `T5.md` "Repair cycle 3"
  - `affected-tests.ts` in full
  - the cycle-3 diffs of `change-risk.ts`, `mutation-probe.ts` and `test-report-readers.ts`, taken against the round-3 byte copy of cycle 2 (`review-scratch-t5-r3/wt`, whose `affected-tests.ts` sha matches the cycle-2 row `3c585332…`)
  - the worker's new tests at `affected-tests.test.ts:578-820`
- Scope check:
  - Against the cycle-2 table, exactly 8 files changed, and all 8 are in the allowed set: `affected-tests.ts`, `change-risk.ts`, `mutation-probe.ts`, `test-report-readers.ts` and their 4 tests.
  - `change-risk.ts` changes only the `isTestPath` body and adds an import.
  - `mutation-probe.ts` changes 1 line (`:725`).
  - `test-report-readers.ts` adds only the aggregate-only guard (`:356-358`).
  - `git status --short` still shows 18 entries.

## sha256 verification ("Repair cycle 3" table)

`sha256sum -c` against the 18 rows gives 18/18 OK. All 18 rows are 64 hex characters.

## Verification table

| Item | Status | Evidence |
|---|---|---|
| NB5 `.spec` / `_spec.rb` / `test_*.py` / `__tests__` / root `tests/` recognised on LSP and module graph | **Fixed** | r3 X1: module graph now includes `packages/a/src/cart.spec.ts`; LSP includes both specs; X1b no longer steps down |
| NB5 content-defined .NET test project | **Fixed** | R5: a `Shop.Web.Specs` csproj with `Microsoft.NET.Test.Sdk` + Reqnroll is selected on a Core change. The r3 X7 fixture has no test SDK reference, so it is still unselected, which is correct. |
| NB5 content-defined **Java** test project | **Regression, BLOCKING (R4-B4)** | Every Maven module pom with a test-scoped junit dependency, including the root `.`, becomes a "test project" |
| NB5 no false positives | Mostly fixed | `testing-utils.ts`, `contest.ts`, `latest.ts`, `attest.py`, `protest.go`, `Contest.cs` → false. The `*-tests.ts` / `*Test.tsx` stem rule gives false positives (`affected-tests.ts`, `run-tests.ts`, `SpeedTest.tsx`). The rule is pre-existing, but it now matters through R4-B2. |
| NB6 changed tests on every rung | **Fixed as a union, but see R4-B2 / R4-B3** | X2 → `[a.test, b.test]`; X2c → root e2e added; X2d → impact tool plus the changed test |
| NB7 Cargo inline tests | **Fixed** | X3 → `cli/src/main.rs`, `cli/tests/cli.rs`, `core/src/lib.rs`; r2 T7 → `src/lib.rs` rung 3 |
| NB8 Gradle typesafe accessors | **Fixed** | X5b → app + core; R2 kebab `projects.coreData` ↔ `:core-data` → app + core-data. Unmapped accessor → unknown (worker test `:699`). |
| NB8 "unreadable dependency syntax → unknown" | **Not met, BLOCKING (R4-B5)** | `project(path: ':core')` is silently absent |
| NB9 modern Cargo workspace narrow | **Fixed** | X4 / X4b / X4c → core + cli only, `other` excluded, `edgesUnknown` absent. R4: `[target.'cfg(unix)'.dependencies]` and dotted `shop-core.path` dev-dep both parse. |
| Docs select nothing and do not widen; unknown types still widen | **Over-correction, BLOCKING (R4-B1)** | Genuine docs pass: Y1b / Y1c / Y1e / Y1f / Y1g stay narrow, D5 → `no_tests_required`, D6 `.graphql` still widens. The docs classifier, however, swallows source, build and dependency files. |
| mutmut fatal bit | **Fixed** | X12: exit 3 → `builtin_mutator` with the note "project tool mutmut failed (tool exit 3…)". `:725` keeps exit 2 as survivors. |
| `.csproj` not a test | **Fixed** | r3 X7: the `.csproj` is gone from the selection; `isTestFile("Shop.Tests/Shop.Tests.csproj")` → false |
| Aggregate-only JUnit → unknown | **Fixed** | X11 / X11b / RN self-closing → `unknown`. Genuine reports are unchanged: RN 10 MB junit passed 164254 in 134 ms, r2 R1–R10 identical. r2 R7 (aggregate-only with a failure) moved from `failed` to `unknown` and r2 R8a (BOM, aggregate-only) from `ok` to `unknown`. Both are aggregate-only, so this is expected and fails closed. |
| change-risk shares the recognizer | **Fixed**, see N2 | `isTestPath` = `isTestFile`; `.spec` now a test |
| No regression on NB1–NB4 and B7/B8 layouts | **Holds, except the CMake widening regression in R4-B1** | r2 probe files 15/15 and 3/3. Every PROBE diff against the r3 re-run is one of: a cycle-3 intended change (Cargo inline targets added), aggregate-only JUnit → unknown, or timing noise. |
| LSP transitive closure on this repo, cap | **Holds** | X10: 0 of 124 / 216 transitive test importers missed. Closure max is 542, under the 1000 cap. The counts rose 140→142 and 216→218 because non-test source files are now listed (R4-B2, N1). |
| Tests can fail and are not seeded around the code | **Holds for NB5–NB9** | Prove-red reproduced below. The docs test (`:781`) fixes only genuine doc names, so it cannot catch R4-B1. |

## Findings

### BLOCKING

**R4-B1 — The documentation classifier treats source, build and dependency files as docs, so a single-file change to them returns `no_tests_required` with 0 tests. `CMakeLists.txt` no longer widens.**
- Location: `affected-tests.ts:108-113` (`.txt` and `.svg` in `DOCUMENTATION_EXTENSIONS`; `DOCUMENTATION_BASENAME` is a *prefix* regex `^(license|…|security|…)([._-]|$)`), `:138-142`, the early return `:939-952`, and the skip `:153` in `detectWideningTriggers`.
- Which paths `isDocumentationPath` marks as docs:
  - Source files whose basename starts with a listed prefix: `src/security.ts`, `src/auth/Security.java`, `lib/notice.js`, `src/changes.ts`, `app/authors.py`, `src/license-check.ts`, `src/readme-parser.ts`, and even `src/security_test.go`.
  - Build and dependency files: `CMakeLists.txt`, `core/CMakeLists.txt`, `requirements.txt`, `requirements-dev.txt`.
  - Runtime and fixture data: `tests/fixtures/expected_output.txt` (golden file), `src/templates/welcome.txt`, `src/icons/logo.svg`.
- D1: `src/security.ts` alone, although it is imported by 2 tests and the LSP is configured → `no_tests_required`, `[]`.
- D1c: `src/main/java/com/x/Notice.java` alone → `no_tests_required`.
- D2 / D2b: `CMakeLists.txt` alone (root, or a module's) → `no_tests_required`.
- D3: `requirements.txt` alone (a dependency bump) → `no_tests_required`.
- D4: the golden fixture alone → `no_tests_required`.
- D2c (regression of earlier-verified config widening): `detectWideningTriggers(["CMakeLists.txt"])` now returns `[]`. `CMakeLists.txt` + `core/cart.cpp` → narrow `module_graph` `[core/tests/cart_test.cpp]`; it used to widen as a build configuration.
- This is a false pass: "no tests required" for a changed security module or a changed build or dependency file.
- Minimal fix:
  - Match `DOCUMENTATION_BASENAME` only against extension-less or doc-extension basenames: `LICENSE`, `LICENSE.md`, `LICENSE-MIT`, `CHANGELOG.md`, `README.rst` and so on — never `*.ts|.java|.py|.go|…`.
  - Drop `.txt` from the doc extensions; `.txt` must at least not override build-config, lockfile or dependency-manifest names.
  - Do not treat files under test or fixture dirs as docs.
  - Consider `.svg` as unknown.
  - Run `isBuildConfigBasename` and the lockfile checks before the docs skip.
  - Tests: D1, D2, D2c and D3 must not return `no_tests_required`, and D2c must widen.

**R4-B2 — Unioning changed tests into a rung's result defeats the rung's emptiness guards. A rung that found nothing reports `ok` with only the changed test.**
- Location: `affected-tests.ts:966-967` (impact tool: union, then `tests.length > 0`), `:885` + `:911` (LSP: `tests` is seeded with `changedTestFiles`, so the "zero test references" guard never fires), `:1033`.
- G1 vs G1b: when the LSP returns `[]` for `src/money.ts`, that file alone → `full_suite`. Add the ordinary co-changed `src/money.test.ts` → `lsp_references` ok `[src/money.test.ts]`. The other importers of `money.ts` never run.
- G2 vs G2b: the same with an impact tool that returns `[]`, for example a jest `--findRelatedTests` miss → `impact_tool` ok `[src/money.test.ts]`.
- G3b: a source module that the pre-existing stem rule misreads as a test (`src/select-tests.ts`; this repo's own `runner-v2/src/affected-tests.ts`), with the LSP returning `[]` → `lsp_references` ok `[src/select-tests.ts]`. The only "test" selected is a source file.
- "Fix code + update its test" is the most common commit shape. The empty-result guards exist exactly for the index-miss and empty-answer failure modes, and cycle 3 disables them for that shape. Cycle 2 stepped down here.
- Minimal fix: evaluate each rung's own non-emptiness guard on the rung's result without the changed tests, then union `changedTests` into a successful result only. Tests: G1b and G2b must step down.

**R4-B3 — Test-tree helpers, setup files and fixtures outside every module are exempt from the NB1 unmapped guard and are then "selected" as the whole narrow result.**
- Location: `affected-tests.ts:214-216` (any path segment `test` / `tests` / `__tests__` → test file, including helpers and fixtures), used by `unmappedNonTestFiles` `:855-856` and the NB6 union `:837-839`.
- H1 (npm workspaces): root `test/helpers/db.ts`, imported by the tests of both packages, changed alone → `module_graph` ok `[test/helpers/db.ts]`.
- H2: `test/setup.ts` (jest `setupFiles`) → `module_graph` ok `[test/setup.ts]`.
- H3: `tests/fixtures/users.json` → `module_graph` ok `[tests/fixtures/users.json]`.
- H4 (LSP; the setup file has no importers because config loads it) → `lsp_references` ok `[test/setup.ts]`.
- In every case no real test runs. In cycle 2 these root paths were not test files (the `/test/` check needed a leading slash), so they were unmapped and the result was `full_suite`. This is a cycle-3 regression.
- Minimal fix: only a runnable test counts as a "changed test" or is exempt from the unmapped guard. A runnable test is a member of `fullSuiteTests` or matches a test basename (`.test.` / `.spec.` / `_test.` / `test_*.py` / `*_spec.rb` / CamelCase `*Test(s)`). A non-runnable file under a test dir that is outside every module must stay unmapped, which gives `full_suite`. With an LSP, its referencers are followed, and an empty result fails the rung (R4-B2). Tests: H1–H4 → `full_suite` (or the referencers on the LSP rung).

**R4-B4 — Java "test project by content" marks every Maven module, and the root, as a test project, so every file in the repo is a "test".**
- Location: `affected-tests.ts:746-748` with `isTestProjectContent` `:248-250` (`\bjunit\b`) and `isTestFile` `:218-220`.
- Why it fires: in Maven, tests live inside each module (`src/test/java`), and nearly every module pom declares junit with `<scope>test</scope>`. A parent pom's `<dependencyManagement>` usually lists junit too.
- M: `testProjectDirs` = `[".", "core", "api", "other"]`. Because `underDir(f, ".")` is always true, every file in the repo, `tools/gen.py` included, is a test.
- M1: a change to `core/src/main/java/Cart.java` selects `api/src/main/java/Api.java`, `core/src/main/java/Cart.java` and `core/src/main/java/Tax.java` as "tests". Main sources are listed as test targets, which is a needlessly wide and wrong selection on every ordinary Maven change.
- M2: every changed file is a "changed test", so R4-B2 applies to every Maven change. With the LSP returning `[]` → `lsp_references` ok `[core/src/main/java/Cart.java]`, and no test runs.
- M3: a main-source referencer (`Tax.java`) is counted as a test.
- Also: nothing in a Maven repo can ever be "unmapped" (NB1), because every file is a test.
- The brief asked for Java test projects by content. That concept fits .NET (a separate test project) but not Maven or Gradle modules.
- Minimal fix: drop pom.xml from `testProjectDirs`, or apply it only to a module whose pom has packaging or content that makes it a dedicated test module and never to `.`. For Maven and Gradle rely on `src/test/**` (already a `test` segment). Tests: M1 selects only `src/test/**` files of core + api; M2 steps down.

**R4-B5 — Gradle `project(path: ':core')` / `project(path = ":core")` edges are silently absent and do not set `edgesUnknown` (NB8 contract not met).**
- Location: `affected-tests.ts:718-719`. It matches only `project\s*\(\s*['"]:…['"]\s*\)`.
- R1: `implementation project(path: ':core')` (Groovy named-argument form; Android Studio's "Add module dependency" generates it), `implementation(project(path = ":core"))` (Kotlin), and `project(path: ':core', configuration: 'default')`. For each, a core change → `module_graph` ok `[core/.../CartTest.kt]`, and `app`'s tests are missed.
- The cycle-3 brief (NB8) requires: "unreadable dependency syntax marks the module's edges unknown (fail closed), never silently absent". A `project(` call the parser does not read is exactly that.
- Minimal fix: accept `project\s*\(\s*(?:path\s*[:=]\s*)?['"]:?([^'"]+)['"]` (with any trailing named args). Set `edgesUnknown` for any remaining `project(` occurrence in a `dependencies` block that did not yield an edge. Tests: the three R1 forms select app + core.

### NON-BLOCKING

- **N1 — Over-listing of non-test files as "tests".** The Cargo inline targets (`src/lib.rs`, `src/main.rs`) are intended crate markers, but the `*-tests` / `*Test` stem rule now also lists sources: this repo's `runner-v2/src/affected-tests.ts` appears in its own selection (Y1, X10 +2). Harmless on its own (it is a superset), but T6 must map these entries to runnable targets. Tighten the stem rule to test-ish extensions and dirs, or document it.
- **N2 — change-risk `isTestPath` can now under-read risk.** The cycle-2 CamelCase rule was limited to `.cs` / `.java`. The shared recognizer applies `-tests` / `-test` / `*Test` stems to every extension. A change to only `src/select-tests.ts`, `src/SpeedTest.tsx` or `src/ab-test.ts` counts as "test changed", which suppresses the `sourceWithoutTest` signal (`change-risk.ts:278-280`). Low magnitude (one signal, uncommon names). It becomes fully safe once the stem rule is tightened (N1).
- **N3 — Cargo workspace-level renamed dependency.** In the `[workspace.dependencies]` entry `core-alias = { path = "crates/core", package = "shop-core" }`, the member line `core-alias.workspace = true` resolves to no module. The edge is silently dropped (R3: core change → `[core/src/lib.rs]` only; `cli` is missed). Uncommon for internal crates. Fix: resolve member keys through the root's `[workspace.dependencies]` `package =` renames, or set unknown when a member dep matches a workspace entry with `path =` but no module.
- **N4 — Cypress `.cy.ts` and `*.e2e.ts` are not recognised by basename.** They are recognised through `fullSuiteTests` when the caller passes paths, so this matters only when the full suite is a command string.

### NOTES

- r2 R7 (aggregate-only JUnit with `failures="1"`) now reads `unknown` instead of `failed`. Both outcomes fail closed.
- The worker's evidence is accurate for what it claims, and all 5 NB prove-reds are recorded with changed hashes. The regressions above are outside what those tests exercise. The docs test only uses canonical doc names, and the NB6 test does not combine a changed test with an empty rung result or a non-runnable test-dir file.

## Commands and counts

All ran from the worktree root with `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`.
- sha256: `sha256sum -c` of the 18 "Repair cycle 3" rows → 18/18 OK. Against the "Repair cycle 2" rows, exactly 8 differ, all in the allowed set.
- The worker's suites were **not** re-run, per the owner rule (the evidence records 114/114 across 7 files).
- Earlier probes were re-run unchanged:
  - `review-scratch-t5-r3\probes-r3.test.mts`: 12/12, 47 PROBE lines.
  - `probes-r3b.test.mts`: 1/1, 7 PROBE lines.
  - `review-scratch-t5-r2\probes-r2.test.mts`: 15/15, 100 PROBE lines.
  - `probes-r2b.test.mts`: 3/3, 12 PROBE lines.
  - Every PROBE diff is explained in the verification table.
- New probes: `review-scratch-t5-r4\probes-r4.test.mts`, 6/6 pass (they log and do not assert), 75 PROBE lines.
- **Prove-red reproduced: NB6 module-graph changed-test union.** It ran in the byte-identical scratch copy `wt\runner-v2`, and the worktree file was never modified.
  - BEFORE: `fe6b0b364ce4a4f0962b749f9836959d182829e2652ecef5f7c4d17f0e8aa2ad`, 44949 bytes, identical to the worktree.
  - Baseline: `--test-name-pattern="repair NB6"` → 1/1 pass.
  - Injection (Node latin1 byte-exact replace, 1 match, `:838`): `if (isTestFile(file, identity)) selected.add(file);` becomes `if (false && isTestFile(file, identity)) …`.
  - INJECTED: `a5fce64196d55b3776f7f183ee4faaaa8c432bded35ac41c61a4c692f24fb9cc`, 44958 bytes. This matches the worker's recorded INJECTED hash exactly, and `diff` shows 1 line.
  - RED: 0/1. `affected-tests.test.ts:670` fails with actual `['packages/a/test/affected.test.ts']` and expected `['packages/a/test/affected.test.ts', 'tests/e2e/checkout.spec.ts']`.
  - Restored from the byte copy. AFTER: `fe6b0b364ce4a4f0962b749f9836959d182829e2652ecef5f7c4d17f0e8aa2ad`. `cmp` against the worktree is identical, and the re-run is 1/1.
  - Worktree hash unchanged throughout: `fe6b0b36…e8aa2ad`. `git status --short` still shows 18 entries.

## Verdict

- **Fixed and verified:**
  - All five round-3 blocking items: NB5, NB6, NB7, NB8 (typesafe accessors) and NB9.
  - The non-blocking mutmut, `.csproj` and aggregate-only JUnit items.
- **No regression:** NB1–NB4, readers, LSP closure and cap, Go, npm and .NET layouts.
- **Five new blocking issues, four of them introduced by cycle 3:**
  - R4-B1: the docs classifier returns `no_tests_required` for source, build and dependency files, and loses the CMake widening.
  - R4-B2: the changed-test union defeats the empty-rung guards.
  - R4-B3: test-dir helpers and fixtures outside modules become the whole selection.
  - R4-B4: junit-by-content makes every Maven file a test.
  - R4-B5: the pre-existing Gradle `project(path:)` gap, which violates the NB8 fail-closed contract.

T5 REVIEW r4 — REPAIR REQUIRED — 5 blocking
