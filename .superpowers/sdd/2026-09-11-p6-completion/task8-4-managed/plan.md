# Task 8.4 managed processes — approved P6 continuation

Authority: user requested finishing all remaining P6 tasks after accepted Task 8.3 commit 59becb95. The original Family packet 8.4 and approved portable-execution-safety plan remain the requirements baseline. No architecture restart, provider/model calls, dependency/Node policy changes, push, unrelated staging, or historical cleanup.

## Ordered implementation and acceptance
1. [x] Decouple backend composition from the public managed facade. The existing authenticated Windows Job host is the only Job service consumed by backends/probes; prove the no-recursion dependency boundary.
2. [x] Introduce a closed versioned managed record and injected run-owned transport. Keep public tool result/snapshot fields and terminal legacy historical reads; refuse unsupported active records. No ambient launch, private supervisor, native handle, bearer/control token or PID-only lifecycle in the facade.
3. [x] Route process.start through exact original ToolBroker authority into authenticated shared-session adoption. The launch intent is an ordinary command; startup means the shared backend/channel has authenticated readiness, not an invented application protocol.
4. [x] Use the shared evidence-only output path for bounded background draining. Live model-facing polling independently checks the fresh original call authority before exposing a bounded durable evidence snapshot. Trusted historical/control-plane observations remain non-mutating and cannot authorize process effects.
5. [x] Route explicit stop through current exact call authority and durably commit cleanup before ignoring subsequent caller cancellation. Lifecycle cleanup is exact-owner/model-free. Cancelled starts join late/adopted cleanup; cancelled polling never stops the child. Async close joins all retained effects and refuses unverified release.
6. [x] Wire production run/worker/subagent/verifier lifetimes and ownership. Preserve actual actor/run/agent-session identities and distinct per-run execution profiles. Recovery only reattaches/cleans existing ownership; no autonomous relaunch.
7. [x] Prove causal RED/GREEN and meaningful reverse faults at the actual boundaries, then complete affected files and dependencies, native Windows/eligible batch, strict refusal/real configured OCI and Linux portable contracts, typecheck, full Runner ESLint and diff-check.
8. [x] Audit original requirements, exact new resource accounting, accepted source hashes, protected inputs and staged scope. Only then mark 8.4 VERIFIED and commit its accepted files. Next packet is 8.5, not P6.5/P7.

## Design decisions within the approved architecture
- The public facade stores metadata/projection only and receives a run-scoped transport through explicit registration; it cannot construct or control an OS process.
- The shared runtime remains sole session/evidence/backend/isolation owner. Existing safe output/evidence primitives are reused rather than creating an unbounded parallel log.
- Fresh call authority is separate from durable ownership. A start grant is never reused for polling/stopping or fabricated for cleanup.
- Internal TypeScript polling may become awaitable where authenticated evidence reads require it; public JSON/tool schemas remain stable.
- Historical failed/uncertain roots from earlier packets remain exclusions. Every new root/container is recorded before effects and classified from exact ownership evidence, never PID absence alone.

## Remaining P6 queue
8.4 managed -> 8.5 launch/local-provider audit -> 9 Git indirect-execution policy -> 10 filesystem mutation fence -> 11 exceptional recovery/disclosure -> 12 cleanup/package/platform/final P6 qualification. Each gate is evidence-backed. Full-suite execution is reserved for final stable P6. Required remote CI results are a separate final gate and cannot be replaced by local claims.
