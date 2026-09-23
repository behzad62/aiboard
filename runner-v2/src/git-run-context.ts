import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { ToolExecutionContext } from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { PermissionProfile } from "./contracts.js";
import { createExecutionCommandGrantScope, type ExecutionCommandGrantScope,
  type ExecutionGrantAuthority, type ExecutionGrantBinding, type OpaqueExecutionGrant } from "./execution-grants.js";
import type { GitCommandOptions } from "./git-command.js";
import { createRuntimeGitCommandRunner, type GitCommandAuthorization, type GitCommandRunner } from "./git-runtime-runner.js";
import type { OneShotCommandExecutor, OneShotCommandRequest, OneShotCommandResult } from "./one-shot-command-executor.js";
import { isTrustedRunnerHostAliasResolution } from "./runner-capabilities-config.js";

export type GitLifecyclePurpose = "baseline" | "workspace" | "integration" | "verification" | "inspection" | "cleanup";

/** This capability stays in the host/runtime composition, never in model args or
 * extension context. Families get only a call-scoped runner, not its authority.
 */
export interface RunGitExecutionContext {
  readonly permissionProfile: PermissionProfile;
  withCall<T>(context: ToolExecutionContext, operation: () => Promise<T>): Promise<T>;
  current(): GitCommandRunner;
  executeForCall(context: ToolExecutionContext, request: Omit<OneShotCommandRequest, "context">): Promise<OneShotCommandResult>;
  forCall(context: ToolExecutionContext): GitCommandRunner;
  lifecycle(purpose: GitLifecyclePurpose): GitCommandRunner;
}

export interface RunGitExecutionContextOptions {
  readonly runId: string;
  readonly projectRoot: string;
  readonly stateDirectory: string;
  readonly permissionProfile: PermissionProfile;
  readonly execution: OneShotCommandExecutor;
  readonly executionGrants: ExecutionGrantAuthority;
  readonly artifacts: Pick<ArtifactStore, "stat" | "get">;
  readonly executable?: string;
  readonly timeoutMs?: number;
  assertOpen(): void;
  observe?(result: OneShotCommandResult): void;
}

interface CallScope {
  readonly binding: ExecutionGrantBinding;
  readonly grant: OpaqueExecutionGrant;
  readonly signal?: AbortSignal;
  scope?: Promise<ExecutionCommandGrantScope>;
}

// Closed trusted mechanics, not a generic pre-run process purpose. Model-facing
// Git still uses its ToolBroker grant. Task9 owns additional indirect-execution
// hardening; this boundary already denies network verbs for internal mechanics.
const INSPECTION = new Set(["rev-parse", "symbolic-ref", "status", "show", "diff", "ls-files", "ls-tree", "log", "cat-file", "rev-list", "merge-base", "diff-tree", "for-each-ref"]);
const MECHANICAL = new Set([...INSPECTION, "branch", "init", "read-tree", "add", "write-tree", "commit-tree", "update-ref", "reset", "worktree", "checkout", "switch", "commit", "merge", "merge-tree", "cherry-pick", "clean", "apply", "mktree", "update-index"]);
const PURPOSES = new Set<GitLifecyclePurpose>(["baseline", "workspace", "integration", "verification", "inspection", "cleanup"]);

export function createRunGitExecutionContext(input: RunGitExecutionContextOptions): RunGitExecutionContext {
  if (!input.runId.trim()) throw new Error("Run Git authority requires a run identity.");
  const roots = gitWorkingRootsForRun(input.projectRoot, input.stateDirectory, input.runId);
  const calls = new WeakMap<object, CallScope>();
  const activeCall = new AsyncLocalStorage<ToolExecutionContext>();
  const runner = (authorize: (options: Readonly<GitCommandOptions>) => Promise<GitCommandAuthorization>) => createRuntimeGitCommandRunner({
    runId: input.runId, executable: input.executable ?? "git", timeoutMs: input.timeoutMs ?? 30_000,
    execution: input.execution, artifacts: input.artifacts, authorize,
    ...(input.observe ? { observe: input.observe } : {}),
  });
  const ownedCallFor = (context: ToolExecutionContext): CallScope => {
      input.assertOpen();
      if (context.runId !== input.runId || !context.callId?.trim() || !context.toolName?.trim() || !context.executionGrant) {
        throw new Error("Git requires the exact run/call ToolBroker grant authority.");
      }
      const binding: ExecutionGrantBinding = Object.freeze({ runId: context.runId, sessionId: context.sessionId,
        actor: Object.freeze({ ...context.actor }), callId: context.callId, toolName: context.toolName, permissionProfile: input.permissionProfile });
      let call = calls.get(context.executionGrant as object);
      if (call && !sameIdentity(call.binding, binding)) throw new Error("Git call identity cannot reuse another invocation's authority.");
      if (!call) {
        call = { binding, grant: context.executionGrant, ...(context.signal ? { signal: context.signal } : {}) };
        calls.set(context.executionGrant as object, call);
      }
      return call;
  };
  const authorizeCall = async (ownedCall: CallScope, directory: string): Promise<GitCommandAuthorization> => {
    input.assertOpen();
    const scope = await (ownedCall.scope ??= createExecutionCommandGrantScope({
      authority: input.executionGrants, parentGrant: ownedCall.grant, binding: ownedCall.binding,
      ...(ownedCall.signal ? { signal: ownedCall.signal } : {}),
    }));
    const workingDirectory = await scope.authorizeDirectory(directory);
    input.assertOpen();
    const command = scope.next();
    return Object.freeze({ workingDirectory, context: Object.freeze({ ...command.binding,
      executionGrant: command.grant, signal: command.signal }), release: command.release });
  };
  const forCall = (context: ToolExecutionContext): GitCommandRunner => {
    const ownedCall = ownedCallFor(context);
    return runner((options) => authorizeCall(ownedCall, options.cwd));
  };
  return Object.freeze({
    permissionProfile: input.permissionProfile,
    forCall,
    withCall<T>(context: ToolExecutionContext, operation: () => Promise<T>): Promise<T> {
      // Run-local async context: concurrent workers cannot overwrite a global
      // current runner. It retains the original nonserializable call grant.
      ownedCallFor(context);
      const fixed = Object.freeze({ ...context, actor: Object.freeze({ ...context.actor }) });
      return activeCall.run(fixed, operation);
    },
    current(): GitCommandRunner {
      const context = activeCall.getStore();
      if (!context) throw new Error("A current exact Git call context is required.");
      return forCall(context);
    },
    async executeForCall(context: ToolExecutionContext, request: Omit<OneShotCommandRequest, "context">): Promise<OneShotCommandResult> {
      const fixed = Object.freeze({ ...request, arguments: Object.freeze([...request.arguments]),
        ...(request.explicitEnvironment ? { explicitEnvironment: Object.freeze({ ...request.explicitEnvironment }) } : {}) });
      const authorization = await authorizeCall(ownedCallFor(context), fixed.workingDirectory);
      let failed = false; let primary: unknown; let result: OneShotCommandResult | undefined;
      try { result = await input.execution.execute({ ...fixed, workingDirectory: authorization.workingDirectory!, context: authorization.context }); }
      catch (error) { failed = true; primary = error; }
      try { await authorization.release(); }
      catch (error) { throw new AggregateError(failed ? [primary, error] : [error], "Call command authorization cleanup failed."); }
      if (failed) throw primary;
      return result!;
    },
    lifecycle(purpose: GitLifecyclePurpose): GitCommandRunner {
      if (!PURPOSES.has(purpose)) throw new Error("Git lifecycle purpose is not permitted.");
      return runner(async (options) => {
        input.assertOpen();
        if (!(purpose === "inspection" ? INSPECTION : MECHANICAL).has(options.args[0]!)) {
          throw new Error("Git command is outside this closed lifecycle purpose.");
        }
        if (purpose === "inspection" && options.args[0] === "symbolic-ref" &&
            (options.args.includes("--delete") || options.args.includes("-d") || options.args.slice(1).filter((argument) => !argument.startsWith("-")).length !== 1))
          throw new Error("Git inspection cannot mutate a symbolic ref.");
        const canonicalRoots = await Promise.all(roots.map(canonicalDeclaredRoot));
        const workingDirectory = await ownedDirectory(options.cwd, canonicalRoots);
        input.assertOpen();
        const binding: ExecutionGrantBinding = Object.freeze({ runId: input.runId,
          sessionId: `run-git:${purpose}`, actor: Object.freeze({ role: "runner_internal", id: `git:${purpose}` }),
          toolName: `runner.git.${purpose}`, callId: `git-lifecycle-${randomUUID()}`, permissionProfile: input.permissionProfile });
        const parent = await input.executionGrants.issue({ ...binding, workspacePath: canonicalRoots[0]!,
          access: canonicalRoots.map((path) => ({ path, mode: purpose === "inspection" ? "read" as const : "write" as const })),
          // These exact per-run working roots live outside the selected project.
          // No entire state directory, credential directory or foreign run is granted.
          externalApproved: true, destructiveApproved: false, networkApproved: false, credentialNames: [] });
        let scope: ExecutionCommandGrantScope | undefined;
        try {
          scope = await createExecutionCommandGrantScope({ authority: input.executionGrants, parentGrant: parent, binding });
          input.assertOpen();
          const command = scope.next(); const ownedScope = scope;
          return Object.freeze({ workingDirectory, context: Object.freeze({ ...command.binding, executionGrant: command.grant, signal: command.signal }),
            release: async () => {
              const failures: unknown[] = [];
              for (const cleanup of [command.release, () => ownedScope.close(), () => input.executionGrants.revoke(parent, "completed")]) {
                try { await cleanup(); } catch (error) { failures.push(error); }
              }
              if (failures.length) throw new AggregateError(failures, "Run-owned Git command cleanup failed.");
            } });
        } catch (primary) {
          const failures: unknown[] = [primary];
          try { await scope?.close(); } catch (error) { failures.push(error); }
          try { await input.executionGrants.revoke(parent, "cleanup"); } catch (error) { failures.push(error); }
          if (failures.length > 1) throw new AggregateError(failures, "Run-owned Git authorization failed during construction.");
          throw primary;
        }
      });
    },
  });
}

/** Matches the existing workspace managers' durable path layouts. It grants
 * each exact run root, never their shared parents. Path defaults are intentionally
 * different where the existing managers use item versus run for empty slugs.
 */
export function gitWorkingRootsForRun(projectRoot: string, stateDirectory: string, runId: string): readonly string[] {
  if (!isAbsolute(projectRoot) || !isAbsolute(stateDirectory) || !runId.trim()) throw new Error("Git working roots require absolute owned paths and a run identity.");
  const slug = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 10);
  const segment = (length: number, fallback: string) => `${slug.slice(0, length) || fallback}-${digest}`;
  return Object.freeze([resolve(projectRoot),
    join(resolve(stateDirectory), "workspaces", segment(12, "item")),
    join(resolve(stateDirectory), "integration", segment(40, "item")),
    join(resolve(stateDirectory), "verification-workspaces", segment(12, "run")),
    join(resolve(stateDirectory), "verifier-workspaces", segment(12, "run")),
    join(resolve(stateDirectory), "git-baselines", segment(40, "run")),
  ]);
}

async function ownedDirectory(path: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Git working directory must be an absolute owned directory.");
  const requested = resolve(path);
  const stat = await lstat(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Git working directory must not be a link.");
  await rejectUntrustedSymbolicPathComponents(requested);
  const directory = resolve(await realpath(requested));
  if (!roots.some((root) => contained(root, directory))) {
    throw new Error("Git working directory is outside this run's owned roots.");
  }
  return directory;
}

async function canonicalDeclaredRoot(target: string): Promise<string> {
  if (!target || !isAbsolute(target) || target.includes("\0")) {
    throw new Error("Git working roots require absolute owned paths and a run identity.");
  }
  let current = resolve(target);
  const missing: string[] = [];
  while (true) {
    try {
      await rejectUntrustedSymbolicPathComponents(current);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        const actual = resolve(await realpath(current));
        if (!isTrustedRunnerHostAliasResolution(current, actual)) {
          throw new Error("Git working roots cannot resolve through a symbolic path.");
        }
        return resolve(actual, ...missing);
      }
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("Git working roots require absolute owned paths and a run identity.");
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function rejectUntrustedSymbolicPathComponents(candidate: string): Promise<void> {
  const root = parse(candidate).root || candidate;
  let current = root;
  for (const segment of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!metadata.isSymbolicLink()) continue;
    let actual: string;
    try { actual = resolve(await realpath(current)); }
    catch { throw new Error("Git working directory must not be a link."); }
    if (!isTrustedRunnerHostAliasResolution(current, actual)) {
      throw new Error("Git working directory must not be a link.");
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function sameIdentity(a: ExecutionGrantBinding, b: ExecutionGrantBinding): boolean {
  return a.runId === b.runId && a.sessionId === b.sessionId && a.actor.id === b.actor.id && a.actor.role === b.actor.role &&
    a.callId === b.callId && a.toolName === b.toolName && a.permissionProfile === b.permissionProfile;
}
