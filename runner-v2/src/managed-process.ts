import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ToolExecutionContext } from "./agent-contracts.js";
import { MANAGED_INPUT_HISTORY_LIMIT, MANAGED_INPUT_MAX_BYTES, MANAGED_INPUT_WRITE_TIMEOUT_MS, MANAGED_OUTPUT_WAIT_MAX_MS, ManagedProcessError, type ManagedInputWriteRecord, type ManagedInputWriteRequest, type ManagedInputWriteResult, type ManagedProcessObservation, type ManagedProcessRecord, type ManagedProcessSnapshot, type StartManagedProcessInput } from "./managed-process-contracts.js";
import { MANAGED_OUTPUT_FINAL_SPILL_BYTES, MANAGED_OUTPUT_LIVE_TAIL_BYTES, decodeOutputCursor, encodeOutputCursor, hasNewOutput, normalizeOutputRead, sliceOutput, streamsFor, type ManagedOutputCursorBinding, type ManagedOutputReadRequest, type ManagedOutputReadResult, type ManagedOutputSlice, type ManagedOutputStreamName } from "./managed-process-output.js";
import { historicalSnapshot, readHistoricalManagedProcessRecord } from "./managed-process-history.js";
import { MAX_MANAGED_OUTPUT_BYTES, managedIdentity, managedProcessId, managedSnapshot, parseManagedSessionRecord, persistManagedSessionRecord, readManagedRecordValue, type ManagedSessionRecord } from "./managed-process-record.js";
import type { ManagedProcessOwner, ManagedProcessRunRuntime } from "./managed-process-transport.js";
export * from "./managed-process-contracts.js";
export type { ManagedOutputReadRequest, ManagedOutputReadResult } from "./managed-process-output.js";
export { readHistoricalManagedProcessObservations } from "./managed-process-history.js";

export interface ManagedProcessServiceOptions {
  stateDirectory: string;
  /** Compatibility-only descriptor. Semantic platform selection belongs to ExecutionHost. */
  platform?: NodeJS.Platform;
  idFactory?: () => string;
  clock?: () => string;
  maxPollBytes?: number;
  startDeadlineMs?: number;
  stopDeadlineMs?: number;
  /** Legacy test configuration is no longer an execution route. */
  supervisorScriptPath?: string;
  runtime?: ManagedProcessRunRuntime;
}

/** Public durable metadata facade. Only an injected exact run transport can
 * launch, observe live evidence or clean resources. OS mechanics never enter here. */
export class ManagedProcessService {
  private readonly records = new Map<string, Readonly<ManagedSessionRecord>>();
  private readonly legacy = new Map<string, ManagedProcessRecord>();
  private readonly runtimes = new Map<string, ManagedProcessRunRuntime>();
  private readonly starts = new Set<Promise<unknown>>();
  private readonly reads = new Set<Promise<unknown>>();
  private readonly stops = new Map<string, Promise<ManagedProcessSnapshot>>();
  /** Per-process input order: one write settles (durably) before the next is admitted. */
  private readonly inputTails = new Map<string, Promise<unknown>>();
  private cursorKeyBytes?: Uint8Array;
  private readonly stateDirectory: string;
  private readonly idFactory: () => string;
  private readonly clock: () => string;
  private readonly maxPollBytes: number;
  private readonly startDeadlineMs: number;
  private readonly stopDeadlineMs: number;
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: ManagedProcessServiceOptions) {
    if (!isAbsolute(options.stateDirectory)) throw new ManagedProcessError("process_record_invalid", "Managed state requires an absolute directory.");
    this.stateDirectory = resolve(options.stateDirectory);
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxPollBytes = bound(options.maxPollBytes ?? MAX_MANAGED_OUTPUT_BYTES, 1, MAX_MANAGED_OUTPUT_BYTES);
    this.startDeadlineMs = bound(options.startDeadlineMs ?? 30_000, 1, 120_000);
    this.stopDeadlineMs = bound(options.stopDeadlineMs ?? AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS, 1, 120_000);
    mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.stateDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ManagedProcessError("process_record_invalid", "Managed state directory identity is invalid.");
    const entries = readdirSync(this.stateDirectory).filter(name => name.endsWith(".json"));
    if (entries.length > 4096) throw new ManagedProcessError("process_capacity_exceeded", "Managed record capacity exceeded.");
    for (const entry of entries) this.load(entry);
    if (options.runtime) this.registerRuntime(options.runtime);
  }

  /** Composition-only: bind an already-created execution graph, never create one here. */
  registerRuntime(runtime: ManagedProcessRunRuntime): () => void {
    this.assertOpen();
    if (!runtime.runId || typeof runtime.start !== "function" || typeof runtime.observe !== "function" || typeof runtime.stop !== "function") throw new ManagedProcessError("process_runtime_unavailable", "Managed execution runtime is invalid.");
    const prior = this.runtimes.get(runtime.runId);
    if (prior && prior !== runtime) throw new ManagedProcessError("process_runtime_unavailable", "A different managed runtime already owns this run.");
    this.runtimes.set(runtime.runId, runtime);
    return () => {
      if ([...this.records.values()].some(record => record.runId === runtime.runId && record.status !== "stopped")) throw new ManagedProcessError("process_cleanup_unverified", "Managed runtime cannot detach before exact cleanup is verified.");
      if (this.runtimes.get(runtime.runId) === runtime) this.runtimes.delete(runtime.runId);
    };
  }

  async start(input: StartManagedProcessInput, context: ToolExecutionContext, workspaceRoot = context.workspacePath): Promise<ManagedProcessSnapshot> {
    this.assertOpen(); const exact = exactCall(context, "process.start");
    if (!workspaceRoot || !isAbsolute(workspaceRoot) || !exact.workspacePath || resolve(workspaceRoot) !== resolve(exact.workspacePath)) throw new ManagedProcessError("invalid_arguments", "Managed start requires the actual absolute calling workspace.");
    const runtime = this.runtime(exact.runId);
    const processId = managedProcessId(this.idFactory());
    if (this.records.has(processId) || this.legacy.has(processId) || this.records.size + this.legacy.size >= 4096) throw new ManagedProcessError("process_capacity_exceeded", "Managed identity is already used or its record bound was reached.");
    const command = checkedCommand(input.command), args = checkedArguments(input.args ?? []), environment = checkedEnvironment(input.env ?? {});
    const cwd = resolve(workspaceRoot, input.cwd ?? "."), at = this.clock();
    const identity = managedIdentity({ processId, runId: exact.runId, sessionId: exact.sessionId, actor: exact.actor });
    if (input.interactive !== undefined && typeof input.interactive !== "boolean") throw new ManagedProcessError("invalid_arguments", "interactive must be a boolean.");
    const record: ManagedSessionRecord = { ...identity, recordKind: "runner.managed-process", schemaVersion: 2,
      command, args: [...args], cwd, environmentKeys: Object.keys(environment).sort(),
      configurationDigest: createHash("sha256").update(JSON.stringify({ command, args, cwd, environment })).digest("hex"),
      streamingSessionId: `managed-stream-${processId}`, launchId: `managed-launch-${processId}`,
      pid: 0, status: "exited_unknown", exitCode: null, signal: null, startedAt: at, updatedAt: at, stdout: "", stderr: "",
      ...(input.interactive ? { input: { interactive: true, inputClosed: false, writes: [] } } : {}) };
    this.save(record);
    const work = (async () => {
      try {
        const snapshot = await runtime.start(Object.freeze({ identity, context: exact, command, args, cwd, environment,
          startTimeoutMs: this.startDeadlineMs, cleanupTimeoutMs: this.stopDeadlineMs, maxOutputBytes: this.maxPollBytes,
          onTerminal: (observation: Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>) => {
            const current = this.records.get(processId);
            if (current && current.status !== "stopped") this.save({ ...current, ...observation, status: "exited_unknown", updatedAt: this.clock() });
          } }));
        this.saveSnapshot(processId, snapshot);
        if (exact.signal?.aborted || this.closing) throw cancelled("start");
        return managedSnapshot(this.records.get(processId)!);
      } catch (primary) {
        try { await this.stopExact(this.records.get(processId)!, runtime); }
        catch (cleanup) { throw new AggregateError([primary, cleanup], "Managed failed start retains unverified exact cleanup."); }
        throw primary;
      }
    })();
    this.starts.add(work);
    try { return await work; } finally { this.starts.delete(work); }
  }

  async poll(processId: string, context: ToolExecutionContext): Promise<ManagedProcessSnapshot> {
    const exact = exactCall(context, "process.poll"); const record = this.owned(processId, exact);
    if (!("schemaVersion" in record)) return historicalSnapshot(record, this.maxPollBytes);
    const read = this.runtime(record.runId).observe(record, exact, this.maxPollBytes).then(snapshot => {
      if (exact.signal?.aborted) throw cancelled("poll");
      return this.saveSnapshot(processId, snapshot);
    });
    this.reads.add(read); void read.finally(() => this.reads.delete(read)).catch(() => undefined);
    return await cancelRead(read, exact.signal);
  }

  /**
   * N1: acknowledged stdin delivery. A writeId is idempotent within this process's bounded journal:
   * the same payload returns the settled outcome without sending twice; a changed payload conflicts.
   * Payload bytes are never persisted or logged (digest and length only).
   */
  async writeInput(processId: string, request: ManagedInputWriteRequest, context: ToolExecutionContext): Promise<ManagedInputWriteResult> {
    this.assertOpen(); const exact = exactCall(context, "process.write_stdin"); const record = this.owned(processId, exact);
    if (!("schemaVersion" in record)) throw new ManagedProcessError("process_input_unavailable", "Historical process records are read-only.");
    const writeId = checkedWriteId(request.writeId);
    if (request.data !== undefined && typeof request.data !== "string") throw new ManagedProcessError("invalid_arguments", "data must be a string.");
    if (request.appendNewline !== undefined && typeof request.appendNewline !== "boolean") throw new ManagedProcessError("invalid_arguments", "appendNewline must be a boolean.");
    if (request.closeInput !== undefined && typeof request.closeInput !== "boolean") throw new ManagedProcessError("invalid_arguments", "closeInput must be a boolean.");
    const text = (request.data ?? "") + (request.appendNewline ? "\n" : "");
    if (text.includes("\0")) throw new ManagedProcessError("invalid_arguments", "Input cannot contain NUL characters.");
    const bytes = new Uint8Array(Buffer.from(text, "utf8")), closeInput = request.closeInput === true;
    if (bytes.byteLength > MANAGED_INPUT_MAX_BYTES) throw new ManagedProcessError("invalid_arguments", `Input exceeds ${MANAGED_INPUT_MAX_BYTES} bytes.`);
    if (!bytes.byteLength && !closeInput) throw new ManagedProcessError("invalid_arguments", "Provide data, appendNewline or closeInput.");
    const digest = createHash("sha256").update(bytes).update(closeInput ? "\u0001eof" : "\u0000").digest("hex");
    const runtime = this.runtime(record.runId);
    if (!runtime.writeInput) throw new ManagedProcessError("process_input_unsupported", "This execution environment cannot deliver process input; nothing was sent.");
    const previous = this.inputTails.get(record.processId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async (): Promise<ManagedInputWriteResult> => {
      const current = this.records.get(record.processId)!;
      const input = current.input;
      if (!input?.interactive) throw new ManagedProcessError("process_input_not_enabled", "Interactive input is off for this process; start it with interactive: true to send stdin.");
      const prior = input.writes.find(entry => entry.writeId === writeId);
      if (prior) {
        if (prior.digest !== digest) throw new ManagedProcessError("process_input_conflict", "This writeId was already used with different input; choose a new writeId.");
        return inputResult(current.processId, prior, input.inputClosed, true);
      }
      if (input.inputClosed) throw new ManagedProcessError("process_input_closed", "Input was already closed (EOF) for this process.");
      if (exact.signal?.aborted) throw cancelled("input");
      const pending: ManagedInputWriteRecord = { writeId, digest, byteLength: bytes.byteLength, closeInput, status: "pending", requestedAt: this.clock() };
      this.save({ ...current, input: { ...input, writes: [...input.writes, pending].slice(-MANAGED_INPUT_HISTORY_LIMIT) } });
      let settled: ManagedInputWriteRecord, inputClosed = false;
      try {
        inputClosed = (await runtime.writeInput!(current, exact, { bytes, closeInput, timeoutMs: MANAGED_INPUT_WRITE_TIMEOUT_MS })).inputClosed;
        settled = { ...pending, status: "acknowledged", settledAt: this.clock() };
      } catch (error) {
        const code = error instanceof ManagedProcessError ? error.code : "process_input_outcome_unknown";
        const certain = ["process_input_rejected", "process_input_unavailable", "process_not_owned", "process_cancelled"].includes(code);
        settled = { ...pending, status: certain ? "rejected" : "outcome_unknown", settledAt: this.clock(), errorCode: code };
        // Uncertain delivery may have closed input; refuse further writes rather than guess.
        inputClosed = !certain && closeInput;
      }
      const latest = this.records.get(record.processId)!;
      const latestInput = latest.input!;
      this.save({ ...latest, input: { ...latestInput, inputClosed: latestInput.inputClosed || inputClosed,
        writes: latestInput.writes.map(entry => entry.writeId === writeId ? settled : entry) } });
      return inputResult(record.processId, settled, latestInput.inputClosed || inputClosed, false);
    });
    this.inputTails.set(record.processId, work);
    try { return await work; } finally { if (this.inputTails.get(record.processId) === work) this.inputTails.delete(record.processId); }
  }

  /** N2: caller-held cursor, tail or explicit-range reads of exact bounded output evidence. */
  async readOutput(processId: string, request: ManagedOutputReadRequest, context: ToolExecutionContext): Promise<ManagedOutputReadResult> {
    const exact = exactCall(context, "process.read_output"); const record = this.owned(processId, exact);
    if (!("schemaVersion" in record)) throw new ManagedProcessError("process_output_history_unsupported", "This historical record keeps only a bounded legacy tail without offsets; use process.poll.");
    const normalized = normalizeOutputRead(request);
    const runtime = this.runtime(record.runId);
    if (!runtime.readOutput) throw new ManagedProcessError("process_output_unsupported", "This execution environment cannot provide offset-addressed output.");
    const binding: ManagedOutputCursorBinding = { processId: record.processId, launchId: record.launchId, generation: `${record.configurationDigest.slice(0, 16)}:${record.startedAt}` };
    const key = this.cursorKey();
    const offsets: Record<ManagedOutputStreamName, number> = normalized.cursor !== undefined ? decodeOutputCursor(key, binding, normalized.cursor) : { stdout: 0, stderr: 0 };
    const selected = normalized.range ? [normalized.range.stream] : streamsFor(normalized.stream);
    const waitMs = Math.min(normalized.waitMs, MANAGED_OUTPUT_WAIT_MAX_MS);
    const read = runtime.readOutput(record, exact, { waitMs, satisfied: evidence => hasNewOutput(evidence, offsets, normalized.range ? normalized.range.stream : normalized.stream) })
      .then(async evidence => {
        if (exact.signal?.aborted) throw cancelled("read");
        this.saveSnapshot(record.processId, { ...evidence.snapshot, stdout: record.stdout, stderr: record.stderr });
        const slices: ManagedOutputSlice[] = [];
        const next = { ...offsets };
        for (const stream of selected) {
          const total = evidence.streams.find(entry => entry.stream === stream)?.totalBytes ?? 0;
          const start = normalized.range ? normalized.range.startOffset : normalized.tailBytes !== undefined ? Math.max(0, total - normalized.tailBytes) : offsets[stream];
          const slice = await sliceOutput({ evidence, stream, startOffset: start, maxBytes: normalized.maxBytes, readSpill: runtime.readSpill?.bind(runtime) });
          slices.push(slice);
          if (!normalized.range) next[stream] = slice.endOffset;
        }
        const terminal = evidence.snapshot.status !== "running";
        return Object.freeze({
          processId: record.processId, status: evidence.snapshot.status, exitCode: evidence.snapshot.exitCode, signal: evidence.snapshot.signal,
          source: evidence.source, ...(evidence.waited ? { waited: evidence.waited } : {}), slices: Object.freeze(slices),
          cursor: encodeOutputCursor(key, binding, next),
          complete: terminal && evidence.source === "final" && !normalized.range && slices.every(slice => !slice.hasMore && !slice.gap && slice.lossyBytes === 0),
          limits: Object.freeze({ maxBytesPerStream: normalized.maxBytes, liveTailBytesPerStream: MANAGED_OUTPUT_LIVE_TAIL_BYTES, finalSpillBytesPerStream: MANAGED_OUTPUT_FINAL_SPILL_BYTES }),
        });
      });
    this.reads.add(read); void read.finally(() => this.reads.delete(read)).catch(() => undefined);
    return await cancelRead(read, exact.signal);
  }

  async list(context: ToolExecutionContext): Promise<ManagedProcessSnapshot[]> {
    const exact = exactCall(context, "process.list");
    const records = [...this.records.values()].filter(record => sameOwner(record, exact));
    if (records.length > 128) throw new ManagedProcessError("process_capacity_exceeded", "Managed observation batch exceeds its bound.");
    const old = [...this.legacy.values()].filter(record => sameOwner(record, exact)).map(record => historicalSnapshot(record, this.maxPollBytes));
    if (!records.length) return old;
    const runtime = this.runtime(exact.runId);
    const read = (runtime.observeMany ? runtime.observeMany(records, exact, this.maxPollBytes) : records.length === 1
      ? runtime.observe(records[0]!, exact, this.maxPollBytes).then(value => [value])
      : Promise.reject(new ManagedProcessError("process_runtime_unavailable", "The managed runtime lacks single-call batch observation authority.")))
      .then(snapshots => {
        if (exact.signal?.aborted) throw cancelled("poll");
        if (snapshots.length !== records.length) throw new ManagedProcessError("process_record_invalid", "Managed batch returned different identities.");
        return snapshots.map((snapshot, index) => this.saveSnapshot(records[index]!.processId, snapshot));
      });
    this.reads.add(read); void read.finally(() => this.reads.delete(read)).catch(() => undefined);
    return [...await cancelRead(read, exact.signal), ...old];
  }

  /** Trusted control-plane observation, never a model-facing substitute for poll authority. */
  async listRun(runId: string): Promise<ManagedProcessObservation[]> {
    const observations: ManagedProcessObservation[] = [...this.legacy.values()].filter(record => record.runId === runId)
      .map(record => ({ ...historicalSnapshot(record, this.maxPollBytes), runId: record.runId, sessionId: record.sessionId, actor: { ...record.actor }, command: record.command, args: [...record.args], cwd: record.cwd, environmentKeys: [...record.environmentKeys] }));
    for (const record of this.records.values()) {
      if (record.runId !== runId) continue;
      const runtime = this.runtimes.get(runId);
      const snapshot = runtime ? await runtime.observe(record, undefined, this.maxPollBytes) : managedSnapshot(record);
      observations.push({ ...snapshot, runId, sessionId: record.sessionId, actor: { ...record.actor }, command: record.command, args: [...record.args], cwd: record.cwd, environmentKeys: [...record.environmentKeys] });
    }
    return observations;
  }

  async signal(processId: string, signal: NodeJS.Signals, context: ToolExecutionContext): Promise<ManagedProcessSnapshot> {
    const exact = exactCall(context, "process.signal"); const record = this.owned(processId, exact);
    if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(signal)) throw new ManagedProcessError("invalid_arguments", "Unsupported managed signal.");
    if (!("schemaVersion" in record)) return historicalSnapshot(record, this.maxPollBytes);
    // The transport commits exact stop authority before any cancellable wait.
    // Do not race its acknowledgement against the caller signal afterwards.
    const stop = this.runtime(record.runId).stop(record, exact, signal, this.stopDeadlineMs).then(snapshot => this.saveSnapshot(processId, snapshot));
    this.stops.set(processId, stop);
    try { return await stop; } finally { if (this.stops.get(processId) === stop) this.stops.delete(processId); }
  }

  async stopRun(runId: string): Promise<void> {
    await this.stopMatching(record => record.runId === runId);
  }

  /** T6b repair (N-6): stop exactly the listed processes; the run-wide stopRun is not attempt-scoped. */
  async stopProcesses(processIds: readonly string[]): Promise<void> {
    const targets = new Set(processIds);
    await this.stopMatching(record => targets.has(record.processId));
  }

  async closeAgent(owner: ManagedProcessOwner): Promise<void> {
    await this.stopMatching(record => sameOwner(record, owner));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    const attempt = (async () => {
      // A late start cannot disappear merely because the owner requested close.
      await Promise.allSettled([...this.starts]);
      await this.stopMatching(() => true);
      await Promise.allSettled([...this.reads]);
      this.closed = true; this.runtimes.clear();
    })();
    this.closePromise = attempt;
    try { await attempt; } finally { if (this.closePromise === attempt) this.closePromise = undefined; }
  }

  private async stopMatching(predicate: (record: Readonly<ManagedSessionRecord>) => boolean): Promise<void> {
    const failures: unknown[] = [];
    for (const record of this.records.values()) {
      if (!predicate(record)) continue;
      const runtime = this.runtimes.get(record.runId);
      if (!runtime && record.status === "stopped") continue; // persisted terminal history has no live operation
      try { await this.stopExact(record, runtime ?? this.runtime(record.runId)); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Managed process cleanup remains unverified.");
  }
  private async stopExact(record: Readonly<ManagedSessionRecord>, runtime: ManagedProcessRunRuntime): Promise<ManagedProcessSnapshot> {
    const existing = this.stops.get(record.processId); if (existing) return await existing;
    const work = (async () => {
      if (record.status === "stopped") {
        const observed = await runtime.observe(record, undefined, this.maxPollBytes);
        if (observed.status === "stopped") return this.saveSnapshot(record.processId, observed);
      }
      const snapshot = await runtime.stop(record, undefined, "SIGTERM", this.stopDeadlineMs);
      if (snapshot.status !== "stopped") throw new ManagedProcessError("process_cleanup_unverified", "Shared managed cleanup did not prove release.");
      return this.saveSnapshot(record.processId, snapshot);
    })();
    this.stops.set(record.processId, work);
    try { return await work; } finally { if (this.stops.get(record.processId) === work) this.stops.delete(record.processId); }
  }

  private load(entry: string): void {
    const value = readManagedRecordValue(join(this.stateDirectory, entry));
    if (value && typeof value === "object" && ("schemaVersion" in value || "recordKind" in value)) {
      const record = parseManagedSessionRecord(value, entry.slice(0, -5)); this.records.set(record.processId, record);
      // A write that was pending at a crash may or may not have been delivered. Record that honestly; never replay it.
      if (record.input?.writes.some(write => write.status === "pending")) this.save({ ...record, input: { ...record.input,
        writes: record.input.writes.map(write => write.status === "pending" ? { ...write, status: "outcome_unknown" as const, settledAt: this.clock(), errorCode: "process_input_interrupted" } : write) } });
      return;
    }
    const legacy = readHistoricalManagedProcessRecord(join(this.stateDirectory, entry));
    if (!legacy || legacy.processId !== entry.slice(0, -5)) throw new ManagedProcessError("process_record_invalid", "Managed historical record identity is invalid.");
    if (legacy.status !== "stopped") throw new ManagedProcessError("process_active_schema_unsupported", "Legacy active managed record requires exact migration/recovery before execution; PID-only adoption is refused.");
    this.legacy.set(legacy.processId, legacy);
  }
  private owned(processId: string, owner: ManagedProcessOwner): Readonly<ManagedSessionRecord> | ManagedProcessRecord {
    const id = managedProcessId(processId), record = this.records.get(id) ?? this.legacy.get(id);
    if (!record) throw new ManagedProcessError("process_not_found", "Managed process was not found.");
    if (!sameOwner(record, owner)) throw new ManagedProcessError("process_not_owned", "Managed process belongs to another exact owner.");
    return record;
  }

  private runtime(runId: string): ManagedProcessRunRuntime {
    const runtime = this.runtimes.get(runId);
    if (!runtime) throw new ManagedProcessError("process_runtime_unavailable", "Managed processes require the injected run-owned execution runtime.");
    return runtime;
  }
  private save(record: ManagedSessionRecord): Readonly<ManagedSessionRecord> {
    const current = persistManagedSessionRecord(this.stateDirectory, record);
    this.records.set(current.processId, current); return current;
  }
  private saveSnapshot(processId: string, snapshot: ManagedProcessSnapshot): ManagedProcessSnapshot {
    const previous = this.records.get(processId);
    if (!previous || snapshot.processId !== processId) throw new ManagedProcessError("process_record_invalid", "Managed runtime returned a different process identity.");
    const current = this.save({ ...previous, ...managedSnapshot(snapshot), stdout: boundedTail(snapshot.stdout, this.maxPollBytes), stderr: boundedTail(snapshot.stderr, this.maxPollBytes) });
    return managedSnapshot(current);
  }
  private cursorKey(): Uint8Array {
    if (this.cursorKeyBytes) return this.cursorKeyBytes;
    const path = join(this.stateDirectory, "output-cursor.key");
    try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== 32) throw new ManagedProcessError("process_record_invalid", "Output cursor key identity is invalid.");
    this.cursorKeyBytes = new Uint8Array(readFileSync(path));
    return this.cursorKeyBytes;
  }
  private assertOpen(): void {
    if (this.closing || this.closed) throw new ManagedProcessError("process_service_closed", "Managed process service is closing or closed.");
  }
}

function sameOwner(a: ManagedProcessOwner, b: ManagedProcessOwner): boolean {
  return a.runId === b.runId && a.sessionId === b.sessionId && a.actor.role === b.actor.role && a.actor.id === b.actor.id;
}
function checkedWriteId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new ManagedProcessError("invalid_arguments", "writeId must be 1-128 characters of [A-Za-z0-9._:-].");
  return value;
}
function inputResult(processId: string, write: ManagedInputWriteRecord, inputClosed: boolean, deduplicated: boolean): ManagedInputWriteResult {
  const status = write.status === "pending" ? "outcome_unknown" : write.status;
  return Object.freeze({ processId, writeId: write.writeId, status, byteLength: write.byteLength, inputClosed, deduplicated,
    ...(write.errorCode ? { errorCode: write.errorCode } : {}),
    ...(status === "outcome_unknown" ? { message: "Delivery was not acknowledged; the process may or may not have received this input. It will not be resent automatically." }
      : status === "rejected" ? { message: "Input was refused before delivery; nothing was sent." } : {}) });
}
function bound(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ManagedProcessError("invalid_arguments", "Managed process bound is invalid.");
  return value;
}
function exactCall(context: ToolExecutionContext, toolName: string): Readonly<ToolExecutionContext> {
  if (!context || !context.runId || !context.sessionId || !context.actor?.id || !["architect", "worker", "subagent", "verifier", "remote", "local_mcp"].includes(context.actor.role) ||
      !context.callId || context.toolName !== toolName || !context.executionGrant || !context.workspacePath || !isAbsolute(context.workspacePath)) {
    throw new ManagedProcessError("process_authority_required", "Managed invocation requires its exact original ToolBroker grant and identity.");
  }
  if (context.signal?.aborted) throw cancelled(toolName);
  return Object.freeze({ ...context, actor: Object.freeze({ ...context.actor }) });
}
function cancelled(operation: string): ManagedProcessError {
  return new ManagedProcessError("process_cancelled", `Managed ${operation} was cancelled.`);
}
function cancelRead<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) { void promise.catch(() => undefined); return Promise.reject(cancelled("poll")); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled("poll")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function checkedCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 8192) throw new ManagedProcessError("invalid_arguments", "Managed executable is invalid.");
  return value;
}
function checkedArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 1024 || Object.keys(value).length !== value.length || value.some(arg => typeof arg !== "string" || arg.includes("\0")) || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new ManagedProcessError("invalid_arguments", "Managed arguments are invalid or exceed their bound.");
  return Object.freeze([...value]);
}
function checkedEnvironment(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new ManagedProcessError("invalid_arguments", "Managed environment must be a plain record.");
  const names = Object.keys(value); const result: Record<string, string> = Object.create(null);
  if (names.length > 256) throw new ManagedProcessError("invalid_arguments", "Managed environment exceeds its bound.");
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || !descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.includes("\0") || Buffer.byteLength(descriptor.value) > 32768) throw new ManagedProcessError("invalid_arguments", "Managed environment entry is invalid.");
    result[name] = descriptor.value;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new ManagedProcessError("invalid_arguments", "Managed environment exceeds its bound.");
  return Object.freeze(result);
}
function boundedTail(value: string, maximum: number): string {
  if (typeof value !== "string") throw new ManagedProcessError("process_record_invalid", "Managed output is not text.");
  const bytes = Buffer.from(value); let start = Math.max(0, bytes.length - maximum);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}
