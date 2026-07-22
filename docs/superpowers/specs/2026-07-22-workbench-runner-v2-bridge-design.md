# WorkBench Managed Runner V2 Bridge Design

## Goal

Run every certified WorkBench attempt through an automatically managed, isolated Runner V2 process while preserving the Bench Runner's deterministic fixture, oracle, verification, retention, and cleanup responsibilities.

## Architecture

The Bench Runner remains the WorkBench control plane. It prepares each fixture, owns protected harness material, launches one Runner V2 child bound to the attempt workspace on an ephemeral loopback port, and stops that child before verification. Runner V2 remains bound to exactly one project, so its existing project isolation and durable-build assumptions do not become multi-project concerns.

The browser receives an ephemeral Runner V2 URL and token from the authenticated Bench Runner. A benchmark-only native adapter uses the existing Runner V2 client to configure providers, create and observe the Build, apply final handoff to the prepared fixture, and capture certified evidence.

## Process Discovery and Lifecycle

The Bench Runner locates a Runner V2 distribution in this order:

1. An explicit `--runner-v2-dir` command-line option.
2. A sibling `aiboard-runner-v2` directory next to `bench-runner.mjs`.
3. The repository's `runner-v2` source tree during local development.

Bench health reports whether a usable Runner V2 distribution was found and includes a safe readiness reason when unavailable. The Benchmark UI blocks WorkBench execution until both the Bench Runner and its managed Runner V2 capability are healthy.

The attempt lifecycle is:

1. Prepare the fixture and store canonical harness metadata outside the model-visible workspace.
2. Remove hidden oracle files from the model-visible workspace.
3. Start Runner V2 with `--project` set to the attempt workspace, a state directory outside that workspace, an ephemeral port, and a random per-attempt token.
4. Execute and observe the native Build.
5. Automatically select `apply_to_project` when final project handoff is requested.
6. Capture audit, model usage, model-call traces, tool-call traces, and retained-path metadata.
7. Stop Runner V2 and wait for process termination.
8. Restore canonical hidden harness files and run the deterministic verifier.
9. Delete successful attempts. Retain failed or invalid attempt workspaces and Runner V2 state directories.

Stop and cleanup operations are idempotent. Browser cancellation stops the child before returning. Bench Runner shutdown also terminates every managed child.

## Harness Security

Runner V2 must never receive hidden oracle material. The Bench Runner stores `.bench-run.json` and canonical copies of `case-meta.json`, `negative-control.json`, and `reference-solution.md` outside the model-visible project while the child is running. Verification restores canonical material only after the child has terminated.

The generic verifier script may remain readable but is protected from modification by the existing immutable-harness snapshot check. The verifier result remains verifier-owned output.

Runner-created `.git` data and internal transient files are excluded from Bench snapshots and diffs. Runner V2 state is always outside the attempt project.

## Benchmark Policy

Runner V2 Build specifications gain optional benchmark metadata containing the attempt identity and exact allowed command strings. Benchmark mode:

- enforces the WorkBench command allowlist in process and command-evidence tools;
- starts with no MCP servers;
- keeps filesystem operations contained to Runner V2 task workspaces;
- uses the case's cost, wall-clock, model-call, tool-call, and token limits where Runner V2 supports them;
- requires no human permission approvals;
- automatically resolves an Architect handoff only to the first offered runtime that belongs to the selected team; and
- treats the absence of an eligible in-team runtime as a provider failure.

The Bench Runner's `dependency-only` network value remains a declared label, not an operating-system network boundary, matching its existing warning and certification semantics.

## Native WorkBench Adapter

A focused browser module owns native WorkBench execution. It consumes the case, selected models, team composition, Bench Runner connection, certified run context, and abort signal. It starts the managed child, configures provider transports using shared native provider-configuration code, maps Architect and worker roles, creates a native Build, starts it, polls until a pause or terminal state, applies project handoff, and collects evidence before requesting child shutdown.

The existing product Build engine continues to own discussion persistence and interactive user handoffs. The benchmark adapter does not create a product discussion and does not import the retired browser Build executor.

## Evidence Mapping

Every settled Runner V2 model reservation with attribution becomes a `BenchmarkModelCallTrace`:

- trace ID is stable from attempt ID and reservation ID;
- model, provider, participant, and role come from reservation attribution;
- token, cache-token, cost, and usage-source fields come from the settled reservation;
- timestamps use the reservation settlement time when no finer timestamp exists.

Every completed native tool observation becomes a `BenchmarkToolCallTrace`. A completed observation without `isError` is valid; an errored observation is failed. Aggregate model calls, tokens, cost, and tool calls come from Runner V2's lifetime usage projection.

The complete Runner V2 audit export is stored as a benchmark JSON artifact. Failed and invalid attempts also receive a retained-state JSON artifact containing the attempt workspace and Runner V2 state paths, but never tokens or provider secrets.

## UI

The WorkBench runner panel keeps the Bench Runner URL and token inputs. It adds managed Runner V2 readiness, discovered version/runtime information, and actionable setup text for `--runner-v2-dir` when unavailable. No second persistent Runner V2 token is entered by the user.

During execution the panel reports these phases: preparing, launching Runner V2, building, applying handoff, verifying, and cleaning or retaining. Results expose Runner V2 audit artifacts and retained paths for failed attempts.

## Failure Handling

Distinct safe failure codes cover distribution discovery, child startup, child exit, health timeout, provider configuration, native Build creation, permission or policy rejection, budget exhaustion, Architect handoff, project handoff, missing trace evidence, shutdown, oracle restoration, and verifier execution.

The adapter always attempts child shutdown. Verification never starts while a managed child is alive. If safe shutdown cannot be confirmed, the attempt is invalid and retained without restoring oracle files until the process is confirmed dead.

## Testing

Tests are written before implementation and cover:

- Runner V2 discovery and health reporting;
- managed child start, status, stop, idempotence, cancellation, and Bench shutdown;
- hidden-oracle absence during execution and canonical restoration before verification;
- `.git` exclusion from snapshots and diffs;
- benchmark command allowlist enforcement in native process and evidence tools;
- native provider configuration and team-role mapping;
- automatic project handoff and deterministic eligible Architect handoff;
- model reservation and tool observation mapping into certified traces;
- successful cleanup and failed-attempt retention;
- Benchmark UI readiness gating and status copy; and
- an end-to-end fixture using a deterministic fake provider transport.

The focused WorkBench suite, Runner V2 suite, TypeScript checks, lint, and production build must pass. Because an active development server can corrupt `.next` during a build, production-build verification is run only after stopping or separately isolating the development server.
