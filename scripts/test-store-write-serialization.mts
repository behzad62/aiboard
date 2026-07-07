/*
 * Client-store adapter-write serialization checks
 * (run: npx tsx scripts/test-store-write-serialization.mts)
 *
 * Regression pin for the File System Access adapter crash: concurrent benchmark
 * record saves used to reach flush()/saveBenchmarkRun at the same time, and two
 * overlapping createWritable() on the same file throw InvalidStateError
 * ("...state had changed since it was read from disk"). The store now routes
 * every adapter write through one serialization queue. These tests inject a mock
 * adapter that DETECTS overlap (increments an in-flight counter with a real async
 * delay) and fire many concurrent writes through the real store paths; a correct
 * store never overlaps two writes (violations === 0).
 *
 * Every store entry point is imported from ../lib/benchmark/store (which
 * re-exports the client-store persistence functions). Importing some from
 * ../lib/client/store directly and some from ../lib/benchmark/store in the same
 * tsx test loads two client-store module copies (ESM + CJS pre-parse), which
 * desyncs the module-level memory/adapter and makes the benchmark save path miss
 * the injected adapter.
 */
import {
  flush,
  saveBenchmarkRunBlob,
  saveBenchmarkTrace,
  __resetClientStoreForTests,
  __resetBenchmarkStoreForTests,
  __setAdapterForTests,
} from "../lib/benchmark/store";
import type { StorageAdapter } from "../lib/client/storage-adapter";
import type { BenchmarkModelCallTrace } from "../lib/benchmark/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Mock filesystem adapter that flags overlapping writes. Each write increments a
 * shared in-flight counter, records an overlap if the counter is already > 1
 * (i.e. another write is running), awaits a real async delay so overlap is
 * possible when writes are NOT serialized, then decrements. Mirrors the hazard
 * of File System Access createWritable(): a second write starting before the
 * first closes is the failure the store's serialization must prevent.
 */
class OverlapDetectingAdapter implements StorageAdapter {
  readonly kind = "filesystem" as const;
  inFlight = 0;
  violations = 0;
  completed = 0;
  order: string[] = [];

  private async guarded(label: string): Promise<void> {
    this.inFlight++;
    if (this.inFlight > 1) this.violations++;
    this.order.push(label);
    await delay(5);
    this.inFlight--;
    this.completed++;
  }

  // Implementing methods may declare fewer params than StorageAdapter (arity is
  // contravariant), so the ones that ignore their args omit them — avoids
  // unused-parameter lint noise while still satisfying the interface.
  async load(): Promise<string | null> {
    return null;
  }
  async save(): Promise<void> {
    await this.guarded("save");
  }
  async listDiscussionIds(): Promise<string[]> {
    return [];
  }
  async loadDiscussionFile(): Promise<string | null> {
    return null;
  }
  async saveDiscussionFile(discussionId: string): Promise<void> {
    await this.guarded(`saveDiscussionFile:${discussionId}`);
  }
  async deleteDiscussion(): Promise<void> {
    await this.guarded("deleteDiscussion");
  }
  async listBenchmarkRunIds(): Promise<string[]> {
    return [];
  }
  async loadBenchmarkRun(): Promise<string | null> {
    return null;
  }
  async saveBenchmarkRun(runId: string): Promise<void> {
    await this.guarded(`saveBenchmarkRun:${runId}`);
  }
  async deleteBenchmarkRun(): Promise<void> {
    await this.guarded("deleteBenchmarkRun");
  }
  label(): string {
    return "overlap-detecting-mock";
  }
}

// ── Test A: concurrent flush() + saveBenchmarkRunBlob through the mock adapter ──
// Exercises both serialized adapter-write sites directly (adapter.save via flush
// and adapter.saveBenchmarkRun via saveBenchmarkRunBlob). Primary regression pin.
{
  __resetClientStoreForTests({}); // sets memory, nulls adapter; blob-storage map stays null
  const adapter = new OverlapDetectingAdapter();
  __setAdapterForTests(adapter);

  const flushes = Array.from({ length: 12 }, () => flush());
  const runBlobs = Array.from({ length: 8 }, (_, i) =>
    saveBenchmarkRunBlob(`run-serialization-${i}`, JSON.stringify({ i }))
  );
  await Promise.all([...flushes, ...runBlobs]);

  check(
    "Test A: no overlapping adapter writes under concurrency",
    adapter.violations === 0,
    { violations: adapter.violations }
  );
  check(
    "Test A: every concurrent write completed",
    adapter.completed === 20 && adapter.inFlight === 0,
    { completed: adapter.completed, inFlight: adapter.inFlight }
  );

  __setAdapterForTests(null);
}

// ── Test B: realistic path — concurrent saveBenchmarkTrace() ───────────────────
// Drives the actual benchmark record-save function the GameIQ runner uses at
// concurrency 4. Each save ends with persistBenchmarkRunFile -> saveBenchmarkRunBlob
// AND flush(), both of which hit the mock adapter. 12 distinct traces, same runId.
{
  __resetBenchmarkStoreForTests(); // initializes an empty client store (memory set)
  const adapter = new OverlapDetectingAdapter();
  __setAdapterForTests(adapter);

  const runId = "run-trace-serialization";
  const now = "2026-07-04T00:00:00.000Z";
  const makeTrace = (i: number): BenchmarkModelCallTrace => ({
    id: `trace-serialization-${i}`,
    runId,
    modelId: "provider:model",
    providerId: "provider",
    startedAt: now,
    completedAt: now,
    retryHistory: [],
  });

  await Promise.all(
    Array.from({ length: 12 }, (_, i) => saveBenchmarkTrace(makeTrace(i)))
  );

  check(
    "Test B: concurrent saveBenchmarkTrace never overlaps adapter writes",
    adapter.violations === 0,
    { violations: adapter.violations }
  );
  check(
    "Test B: saveBenchmarkTrace drove adapter writes (path exercised)",
    adapter.completed > 0 && adapter.inFlight === 0,
    { completed: adapter.completed, inFlight: adapter.inFlight }
  );

  __setAdapterForTests(null);
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
