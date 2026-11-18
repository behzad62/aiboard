/**
 * CW5 test support: the fake CLI (fake-cli.mjs) run as an ordinary child process behind the CLI worker loop's launcher
 * seam, and Claude Code stream-json output to replay. No real CLI is started and no prompt is sent.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

import type { CliProcessHandle, CliProcessLauncher, CliWorkerOwner } from "../../src/cli-worker-runtime.js";
import { prepareGitExecutionPolicy } from "../../src/git-execution-policy.js";
import { FAKE_CLI_SCENARIO_ENV } from "./fake-cli.js";
import { runGitAsync } from "./git-fixture.js";

/**
 * The fixture's Git behind the Runner Git policy and the internal mechanics' verb set (git-run-context.ts MECHANICAL
 * has no network verbs). Production runs the workspace manager's Git through that policy; the fixture's plain runGit
 * would hide a refused verb.
 */
export const policyGit: typeof runGitAsync = async (options) => {
  prepareGitExecutionPolicy(options);
  const verb = options.args.find((arg) => !arg.startsWith("-"));
  if (!verb || verb === "remote" || verb === "push") throw new Error(`Git ${verb ?? "(none)"} is not an internal mechanic.`);
  return await runGitAsync(options);
};

export const FAKE_CLAUDE_SESSION = "6e9ecd7e-f045-475e-b718-988bfac19da6";

/** Runs the fake as a child; its stop kills the child and can be made to fail as an unproven managed cleanup does. */
export class ChildCliLauncher implements CliProcessLauncher {
  readonly starts: Array<{ executable: string; args: readonly string[]; cwd: string; owner: CliWorkerOwner }> = [];
  readonly children: ChildProcess[] = [];
  stops = 0;
  /** Each failing stop throws once with the managed cleanup's code. */
  stopFailures = 0;
  startError: unknown;

  constructor(private readonly scenarioPath: string) {}

  async start(input: { owner: CliWorkerOwner; executable: string; args: readonly string[]; cwd: string }): Promise<CliProcessHandle> {
    this.starts.push(input);
    if (this.startError !== undefined) throw this.startError;
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd, env: { ...process.env, [FAKE_CLI_SCENARIO_ENV]: this.scenarioPath }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.children.push(child);
    let stdout = "", stderr = "", closed = false, exitCode: number | null = null;
    let wake: (() => void) | undefined;
    const poke = () => { const resolve = wake; wake = undefined; resolve?.(); };
    child.stdout!.setEncoding("utf8").on("data", (text: string) => { stdout += text; poke(); });
    child.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; poke(); });
    child.stdin!.on("error", () => undefined);
    child.on("error", () => { closed = true; poke(); });
    child.on("close", (code) => { closed = true; exitCode = code; poke(); });
    return {
      processId: `proc_${this.starts.length}`,
      async write(text: string, closeInput: boolean) {
        await new Promise<void>((resolve) => child.stdin!.write(text, () => resolve()));
        if (closeInput) child.stdin!.end();
      },
      async read(waitMs: number) {
        if (!stdout && !stderr && !closed) {
          await new Promise<void>((resolve) => { wake = resolve; setTimeout(poke, waitMs); });
        }
        const page = { stdout, stderr, gap: false, exited: closed, exitCode: closed ? exitCode : null };
        stdout = ""; stderr = "";
        return page;
      },
    };
  }

  async stopOwner(): Promise<void> {
    this.stops += 1;
    for (const child of this.children) if (child.exitCode === null && child.signalCode === null) child.kill();
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      throw Object.assign(new Error("Shared managed cleanup did not prove release."), { code: "process_cleanup_unverified" });
    }
  }
}

/** A `done` result as the CLI worker schema describes it. */
export function cliDoneResult(summary = "Changed value.txt to two."): Record<string, unknown> {
  return {
    outcome: "done", summary, question: null, replanReason: null,
    checks: [{ label: "node --test", executable: "node", args: ["--test"] }], notRun: [], concerns: [],
  };
}

/**
 * Writes Claude Code stream-json to `path`: an init event, an optional assistant line, and the result event that ends
 * the turn (§3.5). `structured: null` with `working` writes the init event only: a turn that never ends.
 */
export function writeClaudeStream(
  path: string,
  structured: Record<string, unknown> | null,
  options: { isError?: boolean; result?: string; assistantText?: string; working?: boolean } = {},
): string {
  const init = { type: "system", subtype: "init", session_id: FAKE_CLAUDE_SESSION, model: "claude-sonnet-test" };
  const lines: unknown[] = options.working ? [init] : [
    init,
    ...(options.assistantText ? [{ type: "assistant", message: { content: [{ type: "text", text: options.assistantText }] }, session_id: FAKE_CLAUDE_SESSION }] : []),
    {
      type: "result", subtype: options.isError ? "error_during_execution" : "success", is_error: options.isError === true, session_id: FAKE_CLAUDE_SESSION,
      ...(structured ? { structured_output: structured } : {}), result: options.result ?? "",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, modelUsage: { "claude-sonnet-5-5": {} },
    },
  ];
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}
