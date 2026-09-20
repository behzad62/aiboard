# Task 8.0B1 fix round 1 re-review

## Verdict

- Specification compliance: **NOT APPROVED**
- Task code quality: **NOT APPROVED**
- Remaining: **1 Critical, 4 Important**
- Task 8.0B2 remains locked.

## Prior-finding disposition

- Critical family-output boundary: **OPEN**. Private intake and explicit
  authorized pull exist, but operation authorizations remain cross-kernel
  replayable.
- Important 1 output ordering/fail-closed: **ADDRESSED**.
- Important 2 staged authority/reservation/full binding: **ADDRESSED**.
- Important 3 host journal/lifecycle: **ADDRESSED**.
- Important 4 recovery: **OPEN** for total deadline, late resource cleanup and
  non-1 fences.
- Important 5 evidence/cleanup: **OPEN** for finalize evidence and hung effects.
- Important 6 tests/evidence: **OPEN** for the remaining faults.

## Critical

### SessionOperationAuthorization is replayable across SessionAuthority kernels

`AUTHORIZATIONS` is module-global, and an authorization record carries no
issuing SessionAuthority/kernel identity. `assertOperationAuthorization()`
checks matching durable session data but not the issuer. A direct reproduction
copied the matching active session into a different kernel and the foreign
authority accepted the original capability (`CROSS_KERNEL_AUTHORIZATION_ACCEPTED`).

Evidence: `session-authority.ts:199,470-506,773-796` at commit `86304fdb`.

## Important

### 1. Recovery has no single total deadline and can leak a late channel

The requested timeout is restarted for each host/session operation, so total
duration can approach record count times timeout. Terminal rows do not consume
the record bound. The timeout wrapper abandons the provider promise; a channel
returned after timeout is neither retained nor detached.

Evidence: `streaming-process-session-runtime.ts:199-254`.

### 2. Recovered ownership cannot support a current non-1 fence

Attachment creation hardcodes fence 1. Recovery passes owner only even after
validating the durable session/checkpoint fence. There is no adopted-session
takeover plus checkpoint re-fence path. A valid recovered fence above 1 cannot
produce a usable authorized attachment.

Evidence: `streaming-process-session-runtime.ts:58-66,217-227`.

### 3. Spool finalization loss/error is discarded

The tee returns finalize loss/error, but attachment close neither persists nor
surfaces the original failure/loss/artifact result when cleanup succeeds. Stop
can therefore complete without truthful output evidence.

Evidence: `protocol-evidence-tee.ts:27-35` and
`streaming-process-session-runtime.ts:94-99`.

### 4. Cancellation can hang forever on a noncooperative provider effect

The caller-facing provider await is abortable, but the failure path then waits
unconditionally for `activeEffect`. If isolation/launch/channel/handshake never
settles, cancellation never completes. Existing tests eventually release the
effect and do not cover a permanently hung provider.

Evidence: `streaming-process-session-runtime.ts:176-181`.

## Verification

- B1 focused: 52/52 green.
- Task 8.0A: 89/89 green.
- Task 7 plus bounded spool: 173/173 green.
- Typecheck, targeted ESLint and diff check: green.
- Worktree clean.

Green results do not cover the remaining cross-kernel authorization, total-
deadline/late-reattach, non-1 fence, finalize-loss, or noncooperative-provider
faults. Route to the original implementer as fix round 2/5, then independently
re-review the fix-only diff.
