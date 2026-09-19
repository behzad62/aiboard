# Task 7 review round 1 fix report

Date: 2026-08-29
Base reviewed commit: `560a061f`
Scope: review findings only; Task 8 was not started.

## Packet audit

1. **OCI control-plane isolation.** The prepared child environment is now handed to `docker create` through an exclusive Runner-private environment file (`wx`, mode `0600`) under the provider state directory. Docker CLI attestation, create, re-attestation, and release calls receive an empty environment, so child `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, TLS, and certificate variables cannot select the control-plane daemon. The file contains sorted authorized values, its path (never its values) is passed with `--env-file`, and it is removed before lease persistence or error return. Invalid names or CR/LF/NUL values fail typed as `oci_environment_unrepresentable`. Fake and real-Docker tests prove in-container receipt, value absence from argv/lease/output, one attested daemon context, and zero handoff residue.
2. **Evidence/final spill fallback.** Both families verify spill existence, metadata, and hash through `ArtifactStore.verify`. Missing, unreadable, or hash-corrupt spill data falls back to the bounded runtime tail, preserves the mechanical command outcome, and truthfully sets lossy metadata. Complete verified spill remains the preferred artifact; output volume never changes command success.
3. **Runtime-grant revocation.** The one-shot executor records issuance and revokes the runtime grant exactly once before isolation release in `finally`. Tests cover success, failure before runtime consumption, and `outcome_unknown`; provider release still runs and no double revoke occurs.
4. **Stable typed failures.** Evidence tool results and final-verification command facts preserve the closed stable codes for strict capability unavailability, isolation revocation failure, `outcome_unknown`, and related cleanup/identity failures. Unknown failures retain the historical generic mapping.
5. **Production shared-runtime proof.** The former direct-spawn support fake was replaced with a production graph (`ExecutionGrantAuthority` -> selector -> SQLite `SubprocessRuntime` -> native backend -> bounded spool/artifact store). A parameterized three-family matrix covers timeout, cancellation, surviving TERM-ignoring grandchild cleanup, strict-unavailable prelaunch, and restart/outcome-unknown. Family suites additionally cover inherited-secret scrub, >128 KiB tails, >64 MiB output, spill failure, and Full disclosure. Evidence has no public cancellation surface, so its cancellation case invokes the production executor using the evidence family identity and mapping context, as authorized by the review brief. No direct fake executor was reintroduced.

The production matrix exposed one central-environment regression on Windows: `ManagedProcessService` re-merged ambient `process.env` after Task 2 had prepared the child environment. The narrow backend seam `inheritEnvironment: false` now lets the Windows Job backend consume the exact prepared environment. Ordinary managed-process callers keep their historical ambient inheritance. This adds no Windows-only semantic requirement and does not pin Node.

## Prove-red / revert / green evidence

- OCI reserved environment RED: `npx tsx --test --test-name-pattern "OCI child environment" runner-v2/test/oci-execution-isolation-provider.test.ts` -> 0/1; fake CLI received every reserved child variable. GREEN after private handoff: 1/1.
- Evidence spill RED: focused missing/corrupt cases -> 0/3 (missing threw; corrupt artifact was reused). GREEN: 3/3.
- Final spill RED: focused missing/corrupt cases -> 0/3 (missing threw; corrupt result was not lossy). GREEN: 3/3.
- Runtime grant ordering RED: focused executor cases -> 0/3. GREEN: 3/3 with revoke exactly once before provider release.
- Evidence typed codes RED: 0/4; GREEN: 4/4. Final typed codes RED: 0/4; GREEN: 4/4.
- Production environment RED: evidence production graph observed the inherited secret because the Windows managed-process layer performed a second ambient merge. After the exact-environment backend seam, process/evidence/final large-output fixtures are GREEN 1/1 each.
- Routing mutation RED: temporarily imported and executed `execFileSync` from `node:child_process` in production `process-tools.ts`; the AST guard failed 1/2 and reported both the child-process import and direct executable call. The mutation was reverted; guard GREEN 2/2.
- Production spill-fault fixtures: process/evidence/final GREEN 3/3; mechanical success is retained with truthful lossy metadata.
- Real Docker reserved-environment bridge: GREEN 1/1; reserved values arrived only inside the Alpine command, while the CLI continued on the originally attested daemon and cleanup removed the labelled container/handoff.

## Current validation evidence

- `process-tools.test.ts`: 8/8 GREEN.
- `evidence-tools.test.ts`: 16/16 GREEN.
- `final-verification-runtime.test.ts` + `final-verification-runtime-b1.test.ts`: 20/20 GREEN.
- Three-family production matrix: 12/12 GREEN.
- Executor/static/matrix/managed-process/backend aggregate: 61 passed, 0 failed, 1 expected POSIX-host skip.
- Native factory lifecycle/capability/final-factory aggregate: 39/39 GREEN; exactly one authority/runtime/executor graph remains factory-owned.
- Task 6 grants/isolation/OCI/ToolBroker/runtime/backend compatibility aggregate: 154 passed, 0 failed, 1 expected POSIX-host skip. This includes all real Docker fixtures.
- Targeted ESLint: GREEN.
- `npm run typecheck:runner-v2`: GREEN.
- `git diff --check`: GREEN (only Git line-ending notices).
- Production static search of process/evidence/final families for child-process imports, spawn/exec/fork, `process.env`, direct kill, and `taskkill`: zero matches.
- Residue: zero labelled `ai-board.runner-v2.owned=true` containers and zero live named family-fixture processes. Every production-graph helper removes runtime DBs, artifacts, spill directories, grants, process handles, and temporary roots in `finally`; OCI tests assert the environment-handoff directory is absent on success and failure.

## Compatibility, cleanup, rollback, recovery

Public tool schemas and historical generic errors are unchanged. New final-verification `errorCode` is optional. Full remains the only unconfined path and retains `unconfined_explicit_full`; strict profiles never fall back to the original host command. OCI enforcement remains provider-specific and the Docker CLI/native backend is never described as confined.

Rollback is the single focused fix commit. Recovery retains runtime cleanup ownership for ambiguous outcomes, releases/acknowledges provider leases only after runtime terminal cleanup, and exposes cleanup blockers rather than claiming success. Spill corruption never grants process-control authority and degrades only artifact completeness.

Residual risk: POSIX native descendant behavior is skipped on this Windows host, while its contract tests remain green. Windows private file mode uses Node's portable exclusive-create/mode semantics; the file is inside Runner-private state and is deterministically deleted. No platform-specific mandatory containment feature was introduced.

## Exit statement

All five review findings have implementation and current mechanical evidence. Task 8 remains outside this change.
