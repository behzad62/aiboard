# Native benchmark implementation

Requested 26 October 2026: apply the benchmark audit, with Recoverable Job Service as the signature HarnessBench.

## Scope

- Promote RJS into a runnable HarnessBench track; preserve its frozen contract, evaluator, budgets, and historical evidence.
- Replace the live scripted ToolBench path with native Runner V2 fixture sessions and behavioral verification. Keep legacy evaluators only for historical replay and experimental TeamIQ; close their confirmed loopholes.
- Remove static WorkBench cases from current rankings, retain a bounded behavioral smoke pack, and mark TeamIQ experimental.
- Remove the disconnected Live builds tab; scope recommendations and efficiency to comparable measured profiles; refresh documentation and deduplicate CI.
- Add targeted negative controls and integration coverage, then run the affected benchmark checks and build checks. Do not substitute these for Runner V2 Task 12 acceptance.

## Implemented

HarnessBench was a display-only placeholder. It now runs Recoverable Job Service through the native execution bridge and is the default signature benchmark. The user's RJS direction supersedes the original audit's recommendation to keep it optional. The frozen contract, private evaluator, binary scorer, 69 mandatory modeled families, 302 variants, and per-attempt budgets are unchanged. Only the documentation hash was refreshed for the updated README.

| Audit recommendation | Result |
| --- | --- |
| Measure the production tool protocol | ToolBench v4 runs a single model directly through production provider adapters, the agent loop, native tools, broker and accounting. It never creates a Build, Architect, reviewer, integration or documentation workflow. |
| Reject false completion and fabricated verification | Six core fixtures execute real behavioral checks. Qualification also requires successful native tool calls, exact command/argument evidence, delivered target text, and coordinated patch evidence where requested. |
| Prove recovery occurred | The v2 core recovery fixture requires a real stale-context rejection followed by a successful patch; the verification fixture requires a failed check followed by the same command passing. Exact stale-SHA protection also has a production-tool regression control. |
| Enforce qualification scope | Recorded permission, command, protected-path, and workspace-scope denials fail the case. Unsettled tool calls cannot qualify. Missing or mismatched ledger evidence is an invalid harness attempt rather than a model failure. |
| Measure effectiveness | Native action counts, tokens, priced costs, and elapsed time are retained. Extra tool requests reduce ToolBench's separate efficiency diagnostic. Behavioral completion remains the primary score. |
| Add capability profiles | Native core, a separate data variant, optional actual-browser/owned-process, and project-skill profiles are selectable. Each has separate result identity. |
| Retire weak rankings | Current WorkBench is three behavioral pipeline smoke cases. Static language fixtures and legacy ToolReliability results are excluded from current rankings; stored raw evidence and exports remain available. |
| Simplify the product | Default presets are HarnessBench, ToolBench, and Both, with separate scores. Team configurations and experimental TeamIQ remain in Advanced. The disconnected Live builds tab is removed. |
| Compare like measurements | Result identity retains source digest, Node/platform, fixture/scorer versions, budgets, model/provider, and effort. Rankings default to a matching measured profile; signature recommendations use HarnessBench alone. Mature evidence requires three complete comparable runs, not three cases. |
| Preserve regression coverage | Legacy evaluator loopholes have negative controls, action accounting is corrected, and CI no longer invokes the same certified test groups twice. Provider tests and Runner safety checks were retained. |

Runner downloads were rebuilt with the native evidence helper. Managed ledger exports are read-only, bounded, restricted to the attempt's state, and checked against its run identity. Attempt IDs hash the complete owner identity so long shared prefixes cannot collapse separate models into one workspace.

## Verification

All checks below used deterministic fixtures, mock model transports, or local tools. No live provider/model calls were made.

| Check | Outcome |
| --- | --- |
| Native core/variant/skill verifier positive and untouched negative controls; production agent-loop revision recovery; real SQLite ledger export | Passed |
| Native adapter evidence ownership, unavailable infrastructure, failed target delivery, cancellation, and cleanup controls | Passed |
| Actual Chromium/browser tools with a local HTTP fixture and observable saved state | Passed |
| Benchmark publication, track, and end-to-end groups | Passed |
| WorkBench group | Earlier tests passed; stale bundle expectations were corrected, then the bundle test and all remaining runner/timeout/MCP tests passed individually. |
| RJS checkout, release/identity, integration, and truthful-capacity evaluator controls | Passed; frozen contract/suite hashes verified. |
| Affected TypeScript/JavaScript ESLint and application TypeScript check | Passed |
| Next.js production static export | Passed in an isolated source snapshot using webpack, avoiding the active development server's `.next` directory. |
| Hydrated desktop and 390px mobile benchmark UI | Passed: signature default, appropriate runner downloads, run gates, no Live builds tab, no page errors or horizontal overflow. |

The full `npm run test:benchmark` gate is **not green**. Three untouched provider test scripts block the broad unit group in this environment:

- `scripts/test-nvidia-capability-lab.mts`: its assertions pass, then Windows Node 24.18.0 aborts during shutdown with `UV_HANDLE_CLOSING`.
- `scripts/test-provider-registry.mts`: three assertions still expect earlier standalone-runner downloads/commands; the current registry advertises the unified account-provider ZIP and `npm install` / `npm start`.
- `scripts/test-account-provider-runner-copilot-chat.mts`: the fake SDK request/cancellation assertions fail; the preceding fallback request and disconnect checks pass.

These tests and their provider implementations were not changed as part of this benchmark work. Their failures are recorded rather than bypassed. Validation logs and UI captures are in `D:/tmp/native-benchmark-validation/` on this machine. Runner V2 Task 12 acceptance gates were not run or changed.

## Calibration boundary

The user subsequently authorized a first live ToolBench run on DeepSeek-V4.1-Flash at Default effort. The first v1 attempt was stopped and excluded after its live trace exposed an invalid qualification assumption: DeepSeek's production Responses adapter replaces fs.patch/fs.write with provider-native apply_patch. No v1 model score should be inferred from that diagnostic attempt. The v2 suite accepts the available production editing protocol, tests real stale-context recovery and coordinated native changes, and has transport-to-broker regression controls. Evidence from the stopped attempt is in `D:/tmp/aiboard-development/calibration-deepseek-toolbench/`.

Results now includes settled costs per benchmark run and optional provider-reported USD side by side. At the user's request the difference column was removed. Provider USD is separate metadata; local pricing and budget enforcement remain independent. The first calibration's recorded DeepSeek rates are the configured peak rates; published off-peak rates are half those rates, so the estimate must not be described as provider-billed dollars.

The six-case v2 DeepSeek calibration finished with four budget failures and two invalid-harness outcomes. Publication correctly refused a ranking; the earlier UI then showed only empty winner cards, hiding the useful case diagnostics. Results now shows all recorded case outcomes, including unpublished batches, with failure reasons and per-case usage. Invalid outcomes stay excluded from model scoring. See [the calibration report](calibration-2026-10-26-deepseek-flash.md).

The earlier pre-calibration stop was honored until that explicit live-run authorization. Deployment has not been initiated. Other model runs, repeats, and broader capability calibration still require their own setup.

Use deployment-matching Runner source for ToolBench qualification. The dedicated RJS download retains its accepted Runner snapshot; a ToolBench result obtained with that snapshot applies to that source digest. Results from different source digests remain separate profiles. The repository Bench Runner can use the local source while retaining the frozen RJS evaluator.

Core results do not certify arbitrary MCP integrations, project-memory policies, or all role-specific tools. Optional profiles report only their exercised capabilities. The current data variant is public fixture variation, not a secret held-out corpus. Broader role/MCP profiles and predictive difficulty/saturation claims require the actual deployment setup and live calibration.

## Historical v3 calibration revision

The user requested fivefold emergency limits and a repeat on the same DeepSeek model. ToolBench v3 has 5M input/750K output tokens, 300 model/900 tool calls, and 4,500 seconds per case. The six capabilities remain; the bounded-file case now extracts a small value with a checked range instead of reproducing a large file. Every fixture includes a dependency-free public check and npm test entry, eliminating repeated discovery of absent test infrastructure. ToolBench objectives no longer contradict the requested red/green command sequence by demanding only git diff --check evidence. Native Git inspection is named explicitly.

The v2 missing-pause error was a structured verifier-selection budget stop; the adapter now reads that structure and preserves actual failure details. The atomic-edit error was a legacy-policy verification checkout following a physical documentation tip instead of the scheduler-bound profile revision. Final checks and flaky reruns now pin the exact authorized generation revision for both policy versions, retain ownership/current-generation checks, and do not alter user checkouts or weaken stale-profile rejection. A production factory regression exercises that legacy path with a newer physical documentation commit.

Validation passed: both native final-verification factory tests (including actual command execution), 24 profile/workspace ownership and stale-profile tests, real filesystem/provider-patch fixture controls, adapter pause/cancellation/evidence checks, publication, current suite names, historical evidence filters, dashboard selectors, application and Runner TypeScript, and affected ESLint. Runner downloads were rebuilt. Recovery qualification additionally rejects successful edits before the intended fault and requires a real current-file read before retrying. RJS's frozen contract and budgets are unchanged.

At the rerun boundary the browser tool reported “Local browser use is disabled in Work settings.” Access was subsequently restored. After the user explained that ChatGPT restart had stopped the local services, both development services were restarted and the authorized DeepSeek/Default v3 pass began at 20:04 Dubai on 26 October 2026. Its first case completed mechanical final verification and continued into independent review. This is an in-progress measurement, not a final v3 qualification result; the historical v2 report remains separate.

Deterministic controls establish mechanics and evaluator validity. They are not measured model rankings. RJS's modeled service contract does not certify native operating-system process/container safety.

## Current execution design after the v3 investigation

The Run tab now contains only ToolBench and HarnessBench. The Advanced WorkBench/TeamIQ launcher, its duplicate runner/model controls, and its dedicated selection components have been removed. Internal smoke fixtures and legacy evidence readers remain available to regression tests and historical data handling; they are not user-facing run options. Data import, export and saved reports are preserved.

The user's clarified design supersedes the earlier Build-based ToolBench implementation. ToolBench v4 (`solo-toolbench-v4`) is an authenticated, durable solo session hosted by Runner V2. It reuses production transports (including DeepSeek's native patch protocol), the agent loop, filesystem/process/browser/skill tools, permission and mutation fencing, SQLite evidence and usage accounting. `finish_toolbench` submits the task to external deterministic scoring; no grading verdict is sent back into the model loop. Public command output and ordinary tool errors remain normal task feedback. Hidden scoring files remain outside the live model workspace and are restored only for final external scoring. The hidden verifier command is removed from the model allowlist, and benchmark commands cannot inject environment overrides to preload it. The optional browser task cannot write its success file with filesystem tools.

All six core cases retain fivefold emergency guards: 5M input tokens, 750K output, 300 model calls, 900 tool calls and 4,500 seconds. These are safety stops, not target task sizes. Task duration covers the agent session and excludes runner startup and cleanup. Every completed, failed or cancelled session exports available model/tool traces and cost provenance. Restart never resumes paid calls automatically: reservations are retained as estimates, owned execution bindings must reconcile before the control plane starts, and the interrupted attempt is a harness failure. Compatibility checks reject runners lacking solo sessions before provider configuration/model calls.

HarnessBench v3 always creates the full Build crew: Architect, one Worker and Reviewer/Verifier. The Run tab exposes three model slots and “Use Architect model for all roles”; no topology selector or automatic direct-model baselines remain. Reusing one model still runs separate role contexts, requires the verifier, and produces a model comparison result. Mixed-model crews produce team results. The frozen Recoverable Job Service evaluator, 69 families, 302 variants, binary scorer and budgets are unchanged. The pinned RJS distribution still identifies its separately accepted Runner snapshot; this change does not promote that snapshot or claim Runner Task 12 acceptance. Current development source and the generic runner distribution expose the solo API; a pinned bundle without it is refused for ToolBench.

Completion-time Architect questions now return a typed blocked result instead of throwing a missing-action error. Unattended benchmarks fail visibly on that question and never blindly continue an autonomous-pump error. Full Build measurements also have an absolute wall-clock guard and an idle watchdog that checks for active operations. Documentation feedback now distinguishes the STATE commit's completion-gate facts from the latest document commit and explicitly asks for STATE to be committed last. The gate itself is preserved.

Targeted validation covers all six real-tool core sessions and project skills with scripted models and the actual deterministic verifiers; authenticated control, scope and hidden-oracle rejection, budget preflight, cancellation, deadline, restart accounting and cleanup; HarnessBench role mapping and same-model configurations; completion-time questions and documentation snapshots; publication/cancellation/UI contracts; application/Runner TypeScript and production build. These checks use no paid model calls. The stalled v3 process was stopped with its evidence preserved. Visual verification and a new in-app live calibration remain pending while browser control is disabled in Work settings.
