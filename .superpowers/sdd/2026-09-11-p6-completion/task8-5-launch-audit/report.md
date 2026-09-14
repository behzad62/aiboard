# Task 8.5 local-provider audit and raw-launch closure — VERIFIED

Accepted against base `f48da929f0c4f94d2cd70c092812be39fcd7da37` on branch `codex/runner-v2-robust-build`.

Task 8.5 closes the Task 8 execution-family migration by proving there is no configured local model-provider child transport, centralizing the remaining ambient environment snapshot, and installing a whole-tree source guard that rejects raw launch/control escapes outside exact backend/provider-host seams.

## Configured-provider inventory

- `ProviderTransport` remains the closed union `account-runner | openai-compatible | anthropic | google` in `provider-config-store.ts`.
- `NativeBuildFactory` maps those transports to `AccountRunnerModel`, `OpenAICompatibleModel`, `AnthropicModel`, and `GoogleModel`.
- The four model implementations contain no `child_process` import or spawn/exec/fork launch path. They remain API/HTTP/account-runner transports.
- Result: **no configured local child-process provider exists**, so no provider migration was required.

## Delivered closure

- `native-build-factory.ts` is the sole Task 8 production ambient `process.env` snapshot. The snapshot filters credential/control names and is explicitly injected into CLI, ExecutionHost, RunnerInternal, final-verification profile/runtime, semantic probes, and test composition roots.
- Task 8 migrated families no longer rely on implicit ambient environment fallback.
- The production source guard parses Runner `.ts/.mts/.js/.mjs/.cjs/.ps1` plus package/launcher entries and rejects static, namespace, destructured, aliased, and dynamic `child_process` execution, `fork`, member `.kill`, `process.kill`, `taskkill`, shell flags, PowerShell/`.ps1` launch, and migrated-family ambient environment reads.
- Raw execution exceptions are symbol-level with narrow reasons. No migrated family or whole file is blanket-exempted.
- Windows portable supervisor helper identities are bound from the injected `SystemRoot`/`windir`, never supervisor ambient PATH. Production backend requests pre-bind absolute PowerShell/taskkill identities; direct portable supervision resolves only from its encoded environment.
- `ExecutionHost.withGitInspection` now injects the run ambient snapshot into Windows semantic probes.
- Final-verification managed call IDs are scoped by generation/attempt/category, preserving SessionAuthority's one-call/one-grant rule across sequential runtime-smoke/browser checks.
- A Windows Job backend selected from an independently verified `jobContainment` semantic fact retains that run-scoped attestation instead of re-running the optional PowerShell capability probe on every later command. Direct/unattested Job backends still probe dynamically.

## Requirement traceability

1. **Provider inventory:** `task8-raw-launch-closure.test.ts` proves the exact closed transport union, factory constructors, and absence of local model child launchers.
2. **Whole-tree raw-launch audit:** the same guard scans supported Runner production/source/script surfaces and requires every finding to match a live symbol-level allowlist entry.
3. **Alias/dynamic/shell coverage:** ten independent mutations cover aliased `execFile`, aliased `spawn`, namespace alias, dynamic import, `fork`, member kill, ambient env, taskkill, shell flag, and `.ps1` launch.
4. **Ambient centralization:** `native-build-factory.ts` owns the only Task 8 `process.env` snapshot; downstream production and direct-construction tests use injected filtered sources.
5. **Windows helper identity:** `windows-process-backend.test.ts` decodes the actual portable supervisor request and verifies exact injected PowerShell/taskkill paths; stale-parent/direct fixtures use the same explicit source.
6. **Final-verification identity:** `final-verification-managed-authority.test.ts` proves two sequential verification check adapters produce five distinct fresh ToolBroker call identities.
7. **Job semantic attestation:** `windows-process-backend.test.ts` proves a backend selected by a verified Job fact consumes the active capability probe once, while omitted/unverified facts still fail closed.
8. **Task 8 exit:** 8.1–8.4 remain VERIFIED in the P6 ledger and Task 8.5 does not weaken their authority, cancellation, evidence, platform, or cleanup invariants.

## Causal fault evidence

The mandatory raw-launch closure mutations each produced a behavioral RED and were restored before the guard returned GREEN:

- aliased `execFile`
- aliased `spawn`
- namespace alias
- dynamic `child_process` import
- `fork`
- member `.kill`
- migrated-family ambient `process.env`
- `taskkill`
- shell launch flag
- `.ps1` launcher

Additional source-bound RED/GREEN evidence covers final-verification cross-category call-ID reuse and repeated Job capability probing after verified semantic selection. Windows helper binding and direct-fixture failures also reproduced the removed ambient fallback before explicit helper injection.

## Acceptance validation

- Raw-launch closure + configured-provider inventory: **2/2 passed** (`raw-launch-final-green`).
- RunnerInternal MCP/Git internal execution context: **8/8 passed**, 8 roots created/8 removed (`runner-internal-focused-green`).
- Process-host semantic probes: **27/27 passed**, 34 roots created/34 removed (`process-host-semantic-green`).
- Complete Windows process backend file: **90/90 passed**, 65 roots created/65 removed (`windows-process-backend-final`).
- Native final-verification factory end-to-end: **1/1 passed**, 6 roots created/6 removed (`native-final-verification-green5`); build, tests, runtime-smoke, browser, submission, and workspace cleanup all complete green.
- ExecutionHost focused composition: GREEN, 3 roots created/3 removed (`focused-execution-host-final`).
- Final-verification managed call-scope regression: GREEN with fresh operation/check identities (`final-managed-call-scope-green`).
- Verified Job semantic-attestation regression: GREEN (`job-semantic-attestation-green`).
- Windows helper binding regression: GREEN (`windows-helper-binding-green`).
- TypeScript: exit 0 (`typecheck-acceptance`).
- Full Runner ESLint: exit 0, **0 errors**, one pre-existing `mcp-tools.test.ts` unused-import warning (`eslint-acceptance`).
- `git diff --check -- runner-v2`: exit 0 (`diff-check-acceptance`).

The broad 12-file affected diagnostic passed **274** tests and reported four stale test-boundary failures after the product changes. Those four were independently repaired without further product changes: two RunnerInternal cases are covered by the full 8/8 current file, the raw-launch guard is current 2/2, and the CIM-uncertainty case is included in the current 90/90 Windows backend file. A redundant full rerun was intentionally not repeated because the current complete changed files and exact failed surfaces are green and the remaining 274 broad tests had already passed against the accepted product source.

## Resource and repository accounting

- Every successful accepted Task 8.5 run records **0 retained roots**.
- `windows-process-backend-final` releases all 65 roots; `process-host-semantic-green` all 34; `runner-internal-focused-green` all 8; `native-final-verification-green5` all 6; focused accepted runs likewise retain none.
- **17 retained roots** referenced by Task 8.5 receipts belong only to deliberate RED/failed/diagnostic runs and remain preserved as failed evidence; none are relabeled as successful cleanup.
- The Task 8.5 protected baseline contains **1,875 files**: zero drift, zero missing (`protected-final.json`).
- Git index is empty before staging. Unrelated benchmark/UI/package/ZIP/calibration and prior-task changes remain outside Task 8.5 scope.
- `final-audit.json` records the 20 accepted Runner source/test hashes, selected acceptance receipts, provider inventory, mutation REDs, protected comparison, and failed-evidence roots.

## Acceptance decision

**Task 8.5 is VERIFIED. Task 8 is closed.** No configured local provider child process exists; the Task 8 execution families have no unapproved raw-launch or ambient-environment escape; exact native/provider-host exceptions remain guarded by live symbol-level allowlisting and causal mutations.

Task 9 (Git indirect-execution hardening) is now eligible. P6 remains in progress through Tasks 9–12. No push/publication was performed.
