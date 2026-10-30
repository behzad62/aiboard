import type { DurableProcessStore } from "./durable-process-store.js";
import type { StreamingSessionStore } from "./streaming-session-store.js";

/** A creator retains failed construction duties until transfer or verified cleanup. */
export class InspectionConstructionOwner {
  private readonly duties = new Set<() => void | Promise<void>>();
  private readonly inspections = new Set<() => Promise<void>>();
  private transferred = false;
  private closing: Promise<void> | undefined;

  add(cleanup: () => void | Promise<void>): void { this.duties.add(cleanup); }
  addInspection(cleanup: () => Promise<void>): void { this.inspections.add(cleanup); }
  isComplete(): boolean { return !this.duties.size && !this.inspections.size; }

  transfer(): void {
    this.transferred = true;
    this.duties.clear();
  }

  async closeInspections(): Promise<void> {
    const failures: unknown[] = [];
    for (const cleanup of [...this.inspections].reverse()) {
      try { await cleanup(); this.inspections.delete(cleanup); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Process inspection cleanup remains owned.");
  }

  async close(): Promise<void> {
    if (this.transferred) return;
    if (this.closing) return await this.closing;
    const attempt = (async () => {
      const failures: unknown[] = [];
      for (const cleanup of [...this.duties].reverse()) {
        try { await cleanup(); this.duties.delete(cleanup); }
        catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Run construction cleanup remains owned.");
      await this.closeInspections();
    })();
    this.closing = attempt;
    try { await attempt; }
    finally { if (this.closing === attempt) this.closing = undefined; }
  }
}

/** States startup reconciliation never acts on: only an owner-approved exceptional recovery can. */
const INERT_SUBPROCESS_STATES = new Set(["orphaned", "identity_mismatch", "backend_unavailable", "outcome_unknown"]);

/**
 * Records a run binding inherits that no routine reconciliation can settle: a launch a hard stop
 * orphaned before it gained durable identity, or an effect whose outcome died with the old process.
 * Captured after the binding's startup reconciliation, keyed to the revision it saw. Construction
 * already accepts these; teardown exempts them too, but only while they stay exactly as inherited.
 */
export function inheritedSubprocessResidue(store: DurableProcessStore): ReadonlyMap<string, number> {
  const residue = new Map<string, number>();
  for (const invocationId of store.listUnsettledRowIds?.() ?? store.listRowIds()) {
    let record;
    try { record = store.readByInvocation(invocationId); } catch { continue; }
    if (record && (INERT_SUBPROCESS_STATES.has(record.state) || record.pendingEffects.length > 0)) {
      residue.set(invocationId, record.revision);
    }
  }
  return residue;
}

/** Workload exit alone does not settle output, release, or unresolved effects. */
export function assertSubprocessCleanupSettled(
  store: DurableProcessStore,
  inherited: ReadonlyMap<string, number> = new Map(),
): void {
  for (const invocationId of store.listRowIds()) {
    const record = store.readByInvocation(invocationId);
    if (record && inherited.get(invocationId) === record.revision) continue;
    const noLaunch = record && !record.backendBinding &&
      (record.state === "reused" || record.state === "launch_not_proven") &&
      record.cleanup.state === "not_required";
    const cleaned = record?.state === "cleaned" && record.cleanup.state === "verified_empty";
    if (!record || record.pendingEffects.length || (!noLaunch && !cleaned)) {
      // Diagnostic only: the last transition reason carries the failure detail recorded for this state.
      const reason = record?.history?.at(-1)?.reason;
      throw new Error(`Subprocess ${invocationId} cleanup remains unverified in ${record?.state ?? "missing"}.${reason ? ` Last transition: ${reason}` : ""}`);
    }
  }
}

export function assertStreamingCleanupSettled(store: StreamingSessionStore): void {
  for (const sessionId of store.listSessionIds()) {
    const session = store.readBySession(sessionId);
    if (session?.state !== "released") throw new Error(`Streaming session ${sessionId} remains unreleased in ${session?.state ?? "missing"}.`);
  }
  for (const launchId of store.listHostLaunchIds()) {
    const launch = store.readHostLaunch(launchId);
    if (launch?.state === "released") continue;
    if (launch?.state === "handed_off" && store.readBySession(launch.sessionId)?.state === "released") continue;
    throw new Error(`Streaming launch ${launchId} remains unreleased in ${launch?.state ?? "missing"}.`);
  }
}

/** Expiry bounds the observer; the original operation remains consumed and owned. */
export async function awaitInspectionConstruction<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    void operation.catch(() => undefined);
    throw new Error("ExecutionHost construction remains unsettled; ownership is retained.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("ExecutionHost construction remains unsettled; ownership is retained.")), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
