# Independent Task 11 review brief

Review only Task 11 / P6.4h in this worktree. Do not modify files.
Base commit: `284743e980514ecebc1d3143d427f4f3abf86225`.
Authoritative requirements: Task 11 in `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md`.

Task 11 source/client/UI files:
- runner-v2/src/process-recovery-contracts.ts
- runner-v2/src/process-recovery.ts
- runner-v2/src/durable-process-store.ts
- runner-v2/src/execution-grants.ts
- runner-v2/src/scheduler-store.ts
- runner-v2/src/subprocess-runtime.ts
- runner-v2/src/execution-host.ts
- runner-v2/src/native-build-factory.ts
- runner-v2/src/native-build-manager.ts
- runner-v2/src/control-server.ts
- runner-v2/src/cli.ts
- runner-v2/src/build-observability.ts
- lib/client/runner-v2.ts
- components/RunnerV2ObservabilityPanel.tsx

Task 11 tests/scripts:
- runner-v2/test/process-recovery.test.ts
- runner-v2/test/process-recovery-kernel.test.ts
- runner-v2/test/process-recovery-control.test.ts
- runner-v2/test/process-recovery-disclosure.test.ts
- runner-v2/test/process-recovery-model-free.test.ts
- runner-v2/test/subprocess-runtime.test.ts
- runner-v2/test/native-final-verification-factory.test.ts
- scripts/test-runner-v2-client.mts
- scripts/test-runner-v2-observability.mts

Ignore all other dirty/untracked files as unrelated user work.
Inspect current files and the diff from the base commit. Do not trust prior summaries.
Focus on load-bearing defects: authorization widening, PID reuse, identity/ownership races, expiry/replay, concurrent execution, durable transition integrity, secret leakage, cleanup truthfulness, routine lifecycle accidentally invoking models, API auth/body closure, Full-bypass disclosure, partial/unverified facts shown as enforced, historical mutability, and backwards compatibility.

Report findings first, each as Critical / Important / Minor with exact file:line evidence and a concrete failure scenario. Distinguish verified defects from suggestions. If no Critical/Important defects remain, say that explicitly. End with a requirements coverage assessment and any limitations in the evidence.
