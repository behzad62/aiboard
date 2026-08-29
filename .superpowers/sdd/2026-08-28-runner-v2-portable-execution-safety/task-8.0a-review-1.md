# Task 8.0A review 1

## Spec Compliance verdict: Needs fixes

Packet 8.0A is not specification-compliant. The diff stays within the intended contract/fake-provider scope and preserves the Task 7 terminal implementation surfaces, but it has verified gaps in ToolBroker-only revocation, exact/current family authorization, ordered write safety, fencing, parser closure, and collision-safe durable transfer. The required zero-Critical/Important exit gate is therefore not met, and packet 8.0B may not begin on this review.

## Strengths

- The change is scoped to new Runner-private contract/store modules, fake tests, and backward-compatible execution-grant additions. It does not add a real child family, production runtime, CLI graph, backend adapter, raw-spawn fallback, or exact Node patch pin.
- Streaming records are separate from Task 7 terminal process state. The SQLite store uses an integrity MAC and revision-CAS update (`runner-v2/src/streaming-session-store.ts:272-330`), and public reads reparse/deep-clone records.
- The record parser rejects unknown nested fields and explicit secret/live-capability key names (`runner-v2/src/streaming-session-store.ts:360-404`, `runner-v2/src/streaming-session-store.ts:411-592`).
- Session operation tokens are opaque WeakMap-backed objects and the authority assertion checks operation, call binding, access claims, durable owner, and fence (`runner-v2/src/session-authority.ts:337-371`, `runner-v2/src/session-authority.ts:635-659`).
- The durable reducer separates pending, ambiguous, adopted, stopping, cleanup, unavailable/outcome-unknown, and released states, and SQLite capacity failures retain existing records.

## Issues by severity

### Critical

None found.

### Important

1. **Grant expiry is performed outside ToolBroker and can permanently skip registered cleanup revokers.** `assertCurrentConsumedExecutionGrantClaims()` changes a consumed grant record to `revoked` when its clock reaches `expiresAt` but does not run `record.revokers` (`runner-v2/src/execution-grants.ts:304-315`). A later ToolBroker `revoke()` sees the already-revoked state and returns `false` before `runRevokers()` (`runner-v2/src/execution-grants.ts:201-208`). SessionAuthority calls this helper from authorization paths (`runner-v2/src/session-authority.ts:662-667`). Thus a mere currentness assertion can independently revoke ToolBroker-owned material and suppress its exactly-once live cleanup, contrary to the binding ToolBroker-only lifecycle rule. The expiry test verifies only that authorization is rejected and never registers or checks a cleanup revoker (`runner-v2/test/session-authority.test.ts:453-501`).

2. **The interactive registry cannot enforce the required exact call/access authorization.** Its authorization callback receives only `{ sessionId, operation }` (`runner-v2/src/interactive-process-channel.ts:76-80`), and write/control/family requests do not carry the exact execution-grant binding or checked path/credential/network/external/destructive access needed by `SessionAuthority.assertOperationAuthorization()` (`runner-v2/src/interactive-process-channel.ts:99-123`; compare `runner-v2/src/session-authority.ts:121-130`, `runner-v2/src/session-authority.ts:337-371`). `assertAuthorization()` consequently delegates to an arbitrary boolean with insufficient expected facts (`runner-v2/src/interactive-process-channel.ts:404-412`). A long-lived multi-session registry cannot faithfully wire the non-forgeable, exact run/actor/agent-session/tool/call/access contract without an out-of-band confused-deputy-prone map or per-call registry. The tests mask this gap with object-identity predicates such as `candidate === authorization` (`runner-v2/test/interactive-process-channel.test.ts:211-240`).

3. **Family output delivery is authorized only once, so revoked, expired, or takeover-stale capabilities continue receiving bytes.** `subscribeFamilyOutput()` checks authorization and fence at subscription creation, then installs `request.deliver` directly inside a bounded sink (`runner-v2/src/interactive-process-channel.ts:307-315`). Every later backend output callback bypasses `options.authorize` and the current fence. This violates the requirement that every family delivery action carry a current authorization and permits model/family byte exposure after ToolBroker revocation, grant expiry, session disposition, release, or fenced takeover. The test emits only while the original authorization remains valid and has no post-revocation/takeover delivery assertion (`runner-v2/test/interactive-process-channel.test.ts:211-240`).

4. **Writes are not serialized and payload integrity is vulnerable to a post-check mutation.** `write()` checks `current.nextSequence`, then awaits the backend before incrementing it (`runner-v2/src/interactive-process-channel.ts:224-265`). Two concurrent calls with the same sequence can both pass and both reach the backend, after which `nextSequence` advances twice. The method also hashes the caller-owned `Uint8Array` and passes that same mutable object to an asynchronous backend (`runner-v2/src/interactive-process-channel.ts:239-253`), so a caller can mutate bytes after validation but before backend consumption, making delivered bytes disagree with the attested digest. The sequential duplicate test does not exercise either race (`runner-v2/test/interactive-process-channel.test.ts:275-307`). This breaks ordered, digest-bound, nonreplayable input semantics.

5. **Channel attachment fencing is mutable and stale attach/reattach can replace a newer live channel.** Both attach paths store caller-owned `binding` and `fence` objects by reference and unconditionally `set()` the session entry (`runner-v2/src/interactive-process-channel.ts:171-190`, `runner-v2/src/interactive-process-channel.ts:192-222`). There is no existing-attachment/current-fence comparison or detach of the displaced capability. A caller can mutate the retained fence after attachment, defeating the later equality check (`runner-v2/src/interactive-process-channel.ts:229-231`), or a stale acquisition can overwrite a newer fenced attachment and leak the displaced live channel. This contradicts exact immutable binding/fence acquisition and stale-fence refusal.

6. **The durable SessionAuthority ownership lease is recorded but never enforced.** `beginTransfer()` creates `leaseExpiresAt` (`runner-v2/src/session-authority.ts:216-225`) and takeover replaces it (`runner-v2/src/session-authority.ts:263-275`), but authorization currentness checks only active state, owner/fence equality, identity, and grant currentness (`runner-v2/src/session-authority.ts:358-371`). The reducer likewise accepts mutations based on revision/owner/fence without checking the ownership lease clock (`runner-v2/src/streaming-session-store.ts:807-843`). An expired owner can therefore continue authorizing family operations and mutating durable state until some separate takeover happens, while takeover itself is not conditioned on expiry. This defeats the meaning of the durable fenced lease and the requirement for exact *current* authority.

7. **The strict parser accepts forged effect ownership/fence combinations.** `parseEffects()` validates effect owner and fencing token only as independently well-typed values (`runner-v2/src/streaming-session-store.ts:616-660`). `assertStateCombination()` then checks record cleanup ownership and effect status, but never requires the pending transfer effect to be ToolBroker-owned or its fence to match the record (`runner-v2/src/streaming-session-store.ts:665-724`). For example, a `pending_transfer` record with `cleanupOwner: "tool_broker"` but a pending transfer effect owned by `session_authority` at fencing token 99 passes. That is an invalid ownership/evidence combination under the closed schema and undermines exact effect replay. The purported “exact pending transfer effect” test checks only the absence of the effect, not forged owner/fence values (`runner-v2/test/streaming-session-store.test.ts:83-87`).

8. **A session-ID collision consumes a new grant but silently returns an unrelated durable record as if transfer began.** Both stores return any existing same-ID record with `won: false` without checking semantic identity (`runner-v2/src/streaming-session-store.ts:197-216`, `runner-v2/src/streaming-session-store.ts:293-313`). `SessionAuthority.beginTransfer()` has already consumed and reserved the grant, retains claims only on `won`, but hides `won` and returns the existing record unconditionally (`runner-v2/src/session-authority.ts:203-249`). A collision with another run/call/lease/binding can therefore appear successful to the caller without transferring the requested exact immutable authority; the newly consumed call cannot retry. Exact identity mismatch must fail typed rather than alias an existing session.

### Minor

None reported; the Important issues are dispositive.

## Assessment

**Task code quality: Needs fixes.** The modules are focused and the intended separation is clear, but the concurrency, authorization-currentness, cleanup, and parser-integrity defects above are merge-blocking.

**Specification compliance: Needs fixes.** There are real gaps in requirements 3, 5, 6, 9, 10, 12, and 13. The exit phrase `PACKET 8.0A VERIFIED 100% COMPLETE — PACKET 8.0B MAY BEGIN` is not warranted.

⚠️ The reported test, lint, typecheck, diff-check, and RED/revert/GREEN executions cannot be independently proven from the supplied final diff; they are prose evidence in the implementer report rather than raw logs. I did not rerun the reported suite because the verified code defects above already decide the gate. The controller evidence does resolve the reported stale-temp-root caveat.
