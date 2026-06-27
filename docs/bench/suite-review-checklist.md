# AI Board Bench Suite Review Checklist

A case is not official until each item is checked and recorded.

## Case Quality

- Capability target is explicit.
- Prompt is original and includes a canary.
- Manifest has stable `id`, `caseVersion`, timeout, budget, and network policy.
- Reference solution passes.
- A simple wrong solution fails.
- Oracle or fake model passes.
- Weak baseline fails at least one meaningful assertion.
- Verifier is behavioral, not a snapshot of one implementation.
- Score is stable across repeated verifier runs.
- No hidden dependency on local machine state, absolute paths, secrets, or user-specific config.

## Harness Quality

- Harness certification passes for the selected profile.
- Fake model override works.
- Bad JSON model fails as `failed_tool_use`.
- Forbidden command model fails as `failed_tool_use`.
- Harness parser bug simulation classifies as `invalid_harness`.
- Verifier or setup crash classifies as `invalid_case` or `invalid_environment` as appropriate.

## Evidence Bundle

- v2 report contains cases, attempts, verifier results, team compositions, harness certifications, artifacts, traces, and failures.
- Artifact redaction ran and produced a redaction summary.
- Patch, verifier log, and result JSON artifacts are present for WorkBench attempts.
- Bundle hash is recorded after redaction.

## Publication

- Case version is frozen.
- Harness version, prompt set version, and scoring version are recorded.
- Invalid-run counts are reported separately from model failure rates.
- Known limitations and excluded cases are documented.
