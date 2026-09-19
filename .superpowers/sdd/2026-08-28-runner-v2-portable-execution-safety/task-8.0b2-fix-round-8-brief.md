# Task 8.0B2 Fix Round 8 Brief

## Purpose

Close the three Important findings from the fresh fix-round-7 review without
changing Runner V2's portable-first architecture, production execution limits,
or supported runtime policy.

## Scope and requirements

### R8.1 — Revalidate exact coordination-path authority at effect boundaries

- Carry the resolved coordination path with the live fence context.
- Revalidate the path before proposal mutation, claim mutation/commit, the
  external-effect boundary, and finalization/retirement commit.
- A symbolic link or a link count other than one must fail closed before an
  external effect.
- Preserve exact acquisition identity, crash recovery, legacy migration, and
  retired-authority cleanup behavior.

### R8.2 — Decode bounded phases under both base64 alphabets

- Attempt each already-bounded start/end phase with both standard base64 and
  base64url decoders independently.
- Detect strict payloads even when a maximal token combines characters unique
  to both alphabets.
- Apply identical behavior to semantic cleanup and the governed B2 residue
  helper.
- Preserve all candidate-count, encoded-size, decoded-size, inventory, and
  absolute cleanup-deadline bounds.

### R8.3 — Preserve the absolute startup deadline after blocking work

- Pass the caller's absolute startup deadline through birth inspection and
  supervisor-state readiness.
- Recheck expiry immediately after every blocking birth inspection and before
  accepting identity or state.
- Never manufacture a fresh one-millisecond startup allowance after the
  absolute deadline.
- Keep the existing adaptive bounded Windows inspection attempts and separate
  safety cleanup behavior; no build-task timeout changes are authorized.

### R8.4 — Repair only directly observed gate nondeterminism

- If the required full gate exposes an unrelated test-only ordering assumption,
  identify the exact durable contracts and repair only the test.
- Never weaken a production assertion merely to make the gate green.
- Re-run the exact failure, the affected module, and the uninterrupted package
  gate after the repair.

## Explicit exclusions

- No B3 implementation or activation.
- No OCI-family activation or product routing change.
- No required Windows Job Object feature; it remains optional.
- No platform-specific agent-command replacement for process ownership.
- No production command deadline, build-task deadline, or retained-output-cap
  change.
- No exact Node patch pin. Supported Node remains
  `>=22.13.0 <23 || >=24.0.0 <25`.
- No deletion of uncertain or unrelated historical residue.

## Ordered work packets

1. Prove a post-claim hard link reaches the effect RED; revalidate exact path
   authority at each mutation/effect/finalization boundary and prove GREEN.
2. Prove mixed-alphabet wrappers evade both scanners RED; decode every bounded
   phase with both alphabets and prove GREEN.
3. Prove a late birth result reports the wrong deadline outcome RED; propagate
   and recheck the absolute deadline and prove GREEN.
4. Run the exact failures, affected modules, portable compatibility, current
   Node and Node 22.13 lock groups, typecheck, lint, diff, and static scope
   checks.
5. Run one uninterrupted full package gate. For any observed failure, run the
   exact failed check first, repair only a determinable direct cause, and repeat
   the affected and final gates.
6. Audit live helpers and governed residue, record current evidence, commit the
   bounded change, and obtain a fresh independent scoped review.

## Acceptance gate

- Each reviewer regression has physical RED and restored GREEN evidence.
- Affected and compatibility suites are green, with only the explicit POSIX
  fixture skip permitted on Windows.
- Current Node and Node 22.13 floor ownership-lock suites are green.
- Runner typecheck, targeted lint, diff integrity, Node policy, and scope audits
  are green.
- The uninterrupted `npm run test:runner-v2` command exits zero, including all
  chained product contract checks.
- Post-gate inventory has zero live Runner helpers and no new or
  deletion-authorized B2 residue.
- Independent review reports Critical 0 and Important 0.

Only then may Task 8.0B2 be declared verified and B3 become eligible.
