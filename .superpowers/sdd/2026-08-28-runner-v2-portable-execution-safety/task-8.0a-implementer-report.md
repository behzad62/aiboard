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
