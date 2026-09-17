# Task 8 Exact Re-review 3

## Verdict

**NOT APPROVED — the three amended behaviors are semantically sound, but one Important packet-order contradiction and one Important evidence ambiguity remain.**

This review was restricted to the three findings in `task-8-spec-review-2.md`. No other Task 8 requirement was reopened.

## 1. Host crash before SessionAuthority transfer

**Behavior: VERIFIED.**

Lines 113–126 now distinguish:

- an in-process pre-transfer failure owned by ToolBroker's live revoker;
- a Runner-host crash owned solely by the durable provider/lease startup-recovery claim;
- a post-acknowledgement crash owned by SessionAuthority; and
- an ambiguous transfer that may only clean or durably block the exact owned child/lease.

The text correctly forbids input exposure, broader adoption, and relaunch during ambiguous recovery. Lines 153–156 also name the required host-crash fixture and its exact residue assertions.

## 2. Kernel-only output draining and terminal observation

**Behavior: VERIFIED.**

Lines 86–99 now clearly separate kernel lifecycle activity from family/model activity:

- fenced terminal observation and bounded raw-output draining may continue between calls;
- drained bytes stay in private protocol/evidence queues;
- no unauthorised input, protocol dispatch/response, family-state mutation, or byte exposure is allowed; and
- every family subscription, parse/delivery, input, control, and response still needs a current `SessionOperationAuthorization`.

Lines 156–159 name the persistent-child fixture and require bounded draining/observation while delivery and writes remain unauthorized.

## 3. Managed cancellation matrix

**Behavior: VERIFIED.**

Lines 356–365 correctly distinguish:

- cancellation of `process.start` before a successful response, which stops and verifies the child;
- cancellation after durable stop intent, which cannot interrupt cleanup; and
- cancellation of output polling/observation, which cancels only that read and never terminates the child.

The text also correctly removes protocol-idleness semantics from arbitrary managed children and forbids recovery relaunch without a fresh grant.

## Important finding 1 — Real runtime fixtures are assigned to contract-only 8.0A

The new host-crash and persistent-child fixtures are placed in **8.0A RED/GREEN acceptance** at lines 153–159. However, 8.0A is explicitly contract-only, while `StreamingProcessSessionRuntime.open()`, nonblocking recovery, output draining, adapters, and the production kernel are not implemented until 8.0B at lines 161 onward.

The persistent-child fixture cannot prove “bounded kernel draining and terminal observation” before that kernel exists. A real host-crash fixture that verifies process/input-endpoint cleanup also depends on the 8.0B runtime/adapters. This makes the 8.0A exit gate impossible without prematurely implementing 8.0B scope.

### Exact required edit

- Keep contract/fake-provider crash-transition tests in 8.0A.
- Move the real Runner host-crash fixture from lines 153–156 and the persistent-child draining fixture from lines 156–159 into **8.0B RED/GREEN acceptance**.
- State that 8.0A proves the closed state machine with fake claims/backends, while 8.0B proves the same transitions using the real streaming kernel and owned process/input resources.

This preserves the mandatory 8.0A → 8.0B packet boundary.

## Important finding 2 — The required three managed cancellation tests are not explicit

Lines 378–380 require “separate start/stop/output-poll cancellation dispositions,” but do not unambiguously require three distinct prove-RED/revert/GREEN tests. The requested gate was specifically one test for each operation, because combining them can hide a shared cancellation path that incorrectly terminates the child.

### Exact required edit

Replace that phrase with:

> three distinct prove-RED/revert/GREEN cancellation tests: (1) `process.start` cancellation before successful response stops and verifies empty; (2) `process.stop` cancellation after durable stop intent does not interrupt cleanup; and (3) output-poll/observation cancellation cancels only the read and leaves the exact managed child running and owned.

## Newly introduced contradiction check

The only newly introduced contradiction is the placement of real runtime fixtures in contract-only 8.0A. No contradiction was introduced into:

- sole durable cleanup ownership before transfer;
- kernel-only background draining versus authorised family delivery; or
- the managed start/stop/read cancellation dispositions themselves.

## Approval gate

Move the two real runtime fixtures to 8.0B and name the three managed cancellation tests explicitly. After those exact edits, these three reviewed areas have zero Critical/Important ambiguity and the brief can be approved without another architectural redesign or user decision.
