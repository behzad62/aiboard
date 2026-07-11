# Runner V2 Provider, API, and Browser Cutover Plan

**Goal:** Make the Node 24.18.0 native runner the mandatory and sole owner of Build execution, while the browser becomes a control/observation UI.

**Architecture:** The authenticated runner stores provider runtime configuration encrypted with a key derived from the runner token, adapts provider streams into the native `AgentModel` contract, and creates complete `BuildRuntime` instances from durable run configuration. The browser submits a Build specification once, then uses authenticated projections, event replay/SSE, pause/resume, and explicit Architect handoff selection. No model loop, task scheduler, verifier, or mutable Build checkpoint remains in a browser tab.

## Invariants

- Browser refresh/close cannot stop, fork, or overwrite a Build.
- Exactly one runner-owned runtime exists per run ID.
- Provider credentials are never emitted in events/logs/responses and are encrypted at rest.
- Account-runner, OpenAI-compatible, Anthropic, and Google transports expose native tool calls and usage through one `AgentModel` interface.
- Worker failover is automatic and capability-compatible; Architect handoff always waits for user selection.
- Build commands are idempotent and projections/events are replayable after restart.
- Browser Build code cannot fall back to `lib/client/build-engine.ts`.

## Task 1: Provider-neutral runner transport and encrypted configuration

Create `provider-config-store.ts`, `encrypted-provider-config-store.ts`, `account-runner-model.ts`, and `openai-compatible-model.ts` with scripted HTTP tests. Normalize native tool calls, string/tool-result conversations, usage, cancellation, HTTP failure metadata, and account-runner SSE. Derive AES-256-GCM storage keys from the runner token; redact secrets from every error/event.

## Task 2: Durable native Build runtime factory

Create `native-build-factory.ts` and `native-build-manager.ts`. On run creation, compose scheduler/session/tool/budget/evidence/memory stores, workspaces, integration manager, provider health/router, native Architect, and native workers. Rehydrate every nonterminal Build at runner startup. Persist run specification, model assignments, limits, permission profile, and initial Architect selection.

## Task 3: Complete authenticated Build API

Extend `/v2/runs` creation with a versioned Build specification and add health/capabilities, projection/tasks/guidance/evidence/budget/provider-health endpoints, pump, pause/resume/stop, and user Architect-handoff selection. Add scheduler SSE replay so browser activity is durable and cross-tab consistent. Ensure request idempotency and CORS limited to loopback origins.

## Task 4: Browser Runner V2 client and activity projection

Create `lib/client/runner-v2.ts` with Bearer auth, typed create/control/query APIs, SSE reconnect by sequence, and no credential logging. Map scheduler/run events into existing Activity UI shapes without persisting an authoritative browser checkpoint.

## Task 5: Discussion-page cutover

For Build mode, require a healthy Runner V2 and Git before Start/Resume. Submit the discussion spec and provider configurations to the runner, then render runner projections/events. Stop/Resume target runner commands. Refresh merely reconnects and replays; it never launches another engine. Keep non-Build discussions browser-side.

## Task 6: Remove browser Build execution and old runner assumptions

Delete the Build branch dynamic import from `lib/client/engine.ts`, stop shipping/using `scripts/runner.mjs` for Build, and quarantine/remove `lib/client/build-engine.ts` plus obsolete browser Build checkpoint authority after migration tests pass. Retain only any independently used benchmark helpers by moving them to explicit modules.

## Task 7: Fault and live validation

Test browser refresh, two tabs, runner restart at model/tool/guidance/review/integration boundaries, provider usage-limit cooldown, malformed tool calls, budget exhaustion, Git conflicts, and full-access operations. Then continue AIPaintball through the new runner, observe real progress, and fix only systemic Runner V2 defects discovered.

## Completion gate

On localhost, a Build started from AIBoard continues with every browser closed, survives runner restart without duplicate model/tool/Git effects, shows identical activity after refresh or in a second tab, pauses Architect handoff for the user, and completes AIPaintball only through the Architect’s typed completion action. The browser bundle contains no Build execution engine.
