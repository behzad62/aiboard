import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import type { GitRunner } from "./git-repository.js";

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
    for (const args of [["read-tree", "HEAD"], ["add", "-A", "--", "."]]) {
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
  const pairs = Object.entries(input.environment).map(([name, value]) => [process.platform === "win32" ? name.toUpperCase() : name, value]).sort(([a], [b]) => a!.localeCompare(b!));
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
/** Trusted composition only; never supplied by model tool arguments. */
export function bindWorkingTreeCapture(execute: GitRunner, capture: (cwd: string) => Promise<WorkingTreeIdentity>): void { CAPTURES.set(execute, capture); }
export async function workingTreeForRunner(execute: GitRunner, cwd: string): Promise<WorkingTreeIdentity> {
  return await CAPTURES.get(execute)?.(cwd) ?? unknownWorkingTree();
}

export function settleWorkingTreeIdentity(before: WorkingTreeIdentity, after: WorkingTreeIdentity): WorkingTreeIdentity {
  return before.status === "known" && after.status === "known" && before.treeId === after.treeId ? before
    : {status: "unknown", reason: before.status === "known" && after.status === "known" ? "tree_changed_during_command" : "capture_failed", ...(before.status === "known" ? {capturedTreeId: before.treeId} : {}), ...(after.status === "known" ? {settledTreeId: after.treeId} : {})};
}
