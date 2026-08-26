import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import { runGit, type GitCommandOptions } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";
import { parseWorktreeAssociations } from "./worktree-state.js";

const VERIFICATION_WORKSPACE_VERSION = 1 as const;
const VERIFICATION_WORKSPACE_KIND = "final-verification" as const;

export interface VerificationWorkspaceManagerOptions {
  repositoryRoot: string;
  stateDirectory: string;
  runId: string;
  /** The exact IntegrationManager.revision to verify. */
  targetRevision?: string;
  /** Compatibility alias for callers that pass the integration revision directly. */
  integrationRevision?: string;
  /** Prefer reading the revision at create/reopen time when an IntegrationManager is available. */
  integrationManager?: { readonly revision: string };
  execute?: GitRunner;
}

export interface VerificationWorkspace {
  runId: string;
  workspaceId: string;
  path: string;
  metadataPath: string;
  repositoryRoot: string;
  targetRevision: string;
  canonicalRevision: string;
}

export interface VerificationWorkspaceMetadata
  extends Omit<VerificationWorkspace, "metadataPath"> {
  version: typeof VERIFICATION_WORKSPACE_VERSION;
  kind: typeof VERIFICATION_WORKSPACE_KIND;
}

interface CanonicalState {
  revision: string;
  status: string;
}

/**
 * Owns one disposable, detached worktree for final verification.
 *
 * This manager deliberately has no build/runtime/completion authority. It only
 * establishes and validates the filesystem and Git boundary in which later
 * verification commands may run.
 */
export class VerificationWorkspaceManager {
  private readonly repositoryRoot: string;
  private readonly stateDirectory: string;
  private readonly workspaceRoot: string;
  private readonly runId: string;
  private readonly workspaceId: string;
  private readonly workspacePath: string;
  private readonly metadataFilePath: string;
  private readonly targetRevision?: string;
  private readonly integrationRevision?: string;
  private readonly integrationManager?: { readonly revision: string };
  private readonly execute: GitRunner;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: VerificationWorkspaceManagerOptions) {
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.stateDirectory = resolve(options.stateDirectory);
    this.workspaceRoot = resolve(this.stateDirectory, "verification-workspaces");
    this.runId = options.runId;
    this.workspaceId = safeName(options.runId);
    this.workspacePath = resolve(this.workspaceRoot, this.workspaceId);
    this.metadataFilePath = resolve(
      this.workspaceRoot,
      `${this.workspaceId}.metadata.json`
    );
    this.targetRevision = options.targetRevision;
    this.integrationRevision = options.integrationRevision;
    this.integrationManager = options.integrationManager;
    this.execute = options.execute ?? runGit;
  }

  get path(): string {
    return this.workspacePath;
  }

  get metadataPath(): string {
    return this.metadataFilePath;
  }

  /** Create or deterministically recover this run's owned workspace. */
  async create(targetRevision?: string): Promise<VerificationWorkspace> {
    return await this.serialized(async () => {
      const revision = this.resolveTargetRevision(targetRevision);
      await this.assertStateContainment();

      const workspaceExists = await pathExists(this.workspacePath);
      const metadataExists = await pathExists(this.metadataFilePath);
      if (workspaceExists || metadataExists) {
        if (!workspaceExists || !metadataExists) {
          throw new Error(
            "Verification workspace and ownership metadata must exist together."
          );
        }
        const metadata = await this.readMetadata();
        if (metadata.targetRevision !== revision) {
          throw new Error(
            "Verification workspace target revision does not match the requested integration revision."
          );
        }
        await this.assertOwnedWorkspace(metadata, {
          requireCleanWorkspace: true,
          requireCanonicalState: true,
        });
        return toWorkspace(metadata, this.metadataFilePath);
      }

      const canonicalBefore = await this.readCanonicalState();
      this.assertCanonicalClean(canonicalBefore);
      await this.assertRevisionExists(revision);
      await mkdir(this.workspaceRoot, { recursive: true });
      await this.assertStateContainment();

      const descriptor: VerificationWorkspaceMetadata = {
        version: VERIFICATION_WORKSPACE_VERSION,
        kind: VERIFICATION_WORKSPACE_KIND,
        runId: this.runId,
        workspaceId: this.workspaceId,
        path: this.workspacePath,
        repositoryRoot: this.repositoryRoot,
        targetRevision: revision,
        canonicalRevision: canonicalBefore.revision,
      };

      try {
        await this.git(this.repositoryRoot, [
          "worktree",
          "add",
          "--detach",
          this.workspacePath,
          revision,
        ]);
        await this.assertCanonicalStateUnchanged(canonicalBefore);
        await this.assertOwnedWorkspace(descriptor, {
          requireCleanWorkspace: true,
          requireCanonicalState: true,
        });
        await this.writeMetadata(descriptor);
        await this.assertMetadataMatches(descriptor);
        return toWorkspace(descriptor, this.metadataFilePath);
      } catch (error) {
        await this.removeOwnedWorktreeAfterCreateFailure().catch(() => undefined);
        await rm(this.metadataFilePath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  /** Reopen an existing valid workspace without creating another worktree. */
  async reopen(): Promise<VerificationWorkspace> {
    return await this.serialized(async () => {
      const revision = this.resolveTargetRevision();
      await this.assertStateContainment();
      if (!(await pathExists(this.workspacePath))) {
        throw new Error("Verification workspace has not been created.");
      }
      if (!(await pathExists(this.metadataFilePath))) {
        throw new Error("Verification workspace ownership metadata is missing.");
      }
      const metadata = await this.readMetadata();
      if (metadata.targetRevision !== revision) {
        throw new Error(
          "Verification workspace target revision does not match the requested integration revision."
        );
      }
      await this.assertOwnedWorkspace(metadata, {
        requireCleanWorkspace: true,
        requireCanonicalState: true,
      });
      return toWorkspace(metadata, this.metadataFilePath);
    });
  }

  /** Validate and expose the exact owned workspace without requiring it to be clean. */
  async inspectOwned(): Promise<VerificationWorkspace> {
    return await this.serialized(async () => {
      await this.assertStateContainment();
      const metadata = await this.readMetadata();
      await this.assertOwnedWorkspace(metadata, {
        requireCleanWorkspace: false,
        requireCanonicalState: false,
      });
      return toWorkspace(metadata, this.metadataFilePath);
    });
  }

  /** Remove only this manager's owned worktree and metadata. */
  async cleanup(): Promise<void> {
    await this.serialized(async () => {
      const workspaceExists = await pathExists(this.workspacePath);
      const metadataExists = await pathExists(this.metadataFilePath);
      if (!workspaceExists && !metadataExists) return;
      if (!workspaceExists || !metadataExists) {
        throw new Error(
          "Verification workspace and ownership metadata must exist together."
        );
      }

      await this.assertStateContainment();
      const metadata = await this.readMetadata();
      await this.assertOwnedWorkspace(metadata, {
        requireCleanWorkspace: false,
        requireCanonicalState: false,
      });
      await this.git(this.repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        this.workspacePath,
      ]);
      if (await pathExists(this.workspacePath)) {
        throw new Error("Verification workspace was not removed.");
      }
      await rm(this.metadataFilePath, { force: true });
      await this.git(this.repositoryRoot, [
        "worktree",
        "prune",
        "--expire",
        "now",
      ]);
    });
  }

  private resolveTargetRevision(override?: string): string {
    const candidates = [
      override,
      this.targetRevision,
      this.integrationRevision,
      this.integrationManager?.revision,
    ].filter((value): value is string => value !== undefined);
    if (candidates.length === 0) {
      throw new Error(
        "Verification workspace requires the exact IntegrationManager revision."
      );
    }
    const [revision] = candidates;
    if (candidates.some((candidate) => candidate !== revision)) {
      throw new Error(
        "Verification workspace revision sources disagree; refusing to choose a target."
      );
    }
    if (!isRevision(revision)) {
      throw new Error("Verification workspace target revision is invalid.");
    }
    return revision;
  }

  private async assertStateContainment(): Promise<void> {
    for (const [label, path] of [
      ["Runner state directory", this.stateDirectory],
      ["Verification workspace root", this.workspaceRoot],
    ] as const) {
      if (!(await pathExists(path))) continue;
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link.`);
      }
    }
    const canonicalRepository = await canonicalPath(this.repositoryRoot);
    const canonicalState = await canonicalPath(this.stateDirectory);
    const canonicalWorkspaceRoot = await canonicalPath(this.workspaceRoot);
    if (sameOrWithin(canonicalRepository, canonicalState)) {
      throw new Error(
        "Runner state directory must be outside the project checkout."
      );
    }
    if (!sameOrWithin(canonicalState, canonicalWorkspaceRoot)) {
      throw new Error("Verification workspace escaped the runner state directory.");
    }
    if (sameOrWithin(canonicalRepository, canonicalWorkspaceRoot)) {
      throw new Error(
        "Verification workspace root must be outside the project checkout."
      );
    }
    const workspaceParent = await canonicalPath(dirname(this.workspacePath));
    if (!sameOrWithin(canonicalWorkspaceRoot, workspaceParent)) {
      throw new Error("Verification workspace path escaped its owned root.");
    }
    if (await pathExists(this.workspacePath)) {
      const stats = await lstat(this.workspacePath);
      if (stats.isSymbolicLink()) {
        throw new Error("Verification workspace path is a symbolic link.");
      }
      const canonicalWorkspace = await canonicalPath(this.workspacePath);
      if (!samePath(canonicalWorkspace, this.workspacePath)) {
        throw new Error("Verification workspace path escapes its owned root.");
      }
    }
    if (await pathExists(this.metadataFilePath)) {
      const metadataStats = await lstat(this.metadataFilePath);
      if (metadataStats.isSymbolicLink() || !metadataStats.isFile()) {
        throw new Error("Verification workspace ownership metadata is unsafe.");
      }
      const canonicalMetadata = await canonicalPath(this.metadataFilePath);
      if (!sameOrWithin(canonicalWorkspaceRoot, canonicalMetadata)) {
        throw new Error("Verification workspace metadata escaped its owned root.");
      }
    }
  }

  private async assertRevisionExists(revision: string): Promise<void> {
    const resolvedRevision = (
      await this.git(this.repositoryRoot, [
        "rev-parse",
        "--verify",
        `${revision}^{commit}`,
      ])
    ).stdout.trim();
    if (resolvedRevision !== revision) {
      throw new Error("Verification workspace target revision is not an exact commit.");
    }
  }

  private async readCanonicalState(): Promise<CanonicalState> {
    const [head, status] = await Promise.all([
      this.git(this.repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
      this.git(this.repositoryRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ]);
    return { revision: head.stdout.trim(), status: status.stdout };
  }

  private assertCanonicalClean(state: CanonicalState): void {
    if (state.status.length !== 0) {
      throw new Error("Canonical checkout is dirty; verification cannot start.");
    }
  }

  private async assertCanonicalStateUnchanged(
    before: CanonicalState
  ): Promise<void> {
    const after = await this.readCanonicalState();
    if (after.revision !== before.revision || after.status !== before.status) {
      throw new Error("Canonical checkout changed while creating verification workspace.");
    }
  }

  private async readMetadata(): Promise<VerificationWorkspaceMetadata> {
    const raw = await readFile(this.metadataFilePath, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Verification workspace ownership metadata is malformed.");
    }
    if (!isMetadata(value)) {
      throw new Error("Verification workspace ownership metadata is invalid.");
    }
    await this.assertMetadataMatches(value);
    return value;
  }

  private async assertMetadataMatches(
    metadata: VerificationWorkspaceMetadata
  ): Promise<void> {
    if (
      metadata.runId !== this.runId ||
      metadata.workspaceId !== this.workspaceId ||
      !samePath(metadata.path, this.workspacePath) ||
      !samePath(metadata.repositoryRoot, this.repositoryRoot)
    ) {
      throw new Error("Verification workspace ownership metadata does not match this run.");
    }
  }

  private async assertOwnedWorkspace(
    metadata: VerificationWorkspaceMetadata,
    options: { requireCleanWorkspace: boolean; requireCanonicalState: boolean }
  ): Promise<void> {
    await this.assertMetadataMatches(metadata);
    const stats = await lstat(this.workspacePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Verification workspace ownership path is unsafe.");
    }
    const canonicalWorkspace = await canonicalPath(this.workspacePath);
    if (!samePath(canonicalWorkspace, this.workspacePath)) {
      throw new Error("Verification workspace path escapes its owned root.");
    }
    const associations = parseWorktreeAssociations(
      (
        await this.git(this.repositoryRoot, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ])
      ).stdout
    );
    const matchingAssociations = associations.filter((association) =>
      samePath(association.path, this.workspacePath)
    );
    if (matchingAssociations.length !== 1) {
      throw new Error("Verification workspace has unexpected Git ownership metadata.");
    }
    const root = await this.git(this.workspacePath, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (!samePath(root.stdout.trim(), this.workspacePath)) {
      throw new Error("Verification workspace is not the runner-owned worktree.");
    }
    const head = await this.git(this.workspacePath, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    if (head.stdout.trim() !== metadata.targetRevision) {
      throw new Error(
        "Verification workspace target revision does not match its ownership record."
      );
    }
    if (options.requireCleanWorkspace) {
      const status = await this.git(this.workspacePath, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (status.stdout.length !== 0) {
        throw new Error("Verification workspace is dirty.");
      }
    }
    if (options.requireCanonicalState) {
      const canonical = await this.readCanonicalState();
      if (canonical.revision !== metadata.canonicalRevision) {
        throw new Error("Canonical checkout revision changed after verification workspace creation.");
      }
      this.assertCanonicalClean(canonical);
    }
  }

  private async writeMetadata(
    metadata: VerificationWorkspaceMetadata
  ): Promise<void> {
    const temporaryPath = `${this.metadataFilePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );
    try {
      await rename(temporaryPath, this.metadataFilePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async removeOwnedWorktreeAfterCreateFailure(): Promise<void> {
    if (!(await pathExists(this.workspacePath))) return;
    const stats = await lstat(this.workspacePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
    const associations = parseWorktreeAssociations(
      (
        await this.git(this.repositoryRoot, [
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ])
      ).stdout
    );
    if (
      associations.filter((association) =>
        samePath(association.path, this.workspacePath)
      ).length === 1
    ) {
      await this.git(this.repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        this.workspacePath,
      ]);
    }
  }

  private async git(
    cwd: string,
    args: readonly string[],
    allowFailure = false
  ) {
    const options: GitCommandOptions = { cwd, args, allowFailure };
    return await this.execute(options);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function toWorkspace(
  metadata: VerificationWorkspaceMetadata,
  metadataPath: string
): VerificationWorkspace {
  return {
    runId: metadata.runId,
    workspaceId: metadata.workspaceId,
    path: metadata.path,
    metadataPath,
    repositoryRoot: metadata.repositoryRoot,
    targetRevision: metadata.targetRevision,
    canonicalRevision: metadata.canonicalRevision,
  };
}

function isMetadata(value: unknown): value is VerificationWorkspaceMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 8 &&
    candidate.version === VERIFICATION_WORKSPACE_VERSION &&
    candidate.kind === VERIFICATION_WORKSPACE_KIND &&
    typeof candidate.runId === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.repositoryRoot === "string" &&
    isRevision(candidate.targetRevision) &&
    isRevision(candidate.canonicalRevision)
  );
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(path: string): Promise<string> {
  const unresolved: string[] = [];
  let cursor = resolve(path);
  while (!(await pathExists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    unresolved.unshift(basename(cursor));
    cursor = parent;
  }
  let canonical = await realpath(cursor).catch(() => resolve(cursor));
  for (const segment of unresolved) canonical = resolve(canonical, segment);
  return resolve(canonical);
}

function sameOrWithin(root: string, candidate: string): boolean {
  return samePath(root, candidate) || isWithin(root, candidate);
}

function isWithin(root: string, candidate: string): boolean {
  const traversal = relative(resolve(root), resolve(candidate));
  return traversal !== "" && !traversal.startsWith("..") && !isAbsoluteTraversal(traversal);
}

function isAbsoluteTraversal(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\");
}

function samePath(left: string, right: string): boolean {
  const leftResolved = resolve(left);
  const rightResolved = resolve(right);
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function safeName(value: string): string {
  const readable =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 12) || "run";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}
