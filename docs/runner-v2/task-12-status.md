# Runner V2 Task 12 — Durable Gate Status

> **Authoritative continuation state.** Update this file whenever a gate changes status. Do not infer completion from chat summaries.

Plan: `docs/runner-v2/task-12-bounded-gates.md`

- Gate 0 baseline: PASS
- Gate A fencing: NOT_STARTED
- Gate B POSIX: NOT_STARTED
- Gate C Windows: NOT_STARTED
- Gate D macOS/config: NOT_STARTED
- Gate E lifecycle/Docker: NOT_STARTED
- Gate F benchmark: NOT_STARTED
- Gate G final acceptance: NOT_STARTED

## Current gate

T12-0 — Controlled repair baseline is complete. Next gate: T12-A — Exact ownership, authorization, and fencing.

## Clean repair workspace

- Worktree: `D:\repos\ai-discussion-board\.worktrees\runner-v2-task12-bounded`
- Branch: `codex/runner-v2-task12-bounded`
- Canonical Task-12 PR head used as repair base: `cb5320b60ffa6130950db49c59263b4b4501977b`
- Plan/docs replay commit: `3bcb40b0`
- Extracted POSIX safety commit: `7317fa49`
- Extracted capabilities-config confinement commit: `99b4cfb2`

## Baseline provenance

The previous local branch remains available for forensic reference, but its checkpoint history is deliberately excluded from this repair branch:

- `9878a12b9ed1cffe317145a9fa9d465370a03df1` — 1,716 files / ~12.6M inserted lines; contaminated checkpoint.
- `bf57a2de71fe5eea8b88fe53764900264c764603` — mixed 10-file Runner runtime checkpoint layered on `9878a12b`.

Neither checkpoint is in `codex/runner-v2-task12-bounded` ancestry.

Legitimate reviewed fixes extracted from `9878a12b`:
- POSIX membership parser fails closed for PID 0 / invalid non-positive rows except positive PID + PGID 0 kernel-thread rows.
- POSIX post-anchor force control re-attests recorded descendant birth witnesses before group signaling.
- Capabilities config canonical confinement rejects parent-alias escape into the project while preserving host-native aliases.

## Quarantined local-only patches

Do not copy these into the repair branch without the owning gate's review:
- `9878a12b` managed-stop/session-runtime attempt in `streaming-process-session-runtime.ts` and its test: Gate A must redesign exact fence continuity; the audit found the stale-owner TOCTOU still unresolved.
- `bf57a2de` Windows/portable/MCP coordination patch: Gate C must independently review it before inclusion.
- Benchmark/calibration/generated artifacts contained in `9878a12b`: excluded from Task-12 repair history.

## Targeted tests/evidence

RED before extraction:
- `npx tsx --test --test-concurrency=1 runner-v2/test/posix-process-backend.test.ts runner-v2/test/runner-capabilities-config.test.ts`
- Result: 44 pass, 7 fail, 1 skip. Failures were the intended stale-PGID/parser/config regressions.

GREEN after extraction:
- Same command.
- Result: 55 pass, 0 fail, 1 skip; POSIX native fixture skipped on Windows by design.

Baseline hygiene evidence:
- clean repair branch forked directly from `cb5320b6`;
- no `9878a12b` or `bf57a2de` in repair ancestry;
- no competing process was found using the new repair worktree;
- dependency reuse is an ignored local `node_modules` junction only, not repository content.

## Reviewer status

T12-0 baseline evidence has been controller-verified. It is a repository-hygiene prerequisite, not a functional acceptance gate. Gates A-G still require their documented independent review before acceptance.

## Known later-gate issues

- Gate A: managed-stop lease-renewal fencing TOCTOU remains unresolved and is next.
- Gate B: extracted POSIX safety fix is present as `7317fa49`, but Gate B still needs its full invariant review and POSIX-host evidence.
- Gate C: `bf57a2de` coordination patch remains quarantined pending independent Windows review.
- Gate D: extracted config confinement fix is present as `99b4cfb2`; broader macOS `/var -> /private/var` capability-contract handling remains unresolved.
- Gate E: supervisor/output/release settlement and real Docker lifecycle remain open.
- Gate F: certified preset timeout still requires causal classification, not timeout inflation.
