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
  `<root>\w\<case id>`. Claude Code's `init.memory_paths` values (which held its dash-encoded project folder) are
  `<memory-path>`, and its per-user temp hash and message pipe name are `<hash>` and `cc-msg-<hash>`.
- Account fields are replaced: e-mail is `canary@example.test`, org and account ids are
  `00000000-0000-4000-8000-000000000000`, org name is `Canary Org`, Claude Code's `credential_expires_at` and
  `loginExpiresAt` are `2099-01-01T00:00:00.000Z`.
- Request and message ids are placeholders: OpenAI `req_<id>`, Anthropic `req_<id>` and `msg_<id>`, and `cf-ray`.
- Usage figures are synthetic: Claude Code's `rate_limit_event` (`utilization` 0.8 for the windows at
  `allowed_warning` past their 0.75 threshold and 0.2 for the `allowed` five-hour window, `resetsAt` 4102444800,
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

## Synthetic fixtures (CW2, 2026-11-17)

**Files with `.synthetic.` in their name were written by hand, not captured.** No CLI produced them. CW2 wrote
them to pin the rows of the plan's §3.8 that no real output covers: a usage limit, a 429, a 5xx or overload, and agy
logged out. Each has a `meta.json` with `"synthetic": true` and `modelledOn`, which names the recorded fixture or
the owner's log its shape comes from and says which words are invented. The free-check ones are described in
`agy/free/synthetic.meta.json`.

| File | Modelled on | Invented |
|---|---|---|
| `codex-cli/usage-limit.synthetic.*` | the owner's logs ("You've hit your usage limit", exit 1); the event shape of `model-unavailable.windows`; the 0-byte `-o` file of every failed CW0 run | the event layout around the logged prose |
| `codex-cli/usage-limit-stated-reset.synthetic.*` | the above | the appended "try again in 3 hours 12 minutes" |
| `codex-cli/rate-limit.synthetic.*`, `codex-cli/server-error.synthetic.*` | `logged-out.linux` (reconnect notices, then `turn.failed`) | 429 and 503 in place of 401 |
| `claude-code/usage-limit.synthetic.*` | `free/logged-out-streamjson.linux` (init, an assistant event with `error`, an `is_error` result) and the `rate_limit_event` of `background-streamjson.windows` | `status: "rejected"`, the message text |
| `claude-code/usage-limit-result-only.synthetic.*` | `logged-out.linux` (json mode) | the older "usage limit reached\|<unix seconds>" text |
| `claude-code/rate-limit.synthetic.*`, `claude-code/overloaded.synthetic.*` | `model-unavailable.windows` (`api_error_status`, `api_error_type`) | 429 `rate_limit_error`, 529 `overloaded_error` |
| `agy/usage-limit.synthetic.*`, `agy/usage-limit-weekly.synthetic.*` | the owner's logs (exit 3, "Resets in 4h53m36s", a weekly cap of 162h13m35s, `retryable: true`); the stream shape of `model-unavailable.windows` | the sentence before "Resets in" |
| `agy/rate-limit.synthetic.*`, `agy/server-error.synthetic.*` | as agy's usage limit | the 429 and 503 messages |
| `agy/logged-out.synthetic.*`, `agy/free/models-logged-out.synthetic.stderr.txt` | `model-unavailable.windows` (refused before any model call) | the login wording: agy was only seen logged in |
| `agy/free/quota-exhausted.synthetic.json` | `free/quota.json` | one bucket at `remaining_fraction` 0 |

The synthetic ids are recognisable: `00000000-0000-…-0000000c0de1` (Codex), `…0000000c1a0d` (Claude Code),
`…00000000a6e1` (agy).

## Not here

- No real usage-limit output for any CLI (none hit a limit during the spike), no 429 and no 5xx or overload message,
  and no agy logged-out output. The synthetic fixtures above stand in for them until real output is captured; a
  captured one should replace its synthetic twin.
- Claude Code stream-json for a success, a needs-decision, an `is_error` result from a model call, and a killed run.
  The stream-json fixtures are the background run and the free logged-out run; the `result` event has the json
  mode's fields.

## Fake CLIs

`runner-v2/test/support/fake-cli.mjs` replays these fixtures as Codex CLI, Claude Code or agy: it reads its argv and
stdin like the real CLI, writes Codex's `-o` file, and refuses an agy stream message without `event` as agy does.
`runner-v2/test/support/fake-cli.ts` describes its scenario file.
