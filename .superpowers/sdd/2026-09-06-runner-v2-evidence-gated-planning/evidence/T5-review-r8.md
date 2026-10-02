# T5 independent review: round 8 (narrow)

Reviewer: independent, fresh context, no memory of the controller session. Inputs were read from disk only. I edited no source or test file and committed nothing. This file is the only file I wrote in the repo.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5` (T5 is uncommitted). Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r8\`. It holds:
- `probes-r8.test.mts` and `probes-r8.out.txt`
- `probes-r8-against-r7.out.txt`
- `probes-{r7,r6,r5,r4}-on-r7tree.test.mts` with their `.out.txt`
- `rerun-probes-{r7,r6,r5,r4}.txt`
- `wt\`, a byte-identical copy of `runner-v2/{package.json,src,test}`
- `inject.cjs`, `affected-tests.ts.bak`, `pr-*.txt`
- `probes-rr-without-root-rule.out.txt`, `probes-r7-without-root-rule.out.txt`

## Scope

I read `T5-review-r7.md` and the `T5.md` section "Controller repair 4 (after review r7)". In `runner-v2/src/affected-tests.ts` I read `stripGradleComments` (`:727-763`), `parseTypesafeGradleEdges` (`:765-775`) and the build-file branch of `parseMavenGradleGraph` (`:805-853`). I also read the new tests at `runner-v2/test/affected-tests.test.ts:1064-1111`. Per the owner's rule I did not re-run the controller's suites.

| File | Evidence sha256 | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `e280f2cff4b39d2e2919c86fd672e24633789f9a56d2c3d46de0157aec328c44` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `6bcef2119de66566eecb3335f1ad2d43b8f870f83847bae10a277114c65acefd` | same | OK |

`git status --short` showed 18 entries both before and after this review.

**Baseline for regression diffs.** Every probe file was run twice: once against the current tree and once against the r7-reviewed tree. The r7-reviewed tree is `review-scratch-t5-r7\wt` with sha `b4099ac6…6fea`. Diffing the two runs isolates exactly what repair 4 changed.

## Verification

### R7-B1 is fixed: CM1–CM6 inverted

Against the current tree, every CM probe now gives `app→[core]` with `edgesUnknown=false`, and a core change selects `[AppTest, CartTest]`. On the r7 tree the same probes selected `[CartTest]` only. CM7 (a real `/* */` comment around a legacy edge) stays precise.

### Scanner edge cases (`probes-r8.test.mts`, S and SG groups)

**Direct outputs of `stripGradleComments`:**
- An unterminated `'` or `"` is bounded at the end of the line (u1, u2).
- An unterminated `"""` copies the rest of the file verbatim (u3). Kept text can only add calls, so this is the safe direction.
- An unterminated `/*` blanks the rest of the file (u4).
- `'\''` (u5) and `"a\\"` (u6) are handled correctly.
- A trailing `\` at the end of the input does not overrun (u7).
- A Kotlin raw string containing `"` and `//` is kept (u8).
- A GString `"${a("b")} // s"` resolves correctly (u9).
- A slashy `/.*Test/` is harmless (u10).
- CRLF input is handled (u11).

**Precise and correct in real build files:**
- SG1: unterminated `'` on an earlier line.
- SG2, SG3: unterminated `/*` or `"""` after the dependencies.
- SG4: unterminated `"""` before the dependencies (edges kept).
- SG6: slashy regex with the dependencies on the same line.
- SG9: GString with nested quotes followed by `//`.
- SG10: Kotlin raw string containing `"` and `//`.
- SG11: `'\''` followed by `//`.
- SG12: `"C:\\"` followed by `//`.
- SG13, SG14: CRLF files.
- SG15: apostrophe in a line comment.
- SG16: apostrophe in a block comment that holds a legacy edge (the legacy edge is correctly dropped).
- SG17: double-quoted project path.
- SG19: Kotlin raw-string glob.
- SG20: Kotlin `'"'` character literal.
- SG18: a GString path fails closed, as intended.

**Still too narrow** (details under N1 and N2):
- SG5: unterminated `/*` before the dependencies.
- SG7: slashy string containing `\/*`.
- SG8: dollar-slashy string containing `//`.
- SG21: a nested-quote template whose inner string holds `/*`.

**Linear time:**

| Input | Size | Time |
|---|---|---|
| Realistic Android-style content ×80k | 9.28 MB | 965 ms |
| Realistic ×20k | 2.3 MB | 144 ms |
| 200k unterminated `'` lines | — | 63 ms |
| 4 MB with an unterminated `/*` | 4 MB | 61 ms |
| 200k `/* */` pairs | — | 38 ms |
| 200k open `"""` | — | 30 ms |
| 1 M whitespace run after `{` | — | 60 ms |

The scanner is linear. The only superlinear inputs were syntactically invalid files with unclosed parentheses (N3).

### N1–N3 of r7

All intended changes are confirmed by the diff against the r7 tree:
- **N1:** V7, V8, V11 and V13 now set `edgesUnknown`.
- **N2:** V9, r6 DYN5 and r5 G12 now set `edgesUnknown`.
- **N3:** V10 now reads `app→[core]` and stays precise.

### Over-correction (r7 set plus new root shapes)

The r7 set OC1, OC1b, OC2, OC4, OC4b, OC5, OC5b and OC6 is unchanged and precise. **OC3 changed.** Details are in R8-B1.

### No regression in earlier probes (current tree vs r7 tree)

| Probe file | Result (now / r7 tree) | PROBE lines | Diff |
|---|---|---|---|
| `probes-r7.test.mts` | 3/3 / 3/3 | 29 | V7, V8, V9, V11, V13 now fail closed; V10 precise; CM1–CM6 fixed. **OC3 now over-corrected (see B1).** |
| `probes-r6.test.mts` | 2/2 / 2/2 | 28 | DYN5 fails closed (intended). DYN6 `implementation(project(":core").also { … })` now fails closed (slight over-correction, rare idiom). |
| `probes-r5.test.mts` | 6/6 / 6/6 | 106 | G12 fails closed (intended). |
| `probes-r4.test.mts` | 6/6 / 6/6 | 75 | none |

### Prove-red (reproduced the controller's claim 1, in `wt\`)

- **Baseline:** `--test-name-pattern="R7"` gives 2 pass / 0 fail.
- **Mutation M:** restore the string-unaware regex at the build-file site. This means replacing `:811` `const code = stripGradleComments(content);` with the r7 `content.replace(/\/\*…\*\//g," ").replace(/\/\/.*$/gm," ")`. The replacement matched once, with a 1-line diff.
  - Result: **RED 1 pass / 1 fail**, failing at `affected-tests.test.ts:1086` inside test `R7-B1` (declared at `:1064`). This matches the controller's claim 1.
- **Mutation R:** delete the root-file rule at `:848` alone. This matched once, with a 1-line diff.
  - Result: 2/2 green, which matches the controller's claim that the rule is layered.
  - With R applied, the r7 probe output is byte-identical to the current tree's output. So V7, V8, V11 and V13 are still caught by the widened cross-project pattern, and `:848` adds no coverage on any probed shape.
  - With R applied, RR1–RR7 below all return to precise.
- **Restore:** the file was restored from the backup after each mutation. `cmp` against the worktree reported IDENTICAL, and the re-run gave 2/2.

## Findings

### BLOCKING

**R8-B1: the new root-file rule and the widened receiver arm over-correct ordinary multi-module roots. Every change now selects every module.**

Both parts are regressions from repair 4. The r7 tree was precise on every scenario below (`probes-r8-against-r7.out.txt`).

- **Location 1, `affected-tests.ts:848`:** `if (dirOf(path) === "." && includedNames.size > 0 && gradleDeps.length > 0) edgesUnknown = true;`. Any literal `project(':x')` in the root build file widens the whole graph, because `edgesUnknown` is graph-global.
- **Location 2, `:843-845`:** the root's own `findProject(":x")` receiver is read as an edge at `:823`, so the new `.let/.with/…` arm fires on configuration-only roots.

Scenarios where the current tree sets `edgesUnknown=true` and selects App+Core+Data tests for every change (r7 tree: precise):
- **RR4/RR4b (Kover aggregation root):** `build.gradle.kts` `dependencies { kover(project(":app")); kover(project(":core")); kover(project(":data")) }`. This is the documented Kover 0.7+/0.8 idiom for merged reports.
- **RR5 (Dokka aggregation root):** `dependencies { dokka(project(":app")) … }`. This is the documented Dokka 2 multi-module idiom.
- **RR6 (report-aggregation root):** `plugins { id 'jacoco-report-aggregation' }` with `dependencies { jacocoAggregation project(':app') … }`.
- **RR7 (aggregate CI task):** `tasks.register("ciTest") { dependsOn(project(":app").tasks.named("test")) … }`.
- **RR1–RR3 (root-as-module + libs):** `settings.gradle` `include 'lib', 'util'` plus a root `dependencies { implementation project(':lib') }`.
  - This one on its own would be tolerable fail-closed. A lib change already selects root+lib; a root change now also runs `lib` and `util` tests.
  - It is listed because the same line is what kills precision for the aggregation roots above.
- **OC3 (r7 required-precise set):** a configuration-only root `findProject(":app")?.let { it.version = "1" }` is now `.→[app]` + `edgesUnknown`, and a data change selects all three modules.

Why this is blocking: Kover and Dokka aggregation roots are ordinary Kotlin multi-module layouts. With this rule, `module_graph` selection degrades to "everything" on every change in those repos. That is exactly the over-correction class this round must reject. OC3 is part of the r7 set that must stay precise. Nothing is gained in exchange: with `:848` removed, every N1 shape is still caught (mutation R above).

Minimal fix:
1. Delete `:848`. In scratch this was verified to keep the `R7` tests at 2/2, the r7 probe outputs byte-identical, and RR1–RR7 precise.
2. For OC3, decide the `crossProject` condition on edges that are **not** themselves the receiver of the matched `?.let/.with/.run/.also/.apply/.afterEvaluate/.dependencies` call. In practice, drop `(project|findProject)(lit)\s*\??\s*\.` receivers from the dependency list used at `:845`. With that change:
   - V7, V8 and V11 still widen through their inner `project(':core')`.
   - OC3 becomes precise.
   - DYN6 keeps its plain `app→core` edge.

Tests to add:
- The Kover and Dokka roots, RR7 and OC3: a data change must select `[DataTest]` only, with `edgesUnknown` undefined.
- Keep the existing N1/N2 assertions.

### NON-BLOCKING

**N1: the scanner does not model Groovy slashy/dollar-slashy strings or `${…}` nesting, so a `//` or `/*` in those can hide an edge. The rung stays ok but the selection is too narrow.**
- Location: `:734-758`.
- Probes, each selecting `[CartTest]` only:
  - SG7: `exclude { it.path ==~ /gen\/*.java/ }` followed by a later `/* */`.
  - SG8: `$/https://…/$` with the dependencies on the same line.
  - SG21: Kotlin `"${property("x") ?: "/*"}"` with a later `"*/"`.
  - RR10: `"${findProperty("repo") ?: "https://x"}"` with the dependencies on the same line. RR10 was also too narrow on the r7 tree, so it is pre-existing.
- All of these need an unusual combination: a slashy regex containing `\/*`, a dollar-slashy URL, or a nested template default containing `/*`, or a same-line dependency after a `//`. The multi-line RR9 form of the URL template is precise. Hence non-blocking.
- Fix options:
  - Track `${` brace depth inside `"…"` and `"""…"""`, recursing into the code scanner.
  - Treat `$/` as a dollar-slashy opener that runs to `/$`.
  - Cheap fail-closed alternative: if a removed comment span contains `project(`, `findProject(` or `projects.` and the span does not start at a line's first non-space token, set `edgesUnknown`.

**N2: an unterminated `/*` before the dependencies blanks the rest of the file, so the rung stays ok but the selection is too narrow (SG5).**
- Location: `:739-741`.
- Gradle cannot compile such a file, so this is not realistic input.
- Fix: return an `unterminated` flag from the scanner and treat it as `edgesUnknown`.

**N3: new superlinear regex on unclosed parentheses.**
- Location: `:828` `findProject\s*\([^)]*\)` and `:844` `(?:project|findProject)\s*\([^)]*\)`. Both were introduced by repair 4.
- Measurements: `"project(".repeat(20000)` takes 1.7 s; ×80k takes 25.9 s; `"findProject(".repeat(20000)` takes 4.8 s.
- Only syntactically invalid files hit this. Realistic 9.3 MB input runs in under 1 s, hence non-blocking.
- Fix: use `[^()]*` or `[^)\n]{0,200}`.

**N4: DYN6 `implementation(project(":core").also { … })` in a subproject now fails closed through the `.also` arm.**
- This is a rare idiom and the safe direction. It resolves with the receiver-exclusion fix in B1.

### NOTES

1. The unterminated single-line quote is bounded at the newline, and the unterminated triple quote copies to the end of the file. Both keep text rather than removing it, so they can only over-count calls (the safe direction).
2. For a root-as-module build, widening alone is bounded. It is the same line hitting aggregation roots that makes `:848` blocking.

## Commands and counts

All commands ran from the worktree root with `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`.

**Hashes:** the sha256 of both changed files equals the repair-4 values (table above).

**New probes:**
- `review-scratch-t5-r8\probes-r8.test.mts`: 4/4 pass, 49 PROBE lines, 10 TIME lines.
- The `RR2` group, run separately after it was appended: 1/1 with 4 PROBE lines.

**Against the r7 tree:** the RR and RR2 groups of `probes-r8` give precise results for all RR1–RR7.

**Re-runs, current tree vs r7 tree:**

| Probe file | Result | PROBE lines |
|---|---|---|
| r7 | 3/3 | 29 |
| r6 | 2/2 | 28 |
| r5 | 6/6 | 106 |
| r4 | 6/6 | 75 |

Diffs are as listed above.

**Prove-red and fix check** (`--test-name-pattern="R7"` in `wt\`):
- Baseline: 2/0.
- Mutation M: 1/1, failing at `:1086`.
- Mutation R: 2/0. With R, the r7 probes diff is empty and RR1–RR7 are precise.
- Restored: 2/0, and `cmp` reported IDENTICAL.

**Worktree state:** sha `e280f2cf…c44` and `6bcef211…fefd` before and after; `git status` shows 18 entries.

## Verdict

R7-B1 is fixed. The scanner is string-aware, linear, and robust to unterminated quotes and comments, and CM1–CM6 now select AppTest. r7's N1–N3 are closed and all earlier probe files show only intended changes.

However, the new root-file rule (`:848`) and the receiver arm make ordinary aggregation roots (Kover, Dokka, jacoco report aggregation, root CI tasks) and the r7 configuration-only root OC3 select every module on every change. On the r7 tree all of these were precise, and the rule adds no coverage on any probed shape.

T5 REVIEW r8 — REPAIR REQUIRED — 1 blocking
