# AI Board Bench Failure Taxonomy

Certified mode separates model failures from invalid runs. Invalid runs do not count against a model or team because the benchmark did not receive a fair, scored attempt.

## Groups

- `model`: the model failed the task, budget, or verifier.
- `tool`: the model emitted invalid, unsafe, denied, duplicate, malformed, or unapplyable tool actions.
- `harness`: AI Board or the benchmark harness mishandled a valid model output or scoring path.
- `environment`: the runner, Docker image, dependency environment, or host setup failed.
- `case`: the case manifest, fixture, setup command, or verifier configuration is broken.
- `provider`: the hosted or local model provider failed before usable output.
- `user`: the user cancelled the run.

## Required Mappings

| Code | Group | Certified status | Counts against model |
| --- | --- | --- | --- |
| `malformed_tool_call` | `tool` | `failed_tool_use` | yes |
| `patch_failed` | `tool` | `failed_tool_use` | yes |
| `verification_failed` | `model` | `failed_verifier` | yes |
| `runner_crash` | `environment` | `invalid_environment` | no |
| `parser_bug` | `harness` | `invalid_harness` | no |
| `provider_429_before_output` | `provider` | `provider_unavailable` | no |
| `aborted_user` | `user` | `aborted_user` | no |

## Invalid-Run Rules

- Verifier failed because final code is wrong: `failed_verifier`.
- Model emitted invalid tool calls: `failed_tool_use`.
- AI Board discarded valid model output: `invalid_harness`.
- Case setup command is broken: `invalid_case`.
- Docker image or runner environment is missing: `invalid_environment`.
- Provider is unavailable before output: `provider_unavailable`.
- User cancels the run: `aborted_user`.

When source metadata conflicts with a generic code, source metadata wins. For example, `verification_failed` from a parser or harness source is `invalid_harness`, while normal verifier rejection is `failed_verifier`.
