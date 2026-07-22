# WorkBench Lifecycle Recovery Scoping Design

## Problem

The WorkBench Runner V2 adapter limits automatic recovery from models that end a turn without a required lifecycle action. It currently stores all Architect and worker lifecycle recoveries under one `model-lifecycle-repair` key. A worker pause can therefore consume recovery capacity needed later by the Architect, even after the worker submits a correct patch and the Architect approves it.

The retained GPT-5.4 Mini trace for `workbench-contract-0001` proves this failure: the third worker attempt produced the exact required patch, `git diff --check` passed, and review approved it. A later Architect no-lifecycle pause was rejected because two earlier, unrelated lifecycle recoveries had exhausted the shared counter. The correct patch never reached integration or the verifier.

## Design

`nativePauseDisposition` will accept the paused task identifier in addition to the reason. Architect `model_ended_without_lifecycle` pauses will use an Architect-specific recovery key. `worker_model_ended_without_lifecycle` pauses will use a worker key scoped to the task identifier. The existing limit of two adapter continuations per key remains unchanged.

This preserves bounded token safety while preventing one actor or task from consuming another actor's recovery allowance. Provider, protocol, budget, autonomous-pump, and unrecognized pause handling remain unchanged.

## Alternatives Rejected

- Reset every counter after any observed progress: this could let one repeatedly stuck actor run indefinitely as unrelated projection changes occur.
- Remove or greatly increase the recovery cap: this would weaken the cap's intended protection against tooling and lifecycle loops.
- Treat all no-lifecycle pauses as model failures immediately: this would discard recoverable correct work and contradict the adapter's existing recovery behavior.

## Verification

An adapter-level regression will simulate a running build followed by an Architect no-lifecycle pause, a worker no-lifecycle pause for task `T1`, another Architect no-lifecycle pause after progress, and then the final project handoff. The current shared-key implementation must fail before handoff. The scoped implementation must issue three bounded continuation commands, apply the handoff, retain audit evidence, and complete normally.

Existing failure tests will continue proving repeated pauses in the same scope stop with the correct certified failure classification.

## Deployment

After tests, lint, typecheck, Runner V2 tests, and production build pass, republish and copy the Runner V2 bundle to `C:\Users\b_a_s\source\repos\WorkBenchTest`, restart the bench runner and web app as needed, reconnect the WorkBench UI, and restart the 19-case GPT-5.4 Mini run.
