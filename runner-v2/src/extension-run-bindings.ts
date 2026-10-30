import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionManagementService, ExtensionServiceEvent, ManagedSkillSource } from "./extension-management-service.js";

export interface RunCapabilityBinding {
  readonly version: 1;
  readonly runId: string;
  readonly generation: number;
  readonly boundAt: string;
  readonly transitions: readonly Readonly<{ from: number; to: number; at: string; operationIds: readonly string[]; reason: "run_operation" }>[];
}

/**
 * Durable per-run capability-generation pin. A run binds the current generation when it is first
 * created and keeps it across Runner restarts; it moves only when an operation owned by that run (its
 * Architect installing something the user asked for) publishes a newer generation. Other runs' pins
 * never change, and the generation files they name are immutable.
 */
export class ExtensionRunBindings {
  private readonly bindings = new Map<string, RunCapabilityBinding>();
  private readonly unsubscribe: () => void;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDirectory: string, private readonly service: ExtensionManagementService) {
    this.unsubscribe = service.subscribe((event) => this.observe(event));
  }

  /** Existing pin (recovery) or a new one at the current generation. */
  async bind(runId: string): Promise<RunCapabilityBinding> {
    const known = this.bindings.get(runId) ?? await this.read(runId);
    if (known) {
      this.bindings.set(runId, known);
      return known;
    }
    const binding: RunCapabilityBinding = { version: 1, runId, generation: (await this.service.generation()).generation, boundAt: new Date().toISOString(), transitions: [] };
    await this.write(binding);
    return binding;
  }

  /** Managed skills for the run's current pin; evaluated at each discovery so a transition applies at the next call. */
  managedSkills(runId: string): () => Promise<readonly ManagedSkillSource[]> {
    return async () => {
      await this.queue;
      const binding = this.bindings.get(runId) ?? await this.bind(runId);
      return await this.service.managedSkills(binding.generation);
    };
  }

  /** Flush the durable transition before constructing the next agent tool surface. */
  async generation(runId: string): Promise<number> {
    await this.queue;
    return (this.bindings.get(runId) ?? await this.bind(runId)).generation;
  }

  async policyRevision(generation?: number): Promise<number | string> {
    return generation === undefined ? await this.service.policyRevision() : await this.service.policyRevisionForGeneration(generation);
  }

  pinnedGenerations(): ReadonlySet<number> {
    return new Set([...this.bindings.values()].map((binding) => binding.generation));
  }

  release(runId: string): void {
    this.bindings.delete(runId);
  }

  close(): void {
    this.unsubscribe();
  }

  private observe(event: ExtensionServiceEvent): void {
    if (event.type !== "operation") return;
    const operation = event.operation;
    if (operation.owner.kind !== "agent" || (operation.outcome !== "succeeded" && operation.outcome !== "rolled_back")) return;
    const to = operation.result?.generation;
    const current = this.bindings.get(operation.owner.runId);
    if (!current || typeof to !== "number" || to <= current.generation) return;
    const next: RunCapabilityBinding = {
      ...current,
      generation: to,
      transitions: [...current.transitions, { from: current.generation, to, at: new Date().toISOString(), operationIds: [operation.id], reason: "run_operation" as const }].slice(-64),
    };
    this.bindings.set(next.runId, next);
    this.queue = this.queue.then(() => this.write(next));
    // Observe rejection to avoid an unhandled promise, but retain it on queue:
    // future generation reads must fail closed rather than use an unpersisted pin.
    void this.queue.catch(() => undefined);
  }

  private async read(runId: string): Promise<RunCapabilityBinding | undefined> {
    try {
      const value = JSON.parse(await readFile(this.path(runId), "utf8")) as RunCapabilityBinding;
      return value.version === 1 && value.runId === runId && Number.isSafeInteger(value.generation) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(binding: RunCapabilityBinding): Promise<void> {
    this.bindings.set(binding.runId, binding);
    const path = this.path(binding.runId);
    await mkdir(join(path, ".."), { recursive: true });
    const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(binding), { flag: "wx" });
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  }

  private path(runId: string): string {
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(runId)) throw new Error("Invalid run id for a capability binding.");
    return join(this.stateDirectory, "extension-bindings", `${runId}.json`);
  }
}
