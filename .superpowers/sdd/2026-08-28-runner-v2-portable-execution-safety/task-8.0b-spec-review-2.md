# Task 8.0B Revised Specification and Architecture Re-review

## Verdict

**APPROVED.** All five prior Important findings are addressed. The revisions introduce no new Critical or Important ambiguity. Two Minor terminology clarifications are recommended but do not block 8.0B1.

## Prior-finding verdicts

### 1. Mandatory one-shot staged grant contract — ADDRESSED

The revised brief makes staging unconditional. `stageLaunch()` consumes the opaque grant exactly once before the first isolation/provider effect, reserves the call/session/launch identity, retains frozen claims, and returns only Runner-private WeakMap-backed authority (`task-8.0b-brief.md:69-74`). `finalizeLaunch()` is one-shot, binds the exact lease/backend/envelope/handshake/session, seeds the launching-call claims without a second grant consumption, and refuses reuse, revocation/expiry, or identity/envelope mismatch (`task-8.0b-brief.md:74-82`). `beginTransfer()` is explicitly a compatibility wrapper over the same state machine rather than an alternate consumption path (`task-8.0b-brief.md:79-82`).

B1 owns the contract before real adapters exist, and its faults cover consumption before effects, revoker timing, duplicate/collision behavior, and crashes through transfer acknowledgement (`task-8.0b-brief.md:169-183`, `task-8.0b-brief.md:195-205`). This closes the mismatch with the approved 8.0A API, whose legacy `beginTransfer()` requires lease/binding and consumes the grant (`runner-v2/src/session-authority.ts:45-52`, `runner-v2/src/session-authority.ts:205-224`).

### 2. Single durability boundary and atomic adoption owner swap — ADDRESSED

The brief now mandates one streaming-session storage kernel and transactional boundary, explicitly forbidding a separate/best-effort handoff store (`task-8.0b-brief.md:50-68`). It defines the monotonic host lifecycle, deterministic effect identities, pre-isolation prepared commit, pre-launch journaling, fenced lease/binding transitions, and cleanup/block branches (`task-8.0b-brief.md:83-90`).

`commitAdoption()` is one transaction that validates staged and durable identities/revisions, creates the exact acknowledged SessionAuthority record, and changes the host row to inert `handed_off`/owner `none` (`task-8.0b-brief.md:91-102`). The brief states the authoritative owner before and after the transaction, collision rollback, idempotent replay, impossible-pair quarantine, and construction refusal when atomicity is unavailable. B1 crash/reopen tests now require proof of the authoritative owner at every lifecycle revision (`task-8.0b-brief.md:202-205`). This is executable and eliminates ownerless/double-owner windows.

### 3. Per-stream replay/checkpoint/acknowledgement protocol — ADDRESSED

The revised v2 capability specifies per-stream sequences and cumulative offsets, explicit protocol-bearing streams, Runner-to-provider acknowledgement, a capacity-bounded retained provider replay window, and upstream backpressure when full (`task-8.0b-brief.md:109-118`). It also defines the durable accepted window, single consuming intent, consumed checkpoint, and equal declared metadata/replay capacities without persisting bytes (`task-8.0b-brief.md:131-149`).

Ordering is closed: validate continuity → durably commit accepted → queue owned bytes without ack → durably commit consuming intent before parse/effect → authorized parse/delivery → atomically advance consumed/remove accepted/clear intent → acknowledge provider (`task-8.0b-brief.md:136-145`). Duplicate suppression after consumed commit, ambiguous consuming intent, replay inability, sequence/offset/digest mismatch, and evidence-only acknowledgement are all assigned exact outcomes. B1 now requires crash/reopen faults around every checkpoint, queue, delivery, commit, and acknowledgement boundary (`task-8.0b-brief.md:208-217`).

### 4. B3 internal MCP discovery versus Task 8.2 ownership — ADDRESSED

B3 now owns one explicitly narrow `McpDiscoveryExecutor` under a closed internal principal. It may perform only initialize plus `tools/list`, record exact digests, close/clean, and cannot call tools, return a manager, or expose a channel (`task-8.0b-brief.md:309-317`). Construction order places it after per-run binding and recovery and before public facades/models (`task-8.0b-brief.md:318-322`).

The brief explicitly carves this prerequisite executor out from otherwise behavior-neutral public MCP/LSP/managed construction, while assigning lazy live servers, external requests, restarts, public status/tools, and manager close semantics to Task 8.2 (`task-8.0b-brief.md:323-350`). This is consistent with the governing parent’s required closed internal MCP discovery purpose (`task-8-brief.md:204-209`).

### 5. Independent portable/batch/tree/Job semantic probes — ADDRESSED

B2 now requires independent probe facts for portable exact launch/duplex, argv-only batch launch, exact tree ownership/birth re-attestation, and Job-backed stronger containment. Product selection consumes each fact independently and cannot infer semantics from a host/module name (`task-8.0b-brief.md:240-247`).

Batch compatibility is explicitly independent of active Job assignment: verified portable and batch behavior remains available without Job; an unattested batch capability fails only that batch request before launch, without disabling other verified portable launches (`task-8.0b-brief.md:251-257`). The required test matrix covers unavailable/partial/verified combinations and proves portable/batch behavior without Job (`task-8.0b-brief.md:270-284`). This preserves optional Job enhancement without turning it into a hidden Windows prerequisite.

## New Critical/Important ambiguity check

### Critical

None.

### Important

None.

The B1 → B2 → B3 split remains dependency-correct: B1 closes contracts and fake state machines; B2 supplies real host/channel implementations behind those contracts; B3 supplies strict OCI, single-host/per-run construction, and real cross-component recovery/concurrency fixtures (`task-8.0b-brief.md:165-226`, `task-8.0b-brief.md:228-291`, `task-8.0b-brief.md:293-380`). No acceptance criterion is impossible after the revisions, and unavailable Docker/non-current adapters remain truthfully handled without weakening production semantics (`task-8.0b-brief.md:286-291`, `task-8.0b-brief.md:370-376`).

## Minor issues

1. **“Non-copyable” is not literal for a JavaScript object reference.** The security semantics are nevertheless clear because the staged authorization is non-forgeable, private, WeakMap-backed, and one-shot (`task-8.0b-brief.md:69-82`). Prefer “non-serializable/non-reconstructable and alias-safe one-shot” in implementation documentation and tests.

2. **Phase/effect vocabulary could be normalized.** The durable model names three prepared effects—`isolate`, `launch`, and `handoff`—and represents bind/handshake as fenced lifecycle transitions (`task-8.0b-brief.md:83-100`), while a B1 fault calls prelaunch/launch/bind/handshake/transfer each an “effect” (`task-8.0b-brief.md:197-205`). Tests should follow the normative lifecycle/effect names and verify exactly one consumer per actual effect plus exactly one transition per bind/handshake phase.

## Final assessment

**Specification compliance: Compliant. Architecture quality: APPROVED.** Zero Critical or Important ambiguity remains. Internal packet 8.0B1 may begin under the revised brief, with the two Minor wording clarifications handled during implementation documentation/test naming.
