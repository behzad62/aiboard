# Task 9 — Git indirect-execution hardening

Authority: `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md`, Task 9 / P6.4f. Base commit `a468977a170f41e7a1b266191ca92f288502b660`. Task 10 remains locked until Task 9 is accepted and committed.

1. [ ] Audit every Runner Git invocation/call site and prove central runner ownership; record current environment/config behavior and public compatibility requirements.
2. [ ] Add `git-execution-policy.ts` as the sole Git-specific safe environment/config policy layered on Task 8's filtered child environment.
3. [ ] Disable or neutralize system/global/repository indirect execution where safe: hooks, credential prompts/helpers, fsmonitor, external diff/textconv, clean/smudge/process filters, pager/editor, SSH overrides, config includes, aliases, submodule/custom update commands, and equivalent helpers.
4. [ ] Add hostile isolated repository fixtures for hook, filters, credential helper, fsmonitor, external diff/textconv, include.path, pager/editor, alias, SSH override, and submodule/update attempts; prove reachable old behavior RED before product changes, then every sentinel remains absent GREEN.
5. [ ] Commands that intrinsically require a forbidden repository-controlled execution feature fail typed before side effects rather than silently running unconfined.
6. [ ] Preserve shared subprocess environment/output/ownership/isolation and exact ToolBroker grant semantics; preserve Git-missing pre-model fatal prerequisite and existing Git result/error/binary compatibility.
7. [ ] Fault-remove material hardening config/env settings one at a time, prove matching sentinel RED, restore byte-for-byte and GREEN.
8. [ ] Run focused policy/Git/repository/worktree/integration/recovery tests, affected dependencies, TypeScript, full Runner ESLint and diff-check; audit owned temp repos/processes/sentinels and protected inputs.
9. [ ] Self-review every original Task 9 requirement, write acceptance report/evidence, mark Task 9 VERIFIED, commit Task 9 only, and leave Task 10 as next P6 packet.
