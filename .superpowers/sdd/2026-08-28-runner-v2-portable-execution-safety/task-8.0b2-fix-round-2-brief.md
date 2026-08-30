# Task 8.0B2 Fix Round 2

## Scope and authority

Repair exactly the six Important residual gaps in
`task-8.0b2-fix-review-2.md` (the fresh review of
`1d57cf0d..5a970f51`) against the original `task-8.0b2-brief.md` and
`task-8.0b2-fix-round-1-brief.md`. Preserve the verified actor-free Job-host
extraction, portable fallback, Job optionality, managed-facade compatibility,
B1/8.0A/Task 5/7 behavior, Node 22/24 policy, cleanup rules, and all green
load-hardening evidence. Do not add OCI, activate a new child family, or begin
B3.

## Required repair packets

1. **Genuine bounded Job producer backpressure:** make the extracted Job host
   bound unacknowledged stdout/stderr by both chunks and bytes and stop draining
   the producer when that retained window is full. Resume only after the exact
   sink acknowledgement is durably accepted. Output/sink/ack failures must
   become an observable private-channel failure and terminal
   `outcome_unknown`; they must never be swallowed or reported as a clean exit.
   Preserve append-only evidence and Task 5 terminal observation compatibility.
2. **Independent semantic facts with real consumers:** actively attest portable
   duplex, argv-only batch launch, exact-tree/birth, and Job containment as four
   separate facts. Each fact must govern only its own selection/refusal path.
   Portable registration requires its own verified semantics; Job failure must
   not remove a verified portable baseline; an unverified batch fact must cause
   a typed prelaunch batch refusal without disabling verified non-batch launch;
   exact-tree/birth must not be hardcoded or inferred from a module/platform
   name. The batch probe must attest the argv boundary, not merely the presence
   of `powershell.exe`.
3. **Fence the effect boundary, not only the precheck:** every portable and Job
   write, close, signal/control, output acknowledgement, attach/reattach, and
   other ownership-changing effect must carry the candidate owner/token to the
   lowest host/supervisor boundary and atomically compare it with durable current
   ownership immediately before the effect. A token-1 effect paused before the
   boundary must fail if token 2 takes over before it resumes. Old output sinks
   must not acknowledge/delete bytes after takeover. Equal current ownership is
   idempotent; strictly higher ownership may take over; stale/divergent ownership
   fails before any effect.
4. **Fence release through evidence deletion:** portable and Job verify-empty and
   release must re-attest exact birth, membership/emptiness, terminal state,
   settled output, and current owner/token immediately before the durable release
   commit or filesystem deletion. Token-1 release paused during inspection must
   not delete evidence after token 2 takes ownership. Missing, recycled, or
   unknown identity preserves the complete evidence root.
5. **Fail closed on missing/unreadable/unsettled output:** a missing or unreadable
   owned output/checkpoint/ack directory is corruption or uncertainty, never an
   empty retained window. Portable acquire/reattach/terminal/release and Job
   terminal/release must refuse clean success while output is missing,
   unreadable, corrupt, unacknowledged, or unsettled. Job release must prove the
   retained window is empty and every accepted acknowledgement is durable.
6. **Bound asynchronous CIM inspection:** give every asynchronous Windows
   inventory a bounded watchdog. A hung inspector must be terminated, counted as
   an inspection failure, and reach durable fail-closed `outcome_unknown` after
   the governed consecutive-failure limit. Do not reuse stale membership to
   prove terminal/empty. Keep the one-in-flight rule and 250 ms
   completion-to-next-start cadence; do not increase production deadlines.

## Mandatory RED/revert/GREEN proofs

- Job output exceeds the configured retained chunk/byte window while the sink
  is held; the producer is backpressured until the identical acknowledgement.
- A throwing Job sink or acknowledgement failure cannot return clean terminal;
  undelivered bytes remain retained and release is refused.
- Each semantic fact independently toggles only its own registration/refusal;
  active Job false retains verified portable and batch paths, while batch false
  rejects a real `.cmd`/`.bat` request before target creation.
- Token 1 is paused after its precheck for portable signal, portable output ack,
  Job input/control, and Job output ack; token 2 claims ownership; every token-1
  effect then fails and produces no target/control/delete/ack side effect.
- Token-1 portable and Job release are paused during inspection; token 2 claims;
  token 1 cannot commit release or delete evidence.
- Missing/unreadable portable output directories and missing/unsettled Job
  output are refused by acquire/reattach/terminal/release.
- A never-closing CIM inspector is watchdog-terminated, advances the exact
  consecutive-failure counter, becomes durable `outcome_unknown`, and leaves the
  owned process/evidence intact.
- Mutate away each new fence-at-effect, backpressure, output-settlement, semantic
  fact consumer, and CIM-watchdog guard; prove RED; revert; prove GREEN.

## Validation and exit discipline

Run exact failed/reproduced guards first, then affected Job/portable/channel/
semantic/managed suites, complete B1 and 8.0A, Task 5/7/3 compatibility,
typecheck, targeted lint, diff/static dependency/raw-process/product-branch/
Node-pin audits, concurrent load stress, and one uninterrupted complete
`npm run test:runner-v2`. Audit exact owned processes and task-created roots
before and after the broad gate. Do not delete uncertain evidence or use
time-based unclaimed-output deletion. Do not raise production deadlines to pass
load.

Append current RED/GREEN/mutation/load/cleanup evidence to
`task-8.0b2-report.md`, commit the focused repair, and leave the worktree clean.
This implementation is not approval. B3 remains locked until a fresh scoped
re-review and controller verification report zero Critical/Important findings.
