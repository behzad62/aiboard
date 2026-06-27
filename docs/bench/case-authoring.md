# AI Board Bench Case Authoring

Certified cases must be deterministic, versioned, and scored by a verifier or rule engine. Lab evidence can be exploratory; Certified evidence must be reproducible enough to compare models, teams, and harness profiles.

## Required Case Fields

- `id`: stable, track-prefixed id such as `workbench-ts-0001`.
- `schemaVersion`: `2`.
- `track`: `workbench`, `gameiq`, `teamiq`, `toolreliability`, or `harnessbench`.
- `caseVersion`: immutable version for the prompt, fixture, and verifier contract.
- `prompt.userRequest`: public task text shown to the model.
- `environment`: runtime type, timeout, memory limit when known, and network policy.
- `verifier`: deterministic scorer contract. Use `verifier-json`, `game-engine`, or `rule-checker`.
- `budget`: official cost, time, model-call, tool-call, and token caps.
- `scoring`: scoring version and primary metric.
- `contamination`: canary, originality flag, and reference-solution privacy.

## Authoring Pipeline

1. Select the capability target.
2. Draft an original task and public prompt.
3. Add a canary string.
4. Write the reference solution.
5. Write a behavioral verifier.
6. Run an oracle or fake model that should pass.
7. Run a weak baseline that should fail at least one meaningful assertion.
8. Run at least two pilot model attempts.
9. Review common failure modes.
10. Repeat the verifier to check flakiness.
11. Freeze the manifest and fixture.
12. Record the case hash.

## WorkBench v0.1 Rules

- Use small fixture repos with public verifiers.
- The verifier must return JSON with `passed`, `score`, `summary`, and weighted `assertions`.
- Do not score from Architect review or subjective model critique.
- Use `dependency-only` for local command-based setup and verifier cases.
  Reserve `network: none` for cases that execute no commands, because the
  v0.1 local runner cannot enforce OS-level network isolation for child
  processes.
- Do not depend on a user-specific absolute path, machine state, secret, or running app.

## GameIQ and ToolReliability Rules

- Use fixed seeds, fixed boards, and deterministic validators.
- Prefer many small scenarios over one long scenario.
- Record illegal actions, schema failures, fallback moves, and forbidden actions separately.
- A perfect deterministic candidate must be able to score 100.
