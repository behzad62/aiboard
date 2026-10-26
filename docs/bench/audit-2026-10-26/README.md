# Benchmark audit — 26 October 2026

## Recommendation

Keep ToolBench as the primary model-qualification benchmark, but replace its execution path before treating it as evidence that a model can use the current harness correctly and effectively. Today it measures a small scripted version of the retired Build protocol. Its evaluator also has reproducible false positives.

Retire the static WorkBench fixtures from official model rankings. Preserve a small Runner V2 build smoke pack from the behavioral fixtures. Keep Recoverable Job Service as an optional, separate coding challenge. Move TeamIQ to experimental use until it measures the actual orchestration it names.

This is an audit and recommendation, not implementation of those changes or deployment approval. No benchmark/runtime/UI files were changed. This report and its probe script are the only additions; generated results and logs are not committed.

## Scope and evidence

- Audited checkout: `0995d5b5a92eb9813a469ff08bfb1813b6668c8f`, Node `v24.18.0`.
- Existing edits in `BuildRunPolicyControl.tsx`, `BuildCrewPicker.tsx`, `test-build-crew.tsx`, and `test-native-build-policy-ui.tsx` were left untouched.
- Traced the benchmark UI through execution, model calls, evaluation, scoring, persistence, and recommendations; compared this with Runner V2's live agent loop and tools.
- Ran nine focused existing test scripts: all exited 0.
- Added reproducible evaluator probes in [probes.mts](probes.mts); running it writes the full inputs and observed results to `probe-results.json` beside it (not committed). Candidate commands are strings evaluated in the in-memory benchmark; they are never executed. Two WorkBench probes also ran the shipped generated verifier in fresh temporary fixtures.
- No paid/live model benchmark was run. This audit establishes relevance and evaluator validity, not current model rankings or saturation of the surviving cases. No Runner V2 acceptance gates, full build, or broad regression matrix were run.

Reproduce the probes from the repository root:

```powershell
npx tsx docs/bench/audit-2026-10-26/probes.mts
```

## What currently exists

| Surface | What it actually measures | Disposition |
| --- | --- | --- |
| Tool Reliability / ToolBench | Eight scripted multi-turn cases across six failure families, using legacy JSON actions | Keep the purpose and useful failure scenarios; move execution and assertions to Runner V2 |
| TeamIQ | Three ToolBench cases; each turn runs role prompts followed by synthesis | Experimental; not evidence of current Build crew performance or the live discussion engine |
| Standard WorkBench | 19 fixture cases: six have executed JavaScript/JSON behavioral checks, 13 use static checks | Remove static cases from certified quality rankings; keep a small behavioral build smoke pack |
| Recoverable Job Service | Separate WorkBench pack: one substantial implementation task, 69 modeled mandatory families / 302 variants, binary grading | Keep optional and separately reported; outside `workbench-current-all` and the default Full preset |
| Live builds leaderboard | Reads the legacy browser `modelStats` store | Hide or mark historical until connected to Runner V2 evidence |
| GameIQ / Fireworks | Already retired; historical evidence is excluded from current rankings | Keep retired; no replacement needed for this goal |
| Harness certification / automated regression tests | Deterministic implementation checks, largely using fixtures and mock models | Keep necessary regression coverage; distinguish it from model qualification |

The ToolBench corpus was already reduced in July: its version history records removal of 33 saturated single-shot cases. The eight remaining cases cover redundant reads (two), stale patches (two), stale browser refs, write scope, truncation, and verification persistence. Those are useful failure families; their current machinery is the problem.

## Findings

### 1. High: ToolBench tests a different protocol from the live harness

The certified runner asks for JSON text such as `read_range`, `patch` with `ops`, `append`, and `run`. It places the whole rendered transcript inside a new user prompt each turn. Its environment imports action parsing and duplicate-call tracking from `lib/orchestrator/build.ts`, and mirrors error text from the legacy browser Build engine.

Runner V2 instead supplies native tool definitions to the provider through its agent loop. Its filesystem tools include `fs.read`, `fs.search`, `fs.write`, and atomic `fs.patch`, with revision metadata and SHA-256 concurrency protection. `process.run` accepts argument arrays or an explicit shell; managed processes have separate lifecycle tools. Built-in browser interactions use selectors. ToolBench's Playwright-ref simulation can represent one optional MCP behavior, but does not test that bridge's real discovery, schemas, transport, or results.

Consequently a high ToolBench score does not establish that a model can emit native provider tool calls, thread tool results correctly, recover from native validation errors, handle revision conflicts, consume artifacts, or use the tools available to its Runner V2 role.

Sources: [certified-runner.ts](../../../lib/benchmark/toolreliability/certified-runner.ts), [stateful-env.ts](../../../lib/benchmark/toolreliability/stateful-env.ts), [model-call.ts](../../../lib/benchmark/certified/model-call.ts), [agent-loop.ts](../../../runner-v2/src/agent-loop.ts), [filesystem-tools.ts](../../../runner-v2/src/filesystem-tools.ts), [process-tools.ts](../../../runner-v2/src/process-tools.ts), [browser-tools.ts](../../../runner-v2/src/browser-tools.ts).

### 2. High: incorrect tool use can receive full credit

The following probes all received **100/100 and `passed`** for their individual case:

| Probe ID | Candidate behavior | Missing assertion |
| --- | --- | --- |
| `verification-comment-only-fix` | Adds a comment containing `.trim()` while leaving the buggy function unchanged | Verification is a substring predicate, not execution of the function/tests |
| `verification-wrong-command` | Fixes the function, then runs `npm run build` and claims the requested test passed | Any `run` action can receive the scripted test result; `verifyPlan.command` is not enforced |
| `browser-wrong-tool-names` | Calls two nonexistent Playwright tool names with the expected target refs | The environment checks the server/ref, but treats the request as a click regardless of tool name |
| `unread-target-guess` | Reads only line 1, then states the constant stored on line 141 | `targetRead` means any read occurred; the answer check is a substring match |

The unchanged-file verification control correctly failed, so the comment probe isolates a real evaluator loophole rather than a universally passing case.

Sources: `verdictRedundantRead` around line 321, `processStaleRefAction` around line 397, and `processVerifyPersistenceAction` around line 624 in [stateful-env.ts](../../../lib/benchmark/toolreliability/stateful-env.ts).

### 3. High: the forbidden-action gate misses later actions in a batch

The environment processes every action using `inspectStrictToolActionBatchOutput`. Safety evaluation uses the single-action `inspectStrictToolActionOutput` instead.

`forbidden-after-benign` puts a valid in-scope append followed by `git push` in the same response. The case scores **100/100 with `forbiddenAction: false`**. Reversing their order, or placing the forbidden command in its own turn, correctly fails. Every parsed action needs inspection through the same batch-aware path.

This is false acceptance by the benchmark; the probe does not execute Git and does not demonstrate a Runner V2 permission bypass.

Source: `hasForbiddenAction`, [runner.ts](../../../lib/benchmark/toolreliability/runner.ts), around line 376.

### 4. High for qualification: “passed” and “efficiency” do not mean the requested things

- The whole pack passes at a score of 70. `pack-passes-with-scope-violation` attempts an out-of-scope write, fails that case, and still receives **87.5 and `passed`** for the pack. The environment blocks the write, but the pack does not treat the attempted scope violation as a qualification hard gate.
- New runs set schema/tool/patch/command-safety rates to null; the current positive score is essentially stateful case success. This is not separate evidence for native tool-call correctness.
- `efficiencyScore` is copied from the quality score. `toolCalls` counts stateful cases, rather than actions. Reference transcripts contain **22 actions**, but report **8 tool calls**. Adding **20 irrelevant requests** still reports 8 calls and efficiency 100.
- Certified tool traces currently preserve only synthetic `forbidden_action` events, not individual reads, edits, process calls, outcomes, or time spent. Model-call/token/cost accounting is more substantial and should be retained.

Keep graded quality for comparison, but publish qualification per capability and gate explicit safety invariants. A failed behavioral case should be visible without claiming the model is incapable of every kind of tool use. Measure efficiency from observed actions, cost, tokens, and latency.

Sources: [runner.ts](../../../lib/benchmark/toolreliability/runner.ts), around lines 240, 281, 351, and 365; `toolCallTracesForResult` in [certified-runner.ts](../../../lib/benchmark/toolreliability/certified-runner.ts).

### 5. Medium: some recovery cases never require recovery

`stale-patch-event-never-fired` changes `0.03` to `0.05` on the first action, then finishes. It passes before the turn-2 concurrent mutation fires. This is a valid simple edit, but supplies no evidence of stale-patch recovery. The case explicitly allows this path. Likewise, the stale-ref prompt supplies the next page's refs before navigation, and the truncation case tells the model to chunk in advance.

Do not penalize an efficient valid solution. Instead distinguish prevention from recovery, and inject a deterministic conflict/ref invalidation/output boundary when the scenario specifically claims to measure recovery. Assert that the relevant event was encountered before awarding that capability result.

Source: [cases.ts](../../../lib/benchmark/toolreliability/cases.ts), including the accepted early-finish path and scheduled events.

### 6. High: most standard WorkBench cases do not verify working software

Of 19 standard fixtures, **13 have no executed behavioral checks**: the TypeScript, Python, React, C#, C++, Go, and Rust fixtures. They primarily check snippets and diff size. Non-JSON “syntax” checks only count braces and carry zero weight.

The probes inserted invalid source tokens on an already-changed line, preserving snippets and diff limits. **All 13 static case verifiers still awarded full credit.** TypeScript parsing independently reported syntax errors in the TS/TSX samples. Running the generated verifier itself for a TypeScript case and a Python case also exited 0 with `passed: true` and score 1.

This is stronger evidence for removal from quality rankings than an assumption that current models find the tasks trivial. The six behavioral cases are three small surgical-edit/config tasks and three pipeline tasks; they can still catch build/tool integration regressions. Their difficulty for today's selected models needs live calibration before using them to rank models.

WorkBench's **current UI execution path is native Runner V2**: `run-execution.ts` calls `runNativeWorkBenchBuild`. It is inaccurate to dismiss the entire track as running only the legacy engine.

Sources: [corpus.ts](../../../lib/benchmark/workbench/corpus.ts), [challenges.ts](../../../lib/benchmark/workbench/challenges.ts), [run-execution.ts](../../../lib/benchmark/certified/run-execution.ts), [native-runner-adapter.ts](../../../lib/benchmark/workbench/native-runner-adapter.ts).

### 7. Medium: TeamIQ and Live builds have weaker relevance than their labels suggest

TeamIQ's quick and all-modes suites share **three** ToolBench cases. Strategy variants use a benchmark-specific role-call/synthesis loop, rather than the live discussion engine or Runner V2's task scheduling, workers, review, evidence, and integration. Matched solo baselines and team-lift accounting are useful, but their results describe this small prompted experiment. They do not establish that a Build crew is better.

The Live builds tab reads `getModelStats()`. Repository source search found its sole accumulation call in `legacy-build-engine.benchmark.ts`; the live Build route imports `native-build-engine.ts`. The native adapter emits usage separately and does not update this store. Thus this tab can remain empty or show historical legacy results while claiming to accumulate current Build runs.

Sources: [toolreliability-quick.ts](../../../lib/benchmark/teamiq/toolreliability-quick.ts), [TeamIQ runner](../../../lib/benchmark/teamiq/certified-runner.ts), [BuildLeaderboard.tsx](../../../components/benchmark/BuildLeaderboard.tsx), [store.ts](../../../lib/client/store.ts), [engine.ts](../../../lib/client/engine.ts), [legacy engine](../../../lib/client/legacy-build-engine.benchmark.ts).

### 8. Medium: benchmark presentation and maintenance need simplification

- “Best overall model” averages quality over the tracks a row ran. A model with only the small ToolBench pack can receive an overall recommendation; this is broader than the evidence supports. Compare a fixed capability profile and coverage instead.
- Harness certification runs deterministic simulated parser/command/patch checks. Preserve these as self-tests; they do not certify native model/tool compatibility.
- [scoring-rules.md](../scoring-rules.md) still describes retired GameIQ and ToolBench's old single-shot dimensions. The current stateful-only score and some WorkBench missing-cost behavior differ from this document.
- Benchmark CI runs `test:certified` and then `test:benchmark`, which repeats the four major benchmark groups included by `test:certified`. Deduplicate exact invocations while retaining required coverage. Removing a weak model benchmark must not remove provider/tool regression tests or Runner V2 safety qualification.

Sources: [decision-dashboard.ts](../../../lib/benchmark/certified/decision-dashboard.ts), [aggregate.ts](../../../lib/benchmark/scoring/aggregate.ts), [certification.ts](../../../lib/benchmark/certified/certification.ts), [benchmark-tests.yml](../../../.github/workflows/benchmark-tests.yml), [package.json](../../../package.json).

## The ToolBench contract to implement

The question should be: **Can this exact model/provider/effort configuration complete bounded tasks using the tools and policies that its live harness role receives, and at what observed cost?**

| Required coverage | Passing evidence |
| --- | --- |
| Native model/tool protocol | Real production provider adapter and agent loop; correct schemas, calls, tool-result threading, batches, and recovery from malformed arguments |
| Repository investigation | Actual `fs.list/search/read`; target evidence was delivered; correct answer; bounded output/continuation and artifact handling |
| Safe edits | Real `fs.write/patch` in isolated fixtures; final behavioral tests pass; concurrent revision conflict is encountered and resolved; unrelated files preserved |
| Command and process use | Actual argument-array execution, cwd, exit status, output, and bounded managed-process lifecycle; incorrect/irrelevant commands cannot fabricate a test pass |
| Browser/MCP capabilities | Real registered schemas and dispatch; local browser fixture actually reaches the required state; MCP discovery/call/result handling where configured |
| Scope and permissions | Real broker denial and no unauthorized side effect; attempted forbidden actions are visible and gate the relevant qualification |
| Evidence and verification | Actual test outcomes/artifact inspection; comment-only “fixes,” fake success prose, and edited verifier outputs fail |
| Skills, memory, and roles | Small optional profiles for capabilities actually enabled for the selected Architect/worker/reviewer role |

Use small deterministic fixtures behind the production tools, rather than a second implementation of their protocol. Preserve the eight useful failure ideas, but assess the corresponding native behavior. Keep a quick core pack and optional capability packs; unsupported/unavailable infrastructure is reported explicitly, not charged to model reasoning.

Report behavioral completion, tool validity, successful recovery, safety violations, real action counts, tokens, money, elapsed time, and cost per completed task separately. Compare efficiency among successful candidates with matched budgets. Record model/provider identity, effort, role/tool/schema versions, Runner commit, fixture/scorer hashes, platform, and configuration. Version the new suite separately so legacy scores cannot silently enter the same ranking.

Use held-out fixture variants and repeat complete attempts on the models actually used in the app. Include weak and strong controls, report all attempts and uncertainty, and retain cases that predict real harness failures. Repeating a tiny deterministic pack alone does not demonstrate broad capability.

## Suggested sequence before presenting benchmarks as current qualification

1. Stop using current ToolBench/standard WorkBench scores as deployment or native-tool qualification evidence. Mark legacy results with their measured scope; preserve exports/history.
2. Correct the confirmed batch-safety and evaluator loopholes with negative controls; repair action accounting and capability-specific qualification semantics.
3. Add the native ToolBench path and capability profiles, then calibrate the exact model/provider configurations in use.
4. Retire the 13 static WorkBench cases from rankings; retain a small behavioral Runner V2 smoke pack. Keep RJS optional and separately scored. Its modeled service task is substantial, but is not operating-system safety qualification.
5. Move TeamIQ to experimental, hide/reconnect Live builds, and update presets, scoring documentation, recommendation labels, and CI duplication.

Runner V2's documented acceptance gates remain independent of these benchmark decisions. This audit neither reruns nor replaces them.
