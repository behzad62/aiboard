# SDD ledger — plan: docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md

## Preflight evidence

- Starting revision: `c867ac08e079a242a6bd4f59e96918ccfe6d78a0`
- Worktree: `D:/repos/ai-discussion-board/.worktrees/runner-v2-robust-build`
- Branch: `codex/runner-v2-robust-build`
- Baseline product diff: clean after the plan-only commit.
- Node: `v24.18.0` (current evidence only; package policy remains maintained LTS 22/24).
- Git: `2.53.0.windows.1`.
- Docker client/daemon: `29.7.2`; Podman unavailable. Docker is optional production configuration but available for the required local OCI integration fixture.
- Baseline validation: `npm run typecheck:runner-v2` passed; `npm run test:runner-v2` passed 795/795 Runner tests plus every chained client/Build policy check in 206645 ms.
- State/temp rule: every task uses a task-owned temporary external Runner-state root and records cleanup before review.
- Execution rule: tasks are strictly serial; no overlapping implementers.

## Task ledger

| Task | Packet | Status | Base | Implementer report | Review | Fix rounds | Commit | Current evidence |
|---|---|---|---|---|---|---:|---|---|
| 1 | P6.4a contracts | verified complete | `c867ac08` | `task-1-implementer-report.md` | round 1 fixed; re-review approved | 1 | `93dcd216`, `27253f6d` | fresh reviewer: 65/65 + typecheck + diff check green; all required faults red/reverted/green |
| 2 | P6.4b environment | verified complete | `27253f6d` | `task-2-implementer-report.md` | approved after 3 fix rounds | 3 | `9ced73d4`, `cc5c1c71`, `c431d0f5`, `e4096ca0` | fresh reviewer: 8/8 + typecheck + targeted ESLint + adversarial replay green; faults red/reverted/green |
| 3 | P6.4b output | verified complete | `e4096ca0` | `task-3-implementer-report.md` | approved after 3 fix rounds | 3 | `da4dbc01`, `4e83ced7`, `8843f56c`, `802f6491` | fresh reviewer: 49/49 + typecheck + lint + adversarial attestation green; 9 total mutations red/reverted/green; zero residue |
| 4 | P6.4c runtime/store | verified complete | `802f6491` | tracked `task-4-implementer-report.md` | approved after final governed fix round | 5 | `b20d6b78`, `b7a7dd37`, `c5cb2e3a`, `ba5eeead`, `8ef96221`, `9b42e743`, evidence commits `d871df97`, `4d53078a` | fresh reviewer: 49/49 + typecheck + diff check green; expired unbound launch is durably orphaned without takeover/relaunch; stale authority rejected |
| 5 | P6.4c adapters | verified complete after carried prerequisite | `4d53078a` | `task-5-implementer-report.md`, `task-6a-prerequisite-report.md` | approved after breaker residuals closed at Task 6 entry | 5 + 3 carried fixes | `e57c2a1f`, `e29d5b8f`, `4f940cb3`, `16fca6d2`, `dfcb6a33`, `f8c1ad06`, carried `5307d1b7`, `18b97fc9`, `9c59feec`, `b997aade` | fresh re-review approved: all seven blocking effect families durably journaled, exact consumers enforced, malformed/ambiguous effects retained, authority loss fail-closed |
| 6 | P6.4d isolation/grants | verified complete after carried Task 7 entry prerequisite | `b997aade` | `task-6-implementer-report.md`, `task-7a-prerequisite-report.md` | breaker residual independently approved at Task 7 entry | 5 + 3 carried prerequisite fixes | initial `88266699`, fixes through `6be10f70`, carried `b1ea2f92`, `74e7aec3`, `04f00723`, `8eb593f0` | exact grants, truthful provider/Full selection, configured OCI, two-phase cleanup evidence, bounded durable projection, concurrency/capacity safety, real Docker and zero residue approved |
| 7 | P6.4e one-shot/evidence/verification | verified complete | `8eb593f0` | `task-7-brief.md`, `task-7-implementer-report.md`, review/fix reports through `task-7-review-round-5.md` | final governed round 5 approved; zero Critical/Important findings | 5 feature review rounds | initial `560a061f`, fixes through `30e8b8ff` | independent 130/130 + 49/49 + 8/8, type/lint/diff/residue green; no Task 8 scope or Node pin |
| 8 | P6.4e remaining child families | 8.0A verified complete; 8.0B1 blocked after exceptional round 6 | `a0b3fb7a` | `task-8-brief.md`, `task-8.0a-brief.md`, `task-8.0b1-report.md` | B1 exceptional re-review not approved; two Important residuals independently reproduced | 6 (one owner-authorized exception after 5/5) | through `ac7d837f` | B1 implementation gates green, but semantic exit gate red: ambiguous legacy bound rows can omit a possible channel duty and provider-crafted typed errors can expose raw secret-bearing message/cause; B2 locked |
| 9 | P6.4f Git hardening | blocked by 8 | — | — | — | 0 | — | — |
| 10 | P6.4g filesystem fence | blocked by 9 (serial doctrine) | — | — | — | 0 | — | — |
| 11 | P6.4h recovery/disclosure | blocked by 10 | — | — | — | 0 | — | — |
| 12 | P6.4i final gate | blocked by 11 | — | — | — | 0 | — | — |

## Dependency and conflict preflight

All conflicts resolve by strict numeric serialization. “Interface” means a task
consumes or changes a contract owned by the earlier task even when no direct file
overlap is expected.

| Task or pair | Shared file/interface | Resolution |
|---|---|---|
| 1 | Capability contract, generic execution contracts | First; freeze before runtime work |
| 2 | Child-environment contract | After 1 |
| 3 | Output disposition/artifact contract | After 2 |
| 4 | Execution contracts, environment, output, durable state | After 1–3 |
| 5 | ProcessBackend/SubprocessRuntime, managed Job helper | After 4 |
| 6 | Execution contracts, backend selection, ToolBroker/context/factory/config | After 5 |
| 7 | SubprocessRuntime, grants, factory, process/evidence/final verification | After 6 |
| 8 | SubprocessRuntime, grants, factory, managed/LSP/MCP/Git | After 7 |
| 9 | Shared Git runner and environment/isolation policy | After 8 |
| 10 | ToolBroker grant and filesystem tool mutation boundary | After 9 by serial doctrine |
| 11 | Execution/recovery contracts, durable events, observability/client | After 10 |
| 12 | Every runtime composition/cleanup/package/CI surface | Last |
| 1 ↔ 4 | Generic invocation/process/result/store types | Task 4 consumes frozen Task 1 types |
| 1 ↔ 5 | Capability attestation and birth/backend identity | Task 5 implements Task 1 SPI semantics |
| 1 ↔ 6 | Capability and opaque grant contracts | Task 6 consumes/extends only compatibly |
| 1 ↔ 11 | Exceptional recovery proposal/outcome types | Task 11 wires frozen types durably |
| 1 ↔ 12 | Capability version/package compatibility | Task 12 validates; no contract redesign |
| 2 ↔ 4 | Child environment constructor | Task 4 composes it |
| 2 ↔ 7 | Environment behavior in one-shot families | Task 7 routes; Task 2 remains sole policy owner |
| 2 ↔ 8 | Environment behavior in remaining families | Task 8 routes; no duplicate scrub logic |
| 2 ↔ 9 | Git safe environment | Task 9 adds Git-specific deny settings atop central scrub |
| 3 ↔ 4 | Output spool/result lifecycle | Task 4 composes it |
| 3 ↔ 7 | Evidence/final artifact mapping | Task 7 maps shared output only |
| 3 ↔ 8 | Protocol-family output handling | Task 8 retains framing, delegates bytes |
| 3 ↔ 12 | Spill cleanup/package surfaces | Task 12 validates final ownership |
| 4 ↔ 5 | Backend SPI, store transitions, reconciliation | Task 5 supplies adapters without changing orchestration authority |
| 4 ↔ 6 | Runtime backend/provider selection | Task 6 adds isolation selection at the frozen seam |
| 4 ↔ 7 | Shared runtime/factory | Task 7 is first consumer migration |
| 4 ↔ 8 | Shared runtime/factory/store | Task 8 completes consumer migration |
| 4 ↔ 11 | Recovery states and durable records | Task 11 proposes only against Task 4 states |
| 4 ↔ 12 | Startup/shutdown reconciliation | Task 12 composes existing APIs |
| 5 ↔ 6 | Semantic ownership capabilities | Isolation provider may wrap/use backend; claims remain separate |
| 5 ↔ 8 | Managed/LSP current ownership code | Task 8 removes duplicates only after Task 5 adapters are green |
| 5 ↔ 11 | Birth/identity/scope validation | Task 11 reads Task 5 proofs, never signals directly |
| 5 ↔ 12 | Adapter cleanup and CI matrices | Task 12 validates both native adapters |
| 6 ↔ 7 | Grant/provider context and native factory | Task 7 consumes Task 6 wiring |
| 6 ↔ 8 | Grant/provider context and remaining families | Task 8 consumes Task 6 wiring |
| 6 ↔ 10 | Exact path grant at trusted mutation seam | Task 10 consumes grant; Task 6 owns issuance |
| 6 ↔ 11 | Lease/grant enforcement projection | Task 11 exposes existing state |
| 6 ↔ 12 | OCI cleanup/config/package/CI | Task 12 composes and validates |
| 7 ↔ 8 | Shared factory/runtime migration | Complete Task 7 and rebase evidence before Task 8 |
| 7 ↔ 11 | Process result/enforcement projection | Task 11 exposes, does not remap semantics |
| 7 ↔ 12 | Factory cleanup and broad regressions | Task 12 finalizes after both routing tasks |
| 8 ↔ 9 | `git-command.ts` and Git tests | Task 8 routes; Task 9 hardens after green routing |
| 8 ↔ 11 | Managed/recovery observation | Task 11 uses generic records after migration |
| 8 ↔ 12 | Raw-spawn allowlist and family cleanup | Task 12 validates, no new launch seam |
| 9 ↔ 12 | Git preflight/package/static gates | Task 12 runs final Git gate |
| 10 ↔ 11 | Grant/mutation audit projection | Task 11 discloses Task 10 typed outcomes |
| 10 ↔ 12 | Filesystem docs/platform validation | Task 12 validates and documents |
| 11 ↔ 12 | Startup recovery, observability, client/package | Task 12 composes and runs final gate |

## Findings queue

| Finding | Severity | Owner task | Status |
|---|---|---|---|
| Three uniquely named `runner-v2-launch-orphan-*` system-temp roots from Task 4 prove-red runs could not be removed because host policy rejected both safe cleanup attempts; each was inspected and contains only its owned `state.sqlite`. | Low | 12 | Deferred cleanup/residue audit; do not broaden Task 5 |
| One inert Task 5 evidence directory for stopped supervisor PID 41160 remains under the task-owned temp namespace because both recursive and exact file deletion were denied by host policy; all three associated exact fixture processes were revalidated and stopped. | Low | 12 | Deferred cleanup/residue audit; no live process remains |
| A valid schema-v1 active `bound` host row without the new channel/checkpoint markers is ambiguous with a pre-fix crash after channel acquisition; the derived ledger omits `channel` and can release while retaining the backend binding. | Important | 8.0B1 | Closed and independently approved in round 7: active legacy generation is typed refused and byte-preserved |
| A provider can throw or replay an exported `StreamingProcessSessionError` with arbitrary secret-bearing mutable fields. | Important | 8.0B1 | Closed and independently approved in round 7: foreign instances are sanitized and genuine replay is freshly reminted from immutable private claims |

## Task 8 specification gate

- Task 8 architecture inventory covered every production child family, the
  shared construction graph, direct-launch seams, platform-host allowlist, and
  the negative configured-local-provider audit.
- Four focused specification reviews resolved grant lifetime, durable
  SessionAuthority transfer, per-operation authorization, internal execution
  principals, streaming recovery/output ownership, managed cancellation, and
  contract/runtime packet ownership.
- Final verdict: `task-8-spec-review-4.md` APPROVED with zero
  Critical/Important ambiguity. Implementation order is locked to 8.0A, 8.0B,
  8.1 Git, 8.2 MCP, 8.3 LSP, 8.4 managed, then 8.5 provider/static closure.

## Task 8 execution log

- Task 8.0A: initial implementation commits `ddbe9008`, `35608732`; controller
  cleanup evidence `99aea024`; initial review found eight Important issues.
- Task 8.0A: fix round 1/5 (7 addressed, 1 open — expired
  `cleanup_pending` ownership lease strands the exact cleanup effect because
  owner acknowledgement and takeover are both refused; commits
  `0f5b36a8`..`89fa9656`). Packet 8.0B remains locked.
- Task 8.0A: fix round 2/5 (0 fully addressed, 1 open — successful recovered
  cleanup can settle, but recovered failure cannot persist `cleanup_blocked`,
  and accepting an arbitrary older effect fence lacks durable takeover
  provenance; commits `17d7844e`..`3431499f`). Packet 8.0B remains locked.
- Task 8.0A: fix round 3/5 (1 linked defect addressed, 1 open — cleaned and
  blocked settlement now work after takeover, but a coherently forged
  provenance origin plus first transition is not anchored to immutable durable
  authority; commits `88f6059d`..`1f2e5173`). Round 4 escalates to a fresh
  higher-capability implementer; packet 8.0B remains locked.
- Task 8.0A: fix round 4/5 (SQLite terminal coverage addressed, 1 provenance
  finding open — current version-3 records are independently anchored, but an
  active version-2 record can launder the same coherent forgery by deriving its
  new anchor from untrusted provenance during upgrade; commits
  `a9550821`..`a23b75e7`). Round 5 is the governed final fix attempt with fresh
  escalation; packet 8.0B remains locked.
- Task 8.0A: fix round 5/5 (1 addressed, 0 open — unanchored active version-2
  cleanup evidence is typed quarantined and byte-preserved; reducer laundering
  is independently blocked; safe cleanup-free migration and terminal history
  remain closed; commits `78aa035b`..`5106dcb8`). Re-review reports zero new or
  residual Critical/Important findings.
- Task 8.0A: complete (commits `6eba9a1d`..`5106dcb8`, review clean after five
  governed rounds). Fresh controller verification: 89/89 focused and 107/107
  affected Task 7 tests, Runner typecheck, targeted lint, net diff check, clean
  worktree, exact source-scope audit, and zero Task 8.0A temp roots. Packet 8.0B
  is unlocked; no production child family migrated in 8.0A.
- Task 8.0B architecture gate: first focused review found five Important
  ambiguities in staged authority, durable ownership handoff, output checkpoint
  ordering, internal MCP discovery ownership, and independent Windows semantic
  probes. The revised brief makes staging mandatory, uses one atomic streaming
  storage boundary, closes retained replay/checkpoint acknowledgement ordering,
  explicitly owns the narrow B3 discovery executor, and separates portable,
  batch, tree/birth, and optional Job capabilities. Re-review 2 APPROVED with
  zero Critical/Important ambiguity; its two Minor terminology clarifications
  were folded into the brief. Internal packet 8.0B1 is unlocked; production
  adapters, CLI construction, and child families remain unchanged.
- Task 8.0B1 initial implementation (`127403fe`, `b947aaeb`) was not approved:
  review found one Critical and six Important authority, state, recovery,
  evidence and test defects.
- Task 8.0B1 fix round 1/5 (`f8238b8b`, `86304fdb`) closed output ordering,
  staged authority and strict host-state groups, but re-review retained one
  Critical cross-kernel operation-authorization replay and four Important
  recovery/evidence/cancellation findings.
- Task 8.0B1 fix round 2/5 (`fb3050a4`) closed the Critical issuer boundary,
  atomic non-1 re-fence and spool evidence, but re-review retained late-channel
  cleanup and known-resource cancellation races.
- Task 8.0B1 fix round 3/5 (`ac6b8035`) closed caller-bound cleanup races but
  re-review found double-clean and false-release accounting paths.
- Task 8.0B1 fix round 4/5 (`55892af3`) separated settlement and cleanup errors,
  but re-review found channel-only retry ownership could bypass checkpoint or
  lease cleanup.
- Task 8.0B1 fix round 5/5 (`b7ee53f0`) added per-resource durable cleanup
  facts and passed 70/70 B1, 89/89 8.0A, 173/173 Task 7/spool, typecheck, lint,
  diff and cleanup gates. Final independent review nevertheless found two
  Important kernel bypasses: incomplete cleanup-duty subsets can reach released
  with lease/backend obligations present, and arbitrary provider error text can
  persist secrets. Governed repair budget is exhausted. Task 8.0B1 is NOT
  approved, 8.0B2 remains locked, and explicit owner authority is required to
  extend/reset the repair budget or choose rollback/redesign.
- Task 8.0B1 exceptional repair round 6: the owner explicitly authorized one
  additional round after the governed 5/5 breaker. Scope is limited to the two
  final findings in `task-8.0b1-rereview-5.md`: kernel-derived complete cleanup
  obligations and closed secret-safe durable cleanup failures. This authorization
  does not reset or create an open-ended repair budget. Packet 8.0B2 remains
  locked until a fresh independent re-review and controller verification both
  report zero Critical/Important findings.
- Task 8.0B1 exceptional repair round 6 implementation (`ac7d837f`) added
  kernel-derived cleanup facts, current-owner fencing, atomic host/checkpoint
  markers, and closed failure codes/messages. Its implementation evidence was
  green: B1 79/79, 8.0A 89/89, Task 7 plus Task 3 173/173, typecheck, targeted
  lint, diff, mutation, scope, and residue checks.
- Task 8.0B1 exceptional repair round 6 re-review is NOT APPROVED. The fresh
  reviewer found two Important residuals, and the controller reran both exact
  read-only reproductions at `ac7d837f`: (1) a schema-v1 `bound` row without the
  optional new markers derived only `host` and `isolation_lease`, then reached
  `released`/owner `none` while retaining its backend binding; (2) a provider-
  constructed exported `StreamingProcessSessionError` returned the exact
  `credential=B1_R6_TYPED_PROVIDER_SENTINEL` message and nested payload-bearing
  cause to the caller. See `task-8.0b1-exceptional-round-6-review.md`.
- Task 8.0B1 remains blocked. The one owner-authorized exceptional round is
  consumed, no seventh repair round is authorized, and Packet 8.0B2 remains
  locked. Broader controller suites were not rerun after the failed semantic
  gate because they cannot prove either reproduced safety requirement.
- Task 8.0B1 repair round 7: after reviewing the distinction between the prior
  defects and the two residual paths, the owner explicitly authorized fixing
  both and continuing. Round 7 is limited to the ambiguous pre-marker active
  host schema and forgeable provider error-provenance paths recorded in
  `task-8.0b1-exceptional-round-6-review.md`. Packet 8.0B2 remains locked until
  a fresh independent re-review and controller verification are both green.
- Task 8.0B1 repair round 7 implementation (`392804c4`) closed the active host
  generation ambiguity and fresh foreign-error forgery path. Reported gates
  were B1 88/88, 8.0A 89/89, Task 7 plus Task 3 173/173, typecheck, targeted
  lint, diff, mutations, scope, and residue green.
- Task 8.0B1 round 7 re-review: 1 addressed, 1 Important open. Host schema
  generation/refusal is independently approved. Error provenance remains open
  because a previously caller-exposed genuine branded error is mutable and can
  be replayed by a provider; WeakSet identity survives mutation and the normal
  catch rethrows the same object. The controller reproduced `same:true` with
  `credential=B1_R7_REPLAY` in both message and cause. See
  `task-8.0b1-round-7-review.md`. This is the same authorized R7.2 secret-boundary
  requirement, so it enters the automatic technically-determinate repair loop;
  B2 remains locked.
- Task 8.0B1 round 7 replay repair (`a8f972db`) replaces mutable-object identity
  trust with immutable private claims and remints fresh cause-free errors at
  every affected boundary. The exact replay regression was RED 0/1, then GREEN
  1/1; both same-object return and public-field reconstruction mutations were
  proven RED and reverted GREEN. Reported broad gates are B1 89/89, 8.0A 89/89,
  Task 7 plus Task 3 173/173, typecheck, targeted lint, diff, scope, and residue
  green.
- Task 8.0B1 round 7 replay re-review: APPROVED with zero remaining or new
  Critical/Important findings in the bounded repair. Immutable private claims,
  fresh reminting, phase-owned mappings, and cleanup classification were checked
  across launch, cancellation, delivery, channel/output, cleanup/retry, bounded
  provider, and late-resource boundaries. Packet 8.0B2 remains locked pending
  current controller verification.
- Task 8.0B1 controller gate: VERIFIED 100% COMPLETE. Exact formerly failing
  safety checks are green; current affected gates are B1 89/89, 8.0A 89/89,
  Task 7 plus Task 3 173/173, Runner typecheck, targeted lint, scoped diff,
  source-scope, worktree, and residue audits green. Independent semantic review
  reports zero Critical/Important findings. Packet 8.0B2 is unlocked; production
  child-family routing and OCI construction remain deferred to their owning
  packets. See `task-8.0b1-controller-evidence.md`.
- Task 8.0B2 entered at clean head `cb597496`. The focused execution brief owns
  real portable native/POSIX/Windows host and bounded duplex channel adapters,
  mandatory low-level Windows Job host extraction, independent portable/batch/
  tree/Job probes, current-host lifecycle faults, compatibility, mutations, and
  residue gates. OCI, CLI construction, and all production family routing remain
  excluded until their owning packets.
- Task 8.0B2 implementation (`7100c5de`, evidence `35f05ec5`) reported 403 pass,
  0 fail, 1 explicit POSIX-native Windows-host skip, with typecheck, lint,
  mutations, static and residue gates green.
- Task 8.0B2 independent review 1: NOT APPROVED, zero Critical and six Important
  findings. The Job host is a callback wrapper that still routes through the
  managed facade and fabricates an actor; Job has no duplex channel; independent
  facts are not consumed and no Job-unavailable portable/batch fallback exists;
  launch-bound fences reject legitimate recovery; attach/terminal/release omit
  required identity re-attestation; and corrupt/unsettled output can be skipped
  or released fail-open. Governed repair round 1 is authorized automatically
  because all findings are within the approved B2 scope. B3 remains locked.
- Task 8.0B2 fix round 2 is implementation-complete pending broad closure. The
  six residual Important findings now have deterministic RED/revert/GREEN
  coverage: real Job stdout/stderr producer backpressure; independently active
  and consumed portable/batch/tree/Job facts; lowest-boundary atomic fencing;
  final fenced release/deletion; strict portable/Job retained evidence; and a
  watchdog/cadence/failure counter for asynchronous CIM. Controller audit also
  closed ambient probe credential exposure, missing Job read evidence,
  unavailable-by-default facts, active-Job-false fallback, final output-ack
  ordering, and same-host fence-lock starvation under a 65 MiB load. Current
  gates are B2 141/141, affected Windows 17/17, reset 1/1, semantic 2/2,
  production load 1/1, typecheck/diff/residue green. B3 remains locked while
  compatibility/static/full Runner gates run.
- Task 8.0B2 fix round 2 controller-audit closure added current-fence Job
  activation, post-effect Job snapshots, strict portable ack/terminal/release/
  verify-empty linearization, authenticated launch rollback on Windows and
  POSIX, pinned PATH/PATHEXT batch resolution, detach-safe output lanes, and
  minimal fixture environments. Current focused result is 91 pass, zero fail,
  one explicit POSIX-native Windows skip; typecheck/diff and new-residue gates
  are green. Seventeen previously verified Temp roots remain only because local
  execution policy rejected exact literal recursive removal; no supervisor or
  descendant references them. B3 remains locked pending broad closure.
- Final Task 8.0B2 controller fixes add takeover-safe Job release lanes,
  detach-safe Job stream iteration, real fenced POSIX group control, bounded
  POSIX enumeration and Windows CIM/taskkill control, bounded 1 MiB Job input,
  exact portable state identity, post-supervisor control semantics, root-only
  `/T` termination, and Windows directory-first/PATHEXT-inner resolution.
  Current gates: exact 12/12, full Windows 62/62, compatibility 320/320,
  typecheck GREEN, zero live supervisors/new roots after bounded settle. Twenty
  exact interrupted Temp roots (17 prior plus 3 Job64 diagnostics) have no live
  references but remain because execution policy rejected literal recursive
  removal before deletion. B3 remains locked while final static/full Runner
  closure runs.
- Task 8.0B2 broad attempt 1 exited non-green without a trustworthy retained
  aggregate count. Exact isolation repaired the R2-caused legacy LSP stderr
  fallback (17/17 GREEN) and a loaded semantic-probe retained-root path. Probe
  cleanup is now exact-root-contained, state/launch/identity validated, owner
  capped, and independently birth-audited through one bounded inventory. Its
  outside-root, missing-root, and removal mutations were RED/reverted/GREEN;
  semantic is 13/13, recovery 1/1, typecheck/lint/diff GREEN, and bounded settle
  is zero live supervisors. Broad restart remains the final locked gate.
- Broad attempt 2 completed with 1,357 total / 1,350 pass / five fail / one
  cancelled / one skip. All six affected cases were GREEN alone; combined load
  reproduced fixture cleanup EPERM and semantic stable-release contention.
  Test fixtures now require bounded exact terminal/release cleanup, while the
  semantic probe retries transient stable release only inside its unchanged
  deadline. Retry removal was RED/reverted/GREEN; affected stress is 106/106,
  type/lint/diff GREEN, and bounded residue is zero. Final broad restart is in
  progress; B3 remains locked.
- The next unbounded broad completed 1,358 total / 1,353 pass / four fail / one
  skip; every failure was fail-closed Windows host-fixture contention and exact
  reruns were green. `test:runner-v2` now bounds only Node file concurrency to
  three, while the separate real affected stress remains GREEN 106/106. The
  unbounded run is the RED mutation; production deadlines and semantics are
  unchanged. Final exact package-script exit is pending.
- A file-concurrency cap of three still completed 1,358 total / 1,355 pass /
  two fail / one skip; both failures passed exact. The package gate now
  serializes files, while the mandatory real three-file concurrency stress stays
  GREEN 106/106. The capped-three run is RED evidence for the final harness
  bound; production behavior is unchanged.
- The first serial broad completed 1,358 total / 1,356 pass / one fail / one
  skip. Its sole retained-window failure reproduced exact 3/5 as Windows
  `open("wx")` reported active lock contention as `EBUSY`. Shared bounded lock
  acquisition/finalization now covers native claim/effect, portable supervisor
  effect, and Job host claim/effect; transient-unlink removal and
  persistent-error swallowing were each RED, reverted, and GREEN. Exact replay
  is GREEN 5/5 and the affected real concurrent group is GREEN 109/109.
  Typecheck/lint/diff are GREEN and bounded residue is zero. One final serial
  package exit remains required; B3 remains locked.
- A later serial gate completed 1,361 total / 1,359 pass / one fail / one skip.
  Its raw post-header `ECONNRESET` exposed missing `IncomingMessage`
  error/aborted settlement in both authenticated supervisor HTTP clients.
  Requests now settle once and only accept a reset through independent durable
  stopped proof. Listener removal was RED by timeout and reverted GREEN; reset
  stress is 20/20 and affected concurrent stress is GREEN 110/110. Bounded
  residue is zero live owned supervisors. One final serial package exit remains
  required; B3 remains locked.

## Breaker rulings

- Ruling: Task 5's unjournaled recovery output-reopen, backend-observe/output-write,
  and verify-empty effects are real and load-bearing. Carry their durable
  exclusion into the first prerequisite packet of Task 6, before isolation or
  grant work. This preserves dependency safety at the cost of coupling one
  inherited runtime repair to Task 6's dispatch.
- Ruling: completed effect markers must name and enforce their exact semantic
  consumer; unrelated mutations may not clear them. Carry the closed
  family-to-consumer mapping and tamper/replay tests into the same Task 6
  prerequisite. If this ruling is wrong, the cost is a narrower state machine
  and extra migration/tests, not weakened cleanup safety.
- Ruling: Task 6's over-capacity recovery-evidence eviction is real and
  load-bearing. Carry one closed prerequisite into Task 7 before any process
  routing: the newly appended exact recovery group is protected from eviction;
  older complete groups may be removed, but if the protected group still cannot
  fit, persistence fails typed, the provider tombstone is not acknowledged, and
  selector ownership/listeners remain. This preserves the five-round breaker
  while refusing to waive durable cleanup evidence.
- Final serial `npm run test:runner-v2` is GREEN: 1,362 total / 1,361 pass /
  zero fail / zero cancelled / one explicit POSIX-host skip; all chained Runner
  client/policy/UI/observability checks passed. Fresh post-gate typecheck,
  targeted lint, diff check, and five-second residue settle are GREEN with zero
  live owned supervisors. Fix Round 2 is implementation-verified and ready for
  review; it does not approve B2 or unlock B3.
- Task 8.0B2 fix-round-2 independent re-review: CHANGES REQUIRED with zero
  Critical and three Important residual gaps. The optional active Job probe can
  hang the aggregate semantic probe and block an already verified portable
  baseline; anonymous fence lock files cannot safely recover after their holder
  crashes; and passing fixtures plus prior attempts leave non-zero task-owned
  Temp roots. All six preceding Important findings are confirmed addressed.
  Governed fix round 3 is authorized for only these three gaps under
  `task-8.0b2-fix-round-3-brief.md`. B3 remains locked.
- Task 8.0B2 fix round 3 now bounds the optional active Job probe, replaces all
  three anonymous fence-lock paths with one SQLite exact PID/birth/acquisition
  protocol, atomically retires queued contenders, and closes historical plus
  passing-fixture B2 residue. Current gates: lock 9/9, portable 29/29, Windows
  64/64, affected concurrent 125/125, required serial compatibility 387 pass /
  one explicit POSIX-host skip, type/lint/static/diff GREEN, and zero exact B2
  roots/live owned helpers. Final serial Runner package gate, post-gate residue,
  final report, and commit remain; B2/B3 stay locked.
- Task 8.0B2 fix round 3 final verification is GREEN. The initial serial gate
  was RED at two test-harness boundaries: a 30-second evidence broker wrapper
  expired after command mechanics completed at about 44.3 seconds, and a
  portable fixture swallowed its authenticated cleanup. The evidence wrapper
  is now test-only 60 seconds while explicitly asserting the unchanged 25-second
  production command timeout; its file is GREEN 16/16. Cleanup-helper removal
  is RED and revert is GREEN with zero inventory. The final uninterrupted
  package gate is GREEN: 1,377 total / 1,376 pass / zero fail / zero cancelled /
  one explicit POSIX-host skip. Post-gate typecheck, targeted lint, static/diff,
  three-second helper settle, and exact B2-root inventory are GREEN/zero. B2
  remains locked for independent review and B3 has not started.
- Task 8.0B2 fix-round-3 independent re-review: CHANGES REQUIRED with zero
  Critical and four Important residual gaps. Generic POSIX/macOS `ps` absence is
  misclassified as unknown; deleting a retired coordination database lets a late
  stale caller recreate it; a fresh 48-test focused run leaked one live semantic
  probe supervisor/root after PID reuse; and broad prefix plus zero-document
  cleanup authority deleted an unrelated review directory. The optional Job
  watchdog and every earlier B2 finding remain addressed. Governed fix round 4
  is authorized only for these four gaps under
  `task-8.0b2-fix-round-4-brief.md`. B3 remains locked.
- Task 8.0B2 fix round 4 implementation is complete pending independent review.
  Generic POSIX absence is now exact/injectable; native/portable authority
  retirement is non-resurrectable with authenticated post-commit cleanup retry;
  Job initialization is gated by its durable release tombstone; semantic-probe
  timeout cleanup stops only exact supervisors across PID reuse; and historical
  residue deletion requires a closed prefix plus a positive ownership document.
  Current evidence: focused 53/53, portable+Windows 95/95, concurrent affected
  113/113, compatibility 357/357, Node 22.13 and Node 24 locks 12/12 each,
  type/lint/static/diff GREEN, and final serial package 1,384 total / 1,383 pass /
  zero fail or cancelled / one explicit POSIX-host skip. Post-settle live helper
  and exact B2-root inventories are both zero. B2 remains locked; B3 has not
  started.
- Task 8.0B2 fix-round-4 independent re-review: CHANGES REQUIRED with zero
  Critical and two Important residual gaps. A Job release can persist its
  released tombstone then fail SQLite finalization, after which retry returns
  early and strands the live lock; semantic cleanup inventories only recorded
  PIDs and can delete a root while an unlisted command-line-referencing process
  remains live. Every earlier finding remains addressed. Governed fix round 5 is
  authorized only for these two gaps under `task-8.0b2-fix-round-5-brief.md`.
  B3 remains locked.
