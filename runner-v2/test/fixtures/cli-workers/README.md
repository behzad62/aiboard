# CLI worker fixtures (CW0, 2026-11-17)

Real output from Codex CLI, Claude Code and agy, captured by the CW0 spike for the CW2 parsers. Each run was a
Runner-managed process (`process.start` through a ToolBroker grant, one worker owner per run) in a clone of a toy
repository. The spike report is `docs/runner-v2/cli-workers-spike-2026-11-17.md`.

Versions: codex-cli 0.169.0, Claude Code 2.1.326, agy 1.5.10. Windows 10 (Job backend) and Linux (Debian bookworm
in Docker, portable supervisor, non-root user unless the name says root). No macOS.

## Layout

`<cli>/<case>.<os>.<part>`:

- `stdout.jsonl` / `stdout.json`: exactly what the CLI wrote to stdout, scrubbed. Output that is one JSON object
  (Claude Code's `--output-format json`, agy's `--output-format json`) is `.json`; event streams are `.jsonl`.
- `stderr.txt`: only when stderr was not empty.
- `last-message.json`: Codex's `-o` file. It is created even when the run fails or is killed, then 0 bytes.
- `meta.json`: the arguments, the exact stdin, exit code and signal as the managed record saw them, duration, the
  output sizes (counted after scrubbing), what the harness found alive after the stop with `inAnyJob` (Windows) and a
  verdict per process, and a note on what the case shows.
  - The arguments are as the harness passed them, with paths replaced. Its Codex `-o` path joins a Windows folder and
    `/last-message.json` with a forward slash; Windows accepts the mix.
  - `aliveAfterStop` lists only processes the harness's sampler linked to the run. `aliveButMissedBySampler` lists
    survivors found another way (report §1, §6).
  - The `stream-input-missing-event` case ran in a workspace named after its harness job, `agy-success-streamjson`.

`<cli>/free/`: free checks that send no prompt, with `meta.json` giving each command, its exit code and the stream
it wrote to (`codex login status`, `codex debug models`, `claude auth status`, Claude Code stream-json logged out,
`agy models`, `agy --output-format json -p=/quota`).

`result.schema.json`: the result schema every run used (`--output-schema` / `--json-schema`). It is the strict-mode
form, not `CliWorkerResultV1` (report §9.7).

## Bytes and line endings

The files are the bytes the CLIs wrote (LF), apart from the scrub below. `.gitattributes` marks this folder `-text`
so no checkout converts them.

## Scrubbing

- Local paths are `<home>` (the user's home) and `<root>` (the spike's temporary folder); workspaces are
  `<root>\w\<case id>`. Claude Code's dash-encoded project folder names are `<home-dashed>` and `<root-dashed>`, its
  per-user temp hash and message pipe name are `<hash>`, and its `init.memory_paths` values are `<memory-path>`.
- Account fields are replaced: e-mail is `canary@example.test`, org and account ids are
  `00000000-0000-4000-8000-000000000000`, org name is `Canary Org`, Claude Code's `credential_expires_at` and
  `loginExpiresAt` are `2099-01-01T00:00:00.000Z`, and the org/account segment of plugin paths is `<org>_<account>`.
- Request and message ids are placeholders: OpenAI `req_<id>`, Anthropic `req_<id>` and `msg_<id>`, and `cf-ray`.
- Usage figures are synthetic: Claude Code's `rate_limit_event` (`utilization` 0.5, `resetsAt` 4102444800,
  `overageDisabledReason` `<reason>`) and agy's `/quota` (`remaining_fraction` 0.5, reset times 2099). The shapes are
  real.
- Timestamps with the capturing machine's UTC offset are converted to UTC (`Z`).
- Claude Code's stream-json `init` event has its inventory arrays (tools, MCP servers, plugins, skills, agents,
  slash commands, additional directories) replaced by an entry count.
- `codex debug models`: `base_instructions`, `model_messages`, `availability_nux` and `upgrade` are `<trimmed>`;
  every field the CW2 parser reads (`slug`, `display_name`, `visibility`, `supported_reasoning_levels`,
  `default_reasoning_level`) is as captured.
- Session, thread and conversation ids, tool-use ids and task ids are real; they identify a toy session, not an
  account.

## Not here

- No real usage-limit output for any CLI (none hit a limit during the spike), no 429 and no 5xx or overload message,
  and no agy logged-out output. CW2 needs the owner's logs for those rows of the plan's §3.8.
- Claude Code stream-json for a success, a needs-decision, an `is_error` result from a model call, and a killed run.
  The stream-json fixtures are the background run and the free logged-out run; the `result` event has the json
  mode's fields.
