import { createHash } from "node:crypto";
import type { ArtifactStore } from "./artifact-store.js";
import { GitCommandError, type GitBinaryCommandResult, type GitCommandOptions, type GitCommandResult } from "./git-command.js";
import type { OneShotCommandExecutor, OneShotCommandRequest, OneShotCommandResult } from "./one-shot-command-executor.js";
import { parseProcessOutputDisposition, type ProcessOutputDisposition } from "./execution-safety-contracts.js";

/** A run-owned Git interface. It has no process, environment, or grant fallback. */
export interface GitCommandRunner {
  run(options: GitCommandOptions): Promise<GitCommandResult>;
  runBytes(options: GitCommandOptions): Promise<GitBinaryCommandResult>;
}

/** Supplied by the actual owning host/run. The Git family never mints a grant. */
export interface GitCommandAuthorization {
  readonly context: OneShotCommandRequest["context"];
  /** Canonical directory validated by the issuing run, never by model input. */
  readonly workingDirectory?: string;
  release(): void | Promise<void>;
}

export interface RuntimeGitCommandRunnerOptions {
  readonly runId: string;
  readonly executable: string;
  readonly timeoutMs: number;
  readonly execution: OneShotCommandExecutor;
  readonly artifacts: Pick<ArtifactStore, "stat" | "get">;
  authorize(options: Readonly<GitCommandOptions>): Promise<GitCommandAuthorization>;
  /** Private audit projection; public Git result/error shapes remain unchanged. */
  observe?(result: OneShotCommandResult): void;
}

export function createRuntimeGitCommandRunner(input: RuntimeGitCommandRunnerOptions): GitCommandRunner {
  if (!input.runId.trim() || !input.executable.trim() || input.executable.includes("\0")) throw new Error("Git runner requires an exact run and executable.");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) throw new Error("Git runtime timeout must be a positive integer.");

  const runBytes = async (requested: GitCommandOptions): Promise<GitBinaryCommandResult> => {
    // The caller must not change the command while its authority is acquired.
    const options = snapshotOptions(requested);
    const authorization = await input.authorize(options);
    let failed = false; let primary: unknown; let result: GitBinaryCommandResult | undefined;
    try {
      if (authorization.context.runId !== input.runId) throw new Error("Git command run authority does not match its owning runtime.");
      const executed = await input.execution.execute({
        executable: input.executable,
        arguments: options.args,
        workingDirectory: authorization.workingDirectory ?? options.cwd,
        ...(options.env ? { explicitEnvironment: options.env } : {}),
        timeoutMs: input.timeoutMs,
        context: authorization.context,
      });
      input.observe?.(executed);
      const process = executed.process;
      if (process.outcome === "launch_failed") throw new GitCommandError("git_unavailable", "Git executable could not be launched by the selected runtime.");
      if (process.outcome !== "exited" || process.cleanup.state !== "verified_empty" || !Number.isSafeInteger(process.exitCode)) {
        throw new GitCommandError("command_failed", `Git runtime did not finish with verified cleanup (${process.outcome}/${process.cleanup.state}).`);
      }
      const maximum = options.maxOutputBytes!;
      if (process.output.length !== 2 || process.output.filter((stream) => stream.stream === "stdout").length !== 1 ||
          process.output.filter((stream) => stream.stream === "stderr").length !== 1 ||
          process.output.some((stream) => !Number.isSafeInteger(stream.totalBytes) || stream.totalBytes < 0) ||
          process.output.reduce((total, stream) => total + stream.totalBytes, 0) > maximum) {
        throw outputError(maximum);
      }
      const stdout = await exactOutput(process.output.find((stream) => stream.stream === "stdout")!, input.artifacts, maximum);
      const stderr = await exactOutput(process.output.find((stream) => stream.stream === "stderr")!, input.artifacts, maximum);
      result = { exitCode: process.exitCode!, stdout, stderr: stderr.toString("utf8") };
      if (result.exitCode !== 0 && !options.allowFailure) {
        const text = { ...result, stdout: result.stdout.toString("utf8") };
        throw new GitCommandError("command_failed", `git ${options.args.join(" ")} failed with exit code ${result.exitCode}: ${text.stderr.trim() || text.stdout.trim() || "no output"}`, text);
      }
    } catch (error) { failed = true; primary = error; }
    try { await authorization.release(); }
    catch (error) { throw new AggregateError(failed ? [primary, error] : [error], "Git command authorization cleanup failed."); }
    if (failed) throw primary;
    return result!;
  };
  return Object.freeze({
    runBytes,
    async run(options: GitCommandOptions): Promise<GitCommandResult> {
      const result = await runBytes(options);
      return { ...result, stdout: result.stdout.toString("utf8") };
    },
  });
}

function snapshotOptions(options: GitCommandOptions): Readonly<GitCommandOptions> {
  const maximum = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("maxOutputBytes must be a positive integer.");
  if (!Array.isArray(options.args) || options.args.length === 0 || options.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Git arguments must be a nonempty argv array without NUL bytes.");
  if (typeof options.cwd !== "string" || !options.cwd.trim() || options.cwd.includes("\0")) throw new Error("Git working directory is invalid.");
  return Object.freeze({ cwd: options.cwd, args: Object.freeze([...options.args]), maxOutputBytes: maximum,
    ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
    ...(options.env ? { env: Object.freeze({ ...options.env }) } : {}),
  });
}

async function exactOutput(stream: ProcessOutputDisposition, artifacts: Pick<ArtifactStore, "stat" | "get">, maximum: number): Promise<Buffer> {
  if (stream.tailBytesBase64 !== undefined || stream.tailByteLength !== undefined) {
    let observed: ProcessOutputDisposition;
    try { observed = parseProcessOutputDisposition(stream); }
    catch { throw outputError(maximum); }
    // Diagnostic storage loss does not corrupt bytes still wholly present in
    // the separately bounded raw tail. Never use display text as binary proof.
    if (!observed.truncated && observed.tailByteLength === observed.totalBytes)
      return Buffer.from(observed.tailBytesBase64!, "base64");
  }
  if (stream.lossyBytes !== 0 || stream.spillBytes !== stream.totalBytes) throw outputError(maximum);
  if (stream.totalBytes === 0) return Buffer.alloc(0);
  if (!stream.spillArtifactId || !/^[a-f0-9]{64}$/.test(stream.spillArtifactId)) throw outputError(maximum);
  try {
    const record = await artifacts.stat(stream.spillArtifactId);
    if (record.byteLength !== stream.totalBytes || record.byteLength > maximum) throw outputError(maximum);
    const bytes = await artifacts.get(stream.spillArtifactId);
    if (bytes.length !== stream.totalBytes || createHash("sha256").update(bytes).digest("hex") !== stream.spillArtifactId) throw outputError(maximum);
    return Buffer.from(bytes);
  } catch (error) {
    if (error instanceof GitCommandError) throw error;
    throw outputError(maximum);
  }
}

function outputError(maximum: number): GitCommandError {
  return new GitCommandError("output_limit", `Git output exceeded ${maximum} bytes or its exact bounded artifact is unavailable.`);
}
