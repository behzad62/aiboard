# C2a — Docs policy v2 kernel path (STATE.md only) — evidence

Date: 2026-09-27. Worker: Muse Code (lane A, implementation worker brief).
Base: `278fd627` (`feat(runner-v2): P6.6 C1 handoff snapshot renderer`).
Branch `codex/runner-v2-p6-6`. Nothing committed, staged, stashed or pushed
(all changes uncommitted, verified with `git status --short`).

Packet: plan C2 steps 1-4 and 7 (reducer v2, kernel-commit method,
`project_docs.handoff_snapshot_committed`, the gate with STATE.md, answered
runs). Steps 5, 6 and 8 are C2b (AGENTS.md/CLAUDE.md/spec copy, run options,
hand-edit detection). Controller decision CD-13.

Requirements owned: AR-R03 (v2 reducer, additive; v1 replays), AR-R04 (C2a
form: kernel commits STATE.md, runner identity, `AIBoard-Generated:
handoff-snapshot` trailer, new additive event, v2 document tip), AR-R05 (C2a
form: v2 gate on `project.handoff_selected` / `run.completed`, no
model-written STATE.md under v2, failed commit pauses with
`handoff_snapshot_failed` and retries), AR-R06 (answered v2 runs: nothing
written, completion unaffected).

## Changed files (CRLF, no BOM, no encoding-only hunks)

| File | sha256 | Bytes |
|---|---|---|
| `runner-v2/src/scheduler-store.ts` | `cbb8d9a95819e76108612f59b270c6f51b3f9b1555a65b2ee581586f3401a566` | 408998 |
| `runner-v2/src/build-runtime.ts` | `d224f1499a45b84a5d690543cb04848f8aee991a5ef7d8cb6b464c60f545f293` | 167695 |
| `runner-v2/src/integration-manager.ts` | `7296e321ba36a171f3a27d6c744aa819d10ab80c1d5d91b59025300c5e263daf` | 72744 |
| `runner-v2/src/native-build-factory.ts` | `e2748983ece02bd72c4f211692583f60894008822f7718d5367c923d5b124f7f` | 158280 |
| `runner-v2/test/docs-policy-v2-handoff.test.ts` | `0ef5a0a98e9df8124dff1b5387a115e6cb43ca0719be2f1e92c8fa5f4dbb3b1d` | 38951 |
| `runner-v2/test/build-runtime.test.ts` | `cb14b8db23baff8b9baa283c96c59156431bab837793c9ac885e66b04870e20e` | 89162 |
| `runner-v2/test/project-doc-commit.test.ts` | `8ace2326c6c0901f1c6bbc4aaee97e215d97926452c2ca3f174d6c8a951a4693` | 55042 |
| `runner-v2/test/request-triage.test.ts` | `b804bb3d7bb4c7b16c6d9932cc72f8f74886c31d02d8fc863d06034a95d785ff` | 178958 |
| `.superpowers/.../evidence/C2a.md` | (this file) | — |

Hashes measured with node crypto after the final source edit (only this
evidence file was written afterwards). `git diff --check` is clean; every
touched file keeps its pre-existing convention (CRLF for the eight files
above; the pre-existing LF-only `request-triage.test.ts` stays LF with an
LF-only addition). No non-ASCII characters added or changed; no BOM.
Pre-existing working-tree modifications not mine (controller CD-13 note):
`progress.md` and the AR plan doc — untouched by this packet.

Forbidden files touched: none (`agent-prompts.ts`, `architect-tools.ts`,
`planning-tools.ts`, `planning-contracts.ts`, UI/client, package files,
`progress.md`, `AGENTS.md`/`CLAUDE.md`/spec-copy logic). `configureProjectDocsPolicy`
(`build-runtime.ts`) is byte-identical: production still stamps docs v1
(proven by the existing stamp test, still green). `handoff-snapshot.ts` was
not modified (no adapter change needed). `project-docs.ts` was not modified.

## Design choices

- Commit method: `IntegrationManager.commitHandoffSnapshot` sits next to
  `commitProjectDocuments`, which is byte-for-byte unchanged. One commit per
  call with the `RUNNER_IDENTITY` env (`AIBoard Integrator`), trailers
  `AIBoard-Run`, `AIBoard-Author: runner`, `AIBoard-Generated:
  handoff-snapshot`, `AIBoard-Snapshot-Key: <key>`, then `--` plus the
  written paths. Same failure cleanup (`reset --hard`, `clean -fd`) as the
  Architect path.
- Event shape: `project_docs.handoff_snapshot_committed`, actor
  `{role:"runner",id:"build-runtime"}`, payload `{stopSequence, stopKind
  ("completed"|"plan_only"), revision, commit, parent, head, bodyDigest
  (64-hex sha256), paths}`. The reducer requires `docs/project/STATE.md` in
  `paths`; the writer is the only producer and always includes exactly that
  file in C2a.
- Idempotency key: `handoff-snapshot:<stopSequence>` — the stop event is
  `project.handoff_requested`, deterministic, no timestamps. The same string
  is the `AIBoard-Snapshot-Key` trailer, so `findSnapshotCommit` (mirroring
  `findDocumentCommit`) returns the existing commit when a crash lands
  between the commit and the event append: one commit, one event. The store
  additionally dedupes the event by idempotency key.
- Tip handling (CD-11): the event branch moves `projectDocs.documentTip`
  with the same strict-continuation rule as `project_doc.committed`
  (parent equals the canonical integration revision or the current tip).
  `latestIntegratedTaskSequence` bookkeeping (previously v1-gated) now also
  runs under v2; it is behavior-neutral for v2 today (the v2 gate does not
  read it) and keeps the invariant for C3. Plan-only snapshots have no
  canonical revision, so the tip stays unset there; the plan-only gate does
  not need it.
- Gate: `assertHandoffSnapshotGate(projection, revision)` is called in the
  `run.completed` branch (after readiness, so existing error precedence is
  unchanged) and in the `project.handoff_selected` branch (after the
  revision-match refusal). It returns immediately for answered runs and for
  any non-v2 policy. For `plan_only` (or an undefined revision) it requires
  any recorded snapshot holding STATE.md; otherwise it requires a snapshot
  whose `revision`, `commit` or `head` equals the handed-off revision.
  Production selects the integration manager's current revision, which is
  the post-snapshot head after the kernel commit — hence the commit/head
  match (CD-11: `project.handoff_selected` accepts the post-snapshot head
  through the moved tip plus this gate).
- Failure/retry: a failed render/digest/port/commit pauses with
  `run.paused {reason:"handoff_snapshot_failed"}` (same idempotency key per
  stop, so retries do not spam the log) and the step returns
  `paused/handoff_snapshot_failed`. `resume` is exempted from the
  handoff-requested guard only for that reason; the snapshot branch clears
  the pause reason on success. The check runs at the top of `dispatchStep`,
  so the first post-handoff step, every resume, and every crash recovery
  funnel through the same path. No model call anywhere in it.
- Readiness: `projectDocumentationReadiness` already returns `[]` for any
  policy other than 1, so `complete_run` under v2 needs no model-written
  STATE.md with no behavior change for v1 (one clarifying comment added).
- The snapshot event is allowed through the pending-guidance and blocking-
  question gates like `project_doc.committed` (runner kernel bookkeeping).

## Suites with counts (all green unless noted)

New: `runner-v2/test/docs-policy-v2-handoff.test.ts` — 8 tests, all pass
(real SQLite, advancing clock, real git; factory test through
NativeBuildFactory + BuildRuntime.step):

1. Factory plan-only v2 to handoff: exactly one kernel commit holding only
   `docs/project/STATE.md`, the event, runner identity, all three trailers
   plus `AIBoard-Run`, no model call for the snapshot step (Architect calls
   stay 1), the STATE.md body verifies with
   `verifyHandoffSnapshotDigest`, holds the plan view (`## Plan (ready)`,
   P1/T1/REQ-1) and the `complete_run` summary; `project.handoff_selected`
   refused before the event through the production API; production-style
   selection of the post-snapshot head completes the run.
2. Commit failure pauses `handoff_snapshot_failed` (no commit, no event),
   resume retries and succeeds, the failure pause clears, one commit, then
   selection completes.
3. Crash between commit and event: manual pre-commit with the same key and
   the deterministically rendered body, then the pump step appends the event
   with zero new commits (rev-list count 1) and the stored body is byte-equal.
4. Tip + gate: seeded canonical revision equal to the real baseline, so the
   snapshot moves `documentTip` to the kernel commit; refusal before the
   event for the handed-off revision; success after.
5. Answered v2: completion turn, no snapshot step, no port call, no event,
   selection completes, rev-list count stays 0.
6. Seeded v1 plan-only: readiness names the missing STATE.md before the
   model commit and is clean after it (v1 path byte-identical).
7. `run.completed` refused before the event (also covers the
   `handoff_snapshot_failed` pause clearing and snapshot recording at the
   reducer level) and accepted after.
8. Gate unit matrix: revision/commit/head match, unrelated revision refused,
   missing STATE.md refused, plan-only existence rule, v1 skip, answered
   exemption.

Existing suites re-run on the same code (counts are tests/pass, 0 fail):

- `replay-compatibility.test.ts` + `project-docs.test.ts` +
  `handoff-snapshot.test.ts`: 72 pass (v1 fixture log replays unchanged).
- `scheduler-store.test.ts`: 31 pass.
- `build-runtime.test.ts`: 28 pass.
- `project-doc-commit.test.ts`: 16 pass.
- `integration-manager.test.ts`: 37 pass.
- `request-triage.test.ts` + `architect-tools.test.ts`: 36 pass.
- `native-delivery-factory.test.ts`: factory importer of the changed wiring,
  run in the background; result recorded below.
- `native-build-manager.test.ts`: 58 pass. `control-server.test.ts`: 14 pass
  (handoff-selection path importer).
- `t6b-repair-scaled-limit-replay.test.ts` +
  `windows-job-output-replay.test.ts`: 7 pass (replay-adjacent).
- `runner-v2` tsc (`tsc -p runner-v2/tsconfig.json --noEmit`): clean.
- eslint on all eight changed files: clean.
- `git diff --check`: clean.

## Prove-red record

- `runner-v2/src/scheduler-store.ts` sha256 before disabling the gate:
  `91aeac6749795fb6b38cfe9f4d3eae7b0853aeb0a0c24d054b86d844385c4201`.
- Disabled the v2 gate (`assertHandoffSnapshotGate` call in `run.completed`
  replaced with a no-op): `run.completed` without the event succeeded and
  the test `C2a: run.completed is refused before the kernel event and
  accepted after it` went red (`Missing expected exception` at the refusal
  assertion).
- Restored the line; sha256 after:
  `91aeac6749795fb6b38cfe9f4d3eae7b0853aeb0a0c24d054b86d844385c4201`
  (byte-exact restore). The full new suite re-ran green after the restore.

## Not done / limits

- C2b owns the AGENTS.md v2 section, the `@AGENTS.md` CLAUDE.md line, the
  spec copy, run options (`specCopy`, `handoffFiles`), hand-edit detection,
  and the full AR-R05 tree check (the reducer checks recorded `paths`; the
  writer guarantees the tree).
- A post-snapshot task integration before selection (only reachable via
  guidance withdrawal + re-request, since handoff blocks resume) mints a new
  stop sequence and a fresh snapshot; the stale record remains but no longer
  matches. A re-request for an unchanged revision mints a fresh commit
  rather than reusing the prior one.
- `run.paused handoff_snapshot_failed` under a pending user-guidance gate
  behaves like the pre-existing runner pauses (refused until acknowledged);
  the handoff-withdrawal path already returns the run to the Architect.
- Full-repo suite was not run (time); the packet suites, the named importer
  suites above, tsc, eslint and `git diff --check` are the validation gate.

## Controller run (cycle 0)

`runner-v2/test/native-delivery-factory.test.ts` (the suite the worker did not finish): 17 tests, 17 pass, 0 fail, 1,583 s, on the cycle-0 code.
## Repair cycle 1

Date: 2026-09-27. Worker: Muse Code (lane A, repair cycle 1).
Review input: `evidence/C2a-review-r1.md` (verdict REPAIR, 4 blocking + 9 minor).
Base `278fd627`, branch `codex/runner-v2-p6-6`. Nothing committed, staged,
stashed or pushed (all changes uncommitted; `git status --short` shows only
the files below plus the pre-existing controller-owned `progress.md` and AR
plan doc, both untouched). Real SQLite, real git, real pump throughout;
every suite below was run by the worker with `NODE_TEST_CONTEXT` cleared.

### Per-finding changes and proving tests

- B1 (production wiring): `runner-v2/src/build-runtime.ts:2730`
  (`afterArchitect` is now async and commits the kernel snapshot in the same
  step that recorded `project.handoff_requested`, before returning `paused`;
  the top-of-`dispatchStep` check at `:953` stays as the resume-retry/crash-
  recovery backstop). Manager gate-first: `runner-v2/src/native-build-manager.ts:574`
  (`selectProjectHandoffInsideActivity` calls `assertHandoffSnapshotGate`
  before `handle.projectHandoff`, so a failed snapshot never leaves a
  mutated project; the automatic finish/budgeted handoff at `:849-868` goes
  through the same check). Factory wires the new read-back:
  `runner-v2/src/native-build-factory.ts:1693`. Proved by
  `C2a B1: production-manager plan-only run ...` (full factory +
  production `NativeBuildManager`: create -> activate -> awaitIdle ->
  selectProjectHandoff, no manual `runtime.step()`; one snapshot event with
  the owner's selection succeeding), `C2a B1+M6: production-manager finish
  run ...` (automatic handoff applies after the snapshot; order asserted),
  and `C2a B1: with the snapshot commit forced to fail, the project is not
  mutated` (99 forced failures; `physicalHandoffs === 0`, no
  `docs/project/STATE.md` in the project, pump parks at
  `automatic_project_handoff_failed`, owner selection refused).
- B2 (retry returns to the handoff wait): `runner-v2/src/scheduler-store.ts:9182`
  (`applyHandoffSnapshotCommitted` restores `paused` when the snapshot lands
  on a `running` run, i.e. after resume). Proved by `C2a B2+M4`: fail ->
  resume -> retry succeeds -> status `paused` with handoff `requested` and
  no pause reason -> a further pump makes no model call (Architect calls
  stay 1) -> owner selection completes.
- B3 (per-attempt failure key): `runner-v2/src/build-runtime.ts:2090`
  (key `handoff-snapshot-failed:<stop>:<lastSequence>`, like
  `answer-paused:`). Proved by `C2a B3`: two consecutive failures with a
  resume between them append two `run.paused` events with different keys,
  the next resume retries, the third attempt succeeds and selection
  completes.
- B4 (snapshot describes the stop; reuse verifies the tree):
  `runner-v2/src/build-runtime.ts:1988` renders from the projection rebuilt
  from events up to and including the stop event; `runner-v2/src/build-runtime.ts:2040`
  reads `commit:docs/project/STATE.md` back through the new
  `ProjectDocsPort.readHandoffSnapshotFile` (`:416`) and records THAT digest
  with the commit's real paths. `runner-v2/src/integration-manager.ts:698`
  implements the read through the audited git path. Proved by `C2a B4`
  (commit lands, read fails, retry reuses the one commit; the event
  `bodyDigest` equals the committed file's header digest) and the crash test
  (pre-committed stop body reused byte-equal, one commit one event).
- M1: `runner-v2/src/scheduler-store.ts:420` (`requestedSequence` on
  `projectHandoff`, recorded at `:5023`) and `:9073`
  (`handoffSnapshotAtCurrentStop` binds the gate to the latest request).
  Proved by `C2a M1` (stop-1 snapshot + withdrawal + stop-2 request:
  selection refused until the stop-2 snapshot lands) and the extended gate
  unit matrix.
- M2: `runner-v2/src/handoff-snapshot.ts:228` (`HandoffSnapshotFacts.revision`)
  and `:1281` (facts revision wins over the absent integration revision),
  passed from the runtime at `build-runtime.ts:2011`. The plan-only and
  finish tests assert the committed header carries the recorded revision
  (`revision: revision_value` / the baseline), not "not recorded".
- M3: `runner-v2/src/integration-manager.ts:1881` (`findSnapshotCommit`
  requires `AIBoard-Run`, `AIBoard-Author: runner`, `AIBoard-Generated:
  handoff-snapshot` and the key line; run id threaded from `:638`). Proved
  by `C2a M3` (key-only foreign commit is not reused; the full-trailer
  commit is; the read-back returns its bytes and paths).
- M4: `runner-v2/src/build-runtime.ts:407` (`snapshotFailureDetail`:
  message only, single-lined, 300 chars) plus the `detail` carry-through in
  the `run.paused` reducer at `runner-v2/src/scheduler-store.ts:4957`.
  The B2 test asserts a non-empty single-line detail of at most 300 chars.
- M5: fixed by the B4 stop-projection render (a later pause never enters
  STATE.md); covered by the B2/B4 tests.
- M6: tests as above; CD-11 tip coverage on a finish (non-plan-only) run is
  in `C2a B1+M6` (tip moves to the kernel commit; the post-snapshot head is
  selected through it) plus the finish-style tip test.
- M8: `runner-v2/src/native-build-factory.ts:3751` (the path-only `at`
  helper now passes `execute: unavailableGitRunner` explicitly, imported at
  `:5`). All three `*-audit` suites are green, including the previously
  failing `git-caller-audit` case from HEAD.

### Changed files (sha256, measured after the final edit)

- `runner-v2/src/scheduler-store.ts` `2609d5d5e7811aa6050a2182ef9a4327df2912cbfa0ab0ea1fc0767fe5f367e7` (410344 bytes, CRLF)
- `runner-v2/src/build-runtime.ts` `e6a7a75624f5f6dcb65969598a71f0b47019e66f2ef0caf2a37cd560f5fdc370` (171348 bytes, CRLF)
- `runner-v2/src/integration-manager.ts` `bd0c853792e89179164fca3db43f3f19ef71aef559a2184a04c3a0b9b0f9af45` (74667 bytes, CRLF)
- `runner-v2/src/native-build-factory.ts` `cb5dfba81919e9a88c3762164aad07e167b5e8d15f75683c645d992611e3470a` (158624 bytes, CRLF)
- `runner-v2/src/native-build-manager.ts` `b6cd47272d6415f123c9f6a51947dd1fa315d2dc1a3dc30c183d193329ad6b8f` (39091 bytes, CRLF)
- `runner-v2/src/handoff-snapshot.ts` `61f0c79090fecca0cc4ab7a582cf7db9135ce9d11c49f5330efc049b9d7a41a6` (62014 bytes, LF, pre-existing convention kept)
- `runner-v2/test/docs-policy-v2-handoff.test.ts` `91d269bf53d6357e38c81c00735cd4be8948020e04c3008aec715041ebc2869f` (71880 bytes, LF; new file, rewritten: 14 tests, all through the production manager with no manual step)
- `runner-v2/test/build-runtime.test.ts` `816b7ab59f3f0963e0dd286b3be18144427f67c394e4dda1652a6bc61518603d` (89423 bytes, stub: in-memory read-back)
- `runner-v2/test/project-doc-commit.test.ts` `74918dd9cd79ea0fcaf66d7f63fd1d24b0698e459474c89bfd47e29a0174ab00` (55669 bytes, stubs: delegate/throwing read-back)
- `runner-v2/test/request-triage.test.ts` `35170eaf7c9308d8afa031ef34e585fcae24b0176bfdf60a5fd980f7981f63ea` (179093 bytes, stub: throwing read-back; LF kept)
No BOM anywhere; per-file line endings preserved (no mixed EOL);
non-ASCII byte counts identical to HEAD for every touched file;
`git diff --check` clean. `configureProjectDocsPolicy` still byte-identical
(production still stamps docs v1). No `child_process` in new code; the new
`git show` reads go through the existing audited `this.git` path.

### Suites with counts (all green; real SQLite/git/pump)

- `docs-policy-v2-handoff.test.ts`: 14 pass, 0 fail.
- `replay-compatibility` + `project-docs` + `handoff-snapshot`: 72 pass
  (v1 fixture log replays byte-identical, incl. the stored projection).
- `scheduler-store` + `integration-manager` + `final-verification-completion`: 77 pass.
- `build-runtime` + `project-doc-commit`: 44 pass.
- `request-triage` + `architect-tools`: 36 pass.
- `native-build-manager`: 58 pass. `control-server` + replays: 21 pass.
- `git-production-managers` + `process-recovery-control`: 4 pass.
- `native-build-initialization` + `planning-tools`: 37 pass.
- Static audits (`git/lsp/mcp-caller-audit`, `one-shot-command-routing-static`,
  `static-adapter-policy`): 39 pass.
- `runner-v2` tsc `--noEmit`: clean. eslint on all ten changed files: clean.
- `native-delivery-factory.test.ts`: 17 pass, 0 fail (controller-owned
  long suite, run in the background by the worker; ~1602 s).

### Prove-red records (sha256 before/after, byte-exact restore)

- (1) Removed the `afterArchitect` snapshot commit (back to next-step
  dependence): the production-manager plan-only test went red with
  `0 !== 1` snapshot events after the pump (`the handoff step commits
  exactly one snapshot`). `build-runtime.ts` sha before:
  `15b51adc8284f1b30a66a1c832ce47671d3b9aa59d1cb195edc6dbbc2e0930df`;
  after restore: `15b51adc8284f1b30a66a1c832ce47671d3b9aa59d1cb195edc6dbbc2e0930df`
  (byte-exact).
- (2) Restored the fixed failure key
  (`handoff-snapshot-failed:<stop>`): the double-failure test went red with
  `1 !== 2` paused events (second failure appends nothing, resume refused).
  Same sha before/after (byte-exact restore).
- Note: a later comment-only edit replaced 6 em dashes the repair had added
  with `--` (non-ASCII counts identical to HEAD); hashes above are post-edit.

### Not done / limits

- M7 (AGENTS.md/CLAUDE.md splice) is left for C2b; M9 (docs/planning
  pairing check) is left for T7a, as instructed.
- `native-delivery-factory.test.ts` (controller-owned): completed after
  the cycle with 17 pass, 0 fail - see the suite list above.
- Full-repo suite was not run (time); the packet suites, the named importer
  suites above, tsc, eslint and `git diff --check` are the validation gate.

## Acceptance (controller)

Review r2 (`C2a-review-r2.md`): **ACCEPT, 0 blocking**; B1-B4, M1-M6 and M8 fixed; M7 and M9 deferred as briefed. Follow-ups N1-N6 go to C2b (N1 must be fixed before T7a turns docs v2 on in production).
N5 fixed by the controller: `runner-v2/test/docs-policy-v2-handoff.test.ts` had mixed line endings (172 CRLF, 1,368 LF); normalized to LF; 14/14 pass after the change; sha256 `25a8e21431820ae34799c7de5b20877ed3db38320e3d861b8ddfa6352b3da09b`.
