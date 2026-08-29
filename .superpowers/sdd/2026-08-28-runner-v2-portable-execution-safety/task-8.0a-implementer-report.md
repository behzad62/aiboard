# Task 8.0A implementer report

## Scope and baseline

- Packet: Runner V2 8.0A — durable long-lived session authority and state contracts only.
- Worktree: D:\repos\ai-discussion-board\.worktrees\runner-v2-robust-build
- Branch: codex/runner-v2-robust-build
- Assigned baseline: 6eba9a1d5fa123a9808247624865c4f97b7bec25
- Production family migration: none. No Git, MCP, LSP, managed-process, configured-provider, process launch, construction graph, or CLI routing was changed.
- Implementation plus initial report commit: ddbe9008 (feat(runner): define streaming session authority contracts).
- This report finalization update is committed immediately after the implementation commit; the handoff lists both task commit hashes.

## Files changed

- runner-v2/src/streaming-session-store.ts — versioned private durable record parser, clone/digest, closed reducer, memory/SQLite stores, integrity and capacity guards.
- runner-v2/src/session-authority.ts — opaque-grant transfer, fixed-envelope comparisons, non-forgeable operation authorizations, fencing, recovery and typed dispositions.
- runner-v2/src/interactive-process-channel.ts — backend-private interactive channel/provider contracts, bounded ordered writes, reattach, lifecycle boundary and family authorization gates.
- runner-v2/src/execution-grants.ts — immutable credential-name claims and current consumed-claim validation needed by session authority.
- runner-v2/test/streaming-session-store.test.ts — parser, state, persistence, digest, capacity and cleanup tests.
- runner-v2/test/session-authority.test.ts — transfer, access, auth, fencing, revocation/expiry and recovery tests.
- runner-v2/test/interactive-process-channel.test.ts — fake private provider/channel, write, reattach, lifecycle and authorization-boundary tests.
- runner-v2/test/execution-grants.test.ts — credential clone/current-claim tests.

## Requirement-by-requirement audit

| Requirement | Evidence and result |
| --- | --- |
| 1. Preserve Task 7 terminal contracts | No Task 7 source was edited. Imports audit found no streaming module import outside SessionAuthority/new state module. Required Task 7 affected tests passed 106/106. No streaming state references SubprocessRuntime.reconcileStartup. |
| 2. Separate versioned state machine | streaming-session-store defines record kind runner.streaming-session, versions 0/1, closed states for pending/ambiguous/active/stopping/cleanup/released and input/backend/outcome dispositions. Its reducer is separate from terminal state. |
| 3. Strict durable parser/capacity/clone/digest | Exact outer and nested keys, required fields, state/effect/history combinations, unsupported-active and unsafe-downgrade errors, deep frozen public clones, canonical digest and record/effect capacity errors are tested. Initial-claim effect capacity is enforced in both memory and SQLite stores. |
| 4. Durable data only | Recursive forbidden-key scan rejects opaque grants, tokens, ports, payloads, writers, handles, channels and live endpoints/capabilities before parse/clone/storage. The durable record has only immutable identity, access, lease, binding, lifecycle and effect facts. |
| 5. Fenced SessionAuthority transfer | SessionAuthority consumes once, stores only immutable consumed claims in process memory, creates a pending ToolBroker-owned effect, and atomically claims the durable record. It does not issue/revoke opaque grants. |
| 6. Cleanup ownership/recovery | Pending records are ToolBroker-owned; ambiguous host-loss recovery changes the sole owner to provider_lease, acknowledges only the exact ambiguous transfer, and cleans or durably blocks; adopted recovery is SessionAuthority-only. Tests prove no fabricated adoption. |
| 7. No grant persistence/reuse/relaunch | Record parser rejects grant material; unavailable/outcome dispositions deny launch authorization. Both successful and rejected consumed calls reserve their exact ToolBroker call key, preventing a second opaque grant. No relaunch API exists. |
| 8. Immutable access comparison | Helpers independently compare exact path+mode entries, credential names, network/external/destructive flags, lease coverage and later current-grant coverage. Tests reject broader paths/credentials/flags and no union is formed. |
| 9. Non-forgeable operation auth | Opaque object plus WeakMap binds session owner/fence, full run/session/actor/tool/call/profile binding, operation and exact checked access. Assertions reject forged, mismatched, stale, expired and revoked tokens. The registry never returns a backend channel. |
| 10. Lifecycle boundary | Private bounded raw-output draining and terminal wait need no model-call auth. Every write, close, graceful stop, family output delivery and generic request/parse/control/protocol/family action gate requires authorization and current fence. |
| 11. Private provider/channel contracts | Versioned optional InteractiveProcessChannelProvider accepts exact ProcessBackendBinding plus ProcessEffectFence and offers acquire/attested reattach, ordered write, idempotent close, private output, graceful stop, wait and detach. Live instances remain in a closure-private Map. |
| 12. Write safety | Writes validate expected in-memory sequence, length, SHA-256 digest, timeout, current fence, release/close state and explicit acknowledgement. Ack failure or timeout makes the in-memory channel fail closed and reports fenced outcome_unknown without payload persistence. |
| 13. Attested reattach | Reattach requires version, exact binding, valid channel, attested next sequence and input-closed state. Failure reports fenced input_unavailable; acquisition failure reports backend_unavailable; cleanup ownership remains durable. |
| 14. No family migration | No existing family imports any new module, no real child fixture/launch was added, and the channel/provider tests use fakes only. |

## TDD evidence

Each behavior below was added test-first. RED commands were run before the listed minimum implementation. Where a guard was proved with a mutation, the listed revert was applied before the GREEN rerun.

| Cycle | RED command and observed failure | Revert / minimum implementation | GREEN command and result |
| --- | --- | --- | --- |
| Durable store foundation: strict outer/nested schemas, versions, state/effect/history, clone | npx tsx --test --test-name-pattern="rejects unknown fields\|rejects a pending-transfer\|returns an immutable\|refuses an unsupported active\|refuses an active record" runner-v2/test/streaming-session-store.test.ts — missing module/strict parser behaviors | Added streaming-session-store parser and deep clone/freeze; no mutation retained | Same command — selected tests passed |
| Durable forbidden values | npx tsx --test --test-name-pattern="refuses durable session data\|refuses every live capability" runner-v2/test/streaming-session-store.test.ts — durable secret/capability accepted | Added recursive forbidden durable key scan. Mutation: removed nativeHandle from the deny-set; RED became expected forbidden-value assertion failure with unknown-field result; restored nativeHandle using apply_patch | Same command — selected tests passed |
| Durable transitions/persistence | npx tsx --test --test-name-pattern="persists fenced transfer acknowledgement" runner-v2/test/streaming-session-store.test.ts — Streaming session durable mutation is not implemented | Added common fenced reducer and SQLite revision CAS persistence | Same command — passed |
| Ambiguous cleanup blocker | npx tsx --test --test-name-pattern="durably blocks an exact cleanup effect" runner-v2/test/streaming-session-store.test.ts — invalid command | Added mark_cleanup_blocked reducer command | Same command — passed |
| Typed outcomes/stopping/takeover | npx tsx --test --test-name-pattern="records a typed adopted-session outcome\|requires a fenced stopping transition\|fenced recovery can take over" runner-v2/test/streaming-session-store.test.ts — invalid commands | Added mark_disposition, begin_stopping and takeover commands | Same command — selected tests passed |
| State-combination guard mutation | npx tsx --test --test-name-pattern="rejects impossible adopted states" runner-v2/test/streaming-session-store.test.ts — baseline passed | Mutation: changed adopted cleanup-owner guard to if (false); exact command RED with missing expected exception; restored guard using apply_patch | Exact command — passed after revert |
| Digest semantic sensitivity mutation | npx tsx --test --test-name-pattern="includes every remaining streaming authority" runner-v2/test/streaming-session-store.test.ts — baseline passed | Mutation: replaced canonical digest result with a constant; exact command RED; restored SHA-256 canonical digest using apply_patch | Exact command — passed after revert |
| Initial effect-capacity bound (memory + SQLite) | npx tsx --test --test-name-pattern="enforces configured effect capacity on initial claims" runner-v2/test/streaming-session-store.test.ts — Missing expected exception | Added parsed.effects.length guard to both claim implementations | Same command — passed |
| Transfer/access foundation | npx tsx --test --test-name-pattern="consumes one launch grant\|refuses a session envelope\|compares path, credentials, network\|refuses an isolation lease" runner-v2/test/session-authority.test.ts — missing module/access checks | Added SessionAuthority transfer and independent envelope/lease/current-claim comparisons | Same command — selected tests passed |
| Exact transfer and cleanup ownership | npx tsx --test --test-name-pattern="durably transfers cleanup ownership" runner-v2/test/session-authority.test.ts — missing transfer acknowledgement behavior | Added fenced transfer acknowledgement and cleanup-owner state handoff | Same command — passed |
| Opaque auth/stale fence | npx tsx --test --test-name-pattern="binds an opaque launch-call authorization\|invalidates a current operation authorization" runner-v2/test/session-authority.test.ts — missing opaque authorization / takeover | Added WeakMap-backed auth records and current owner/fence verification | Same command — selected tests passed |
| Revoke/expiry | npx tsx --test --test-name-pattern="revokes a session operation authorization\|expires a session operation authorization" runner-v2/test/session-authority.test.ts — current-claim check absent | Added current consumed-claim validation. Mutation: made assertCurrentClaims a no-op; exact command RED with missing expected exception; restored validation using apply_patch | Same command — selected tests passed |
| Exactly one grant and transfer | npx tsx --test --test-name-pattern="rejects a second opaque grant" runner-v2/test/session-authority.test.ts — got grant_consumed rather than pre-consumption second_grant_for_call | Added ToolBroker-call key precheck | Same command — passed |
| Second transfer call | npx tsx --test --test-name-pattern="refuses a second streaming-session transfer" runner-v2/test/session-authority.test.ts — missing expected exception | Added global call-key reservation across transfers | Same command — passed |
| Recovery before/after adoption | npx tsx --test --test-name-pattern="replays each unadopted\|fails closed into durable provider-lease cleanup blocking\|uses SessionAuthority-only fenced cleanup" runner-v2/test/session-authority.test.ts — missing recovery method/Provider cleanup proof | Added exact once replay/ack and clean-or-block recovery paths | Same command — selected tests passed |
| Typed disposition/no relaunch | npx tsx --test --test-name-pattern="records a typed unavailable disposition" runner-v2/test/session-authority.test.ts — missing SessionAuthority disposition method | Added fenced mark_disposition bridge | Same command — passed |
| Rejected consumed call cannot retry with another grant | npx tsx --test --test-name-pattern="requires a fresh exact ToolBroker call" runner-v2/test/session-authority.test.ts — Missing expected exception | Reserved call key immediately after successful consume in beginTransfer/authorizeOperation (before later validation can reject) | Same command — passed |
| Private channel/write/close foundation | npx tsx --test --test-name-pattern="keeps an acquired backend channel private\|closes input idempotently" runner-v2/test/interactive-process-channel.test.ts — missing module/private registry/auth checks | Added versioned private channel contracts, closure registry, ordered write and close behavior | Same command — selected tests passed |
| Reattach and typed unavailable | npx tsx --test --test-name-pattern="refuses reattach\|reattaches only\|reports typed input_unavailable" runner-v2/test/interactive-process-channel.test.ts — missing reattach contract | Added exact-binding attested reattach and input_unavailable bridge | Same command — selected tests passed |
| Backend unavailable | npx tsx --test --test-name-pattern="records backend_unavailable" runner-v2/test/interactive-process-channel.test.ts — raw backend error escaped/no durable disposition | Added failAttach fenced disposition bridge | Same command — passed |
| Ack uncertainty/timeout | npx tsx --test --test-name-pattern="fails closed and records outcome_unknown\|treats a write timeout" runner-v2/test/interactive-process-channel.test.ts — disposition absent / missing timeout rejection | Added explicit acknowledgement race, fail-closed outcome state and fenced outcome_unknown reporting | Same command — selected tests passed |
| Write fence mutation | npx tsx --test --test-name-pattern="rejects stale, mismatched, duplicate, and out-of-order writes" runner-v2/test/interactive-process-channel.test.ts — baseline passed | Mutation: disabled write-fence comparison with if (false); exact command RED with missing expected rejection; restored comparison using apply_patch | Exact command — passed after revert |
| Lifecycle/family gates | npx tsx --test --test-name-pattern="permits private output\|bounds private raw-output\|requires a current authorization before subscribing\|requires authorization for graceful shutdown\|denies every family protocol" runner-v2/test/interactive-process-channel.test.ts — missing APIs/gates | Added private bounded drain, terminal observation, graceful-stop gate and generic family-action gate | Same command — selected tests passed |
| Fenced durable callback | npx tsx --test --test-name-pattern="fails closed and records outcome_unknown" runner-v2/test/interactive-process-channel.test.ts — expected fence values were undefined | Added ProcessEffectFence to onDisposition callback | Same command — passed |
| Credential claim clone/current validation | npx tsx --test --test-name-pattern="clones every public credential-name\|makes consumed claims unusable" runner-v2/test/execution-grants.test.ts — credential array shared/current validation unavailable | Added canonical immutable names, clone handling and current consumed-claim helper. Mutation: returned the original credential array; RED asserted reference equality; restored clone using apply_patch | Same command — selected tests passed |

## Focused and affected validation

| Command | Result |
| --- | --- |
| npm run typecheck:runner-v2 | Passed: tsc -p runner-v2/tsconfig.json --noEmit. |
| npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts runner-v2/test/execution-grants.test.ts | Passed: 69 tests, 0 failures. |
| npx tsx --test runner-v2/test/execution-grants.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/one-shot-command-executor.test.ts | Passed: 106 tests, 0 failures. |
| npx eslint runner-v2/src/execution-grants.ts runner-v2/src/streaming-session-store.ts runner-v2/src/session-authority.ts runner-v2/src/interactive-process-channel.ts runner-v2/test/execution-grants.test.ts runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts | Passed with no output. |
| git diff --check 6eba9a1d5fa123a9808247624865c4f97b7bec25 -- | Passed (exit 0; only repository line-ending warnings). |

## Fake-state cleanup evidence

- Every new test-created state root is outside the project, created with mkdtemp, and has a finally block that closes any SQLite store and calls rm(..., { recursive: true, force: true }).
- Post-test scans returned no runner-v2-session-* roots and no runner-grant-* roots.
- The exact rerun of the SQLite-reopen test passed and did not create another transition root.
- One older task-owned root remains: C:\Users\b_a_s\AppData\Local\Temp\runner-v2-stream-store-transition-OIZwSE, containing only sessions.sqlite. Its source test has cleanup, and the current exact rerun cleaned its own root; this is stale prior state. I read/verified the exact target and attempted exact PowerShell deletion, but the host command policy rejected both the recursive directory deletion and exact file deletion. No workaround or broad deletion was attempted.

## Final self-review

- Diff scope is exactly the eight listed contract/test files; no production child family or Task 7 implementation file changed.
- New source references only the new streaming store from SessionAuthority. No existing family imports the new contracts.
- New modules do not invoke child-process APIs; they define fakes/contracts only.
- SessionAuthority never calls revoke/revokeAll; ToolBroker remains the grant revocation owner.
- Durable-key audit finds forbidden live/secret names only in the parser deny-set, not persisted fields.
- The public registry API exposes only actions/results, never an InteractiveProcessChannel instance.
- SQLite claim and mutation use SQL conflict/CAS conditions; parse/clone occurs on every public read.
- No exact Node patch pin, platform-specific behavior, raw-spawn fallback, real-child fixture, or broad process control was added.

## Remaining concerns / handoff

1. The code and specified focused/affected gates are green, but the host policy prevented removing the single verified stale Temp root described above. It should be removed manually or by an authorized cleanup mechanism before claiming the packet’s “temp state is empty” gate.
2. This was a sole-implementer packet under the no-subagent instruction. An independent reviewer has not yet supplied the brief-required zero Critical/Important review; route the committed diff to that reviewer before declaring PACKET 8.0A VERIFIED 100% COMPLETE.

## Fix Round 1 — review base `99aea024df90d55b08d574821ea527ee3eafd97b`

### Scope, files, and constraints

- This round addresses all eight Important findings in `task-8.0a-review-1.md`; it does not start 8.0B or migrate a production child family.
- Changed production files: `runner-v2/src/execution-grants.ts`, `runner-v2/src/session-authority.ts`, `runner-v2/src/streaming-session-store.ts`, and `runner-v2/src/interactive-process-channel.ts`.
- Changed focused tests: `runner-v2/test/execution-grants.test.ts`, `runner-v2/test/session-authority.test.ts`, `runner-v2/test/streaming-session-store.test.ts`, and `runner-v2/test/interactive-process-channel.test.ts`.
- No brief, progress ledger, review file, or controller evidence file was edited. No Git/MCP/LSP/managed/provider routing appears in this round’s diff.

### Finding-by-finding audit and TDD evidence

1. **ToolBroker-only expiry/revocation**
   - Regression: `observing expired consumed claims leaves exactly-once cleanup to ToolBroker revocation` registers an actual consumed-grant revoker, expires currentness, then proves `revoke()` runs cleanup once and only once.
   - RED: `npx tsx --test --test-name-pattern="observing expired consumed claims" runner-v2/test/execution-grants.test.ts` failed with `false !== true`: currentness had already changed the record to revoked, so ToolBroker could not run the revoker.
   - Minimum fix: `assertCurrentConsumedExecutionGrantClaims()` now only rejects expiry; it never changes lifecycle state. ToolBroker’s `revoke`/`revokeAll` remain the only path that changes state and runs registered revokers.
   - GREEN: the same command passed `1/1`.

2. **Exact SessionAuthority facts in interactive operations**
   - Regression: `carries the exact SessionAuthority binding and access assertion into an interactive write` constructs a real grant, transfer, acknowledgement, opaque operation authorization, full binding/access assertion, and invokes `SessionAuthority.assertOperationAuthorization` through the registry.
   - RED: `npx tsx --test --test-name-pattern="carries the exact SessionAuthority binding" runner-v2/test/interactive-process-channel.test.ts` failed with `TypeError: Cannot read properties of undefined (reading 'runId')`, proving the registry supplied only session/operation facts.
   - Minimum fix: write/control/family request types now require `SessionOperationAuthorization` plus the complete `OperationAuthorizationAssertion`; `authorize` receives both. Every family-facing gate verifies the request session/operation and delegates all exact binding/access facts to SessionAuthority. No out-of-band identity map was introduced.
   - GREEN: the same command passed `1/1`; the full interactive file subsequently passed.

3. **Per-delivery current authorization/fence validation**
   - Regressions: `stops family output delivery after ToolBroker revokes the source call`, `... grant expires`, `... fenced SessionAuthority takeover`, and `... lifecycle release` subscribe first, emit allowed bytes, then change current authority and assert later bytes are not delivered.
   - RED: `npx tsx --test --test-name-pattern="stops family output delivery" runner-v2/test/interactive-process-channel.test.ts` failed all three authority cases because the post-change byte remained in the delivery array.
   - Minimum fix: family subscription performs a current attachment/release/fence/full-SessionAuthority check for every backend callback and unsubscribes fail-closed on rejection.
   - GREEN: the same command passed `3/3`.
   - Mutation RED/revert for release: after adding the lifecycle-release case, I temporarily removed `current.released` from the callback guard. `npx tsx --test --test-name-pattern="stops family output delivery after lifecycle release" runner-v2/test/interactive-process-channel.test.ts` failed with `after-release` present. I restored the release guard with `apply_patch`; the exact command then passed `1/1`.

4. **Serialized writes and owned payload bytes**
   - Regression: `serializes overlapping writes and delivers a byte copy that survives caller mutation` blocks the first backend write, starts a concurrent duplicate sequence, mutates the caller buffer after invocation, then checks one backend start, one in-flight writer, one sequence reservation, and original delivered bytes.
   - Test-design correction: the first draft used sequence 2 and correctly failed immediately as out-of-order before exercising the race; I changed only the test to a concurrent duplicate sequence. No production code changed in that correction.
   - RED: `npx tsx --test --test-name-pattern="serializes overlapping writes" runner-v2/test/interactive-process-channel.test.ts` failed `2 !== 1`, proving both duplicate writes reached the backend.
   - Minimum fix: each attachment owns a settled write tail. `write()` snapshots scalar fields and copies the `Uint8Array` at API entry, serializes validation/backend work, reserves `nextSequence` before awaiting the acknowledgement, and marks an unknown outcome fail-closed.
   - GREEN: the same command passed `1/1`; delivered bytes remained `first` after caller mutation.

5. **Immutable, fenced attachment/reattachment and capability cleanup**
   - Regression: `clones attachment evidence and safely rejects stale attachment or reattachment without leaking channels` mutates caller binding/fence after attach and reattach, accepts a newer fence while detaching the displaced channel, rejects lower-fence attach/reattach, detaches their returned capabilities, and confirms the newer channel remains current.
   - RED: `npx tsx --test --test-name-pattern="clones attachment evidence" runner-v2/test/interactive-process-channel.test.ts` failed with `Interactive channel fence is stale` after caller mutation.
   - Minimum fix: attach/reattach clone and freeze exact binding/fence before provider calls; per-session attachment changes serialize; only a strictly newer fence may replace a live attachment; a replacement first releases the old channel; rejected/invalid/stale returned channels are detached or fail closed; release also serializes against attachment changes.
   - GREEN: the same command passed `1/1`.

6. **Durable ownership-lease enforcement**
   - Regressions: `rejects an expired durable session owner before issuing a new family authorization`; `requires ownership-lease expiry for takeover and refuses expired-owner durable mutations`. The latter covers pre-expiry takeover refusal, expiry-time owner mutation refusal, post-expiry takeover, and cleanup-state takeover refusal.
   - RED (authorization): `npx tsx --test --test-name-pattern="rejects an expired durable session owner" runner-v2/test/session-authority.test.ts` failed with `Missing expected exception`.
   - RED (reducer): `npx tsx --test --test-name-pattern="requires ownership-lease expiry" runner-v2/test/streaming-session-store.test.ts` failed with `Missing expected exception` for pre-expiry takeover.
   - Minimum fix: SessionAuthority checks `leaseExpiresAt` on issuing/asserting operation authorization. The reducer rejects an expired SessionAuthority owner’s mutation, permits takeover only after expiry from adopted non-cleanup states, rejects pre-expiry takeover, and requires a new takeover lease beyond the takeover time.
   - GREEN: both exact commands passed `1/1`.
   - Compatibility RED/revert: the established fenced-takeover tests now correctly failed with `lease_not_expired`. I changed their fake clocks/fixtures to reach the durable lease expiry before takeover, then reran `npx tsx --test runner-v2/test/session-authority.test.ts` (`19/19`) and `npx tsx --test runner-v2/test/streaming-session-store.test.ts` (`34/34` at that point) green.

7. **Strict effect owner/fence parser closure**
   - Regression: `rejects forged transfer and cleanup effect owner or fence evidence` now rejects forged pending transfer ownership/fence, forged active cleanup evidence, forged released cleanup owners, and still accepts a real provider-lease cleanup/release path.
   - RED: `npx tsx --test --test-name-pattern="rejects forged transfer and cleanup effect" runner-v2/test/streaming-session-store.test.ts` initially reported `Missing expected exception` for the forged transfer; later focused REDs reported missing released cleanup-owner rejection and then invalid provider-lease release while hardening the release-history check.
   - Minimum fix: pending/ambiguous effects require the exact ToolBroker owner/current fence; adopted transfer evidence requires ToolBroker ownership and a fence no newer than current; pending/blocked cleanup requires exact current cleanup owner/fence; released cleanup requires the owner implied by the state before cleanup and the exact current fence.
   - GREEN: the same exact command passed `1/1`. A first provider-release test draft omitted the required `acknowledge_ambiguous_transfer`; I corrected only that test transition before the final intended RED. No production change was hidden by the draft correction.

8. **Collision-safe session ID claim and pre-consumption authority check**
   - Store regression: `makes an exact session claim idempotent but rejects a semantic session-ID collision in memory and SQLite` checks same-identity idempotence and typed `identity_conflict` for changed immutable input on both backends.
   - RED: `npx tsx --test --test-name-pattern="makes an exact session claim idempotent" runner-v2/test/streaming-session-store.test.ts` failed with `Missing expected exception`.
   - Minimum fix: memory and SQLite claim paths compare canonical complete immutable identity before returning an existing record and throw typed `identity_conflict` on mismatch.
   - GREEN: the same command passed `1/1`.
   - SessionAuthority regression: `refuses a semantic streaming session-ID collision before consuming the new grant` first covers a different call and then a same-call/different-lease collision, proving both fresh grants remain consumable after typed `session_collision`.
   - REDs: `npx tsx --test --test-name-pattern="refuses a semantic streaming session-ID collision" runner-v2/test/session-authority.test.ts` first failed because the store `identity_conflict` escaped after consuming the grant; the extended same-call case then failed because `second_grant_for_call` was raised before semantic collision comparison.
   - Minimum fix: SessionAuthority reads an existing session and compares full immutable input identity before consumption and before call-key reuse checks; mismatch is typed `session_collision`, while store races remain typed at the store boundary.
   - GREEN: the same command passed `1/1`.

### Focused and affected validation (fresh after all fixes)

| Command | Result |
| --- | --- |
| `npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts runner-v2/test/execution-grants.test.ts` | Passed: `82` tests, `0` failures. |
| `npx tsx --test runner-v2/test/execution-grants.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/one-shot-command-executor.test.ts` | Passed: `107` tests, `0` failures. |
| `npm run typecheck:runner-v2` | Passed: `tsc -p runner-v2/tsconfig.json --noEmit`. |
| `npx eslint runner-v2/src/execution-grants.ts runner-v2/src/streaming-session-store.ts runner-v2/src/session-authority.ts runner-v2/src/interactive-process-channel.ts runner-v2/test/execution-grants.test.ts runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts` | Passed with no lint output. |
| `git diff --check 99aea024df90d55b08d574821ea527ee3eafd97b --` | Passed (exit `0`; only Git’s line-ending warnings). |

### Fake-state cleanup and final self-review

- Every fix-round temporary root was created by `mkdtemp` and removed in a `finally` block. The exact final read-only scan was: `$tempRoot = [System.IO.Path]::GetTempPath(); $leftovers = Get-ChildItem -LiteralPath $tempRoot -Directory | Where-Object { $_.Name -match '^(runner-grant-expiry-owner-|runner-v2-(channel-authority|channel-family-output|session-collision|session-expired-lease|session-stale-auth)-)' }; if ($leftovers) { $leftovers | Select-Object -ExpandProperty FullName; exit 1 }; 'No Task 8.0A fix-round temporary roots remain.'` It printed `No Task 8.0A fix-round temporary roots remain.`
- The controller separately removed the old stale temp root and recorded its evidence in `task-8.0a-controller-evidence.md`; that file was not recreated or modified here. This supersedes the historical stale-root concern above for this fix round.
- Diff audit: only the four 8.0A contract modules and four focused test files changed; no production family, Task 7 implementation, construction graph, Git/MCP/LSP/managed/provider routing, CLI, or child launch code changed.
- Safety audit: expiry no longer performs an independent revoke; every interactive family request has full opaque authorization facts; every delivered family byte rechecks current auth/fence; writes are serialized/copy-owned/nonreplayable; attachment state is cloned/fenced/cleanup-safe; durable lease and effect evidence are closed; exact identity collisions cannot alias a new grant request.

### Fix-round commits and concerns

- Production/tests plus this force-added report: `0f5b36a8` (`fix(runner): harden streaming session authority contracts`).
- This small report-hash follow-up is committed separately after recording the production hash; the final handoff lists both hashes.
- No unresolved implementation or validation concern remains. The packet still requires its prescribed independent review before the overall 8.0A reviewer exit gate may be claimed.

## Fix Round 2 — re-review base `b6baf5b457597739e4aa17257292265f2ecde62d`

### Scope and files changed

- This round addresses the sole remaining Important finding in `task-8.0a-rereview-1.md`: an expired adopted `cleanup_pending` effect could not be taken over or settled after host loss.
- Production changes are limited to `runner-v2/src/streaming-session-store.ts` and `runner-v2/src/session-authority.ts`.
- Focused test changes are limited to `runner-v2/test/session-authority.test.ts` and the existing lease-expectation adjustment in `runner-v2/test/streaming-session-store.test.ts`.
- No brief, review, progress-ledger, or controller-evidence file was edited. In particular, `task-8.0a-controller-evidence.md` was not recreated or modified. No 8.0B work, production family migration, Git/MCP/LSP/managed/provider routing, CLI, construction graph, or child launch code is in this diff.

### Finding audit — expired adopted pending cleanup recovery

- **Regression:** `recovers an expired adopted pending cleanup only after a new fenced owner takes over` creates a real opaque grant, adopted exact session, and a durable SessionAuthority-owned `cleanup-1` effect at fence `1`. It then models the pre-crash owner lease expiring and the startup owner taking fence `2`.
- **Protection before recovery:** before expiry the existing owner cannot take over (`lease_not_expired`); a wrong owner cannot acknowledge `cleanup-1` (`stale_fence`); at expiry a wrong owner cannot take over (`stale_fence`); the expired old owner cannot record another disposition (`lease_expired`) or invoke its recovery callback (`authorization_stale`, zero replay calls).
- **Minimum durable transition:** only an adopted `cleanup_pending` record with `cleanupOwner === "session_authority"` may now take a post-expiry `takeover`. The state remains `cleanup_pending`, the new owner/fence/lease replace only the durable ownership lease, and the existing `cleanup-1` effect remains its original fence `1`.
- **Parser/state closure:** a pending or released cleanup effect may have a fence at or below the current owner fence only to retain that exact already-created effect across a valid recovery takeover; its cleanup owner must still exactly match. `cleanup_blocked` remains exact-current-fence and is not takeover-eligible. SQLite durability still HMAC-verifies stored record bytes before parser acceptance.
- **Recovery authorization:** `recoverAdopted()` now checks the supplied owner/fence and current lease before calling the external replay callback. The new fence `2` can replay the existing `cleanup-1`/fence-`1` effect once, then acknowledge it to `released`; the pre-crash owner cannot replay it. A second recovery is refused, and neither the pending nor released state can issue launch/input/access authorization.
- **Compatibility assertion:** the older store test had asserted that an expiry-time pending-cleanup takeover was categorically `invalid_state`, which is the defect. It now preserves the intended pre-expiry refusal (`lease_not_expired`); the new SessionAuthority regression covers the only newly allowed post-expiry path.

### TDD / fault evidence

| Cycle | Exact command and observed result | Revert / minimum implementation | GREEN result |
| --- | --- | --- | --- |
| Natural RED for recovery hole | `npx tsx --test --test-name-pattern="recovers an expired adopted pending cleanup" runner-v2/test/session-authority.test.ts` — failed with `StreamingSessionStoreError: Only an adopted session without pending cleanup can be taken over.` The post-expiry recovery owner therefore could not settle the existing pending cleanup. | Added `cleanup_pending` to the existing adopted SessionAuthority takeover set after the durable lease-expiry check; kept it unavailable to provider-lease and blocked cleanup states. Preserved historic exact cleanup evidence through the existing effect instead of minting/replacing an effect. Added stale owner/fence plus lease validation before `recoverAdopted()` can call `replay`. | Same exact command — passed `1/1` after the minimal implementation, and again after adding the input/wrong-owner assertions. |
| Mutation RED/revert proving cleanup-pending eligibility is required | Temporarily removed `"cleanup_pending"` from the takeover-state set with `apply_patch`, then ran `npx tsx --test --test-name-pattern="recovers an expired adopted pending cleanup" runner-v2/test/session-authority.test.ts`. It failed `0/1`: the pre-expiry assertion received `StreamingSessionStoreError: Only an adopted streaming session can be taken over` instead of the required `lease_not_expired`, proving the cleanup state was being rejected before lease protection/recovery could apply. | Restored the sole `"cleanup_pending"` entry with `apply_patch`; no mutation was retained beyond the reviewed production change. | Same exact command — passed `1/1` (`9.8818ms`). |
| Existing expectation adaptation | After the production change, `npx tsx --test runner-v2/test/streaming-session-store.test.ts` reported one expected compatibility failure: `Missing expected exception` for the old assertion that a post-expiry pending-cleanup takeover must be `invalid_state`. | Replaced only that obsolete expectation with a pre-expiry pending-cleanup takeover at `00:01:30` expecting `lease_not_expired`; the new regression owns the required post-expiry recovery case. | Same store file — passed `34/34` before final full matrix. |

### Fresh focused and affected validation

| Command | Result |
| --- | --- |
| `npx tsx --test --test-name-pattern="recovers an expired adopted pending cleanup" runner-v2/test/session-authority.test.ts` | Passed `1/1` after restoring the mutation. |
| `npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts runner-v2/test/execution-grants.test.ts` | Passed `83` tests, `0` failures. |
| `npx tsx --test runner-v2/test/execution-grants.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/one-shot-command-executor.test.ts` | Passed `107` tests, `0` failures. |
| `npm run typecheck:runner-v2` | Passed: `tsc -p runner-v2/tsconfig.json --noEmit`. |
| `npx eslint runner-v2/src/streaming-session-store.ts runner-v2/src/session-authority.ts runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts` | Passed with no output. |
| `git diff --check b6baf5b457597739e4aa17257292265f2ecde62d --` | Passed (exit `0`; only Git line-ending warnings). |

### Fake-state cleanup, self-review, and handoff

- The new test creates `runner-v2-session-expired-cleanup-*` outside the repository with `mkdtemp` and removes it in `finally` using `rm(..., { recursive: true, force: true })`.
- Final read-only cleanup scan: `$taskTempRoot = [System.IO.Path]::GetTempPath(); $leftovers = @(Get-ChildItem -LiteralPath $taskTempRoot -Directory -Filter 'runner-v2-session-expired-cleanup-*' -ErrorAction SilentlyContinue); if ($leftovers.Count -gt 0) { $leftovers | Select-Object -ExpandProperty FullName; exit 1 }; Write-Output 'No runner-v2-session-expired-cleanup temporary roots remain.'` — output: `No runner-v2-session-expired-cleanup temporary roots remain.`
- Self-review: only a new post-expiry fenced SessionAuthority cleanup-recovery path is introduced. It cannot create input/access/relaunch authority because `authorizeLaunchOperation()` remains active-state-only; it cannot reopen generic expired-owner mutation; it cannot replay from the stale owner because validation occurs before the callback; it cannot transfer `cleanup_blocked`; and it preserves the sole truthful `session_authority` cleanup owner/effect until exact acknowledgement.
- Final diff and commit evidence are recorded immediately below after the final staged check and force-add of this ignored report.

### Fix Round 2 commits and concerns

- Production/tests plus this force-added report: `17d7844e` (`fix(runner): recover expired pending cleanup`).
- Report-hash follow-up: committed immediately after recording this production hash.
- No unresolved implementation or validation concern is known. The packet still requires the prescribed independent re-review before the overall 8.0A reviewer exit gate can be claimed.

## Fix Round 3 — re-review base `16e23e513e23eca86454a340a1e72f6b8f6b4ecb`

### Scope and linked-finding audit

- This round addresses both linked Important defects in `task-8.0a-rereview-2.md`: a recovered pending cleanup could not persist the `blocked` settlement, and the parser accepted any old cleanup fence without durable takeover provenance.
- Changed production files: `runner-v2/src/streaming-session-store.ts` and `runner-v2/src/session-authority.ts`. Changed focused tests: `runner-v2/test/streaming-session-store.test.ts` and `runner-v2/test/session-authority.test.ts`.
- No brief, review, progress ledger, controller evidence, 8.0B code, production child family, Git/MCP/LSP/managed/provider routing, CLI, construction graph, or child launch code was changed.
- **Atomic recovered cleanup takeover:** schema version `2` adds immutable cleanup-effect provenance: the stable effect ID, its original owner/fence, and a chronological chain of exact one-step `from` → `to` owner/fence transitions. A post-expiry adopted `cleanup_pending` takeover re-fences the existing effect atomically with the record owner/fence/lease update; it does not mint another cleanup effect or change its ID/kind/created time.
- **Closed parser:** version-2 cleanup effects require provenance. The parser checks the effect ID, origin, every contiguous fence step, timestamp order, final current owner/fence, and SessionAuthority ownership for any recovered chain. Pending, blocked, and released cleanup states again require the cleanup effect fence to equal the current record fence exactly. Version-1 records remain readable only under the pre-provenance strict-current-fence form; any reducer mutation upgrades to version 2. Historical version-0 terminal data remains supported when it retains its historical no-provenance effect shape.
- **Blocked settlement:** `recoverAdopted()` receives the re-fenced existing effect and uses the same current fence to mark it blocked. The durable `cleanup_blocked` state then parses, retains its sole SessionAuthority owner, and a later recovery returns that blocker without invoking the external callback again.

### TDD / fault evidence

| Cycle | Exact RED command and observed failure | Minimum implementation / revert | GREEN result |
| --- | --- | --- | --- |
| Cleaned recovered effect must use the new fence | `npx tsx --test --test-name-pattern="recovers an expired adopted pending cleanup" runner-v2/test/session-authority.test.ts` — failed `0/1` with `1 !== 2` at the re-fenced cleanup assertion. | Added an atomic cleanup-pending takeover branch that accepts only the expected expired SessionAuthority owner, advances its fence exactly one step, re-fences the existing cleanup effect, and records its origin/takeover chain. | Same exact command passed `1/1` (`13.5412ms`); the replay saw `cleanup-1` at fence `2`, released once, and a later recovery remained refused. |
| Recovered `blocked` settlement must survive | `npx tsx --test --test-name-pattern="durably blocks a re-fenced expired adopted cleanup" runner-v2/test/session-authority.test.ts` — failed `0/1` with `StreamingSessionStoreError: Streaming session cleanup effect ownership evidence is invalid` from `mark_cleanup_blocked` after the external callback ran. | Re-fencing makes the preserved effect equal the current fence before replay; strict current-fence parser rules are restored for pending, blocked, and released cleanup. | Same exact command passed `1/1` (`12.0963ms`): one replay persisted `cleanup_blocked`, and the next recovery made zero additional callback calls. |
| Durable provenance / SQLite parser closure | `npx tsx --test --test-name-pattern="persists exact re-fenced cleanup takeover provenance" runner-v2/test/streaming-session-store.test.ts` — failed `0/1` because `cleanup.cleanupProvenance` was `undefined`. | Added version-2 nested provenance parsing and consistency checks. The SQLite reducer persists the same effect ID/fence/provenance with its HMAC-protected row before reopen. | Same exact command passed `1/1` (`41.1515ms`), including SQLite reopen and parser refusals for an arbitrary old effect fence, missing provenance, forged origin, wrong final owner, fence jump, and altered effect ID. |
| Parser-provenance mutation / revert | Temporarily removed the `provenance.effectId !== cleanup.effectId` parser guard with `apply_patch`, then ran `npx tsx --test --test-name-pattern="persists exact re-fenced cleanup takeover provenance" runner-v2/test/streaming-session-store.test.ts`. It failed `0/1` with `Missing expected exception`, proving the altered-effect-identity variant could pass. | Restored the exact effect-ID guard with `apply_patch`; no mutation was retained. | Same exact command passed `1/1` (`35.7624ms`). |
| Versioned-test compatibility | The first combined store/authority run reported three expected compatibility failures because schema version `2` became current: old tests still treated version `2` as unsupported and tried to cast a version-2 provenance-bearing effect to historical version `0`. | Updated only those expected-version fixtures: current records use `2`, unsupported uses `3`, and the historical-terminal fixture removes the later provenance property. | `npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts` passed `56/56`. |

### Required-regression coverage

- The cleaned path validates pre-expiry and wrong-owner takeover refusal, generic expired-owner mutation refusal, stale pre-crash callback refusal, no input/access/relaunch authorization during pending or released cleanup, exact re-fenced replay, and exactly-once release.
- The blocked path validates the same exact effect identity at fence `2`, durable `cleanup_blocked`, and a later no-replay recovery.
- The SQLite parser test opens the same durable row after close and compares the full cleanup effect/provenance; it rejects arbitrary older fences, absent/forged provenance, wrong owner, non-contiguous fence jump, and mismatched effect identity.

### Fresh focused and affected validation

| Command | Result |
| --- | --- |
| `npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts runner-v2/test/execution-grants.test.ts` | Passed `85` tests, `0` failures. |
| `npx tsx --test runner-v2/test/execution-grants.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/one-shot-command-executor.test.ts` | Passed `107` tests, `0` failures. |
| `npm run typecheck:runner-v2` | Passed: `tsc -p runner-v2/tsconfig.json --noEmit`. |
| `npx eslint runner-v2/src/streaming-session-store.ts runner-v2/src/session-authority.ts runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts` | Passed with no output. |
| `git diff --check 16e23e513e23eca86454a340a1e72f6b8f6b4ecb --` | Passed (exit `0`; only Git line-ending warnings). |

### Fake-state cleanup and self-review

- Both new roots use `mkdtemp` outside the project and `finally` cleanup: `runner-v2-session-expired-cleanup-blocked-*` and `runner-v2-stream-cleanup-provenance-*`.
- The exact final read-only scan is rerun after this report is written and before staging. It includes both new prefixes and the existing expired-cleanup prefix; no deletion workaround or controller-evidence change is used.
- Review audit: the transition is atomic in both memory and SQLite writers; the effect ID remains `cleanup-1`; effect fence and record fence advance together; every provenance step is continuous and final-owner bound; old generic mutation/auth behavior remains closed; `cleanup_blocked` remains non-takeover-eligible; no family-facing input/access/relaunch surface is added.

### Fix Round 3 commits and concerns

- Production/tests plus this force-added report: `88f6059d` (`fix(runner): fence recovered cleanup effects`).
- Report-hash follow-up: committed immediately after the production hash is recorded.
- No unresolved implementation or validation concern is known. The independent 8.0A re-review exit gate remains required.

## Fix Round 4 — re-review base `e493b5757a46c5388aa02cdcde3caa16b3473bc1`

### Root cause, scope, and correction

- This round addresses the sole open Important finding and its linked durability warning from `task-8.0a-rereview-3.md`. No brief, review, ledger, controller evidence, 8.0B code, production family/runtime/CLI/backend adapter, Git/MCP/LSP/managed/provider routing, construction graph, or child launch code changed.
- Root cause: the version-2 parser initialized cleanup takeover validation from `cleanupProvenance.originOwnerId` and then compared the first transition only to that same caller-provided value. Changing both fields coherently therefore changed the root of trust and passed every continuity check.
- Schema version 3 adds a top-level immutable `cleanupCreationAuthority` fact containing the exact cleanup effect ID, owner ID, fence, and creation time. It is written atomically with `begin_cleanup`, is never re-fenced during takeover, is deep-frozen/cloned/digest-sensitive, and is cross-checked against both the immutable cleanup effect facts and the provenance origin before the transition chain is followed.
- The raw parser now rejects a missing anchor, a null anchor on a cleanup record, anchor/provenance owner mismatch, a coherent provenance-only owner forgery, coherent wrong-origin fencing, discontinuous owner or fence chains, changed effect identity, and absent provenance. A valid two-step fence-1 -> fence-2 -> fence-3 takeover remains accepted and preserves the same `cleanup-1` effect ID.
- SQLite still HMAC-verifies the complete durable row before parsing. The regression also changes the anchor, provenance origin, and first transition coherently in raw SQLite JSON without changing its integrity tag; reopen/read fails typed `invalid_record` before the forged row can be returned.
- Active version-2 records remain readable. On the next authenticated reducer mutation, an integrity-protected version-2 cleanup fact is upgraded to version 3 by deriving the immutable creation anchor from the already durable provenance/effect evidence. Historical version-0 terminal records remain readable only in their legacy no-anchor/no-provenance shape; active schema-0 downgrade and unsupported schema-4 behavior remain unchanged.
- The existing cleaned and blocked expired-cleanup authority regressions now use the real SQLite store. After takeover and settlement, they close/reopen SQLite and construct a fresh `SessionAuthority`: released cleanup refuses recovery without replay, while blocked cleanup returns the durable blocker without replay. Both callbacks execute exactly once before the first close.

### TDD and fault evidence

| Cycle | Exact RED and observed result | Minimum implementation / revert | Exact GREEN result |
| --- | --- | --- | --- |
| Independent cleanup-creation anchor and coherent forgery | `npx tsx --test --test-name-pattern="anchors multi-step cleanup takeover provenance and rejects coherent forgery" runner-v2/test/streaming-session-store.test.ts` failed `0/1` with `StreamingSessionStoreError: streaming session record has unknown field cleanupCreationAuthority`. The schema had no independent pre-takeover authority fact. | Added schema version 3, the top-level immutable creation fact, exact parser, state cross-check, reducer creation, and SessionAuthority initial `null` fact. The test covers missing/null anchor, coherent two-field owner forgery, anchor mismatch, coherent wrong origin fence, owner/fence discontinuity, changed effect ID, absent provenance, valid multi-step takeover, and SQLite HMAC tamper refusal. | Same exact command passed `1/1` (`47.4015ms` on the first GREEN; `46.6478ms` after the required mutation revert; fresh focused rerun `47.9522ms`). |
| Required anchor-cross-check mutation / revert | Temporarily removed only `cleanupCreationAuthority.ownerId !== provenance.originOwnerId` with `apply_patch`. The exact coherent-forgery command failed `0/1` with `AssertionError: Missing expected exception`, proving the reviewer’s two-field forgery passed without the independent-anchor cross-check. | Restored that exact owner cross-check with `apply_patch`; no mutation remains. | Same exact command passed `1/1` (`46.6478ms`). |
| Version-2 recovery-safe upgrade | `npx tsx --test --test-name-pattern="upgrades integrity-protected version-2 cleanup evidence" runner-v2/test/streaming-session-store.test.ts` failed `0/1` with `StreamingSessionStoreError: streaming session record is missing required field cleanupCreationAuthority` during takeover. | Added one normalization path used by every version-upgrading reducer mutation. For authenticated legacy cleanup it derives the creation fact from the existing immutable effect/provenance origin; no effect ID, ownership chain, access, input, or relaunch state changes. | Same exact command passed `1/1` (`23.5367ms`). |
| SQLite terminal SessionAuthority recovery coverage | The reviewer identified that both existing regressions used the in-memory store. The two tests were changed before further implementation to use SQLite, close/reopen after settlement, and create a fresh `SessionAuthority`. The shared reducer already had the correct terminal behavior, so these permanent coverage additions were GREEN without a production change. | `cleaned` asserts one `cleanup-1` callback, durable `released`, reopen recovery refusal, and zero reopened callbacks. `blocked` asserts one callback, durable `cleanup_blocked`, reopened blocker return, and zero later callbacks. | `npx tsx --test --test-name-pattern="recovers an expired adopted pending cleanup|durably blocks a re-fenced expired adopted cleanup" runner-v2/test/session-authority.test.ts` passed `2/2` (`49.8326ms`, `35.9987ms` on the first SQLite run; fresh rerun passed `2/2`). |

### Fresh validation

| Command | Result |
| --- | --- |
| `npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts` | Passed `57` tests, `0` failures. |
| `npx tsx --test runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts runner-v2/test/interactive-process-channel.test.ts runner-v2/test/execution-grants.test.ts` | Passed `86` tests, `0` failures. |
| `npx tsx --test runner-v2/test/execution-grants.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/one-shot-command-executor.test.ts` | Passed `107` tests, `0` failures. |
| `npm run typecheck:runner-v2` | Passed: `tsc -p runner-v2/tsconfig.json --noEmit`. |
| `npx eslint runner-v2/src/streaming-session-store.ts runner-v2/src/session-authority.ts runner-v2/test/streaming-session-store.test.ts runner-v2/test/session-authority.test.ts` | Passed with no output. |
| `git diff --check e493b5757a46c5388aa02cdcde3caa16b3473bc1 --` | Passed (exit `0`; only Git line-ending warnings). |

### Cleanup and fix-only self-review

- Every new/strengthened SQLite test uses a task-owned `mkdtemp` root outside the repository and closes stores before `rm(..., { recursive: true, force: true })` in `finally`.
- Final read-only scan covered `runner-v2-stream-cleanup-provenance-*`, `runner-v2-stream-cleanup-v2-upgrade-*`, `runner-v2-session-expired-cleanup-*`, and `runner-v2-session-expired-cleanup-blocked-*`; output was `No Task 8.0A Fix Round 4 temporary roots remain.`
- Fix-only diff before the report contained exactly `runner-v2/src/streaming-session-store.ts`, `runner-v2/src/session-authority.ts`, `runner-v2/test/streaming-session-store.test.ts`, and `runner-v2/test/session-authority.test.ts`. The only existing production import remains `interactive-process-channel.ts` importing SessionAuthority; no child family imports the streaming store or new anchor.
- The same cleanup effect ID is retained across every re-fence and terminal settlement. The record owner/fence, cleanup effect fence, and takeover append remain one reducer result and one SQLite CAS/HMAC row update. Stale/pre-expiry/wrong-owner refusal and lease expiry checks execute before mutation or callback.
- The anchor adds no opaque grant, token, payload, port, live handle, input, access expansion, or relaunch authority. `cleanup_pending`, `cleanup_blocked`, and `released` remain unavailable to launch/family authorization, and generic expired-owner mutation remains closed.

### Fix Round 4 commits and concerns

- Production and regression tests: `a9550821` (`fix(runner): anchor cleanup takeover authority`).
- This force-added report evidence is committed separately immediately after this section; the final handoff lists its exact hash.
- No unresolved implementation or validation concern is known. The prescribed independent re-review remains the only 8.0A exit gate before 8.0B may begin.
