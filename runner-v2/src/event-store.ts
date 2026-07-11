import type { NewRunEvent, RunEvent } from "./contracts.js";

export interface EventStore {
  append(event: NewRunEvent): RunEvent;
  readRun(runId: string, afterSequence?: number): RunEvent[];
  listRunIds(): string[];
  close(): void;
}
