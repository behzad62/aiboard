# Worker Architect Guidance Design

## Summary

Build mode should let a worker ask the Architect for task-local guidance when the worker decides that a stronger model can resolve an ambiguity or reduce wasted effort. The first version is intentionally narrow: guidance is advisory, scoped to the requesting task, and does not mutate the task contract.

Workers choose whether a request is blocking or asynchronous:

- Blocking guidance pauses the task until the Architect answers, then reruns the same task with the answer injected.
- Asynchronous guidance lets the worker continue; the answer is attached to the task and shown only if that task returns in a later retry or fix iteration.

The injected prompt must show both the worker's original question and the Architect's answer so the worker can tell what was answered.

## Goals

- Give weaker worker models an explicit path to ask for help without treating uncertainty as failure.
- Preserve Build mode's existing Architect-led task ownership, review, and write-scope enforcement.
- Keep guidance traceable by task and question id.
- Avoid broad global side effects in the initial version.

## Non-Goals

- Do not let guidance requests change `outputPaths`, `dependsOn`, task ownership, or write permissions.
- Do not add a worker-to-worker communication channel.
- Do not automatically broadcast guidance across all tasks.
- Do not replace Architect review/fix cycles.

## User Experience

When a worker is unsure, it may emit a worker-only action:

```json
{
  "action": "guidance_request",
  "mode": "blocking",
  "question": "Should this component reuse the existing settings store or create a separate client cache?",
  "reason": "The task touches provider defaults and storage boundaries."
}
```

The engine records the request on the task with a stable id such as `G-T4-1`.

After the Architect answers, the next worker prompt includes:

```text
ARCHITECT GUIDANCE FOR THIS TASK

Guidance G-T4-1
Worker question:
Should this component reuse the existing settings store or create a separate client cache?

Architect answer:
Reuse the existing settings store. Do not add a second client cache. Keep changes scoped to ...
```

If an asynchronous request is still unanswered when the task continues, the worker can see:

```text
PENDING GUIDANCE REQUESTS

Guidance G-T4-2 is still waiting for Architect response.
Continue only if the task is safe without it.
```

## Data Model

Add a task-local guidance record shape:

```ts
interface BuildTaskGuidance {
  id: string;
  taskId: string;
  mode: "blocking" | "async";
  question: string;
  reason?: string;
  status: "pending" | "answered";
  answer?: string;
  requestedBy?: string;
  requestedAtWave: number;
  answeredAtWave?: number;
}
```

Store guidance records directly on the `BuildTask` as `guidance?: BuildTaskGuidance[]`. Build checkpoints already persist task graphs, so keeping guidance on the task preserves resume behavior without adding another side-channel to snapshot and restore.

## Action Protocol

Add a worker-only terminal/tool action:

```ts
interface GuidanceRequestAction {
  action: "guidance_request";
  mode: "blocking" | "async";
  question: string;
  reason?: string;
}
```

`guidance_request` belongs in the worker action set and in worker tool instructions. It should not be available to Architect plan/review profiles.

The parser should reject empty questions and default invalid or missing `mode` to `"blocking"` only if doing so matches existing tolerant parsing patterns. Otherwise reject malformed requests and ask the worker to retry with valid JSON.

## Engine Flow

Blocking guidance:

1. Worker emits `guidance_request` with `mode: "blocking"`.
2. Engine stores a pending guidance record for the task.
3. Engine calls the Architect with the current task, the worker question, the reason, relevant task context, and any existing guidance for that task.
4. Architect returns a structured advisory answer.
5. Engine stores the answer on the guidance record.
6. Engine reruns the same task with the answer injected into the worker prompt.
7. The task is not counted as failed, bad output, or reviewed until the worker actually produces task output.

Asynchronous guidance:

1. Worker emits `guidance_request` with `mode: "async"`.
2. Engine stores a pending guidance record.
3. Worker may continue in the current loop and produce output.
4. Architect answers before the next relevant task iteration if possible.
5. The answer is injected only when that same task is retried, fixed, or otherwise invoked again.

If the Architect decides guidance has broader convention value, it can put that decision into the normal Architect notes or memory during planning/review. The guidance mechanism itself remains task-local.

## Architect Prompt

Add a focused guidance-answer prompt that tells the Architect:

- Answer the worker's exact question.
- Keep the answer advisory and task-scoped.
- Do not change output paths, dependencies, or ownership.
- If broader conventions are implied, mention them briefly, but rely on normal notes/memory paths to carry them forward.
- Return a concise structured answer.

The prompt should include the task id/title/instructions, output paths, phase spec, current Architect notes, and prior guidance records for the task. It should not need the full wave review prompt.

## Worker Prompt Injection

`buildWorkerTaskPrompt` should render task-local guidance as its own section near the task instructions, before tool instructions and file output rules. Each answered record must include:

- guidance id
- original worker question
- optional reason
- Architect answer

Pending async records should be separate from answered guidance so the worker does not mistake an unanswered question for an instruction.

## Error Handling

- If the Architect guidance call fails for a blocking request, mark the task for retry/fix without debiting the worker as bad output when the failure is provider or network related.
- If a worker repeatedly emits malformed guidance requests, use the existing malformed tool-call handling.
- If an async request is never answered because the task is approved, no follow-up is needed.
- If a worker asks guidance outside its task scope, the Architect answer should redirect it back to the assigned task rather than expanding scope.

## Testing

Add focused tests for:

- `guidance_request` parsing and validation.
- Worker native tool definitions include `guidance_request`; Architect plan/review definitions do not.
- Worker action eligibility accepts `guidance_request`.
- Blocking request stores the question, calls the Architect, and reruns the same worker task with both question and answer in the prompt.
- Async request stores the question and injects the answer only on a later same-task iteration.
- Guidance records persist through Build checkpoint/resume.

## Implementation Boundaries

Store guidance directly on `BuildTask`; do not introduce a global guidance store for the first version. If a task is split, child tasks do not automatically inherit the parent's unanswered guidance unless the worker included that context in the split reason or subtask instructions.

To avoid loops, allow at most one blocking guidance request per task attempt. A later fix/retry attempt may ask again if the new question is materially different.
