# CLI worker fixtures (CW0, 2026-11-17)

Real output from Codex CLI, Claude Code and agy, captured by the CW0 spike for the CW2 parsers. Each run was a
Runner-managed process (`process.start` through a ToolBroker grant, one worker owner per run) in a clone of a toy
repository. The spike report is `docs/runner-v2/cli-workers-spike-2026-11-17.md`; its §1 lists the exact prompts.

Versions: codex-cli 0.169.0, Claude Code 2.1.326, agy 1.5.10. Windows 10 (Job backend) and Linux (Debian bookworm
in Docker, portable supervisor, non-root user unless the name says root). No macOS.

## Layout

`<cli>/<case>.<os>.<part>`:

- `stdout.jsonl` / `stdout.json`: exactly what the CLI wrote to stdout. Claude Code's `--output-format json` is
  one object, so it is `.json`; its stream-json capture is `.jsonl`.
- `stderr.txt`: only when stderr was not empty.
- `last-message.json`: Codex's `-o` file. It is created even when the run fails or is killed, then 0 bytes.
- `meta.json`: the arguments (paths replaced), exit code and signal as the managed record saw them, duration, what
  the harness observed after the stop, and a note on what the case shows.

`<cli>/free/`: free checks that send no prompt (`codex login status`, `codex debug models`, `claude auth status`,
`agy models`, `agy -p=/quota --output-format json`).

## Scrubbing

- Local paths are `<home>` (the user's home) and `<root>` (the spike's temporary folder); workspaces are
  `<root>\w\<case id>`.
- Account fields are replaced: e-mail is `canary@example.test`, org and account ids are
  `00000000-0000-4000-8000-000000000000`, org name is `Canary Org`, Claude Code's `credential_expires_at` is
  `2099-01-01T00:00:00.000Z`, and the org/account segment of plugin paths is `<org>_<account>`.
- `cf-ray` and OpenAI request ids are placeholders.
- Claude Code's stream-json `init` event has its inventory arrays (tools, MCP servers, plugins, skills, agents,
  slash commands, memory paths) replaced by an entry count.
- `codex debug models`: `base_instructions`, `model_messages`, `availability_nux` and `upgrade` are `<trimmed>`;
  every field the CW2 parser reads (`slug`, `display_name`, `visibility`, `supported_reasoning_levels`,
  `default_reasoning_level`) is as captured.
- Session, thread and conversation ids are real; they identify a toy session, not an account.

## Not here

No real usage-limit output was captured for any CLI (none hit a limit during the spike). CW2 needs the owner's logs
for those rows of the plan's §3.8; the spike report says which.
