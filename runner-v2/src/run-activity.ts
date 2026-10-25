/**
 * What the runner is doing right now outside model turns: verification checkouts, dependency installs
 * and checks. Final verification spent eighteen minutes on such steps with no event and no visible
 * activity, so the owner could not tell work from a hang (tunnel run). Held in memory only; scheduler
 * events stay the durable record.
 */
export interface RunActivity {
  id: number;
  label: string;
  startedAt: string;
  taskId?: string;
}

export interface RunActivityTracker {
  track<T>(label: string, work: () => Promise<T>, taskId?: string): Promise<T>;
}

export class RunActivityBoard implements RunActivityTracker {
  private nextId = 1;
  private readonly active = new Map<number, RunActivity>();

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  async track<T>(label: string, work: () => Promise<T>, taskId?: string): Promise<T> {
    const id = this.nextId++;
    this.active.set(id, { id, label, startedAt: this.clock(), ...(taskId ? { taskId } : {}) });
    try {
      return await work();
    } finally {
      this.active.delete(id);
    }
  }

  /** Oldest first; a nested step follows the step it belongs to. */
  list(): RunActivity[] {
    return [...this.active.values()].map((activity) => ({ ...activity }));
  }
}
