import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { ManagedProcessService } from "./managed-process.js";
import { rebuildSchedulerProjection, type SchedulerStore } from "./scheduler-store.js";

export interface TempCreationRecord {
  readonly path: string;
  readonly ownerRunId: string;
  readonly ownerProjectId: string;
  readonly createdAt: string;
  readonly kind: "directory" | "file";
  /**
   * T6b repair (OA-17): paths retained by design (live execution copies,
   * snapshots) are recorded so the owner can see them but are never
   * deletion candidates. Only `retained !== true` records are eligible.
   */
  readonly retained?: boolean;
}

export interface LeftoverCleanupRecord {
  readonly path: string;
  readonly ownership: "proven" | "unproven";
  readonly action: "cleaned" | "retained";
  readonly reason: string;
}

export interface ProcessOwnershipRecord {
  readonly processId: string;
  readonly ownerRunId: string;
  readonly status: "running" | "stopped" | "exited_unknown";
}

export interface CleanupSearchFinding {
  readonly processes: readonly {
    readonly processId: string;
    readonly ownership: "proven" | "unproven";
    readonly action: "cleaned" | "retained";
    readonly reason: string;
  }[];
  readonly tempPaths: readonly LeftoverCleanupRecord[];
}

/**
 * T6b repair (OA-17): validate a creation record without touching the
 * filesystem. Durable persistence lives in Runner-private SQLite state
 * (scheduler `temp.creation_recorded` events); this module never writes a
 * shared or worker-writable registry file, so a forged record cannot be
 * planted by executed workloads.
 */
export function recordTempCreation(record: TempCreationRecord): TempCreationRecord {
  if (!record.path.trim() || !record.ownerRunId.trim() || !record.ownerProjectId.trim()) {
    throw new Error("Temporary-path creation requires path and owner identity.");
  }
  if (!isAbsolute(record.path)) {
    throw new Error("Temporary-path creation requires an absolute path.");
  }
  return record;
}

/** Durable scheduler key for one recorded path. */
export function tempCreationRecordKey(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 24);
}

/**
 * T6b repair (N6): idempotency keys derive from durable record identity,
 * never the clock.
 */
export function tempCreationIdempotencyKey(record: TempCreationRecord): string {
  return `temp:${record.ownerRunId}:${record.ownerProjectId}:${tempCreationRecordKey(record.path)}`;
}

/**
 * T6b repair (OA-17): containment check against runner-owned roots. A
 * record is only a deletion candidate when its path is still under a root
 * the runner itself created (OS temp runner prefixes, the runner state
 * directory, run roots) and outside the workspace/project tree.
 */
export function isPathUnderAnyRoot(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const resolved = resolve(path);
  return roots.some((root) => {
    if (!root || !isAbsolute(root)) return false;
    const parent = resolve(root);
    const rel = relative(parent, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export interface TempPathObservation {
  readonly exists: boolean;
  readonly isSymbolicLink: boolean;
  readonly kindMatches: boolean;
}

/**
 * T6b repair (OA-17): pure ownership decision. The caller supplies the
 * filesystem observation (gathered with lstat, never following symlinks or
 * junctions) and performs the deletion only when this decision returns
 * `proven`/`cleaned`. Paths outside the runner-owned roots, symlinks, and
 * retained-by-design records are never deletion candidates, so a forged or
 * stale record cannot delete a user folder (probe F).
 */
export function decideRecordedTempCleanup(
  record: TempCreationRecord,
  expected: { readonly ownerRunId: string; readonly ownerProjectId: string },
  runnerRoots: readonly string[],
  observation: TempPathObservation,
  excludedRoots: readonly string[] = [],
): LeftoverCleanupRecord {
  if (record.ownerRunId !== expected.ownerRunId || record.ownerProjectId !== expected.ownerProjectId) {
    return { path: record.path, ownership: "unproven", action: "retained", reason: "Creation record owner does not match the current runner owner." };
  }
  if (excludedRoots.length > 0 && isPathUnderAnyRoot(record.path, excludedRoots)) {
    return { path: record.path, ownership: "unproven", action: "retained", reason: "Recorded path is inside the workspace or project tree; never removed by temp cleanup." };
  }
  if (record.retained === true) {
    return { path: record.path, ownership: "proven", action: "retained", reason: "Recorded path is retained by design and is never a cleanup candidate." };
  }
  if (!isPathUnderAnyRoot(record.path, runnerRoots)) {
    return { path: record.path, ownership: "unproven", action: "retained", reason: "Recorded path is outside the runner-owned roots; never followed or removed." };
  }
  if (observation.isSymbolicLink) {
    return { path: record.path, ownership: "proven", action: "retained", reason: "Recorded path is a symlink or junction, which the runner never follows." };
  }
  if (!observation.exists) return { path: record.path, ownership: "proven", action: "cleaned", reason: "Recorded path is already absent." };
  if (!observation.kindMatches) {
    return { path: record.path, ownership: "proven", action: "retained", reason: "Recorded path kind does not match filesystem entry." };
  }
  return { path: record.path, ownership: "proven", action: "cleaned", reason: "Recorded runner-owned path is a leftover cleanup candidate." };
}

/**
 * T6b repair (OA-17): durable creation-record sink. Production wires this
 * to Runner-private scheduler state (scheduler `temp.creation_recorded`
 * events in the SQLite store under the runner state directory). Call sites
 * validate synchronously via {@link recordTempCreation} and then call the
 * sink; a missing sink means the path is transient and self-cleaned.
 */
export interface TempRecordSink {
  readonly recorded: (record: {
    readonly path: string;
    readonly ownerRunId?: string;
    readonly ownerProjectId?: string;
    readonly kind: "directory" | "file";
    readonly createdAt: string;
    readonly retained?: boolean;
  }) => void;
  readonly cleared: (path: string) => void;
}

/**
 * T6b repair (OA-17): scheduler-backed sink keyed to the real run and
 * project. Records survive sessions and replacement agents; clearing is
 * idempotent. Every append uses a durable idempotency key (N6).
 */
export function createSchedulerTempRecorders(
  store: SchedulerStore,
  owner: { readonly runId: string; readonly projectId: string },
  clock: () => string,
): TempRecordSink {
  return {
    recorded: (record) => {
      const validated = recordTempCreation({
        path: record.path,
        ownerRunId: record.ownerRunId ?? owner.runId,
        ownerProjectId: record.ownerProjectId ?? owner.projectId,
        createdAt: record.createdAt,
        kind: record.kind,
        ...(record.retained === true ? { retained: true as const } : {}),
      });
      // Re-recording the same path with the same owners is an idempotent
      // no-op (a resumed run replays creation). A different owner for the
      // same path still falls through to the reducer conflict below.
      // T6b repair (R3 N-3): the already-recorded check respects the
      // retained flag — an identical record is a no-op, a retained record
      // is never downgraded, and only a retained upgrade falls through (on
      // its own idempotency key; the reducer merges retained upward).
      const existing = rebuildSchedulerProjection(store.readRun(owner.runId)).tempRecords?.[tempCreationRecordKey(validated.path)];
      let upgradeToRetained = false;
      if (existing && existing.ownerRunId === validated.ownerRunId &&
        existing.ownerProjectId === validated.ownerProjectId && existing.kind === validated.kind) {
        if (existing.retained || validated.retained !== true) return;
        upgradeToRetained = true;
      }
      store.append({
        runId: owner.runId,
        type: "temp.creation_recorded",
        occurredAt: clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: upgradeToRetained ? `${tempCreationIdempotencyKey(validated)}:retained` : tempCreationIdempotencyKey(validated),
        payload: {
          path: validated.path,
          ownerRunId: validated.ownerRunId,
          ownerProjectId: validated.ownerProjectId,
          createdAt: validated.createdAt,
          kind: validated.kind,
          ...(validated.retained === true ? { retained: true } : {}),
        },
      });
    },
    cleared: (path) => {
      store.append({
        runId: owner.runId,
        type: "temp.record_cleared",
        occurredAt: clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: `temp-cleared:${owner.runId}:${tempCreationRecordKey(path)}`,
        payload: { path },
      });
    },
  };
}

/** Records owned by this run and project. Foreign records stay for their owner. */
export function filterRecordsForOwner(
  records: readonly TempCreationRecord[],
  expected: { readonly ownerRunId: string; readonly ownerProjectId: string },
): TempCreationRecord[] {
  return records.filter(
    (record) => record.ownerRunId === expected.ownerRunId && record.ownerProjectId === expected.ownerProjectId,
  );
}

export type OwnedProcessCleanupRecord = {
  readonly processId: string;
  readonly ownership: "proven" | "unproven";
  readonly action: "cleaned" | "retained";
  readonly reason: string;
};

/**
 * T6b (OA-17): find processes the runner still owns after a task attempt or
 * verification, using the existing ownership records. Proven-owned leftovers
 * still alive are stopped; uncertain end states and foreign owners are
 * retained and reported, never killed on a guess.
 * T6b repair (N-6): with an attempt scope, only the attempt's sessions are
 * stop candidates, stopped individually instead of via the run-wide
 * stopRun; live processes outside the scope are retained and reported.
 */
export async function searchOwnedProcesses(
  processes: Pick<ManagedProcessService, "listRun" | "stopRun" | "stopProcesses">,
  ownerRunId: string,
  scope?: { readonly sessionIds: readonly string[] },
): Promise<OwnedProcessCleanupRecord[]> {
  const findings: OwnedProcessCleanupRecord[] = [];
  const observations = await processes.listRun(ownerRunId);
  const inScope = (entry: { readonly sessionId: string }): boolean =>
    scope === undefined || scope.sessionIds.includes(entry.sessionId);
  const aliveOwned = observations.filter((entry) => entry.runId === ownerRunId && entry.status === "running" && inScope(entry));
  const outOfScope = scope === undefined
    ? []
    : observations.filter((entry) => entry.runId === ownerRunId && entry.status === "running" && !inScope(entry));
  if (aliveOwned.length > 0) {
    let stopped = false;
    try {
      if (scope === undefined) await processes.stopRun(ownerRunId);
      else await processes.stopProcesses(aliveOwned.map((proc) => proc.processId));
      stopped = true;
    } catch {
      stopped = false;
    }
    const after = stopped ? await processes.listRun(ownerRunId) : observations;
    const current = new Map(after.map((entry) => [entry.processId, entry]));
    for (const proc of aliveOwned) {
      const state = current.get(proc.processId);
      if (stopped && (!state || state.status !== "running")) {
        findings.push({ processId: proc.processId, ownership: "proven", action: "cleaned", reason: "Owned process still alive after the attempt was stopped." });
      } else {
        findings.push({ processId: proc.processId, ownership: "proven", action: "retained", reason: "Owned process is still running after a stop request; retained and reported." });
      }
    }
  }
  for (const proc of outOfScope) {
    findings.push({ processId: proc.processId, ownership: "proven", action: "retained", reason: "Process session is outside the attempt's sessions; retained and reported." });
  }
  for (const entry of observations) {
    if (entry.runId !== ownerRunId) {
      findings.push({ processId: entry.processId, ownership: "unproven", action: "retained", reason: "Process owner does not match the current run; retained and reported." });
    } else if (entry.status === "exited_unknown") {
      findings.push({ processId: entry.processId, ownership: "proven", action: "retained", reason: "Process end state is unknown; retained and reported, never stopped on a guess." });
    }
  }
  return findings;
}
