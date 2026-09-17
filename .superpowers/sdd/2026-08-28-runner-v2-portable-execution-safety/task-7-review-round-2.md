# Task 7 review — round 2

Verdict: **REJECTED**

No Critical findings. Two Important findings remain after the first repair
round.

## Important findings

1. If `docker create` succeeds and deletion of the private environment handoff
   throws, OCI acquisition exits before the exact container ID is parsed and
   durably owned. This can leave an unowned container. Add deletion-fault
   injection and ensure every successful create is either durably owned or
   compensating-removed/recoverable, including dual cleanup failure.

2. The production-family matrix changes labels but invokes
   `fixture.internalExecution.execute()` directly. Timeout, cancellation,
   strict-unavailable, and restart/outcome-unknown cases must start through the
   actual `ProcessTools`, `EvidenceTools`, and `FinalVerificationRuntime`
   family boundaries, while faults remain below the production runtime seam.

## Additional required repair evidence

The combined focused command returned 96/98 although both failures passed
alone. The failures were:

- `evidence production graph cancellation cleans its TERM-ignoring grandchild`:
  `backend_unavailable`, caused by `read ECONNRESET` in the runtime observation
  path.
- `Windows native supervisor owns a surviving descendant after launcher exit`:
  `Owned descendant identity mismatch` in the Windows backend signal path.

Eliminate the shared-state, identity, or timing interference and prove the
affected combined aggregate green on at least three consecutive runs. The fix
report must include exact covering commands and results, not counts alone.

## Confirmed addressed from round 1

- Spill verification and bounded-tail fallback.
- Exact-once runtime-grant revocation ordering.
- Stable typed strict/revocation/outcome failure mapping.
- Nominal Docker control-plane environment isolation.
