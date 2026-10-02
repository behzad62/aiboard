# Test-time profile — where a handoff harness test spends its time (controller, 2026-09-29)

Question: TX-2 moved the handoff tests onto a harness, but total test time stayed about the same (~9,900 s vs ~9,700 s). Why?

Method: scratch probe `scratchpad/prof/profile.test.mts` wraps `IntegrationManager.prototype.git`, `NativeBuildFactory.prototype.create` and `BuildRuntime.prototype.step` with timers, then imports `docs-policy-v2-handoff-entry-links.test.ts` and runs one test ("C2c NF-2: an AGENTS.md link to a missing target is skipped with a reason, and the handoff completes") alone, no other load. Worktree HEAD 83f89cf5 plus uncommitted TX-2 test files; runner-v2/src unchanged.

| Measure | Calls | Time |
|---|---|---|
| Whole test | 1 | 59.2 s |
| `IntegrationManager.git` (every git call through the audited execution host) | 54 | 54.8 s (93%), about 1,014 ms each |
| of which rev-parse / ls-files / symbolic-ref / ls-tree / merge-base / show / worktree / cat-file / log / add | 13 / 12 / 4 / 6 / 5 / 5 / 4 / 3 / 1 / 1 | 15.0 / 10.4 / 6.0 / 5.5 / 5.0 / 4.6 / 3.6 / 2.8 / 1.0 / 0.8 s |
| `NativeBuildFactory.create` | 1 | 14.8 s (mostly its git calls) |
| `BuildRuntime.step` (the handoff snapshot step) | 1 | 35.3 s (mostly its git calls) |

Baselines on the same machine (median): plain `git rev-parse HEAD` 30 ms; `powershell.exe -NoProfile` with `Get-Process` 159 ms; bare `node -e 0` 44 ms.

Finding: a git call through the runner's contained launch (node supervisor, Windows Job host `managed-process-job-host.ps1`, PowerShell process-birth inspections in `native-process-backend.ts`, status polling) costs about 1 s, about 33 times a plain git call. This is the same path production uses, so it also costs about 1 minute of git time per real handoff (about 50 git calls), and it dominates the delivery-factory tests too (CD-18). The harness cannot remove it, because the packet rule requires the factory-built port and the real execution host.

Not measured yet: how the ~970 ms overhead splits between process starts and polling waits. That needs an investigation of the launcher itself (outside P6.6 scope; owner decision).
