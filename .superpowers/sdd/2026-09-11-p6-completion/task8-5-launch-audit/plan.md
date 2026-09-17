# Task 8.5 local-provider audit and raw-launch closure

Authority: continue the already-approved P6 Task 8 packet after Task 8.4 commit `f48da929`. Do not alter unrelated work, dependencies, Node policy, or provider behavior unless the audited inventory proves a real local child provider exists.

1. [x] Record configured-provider inventory: exact transport enum, model factories, config entry points, and whether any transport launches a local child.
2. [x] Add one whole-tree production audit covering Runner `.ts/.mts/.js/.mjs/.cjs/.ps1`, Runner package scripts/launcher entries, and migrated-family ambient environment access.
3. [x] Resolve static/dynamic/namespace/destructured/aliased `child_process` bindings and reject spawn/exec/fork/member kill/process.kill/taskkill/shell/PowerShell/.ps1 bypasses.
4. [x] Keep a symbol/range-level adapter/provider-host allowlist with narrow reasons; do not blanket-exempt files.
5. [x] Prove `native-build-factory.ts` is the sole Task 8 ambient `process.env` source and that downstream families receive filtered/injected environment.
6. [x] Prove real temporal RED/revert/GREEN mutations for aliased spawn/execFile, namespace alias, dynamic import, fork, member kill, ambient env, taskkill, shell flag, and `.ps1` launcher.
7. [x] Run focused guard/provider compatibility, affected Task 8 tests, Runner typecheck, ESLint, diff-check, and exact resource/protected-input audit.
8. [x] Audit the full original Task 8 requirements, mark Task 8 exit only if 8.1–8.5 remain verified, commit only accepted 8.5 source/tests/evidence, and leave Task 9 as the next P6 packet.
