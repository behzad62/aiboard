# Task 4 implementer report — P6.4c backend-neutral durable subprocess runtime

## Scope and commit

Implemented Task 4 only in `D:/repos/ai-discussion-board/.worktrees/runner-v2-robust-build`, starting from required base `802f649138d7f72f0e6dc2a2d0a6c64bfc0ec0f8` on branch `codex/runner-v2-robust-build`.

Implementation commit: `b20d6b7820b41fe32a688928af709933fac10e36` (`feat(runner-v2): add durable subprocess runtime`).

The commit contains exactly the six requested source/test files:

- `runner-v2/src/process-backend.ts`
- `runner-v2/src/durable-process-store.ts`
- `runner-v2/src/subprocess-runtime.ts`
- `runner-v2/test/process-backend-contract.test.ts`
- `runner-v2/test/durable-process-store.test.ts`
- `runner-v2/test/subprocess-runtime.test.ts`

No production OS backend, isolation provider, existing process family, spawn site, native build factory, or legacy process implementation was modified or rewired.

## Contract and control-flow decisions

### `ProcessBackend`

The SPI owns strict probe/attestation, launch, observe/drain, signal with semantic escalation action, verified-empty proof, restart reconciliation, and resource release. A backend has an implementation identity independent of `platformLabel`. `selectProcessBackend` accepts a backend only when:

1. the probe is a closed ordinary data object;
2. `verified` is literal `true`;
3. the claimed backend id exactly matches the implementation id;
4. every requested semantic capability is `enforced`.

Accessor-backed, proxy-backed, open-shaped, false, string-truthy, malformed, and identity-conflicting claims fail closed. Selection never reads `process.platform` or chooses by OS label.

Ephemeral launch input includes the validated Task 1 intent/grant and Task 2 scrubbed environment. The backend returns only opaque backend identity, birth fingerprint, optional PID, and start time. Signal/reconcile/release accept the complete identity-bound binding; PID is informational and never sufficient authority.

### Durable store

`DurableProcessStore` has in-memory and SQLite implementations behind one interface. SQLite follows existing Runner conventions: parent creation only for writable stores, `node:sqlite`, WAL, `BEGIN IMMEDIATE`, one atomic JSON record update, rollback on failure, and a true `readOnly` open that performs no schema/journal mutation.

The state graph is closed and validated on every mutation:

`prepared -> launching -> running -> stopping -> exited -> verifying_empty -> cleaned`

Typed failure/recovery states are `launch_not_proven`, `orphaned`, `identity_mismatch`, `backend_unavailable`, `outcome_unknown`, and `cleanup_blocked`. Illegal transitions throw before storage changes. `backend_unavailable` is deliberately recoverable only through explicit startup reconciliation when a durable opaque identity and birth fingerprint exist; a backend-unavailable record with no binding remains fail-closed. Other terminal exceptional states require later exceptional-recovery authority and are not silently retried.

Exact invocation ids are unique/idempotent. Re-creating the same invocation/run/logical identity returns the original record; conflicting identities reject. Historical reads clone state and never invoke a backend. The durable record excludes executable, arguments, working directory, environment values, grant material, native/live handles, and spill paths. It includes only invocation/run/task/session identity, requested capability names, name-only environment audit, backend opaque identity/birth/PID after binding, lifecycle, output disposition/artifact ids, cleanup proof/failure, and terminal result.

### `SubprocessRuntime`

The runtime composes the prior public seams in this exact order:

1. strictly parse invocation and validate the Task 1 one-call grant binding/state;
2. use Task 2 to create a one-use scrubbed environment capability and name-only audit;
3. persist `prepared`, then `launching`, before backend launch;
4. select a backend by verified semantic capabilities;
5. launch inside `withChildEnvironment`, keeping raw values call-scoped;
6. validate and atomically bind backend opaque identity plus birth fingerprint before `running`/started can be observed;
7. drain stdout/stderr through the Task 3 bounded spool;
8. apply a timeout/cancellation stop decision by moving to `stopping` and identity-bound termination before collecting exit;
9. persist `exited`, finalize bounded output, then persist `verifying_empty`;
10. require verified emptiness and successful backend release before `cleaned` is durable.

Verified-empty refusal or release failure produces `cleanup_blocked`; `cleaned` is never written first. Result precedence is launch failure, timeout/cancellation, cleanup failure, then child exit. Lossy output metadata is retained but never changes the process outcome.

`cancel()` reconstructs authority only from the durable opaque identity and birth fingerprint. Missing identity, a PID-only record, or a supplied observed birth discriminator that differs from durable birth all fail with `identity_mismatch` before `backend.signal` is called.

`reconcileStartup()` is the only automatic recovery entry point. It classifies pre-launch intent as `launch_not_proven`, launch-without-binding as `orphaned`, delegates identity-bound state to the original backend, persists `outcome_unknown`/`identity_mismatch` exactly, and for a proven exit runs verified-empty and release before cleanup.

## TDD evidence

All tests were created before the production modules. Initial exact RED:

```powershell
npx tsx --test runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts
```

Exit 1: all three files failed with `ERR_MODULE_NOT_FOUND` for the three intentionally absent Task 4 modules. This established that the wished-for public APIs and behaviors did not exist.

After the minimal modules were added, the first combined run had 12 passes and 2 failures. Both failures were test-fixture construction errors: already-running records were incorrectly passed through `createPrepared`. The stack traces terminated in the intended prepared-state validator. The fixtures were corrected to create `prepared`, transition to `launching`, and bind through the real store API. The rerun passed 14/14.

Additional focused RED/GREEN guards:

1. **Adversarial backend claim.** Added a test requiring accessor/proxy capability claims to be rejected without consulting getters/traps. Initial exit 1 (`Missing expected exception`); strict descriptor-copy parsing and proxy rejection made it green. Combined suite passed 15/15.
2. **Release-before-success ordering.** Added a backend release fault. Initial exit 1 because `release refused` escaped after a durable `cleaned` record. Moving release before the `cleaned` transition and mapping failure to `cleanup_blocked` made it green. Combined suite passed 16/16.
3. **Backend return after disappearance.** Strengthened disappearance coverage to require later explicit reconciliation. Initial exit 1 (`backend_unavailable` remained instead of `cleaned`). Making only identity-bound `backend_unavailable` state recoverable and re-running reconciliation through verify-empty/release made it green.

The final focused suite covers 19 behaviors, including durable-before-launch ordering, legal/illegal transitions, exact duplicate invocation, start failure, three restart crash points, timeout/cancel precedence, missing/bad identity, PID reuse, false claims, backend disappearance and return, deterministic lossy output, verified-empty failure, release cleanup blocker, restart reconciliation, outcome unknown, historical read-only observation, and durable value exclusions.

## Required post-implementation mutation checks

Both mutations used `apply_patch`, were run against their focused behavior test, and were reverted with `apply_patch` before final verification.

### PID-only signal authorization

Injected a cancellation branch that synthesized opaque/birth strings from a durable record containing only `rootPid`, directly called `backend.signal`, and returned success.

```powershell
npx tsx --test --test-name-pattern="missing identity and PID reuse" runner-v2/test/subprocess-runtime.test.ts
```

Mutated result: exit 1; the test reported `Missing expected rejection`, proving the forbidden PID-only signal was detected. After revert, the identical command exited 0 (1 passed).

### Success before verified-empty

Injected a `cleaned` transition immediately after `verifying_empty` and before `backend.verifyEmpty`.

```powershell
npx tsx --test --test-name-pattern="verified-empty failure blocks cleanup" runner-v2/test/subprocess-runtime.test.ts
```

Mutated result: exit 1 with `Illegal process transition cleaned -> cleanup_blocked`, proving premature success was observable and could not conceal the empty-verification failure. After revert, the identical command exited 0 (1 passed).

The accessor/proxy, release-order, and backend-return guards above also had direct pre-fix RED and post-fix GREEN evidence rather than passing immediately.

## Final verification

Fresh exact Task 4 command immediately before staging/commit:

```powershell
npx tsx --test runner-v2/test/process-backend-contract.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/durable-process-store.test.ts
```

Exit 0: 19 passed, 0 failed.

Fresh Task 1–4 seam/integration command:

```powershell
npx tsx --test runner-v2/test/execution-safety-contracts.test.ts runner-v2/test/child-environment.test.ts runner-v2/test/bounded-output-spool.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/artifact-store.test.ts
```

Exit 0: 84 passed, 0 failed. This exercises the Task 1 contract parser/grant, Task 2 scrubbed environment capability, Task 3 bounded output/artifact/cleanup behavior, and Task 4 composition together.

```powershell
npm run typecheck:runner-v2
```

Exit 0.

```powershell
npx eslint runner-v2/src/process-backend.ts runner-v2/src/durable-process-store.ts runner-v2/src/subprocess-runtime.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts
```

Exit 0 with no warnings or errors after removing one unused caught-error binding and one unused test type import.

`git diff --check` and `git diff --cached --check` exited 0. The staged diff was exactly six new Task 4 files, 808 insertions, with no unrelated modification.

## Durable-value and residue audit

Production search found no `process.platform`, native handle, child process, secret value, password, API key, or spill-path durability in the new modules. The only credential-named field is the caller-visible opaque `credentialGrantId` passed into Task 2; it is consumed before durable intent and never written to `DurableSubprocessRecord`. Executable, arguments, and working directory exist only inside the ephemeral Task 1 intent passed to the backend launch call.

The SQLite/read-only test writes external task-owned state under a system temporary directory, reopens it read-only, verifies mutation rejects, and byte-compares the database before/after historical observation. It also checks the durable JSON does not contain fixture secret values, native-handle fields, or a host spill path.

Post-test filesystem inspection:

- `NO_TASK_TEMP_RESIDUES` for `runner-v2-runtime-*` and `runner-v2-process-store-*` under the system temp directory.
- `NO_WORKTREE_SPILL_RESIDUES` for `*.tmp`, `*.owner.json`, and `.output-spool-owner.json` in the worktree.

No material files were deleted manually; test-owned temporary roots were registered with test cleanup and were absent afterward.

## Self-review and concerns

Self-review traced each interface named in the brief end to end: Task 1 invocation/grant and semantic capability types; Task 2 environment capability/audit; Task 3 spool write/finalize/cleanup result; ProcessBackend probe/launch/observe/signal/verify/reconcile/release; durable store create/transition/bind/read/list; runtime invoke/cancel/reconcile.

Mutation review checked wrong capability trust, missing durable intent, signal by PID, missing/bad birth, duplicate launch, launch error, output loss changing result, cleanup success before proof, release after success, backend loss made permanently terminal, and historical reads causing backend activity. Each is protected by at least one behavior test.

Intentional integration boundary: timeout/cancellation is represented as the runtime's already-decided `stopReason` input in this backend-neutral task. The runtime owns lifecycle ordering, identity-bound termination, precedence, observation, verification, and cleanup once that trigger is supplied. Later orchestration rewiring must source that trigger from its real deadline/cancellation controller and must route all existing child families through this runtime; Task 4 intentionally does not partially rewire any family or add an OS timer/adapter.

No unresolved test, typecheck, lint, residue, or diff failure remains. No production backend exists yet, by task design.

---

## Review round 1 repair — 2026-08-29

Review outcome `CHANGES REQUIRED` was addressed as a substantive replacement of the first Task 4 design. Repair commit: `b7a7dd37` (`fix(runner-v2): harden subprocess runtime authority`), based on the original Task 4 commit `b20d6b78`.

### Finding-by-finding changes

1. Invocation now accepts only an opaque grant id. A constructor-bound Runner-private authority atomically consumes it, and the runtime strictly snapshots a closed, immutable grant bound to grant/run/invocation/access/issued/expiry. Caller grant/result/stop labels, accessors, proxies, replay, expiry, and future-issued grants fail before launch.
2. Durable schema v2 is parsed as a closed, once-snapshotted per-state record with state/history/result/cleanup/binding invariants. Mutations are closed runtime-private commands obtained only through constructor authority and guarded by revision CAS. SQLite corruption fails closed on both read and reopen.
3. A SHA-256 canonical request fingerprint covers run/task/session, intent command/arguments/cwd, environment name decisions, capabilities, and grant binding without persisting request text or secret values. A secret-free retry key plus per-store coordination serializes exact invocations across runtime instances; SQLite uses `BEGIN IMMEDIATE` and revision CAS. Exact retries observe one operation; divergent retries conflict.
4. Probe, launch, observe, signal, verified-empty, reconcile, and release responses each have strict closed parsers that reject unknown keys, wrong types, accessors, and proxies after one snapshot. Malformed values map to launch-not-proven, unavailable/unknown, or cleanup-blocked rather than truthy success.
5. Durable bindings contain a unique registry id, backend id, attestation version/digest, opaque identity, and birth fingerprint. Probe attestations are immutable and re-probed for exact match before every signal, reconciliation, empty verification, and release authority decision.
6. AbortSignal/deadline decisions are runtime-owned with an injected deterministic clock/sleep seam. Stop intent is durable before effects. Interrupt, terminate, and force-terminate each persist `requested` before signaling and then persist the parsed result; restart resumes a pending requested escalation. Durable timeout/cancel precedence outranks later exit or cleanup failure.
7. Launch, cancellation, and state changes are serialized/CAS-safe. Cancellation during launch is durably queued and cannot signal until launch identity is bound; terminal cancellation is a read-only no-op; only active identity-bound states may signal after fresh attestation.
8. Reconciliation handles prepared, launching, active/stopping/unavailable, exited, and verifying states plus running/exited/mismatch/unknown backend outcomes. Each record is caught and classified independently so one output/backend failure does not abort later recovery.
9. Recoverable output ownership is prepared before launch and only its safe owner id and safe artifact/disposition values are durable. Restart reopens, drains, finalizes, verifies, releases, and classifies reopen/finalize/cleanup failures deterministically. The ordering test asserts preparation at the actual backend launch boundary.
10. The replacement adversarial suite covers forged authority/result inputs, strict durable rows, exact/divergent and cross-runtime SQLite concurrency, corruption/reopen, persisted-byte inspection, all backend parser traps, false claims/re-attestation replacement, deadlines/escalation/restart, terminal and launch-race cancellation, cleanup precedence, output recovery, reconciliation mapping, and per-record failure isolation.

### TDD and fault evidence

The durable-store replacement first failed because `canonicalRequestFingerprint` and closed runtime transitions did not exist; after implementation its seven tests passed. Backend contract replacement first failed on missing strict parsers and then exposed missing registry/backend binding; after the fix its five tests passed. Runtime replacement initially failed 10 of 11 tests against the old API/design; the rewritten runtime and subsequent guards reached 15 of 15 runtime tests and 27 of 27 exact Task 4 tests.

Additional restart escalation guard: the new `restart resumes an escalation whose durable request preceded a crash` test first failed with durable state `outcome_unknown` instead of `cleaned`; after teaching escalation to resume the already-requested action, the focused test passed.

Required and new authority mutations were applied and reverted with `apply_patch`:

- PID-only authority: `parseBinding` was mutated to replace the required opaque identity with a PID-derived constant. `--test-name-pattern="strict per-state parser"` failed with `Missing expected exception`; after revert the identical focused command passed 1/1.
- Premature success: `finish` was mutated to persist `cleaned` before `verifyEmpty`. `--test-name-pattern="malformed backend results"` failed with `Illegal process transition from cleaned`; after revert it passed 1/1.
- Caller authority bypass: the closed-key guard was mutated to accept arbitrary invocation fields. `--test-name-pattern="caller can provide only"` failed with `Missing expected rejection`; after revert it passed 1/1.
- Durable signal ordering was also observed directly in the deadline test: the backend signal callback asserts the latest durable escalation outcome is `requested` for each ladder action.

### Final verification

```powershell
npx tsx --test runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts
```

Exit 0: 27 passed, 0 failed.

```powershell
npx tsx --test runner-v2/test/execution-safety-contracts.test.ts runner-v2/test/child-environment.test.ts runner-v2/test/bounded-output-spool.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts
```

Exit 0: 89 passed, 0 failed across the Task 1–4 seams.

`npm run typecheck:runner-v2` exited 0. Targeted ESLint over the three Task 4 source and three test files exited 0. `git diff --check` exited 0; the only messages were the repository's expected Windows LF-to-CRLF notices. The committed repair is exactly those six Task 4 files: 498 insertions, 708 deletions.

### Persistence, cleanup, and self-review

The SQLite byte-level test inspects the actual persisted database after concurrent execution and rejects fixture secret values, alternate secret values, raw argument text, working directory, native-handle names, and spill paths. Temporary SQLite roots are created below the system temp directory and removed through test cleanup. Post-test worktree inspection found no SQLite, temporary, spill, owner-marker, or runner-state residue under `runner-v2`; no material file was manually deleted.

Self-review traced grant consume → environment preparation → safe fingerprint/prepare → output ownership → backend selection/launch binding → observation/stop escalation → finalize/verified-empty/release → durable result, plus every reconciliation entry state. It found and removed a fallback that synthesized a cleanup result using the system clock, preserving the injected deterministic clock and the rule that callers/runtime helpers cannot invent outcome labels. It also replaced a weak cross-array output-order assertion with a launch-boundary assertion.

No production OS adapter, isolation provider, existing child-family wiring, or later-task behavior was added. Remaining integration is intentionally outside Task 4: later work must construct the private grant authority and connect existing child families to this backend-neutral runtime. No unresolved focused test, seam test, typecheck, lint, diff, or residue concern remains.

---

## Review round 2 repair — 2026-08-29

Round-2 repair commit: `c5cb2e3a` (`fix(runner-v2): authenticate subprocess runtime state`), following round-1 commit `b7a7dd37`.

### Seven finding clusters

1. Public authority-bearing constructors were removed. `createSubprocessRuntimeKernel`, `createInMemoryDurableProcessKernel`, `openSqliteDurableProcessKernel`, and `createProcessBackendRegistry` create concrete frozen capabilities validated by module-private WeakSet/WeakMap brands. Structural lookalikes fail synchronously. Runtime dependencies and their methods are snapshotted/bound at kernel creation; invocation intent, argument/capability arrays, environments, grants, and dates are copied and deeply frozen before use. The backend observes the immutable snapshot even if the caller mutates nested arrays immediately after `invoke`.
2. Durable records now cross-check history origin, legal transitions, history length against revision, current state, binding, observation, stop intent, ordered escalation, output, cleanup, and terminal result/exit/start/precedence. SQLite rows carry keyed HMAC-SHA-256 integrity over row id, revision, and canonical stored JSON. The Runner state key is copied into private store state, never persisted. A syntactically valid owner edit fails closed on reopen; semantically inconsistent terminal objects fail the closed parser independently.
3. Request identity is a keyed HMAC over the complete snapshotted intent, ambient and explicit environment names and values, credential/grant ids, private grant-binding digest, capability order, deadline, and initial cancellation semantics. No plaintext request values are durable and an alternate key yields a different digest, preventing unkeyed dictionary comparison. `invoke` performs a synchronous SQLite/in-memory owner lease and output-owner claim before its first await, grant consume, environment preparation, probe, or output prepare. Exact losers observe the durable winner; divergent losers conflict before grant/output effects. The process-local shared-inflight map was removed.
4. Backend registries are branded immutable snapshots. Entries require a stable Runner-trusted implementation generation; the snapshot binds original method functions, generation, and implementation digest. Array entry replacement or method replacement cannot change authority. Durable bindings contain generation/digest, every operation revalidates them, and release uses the exact freshly returned selected implementation instead of a stale earlier reference.
5. A claimed `prepared` row exists before `invoke` returns, so an immediate `cancel` persists stop intent even while output preparation waits. Prepared/launching stops remain queued through launch binding. Recovery of `backend_unavailable` plus an existing stop explicitly transitions back to `stopping` before resuming the durable escalation ladder.
6. Stores enumerate raw row ids without decoding. Startup recovery authenticates/decodes each row inside its own catch, reports `corrupt` for that row, and continues later ids. The table-driven recovery test covers prepared, launching, exited, verifying-empty, and each of running/stopping/backend-unavailable crossed with running, exited, identity-mismatch, outcome-unknown, and malformed backend reconciliation values (19 cases), plus independent failure isolation.
7. The winning durable claim contains the output owner before output allocation. Only afterward does the runtime call idempotent `prepare(ownerId)`. Prepare failure is a durable `cleanup_blocked` result without grant consumption. Recovery of a crash between claim and prepare calls `prepare` again by the same owner id; already-prepared rows use `reopen`, then finalize/verify/release/cleanup.

### RED/GREEN and mutation evidence

The first branded-registry tests failed because `createProcessBackendRegistry` did not exist. Store-kernel/fingerprint tests likewise failed against the public authority constructors and unkeyed fingerprint API. The unavailable-with-stop direct repro initially completed recovery without any signal (`actual []`, expected `signal:interrupt`); after the state re-entry fix it passed. The crash-before-output recovery assertion initially saw no second `prepare` call; after recovery began selecting prepare versus reopen from durable output state it passed. Invalid-grant recovery initially left state `prepared`; after durable classification and output cleanup it passed as `launch_not_proven`.

Required and new guard faults were applied and reverted with `apply_patch`:

- PID-only: the binding parser replaced the required opaque identity with a PID-only constant. The corrected strict parser fixture failed with `Missing expected exception`; restored code passed 1/1.
- Premature cleanup: `finish` wrote `cleaned` before verified-empty. The malformed verification guard failed with `Illegal process transition from cleaned`; restored code passed 1/1.
- HMAC bypass: SQLite read skipped integrity comparison. A syntactically valid forged-owner edit was accepted and the test failed with `Missing expected exception`; restored code passed 1/1.
- CAS winner bypass: the losing SQLite claim was mutated to return `won:true`. The separate-runtime contender test failed when the loser attempted a second grant consume (`Execution grant is invalid`); restored code passed 1/1 with one grant consume and one output prepare.
- Registry snapshot bypass: the trusted snapshot retained the caller backend object instead of bound method functions. Replacing `probe` made selection fail, and the immutable-registry guard went RED; restored code passed 1/1.

### Final verification and residue

Exact Task 4 command (`process-backend-contract`, `durable-process-store`, `subprocess-runtime`) exited 0: 35 passed, 0 failed. Task 1–4 seam command (`execution-safety-contracts`, `child-environment`, `bounded-output-spool`, and the three Task 4 files) exited 0: 97 passed, 0 failed. `npm run typecheck:runner-v2` exited 0. Targeted ESLint over all six changed source/test files exited 0 with no warnings. `git diff --check` exited 0 apart from expected Windows LF-to-CRLF notices.

SQLite byte inspection again found no secret environment values, arguments, cwd, live handles, spill paths, or integrity key. System-temp SQLite roots were test-cleaned. Worktree inspection found no SQLite, spill, owner-marker, temp, or runner-state residue under `runner-v2`; no material files were manually removed.

Self-review traced the synchronous claim boundary, winner/loser paths, immediate cancellation, every state command and invariant, HMAC verification, implementation generation across restart, fresh-instance effect calls, output prepare/reopen paths, and per-row reconciliation. It found and fixed one additional prepared-row escalation invariant that could otherwise accept a stopped prepared row with a syntactically complete escalation entry. No production OS adapter, isolation provider, existing-family rewiring, or Task 5+ work was added. No unresolved verification or residue concern remains.

---

## Review round 3 repair — 2026-08-29

Round-3 was implemented from round-2 commit `c5cb2e3a`. Repair commit: `ba5eeead` (`fix(runner-v2): seal subprocess runtime kernel`).

### Findings and decisions

1. `createSubprocessRuntimeKernel` now owns the state store, per-instance grant vault, copied state key, writer capability, and runtime lease owner. It returns a frozen `{runtime, grantsController, readOnlyStore}`. Caller grant/store callbacks and the exported writer accessor were removed. The controller affects only its kernel. Factory/invocation/grant inputs reject unknown fields, accessors, and proxies; intent arrays, nested environments, dates, grants, and the complete backend launch request are snapshotted/frozen.
2. Durable parsing requires prepared history origin, legal edges, `history.length === revision + 1`, current history/state agreement, output ownership from launching through terminal states, and consistent binding/observation/stop/escalation/output/result/cleanup. Output-prepare failure exists only in a recoverable unprepared row. HMAC remains mandatory.
3. The keyed semantic fingerprint distinguishes absent/present AbortSignal, initial abort, exact deadline, complete intent/environment/grant/capability semantics, without persisting plaintext. Initial claim durably owns lease/output identifiers. Lease renewal/takeover commands are revision-CAS guarded; a live lease is not stolen and an expired pre-effect claim is recovered. A real two-Node-process fixture races independent SQLite connections and proves one output prepare, one grant consume, and one outcome.
4. Backend implementations use module-branded registrations, a fresh immutable runtime generation, and bound exact methods. Normal reattestation requires exact generation/object snapshot. Explicit restart adoption accepts only a newly branded trusted adapter with the stable code/config-derived digest and persists `adopt_backend` without changing process identity before effects.
5. Output prepare failure stays prepared/discoverable, expires its lease, and consumes no grant. Startup retries the same owner id, cleans it, and settles `launch_not_proven`.
6. Writable SQLite open sets a busy timeout and transactionally creates/inspects/alters legacy schema. Old unsigned rows remain corrupt while new signed writes work. Read-only legacy inspection neither migrates nor mutates.

### RED/GREEN and fault evidence

New direct regressions cover signal-presence fingerprinting, terminal `outputPrepared:false`, scoped grants, top-level launch freeze, exact-instance reattestation/adoption, live/expired leases, real OS-process contention, recoverable output prepare, writable/read-only migration, and corrupt-row continuation.

Every required fault was applied with `apply_patch`, observed RED, reverted, and rerun GREEN:

- PID-only/fresh-identity bypass changed signal authority to ordinary selection. The fresh-attestation cancellation guard failed (`actual true`, expected `false`); restored run passed 1/1.
- Premature cleanup fabricated `{empty:true}` instead of calling `verifyEmpty`. The malformed-verification guard failed (`actual exited`, expected `cleanup_failed`); restored run passed 1/1.
- Shared grant authority made grant values/digests global. The cross-kernel test failed with `Missing expected rejection`; restored run passed 1/1.
- HMAC bypass disabled integrity comparison. Corruption/reopen failed with `Missing expected exception`; restored run passed 1/1.
- CAS bypass forced an exact retry to win. The SQLite contender failed on an illegal duplicate transition; restored run passed 1/1.
- Registry bypass matched normal reattestation by backend id alone. The copied-instance guard failed with `Missing expected rejection`; restored run passed 1/1.
- Migration bypass skipped writable migration. Legacy claim failed with `no column named integrity`; restored run passed 1/1.

### Final verification

`node --import tsx --test runner-v2/test/durable-process-store.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/subprocess-runtime.test.ts` exited 0: 40 passed, 0 failed, including the separate-process fixture.

`npm run test:runner-v2` exited 0: 902 passed, 0 failed, followed by PASS for every Runner client/native Build policy, UI, cutover, pause, usage, live-state, transcript, files, stats, steering, and observability script.

`npx tsc -p runner-v2/tsconfig.json --noEmit` and targeted ESLint over the three source files, three test files, and contender fixture exited 0 with no diagnostics. `git diff --check` exited 0 apart from expected Windows LF/CRLF notices.

### Persistence, cleanup, self-review, concerns

The persisted-byte regression inspects SQLite for environment secrets/variants, raw arguments, cwd, native handles, and spill paths. Keys are not durable. Raw ids are enumerated before independent decode, so corrupt-first/valid-second recovery continues. Tests used system-temp task roots with registered cleanup; worktree inspection found no SQLite/WAL/SHM, spill, owner-marker, or temp residue. No material file was manually deleted.

Self-review traced issue/revoke/consume, synchronous claim, immediate cancellation, output retry, environment audit, selection/binding, deadline escalation, exact reattestation, restart adoption, observation, finalization, verified-empty, release, terminal result, lease takeover, per-row reconciliation, and old-schema open. No production OS adapter, isolation provider, existing-family rewiring, or Task 5+ behavior was added. The large textual diff is primarily Prettier expanding previously compressed Task 4 files; focused semantic review and the full 902-test suite found no unrelated behavior change. No unresolved implementation, verification, residue, or scope concern remains.

---

## Review round 4 escalation fixes — 2026-08-29

Round 4 was escalated from base `ba5eeead`. The implementation fix is commit `8ef96221` (`fix(runner-v2): fence durable subprocess effects`). Work remained limited to the Task 4 backend/store/runtime seam and its tests; no Task 5+ integration or production adapter was added.

### Finding-by-finding correction

1. The runtime authority root is now a frozen, null-prototype closure facade. Its only own keys are `invoke`, `cancel`, and `reconcileStartup`; descriptors are non-writable/non-configurable, and there is no prototype traversal. The implementation object, writer, store authority, grant vault, state key, registry snapshot, and options remain closure-only. Serialization and inspection expose no hidden authority. Each factory call still creates an independently scoped controller/vault.
2. Every durable process row now contains a closed, HMAC-protected mutation log, and replay of that log is the sole authority for its projection. The initial `prepared` mutation carries every initial fact. Each later mutation has an exact kind, revision, owner, fencing token, timestamp, and strictly keyed payload. Replay validates revision continuity, legal state edges, exact mutation/state combinations, and derives history, output preparation/failure, environment audit, lease/owner, stop intent, backend binding/adoption, observation, escalation, result, output disposition, and cleanup. The supplied row projection must canonical-byte-match the replayed projection. Adversarial duplicate-prepared, contradictory prepared, and terminal combinations fail closed even when syntactically valid.
3. Claims start at fencing token 1 and every lease takeover increments it monotonically. Every mutation requires the runtime's fixed owner plus its cached token, so a stale owner cannot regain authority by rereading a newer revision. Output and backend operations receive an immutable `{ownerId, fencingToken}` fence; the runtime validates it before and after every awaited effect. A real timer heartbeat renews the lease for the duration of blocked output, backend, and clock effects. A live lease cannot be stolen; expiry takeover is confined to pre-effect-safe prepared records. Launching/active ambiguity is reconciled and never relaunched. Deterministic and real SQLite contention tests cover heartbeat, live non-steal, expiry takeover, one pre-effect winner, and rejection of a stale effect after takeover.
4. Failed output-owner cleanup persists as `cleanup_blocked` with failed cleanup and a launch-failed result. Recovery reopens/prepares the same owner and retries cleanup. Only successful owner cleanup may append `settle_output_cleanup` and derive `launch_not_proven` with `not_required`; cleanup failure can no longer erase a possibly live owner.
5. Writable SQLite construction sets `busy_timeout` before journal/schema work. WAL/schema initialization runs in a bounded eight-attempt loop which retries only SQLite lock/busy failures with bounded synchronous backoff, rolls back only a begun transaction, and closes the database if initialization ultimately fails. A separate-OS-process regression holds an exclusive schema lock beyond the initial busy timeout, releases it, and verifies both contenders initialize safely with one durable winner.

### TDD RED evidence

New regressions were run before their implementation and failed for the intended reason:

- Runtime privacy enumerated `options`, `writer`, registry/fence state and other implementation properties instead of only the three intended methods.
- Durable authority tests found no mutation log and an undefined fencing token.
- Fence propagation observed an undefined launch fence.
- Output cleanup recovery settled `launch_not_proven` instead of retaining `cleanup_blocked`.
- The blocked-output contention test allowed the second owner to take over instead of returning the live lease.
- The real separate-process initialization test failed at `PRAGMA journal_mode = WAL` with `database is locked`.

After the smallest complete store/runtime/backend corrections, the new cases and all earlier Task 4 guards passed.

### Required RED/revert/GREEN fault injections

Each fault was applied with `apply_patch`, the exact covering test was observed RED, the fault was reverted, and the same test was observed GREEN:

- PID-only/fresh-identity authority replaced escalation reattestation with ordinary selection. The fresh-attestation cancel guard failed (`actual true`, expected `false`).
- Premature cleanup replaced `verifyEmpty` with a fabricated `{empty:true}` result. The malformed backend guard returned `exited` instead of `cleanup_failed`.
- Private authority returned the internal runtime object rather than the facade. The privacy guard enumerated writer/options/fences and failed.
- Mutation-log bypass disabled projection/replay comparison. The closed-mutation guard accepted a contradictory row and failed with a missing exception.
- HMAC bypass forced integrity comparison to succeed. A coherent forged-owner edit to both projection and prepared mutation was accepted and the integrity guard failed with a missing exception.
- Heartbeat bypass disabled lease renewal during an awaited output effect. The live-owner guard observed an illegal takeover.
- Stale-fence bypass removed owner/token validation and restamped the current fence. The stale-owner guard failed with a missing exception after takeover and reread.
- Cleanup-settlement bypass wrote `fail_launch/not_required` after cleanup failure. The recovery guard observed `launch_not_proven` instead of `cleanup_blocked`.
- SQLite retry bypass reduced initialization to one attempt. The genuine separate-process lock test failed with `database is locked`.

### Final verification

```powershell
node --import tsx --test runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts
```

Exit 0: 47 passed, 0 failed.

```powershell
node --import tsx --test runner-v2/test/execution-safety-contracts.test.ts runner-v2/test/child-environment.test.ts runner-v2/test/bounded-output-spool.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts
```

Exit 0: 109 passed, 0 failed across the Task 1–4 seam.

`npx tsc -p runner-v2/tsconfig.json --noEmit`, targeted ESLint over the Task 4 source/tests, and targeted Prettier check all exited 0. `git diff --check` and the staged equivalent exited 0 apart from the repository's expected Windows LF/CRLF notices. The implementation commit changes exactly six Task 4 files: 1,671 insertions and 516 deletions.

```powershell
npm run test:runner-v2
```

Exit 0: 909 passed, 0 failed, followed by PASS for Runner V2 client, every native Build policy/UI/cutover/pause/model-usage/live-state/transcript/files/stats/steering contract, and the observability panel.

### Persistence, cleanup, and self-review

The persisted-byte tests inspect actual SQLite bytes and continue to reject secrets, arguments, working directories, native handles, spill paths, and integrity-key material. The final worktree audit found no SQLite/WAL/SHM file, temp file, spill owner marker, or output-owner marker under `runner-v2`. The process audit found no live SQLite contender or Task 4 test process. Iterative RED runs and intentional unresolved-effect recovery tests had left 15 uniquely named Task 4 roots below the system temp directory; their resolved paths were verified below the system temp root, those test-only directories were removed, and the repeated audit found zero matching roots. No project or user material was removed.

Self-review traced claim/retry/takeover, mutation creation and replay, HMAC verification, stale revision plus stale owner/token rejection, every awaited external effect, launch ambiguity, restart adoption, output-owner recovery, terminal cleanup, and concurrent schema initialization. It also checked facade keys, symbols, descriptors, prototype, inspection, serialization, and cross-kernel isolation. The large durable-store diff is necessary because row facts are now derived rather than independently trusted; the closed replay table and adversarial combinations are the central regression boundary. No unresolved test, lint, type, diff, process, persistence, cleanup, or scope concern remains.
