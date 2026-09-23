import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { PermissionProfile } from "./contracts.js";
import { ExecutionGrantError, type ExecutionGrantAuthority } from "./execution-grants.js";
import { captureFilesystemMutation, authorizeFilesystemMutation, fencedWrite, filesystemMutationWorkspace } from "./filesystem-mutation-fence.js";

import { requireGitRunner } from "./git-command.js";
import { inspectRepository, type GitRunner } from "./git-repository.js";

const DEFAULT_MAX_UNTRACKED_BYTES = 100 * 1024 * 1024;
const RUNNER_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "AIBoard Runner",
  GIT_AUTHOR_EMAIL: "runner@aiboard.local",
  GIT_COMMITTER_NAME: "AIBoard Runner",
  GIT_COMMITTER_EMAIL: "runner@aiboard.local",
};
const DEFAULT_IGNORE_BLOCK = `
# AIBoard runner safety defaults
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
node_modules/
.next/
dist/
build/
coverage/
.cache/
`;

export interface CaptureGitBaselineOptions {
  projectPath: string;
  stateDirectory: string;
  runId: string;
  maxUntrackedFileBytes?: number;
  execute?: GitRunner;
  /** Existing run-owned authority, not a new policy or ambient bootstrap bypass. */
  filesystemAuthorization?: Readonly<{ authority: ExecutionGrantAuthority; permissionProfile: PermissionProfile }>;
}

export interface GitBaseline {
  revision: string;
  ref: string;
  repositoryRoot: string;
  initializedRepository: boolean;
}

export async function captureGitBaseline(
  options: CaptureGitBaselineOptions
): Promise<GitBaseline> {
  const execute = requireGitRunner(options.execute);
  const maxBytes =
    options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("maxUntrackedFileBytes must be a non-negative integer.");
  }

  const projectPath = resolve(options.projectPath);
  const stateDirectory = resolve(options.stateDirectory);
  const ref = baselineRef(options.runId);
  let inspection = await inspectRepository(projectPath, execute);
  let initializedRepository = false;

  if (!inspection.repository || !inspection.headRevision) {
    await addDefaultIgnoreRules(projectPath, options);
    initializedRepository = true;
  }
  if (!inspection.repository) {
    await execute({ cwd: projectPath, args: ["init", "-b", "main"] });
    inspection = await inspectRepository(projectPath, execute);
  }
  if (!inspection.repository || !inspection.root) {
    throw new Error(`Git repository initialization failed for ${projectPath}.`);
  }
  if (!(await sameCanonicalExistingDirectory(inspection.root, projectPath))) {
    throw new Error(
      `Project path must be the Git repository root (${inspection.root}).`
    );
  }

  const existing = await resolveRef(projectPath, ref, execute);
  if (existing) {
    return {
      revision: existing,
      ref,
      repositoryRoot: projectPath,
      initializedRepository: await isInitialBaseline(
        projectPath,
        existing,
        execute
      ),
    };
  }

  const indexPath = join(
    stateDirectory,
    `baseline-index-${safeName(options.runId)}-${randomUUID()}`
  );
  const indexEnvironment = { GIT_INDEX_FILE: indexPath };
  try {
    await execute({
      cwd: projectPath,
      args: inspection.headRevision
        ? ["read-tree", inspection.headRevision]
        : ["read-tree", "--empty"],
      env: indexEnvironment,
    });
    if (inspection.headRevision) {
      await execute({
        cwd: projectPath,
        args: ["add", "-u", "--", "."],
        env: indexEnvironment,
      });
    }

    const untracked = await execute({
      cwd: projectPath,
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
      env: indexEnvironment,
    });
    const accepted = await filterUntrackedFiles(
      projectPath,
      untracked.stdout.split("\0").filter(Boolean),
      maxBytes
    );
    for (let offset = 0; offset < accepted.length; offset += 100) {
      await execute({
        cwd: projectPath,
        args: ["add", "--", ...accepted.slice(offset, offset + 100)],
        env: indexEnvironment,
      });
    }

    const tree = (
      await execute({
        cwd: projectPath,
        args: ["write-tree"],
        env: indexEnvironment,
      })
    ).stdout.trim();
    const subject = initializedRepository
      ? `AIBoard initial baseline (${options.runId})`
      : `AIBoard run baseline (${options.runId})`;
    const commitArguments = ["commit-tree", tree];
    if (inspection.headRevision) {
      commitArguments.push("-p", inspection.headRevision);
    }
    commitArguments.push("-m", subject);
    const revision = (
      await execute({
        cwd: projectPath,
        args: commitArguments,
        env: RUNNER_IDENTITY,
      })
    ).stdout.trim();

    const created = await execute({
      cwd: projectPath,
      args: ["update-ref", ref, revision, ""],
      allowFailure: true,
    });
    if (created.exitCode !== 0) {
      const raced = await resolveRef(projectPath, ref, execute);
      if (!raced) {
        throw new Error(`Could not create baseline ref ${ref}: ${created.stderr}`);
      }
      return {
        revision: raced,
        ref,
        repositoryRoot: projectPath,
        initializedRepository: await isInitialBaseline(
          projectPath,
          raced,
          execute
        ),
      };
    }

    if (initializedRepository) {
      await execute({ cwd: projectPath, args: ["update-ref", "HEAD", revision] });
      await execute({ cwd: projectPath, args: ["reset", "--mixed", "--quiet", "HEAD"] });
    }
    return { revision, ref, repositoryRoot: projectPath, initializedRepository };
  } finally {
    await rm(indexPath, { force: true });
  }
}

async function addDefaultIgnoreRules(configuredProjectPath: string, options: CaptureGitBaselineOptions): Promise<void> {
  const projectPath = filesystemMutationWorkspace(configuredProjectPath);
  const ignorePath = join(projectPath, ".gitignore");
  const capture = captureFilesystemMutation(projectPath, "fs.write", [{ path: ignorePath, access: "write" }]);
  let bytes: Buffer | undefined;
  try { bytes = await readFile(ignorePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const existing = bytes?.toString("utf8") ?? "";
  if (existing.includes("# AIBoard runner safety defaults")) return;
  const authorization = options.filesystemAuthorization;
  if (!authorization) throw new ExecutionGrantError("grant_forged", "Git bootstrap filesystem mutation requires the existing run-owned authority.");
  const binding = { runId: options.runId, sessionId: "run-git:baseline", actor: { role: "runner_internal" as const, id: "git:baseline" },
    toolName: "fs.write", callId: `baseline-ignore-${randomUUID()}`, permissionProfile: authorization.permissionProfile };
  const grant = await authorization.authority.issue({ ...binding, workspacePath: projectPath,
    access: [{ path: ignorePath, mode: "write" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
  try {
    const filesystemMutation = authorizeFilesystemMutation(capture, { authority: authorization.authority, grant, binding });
    const content = existing.length === 0 ? DEFAULT_IGNORE_BLOCK.trimStart()
      : existing + (existing.endsWith("\n") ? "" : "\n") + DEFAULT_IGNORE_BLOCK;
    fencedWrite({ ...binding, workspacePath: projectPath, executionGrant: grant, filesystemMutation }, ignorePath,
      Buffer.from(content), bytes ? createHash("sha256").update(bytes).digest("hex") : undefined, false);
  } finally { await authorization.authority.revoke(grant, "completed"); }
}

async function filterUntrackedFiles(
  root: string,
  paths: string[],
  maxBytes: number
): Promise<string[]> {
  const accepted: string[] = [];
  for (const path of paths) {
    if (isDefaultExcluded(path)) continue;
    const absolute = resolve(root, path);
    const traversal = relative(root, absolute);
    if (traversal.startsWith("..") || traversal === "") continue;
    const details = await lstat(absolute);
    if (details.isFile() && details.size > maxBytes) continue;
    accepted.push(path);
  }
  return accepted;
}

function isDefaultExcluded(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = basename(normalized);
  if (["node_modules", ".next", "dist", "build", "coverage", ".cache"].some(
    (segment) => segments.includes(segment)
  )) {
    return true;
  }
  if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) {
    return true;
  }
  return [".pem", ".key", ".p12", ".pfx"].some((suffix) =>
    name.endsWith(suffix)
  );
}

async function resolveRef(
  cwd: string,
  ref: string,
  execute: GitRunner
): Promise<string | null> {
  const result = await execute({
    cwd,
    args: ["rev-parse", "--verify", ref],
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function isInitialBaseline(
  cwd: string,
  revision: string,
  execute: GitRunner
): Promise<boolean> {
  const result = await execute({
    cwd,
    args: ["show", "-s", "--format=%s", revision],
  });
  return result.stdout.trim().startsWith("AIBoard initial baseline (");
}

function baselineRef(runId: string): string {
  return `refs/aiboard/runs/${safeName(runId)}/baseline`;
}

function safeName(value: string): string {
  const readable = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}

async function sameCanonicalExistingDirectory(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    canonicalExistingDirectory(left),
    canonicalExistingDirectory(right),
  ]);
  if (a === null || b === null) return false;
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function canonicalExistingDirectory(path: string): Promise<string | null> {
  try {
    const requested = resolve(path);
    const metadata = await lstat(requested);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    return resolve(await realpath(requested));
  } catch {
    return null;
  }
}
