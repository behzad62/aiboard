# Task 8.0B2 Fresh Re-review — Fix Round 1

Range reviewed: `1d57cf0d..5a970f51`

## Verdict

**CHANGES REQUIRED — B2 cannot close.**

Zero Critical findings. Six Important gaps remain. Fresh focused verification
was 66/66 green, but those tests do not cover the reproduced races and missing
faults below.

## Findings

1. **Addressed — actor-free Job host extraction.**
   `AuthenticatedWindowsJobProcessHost` owns the low-level records, supervisor,
   control, output, reconciliation, and release mechanics. The transitive guard
   rejects managed-facade/actor dependencies.
2. **Important — Job duplex is not genuinely producer-backpressured.**
   `managed-process-supervisor.mjs` drains and appends stdout/stderr without a
   bounded unacknowledged window. Job acknowledgement only advances offsets.
   `windows-job-process-channel.ts` also swallows sink/output failures. A
   throwing-sink reproduction returned clean terminal `exited` with zero acks
   and four undelivered bytes.
3. **Important — three independent semantic facts remain dead.**
   Only Job containment governs construction. Exact tree/birth is hardcoded
   `partial`; portable duplex and batch argv facts do not govern selection or
   typed refusal; portable registration is unconditional; and the batch probe
   checks only for a PowerShell file rather than argv semantics.
4. **Important — takeover does not fence the final effect boundary.**
   Portable signal writes unfenced control after an earlier fence check, and
   Job channel host effects accept no fence. Deterministic reproductions showed
   token-1 portable signal and Job input effects succeeding after token 2 had
   durably taken ownership.
5. **Important — final re-attestation does not cover every attach/terminal/
   release effect.** Job attach/write/close/output-ack retain a check/effect
   race. Portable release checks the fence only at entry; a reproduction let
   token 1 delete evidence after token 2 took ownership during the emptiness
   checks.
6. **Important — missing/unsettled output remains fail-open.**
   Portable output-directory read errors are converted to an empty window; a
   missing-directory acquire succeeded. Job release has no unsettled-output
   gate, and the throwing-sink reproduction reported clean terminal despite
   undelivered bytes.
7. **Important (new) — asynchronous CIM inventory has no watchdog.**
   A never-closing PowerShell inventory leaves the one-in-flight flag set
   forever, so the consecutive-failure counter never advances to durable
   `outcome_unknown`. No hung-query fault test exists.

## Checks without findings

- No time-based unclaimed-output deletion was introduced.
- No production deadline was raised; deadline changes are test-only.
- Recovery cleanup retry is test-only.
- Terminal HTTP reset fallback requires exact durable stopped,
  ownership-released supervisor proof and has a nonterminal rejection test.
- Reported broad evidence was 1295 total, 1294 pass, zero fail, one explicit
  POSIX skip. The worktree was clean during review.

**B2 CANNOT CLOSE.**
