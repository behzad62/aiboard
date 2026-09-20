# Independent implementation review — pre-repair (historical)

Session: `1c259a99-12ed-4242-8a76-90cd4809d4a6`
Scope: read-only independent review of the uncommitted scoped-lifecycle candidate against adopted `DECISION.md` / `PLAN.md`.

## Verdict

**0 BLOCKING / 3 IMPORTANT / NOT READY**

## IMPORTANT findings

1. **Observability scope missing** — Safety observability / client projection still surfaced only legacy `tree_termination` / `verified_emptiness` capability maps and never displayed `lifecycle.scope` / `requiredLifecycleScope` (`build-observability.ts`; client mirror `lib/client/runner-v2.ts`).
2. **Lifecycle requirement flags unwired** — Live families (one-shot / managed / MCP / LSP) passed only `{ permissionProfile }` into `resolveRequiredLifecycleScope`; `requireCompleteCleanup` / `knownUnavoidableDetachment` were never set by those callers.
3. **Full+contained provider/Job fallback missing** — For `full` + `contained_workload`, isolation selection fell through to OCI-style providers only and did not consider a verified Windows Job backend / honest full-only unconfined fallback composition.

## Disposition

These three IMPORTANT findings were subsequently repaired and closed by the independent post-repair review artifact `evidence/implementation-review-after-repair.txt` (`READY`, findings `none`). This file is repair history only; it is not current readiness evidence.
