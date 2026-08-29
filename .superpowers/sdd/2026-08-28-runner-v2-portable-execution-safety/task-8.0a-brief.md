# Task 8.0A implementation brief — session authority and durable streaming contracts

## Position and authority

- This is the first executable packet of canonical Task 8 in
  `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md`.
- Entry base: `a0b3fb7a`.
- The approved Task 8 architecture is recorded in `task-8-brief.md`; this file
  is the complete, focused implementation authority for packet 8.0A.
- Only one implementer may modify the protected shared execution interfaces.
- Node policy is maintained Node 22 or 24; never add an exact patch pin.

## Purpose

Define and prove the Runner-private durable authority/state contracts required
for long-lived child sessions before any streaming runtime, backend channel,
construction graph, or production child family is migrated.

## Exact scope

1. Preserve the terminal `ProcessBackend`, `SubprocessRuntime`,
   `OneShotCommandExecutor.execute()`, `DurableProcessStore`, and Task 7 result/
   state schemas and behavior. Backwards-compatible interface additions are
   allowed; a persistent session must never enter terminal
   `SubprocessRuntime.reconcileStartup()`.
2. Add a separate, versioned Runner-private streaming-session record kind,
   closed state machine, parser, clone/digest behavior, and durable store. Its
   schema must distinguish at least unadopted pending transfer, ambiguously
   transferred, adopted/active, stopping/cleanup, terminal/released, and typed
   unavailable/outcome-unknown dispositions without borrowing terminal command
   states whose reconciliation waits for exit.
3. Reject unknown fields, invalid state/field combinations, unsupported active
   versions, and unsafe downgrade. Preserve historical terminal records. Clone
   every public result, make digests sensitive to every semantic field, enforce
   configured record/effect/capacity bounds, and fail typed rather than evicting
   active ownership or cleanup evidence.
4. Persist only durable data. No opaque grant, bearer token, control port,
   input payload, writer, native handle, channel object, live endpoint, or live
   capability may be stored, serialized, cloned into model-visible data, or
   included in durable events.
5. Add a durable `SessionAuthority` transfer contract. The ToolBroker-issued
   opaque grant remains lifecycle-owned by ToolBroker. The contract consumes it
   exactly once and retains only validated immutable claims. Fenced,
   idempotent pending effects atomically transfer cleanup ownership of the exact
   immutable isolation lease and fixed access envelope to SessionAuthority.
   The runtime must never reissue, retain, or independently revoke the opaque
   grant; ToolBroker revokes it exactly once at normal call completion,
   cancellation, or timeout.
6. Model the three cleanup owners precisely:
   - an in-process failure before transfer is owned by ToolBroker's live call
     revoker;
   - if the host dies before transfer, the durable provider/lease claim is the
     sole startup-recovery cleanup owner and may clean or durably block the exact
     unadopted effect but may not fabricate adoption;
   - after durable transfer acknowledgement, SessionAuthority owns recovery and
     cleanup.
   Ambiguous transfer recovery is fenced and fail-closed: no input exposure,
   authority broadening, or relaunch. Replay emits and acknowledges each exact
   transfer/cleanup effect once.
7. Never persist or reuse grant material. Adopted authority permits exact-child
   observation and cleanup only; it never grants relaunch or access expansion.
   A crash requiring relaunch ends the current call typed unavailable or
   outcome-unknown. Relaunch may occur only on a later newly authorized call.
   No family may mint or reuse a second grant in the same ToolBroker call.
8. Define immutable access-envelope claims and explicit comparison helpers:
   `sessionEnvelope.access` is a subset of `launchGrant.access`;
   `requestAccess` is a subset of `sessionEnvelope.access`; and a current grant
   independently authorizes request access, external/destructive decisions,
   and exact run/session/actor/tool/call identity. Compare credential names,
   network permission, and path modes separately. Never compare opaque grants
   as sets, broaden a session envelope, or union envelopes across calls.
9. Define a non-forgeable Runner-private `SessionOperationAuthorization` bound
   to the exact session owner, run, actor, agent session, tool, call, permitted
   operation, and access check. Every family-facing write, close-input, request,
   stop, graceful shutdown, family subscription, parse/delivery action,
   input/control operation, and protocol response requires a current
   authorization. A backend channel is never returned to a family.
10. Permit only fenced Runner recovery, cleanup, terminal observation, and
    bounded raw-output draining into private protocol/evidence queues without a
    model-call authorization. These lifecycle actions may not write input,
    dispatch a request, acknowledge a server-originated action, expose bytes to
    a family/model, or mutate family protocol state.
11. Define the versioned optional backend-private
    `InteractiveProcessChannelProvider`, separate from tree ownership and write
    confinement. It is acquired or reattached only against an exact backend
    binding plus fencing token, and exposes ordered bounded write, idempotent
    close-input, live private output subscription, graceful stop, terminal
    wait, detach/release, and optional attested reattach contracts.
12. Each write contract carries an in-memory sequence, byte length and digest,
    timeout, and explicit backend acknowledgement. Payload bytes are never
    persisted. A crash while acknowledgement is unknown becomes typed
    `outcome_unknown` and is never replayed. Reject stale fences, released
    sessions, duplicate/out-of-order writes, and writes after close.
13. Keep live channel capabilities backend-private and in memory, such as via a
    non-enumerable registry or `WeakMap`. Reattach requires exact backend
    attestation. If reattach cannot be proven without durable secrets, return
    typed `input_unavailable` or `outcome_unknown` while retaining cleanup
    ownership.
14. The first future MCP/LSP operation will use the same launching ToolBroker
    call's validated claims after adoption; later operations require new calls
    and grants. `process.start` will return after adoption and before
    ToolBroker's normal revocation. Packet 8.0A defines and tests these claims
    and transitions only; it does not migrate or launch those families.

## Explicit exclusions

- Do not implement `StreamingProcessSessionRuntime.open()`, real process launch,
  output queues/spooling, backend channel implementations, OCI interactive
  attach, Windows Job host extraction, CLI/factory construction, or per-run
  binding. Those belong to 8.0B.
- Do not modify production Git, MCP, LSP, managed-process, or configured-provider
  routing. Do not introduce a compatibility raw-spawn fallback.
- Do not implement Task 9 Git indirect-execution hardening, Task 10 filesystem
  fencing, Task 11 recovery proposals/disclosure, Task 12 package/CI work, or P7.
- No Windows-only product semantic, AI-selected OS command, shell ownership
  fallback, broad PID kill, host-secret persistence, or exact Node patch pin.
- No real child-process fixture belongs in 8.0A. Use fake claims, fake providers,
  and fake backend bindings to prove the state/authority contracts.

## Expected implementation surfaces

- New focused modules under `runner-v2/src/` for streaming-session contracts,
  durable streaming-session storage/state, SessionAuthority/access envelopes,
  and operation authorization. Names may follow current repository conventions.
- Backwards-compatible additions only in `runner-v2/src/process-backend.ts`,
  `execution-grants.ts`, and related shared types when required by the frozen
  contracts.
- New focused tests under `runner-v2/test/`, plus affected Task 7 contract tests.
- Do not touch production family modules except a type-only import proved
  unavoidable; any behavior migration is out of scope.

## Required TDD and fault evidence

For every new behavior or guard: add the smallest real test first, run it and
capture the expected failure, revert the mutation when using an injected guard,
implement the minimum behavior, and rerun the exact test green. Record every
RED/revert/GREEN command, failure reason, and green result in the report.

The focused test matrix must cover:

- strict schema parsing, unknown fields, invalid state combinations, unsupported
  active version, active downgrade refusal, and historical terminal compatibility;
- clone isolation and digest sensitivity for every semantic field;
- capacity overflow that retains active ownership and cleanup evidence;
- grant consumed once, opaque grant never persisted, ToolBroker-only revocation,
  and no second grant within one call;
- session-envelope/launch-claims and request/session-envelope comparisons,
  separate path/network/credential checks, broader-access refusal, and no union;
- exact operation-authorization binding, operation mismatch, actor/call/session
  mismatch, expiry/revocation, non-forgeability, stale authorization, and backend
  channel non-exposure;
- fake-provider crash before transfer, host-loss pending transfer, ambiguous
  transfer, crash after acknowledgement, exactly-once effect replay/ack, stale
  fence/takeover, and no fabricated adoption/relaunch;
- write before acknowledgement crash versus after acknowledgement crash,
  duplicate/out-of-order sequence, length/digest mismatch, timeout, stale fence,
  released session, close-input idempotence, and write after close;
- durable-value scan proving no grant/token/port/payload/writer/handle/channel/
  live capability is serialized or model-visible;
- reattach attestation success/refusal and typed input unavailable/outcome unknown;
- kernel-lifecycle authorization boundary at the contract level using fakes:
  terminal observation/private draining allowed, but family delivery, protocol
  mutation, every write, and every control action denied without current auth;
- exact Task 7 terminal contract/store/runtime/one-shot compatibility.

Each new regression test must itself be proven red, reverted, and green. Fake-
provider transition tests are the acceptance evidence here; the real Runner
host-crash and persistent-child draining fixtures belong to 8.0B.

## Validation order

1. Run the exact newly failing test after each RED.
2. Run that exact test after the minimum implementation.
3. Run the affected new contract/store/authority test files.
4. Run affected existing tests:
   `runner-v2/test/execution-grants.test.ts`,
   `runner-v2/test/process-backend-contract.test.ts`,
   `runner-v2/test/durable-process-store.test.ts`,
   `runner-v2/test/subprocess-runtime.test.ts`, and
   `runner-v2/test/one-shot-command-executor.test.ts`.
5. Run Runner V2 TypeScript checking and targeted lint on changed production and
   test files.
6. Run `git diff --check` over the packet range and a final adversarial audit of
   every requirement above. Broaden tests only when impact cannot be bounded.

## Cleanup, rollback, and recovery

- All fake stores/state roots must be task-owned external temporary directories
  and cleaned in `finally`; verify no Task 8.0A temp root remains.
- Failed transactions must retain a single truthful cleanup owner and current
  evidence. Never acknowledge a pending transfer/cleanup effect before the
  exact consumer succeeds.
- Active unsupported streaming records must fail typed and remain recoverable;
  rollback must not erase or reinterpret them.
- Task 7 binaries/contracts may be restored only when no active 8.0A streaming
  record or pending effect exists. Terminal historical evidence remains.

## Definition of Done and exit gate

8.0A is complete only when every assigned requirement is audited, every new
guard/regression has current RED/revert/GREEN evidence, focused and affected
Task 7 tests are green, typecheck/lint/diff checks are green, temp state is
empty, the final adversarial audit finds no missing requirement, and an
independent reviewer reports zero Critical/Important findings.

No production child family may migrate before this gate. The only successful
outcome is:

**PACKET 8.0A VERIFIED 100% COMPLETE — PACKET 8.0B MAY BEGIN**
