import { createExecutionGrantAuthority } from "../../src/execution-grants.js";
/** Explicit test-only finite Git fixture adapter. It is NOT the runtime under
 * test and is never imported by production. Caller/manager compatibility tests
 * use real Git against their own temporary repositories; separate native host
 * tests exercise the actual runtime/grants/containment/output path.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { GitCommandError, type GitCommandOptions, type GitCommandResult, type GitBinaryCommandResult } from "../../src/git-command.js";
import type { GitCommandRunner } from "../../src/git-runtime-runner.js";
import type { RunGitExecutionContext } from "../../src/git-run-context.js";
import type { OneShotCommandExecutor } from "../../src/one-shot-command-executor.js";
import type { PermissionProfile } from "../../src/contracts.js";

export async function runGitBytes(options: GitCommandOptions): Promise<GitBinaryCommandResult> {
  const cwd = realpathSync(resolve(options.cwd));
  const inside = relative(realpathSync(tmpdir()), cwd);
  if (!isAbsolute(options.cwd) || inside === ".." || inside.startsWith("..\\") || inside.startsWith("../") || isAbsolute(inside))
    throw new Error("Fixture Git may operate only in its explicit temporary repository.");
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Runner fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Runner fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }, options.env);
  const result = spawnSync("git", ["-c", "core.hooksPath=", "-c", "core.fsmonitor=false", "-c", "credential.helper=", ...options.args],
    { cwd, env, encoding: "buffer", maxBuffer: 128 * 1024 * 1024, windowsHide: true, shell: false });
  if (result.error || result.signal || result.status === null)
    throw new GitCommandError("git_unavailable", `Finite Git fixture did not join: ${result.error?.message ?? result.signal ?? "unknown"}`);
  const stdout = result.stdout ?? Buffer.alloc(0); const stderr = (result.stderr ?? Buffer.alloc(0)).toString("utf8");
  if (stdout.length + Buffer.byteLength(stderr) > (options.maxOutputBytes ?? 4 * 1024 * 1024))
    throw new GitCommandError("output_limit", "Fixture output exceeded the caller bound after exact child completion.");
  if (result.status !== 0 && !options.allowFailure)
    throw new GitCommandError("command_failed", `git ${options.args.join(" ")} failed: ${stderr}`, { exitCode: result.status, stdout: stdout.toString("utf8"), stderr });
  return { exitCode: result.status, stdout, stderr };
}
export async function runGit(options: GitCommandOptions): Promise<GitCommandResult> {
  const result = await runGitBytes(options); return { ...result, stdout: result.stdout.toString("utf8") };
}
export const fixtureGitRunner: GitCommandRunner = Object.freeze({ run: runGit, runBytes: runGitBytes });
export function fixtureGitContext(profile: PermissionProfile = "full", execution?: OneShotCommandExecutor): RunGitExecutionContext {
  return { permissionProfile: profile, forCall: () => fixtureGitRunner, lifecycle: () => fixtureGitRunner, current: () => fixtureGitRunner,
    withCall: (_context, operation) => operation(),
    executeForCall: async (context, request) => {
      if (!execution || !context.callId || !context.toolName) throw new Error("Fixture composite command requires its explicit executor.");
      return await execution.execute({ ...request, context: { ...context, callId: context.callId, toolName: context.toolName } });
    } };
}

import { WorkspaceManager as ActualWorkspaceManager } from "../../src/workspace-manager.js";
export class WorkspaceManager extends ActualWorkspaceManager {
  constructor(options: ConstructorParameters<typeof ActualWorkspaceManager>[0]) { super({ ...options, execute: options.execute ?? runGit }); }
}

import { IntegrationManager as ActualIntegrationManager } from "../../src/integration-manager.js";
export class IntegrationManager extends ActualIntegrationManager {
  constructor(options: ConstructorParameters<typeof ActualIntegrationManager>[0]) { super({ ...options, execute: options.execute ?? runGit, executeBytes: options.executeBytes ?? runGitBytes }); }
}

import { VerificationWorkspaceManager as ActualVerificationWorkspaceManager } from "../../src/verification-workspace.js";
export class VerificationWorkspaceManager extends ActualVerificationWorkspaceManager {
  constructor(options: ConstructorParameters<typeof ActualVerificationWorkspaceManager>[0]) { super({ ...options, execute: options.execute ?? runGit }); }
}

import { FinalVerificationDiagnosticsArchive as ActualFinalVerificationDiagnosticsArchive } from "../../src/final-verification-cleanup.js";
export class FinalVerificationDiagnosticsArchive extends ActualFinalVerificationDiagnosticsArchive {
  constructor(options: ConstructorParameters<typeof ActualFinalVerificationDiagnosticsArchive>[0]) { super({ ...options, execute: options.execute ?? runGit }); }
}

import { FinalVerificationRuntime as ActualFinalVerificationRuntime } from "../../src/final-verification-runtime.js";
export class FinalVerificationRuntime extends ActualFinalVerificationRuntime {
  constructor(options: ConstructorParameters<typeof ActualFinalVerificationRuntime>[0]) { super({ ...options, git: options.git ?? runGit }); }
}

import { NativeBuildFactory as ActualNativeBuildFactory } from "../../src/native-build-factory.js";
export class NativeBuildFactory extends ActualNativeBuildFactory {
  constructor(options: ConstructorParameters<typeof ActualNativeBuildFactory>[0]) { super({ ...options, gitForRun: options.gitForRun ?? ((spec) => fixtureGitContext(spec.permissionProfile)) }); }
}

import { NativeWorkerDriver as ActualNativeWorkerDriver } from "../../src/native-worker-driver.js";
export class NativeWorkerDriver extends ActualNativeWorkerDriver {
  constructor(options: ConstructorParameters<typeof ActualNativeWorkerDriver>[0]) { super({ ...options, git: options.git ?? fixtureGitContext(options.permissionProfile, options.execution) }); }
}

import { NativeArchitectRuntime as ActualNativeArchitectRuntime } from "../../src/native-architect-runtime.js";
export class NativeArchitectRuntime extends ActualNativeArchitectRuntime {
  constructor(options: ConstructorParameters<typeof ActualNativeArchitectRuntime>[0]) { super({ ...options, git: options.git ?? fixtureGitContext() }); }
}

import { NativeVerifierRuntime as ActualNativeVerifierRuntime } from "../../src/native-verifier-runtime.js";
export class NativeVerifierRuntime extends ActualNativeVerifierRuntime {
  constructor(options: ConstructorParameters<typeof ActualNativeVerifierRuntime>[0]) { super({ ...options, git: options.git ?? fixtureGitContext() }); }
}

import { RepositoryIntelligence as ActualRepositoryIntelligence } from "../../src/repository-intelligence.js";
export class RepositoryIntelligence extends ActualRepositoryIntelligence {
  constructor(execute: ConstructorParameters<typeof ActualRepositoryIntelligence>[0] = runGit) { super(execute); }
}
import { TypeScriptIntelligence as ActualTypeScriptIntelligence } from "../../src/typescript-intelligence.js";
export class TypeScriptIntelligence extends ActualTypeScriptIntelligence {
  constructor(repository: ConstructorParameters<typeof ActualTypeScriptIntelligence>[0] = new RepositoryIntelligence()) { super(repository); }
}
import { captureGitBaseline as actualCaptureGitBaseline } from "../../src/git-baseline.js";
export async function captureGitBaseline(options: Parameters<typeof actualCaptureGitBaseline>[0]) {
  const owned = options.filesystemAuthorization ? undefined : createExecutionGrantAuthority();
  try {
    return await actualCaptureGitBaseline({ ...options, execute: options.execute ?? runGit,
      filesystemAuthorization: options.filesystemAuthorization ?? { authority: owned!, permissionProfile: "full" } });
  } finally { await owned?.revokeAll("cleanup"); }
}
import { inspectRepository as actualInspectRepository } from "../../src/git-repository.js";
export function inspectRepository(path: string, execute: Parameters<typeof actualInspectRepository>[1] = runGit) {
  return actualInspectRepository(path, execute);
}
import { createChangeSet as actualCreateChangeSet } from "../../src/change-set.js";
export function createChangeSet(options: Parameters<typeof actualCreateChangeSet>[0]) {
  return actualCreateChangeSet({ ...options, execute: options.execute ?? runGit });
}
import { createGitTools as actualCreateGitTools } from "../../src/git-tools.js";
export function createGitTools(context: Parameters<typeof actualCreateGitTools>[0] = fixtureGitContext()) { return actualCreateGitTools(context); }
import { runWorkerTask as actualRunWorkerTask } from "../../src/worker-runtime.js";
export function runWorkerTask(options: Parameters<typeof actualRunWorkerTask>[0]) {
  return actualRunWorkerTask({ ...options, git: options.git ?? fixtureGitContext(options.permissionProfile, options.execution) });
}
import { createSubagentTools as actualCreateSubagentTools } from "../../src/subagent-tools.js";
export function createSubagentTools(options: Parameters<typeof actualCreateSubagentTools>[0]) {
  return actualCreateSubagentTools({ ...options, git: options.git ?? fixtureGitContext(options.permissionProfile, options.execution) });
}
import { inspectFinalVerificationExecutionProfile as actualInspectFinalVerificationExecutionProfile,
  FinalVerificationProfileAuthority as ActualFinalVerificationProfileAuthority } from "../../src/final-verification-profile.js";
export function inspectFinalVerificationExecutionProfile(options: Parameters<typeof actualInspectFinalVerificationExecutionProfile>[0]) {
  return actualInspectFinalVerificationExecutionProfile({ ...options, execute: options.execute ?? runGit });
}
export class FinalVerificationProfileAuthority extends ActualFinalVerificationProfileAuthority {
  override inspectAndPersist(input: Parameters<ActualFinalVerificationProfileAuthority["inspectAndPersist"]>[0]) {
    return super.inspectAndPersist({ ...input, execute: input.execute ?? runGit });
  }
}
