/**
 * The bash side of a shell session (shell-session.ts): one bash that runs each command in itself, so variables,
 * functions, exported values and the working directory carry over.
 *
 * Launch: bash -c 'eval "$AIBOARD_SESSION_HOST"' with this script in AIBOARD_SESSION_HOST, the per-session nonce in
 * AIBOARD_SESSION_NONCE and the first command's frame in AIBOARD_SESSION_FIRST; all three are removed from the
 * environment before any command runs. Every later command arrives as one stdin line.
 *
 * A frame is four space-separated fields: the id, then base64 of the script, of the working directory and of the
 * environment ("-" when absent). The environment is NAME:base64(value) pairs joined by commas. Bash has no JSON parser,
 * hence fields instead of the PowerShell host's JSON.
 *
 * Each command writes <<aiboard:NONCE:ID:start>> on both streams, runs with stdin from /dev/null (so a program that
 * reads stdin cannot swallow the next frame), and ends with a newline and <<aiboard:NONCE:ID:end>> on both streams,
 * followed on stdout by {"exitCode","timedOut","cwd"}. The command runs in this shell itself: exit, or a failure under
 * set -e, ends the session, as it would end a terminal. Bash cannot stop one foreground command and keep the shell, so
 * a command past its limit ends the session from outside (shell-session.ts).
 */
export const BASH_SESSION_HOST_COMMAND = 'eval "$AIBOARD_SESSION_HOST"';

export const BASH_SESSION_HOST_SCRIPT = [
  '__aiboard_nonce="$AIBOARD_SESSION_NONCE"',
  '__aiboard_next="$AIBOARD_SESSION_FIRST"',
  "unset AIBOARD_SESSION_NONCE AIBOARD_SESSION_FIRST AIBOARD_SESSION_HOST",
  '__aiboard_decode() { printf "%s" "$1" | base64 -d; }',
  "while :; do",
  '  if [ -n "$__aiboard_next" ]; then __aiboard_frame="$__aiboard_next"; __aiboard_next=""',
  '  else IFS= read -r __aiboard_frame || exit 0; fi',
  '  IFS=" " read -r __aiboard_id __aiboard_s __aiboard_c __aiboard_e <<< "$__aiboard_frame"',
  '  if [ "$__aiboard_e" != "-" ]; then',
  '    for __aiboard_pair in ${__aiboard_e//,/ }; do export "${__aiboard_pair%%:*}=$(__aiboard_decode "${__aiboard_pair#*:}")"; done',
  "  fi",
  '  printf "<<aiboard:%s:%s:start>>\\n" "$__aiboard_nonce" "$__aiboard_id"',
  '  printf "<<aiboard:%s:%s:start>>\\n" "$__aiboard_nonce" "$__aiboard_id" >&2',
  '  if [ "$__aiboard_c" != "-" ] && ! cd "$(__aiboard_decode "$__aiboard_c")"; then (exit 1)',
  '  else eval "$(__aiboard_decode "$__aiboard_s")" </dev/null; fi',
  "  __aiboard_code=$?",
  '  __aiboard_here="$(pwd -W 2>/dev/null || pwd)"',
  '  __aiboard_here="${__aiboard_here//\\\\/\\\\\\\\}"; __aiboard_here="${__aiboard_here//\\"/\\\\\\"}"',
  '  printf "\\n<<aiboard:%s:%s:end>>\\n" "$__aiboard_nonce" "$__aiboard_id" >&2',
  '  printf "\\n<<aiboard:%s:%s:end>>{\\"exitCode\\":%d,\\"timedOut\\":false,\\"cwd\\":\\"%s\\"}\\n" "$__aiboard_nonce" "$__aiboard_id" "$__aiboard_code" "$__aiboard_here"',
  "done",
].join("\n");
