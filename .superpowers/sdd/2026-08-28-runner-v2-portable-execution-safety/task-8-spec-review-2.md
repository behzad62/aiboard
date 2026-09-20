# Task 8 Final Narrow Specification Re-review

## Verdict

**NOT APPROVED — three Important ambiguities remain in the four requested residual areas.**

The amended brief resolves the earlier first-call grant double-use problem, defines the access-envelope relationships, introduces current per-operation authorization, separates the two internal principals, and adds termination/recovery rules to MCP, LSP, and managed sessions. It is close to executable. Approval is withheld because the remaining text still permits contradictory implementations of host-crash cleanup, background output observation, and managed-operation cancellation.

No user authority decision is required. Each finding below has a technically determinate edit.

## Scoped results

| Residual area | Result | Evidence |
|---|---|---|
| 1. ToolBroker-owned first-call grant lifecycle and crash/relaunch | **Partial** | Lines 77–114 correctly keep the opaque grant ToolBroker-owned, consume it once, use its validated claims for the first post-adoption request, forbid a second grant in the call, and defer relaunch to a later call. The pre-transfer host-crash cleanup owner is still incomplete. |
| 2. Envelope relationships and `SessionOperationAuthorization` | **Partial** | Lines 86–106 correctly define `sessionEnvelope.access ⊆ launchGrant.access`, `requestAccess ⊆ sessionEnvelope.access`, separate credential/network/path comparisons, and require current authorization for family operations. Lines 86 and 92–93 conflict over background observation/output draining. |
| 3. Closed Git-preflight and MCP-discovery principals | **Verified** | Lines 190–195 define exactly two distinct purposes, identities, least envelopes, timeouts, cleanup, prohibit MCP tool invocation during discovery, and prohibit any other internal child-launch principal. No conflict found. |
| 4. MCP/LSP/managed termination and recovery | **Partial** | MCP lines 264–269 and LSP lines 302–307 are executable. Managed lines 338–343 apply protocol-idleness logic to an arbitrary background process and do not distinguish cancellation of start, stop, and read/observe operations. |

## Important finding 1 — Pre-transfer host crash has no stated durable cleanup owner

Lines 107–108 state that a crash before transfer is cleaned through ToolBroker's “still-live” revoker. That is true for an in-process failure, but not when the Runner host itself crashes: ToolBroker and its in-memory revoker are then gone. The construction order later recovers leases, but the required ownership rule should not depend on inference.

### Exact required edit

Replace the first two sentences of the crash bullet with:

> A failure before transfer is cleaned through ToolBroker's live call revoker. If the Runner host dies and that revoker cannot run, the durable provider/lease claim remains the sole startup-recovery cleanup owner; reconciliation must identify the unadopted pending transfer, clean or durably block it, and never treat it as an adopted session. A crash after the durable transfer acknowledgement is recovered through SessionAuthority. Recovery of an ambiguous transfer is fenced and fail-closed: it may clean the exact owned child/lease but may not expose input, adopt broader authority, or relaunch.

Add a focused crash fixture that terminates the Runner between lease acquisition and transfer acknowledgement, restarts it, and proves exactly one cleanup transition with no residual lease, process, input endpoint, or fabricated adopted session.

## Important finding 2 — Background observation authorization is contradictory

Line 86 says adopted SessionAuthority permits observation. Lines 88–93 require authorization for every family-facing live-output operation and then say only recovery and cleanup may operate without model-call authorization. Persistent children nevertheless require kernel-owned terminal observation and bounded raw-output draining between calls; otherwise a child can block on stdout/stderr and the runtime cannot detect exit. This must not authorize model-visible output delivery or protocol input, but it must be allowed without an active ToolBroker call.

### Exact required edit

Replace the final sentence at lines 92–93 with:

> Only fenced Runner recovery, cleanup, terminal observation, and bounded raw-output draining into the private protocol/evidence queues may run without a model-call authorization. Those lifecycle operations may not write input, dispatch a protocol request, acknowledge a server-originated action, expose bytes to a family/model, or mutate family protocol state. Every family subscription, parse/delivery action, input/control operation, and protocol response still requires a current `SessionOperationAuthorization`.

Add an acceptance test that leaves a persistent child running between ToolBroker calls, fills stdout beyond the in-memory tail, and proves the kernel continues bounded draining/terminal observation while family delivery and all writes remain unauthorized.

## Important finding 3 — Managed cancellation incorrectly uses protocol-idleness semantics

Managed lines 338–343 copy the MCP/LSP “protocol idleness” rule. A managed child is an arbitrary background process and may have no protocol or provable idle state. The current wording can also make cancellation of a harmless output poll terminate the background process, weakening established durable-managed behavior.

### Exact required edit

Replace the managed termination bullet with:

> Close a managed session on owning agent-session or run termination, configuration/executable/schema/envelope replacement, invalid ownership authorization, or explicit authenticated stop. Cancellation is operation-specific: cancellation of `process.start` before its successful response stops the adopted child and verifies exact emptiness; once a stop intent is durably accepted, cleanup continues despite caller cancellation; cancellation of output polling or observation cancels only that read/observation and never terminates the managed child. Arbitrary managed children have no protocol-idleness exemption. Startup recovery may observe or clean an existing exact child but never relaunch it without a fresh grant.

Add three separate cancellation tests for start, stop, and output polling to prove these dispositions.

## Newly introduced contradictions

Two contradictions were introduced by the residual edits:

1. SessionAuthority is permitted to observe at line 86, while lines 92–93 permit only recovery/cleanup without a current call. The exact edit above separates kernel lifecycle draining from family-visible output operations.
2. Protocol-idleness retention is appropriate for MCP/LSP but is applied to protocol-agnostic managed children. The exact managed cancellation matrix above removes that ambiguity.

No contradiction was found in the revised ToolBroker ownership rule, envelope set relations, first-call claim reuse, later-call relaunch rule, or the two closed internal principals.

## Approval gate

After the three exact edits and their focused tests are assigned in the brief, the four residual areas will be architecturally executable without a Critical/Important ambiguity. Until then, implementation should not begin.
