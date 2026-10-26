# ToolBench v3 token and stall investigation

## Finding

This first-case run is not a clean measurement of DeepSeek's tool efficiency. ToolBench was connected to the full native Build workflow, including Architect planning, implementation review, final verification, independent verifier sessions, and legacy project-documentation completion rules. Those stages dominate a tiny tool task. A contradictory documentation-readiness message then amplified the cost, and an unhandled clarification question left the benchmark polling a running state indefinitely.

The implementation used production tools, but that alone did not make its measurement design appropriate. The fivefold budget increase permitted more execution; it did not repair this workflow mismatch. This run must not be used as a model-only efficiency ranking.

## Evidence and accounting

Read-only snapshot from the active managed runner, 26 October 2026. Same first v3 case and model as the current Results row. No new model calls were initiated for this investigation; the live scheduler, model configuration, fixture and source were not modified.

| Portion | Model calls | Provider-reported input tokens | Output tokens | Calculated USD |
| --- | ---: | ---: | ---: | ---: |
| Through successful functional verification and independent review | 39 | 615,059 | 28,255 | 0.073466 |
| Subsequent completion/documentation loop | 48 | 3,180,131 | 35,370 | 0.075364 |
| Total settled | 87 | 3,795,190 | 63,625 | 0.148830 |

**83.8% of input-token usage occurred after functional verification and independent review had passed.** The phase boundary is the durable `verifier.verdict_submitted` event at 20:12:49.674 Asia/Dubai (16:12:49.674 UTC), not an inferred model statement.

By role: Architect 63 calls / 3,516,025 input; worker 13 calls / 153,238 input; independent verifier 11 calls / 125,927 input. All roles used the same configured DeepSeek model. “Independent” means a separate reviewing session, not a different provider/model or a human reviewer.

Input tokens are cumulative provider counts across requests, including repeated conversation history. Of 3,795,190 input tokens, 3,626,112 (95.5%) were cache hits; uncached input was 169,078. This was not 3.8M newly generated tokens: output was 63,625. Cache reuse reduces the priced input charge but does not make the repeated workflow useful. USD is calculated using the recorded configured rates; no provider USD amount was returned.

There is some model-accountable poor tool behavior: the ledger contains five `benchmark_command_denied` results and one `benchmark_hidden_path` result. The worker also ignored the instruction to write STATE.md last. These observations do not justify attributing the whole 3.8M input total to model inefficiency; the run is confounded by harness orchestration and misleading feedback.

## Why the documentation loop happened

1. `runNativeWorkBenchBuild` creates a full Build, not a focused tool session. Its request does not opt into the newer planning/docs policy; the recorded run has docs policy v1. That policy requires model-written documentation before completion.
2. The fixture says only `answer.json` may change. The Build completion workflow also requires `docs/project/README.md`, STATE.md, and marked AGENTS.md/CLAUDE.md sections. Those extra documents do not test repository search, bounded reads or writing the answer. ToolBench inherited an incompatible requirement and a separate document-writing route outside its intended task.
3. The Architect wrote STATE.md at scheduler sequence 52 (20:14:22). At that commit the entry-point facts were `agentsMarkedSection=false`, `claudePointer=false`.
4. By sequence 56 (20:15:27), both entry-point facts were true. Subsequent AGENTS.md/CLAUDE.md commits through sequence 84 also recorded both as true. Repeated marker rewrites were unnecessary.
5. `projectDocumentationReadiness` reads these facts from the latest **STATE.md commit**, still sequence 52. It therefore reports missing AGENTS/CLAUDE markers even after later commits prove them present. In contrast, `renderArchitectProjectDocs` shows entry-point facts from the **latest document commit**. The prompt and completion refusal describe different snapshots without explaining that difference.
6. The actual missing action was to update STATE.md after the entry points, not to discover or rewrite marker encodings. The generic gate messages did not name that action. The model tried repeated encodings and eventually asked for clarification.

Offline reproduction: the actual saved projection produces exactly two readiness issues, missing marked AGENTS and CLAUDE sections. A diagnostic clone replacing only STATE.md's old entry-point flags with the already-proven latest committed flags produces `ready:true`. This does not authorize rewriting live state or skipping the gate; it isolates the stale-snapshot feedback defect. The live projection remains unchanged.

Relevant implementation: `runner-v2/src/scheduler-store.ts` (`projectDocumentationReadiness`, `latestProjectStateCommit`), `runner-v2/src/agent-prompts.ts` (`renderArchitectProjectDocs`, `ARCHITECT_PROJECT_DOCS_INSTRUCTIONS`), and `lib/benchmark/workbench/native-runner-adapter.ts` (full Build construction).

## Why it stalled

- At 20:25:22.165 the Architect recorded the legitimate typed action `architect.question_requested`, question `docs-gate-marker-format`, explaining the scope/docs conflict. The scheduler records a blocking question but leaves status running.
- `advanceFinalVerification` expects the next action to request project handoff. Its `architectStoppedFor` helper recognizes only paused status, so it does not recognize a blocking question as an intentional wait. It throws “Architect returned from completion_decision_required without a typed action,” despite the question event being durable.
- The manager records `autonomous_pump_error` at sequence 87. The benchmark's generic recovery policy sends continue, creating sequence 88, only 298 ms later.
- The next runtime dispatch returns blocked/`architect_question_pending`. No new provider request is needed or pending. The Build projection still says running.
- The benchmark adapter handles completed and paused projections, but not open Architect questions. It therefore keeps polling, and Results says Running with all case outcomes pending.
- The adapter maps `maxWallClockSeconds` to model-active time (`maxActiveMs`); its additional elapsed-budget check occurs after the Build returns. An idle wait with no model calls is not an effective absolute wall-clock deadline. A separate blocked/no-progress deadline is needed.

At the recorded progress check there were zero pending model calls, an empty activity list, and the last settlement was 20:25:22.131. The stall was a harness/control-state issue, not a provider rate limit or a model still reasoning. No further token charges were recorded during that idle interval.

Relevant implementation: `runner-v2/src/build-runtime.ts` (`advanceFinalVerification`, `architectStoppedFor`, `dispatchStep`), `runner-v2/src/scheduler-store.ts` (`architect.question_requested` reducer), and the benchmark adapter's paused-only poll/auto-continue logic.

## Prevention, in order

1. **Make ToolBench a focused native tool session.** Use the same provider adapter, agent loop, tool schemas, broker, workspace fencing and usage ledger. One selected model performs the fixture and explicitly submits it; a deterministic external verifier checks behavior and required tool evidence. Do not run model judges, full project planning, documentation or handoff gates for these small exercises. Test multi-role/full-project orchestration separately, including through the signature HarnessBench. Version this execution change and retain old evidence.
2. **Fix product blocking-state propagation.** A recorded Architect question is a valid intentional stop. Preserve its typed reason through runtime/manager/adapter. Product UI must show Needs input; an unattended fixed benchmark should terminate the attempt with a harness/setup reason when no human input is part of its contract. Never automatically continue a known unresolved question or blindly retry deterministic pump errors.
3. **Make documentation feedback actionable and consistent.** Both prompt and gate should identify the same revision/snapshot. Distinguish absent markers from STATE.md being captured before valid markers, and say exactly which document needs refreshing. Preserve revision/ownership guarantees and keep real product documentation policies separate from fixture scope. Do not resolve this by globally disabling product gates.
4. **Use real emergency deadlines and no-progress detection.** Keep the user-requested 5M input cap. Add an actual elapsed-time deadline independent of model-active time. Track durable progress, pending model/tool work and explicit owner waits; report blocked reasons, and stop repeated attempts at the same unchanged gate after a small bound. Do not mistake a legitimate long pending provider call for an idle state.
5. **Test the full completion contract before paid calibration.** Existing controls proved tool execution, fixture correctness, stale-profile handling and publication boundaries. They did not exercise this combination of legacy docs readiness, question handling and auto-continue through actual completion. Add production-path regression tests for the captured STATE-before-markers sequence, completion-time ask_user, unattended benchmark blocking, and idle deadline. Every fixture needs both a scripted successful native-session completion and failing/blocked controls, with all model calls mocked. Then run one versioned live calibration, without repeated tuning until green.

The investigation itself made no production code change. The subsequent implementation replaces this path with solo ToolBench v4, preserves HarnessBench's full crew, fixes completion-question handling and inconsistent documentation feedback, and adds absolute deadlines and an activity-aware idle guard. The stalled v3 runner was stopped after preserving its usage and diagnostics. See `native-benchmarks-implementation.md` for the implemented boundary and validation; the v3 result is not a valid measure of model efficiency.

## Local evidence

- `D:/tmp/aiboard-development/calibration-deepseek-toolbench/v3-diagnostic-snapshot.json`: full projection, settled usage, observability and scheduler events.
- `.../v3-completion-probe.json`: offline readiness replay and counterfactual flags.
- `D:/tmp/aiboard-development/probe-v3-completion.mts`: read-only offline reproduction against the actual production readiness function; passed.
- `D:/tmp/aiboard-development/probe-v3-tool-risk.mjs`: read-only tool-ledger accounting.

The full snapshots remain local; credentials used for authenticated localhost requests were not printed or written into this report.
