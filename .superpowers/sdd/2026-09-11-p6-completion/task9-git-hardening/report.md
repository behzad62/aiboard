# Runner V2 Task 9 — Git indirect-execution hardening

Date: 2026-09-14
Branch: `codex/runner-v2-robust-build`
Accepted pre-Task-9 base: `a468977a170f41e7a1b266191ca92f288502b660`
Authoritative plan: `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md` Task 9 / P6.4f.

## Architecture and policy boundary

Task 9 keeps every Runner Git subprocess on the existing shared Git runtime. `git-runtime-runner.ts` snapshots caller arguments/environment, applies `prepareGitExecutionPolicy()`, acquires/canonicalizes the existing run/call authority, then executes `enforceGitRepositoryExecutionPolicy()` against the exact authorized worktree before the shared `execution.execute()` seam. Policy refusal follows the existing authority-release cleanup path; no alternate Git executor was introduced.

`git-command.ts` adds typed `policy_refused` failure. `child-environment.ts` now treats an explicit `undefined` override as a case-insensitive canonical deletion of an inherited safe environment variable and records `removed_explicit`.

The caller environment is narrowed to `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, and `GIT_INDEX_FILE`. Ambient Git/process launch controls are removed. The safe environment forces system/global config isolation, disables prompting/askpass/editor/pager paths, constrains protocols, and supplies safe discovery behavior. The fixed `-c` policy disables hooks, fsmonitor, credential helpers/interaction, signing/editor paths, submodule recursion, unsafe protocol helpers, and other program-launch surfaces.

Repository scanning inspects common config, linked-worktree `config.worktree`, `.gitmodules`, `.git/info/attributes`, and relevant worktree `.gitattributes`. It fail-closes on includes/includeIf, aliases, filter clean/smudge/process, diff command/textconv/external, merge drivers, credential helpers, SSH/proxy command settings, unsafe remote/submodule transports, and custom submodule update commands.

Linked worktrees are validated by reciprocal `.git`/`gitdir` pointers using physical file identity (`dev`/`ino`), which handles path aliases while rejecting mismatched or symbolic metadata. Normal Runner command shapes remain supported, including `remote`, `remote get-url`, constrained `push`, `log -p`, status/diff, noninteractive commit/merge/cherry-pick variants, and existing worktree/recovery flows.

## TDD, defects, and causal proof

The hostile-repository work followed RED → GREEN development with preserved RED evidence. Final hostile coverage includes hooks, clean/smudge/process filters, include, textconv, alias, SSH override, remote helper transport, custom submodule update, editor, sequence editor, pager, fsmonitor, external diff, and credential helper.

Two material defects discovered during acceptance were repaired rather than hidden: `-c diff.external=` caused Git to attempt an empty external command, so the setting was removed and repository `diff.external` is scanner-refused; commit/merge/cherry-pick `--edit` initially exposed editor launch, so those argv shapes are centrally refused.

Final-source causal reverse faults are recorded as `causal-final-hook-red`, `causal-final-clean-red`, `causal-final-fsmonitor-red`, `causal-final-ssh-red`, `causal-final-credential-red`, and `causal-final-external-diff-red`. Every fault produced the expected outside sentinel, exited RED, retained its failed root, restored the exact source in `finally`, and recorded `beforeHash == afterHash == b1425d99a8cd46620934a9aebafea7f8000af0cc50c6b84ed6860c66a8da42db`.

The final causal harness itself needed a Windows-only evidence fix: Windows PowerShell native invocation drops empty argv entries and strips literal quotes. The harness now transports its replacement arguments as prefixed base64 and decodes them in the controller; this changes only evidence plumbing and preserves the causal mutation semantics.

## Final validation

- Post-causal hostile matrix `hostile-matrix-post-causal-green`: 16/16 pass, exit 0, `inputsUnchanged=true`, 64 observed roots, 0 retained.
- Affected Git graph `affected-git-final2-green`: 114/114 pass, exit 0, `inputsUnchanged=true`, 82 observed roots, 0 retained.
- Safe Git bootstrap `git-bootstrap-safe-green`: 3/3 pass, exit 0, `inputsUnchanged=true`, 3 observed roots, 0 retained.
- Focused IntegrationManager `integration-manager-focused-green`: 10/10 pass, exit 0, `inputsUnchanged=true`, 10 observed roots, 0 retained.
- Affected native graph `affected-native-acceptance`: 56/56 pass, exit 0, `inputsUnchanged=true`, 40 observed roots, 0 retained.
- TypeScript `static-tsc-final-green`: exit 0, `inputsUnchanged=true`, 0 retained roots.
- Full Runner ESLint `static-eslint-final-green`: exit 0, `inputsUnchanged=true`, 0 retained roots.
- Whitespace `static-whitespace-final-green`: `git diff --check -- runner-v2`, exit 0, `inputsUnchanged=true`, 0 retained roots.

These suites overlap and are intentionally reported individually; no aggregate test count is claimed.

## Resource and diagnostic accounting

`resource-ledger.json` classifies accepted GREEN, non-accepted diagnostic/superseded GREEN, and preserved RED/failed receipts. Accepted evidence contains 16 runs and 321 observed roots with zero retained roots; every accepted run exited 0 and kept its input snapshot unchanged. Twenty-six RED/failed receipts remain non-accepted, with 61 retained roots preserved as evidence.

The historical Git bootstrap inspection failure remains diagnostic evidence rather than an accepted GREEN cleanup result. The known test-only IntegrationManager concurrency hang remains a diagnostic exclusion; focused production-path acceptance is `integration-manager-focused-green`.

No repeated full configured suite was run for Task 9. The full-suite gate remains reserved for final P6 integration.

## Protected baseline

`audit-protected.mjs` checks the 2,350-file baseline. The final rerun after the completion-plan update found 2,342 unchanged files, exactly eight permitted Task 9 drifts (the seven Task 9 source/test drifts plus the completion plan), zero unexpected drift, and zero missing protected files.

## Acceptance conclusion

**Task 9 VERIFIED.** The implementation meets the P6.4f hardening requirements with current-source hostile, causal, affected, static, resource, and protected-baseline evidence. Task 10 is next eligible but remains PENDING and unstarted.
