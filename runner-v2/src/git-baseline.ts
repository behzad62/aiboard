import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { runGit } from "./git-command.js";
import { inspectRepository, type GitRunner } from "./git-repository.js";

const DEFAULT_MAX_UNTRACKED_BYTES = 100 * 1024 * 1024;
const RUNNER_IDENTITY: NodeJS.ProcessEnv = {
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
  const execute = options.execute ?? runGit;
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

  if (!inspection.repository) {
    await addDefaultIgnoreRules(projectPath);
    await execute({ cwd: projectPath, args: ["init", "-b", "main"] });
    initializedRepository = true;
    inspection = await inspectRepository(projectPath, execute);
  }
  if (!inspection.repository || !inspection.root) {
    throw new Error(`Git repository initialization failed for ${projectPath}.`);
  }
  if (inspection.root !== projectPath) {
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

async function addDefaultIgnoreRules(projectPath: string): Promise<void> {
  const ignorePath = join(projectPath, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(ignorePath, "utf8");
  } catch {
    // A missing ignore file is expected for most non-repositories.
  }
  if (existing.includes("# AIBoard runner safety defaults")) return;
  if (existing.length === 0) {
    await writeFile(ignorePath, DEFAULT_IGNORE_BLOCK.trimStart(), "utf8");
  } else {
    await appendFile(
      ignorePath,
      `${existing.endsWith("\n") ? "" : "\n"}${DEFAULT_IGNORE_BLOCK}`,
      "utf8"
    );
  }
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
