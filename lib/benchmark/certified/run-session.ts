import type { BenchmarkPreset } from "./run-presets";

export type CertifiedRunOwner = "advanced" | "preset";
export type CertifiedTabRunPhase = "idle" | "running" | "cancelling";

export interface CertifiedTabRunSnapshot {
  owner: CertifiedRunOwner | null;
  phase: CertifiedTabRunPhase;
  presetId?: BenchmarkPreset["id"];
  startedAt?: number;
  error?: string;
}

export interface CertifiedTabRunCoordinator {
  getSnapshot(): CertifiedTabRunSnapshot;
  subscribe(listener: () => void): () => void;
  tryStart(
    owner: CertifiedRunOwner,
    metadata: { presetId?: BenchmarkPreset["id"] },
    execute: (signal: AbortSignal) => Promise<void>
  ): boolean;
  cancel(reason: unknown): boolean;
}

const IDLE: CertifiedTabRunSnapshot = { owner: null, phase: "idle" };

export function createCertifiedTabRunCoordinator(): CertifiedTabRunCoordinator {
  let snapshot = IDLE;
  let controller: AbortController | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();

  const publish = (next: CertifiedTabRunSnapshot) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tryStart(owner, metadata, execute) {
      if (snapshot.owner !== null) return false;
      const runGeneration = ++generation;
      const runController = new AbortController();
      controller = runController;
      publish({
        owner,
        phase: "running",
        ...metadata,
        startedAt: Date.now(),
      });
      void Promise.resolve()
        .then(() => execute(runController.signal))
        .catch((error: unknown) => {
          if (runGeneration !== generation) return;
          publish({
            ...snapshot,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (runGeneration !== generation) return;
          controller = null;
          publish({ owner: null, phase: "idle", error: snapshot.error });
        });
      return true;
    },
    cancel(reason) {
      if (!controller || snapshot.owner === null) return false;
      if (!controller.signal.aborted) controller.abort(reason);
      if (snapshot.phase !== "cancelling") {
        publish({ ...snapshot, phase: "cancelling" });
      }
      return true;
    },
  };
}

export const certifiedTabRunCoordinator = createCertifiedTabRunCoordinator();
