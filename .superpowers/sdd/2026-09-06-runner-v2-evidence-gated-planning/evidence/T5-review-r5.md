# T5 independent review — round 5 (narrow)

Reviewer: an independent fresh-context reviewer. I have no memory of the controller session that made the repair, and I read round 4 and the evidence from disk.
Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`, branch `codex/runner-v2-p6-6-t5`, base `57e80f45`, T5 uncommitted.
No source or test file was edited and nothing was committed. This file is the only file written in the repo.
Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r5\`
- `rerun-probes-r2.txt`, `rerun-probes-r2b.txt`, `rerun-probes-r3.txt`, `rerun-probes-r3b.txt`, `rerun-probes-r4.txt`: the earlier probe files, re-run unchanged.
- `probes-r5.test.mts` and `probes-r5.out.txt`: the new round-5 probes.
- `wt/`: a byte-identical copy of `runner-v2/src` and `runner-v2/test`, used for the prove-red.
- `pr-baseline.txt`, `pr-red.txt`, `pr-green.txt`: the prove-red runs.

## Scope

I read:
- `T5-review-r4.md`
- `T5.md` "Controller repair (after review r4)"
- `affected-tests.ts` in full, with focus on:
  - `isDocumentationPath`
  - `isTestBasename`, `isRunnableTestFile` and `isTestFile`
  - `parseMavenGradleGraph`
  - `moduleGraphTests` and `unmappedNonTestFiles`
  - `followLspReferences` and `computeAffectedTests`
- The new tests R4-B1..B5 at `affected-tests.test.ts:827-995`

Scope check:
- The only changes since "Repair cycle 3" are to `affected-tests.ts` and its test.
- The other 16 T5 files match their cycle-3 sha256 rows (16/16 OK).
- `git status --short` shows 18 entries.

## sha256 verification

| File | Evidence value | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `82c8f6cd7e2a799f37f9e36f03addb0ab23fb3ffc1042d43b5a68d8b55b8cd40` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `fbc8209d0102d5a2b3784fd435f8316848c8bbb46435eea7e3b1bf9f86f536c3` | same | OK |

Per the owner rule, I did not re-run the controller's suites.

## Verification table

| Item | Status | Evidence (probe) |
|---|---|---|
| R4-B1: docs classifier | **Fixed** | See below |
| R4-B2: co-changed test masks an empty rung | **Fixed** | See below |
| R4-B3: helpers, setup files and fixtures outside modules | **Fixed** | See below |
| R4-B4: junit-by-content in Maven | **Fixed** | See below |
| R4-B5: Gradle `project(path:)` | **Fixed for the named forms. The variable/interpolation variant is still silently dropped: R5-B1.** | See below |
| Narrowed recognizer (`isRunnableTestFile`) | **No false narrow when `fullSuiteTests` lists test paths**. Several ecosystems now depend on that list: N1. | See below |
| `isRunnableTestFile` vs `isTestFile` consistency | Consistent for the ladder's guards. The module-graph selection still uses `isTestFile`: N2. | See below |
| No regression on NB1–NB9 or earlier layouts | **Holds** | See below |

**R4-B1: docs classifier.**
- These are no longer docs: `src/security.ts`, `Security.java`, `notice.js`, `changes.ts`, `authors.py`, `security_test.go`, `CMakeLists.txt` (root and module), `requirements*.txt`, the golden `.txt`, the template `.txt` and `logo.svg`.
- Other-language variants are also not docs: `Readme.kt`, `license.go`, `Security.swift`, `changelog.rs`, `authors.rb`, `contributing.php`.
- `.txt` build inputs are not docs and widen: `constraints.txt`, `requirements/base.txt`, `conanfile.txt`.
- Test-data dirs are not docs: `tests/fixtures/*.txt`, `testdata/golden.md`, `spec/fixtures/input.md`.
- D1: `src/security.ts` → `lsp_references` with its 2 importers.
- D2/D2b/D2c: CMake widens again (`build configuration CMakeLists.txt`) and selects app + core.
- D3/D4 → `full_suite`.
- Genuine docs still select nothing: `README.md` + `LICENSE` → `no_tests_required`.
- Mixed `README.md` + code stays narrow (D6).

**R4-B2: co-changed test masks an empty rung.**
- G1b and L4 (LSP `[]` plus a co-changed test) → `full_suite`.
- G2b and L5 (impact tool `[]` plus a co-changed test) → `full_suite`.
- L4c (the LSP finds only non-test referencers, plus a co-changed test) → `full_suite`.
- L4b (a mocha `test/money.js` that is a `fullSuiteTests` member) → `full_suite`.
- Test-only changes still stay narrow: L4d, L4e (with a README) and L5b.
- G3b (`select-tests.ts`) → `full_suite`.

**R4-B3: helpers, setup files and fixtures outside modules.**
- H1–H4 → `full_suite`.
- L7: a helper's LSP referencers are followed transitively and give `[a.test, b.test]`.
- A helper inside a module still selects that module's tests and its dependents' tests. H1 and H1b give a + b tests; H1c (LSP) gives `a.test`.
- A test helper inside a Maven module (M2) selects `api` + `it` tests.

**R4-B4: junit-by-content in Maven.**
- `testProjectDirs` is `undefined`.
- M1: a core main change selects no `src/main` files. The r5 multi-module fixture (core ← api ← it) → CartTest, ApiTest and CheckoutIT (by segment, even when `fullSuiteTests` is `[]`).
- M2 and M5 (LSP `[]`) → `module_graph`, not a main-source "test".
- `tools/gen.py` under the root pom → `full_suite`.

**R4-B5: Gradle `project(path:)`.**
- The R1 Groovy and Kotlin `path:` / `path =` forms now select app + core.
- G5/G6 (`project(varName)` and `project(path = varName)`) set `edgesUnknown` and select every module.
- G8 `testFixtures(project(":core"))` and G9 with `configuration:` both work.

**Narrowed recognizer (`isRunnableTestFile`).**
- Recognized by basename: Go `_test.go`; Python `test_*.py`, `*_test.py` and `tests.py`; Kotlin `*Test.kt`; Swift `*Tests.swift`; gtest `*_test.cc`; Ruby `*_spec.rb`, `test_*.rb` and `*_test.rb`; Dart; Elixir; C# `*Tests.cs`; `.cy.ts`.
- Not recognized by basename:
  - Rust `tests/*.rs`
  - PHP `*Test.php`
  - JS `__tests__/x.js` and mocha `test/x.js`
  - Scala and Groovy `*Spec`
  - Java `*IT.java`
  - gtest `*_unittest.cc`
- For all of these, `isTestFile` is still true, by the test-dir segment.
- They count as runnable only through `fullSuiteTests` membership (L1 and L3 pass with paths).

**`isRunnableTestFile` vs `isTestFile` consistency.**
- Runnable-only: the changed-test union, the unmapped guard and the LSP `found` set.
- `isTestFile`: the module-graph selection and the `affectsEveryModule` selection.
- No path lets a non-runnable file be the whole selection on the LSP or impact rungs. The module graph can still select helpers only when a module has no runnable tests (N2).

**No regression on NB1–NB9 or earlier layouts.**
- All five earlier probe files pass.
- Every PROBE diff against the r4 run is one of:
  - an intended R4-B1..B5 change, listed above
  - fewer over-listed non-test sources: X10/TN8 `selected` fell 142→126 and 140→124, with `missed` still 0; Y1 no longer lists `affected-tests.ts`
  - `.cy.ts` / `.e2e.ts` now recognized
  - timing noise (r2 R9/RN ms lines)
- Cargo, Go, npm, .NET and CMake narrowness is unchanged, and the LSP closure and cap are unchanged.

## Findings

### BLOCKING

**R5-B1: Gradle `project()` paths built with interpolation or concatenation are silently dropped as edges. `edgesUnknown` is not set, so a core change misses the dependent module's tests with an `ok` `module_graph` rung. This is the NB8 fail-closed contract that R4-B5 was meant to close.**
- Location: `affected-tests.ts:766-769`.
- The regex `\bproject\s*\(\s*(?:path\s*[:=]\s*)?['"]:?([^'"]+)['"]` captures:
  - the literal `$it` from `project(":$it")`, and `${name}` from `project(":${name}")`
  - `":"` from `project(":" + name)`, which normalizes to `""`
- Each capture counts as a readable edge, so `projectDeps.length === projectCalls` and `edgesUnknown` stays false.
- The captured name resolves to no module, so `moduleGraphTests:845` (`if (!byName.has(dep)) continue;`) drops it without any signal.
- Probes (app depends on core, settings `include(":app", ":core", ":data")`, change `core/src/main/kotlin/Cart.kt`):

  | Probe | app build file | Result | `edgesUnknown` |
  |---|---|---|---|
  | G1 (control) | `implementation(project(":core"))` | app + core | false |
  | G2 | `listOf("core").forEach { implementation(project(":$it")) }` | `module_graph` ok `[core/.../CartTest.kt]`, **AppTest missed** | false |
  | G3 | `implementation(project(":${name}"))` | same, **AppTest missed** | false |
  | G4 | `implementation(project(":" + name))` | same, **AppTest missed** | false |

- By contrast, the unquoted variable forms G5 and G6 correctly set `edgesUnknown`, and the typesafe accessor path already sets it for a name not in `includedNames` (`:773-775`). The quoted-literal path has no equivalent check.
- Realism: Gradle and Android builds often generate module dependencies in loops or with string templates, for example `project(":feature:$name")` or `project(":$it")`. That makes this a realistic false narrow selection on the most common change shape, a source change in a library module.
- Minimal fix, in `parseMavenGradleGraph`:
  1. Treat a captured path as unreadable, so it does not count toward `projectDeps` and the existing `projectDeps.length < projectCalls` check sets `edgesUnknown`, when:
     - it contains `$`, or
     - it is empty after stripping `:`, or
     - the closing quote is not followed by `\s*[,)]`, which rejects `":" + name`.
  2. Optionally, mirror the typesafe rule: when settings includes were parsed, a literal `project(":x")` whose `x` is not an included name sets `edgesUnknown`.
- Tests: G2, G3 and G4 select app + core (or set `edgesUnknown`), and G1 stays narrow (app + core only, `data` excluded).

### NON-BLOCKING

**N1: The narrowed basename recognizer makes `fullSuiteTests` membership the only way the LSP rung counts several real test conventions.**
- Location: `affected-tests.ts:218-246`, `:956`.
- Conventions affected: Rust `tests/*.rs`, JS `__tests__/*.js`, mocha `test/*.js`, PHP `*Test.php`, Scala and Groovy `*Spec`, `*IT.java`, `*_unittest.cc`.
- L1 (a jest repo mixing `__tests__/money.js` and `cart.test.js`):
  - with `fullSuiteTests` listing both paths, the result is correct;
  - L1b, with the `__tests__` path absent from `fullSuiteTests`, gives `lsp_references` ok `[src/cart.test.js]`, and `__tests__/money.js` is missed.
- In cycle 3, the LSP rung used `isTestFile`, which recognizes test-dir segments, so this is a recall reduction whose safety depends on the caller.
- Callers pass the full-suite list as test paths, and the `full_suite` rung returns that list as the selection, so a complete list is already required for the floor to be correct. The LSP display paths are root-relative with `/` (`lsp-client.ts:1331`, `language-provider-router.ts:604`), which matches.
- On the no-rung and module-graph paths, PHP and Ruby changes widen anyway (`.php` and `.rb` are "unknown file type").
- Recommendation:
  - Document on `AffectedTestsInput.fullSuiteTests` that it must enumerate every runnable test file as a root-relative `/` path, and make T6 enforce it.
  - Optionally, in `followLspReferences`, add `isTestFile && !isRunnableTestFile` hits to the result without counting them toward the emptiness guard. This keeps the R4-B3 protection and restores recall.

**N2: The module-graph selection still uses `isTestFile`, so it lists non-runnable helpers and resources, and it can return an `ok` rung containing only them.**
- Location: `moduleGraphTests:877`, `:1090`.
- M1 lists `api/src/test/java/support/Fixtures.java` and `core/src/test/resources/data.json`. H1 lists `packages/a/test/helpers/db.ts`. This is over-listing and harmless when real tests are also present.
- H2: a module whose `test/` holds only a helper and a fixture, with no dependents, gives `module_graph` ok `[packages/c/test/fixtures/f.json, packages/c/test/helpers/h.ts]`, and no runnable test is selected.
- This behavior predates R4, and the module shape is uncommon.
- Fix: for the emptiness check at `:1092`, require at least one selected entry that is a `fullSuiteTests` member or matches `isRunnableTestFile`. T6 must in any case map entries to runnable targets.

**N3: The per-file LSP index miss is still masked by another changed file's hits.**
- L6: `src/a.ts` + `src/b.ts` are changed, the LSP answers only for `a`, and the result is `lsp_references` ok `[a.test.ts]`.
- The guard is global (`:965`). This is pre-existing and was not raised in r2–r4.
- A per-file guard would widen whenever a changed file has no referencers, such as a new file or an entry point. Record it as a design choice.

**N4: Runtime data under doc extensions reads as documentation, and a single-file change to it gives `no_tests_required`.**
- Examples: `src/main/resources/changes.txt` (a conventional doc basename with `.txt`), `src/assets/logo.png`, `src/__image_snapshots__/a.png`, and `prompts/system.md` (a prompt template loaded at runtime).
- Cheap hardening: exclude `resources`, `assets`, `static`, `public`, `__snapshots__` and `__image_snapshots__` segments in `isDocumentationPath`.
- `findProject(":core")` (G12) is likewise not read. It is rare, and would be fixed together with R5-B1.

### NOTES

- `tests/README.md` is not documentation, so it widens to the full suite. That is the safe direction and was intended by R4-B1.
- The controller's evidence is accurate. All five R4 tests assert the reviewer's scenarios. The R4-B3 and R4-B5 "stays green when one layer is reverted" explanations are consistent with the code: defense in depth.
- `change-risk.isTestPath` now follows the narrowed `isTestFile`. `SpeedTest.tsx` and `affected-tests.ts` no longer suppress `sourceWithoutTest`, so r4 N2 is resolved.

## Commands and counts

All ran from the worktree root with `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`.

- **sha256:** `sha256sum` of the two changed files matches the controller's section, and the 16 other T5 files match their "Repair cycle 3" rows (16/16 OK).
- **Earlier probes, re-run unchanged:**
  - `review-scratch-t5-r4\probes-r4.test.mts`: 6/6, 75 PROBE lines.
  - `review-scratch-t5-r3\probes-r3.test.mts`: 12/12, 47 PROBE lines.
  - `probes-r3b.test.mts`: 1/1, 7 PROBE lines.
  - `review-scratch-t5-r2\probes-r2.test.mts`: 15/15, 100 PROBE lines.
  - `probes-r2b.test.mts`: 3/3, 12 PROBE lines.
  - Every PROBE diff against the r4 outputs is explained in the verification table.
- **New probes:** `review-scratch-t5-r5\probes-r5.test.mts`, 6/6 pass (they log and do not assert), 106 PROBE lines.
- **Prove-red reproduced: the R4-B2 LSP emptiness guard.** It ran in the byte-identical scratch copy `wt\runner-v2`, and the worktree was never modified.
  - BEFORE: `82c8f6cd7e2a799f37f9e36f03addb0ab23fb3ffc1042d43b5a68d8b55b8cd40`, 48777 bytes, identical to the worktree.
  - Baseline: `--test-name-pattern="R4-B2"` → 1 pass / 0 fail.
  - Injection (Node latin1 byte-exact replace, 1 match, `:965`): `if (changedNonTests.length > 0 && found.size === 0) {` becomes `if (false && changedNonTests.length > 0 && found.size === 0) {`.
  - INJECTED: `b294863eb7867b70005d1fb70679e62174342299832d4f1476f7c4c0773924c3`, 48786 bytes. `diff` shows 1 line.
  - RED: 0 pass / 1 fail. `affected-tests.test.ts:873` fails with actual `'lsp_references'` and expected `'full_suite'`.
  - Restored from the backup. AFTER: `82c8f6cd…b8cd40`. `cmp` against the worktree is identical, and the re-run is 1 pass / 0 fail.
  - The worktree hash was `82c8f6cd…b8cd40` before and after. `git status --short` shows 18 entries.

## Verdict

All five R4 blockers are fixed for the forms that round 4 named, with no regression, and a real fault proof. One NB8 fail-closed gap remains in the Gradle literal-`project()` path: interpolated or concatenated paths are silently dropped, giving an `ok` rung that is too narrow.

T5 REVIEW r5 — REPAIR REQUIRED — 1 blocking
