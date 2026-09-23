You are taking over Runner V2 Gate G from an already-implemented lifecycle architecture correction.

## Repository / branch

Worktree:

`D:\repos\ai-discussion-board\.worktrees\runner-v2-task12-bounded`

Branch:

`codex/runner-v2-task12-bounded`

PR:

`#95`

Current pushed architecture commit:

`2ffb8054`

Do **not** merge PR #95 unless I explicitly approve it.

## Critical constraint

Do **not** run:

`npm run test:runner-v2`

That full-suite budget was already consumed earlier. Use impact-based targeted validation and hosted qualification only.

Node support is **Node 24 only**. Do not reintroduce Node 22.

---

# Current architecture — do not reopen this unless new evidence proves it wrong

Runner V2 lifecycle semantics were corrected so that:

* ordinary native execution uses a truthful `process_group` lifecycle scope;
* strong containment uses `contained_workload`;
* POSIX process groups do **not** claim arbitrary detached-descendant containment;
* Windows Job Objects and OCI are strong contained-workload boundaries;
* process backends and isolation providers remain separate abstractions;
* PPID/ancestry reconstruction is not used as lifecycle ownership authority;
* v1 durable records remain readable but cannot silently acquire v2 destructive lifecycle authority;
* recovery, persistence, MCP/LSP/managed execution, one-shot execution, observability and provider selection now carry lifecycle scope explicitly;
* `full + contained_workload` prefers qualified OCI, but may fall back to a verified contained backend such as Windows Job; POSIX must fail if no contained provider exists;
* restricted/project/guarded execution remains fail-closed;
* output settlement, fencing, exact identity, durable recovery, birth identity and stale-authority protections remain intact.

A fresh independent Cursor review after these repairs returned:

`READY — no Blocker/Important findings`

Do not redesign this architecture just because hosted CI is noisy.

---

# What is happening now

We have spent too many hours in a loop where:

1. local real-host tests pass,
2. GitHub hosted qualification fails under timing/contention,
3. individual failures are patched,
4. another unrelated host-sensitive failure appears.

We need to break that loop by **refactoring the qualification layer**, not by continuing to modify working lifecycle/fence semantics.

## Fresh PR CI status

Required PR CI on commit `2ffb8054` is green, including:

* Windows/Linux/macOS portable contract
* native adapter probes
* package parity/reproducibility
* benchmark

So deterministic required CI is already healthy.

## Qualification run

Fresh hosted qualification run:

`35492714608`

It exposed a mix of real defects, stale fixtures and hosted-runner timing issues.

### Already diagnosed / repaired locally but not yet committed

There are currently uncommitted qualification-repair changes in the worktree.

Important examples:

### 1. Real recovery bootstrap bug

`captureRunGitBaseline()` previously called the exact ownership `binding.close()` only once.

The close contract intentionally may surface one transient cleanup error even though a retry immediately proves release.

On slow hosted runners that transient error was wrapped as an `AggregateError`, which masked either:

* successful bootstrap, or
* the original typed isolation error,

and the HTTP layer converted it to generic `500 internal_error`.

A RED test proved this.

Fix implemented:

* retry the exact `binding.close()` once at the Git-bootstrap consumer boundary;
* do not weaken `ExecutionHost.close()` itself.

Targeted new tests: **2/2 green**

Real local recovery smoke: green.

### 2. CLI qualification fixture problems

Several CLI qualification failures were stale fixtures, not product failures.

Fixes already made locally:

* Windows test-only CLI readiness outer budget:

  * Windows: 90s
  * other hosts: 30s
* active-build capability-contract fixtures now include the Git baseline prerequisite they are supposed to satisfy;
* “unsupported execution-safety version” fixture now writes version `3`, because version `2` is now legitimately current.

Affected CLI tests: **3/3 green locally**

These are test/harness fixes only. Product startup deadlines were not widened.

### 3. macOS POSIX lifecycle test

The test previously did:

`sleep ~150ms -> assert reconcile == running`

That is fragile on hosted macOS because POSIX identity evidence comes through `ps`.

It was changed locally to bounded convergence:

* wait up to ~5s;
* PASS if `running`;
* persistent `outcome_unknown` still fails;
* failure should include exact supervisor state/error.

Do not weaken POSIX fail-closed semantics.

### 4. Windows hosted qualification failures

The hosted qualification run showed multiple Windows failures involving:

* `database is locked`
* owned-fence protocol observation changed
* fixture Job startup deadline
* late-birth cleanup uncertainty
* channel/fence acquisition contention

However:

Exact Windows portable-channel qualification command was run locally:

`99 passed / 0 failed`

The exact Windows native lifecycle qualification command was also being reproduced locally and was green through the observed sections.

This strongly suggests hosted-runner interference / giant-file qualification coupling rather than a deterministic lifecycle defect.

Do **not** immediately modify `owned-fence-lock.mjs`, Windows lifecycle semantics, or product deadlines because GitHub happened to hit contention.

---

# Main task

Refactor Runner V2 hosted qualification so it becomes **small, isolated, deterministic, and useful**.

The objective is to stop using enormous timing-sensitive test files as qualification entrypoints.

## Desired model

Separate:

### A. Deterministic correctness

Keep existing unit/contract tests for things like:

* lifecycle scope selection;
* stale authority rejection;
* fencing rules;
* recovery decisions;
* takeover semantics;
* tamper resistance;
* capability policy;
* output settlement rules.

These belong in normal required CI.

### B. Real-host qualification

Hosted qualification should prove only the things that actually require the OS/runtime:

* Windows Job containment;
* Windows portable/native lifecycle;
* POSIX process-group lifecycle;
* macOS real process identity behavior;
* real restart/recovery;
* OCI containment;
* real output/terminal lifecycle where OS behavior matters.

These should be small dedicated qualification tests.

---

# Suggested direction — evaluate and refine, do not blindly force

Create focused real-host qualification entrypoints, for example:

```text
runner-v2/test/qualification/
  windows-job-lifecycle.test.ts
  windows-portable-lifecycle.test.ts
  posix-process-group.test.ts
  recovery.test.ts
  cli-readiness.test.ts
  oci-containment.test.ts
```

Names can differ if the repository structure suggests something better.

Each entrypoint should contain only a small number of real-host acceptance scenarios, ideally about 3–10 meaningful scenarios, not hundreds of synthetic unit tests.

Important principles:

### Fresh process isolation

Where practical, run important scenarios in separate Node processes rather than one giant test process.

For example:

```text
Windows Job scenario
    ↓
fresh Node process exits
    ↓
Windows portable scenario
    ↓
fresh Node process exits
```

The goal is to prevent:

* delayed SQLite cleanup;
* late background process completion;
* retained fixture state;
* one test's timing from poisoning another.

### Keep product deadlines unchanged

Qualification may use generous **outer test guards** because GitHub VMs are slow.

Examples:

* CLI readiness outer guard 90s on Windows;
* fixture startup guard large enough for GitHub load;
* cleanup guard large enough to observe exact release.

Do not widen product:

* fence deadlines;
* lifecycle deadlines;
* startup semantics;
* recovery semantics;

unless a separate deterministic test proves a real product defect.

### Use bounded convergence, not fixed sleeps

Avoid:

```text
sleep(150ms)
assert(state == running)
```

Prefer:

```text
wait until bounded deadline:
    expected state -> pass
    definitive invalid state -> fail immediately
    still unknown at deadline -> fail with exact evidence
```

### Evidence on failure

For every real-host qualification failure, preserve/upload useful diagnostics automatically where practical:

* fixture root;
* `state.json`;
* fence SQLite database + sidecars;
* supervisor status;
* process snapshot;
* retained output metadata;
* timing measurements;
* stdout/stderr;
* relevant durable recovery records.

Do not make investigation depend on another rerun just to add logging.

---

# Qualification workflow

Review and simplify:

`.github/workflows/runner-v2-qualification.yml`

Current qualification jobs include:

* native lifecycle
* CLI readiness
* recovery
* Windows portable channel
* Docker OCI integration

Do not simply keep invoking whole giant files if only a handful of their tests are genuine real-host qualification.

For example, current Windows lifecycle invokes entire files such as:

```text
windows-process-backend.test.ts
windows-job-process-channel.test.ts
```

and portable qualification invokes:

```text
portable-process-protocol.test.ts
portable-process-channel.test.ts
```

Those contain many deterministic/synthetic tests and create unnecessary contention.

Refactor qualification to call the focused acceptance entrypoints instead.

Existing broad test files should remain available for normal deterministic testing.

---

# Important stopping rule

Do not continue this loop:

```text
CI host contention
→ tweak product behavior
→ local passes
→ different CI timing failure
→ tweak product again
```

Use this decision rule instead:

### If a failure:

1. reproduces deterministically locally
   → fix the product/test contract.

2. is a stale fixture/obsolete expectation
   → fix the fixture.

3. passes repeatedly with the exact same command locally but fails only inside a giant hosted qualification run with unrelated contention
   → isolate/refactor qualification before touching product semantics.

4. still fails in the new isolated hosted qualification
   → investigate as a genuine host-specific product issue.

---

# Before implementation

First inspect:

* current `git status`;
* current uncommitted repair diff;
* `docs/runner-v2/architecture-reassessment-2026-09-19/DECISION.md`
* `PLAN.md`
* `STATE.json`
* fresh qualification run evidence if accessible.

Do not blanket reset the working tree. There are legitimate uncommitted repairs described above.

Classify existing uncommitted hunks:

* KEEP
* REWORK
* REMOVE
* DEFER

before restructuring qualification.

---

# Testing discipline

Use targeted validation only.

Recommended pattern:

1. RED test for any product bug.
2. Minimal implementation.
3. Exact affected test.
4. Focused related file/suite.
5. TypeScript compile.
6. `git diff --check`.
7. Fresh hosted qualification.

Do **not** run the global Runner V2 suite.

Do not rerun huge affected bundles repeatedly if one focused qualification entrypoint can prove the change.

---

# Independent review

Before final commit/push of the qualification refactor, run one fresh read-only independent Cursor review.

Ask it specifically to check:

* qualification no longer over-stresses unrelated test infrastructure;
* no product deadline/semantic weakening was introduced;
* lifecycle scope guarantees remain truthful;
* POSIX ancestry reconstruction has not returned;
* Windows Job/OCI containment claims remain honest;
* host-only qualification genuinely exercises real OS behavior;
* evidence collection is sufficient;
* required CI remains deterministic;
* no previously required cross-platform coverage was accidentally dropped.

Address only concrete Blocker/Important findings.

---

# Final acceptance path

Target outcome:

```text
local targeted tests green
        ↓
focused qualification entrypoints green locally where host supports them
        ↓
commit qualification refactor + existing genuine repairs
        ↓
push
        ↓
fresh required PR CI green
        ↓
fresh isolated Windows/Linux/macOS/OCI qualification green
        ↓
update M4 / Gate G evidence
        ↓
clean tree
        ↓
READY FOR USER REVIEW
```

Do not mark Gate G PASS until the fresh hosted qualification on the final SHA is green.

Do not merge PR #95.

---

# Current mindset

The remaining problem is no longer “invent stronger process-containment machinery.”

The problem is:

**make hosted qualification accurately test the architecture without creating artificial cross-test interference.**

Prefer reducing qualification coupling over increasing implementation complexity.

Preserve correctness, fail-closed authority and honest lifecycle semantics.
