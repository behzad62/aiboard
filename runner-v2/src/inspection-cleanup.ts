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

/** Workload exit alone does not settle output, release, or unresolved effects. */
export function assertSubprocessCleanupSettled(store: DurableProcessStore): void {
  for (const invocationId of store.listRowIds()) {
    const record = store.readByInvocation(invocationId);
    const noLaunch = record && !record.backendBinding &&
      (record.state === "reused" || record.state === "launch_not_proven") &&
      record.cleanup.state === "not_required";
    const cleaned = record?.state === "cleaned" && record.cleanup.state === "verified_empty";
    if (!record || record.pendingEffects.length || (!noLaunch && !cleaned)) {
      throw new Error(`Subprocess ${invocationId} cleanup remains unverified in ${record?.state ?? "missing"}.`);
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
