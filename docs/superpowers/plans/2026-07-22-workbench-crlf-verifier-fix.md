# WorkBench CRLF Verifier Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent WorkBench's surgical-diff assertion from counting Windows line-ending conversion as code changes.

**Architecture:** Normalize CRLF and bare CR to LF inside the changed-line calculation only, immediately before equality and longest-common-subsequence comparison. Apply the same logic to the in-browser TypeScript verifier and the generated `verifier.mjs` runtime so their scoring stays identical; do not alter candidate contents used by semantic, syntax, or behavioral assertions.

**Tech Stack:** TypeScript, Node.js ESM, Next.js static export, PowerShell on Windows.

## Global Constraints

- Preserve all verifier assertions and scoring weights except the treatment of line endings in changed-line accounting.
- Keep `lib/benchmark/workbench/challenges.ts` and the generated verifier in `lib/benchmark/workbench/corpus.ts` behaviorally identical.
- Add a regression covering CRLF candidate files before changing production code.
- Runner V2 requires exactly Node.js 24.18.0 and Git.

---

### Task 1: Add CRLF parity regression coverage

**Files:**
- Modify: `scripts/test-workbench-current-challenges.mts`

**Interfaces:**
- Consumes: `runWorkBenchChallengeVerifier(...)`, `runRuntimeVerifier(...)`, and each challenge's `referenceFiles`.
- Produces: regression assertions proving LF-authored base fixtures and equivalent CRLF reference candidates receive score `1` in both verifier implementations.

- [x] **Step 1: Write the failing test**

Add a helper that converts every line break in every reference file to CRLF, then invoke both verifiers and assert that each result passes with score `1`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/test-workbench-current-challenges.mts`

Expected: FAIL on the CRLF assertions because `changedLines` treats the retained `\r` characters as edits.

### Task 2: Normalize line endings for diff accounting

**Files:**
- Modify: `lib/benchmark/workbench/challenges.ts`
- Modify: `lib/benchmark/workbench/corpus.ts`

**Interfaces:**
- Consumes: two file-content strings passed to `changedLines`.
- Produces: an edit count based on `value.replace(/\r\n?/g, "\n")`, leaving all other verifier inputs untouched.

- [x] **Step 1: Implement the minimal TypeScript fix**

Normalize both operands at the start of `changedLines`, then compare and split the normalized strings.

- [x] **Step 2: Mirror the fix in generated runtime source**

Add the same normalization inside the `String.raw` verifier program so native execution has identical behavior.

- [x] **Step 3: Run the focused test to verify it passes**

Run: `npx tsx scripts/test-workbench-current-challenges.mts`

Expected: all current challenge, negative-control, runtime-parity, and CRLF checks PASS.

### Task 3: Verify and publish the repaired application artifact

**Files:**
- Verify: `lib/benchmark/workbench/challenges.ts`
- Verify: `lib/benchmark/workbench/corpus.ts`
- Verify: `scripts/test-workbench-current-challenges.mts`
- Copy if rebuilt: `public/bench-runner.mjs`, `public/aiboard-runner-v2.zip`

**Interfaces:**
- Consumes: repository scripts and the downloadable runner artifacts.
- Produces: a lint-clean, type-safe, built app with the corrected WorkBench verifier available to the benchmark UI.

- [x] **Step 1: Run focused and full verification**

Run the WorkBench test suite, lint, TypeScript validation, and production build. Expected: exit code `0` for every command.

- [x] **Step 2: Restore the development server after build**

Restart the app on port `3000`, because building while the development server is active can invalidate `.next`.

- [x] **Step 3: Copy rebuilt downloadable artifacts when their bytes changed**

Copy the updated files to `C:\Users\b_a_s\source\repos\WorkBenchTest` and leave the localhost benchmark runner available for reruns.

- [x] **Step 4: Commit**

Stage only the plan, regression test, and verifier changes, then commit with `fix: normalize WorkBench verifier line endings`.
