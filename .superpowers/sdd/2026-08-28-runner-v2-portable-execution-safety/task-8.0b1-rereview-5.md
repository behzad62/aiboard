# Task 8.0B1 final governed re-review — round 5

## Verdict

- **NOT APPROVED**
- Critical remaining: 0
- Important remaining: 2
- The governed repair budget of 5/5 rounds is exhausted.
- **PHASE BLOCKED — GENUINE USER DECISION REQUIRED**
- Task 8.0B2 remains locked.

## Remaining Important findings

### 1. Durable kernel accepts an incomplete cleanup ledger and can falsely release

The runtime normally constructs all four cleanup duties, but the store reducer
does not derive/require the complete duty set from durable lifecycle state.
`begin_cleanup` accepts any nonempty subset and `settle_cleanup_cleaned` releases
when only that supplied subset succeeds. A direct reproduction created a fully
bound launch, supplied only a channel duty, and reached `released`/owner `none`
while the lease and backend binding remained.

The parser also accepts pending/failed duties owned by a historical takeover
owner rather than requiring the exact current owner/fence. A reproduction
accepted an unresolved host duty at `o1/1` in a current `o2/2` record.

Evidence: `streaming-session-store.ts:2027,2045,2162` at `b7ee53f0`.

Required repair if authorized: derive the mandatory cleanup duty set from the
durable launch/session state inside the kernel; reject missing, extra, duplicate,
wrong-identity and stale-owner/fence duties; allow release only when every
derived duty is acknowledged under the current fence. Re-fence every unresolved
duty atomically on takeover.

### 2. Durable cleanup failure text can contain credential/secret values

`durableFailureMessage()` only truncates arbitrary provider error text. That
text is stored in resource facts without a closed code/template mapping. A
direct reproduction persisted `credential=B1_PRIVATE_SENTINEL` in the host
record, violating the explicit durable-secret prohibition.

Evidence: `streaming-process-session-runtime.ts:96-105,438` and
`streaming-session-store.ts:2205-2214`.

Required repair if authorized: persist only a closed typed failure code plus
safe fixed message/template; never persist arbitrary provider text. Keep raw
details in ephemeral diagnostics only. Add direct credential/token/env/argv/
path-payload sentinel tests across every durable table.

## Addressed and verified

- Runtime checkpoint-only, lease-only, combined partial/final retry,
  expiry/restart and no-repeat behavior is green in the normal path.
- Earlier authorization, output ordering, staged authority, strict lifecycle,
  recovery deadline/non-1 fence, evidence finalization, noncooperative
  cancellation and late cleanup race findings remain addressed.
- Final fresh checks: exact cleanup matrix 3/3, full B1 70/70, Runner typecheck,
  targeted ESLint and diff check green; worktree clean.

## Owner decision required

The execution doctrine permits escalation when the governed repair budget is
exhausted. No sixth implementation round may begin without explicit owner
authorization to extend/reset that budget or to choose rollback/redesign.
