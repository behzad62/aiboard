# T5 independent review: round 9 (narrow)

Reviewer: independent, fresh context, no memory of the controller session. I edited no source or test file and committed nothing. This file is the only file I wrote in the repo.

Workspace: `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6-t5` (T5 is uncommitted). Scratch: `C:\Users\b_a_s\AppData\Local\Temp\p6-6\review-scratch-t5-r9\`. It holds:
- `wt\`, a byte-identical copy of `runner-v2/{package.json,src,test}`, plus `affected-tests.ts.bak`
- `probes-{r4,r5,r6,r7,r8}.test.mts`: the earlier probe files with only the `W` import line made env-configurable (`AFF_SRC`)
- `probes-{r4..r8}.cur.out.txt` and `probes-{r4..r8}.r8tree.out.txt`, plus `diff-{r4..r8}.txt`
- `probes-r9.test.mts`, `probes-r9.{cur,r8tree,r7tree}.out.txt`, `probes-r9-rx.{cur,r8tree,r7tree}.out.txt`
- `probe-long.test.mts` and `probe-long.out.txt`
- `pr-baseline.txt`, `pr-red-X.txt`, `pr-red-Y.txt`, `pr-restored.txt`

## Scope

I read `T5-review-r8.md` and the `T5.md` section "Controller repair 5 (after review r8)". I read the Gradle build-file branch of `parseMavenGradleGraph` in `runner-v2/src/affected-tests.ts` (`:805-857`, including `RECEIVER` at `:820`, its removal at `:829`, the `findProject?.` rule at `:835`, and `crossProject` at `:850-852`). I also read the new test `R8-B1` at `runner-v2/test/affected-tests.test.ts:1113-1135`. Per the owner's rule I did not re-run the controller's suites.

| File | Evidence sha256 | Tree | Match |
|---|---|---|---|
| `runner-v2/src/affected-tests.ts` | `cadec8d410e4ad19f01e5596ba8a34b22fd29ca64ec0d09b91b7796c265da641` | same | OK |
| `runner-v2/test/affected-tests.test.ts` | `d12615432eb45fb761376796cffca25526a2eac96fde0b1f7f58b7dc50db572a` | same | OK |

`git status --short` showed 18 entries both before and after this review.

**Baselines for regression diffs:**
- **r8 tree:** `review-scratch-t5-r8\wt`, sha `e280f2cf…c44`, the tree r8 reviewed.
- **r7 tree:** `review-scratch-t5-r7\wt`, sha `b4099ac6…6fea`.

## Verification

### R8-B1 is fixed in the direction r8 asked for

On the current tree, each of these gives `edgesUnknown=false`, and a data change selects `[DataTest]` only:
- RR4, RR4b and RR5 (Kover and Dokka aggregation roots)
- RR6 (`jacocoAggregation`)
- RR7 (`dependsOn(project(":app").tasks…)`)

RR1–RR3 (root-as-module plus libs) are also precise:
- a lib change selects `LTest` and `RootTest`
- a util change selects `UTest`
- a root change selects `RootTest`

OC3 (the root `findProject(":app")?.let { it.version = … }`) is precise: a data change selects `[DataTest]`, and a core change selects `[AppTest, CartTest]`.

My extra over-correction controls (RY1–RY5) are all precise: `dependsOn(project(":core").tasks…)` in a module, root `findProject(":app")?.extensions…`, root `project(":app").plugins.withId`, `evaluationDependsOn`, and Kover combined with a CI task.

### R7 fail-closed shapes still fail closed

V7 (`.with { dependencies }`), V8 (`findProject(...)?.dependencies?.add`), V9 (`findProject(":core")?.let { implementation(it) }` as the only line in `dependencies`) and V11 (`.dependencies.add`) all give `edgesUnknown=true`. So do the cross-project, `subprojects.each` and `configure` shapes in the r7 and r6 probe files.

### N3 of r8 is fixed

| Input | Current tree | r8 tree |
|---|---|---|
| 80k unclosed `project(` (SL) | "under5s" | "SLOW" |
| 40k `findProject(':x'` inside `dependencies {` | 81 ms | 31.8 s |
| 50k 200-char receiver prefixes | 208 ms | 273 s |
| `dependencies {` + 3990 chars + 20k `findProject(` | 18 ms | 5.3 s |

No realistic input hangs or crashes.

### Probe history re-runs (current tree vs r8 tree)

| Probe file | Result (current / r8 tree) | PROBE lines | Diff |
|---|---|---|---|
| r4 | 6/6 / 6/6 | 75 | none |
| r5 | 6/6 / 6/6 | 106 | none |
| r6 | 2/2 / 2/2 | 28 | DYN5: still unknown, edge dropped (fine). **DYN6 regressed: now too narrow** (B1). |
| r7 | 3/3 / 3/3 | 29 | V7, V8 and V11: the root's receiver `app` is dropped from the root edge list, still unknown. V9 still unknown. OC3 now precise (intended). |
| r8 | 5/5 / 5/5 | 53 | RR1–RR7 now precise (intended). SL timing fixed. |

### Prove-red (reproduced both controller claims in `wt\`)

Run: `--test-name-pattern="R8-B1|R7"`.
- **Baseline:** 3 pass / 0 fail.
- **Mutation X:** remove the receiver exclusion. `receivers` becomes `0` and `.replace(RECEIVER, " ")` is dropped; 1 match each.
  - Result: **RED 2/1**, failing at `affected-tests.test.ts:1129` inside `R8-B1` (`:1113`).
  - Assertion message: `findProject(":app")?.let { it.version = "1.0" }` (OC3).
- **Mutation Y:** re-add the r8 root-file rule after `:852`, a 1-line insertion.
  - Result: **RED 2/1**, failing at `:1129`.
  - Assertion message: the Kover root.
- **Restore:** `cmp` against the worktree file reported IDENTICAL, and the re-run gave 3/0.

## Findings

### BLOCKING

**R9-B1: `RECEIVER` removal hides real dependencies declared in dependency-notation position. The rung stays `module_graph` (ok) but the selection is too narrow.**

- **Location:** `affected-tests.ts:820` (`RECEIVER`), `:829` (`.replace(RECEIVER, " ")`), `:821-822` (receivers are subtracted from `projectCalls`) and `:850-852`.
- **Mechanism:**
  1. Every `project(lit).<member>` or `findProject(lit)?.<member>` is erased before edges are read, and is also removed from the unreadable-call count. This applies to the members `with|dependencies|afterEvaluate|apply|let|run|also|tasks|configure|extensions|plugins`, wherever the call sits.
  2. The only remaining guard is `crossProject && gradleDeps.length > 0`, which fails in two ways:
     - It never fires when the receiver was the file's only project reference.
     - Its member list does not include `tasks`, `extensions`, `plugins` or `configure`, so for those members it does not fire even when other edges exist.

A core change on the current tree selects `[CartTest]` only, and `AppTest` is missed:

| Probe | `app/build.gradle(.kts)` `dependencies { … }` content | r7 tree | r8 tree | current |
|---|---|---|---|---|
| RX1 (= r6 DYN6) | `implementation(project(":core").also { println(it.name) })` | precise | fail-closed | **narrow** |
| RX2 | `api(project(":core").apply { description = "x" })` | precise | fail-closed | **narrow** |
| RX6 | `testImplementation(project(":core").extensions.getByType<SourceSetContainer>()["test"].output)` | precise | precise | **narrow** |
| RX6b | RX6 + `implementation(project(":data"))` | precise | precise | **narrow** (app→[data], no unknown) |
| RX7 | `testImplementation(files(project(":core").tasks.named("testJar")))` | precise | precise | **narrow** |
| RX7b | RX7 + `implementation(project(":data"))` | precise | precise | **narrow** (app→[data], no unknown) |
| RX8 | Groovy `implementation project(':core').also { }` | precise | fail-closed | **narrow** |
| RX9 | `project(":core").let { implementation(it) }` | precise | fail-closed | **narrow** |
| RX17 | `project(":core").run { implementation(this) }` | precise | fail-closed | **narrow** |
| RX13 | top-level `findProject(":core")?.let { p -> dependencies { implementation(p) } }` | narrow | fail-closed | **narrow** |

These forms still work correctly: `implementation(findProject(":core")!!)` (RX3) is an edge, and `.sourceSets…` output shares (RX4, RX5) are edges.

RX6 and RX7 are ordinary Kotlin-DSL test-output-sharing idioms. They were precise on both earlier trees and are now silently lost, even next to other project edges. DYN6 is a probe from the history, and it went from precise (r7) to fail-closed (r8) to too narrow. The brief states that "any receiver form inside a `dependencies {}` block of a module file that is really a dependency must not become silent".

The new test `R8-B1` (`test/affected-tests.test.ts:1113`) only exercises root files, so nothing guards this direction.

**Minimal fix:** treat a `RECEIVER` match as benign only when both of these hold:
- **(a)** It is not in dependency-notation position. That is, it is not preceded, after optional whitespace, by `(` or `,` of a call other than `dependsOn|mustRunAfter|shouldRunAfter|finalizedBy`, nor by a bare Groovy configuration identifier (`implementation project(':x').…`).
- **(b)** It is not inside a `dependencies { … }` block, and for the lambda members (`let|also|run|apply|with`) its lambda does not contain `dependencies` or a configuration call.

Any other receiver keeps counting as an unreadable call, so `projectDeps.length < projectCalls` sets `edgesUnknown`. This keeps OC3, RR7, RY1–RY3, V7, V8 and V11 as they are.

**Tests to add:** RX1, RX6b and RX7b as module-file cases, where a core change must select `AppTest` or `edgesUnknown` must be true.

**R9-B2: the bounded `findProject?.` rule stops matching the r7 V9 shape as soon as the `dependencies` block holds any `}` or more than 4000 characters before it. Combined with the receiver removal, the only edge disappears silently.**

- **Location:** `affected-tests.ts:835`, `/\bdependencies\s*\{[^}]{0,4000}\bfindProject\s*\([^)\n]{0,200}\)\s*\?\s*\./`.
- **Mechanism:** `[^}]` also stops at the `}` of a `${…}` version template or an `{ exclude(…) }` closure. Both are routine lines in real dependency blocks. The 4000-character bound is also hit by large blocks: at about 150 coordinates the `findProject` sits at offset 7147.
- **Effect:** on the r8 tree the plain edge regex still produced `app→core` from `findProject(":core")`, and `.let` was fail-closed. Now `RECEIVER` erases it, so nothing remains.

On the current tree each of these gives `edgesUnknown=false`, `app→[]`, and a core change selects `[CartTest]`:

| Probe | Content before the `findProject(":core")?.let { implementation(it) }` line | r8 tree |
|---|---|---|
| RX10 | `testImplementation("junit:junit:4.13") { exclude(group = "org.hamcrest") }` | fail-closed |
| RX11 | `implementation("com.x:y:${v}")` | fail-closed |
| RX12b | 150 plain coordinates (`probe-long.out.txt`) | fail-closed |

This is the optional-module idiom the r7 review required to fail closed, written with realistic neighbouring lines.

**Minimal fix:** find `dependencies {` blocks with a string-aware brace-depth scan over `code` (which is already comment-stripped) instead of `[^}]{0,4000}`. The scan is linear, so no length bound is needed. Alternatively, R9-B1's rule (b) subsumes this: any `findProject(lit)?.` receiver inside a dependencies block, found by the depth scan, is unreadable.

**Test to add:** RX10 or RX11.

### NON-BLOCKING

**N1:** the r8 N1 and N2 scanner gaps are still open, as the controller disclosed: slashy and dollar-slashy strings, nested `${…"/*"…}`, and an unterminated `/*` before `dependencies`. There is no new information this round.

**N2:** V7, V8 and V11 now drop the root's `app` receiver from the root's edge list. They stay `edgesUnknown`, so this has no selection effect.

### NOTES

1. Round direction check. r8 was too wide on roots, and r9 is precise on roots. However, the same receiver erasure that fixed OC3 is applied to module files, which reintroduces the too-narrow direction for dependency-notation receivers and for the V9 idiom beyond a trivial block.
2. The mutation-Y anchor did not match with a JS `\n` search because the file uses CRLF. I applied it with `sed '852a'` instead, and restored from the backup afterwards (`cmp` reported IDENTICAL).

## Commands and counts

All commands ran from the worktree root with `"C:\Program Files\nodejs\node.exe" .\node_modules\tsx\dist\cli.mjs --test --test-concurrency=1 <file>`. For the r8 and r7 trees the probe files were run with `AFF_SRC=file:///C:/Users/b_a_s/AppData/Local/Temp/p6-6/review-scratch-t5-r{8,7}/wt/runner-v2/src/`.

**Hashes:** match the repair-5 evidence (table above).

**Probe history, current tree vs r8 tree:**

| Probe file | Result | PROBE lines | Diff lines |
|---|---|---|---|
| r4 | 6/6 | 75 | 0 |
| r5 | 6/6 | 106 | 0 |
| r6 | 2/2 | 28 | 4 (DYN5, DYN6) |
| r7 | 3/3 | 29 | 10 (V7, V8, V9, V11, OC3) |
| r8 | 5/5 | 53 | 18 (SL, RR1–RR7) |

**New probes:**
- `probes-r9.test.mts`, RX group: 1/1 on each of the three trees, with 17 RX PROBE lines each. The first full run hit a probe-harness `ReferenceError` (missing `D`). I fixed the harness and re-ran.
- RY group: 5 PROBE lines.
- RT timing: 1 TIME line.
- `probe-long.test.mts`: 1/1, 1 PROBE line.

**Prove-red** (`--test-name-pattern="R8-B1|R7"` in `wt\`):
- Baseline: 3/0.
- Mutation X: 2/1 at `:1129` (OC3).
- Mutation Y: 2/1 at `:1129` (Kover).
- Restored: 3/0, and `cmp` reported IDENTICAL.

**Worktree state:** sha `cadec8d4…a641` and `d1261543…572a` before and after; `git status` shows 18 entries.

## Verdict

R8-B1 is fixed: aggregation, CI-task and configuration roots and OC3 are precise, the R7 fail-closed shapes still fail closed, and N3 is fixed. However, the new receiver erasure also applies inside module dependency blocks. It silently drops real edges such as `implementation(project(":core").also {…})`, `testImplementation(project(":core").extensions…output)`, `files(project(":core").tasks.named(…))` and `findProject(":core")?.let { implementation(it) }` after an ordinary templated or closure line, which gives a too-narrow `ok` selection.

T5 REVIEW r9 — REPAIR REQUIRED — 2 blocking
