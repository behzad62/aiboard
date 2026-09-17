# Task 8.0B2 Fresh Re-review — Fix Round 7

## Verdict

- Specification compliance: **CHANGES REQUIRED**
- Code quality: **CHANGES REQUIRED**
- Critical: **0**
- Important: **3**
- Minor: **0**
- B2 unlock: **refused**

## Important findings

1. The coordination path was validated while opening and claiming the owned
   fence, but was not revalidated after the claim and immediately before the
   external effect. Adding a hard link from the `afterClaim` fault seam left
   the database with two names while the effect and finalization still
   succeeded. Exact single-link authority must be rechecked at every mutation,
   effect, and retirement boundary.
2. The bounded phase scanners still classified the complete maximal token as
   either standard base64 or base64url before decoding it. Wrapping a strict
   standard-base64 payload with base64url-only characters, or a strict
   base64url payload with standard-only characters, made the whole token fit
   neither alphabet. Both cleanup paths then missed the embedded root and
   authorized deletion. Each bounded phase must be attempted independently
   with both decoders.
3. A process-birth inspection that returned after the caller's absolute
   startup deadline was accepted. The remaining state wait was also converted
   back into a fresh positive relative timeout through `Math.max(1, ...)`.
   Deadline expiry must be rechecked after blocking inspection and the same
   absolute deadline must flow through state readiness.

## Review evidence

- The post-claim hard-link reproduction reached the external effect with link
  count two before the repair.
- Mixed standard-base64/base64url wrappers caused both semantic cleanup and the
  governed B2 residue helper to remove referenced evidence before the repair.
- A birth inspector delayed beyond a 50 ms absolute deadline was rejected for
  an incidental supervisor timeout rather than the exhausted caller deadline.
- Round-7 focused, compatibility, full-package, Node-floor, static, and residue
  evidence remained green, but these three ownership and deadline gaps prevent
  B2 closure.

B2 remains locked. Fix round 8 is limited to these three findings and direct
validation fallout; B3 has not started.
