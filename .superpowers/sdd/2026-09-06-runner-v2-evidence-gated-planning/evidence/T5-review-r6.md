# T5 independent review — round 6 (narrow)

Reviewer: an independent reviewer with fresh context. I have no memory of the controller session. I read review round 5 and the controller's evidence from disk.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5`. T5 is uncommitted.

I did not edit any source or test file and did not commit anything. This file is the only file I wrote in the repo.

Scratch directory: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r6\`. It holds:
- `probes-r6.test.mts` and `probes-r6.out.txt`: the new round-6 probes.
- `probes-r6-against-r5.test.mts` and `.out.txt`: the same probes run against the r5-reviewed copy (`review-scratch-t5-r5\wt`, sha `82c8f6cd…`). I used this to tell regressions apart from pre-existing behaviour.
- `rerun-probes-{r5,r4,r3,r3b,r2,r2b}.txt`: the earlier probe files, re-run without changes.
- `wt\`: a byte-identical copy of `runner-v2/{package.json,src,test}`.
- `inject.cjs`, `pr-baseline.txt`, `pr-red-A.txt`, `pr-B.txt`, `pr-C.txt` and `pr-green.txt`: the prove-red runs.

## Scope

I read:
- `T5-review-r5.md`
- `T5.md` "Controller repair 2 (after review r5)"
- `parseGradleIncludes` (`affected-tests.ts:690-710`)
- `parseTypesafeGradleEdges` (`:721-731`)
- `parseMavenGradleGraph` (`:734-812`)
- `moduleGraphTests` (`:833-898`)
- the new test `R5-B1: …` (`affected-tests.test.ts:997-1030`)

Per the owner's rule, I did not re-run the controller's suites.

| File | Evidence sha256 | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `512d3ec46e105956b5b817933877aec743b6652e5e9eea838d994b027eb6b014` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `df1dec8ec6222a1214cc6ee278856431d0f46bd3c5b3957a73a487bcc23c6b3a` | same | OK |

`git status --short` shows 18 entries, the same as r5.

## Verification

### R5-B1 is fixed

- G2, G3 and G4 are inverted. From the r5 probe file, re-run: `edgesUnknown=true`, and a core change selects app, core and data. In r5 it selected only core.
- G1, the literal control, stays narrow: app and core are selected and data is excluded.

Other dynamic forms. Each app build file below was probed with `include(":app", ":core", ":data")` and a change to `core/.../Cart.kt`:

| Probe | Form | r6 result | r5 tree |
|---|---|---|---|
| DYN1 | `project(path = ":$x")` | edgesUnknown, all modules | app missed |
| DYN2 | `project(":a:$b")` | edgesUnknown, all modules | edgesUnknown (membership) |
| DYN3 | `project(':co' + suffix)` | edgesUnknown, all modules | app missed (edge `co`) |
| DYN4 | `project(""":core""")` | edgesUnknown, all modules | same |
| DYN6 | `project(":core").also { … }` | app + core, precise | same |
| DYN7 | `rootProject.project(":core")` | app + core, precise | same |
| DYN8 | `project(mapOf("path" to ":core"))` | edgesUnknown, all modules | same |
| DYN9 | `project(/:core/)` | edgesUnknown, all modules | same |
| DYN10 | `project( ":core" )` | app + core, precise | same |
| DYN11 | `project(":${"core"}")` | edgesUnknown, all modules | app missed (edge `${`) |
| DYN5 | `findProject(":core")?.let { … }` | **app missed**, `ok` | same (r5 N4, carried) |

### Over-correction check on the settings-membership rule (`:776`)

- **(a) Nested includes.** OCa1 (`include ':app', ':libs:core', ':data'` with `project(':libs:core')`) and OCa2 (`include 'libs:core'` with no leading colon, plus `project(path: ':libs:core')`) both give precise results: app + libs/core, `edgesUnknown=false`, data excluded. The include normalization and the `project()` normalization agree.
- **(b) Kotlin DSL.** These are all precise:
  - OCb1: `include("app", "core", "data")` with no colons
  - OCb2: a multi-line `include(\n ":app",\n …,\n)` with a trailing comma, plus `testFixtures(project(":core"))`
  - OCb3: separate `include()` lines
- **(c) Composite builds.**
  - OCc1: `pluginManagement { includeBuild("build-logic") }` gives a precise result. The `include(?![A-Za-z0-9_])` guard ignores `includeBuild`.
  - OCc2: an included build that has its own settings (`tools/settings.gradle.kts include(":lib", ":cli")`). Its names are added to the union, and a root core change stays precise. That build's modules are mis-rooted (see NOTE 2).
- **(d) Settings with only `rootProject.name`** (OCd): no names are included, so the rule is off. The result is `full_suite`, because core has no module entry. This is pre-existing and the safe direction.
- **(e) Settings absent** (OCe): the rule is off. The result is `full_suite`, for the same reason. This is pre-existing.
- **(f) Root `build.gradle` configuration blocks.**
  - OCf1 has a root with `allprojects { … }`, `subprojects { apply plugin: 'java' }`, `project(':core') { apply plugin: 'java-library' }` and `project(':app') { … }`, and app depends on core. A core change gives app + core with `edgesUnknown=false`. A data change (OCf1b) gives only DataTest.
  - So configuration blocks do **not** make plain multi-project builds `edgesUnknown`, and OA-12 is preserved. The `{` after the `)` passes the `(?=\s*[,)])` lookahead, and the included names satisfy the membership rule.
  - However, see **R6-B1**: dependencies *declared* inside those root blocks are attributed to the root module.
- **Comments.** OCg and OCh (a commented-out `project(":legacy")` for a module no longer in settings) now set `edgesUnknown` and widen to every module. See N1. This is the only new over-widening I found. r5 G10 shows the same diff.

### No regression

All earlier probe files pass. Every PROBE diff against the r5-round outputs is one of:
- the intended R5-B1 change (G2, G3, G4)
- G10: the commented-out legacy module now widens (N1)
- timing noise (r2 R9/RN ms lines)

There were no other differences in r4, r3, r3b or r2b.

### Prove-red reproduced (all three of the controller's claims)

I ran these in the byte-identical copy `wt\runner-v2`. BEFORE sha was `512d3ec4…b6b014`, 49338 bytes. Baseline `--test-name-pattern="R5-B1"` gave 1 pass / 0 fail.

- **A, membership rule off.** Changed `:776` `if (includedNames.size…` to `if (false && includedNames.size…` (1 match). Injected sha `aba32e39…`, diff is 1 line.
  - Result: **RED 0/1** at `affected-tests.test.ts:1018`, actual `undefined`, expected `true` (the unknown-module case).
- **B, lookahead and `$` filter off, membership rule kept** (2 lines, sha `c47a8484…`).
  - Result: GREEN 1/0. This confirms defense in depth, as the controller claimed.
- **C, all three off** (3 lines, sha `d0295b92…`).
  - Result: **RED 0/1** at `affected-tests.test.ts:1009` (the template form), actual `undefined`, expected `true`.
- **Restore.** I restored from backup after each injection.
  - AFTER sha `512d3ec4…b6b014`, and `cmp` against the worktree reports IDENTICAL.
  - The re-run gave 1 pass / 0 fail.
  - The worktree hash was unchanged throughout, and `git status` still shows 18 entries.

## Findings

### BLOCKING

**R6-B1: Dependencies declared inside cross-project configuration blocks in a build file are attributed to that file's own directory, usually the root `.`. A change to a library then misses every dependent subproject's tests, and the `module_graph` rung still reports `ok`.**
- Location: `affected-tests.ts:783-786`. `modules.push({ name: dir, dir, dependsOn: gradleDeps })` uses `dir = dirOf(path)` for every edge in the file. Nothing looks at `subprojects { }`, `allprojects { }`, `configure(…) { }` or `project(':x') { }`.
- Probes: settings `include ':app', ':core', ':data'`, change `core/src/main/kotlin/Cart.kt`.

  | Probe | root `build.gradle` | Graph | Result |
  |---|---|---|---|
  | OCf2 | `project(':app') { dependencies { implementation project(':core') } }` | `.` → [app, core], app → [] | `module_graph` ok `[core/…/CartTest.kt]`, **AppTest missed** |
  | OCf3 | `subprojects { if (name != 'core') { dependencies { implementation project(':core') } } }` | `.` → [core] | `module_graph` ok `[core/…/CartTest.kt]`, **AppTest and DataTest missed** |

- **Not a regression of repair 2.** The same probes against the r5-reviewed copy give identical output. The defect predates R4-B5, and rounds 1–5 did not probe it.
- It is blocking under this round's rule: a realistic input produces a selection that is too narrow, with an `ok` rung. Two patterns trigger it:
  - Declaring a shared `common`/`core` dependency in root `subprojects { dependencies { … } }` or `configure(subprojects.findAll { … }) { … }`. This is a widespread pattern in pre-convention-plugin Gradle builds.
  - Declaring cross-project dependencies from the root (`project(':app') { dependencies { … } }`), which appears in Gradle's own multi-project documentation.

  The typical change shape is a source edit in the shared library, and that is exactly the case where the dependents' tests are missed.
- **Minimal fix**, in the build-file branch of `parseMavenGradleGraph`:
  - Condition: the file contains a cross-project block opener (`/\b(?:subprojects|allprojects)\s*\{|\bconfigure\s*\(|\bproject\s*\([^)]*\)\s*\{/`) **and** a `\bdependencies\s*\{` block, **and** it yields at least one project edge (`gradleDeps.length > 0`).
  - Action: set `edgesUnknown`.
  - A precise attribution of each block to its target module is optional and can come later.
  - This keeps OCf1 precise. That case has configuration blocks but no `dependencies` in the root, and it is the OA-12 concern: plain multi-project builds must not become all-modules.
- **Tests:**
  - OCf2 and OCf3: a core change selects AppTest (and, for OCf3, DataTest), or `edgesUnknown` is true.
  - OCf1 control: app + core, data excluded, `edgesUnknown` undefined.

### NON-BLOCKING

**N1: Commented-out `project()` literals now widen the whole graph when they name a module that is no longer in settings.**
- Location: `affected-tests.ts:766` and `:770`. Both scan raw `content`, while `parseTypesafeGradleEdges:722` strips `//` and `/* */` first.
- Probes: OCg (`// implementation(project(":legacy"))`), OCh (the block-comment version) and r5 G10 all went from precise app + core to every module.
- This is the safe direction and only affects build files that keep commented-out references to removed modules. Still, it is a needless widening introduced by the `:776` rule. The comment text also already counts as a `project(` call, which is pre-existing.
- Fix: apply the same comment stripping as `:722` to `content` before computing `projectCalls` and `projectDeps`. A real change inside a comment cannot add or remove a Gradle edge.

**N2 (carried from r5 N4, still present): `findProject(":core")` is neither counted nor read.**
- Probe: DYN5 gives `module_graph` ok, and AppTest is missed.
- `\bproject` does not match inside `findProject`, because there is no word boundary.
- It is rare in dependency blocks (it is mostly used for optional modules), and the controller recorded it as carried. Fix: allow `(?:\b|(?<=find))[pP]roject\s*\(` in both the call count and the edge regex, or count `findProject(` as an unreadable call.

### NOTES

1. **A settings file in a subdirectory** (for example `backend/settings.gradle.kts`, probe OCi) roots its included names at the repo root (`core` instead of `backend/core`). Changes then fall through to `full_suite`. This is pre-existing, the safe direction, and costs precision only.
2. **An included build's own settings** (OCc2, `tools/settings.gradle.kts`) adds `lib`/`cli` as repo-root modules, and they resolve to no files. Changes inside `tools/` map to no module and widen. This is pre-existing and the safe direction.
3. The membership rule is off when `includedNames` is empty (OCd, OCe), as intended. The new test's literal control does check that `edgesUnknown` stays `undefined`.

## Commands and counts

All commands ran from the worktree root with `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`.

- **sha256:** both changed files match the controller's "Controller repair 2" values.
- **New probes:**
  - `review-scratch-t5-r6\probes-r6.test.mts`: 2/2 pass (they log and do not assert), 28 PROBE lines.
  - The same file against the r5 copy: 2/2, 28 PROBE lines.
- **Earlier probes, re-run:**

  | Probe file | Result | PROBE lines |
  |---|---|---|
  | `review-scratch-t5-r5\probes-r5.test.mts` | 6/6 | 106 |
  | `review-scratch-t5-r4\probes-r4.test.mts` | 6/6 | 75 |
  | `review-scratch-t5-r3\probes-r3.test.mts` | 12/12 | 47 |
  | `probes-r3b.test.mts` | 1/1 | 7 |
  | `review-scratch-t5-r2\probes-r2.test.mts` | 15/15 | 100 |
  | `probes-r2b.test.mts` | 3/3 | 12 |

  The diffs are explained above.
- **Prove-red:**

  | Run | Result |
  |---|---|
  | baseline | 1/0 |
  | A | 0/1 (`:1018`) |
  | B | 1/0 |
  | C | 0/1 (`:1009`) |
  | restored | 1/0 |

  The worktree sha was `512d3ec4…b6b014` before and after.

## Verdict

R5-B1 is fixed. All the template, concatenation and triple-quoted forms fail closed. The settings-membership rule does not over-widen nested, Kotlin-DSL or composite-build settings, and root configuration blocks do not make plain builds all-modules. The only new widening is N1 (commented-out edges).

One realistic false-narrow defect remains, and it is pre-existing: dependencies declared inside root `subprojects { }` or `project(':x') { }` blocks are attributed to the root module (R6-B1).

T5 REVIEW r6 — REPAIR REQUIRED — 1 blocking
