import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import type { GitRunner } from "./git-repository.js";
import { PLAYWRIGHT_CLI_OWNER_VARIABLES } from "./playwright-cli.js";

export type WorkingTreeIdentity =
  | { readonly status: "known"; readonly treeId: string }
  | { readonly status: "unknown"; readonly reason: "capture_unavailable" | "capture_failed" | "tree_changed_during_command"; readonly capturedTreeId?: string; readonly settledTreeId?: string };
export interface ChildEnvironmentIdentity {
  readonly version: 1;
  readonly status: "known" | "unknown";
  readonly fingerprint?: string;
  readonly environmentDigest?: string;
  readonly preparedEnvironmentDigest?: string;
  readonly lockfileDigest?: string;
  readonly runtime?: { readonly executableDigest: string; readonly version: string; readonly kind: "node"; readonly versionSource: "runner_node_same_executable" };
  readonly provider?: { readonly providerId: string; readonly implementationDigest: string; readonly immutableImageId?: string };
  readonly unavailable: readonly string[];
}
export const unknownWorkingTree = (): WorkingTreeIdentity => ({ status: "unknown", reason: "capture_unavailable" });
export const unknownChildEnvironment = (): ChildEnvironmentIdentity => ({ version: 1, status: "unknown", unavailable: ["effective_child_environment", "runtime", "lockfiles"] });

/** Caller supplies an already attested private run root and run-owned Git runner.
 * A separate index per snapshot never reads or writes the owner's staging index.
 * Git owns newline/attribute/filter semantics; unsupported mechanics stay unknown.
 */
const RUNNER_REPORT_EXCLUSION = ":(exclude,glob)**/.aiboard-report-*";

export async function captureWorkingTreeIdentity(cwd: string, indexRoot: string, execute: GitRunner): Promise<WorkingTreeIdentity> {
  let temporary: string | undefined;
  try {
    const repository = await execute({cwd, args: ["rev-parse", "--show-toplevel"]});
    const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
    // A subdirectory grant cannot authorize a wider repository snapshot.
    if (repository.exitCode !== 0 || !samePath(await realpath(repository.stdout.trim()), await realpath(cwd))) return {status: "unknown", reason: "capture_failed"};
    await mkdir(indexRoot, { recursive: true });
    const root = await realpath(indexRoot);
    if (!samePath(root, indexRoot)) return { status: "unknown", reason: "capture_failed" };
    const traversal = relative(await realpath(cwd), root);
    if (traversal === "" || (traversal !== ".." && !traversal.startsWith(`..${sep}`) && !isAbsolute(traversal))) return { status: "unknown", reason: "capture_failed" };
    temporary = await mkdtemp(join(root, "command-index-"));
    const env = Object.freeze({ GIT_INDEX_FILE: join(temporary, "index") });
    // Runner-written test reports (.aiboard-report-*) are not project content: counting them made every
    // reported test command "tree_changed_during_command", so its evidence lost its identity (tunnel run).
    for (const args of [["read-tree", "HEAD"], ["add", "-A", "--", ".", RUNNER_REPORT_EXCLUSION]]) {
      const result = await execute({ cwd, args, env });
      if (result.exitCode !== 0) return { status: "unknown", reason: "capture_failed" };
    }
    const result = await execute({ cwd, args: ["write-tree"], env });
    const treeId = result.stdout.trim();
    return result.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(treeId)
      ? Object.freeze({ status: "known", treeId }) : { status: "unknown", reason: "capture_failed" };
  } catch { return { status: "unknown", reason: "capture_failed" }; }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

/** Only the actual prepared environment is accepted here by trusted host callers.
 * Arbitrary Python/Java/image runtimes deliberately have unavailable versions.
 * No environment value (including granted credentials) enters the envelope.
 */
export async function fingerprintChildEnvironment(input: {
  environment: Readonly<Record<string, string>>; executable: string; cwd: string;
  provider?: ChildEnvironmentIdentity["provider"];
}): Promise<ChildEnvironmentIdentity> {
  const unavailable: string[] = [];
  // VF7b: the Runner's per-owner browsing names (session, state folders) differ between agent sessions and say
  // nothing about the command's result, so they stay out of the digest and evidence still matches across owners.
  // Exact names only (case-insensitive only where the platform's names are); the run's browser stays in.
  const ownerScoped = new Set<string>(PLAYWRIGHT_CLI_OWNER_VARIABLES);
  const ownerScopedName = (name: string) => ownerScoped.has(process.platform === "win32" ? name.toUpperCase() : name);
  const pairs = Object.entries(input.environment).filter(([name]) => !ownerScopedName(name)).map(([name, value]) => [process.platform === "win32" ? name.toUpperCase() : name, value]).sort(([a], [b]) => a!.localeCompare(b!));
  const environmentDigest = createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
  let runtime: ChildEnvironmentIdentity["runtime"];
  try {
    if (input.provider || !isAbsolute(input.executable) || await realpath(input.executable) !== await realpath(process.execPath)) throw new Error("unknown runtime");
    runtime = Object.freeze({ kind: "node", version: process.version, versionSource: "runner_node_same_executable", executableDigest: createHash("sha256").update(await readFile(input.executable)).digest("hex") });
  } catch { unavailable.push("runtime"); }
  const lockfiles: Array<[string, string | null]> = [];
  for (const name of ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "uv.lock", "poetry.lock", "Pipfile.lock", "Cargo.lock", "Gemfile.lock", "packages.lock.json", "gradle.lockfile"]) {
    try { lockfiles.push([name, createHash("sha256").update(await readFile(join(input.cwd, name))).digest("hex")]); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") lockfiles.push([name, null]); else unavailable.push("lockfiles"); }
  }
  const lockfileDigest = createHash("sha256").update(JSON.stringify(lockfiles)).digest("hex");
  if (input.provider) unavailable.push("effective_provider_environment", "provider_runtime");
  const metadata = { ...(input.provider ? {preparedEnvironmentDigest: environmentDigest} : {environmentDigest}), lockfileDigest, ...(runtime ? { runtime } : {}), ...(input.provider ? { provider: Object.freeze({...input.provider}) } : {}) };
  return Object.freeze({ version: 1, status: unavailable.length ? "unknown" : "known", ...metadata,
    ...(unavailable.length ? {} : { fingerprint: createHash("sha256").update(JSON.stringify(metadata)).digest("hex") }), unavailable: Object.freeze([...new Set(unavailable)]) });
}

const CAPTURES = new WeakMap<GitRunner, (cwd: string) => Promise<WorkingTreeIdentity>>();
const RESTORES = new WeakMap<GitRunner, (cwd: string, treeId: string) => Promise<string[]>>();
/** Trusted composition only; never supplied by model tool arguments. */
export function bindWorkingTreeCapture(execute: GitRunner, capture: (cwd: string) => Promise<WorkingTreeIdentity>): void { CAPTURES.set(execute, capture); }
export async function workingTreeForRunner(execute: GitRunner, cwd: string): Promise<WorkingTreeIdentity> {
  return await CAPTURES.get(execute)?.(cwd) ?? unknownWorkingTree();
}
/** Trusted composition only: the restore that goes with the capture bound to the same runner (same private root). */
export function bindWorkingTreeRestore(execute: GitRunner, restore: (cwd: string, treeId: string) => Promise<string[]>): void { RESTORES.set(execute, restore); }
export async function restoreWorkingTreeForRunner(execute: GitRunner, cwd: string, treeId: string): Promise<string[]> {
  const restore = RESTORES.get(execute);
  if (!restore) throw new Error("The working-tree restore is unavailable for this Git runner.");
  return await restore(cwd, treeId);
}

/** At most this many characters of pathspecs on one Git command line (Windows allows 32,767 for the whole line). */
const RESTORE_PATHSPEC_CHARS = 8_000;

/**
 * CW6 (CLI workers plan §3.6): puts a worktree's working files back to `treeId`, a tree captureWorkingTreeIdentity
 * took earlier, after something the Runner ran (a re-run of a CLI worker's check) changed them. The same private-index
 * rules as the capture: the owner's staging index is never read or written. Files the tree has are written back from
 * it; files it lacks (added since, not ignored) are removed. Returns the paths it put back, sorted, and throws unless a
 * fresh capture then reads exactly `treeId`.
 */
export async function restoreWorkingTree(cwd: string, indexRoot: string, execute: GitRunner, treeId: string): Promise<string[]> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(treeId)) throw new Error("The tree to restore is not a tree id.");
  const now = await captureWorkingTreeIdentity(cwd, indexRoot, execute);
  if (now.status !== "known") throw new Error("The working files could not be read before their restore.");
  if (now.treeId === treeId) return [];
  const diff = await execute({ cwd, args: ["diff", "--name-status", "-z", "--no-renames", treeId, now.treeId] });
  if (diff.exitCode !== 0) throw new Error("The changed working files could not be listed.");
  const fields = diff.stdout.split("\0");
  const restore: string[] = [], remove: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!, path = fields[index + 1]!;
    if (!path) continue;
    // Added since the tree: removed. Changed or deleted since: written back from the tree.
    (status === "A" ? remove : restore).push(path);
  }
  const root = await realpath(indexRoot);
  const temporary = await mkdtemp(join(root, "restore-index-"));
  try {
    const env = Object.freeze({ GIT_INDEX_FILE: join(temporary, "index") });
    const run = async (args: readonly string[]) => {
      const result = await execute({ cwd, args, env });
      if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed while the working files were restored.`);
    };
    await run(["read-tree", treeId]);
    for (const batch of pathspecBatches(restore)) await run(["checkout", treeId, "--", ...batch]);
    // Listed paths only, ignored or not: each is a file the tree does not have.
    for (const batch of pathspecBatches(remove)) await run(["clean", "-f", "-x", "-q", "--", ...batch]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  const after = await captureWorkingTreeIdentity(cwd, indexRoot, execute);
  if (after.status !== "known" || after.treeId !== treeId) throw new Error("The working files could not be proven back to the tree they were restored to.");
  return [...restore, ...remove].sort();
}

function pathspecBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [], size = 0;
  for (const path of paths) {
    const spec = `:(literal)${path}`;
    if (batch.length && size + spec.length > RESTORE_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(spec);
    size += spec.length + 1;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function settleWorkingTreeIdentity(before: WorkingTreeIdentity, after: WorkingTreeIdentity): WorkingTreeIdentity {
  return before.status === "known" && after.status === "known" && before.treeId === after.treeId ? before
    : {status: "unknown", reason: before.status === "known" && after.status === "known" ? "tree_changed_during_command" : "capture_failed", ...(before.status === "known" ? {capturedTreeId: before.treeId} : {}), ...(after.status === "known" ? {settledTreeId: after.treeId} : {})};
}
