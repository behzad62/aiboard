import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  assertAssignmentClaim,
  type AssignmentClaim,
  type ExecutionTaskContract,
} from "./planning-contracts.js";
import type { BuildTask } from "./task-contracts.js";

export const MAX_WORKERS = 4;

export interface NewPolicyCapacityInput {
  readonly planningPolicyVersion?: number;
  readonly configuredMax: number;
  readonly resourceCapacity?: number;
}

export function effectiveMaxWorkers(input: NewPolicyCapacityInput): number {
  if (!Number.isSafeInteger(input.configuredMax) || input.configuredMax < 1) {
    throw new Error("configuredMax must be a positive integer.");
  }
  if (input.planningPolicyVersion !== 1) return input.configuredMax;
  let bound = Math.min(MAX_WORKERS, input.configuredMax);
  if (input.resourceCapacity !== undefined) {
    if (!Number.isSafeInteger(input.resourceCapacity) || input.resourceCapacity < 0) {
      throw new Error("resourceCapacity must be a non-negative integer.");
    }
    bound = Math.min(bound, input.resourceCapacity);
  }
  return bound;
}

export function normalizeClaimPath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const absolute = trimmed.startsWith("/");
  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

export function claimPathKey(path: string): string {
  return normalizeClaimPath(path).replace(/^[A-Za-z]:/, "").toLowerCase();
}

export function claimPathsEqual(left: string, right: string): boolean {
  return claimPathKey(left) === claimPathKey(right);
}

export function claimPathContains(outer: string, inner: string): boolean {
  const outerKey = claimPathKey(outer);
  const innerKey = claimPathKey(inner);
  return outerKey === innerKey ||
    outerKey === "." ||
    outerKey === "" ||
    outerKey === "/" ||
    innerKey.startsWith(`${outerKey}/`);
}

export function claimPathsOverlap(left: string, right: string): boolean {
  return claimPathContains(left, right) || claimPathContains(right, left);
}

export interface AliasResolution {
  readonly requested: string;
  readonly resolved: string;
  readonly confirmed: boolean;
}

/**
 * Resolve a claim path against an explicit project/worktree root. New files
 * resolve through the nearest existing ancestor, so this never depends on
 * process.cwd(). Reducers consume already-recorded normalized paths.
 */
export function resolveClaimPathAgainstRoot(
  path: string,
  projectRoot: string,
): AliasResolution {
  const absolute = isAbsolute(path.replace(/\\/g, "/"))
    ? resolve(path)
    : resolve(projectRoot, path);
  let candidate = absolute;
  const suffix: string[] = [];
  for (;;) {
    try {
      lstatSync(candidate);
      const absoluteResolved = resolve(
        realpathSync(candidate),
        ...suffix.reverse(),
      );
      const root = (() => {
        try {
          return realpathSync(resolve(projectRoot));
        } catch {
          return resolve(projectRoot);
        }
      })();
      const withinRoot = relative(root, absoluteResolved);
      const resolved = withinRoot.startsWith("..") || isAbsolute(withinRoot)
        ? absoluteResolved
        : withinRoot;
      return { requested: path, resolved: normalizeClaimPath(resolved), confirmed: true };
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        return {
          requested: path,
          resolved: normalizeClaimPath(absolute),
          confirmed: false,
        };
      }
      suffix.push(relative(parent, candidate));
      candidate = parent;
    }
  }
}

export const SHARED_LOCKFILE_NAMES: readonly string[] = Object.freeze([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "podfile.lock",
  "packages.lock.json",
]);

export const SHARED_SURFACE_DIR_PREFIXES: readonly string[] = Object.freeze([
  "migrations/",
  "db/migrate/",
  "prisma/migrations/",
  "alembic/versions/",
  "drizzle/",
  "config/",
  "contracts/",
]);

function basenameOf(normalized: string): string {
  const index = normalized.lastIndexOf("/");
  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function isSharedLockfile(path: string): boolean {
  return SHARED_LOCKFILE_NAMES.includes(basenameOf(normalizeClaimPath(path)).toLowerCase());
}

export function isSharedSurfaceDir(path: string): boolean {
  const segments = claimPathKey(path).split("/").filter(Boolean);
  return SHARED_SURFACE_DIR_PREFIXES.some((prefix) => {
    const parts = prefix.split("/").filter(Boolean);
    return segments.some((_segment, start) =>
      parts.every((part, offset) => segments[start + offset] === part),
    );
  });
}

function sharedSurfaceResource(path: string): string {
  const normalized = normalizeClaimPath(path);
  if (isSharedLockfile(normalized)) {
    return `shared:lockfile:${basenameOf(claimPathKey(normalized))}`;
  }
  const segments = claimPathKey(normalized).split("/").filter(Boolean);
  for (const prefix of SHARED_SURFACE_DIR_PREFIXES) {
    const parts = prefix.split("/").filter(Boolean);
    for (let start = 0; start + parts.length <= segments.length; start += 1) {
      if (parts.every((part, offset) => segments[start + offset] === part)) {
        return `shared:dir:${parts.join("/")}`;
      }
    }
  }
  return `shared:path:${claimPathKey(normalized)}`;
}

export function isSharedSurface(path: string): boolean {
  return isSharedLockfile(path) || isSharedSurfaceDir(path);
}

const RESOURCE_KIND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  database: "db",
  postgres: "db",
  mysql: "db",
  sqlite: "db",
  tcp: "port",
  http: "port",
  config: "config",
  schema: "schema",
});

export function normalizeResourceClaim(resource: string): string {
  const separator = resource.indexOf(":");
  if (separator < 0) return resource.trim().toLowerCase().replace(/\s+/g, " ");
  const kind = resource.slice(0, separator).trim().toLowerCase().replace(/\s+/g, "");
  const name = resource.slice(separator + 1).trim().toLowerCase().replace(/\s+/g, "");
  return `${RESOURCE_KIND_ALIASES[kind] ?? kind}:${name}`;
}

export interface TaskWriteClaim {
  readonly taskId: string;
  readonly files: readonly string[];
  readonly resources: readonly string[];
  readonly worktree: string;
}

function sharedSurfaceFiles(surfaces: readonly string[]): string[] {
  return surfaces
    .map(normalizeClaimPath)
    .filter(isSharedSurface)
    .map(sharedSurfaceResource);
}

export function contractWriteClaim(
  contract: ExecutionTaskContract,
  worktree: string,
): TaskWriteClaim {
  const files = contract.writableSurfaces.map(normalizeClaimPath);
  return {
    taskId: contract.id,
    files,
    resources: [...new Set([
      ...(contract.sharedResourceClaims ?? []).map(normalizeResourceClaim),
      ...sharedSurfaceFiles(files),
    ])],
    worktree: normalizeClaimPath(worktree),
  };
}

export function schedulerTaskWriteClaim(
  task: BuildTask,
  contract: ExecutionTaskContract | undefined,
  worktree: string,
): TaskWriteClaim {
  if (!contract) {
    return {
      taskId: task.id,
      files: task.kind === "verification_repair" ? [normalizeClaimPath(worktree)] : [],
      resources: task.kind === "verification_repair" ? ["shared:repair/admission"] : [],
      worktree: normalizeClaimPath(worktree),
    };
  }
  const base = contractWriteClaim(contract, worktree);
  return {
    ...base,
    taskId: task.id,
    resources: [
      ...base.resources,
      ...(task.kind === "verification_repair" ? ["shared:repair/admission"] : []),
    ],
  };
}

export type ClaimConflictKind = "worktree" | "file" | "shared_surface" | "resource";

export interface ClaimConflict {
  readonly kind: ClaimConflictKind;
  readonly detail: string;
}

export function findClaimConflict(
  candidate: TaskWriteClaim,
  actives: readonly TaskWriteClaim[],
  resolveAlias: (path: string) => AliasResolution = (path) => ({
    requested: path,
    resolved: normalizeClaimPath(path),
    confirmed: false,
  }),
): ClaimConflict | undefined {
  const candidateFiles = candidate.files.map((file) => resolveAlias(file).resolved);
  const candidateResources = new Set(candidate.resources.map(normalizeResourceClaim));
  for (const active of actives) {
    if (active.taskId === candidate.taskId) continue;
    if (claimPathsEqual(active.worktree, candidate.worktree)) {
      return {
        kind: "worktree",
        detail: `Task ${candidate.taskId} shares worktree ${candidate.worktree} with active task ${active.taskId}; no two writers share one worktree.`,
      };
    }
    const activeFiles = active.files.map((file) => resolveAlias(file).resolved);
    for (const left of candidateFiles) {
      for (const right of activeFiles) {
        if (claimPathsOverlap(left, right)) {
          const shared = isSharedSurface(left) || isSharedSurface(right);
          return {
            kind: shared ? "shared_surface" : "file",
            detail: `Task ${candidate.taskId} claims ${left}, overlapping active task ${active.taskId}'s claim ${right}${shared ? " (shared contract/config/migration/lockfile surface)" : ""}.`,
          };
        }
      }
    }
    const activeResources = new Set(active.resources.map(normalizeResourceClaim));
    for (const resource of candidateResources) {
      if (activeResources.has(resource)) {
        return {
          kind: "resource",
          detail: `Task ${candidate.taskId} claims shared resource ${resource}, already held by active task ${active.taskId}.`,
        };
      }
    }
  }
  return undefined;
}

export function assignmentPacketIdFor(
  taskId: string,
  contractId?: string,
  kernelRepair = false,
): string {
  if (kernelRepair && contractId === undefined) {
    return `kernel-repair:${encodeURIComponent(taskId)}`;
  }
  return contractId !== undefined && contractId !== taskId
    ? `repair:${encodeURIComponent(contractId)}::${taskId}`
    : taskId;
}

export function assignmentIsKernelRepair(packetId: string): boolean {
  return packetId.startsWith("kernel-repair:");
}

export function assignmentContractId(packetId: string): string {
  if (assignmentIsKernelRepair(packetId)) {
    return decodeURIComponent(packetId.slice("kernel-repair:".length));
  }
  return packetId.startsWith("repair:")
    ? decodeURIComponent(packetId.slice("repair:".length).split("::", 1)[0])
    : packetId;
}

export function assignmentMatchesTask(packetId: string, taskId: string): boolean {
  return packetId === taskId ||
    packetId.endsWith(`::${taskId}`) ||
    (
      assignmentIsKernelRepair(packetId) &&
      decodeURIComponent(packetId.slice("kernel-repair:".length)) === taskId
    );
}

export function taskWriteClaimFromAssignment(
  claim: AssignmentClaim,
  taskId: string,
): TaskWriteClaim {
  const files: string[] = [];
  const resources: string[] = [];
  for (const surface of claim.writableSurfaces) {
    if (surface.startsWith("resource:")) resources.push(normalizeResourceClaim(surface.slice("resource:".length)));
    else files.push(normalizeClaimPath(surface));
  }
  return {
    taskId,
    files,
    resources: [...new Set([...resources, ...sharedSurfaceFiles(files)])],
    worktree: normalizeClaimPath(claim.branchOrWorktree),
  };
}

export interface AssignmentClaimInput {
  readonly packetId: string;
  readonly laneId: string;
  readonly workerOrSessionId: string;
  readonly acceptedBaseRevision: string;
  readonly branchOrWorktree: string;
  readonly writableSurfaces: readonly string[];
  readonly forbiddenSurfaces: readonly string[];
  readonly ownershipGeneration: number;
}

export function claimIdFor(taskId: string, ownershipGeneration: number): string {
  return `t4claim:${taskId}:gen:${ownershipGeneration}`;
}

export function buildAssignmentClaim(input: AssignmentClaimInput): AssignmentClaim {
  const claim: AssignmentClaim = {
    id: claimIdFor(input.packetId, input.ownershipGeneration),
    packetId: input.packetId,
    laneId: input.laneId,
    workerOrSessionId: input.workerOrSessionId,
    acceptedBaseRevision: input.acceptedBaseRevision,
    branchOrWorktree: input.branchOrWorktree,
    writableSurfaces: [...input.writableSurfaces],
    forbiddenSurfaces: [...input.forbiddenSurfaces],
    ownershipGeneration: input.ownershipGeneration,
    state: "claimed",
  };
  assertAssignmentClaim(claim);
  return claim;
}

export function releaseAssignmentClaim(
  prior: AssignmentClaim,
  state: "released" | "stopped_fenced",
  writerStopEvidence?: string,
): AssignmentClaim {
  const released: AssignmentClaim = {
    ...prior,
    writableSurfaces: [...prior.writableSurfaces],
    forbiddenSurfaces: [...prior.forbiddenSurfaces],
    state,
    ...(writerStopEvidence !== undefined ? { writerStopEvidence } : {}),
  };
  assertAssignmentClaim(released);
  return released;
}

export function nextClaimGeneration(priorClaims: readonly AssignmentClaim[]): number {
  return Math.max(0, ...priorClaims.map((claim) => claim.ownershipGeneration)) + 1;
}

export function assertClaimSuccessor(
  prior: AssignmentClaim,
  next: AssignmentClaim,
): void {
  if (prior.state !== "released" && prior.state !== "stopped_fenced") {
    throw new Error(
      `Cannot reassign packet ${prior.packetId}: prior claim ${prior.id} is still owned.`,
    );
  }
  if (prior.state === "stopped_fenced" && !prior.writerStopEvidence?.trim()) {
    throw new Error(
      `Cannot reassign packet ${prior.packetId}: stopped/fenced claim ${prior.id} lacks writer-stop evidence.`,
    );
  }
  if (next.ownershipGeneration !== prior.ownershipGeneration + 1) {
    throw new Error(
      `Reassignment of packet ${prior.packetId} must advance ownershipGeneration from ${prior.ownershipGeneration} to ${prior.ownershipGeneration + 1}, got ${next.ownershipGeneration}.`,
    );
  }
}
