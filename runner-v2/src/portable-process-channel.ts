import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
  type BackpressuredOutputAcknowledgement,
  type BackpressuredOutputMetadata,
  type BackpressuredOutputSettlement,
  type InteractiveProcessChannel,
  type InteractiveProcessWrite,
} from "./interactive-process-channel.js";
import type { ProcessBackendBinding, ProcessEffectFence } from "./process-backend.js";
import {
  PortableOutputRetirementBlockedError,
  readPortableOutputSnapshot,
  validatePortableAcknowledgements,
  type PortableFenceSnapshotOutcome,
  type PortableOutputSnapshot,
} from "./portable-process-protocol.mjs";
import { isOwnedFenceLockContention } from "./owned-fence-lock.mjs";

export interface PortableChannelAuthority {
  readonly directory: string;
  readonly nonce: string;
  readonly fence: ProcessEffectFence;
  /** Exact durable supervisor PID; authenticates its atomic publication names. */
  readonly supervisorPid?: number;
  reattest(): "live" | "exited";
  /** Read-side exact-fence check; unlike a writer claim it must not contend with output retirement. */
  reattestFence?(): void;
  /** Observation only; never authorizes a protected effect. Must settle after cancellation. */
  reattestObservation?(signal: AbortSignal): Promise<"live" | "exited">;
  effect<T>(kind: "attach" | "write" | "close" | "signal" | "output_ack" | "ack_consume", effect: () => T): Promise<T>;
  snapshot<T>(read: () => T): PortableFenceSnapshotOutcome<T>;
}

export interface PortableProcessChannelProviderOptions {
  readonly clock?: () => number;
  readonly replayCapacityChunks: number;
  readonly replayCapacityBytes: number;
  readonly pollIntervalMs: number;
  authority(binding: ProcessBackendBinding, fence: ProcessEffectFence): PortableChannelAuthority;
}

export function createPortableProcessChannelProvider(options: PortableProcessChannelProviderOptions) {
  const replayCapacityChunks = positive(options.replayCapacityChunks);
  const replayCapacityBytes = positive(options.replayCapacityBytes);
  const pollIntervalMs = positive(options.pollIntervalMs);
  const acquire = async (binding: ProcessBackendBinding, fence: ProcessEffectFence) => {
    const channel = new PortableProcessChannel(options.authority(binding, fence), pollIntervalMs, options.clock ?? Date.now);
    await channel.validateForAttach();
    return channel;
  };
  return Object.freeze({
    version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
    replayCapacityChunks,
    replayCapacityBytes,
    acquire,
    async reattach(binding: ProcessBackendBinding, fence: ProcessEffectFence) {
      const channel = await acquire(binding, fence);
      const recoveryOutput = channel.recoveryOutputObservation();
      return {
        version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
        binding,
        channel,
        ...recoveryOutput,
        replayCapacityChunks,
        replayCapacityBytes,
        nextSequence: channel.nextWriteSequence(),
        inputClosed: channel.isInputClosed(),
      };
    },
  });
}

class PortableProcessChannel implements InteractiveProcessChannel {
  private readonly channelDirectory: string;
  private readonly inputDirectory: string;
  private readonly ackDirectory: string;
  private nextCommand = 1;
  private nextWrite = 1;
  private inputClosed = false;
  private detached = false;
  private outputTimer?: ReturnType<typeof setInterval>;
  private terminalTimer?: ReturnType<typeof setTimeout>;
  private terminalTask?: Promise<void>;
  private terminalInspection?: AbortController;
  private readonly terminalWaiters = new Set<() => void>();
  private outputSink?: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>;
  private outputTail = Promise.resolve();
  private readonly deliveredOutput = new Set<string>();
  private readonly terminalSinks = new Set<(result: unknown) => void>();
  private channelFailure?: Error;
  private stateNeedsPersist = false;
  private outputTasks = 0;
  private outputSettlementDeadlineAt?: number;
  private outputSettlement?: Promise<BackpressuredOutputSettlement>;
  private liveStoppedObserved = false;

  constructor(private readonly authority: PortableChannelAuthority, private readonly pollIntervalMs: number, private readonly clock: () => number) {
    this.channelDirectory = join(authority.directory, "channel");
    this.inputDirectory = join(this.channelDirectory, "input");
    this.ackDirectory = join(this.channelDirectory, "ack");
    this.restoreInputState();
  }

  async write(input: InteractiveProcessWrite, payload: Uint8Array): Promise<unknown> {
    this.assertAttached();
    this.reattest(true);
    if (this.inputClosed) throw new Error("Portable channel input is closed.");
    if (input.sequence !== this.nextWrite) throw new Error("Portable channel write sequence is stale or out of order.");
    const owned = new Uint8Array(payload);
    if (owned.byteLength !== input.byteLength || createHash("sha256").update(owned).digest("hex") !== input.digest)
      throw new Error("Portable channel write metadata does not match its payload.");
    const commandSequence = this.nextCommand;
    await this.command(commandSequence, {
      type: "write",
      byteLength: owned.byteLength,
      digest: input.digest,
      bytes: Buffer.from(owned).toString("base64"),
    }, input.timeoutMs, { nextCommand: commandSequence + 1, nextWrite: this.nextWrite + 1, inputClosed: this.inputClosed });
    return { acknowledged: true, sequence: input.sequence };
  }

  async closeInput(): Promise<unknown> {
    this.assertAttached();
    this.reattest(true);
    if (this.inputClosed) return false;
    const sequence = this.nextCommand;
    await this.command(sequence, { type: "close_input" }, 5_000, { nextCommand: sequence + 1, nextWrite: this.nextWrite, inputClosed: true });
    return true;
  }

  subscribePrivateOutput(sink: (bytes: Uint8Array) => void): () => void {
    return this.subscribeBackpressuredOutput(async (metadata, bytes) => {
      sink(new Uint8Array(bytes));
      return metadata;
    });
  }

  subscribeBackpressuredOutput(
    sink: (metadata: BackpressuredOutputMetadata, ownedBytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>,
  ): () => void {
    this.assertAttached();
    if (this.outputSink) throw new Error("Portable channel output already has a consumer.");
    this.outputSink = sink;
    this.outputTimer = setInterval(() => this.scheduleOutput(), this.pollIntervalMs);
    this.outputTimer.unref?.();
    this.scheduleOutput();
    return () => {
      this.outputSink = undefined;
      if (this.outputTimer) clearInterval(this.outputTimer);
      this.outputTimer = undefined;
    };
  }

  async gracefulStop(): Promise<unknown> {
    this.assertAttached();
    this.reattest(true);
    const sequence = this.nextCommand;
    await this.command(sequence, { type: "graceful_stop" }, 5_000, { nextCommand: sequence + 1, nextWrite: this.nextWrite, inputClosed: this.inputClosed });
    return { acknowledged: true };
  }

  async waitForTerminal(): Promise<unknown> {
    if (this.detached) return { state: "outcome_unknown" };
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const cancelled = () => { unsubscribe(); resolve({ state: "outcome_unknown" }); };
      this.terminalWaiters.add(cancelled);
      unsubscribe = this.observeTerminal((result) => {
        this.terminalWaiters.delete(cancelled);
        unsubscribe();
        resolve(result);
      });
      this.terminalTimer?.ref?.();
    });
  }

  observeTerminal(sink: (result: unknown) => void): () => void {
    this.assertAttached();
    const subscription = (result: unknown) => sink(result);
    this.terminalSinks.add(subscription);
    this.scheduleTerminal();
    return () => {
      this.terminalSinks.delete(subscription);
      if (this.terminalSinks.size === 0) this.cancelTerminalInspection();
    };
  }

  private cancelTerminalInspection(): void {
    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.terminalTimer = undefined;
    this.terminalInspection?.abort();
  }

  private scheduleTerminal(): void {
    if (this.detached || this.terminalSinks.size === 0 || this.terminalTask || this.terminalTimer) return;
    this.terminalTimer = setTimeout(() => {
      this.terminalTimer = undefined;
      const controller = new AbortController();
      this.terminalInspection = controller;
      this.terminalTask = this.terminal(controller.signal).then((result) => {
        if (!result || this.detached || controller.signal.aborted) return;
        this.deliverTerminal(result);
      }).finally(() => {
        this.terminalTask = undefined;
        this.terminalInspection = undefined;
        this.scheduleTerminal();
      });
    }, this.pollIntervalMs);
    if (this.terminalWaiters.size === 0) this.terminalTimer.unref?.();
  }

  private deliverTerminal(result: unknown): void {
    // Reentrant additions/replacements belong to a fresh observation. Retire
    // each exact registration only if it is still live immediately at delivery.
    const listeners = [...this.terminalSinks];
    for (const listener of listeners) {
      if (this.detached || !this.terminalSinks.delete(listener)) continue;
      listener(result);
    }
  }

  async detach(): Promise<unknown> {
    if (this.detached) return false;
    this.detached = true;
    this.outputSink = undefined;
    if (this.outputTimer) clearInterval(this.outputTimer);
    this.cancelTerminalInspection();
    this.outputTimer = undefined;
    this.terminalTimer = undefined;
    this.terminalSinks.clear();
    for (const waiter of this.terminalWaiters) waiter();
    this.terminalWaiters.clear();
    await this.terminalTask;
    await this.outputTail.catch(() => undefined);
    return true;
  }

  settleBackpressuredOutput(deadlineAt: number): Promise<BackpressuredOutputSettlement> {
    if (this.outputSettlement) return this.outputSettlement;
    if (!Number.isSafeInteger(deadlineAt) || this.detached || !this.outputSink) {
      return Promise.resolve({ status: "blocked", reason: "outcome_unknown" });
    }
    this.outputSettlementDeadlineAt = deadlineAt;
    if (this.outputTimer) clearInterval(this.outputTimer);
    this.outputTimer = undefined;
    // outputTail remains owned even if the caller's deadline wins. No detach,
    // replacement subscription, or repeated ACK is issued by this observer.
    this.outputSettlement = this.observeOutputSettlement(deadlineAt);
    return this.outputSettlement;
  }

  private async observeOutputSettlement(deadlineAt: number): Promise<BackpressuredOutputSettlement> {
    const wallDeadline = Date.now() + Math.max(this.pollIntervalMs, deadlineAt - this.clock());
    let coordinationBlocked = false;
    for (;;) {
      if (this.clock() >= deadlineAt || Date.now() >= wallDeadline) {
        return { status: "blocked", reason: coordinationBlocked ? "coordination_unavailable" : "deadline" };
      }
      const snapshot = this.authority.snapshot(() => {
        this.assertOutputDeadline();
        const state = JSON.parse(readFileSync(join(this.authority.directory, "state.json"), "utf8"));
        if (state.nonce !== this.authority.nonce || !["running", "stopping", "stopped"].includes(state.status)) {
          throw new Error("Portable output terminal authority is unavailable.");
        }
        return { terminal: state.status === "stopped", output: this.readOutputSnapshot() };
      });
      if (snapshot.status === "stale") return { status: "blocked", reason: "stale_fence" };
      if (snapshot.status === "unavailable" && snapshot.cause === "coordination" && isRetryablePortableCoordination(snapshot.error)) {
        coordinationBlocked = true;
        await delay(this.settlementRetryDelayMs(deadlineAt, wallDeadline));
        continue;
      }
      if (snapshot.status === "unavailable") return { status: "blocked", reason: "outcome_unknown" };
      if (snapshot.status !== "applied") return { status: "blocked", reason: "output_unaccounted" };
      if (this.channelFailure) return { status: "blocked", reason: this.channelFailure instanceof PortableOutputSettlementFailure ? this.channelFailure.reason : "outcome_unknown" };
      const { terminal, output } = snapshot.value;
      if (terminal && output.output.length === 0 && output.acknowledgements.length === 0 && this.outputTasks === 0) {
        if (this.clock() >= deadlineAt || Date.now() >= wallDeadline) {
          return { status: "blocked", reason: coordinationBlocked ? "coordination_unavailable" : "deadline" };
        }
        try { this.reattest(false); }
        catch (error) {
          if (isRetryablePortableCoordination(error)) {
            coordinationBlocked = true;
            await delay(this.settlementRetryDelayMs(deadlineAt, wallDeadline));
            continue;
          }
          return { status: "blocked", reason: "stale_fence" };
        }
        if (this.clock() >= deadlineAt || Date.now() >= wallDeadline) {
          return { status: "blocked", reason: coordinationBlocked ? "coordination_unavailable" : "deadline" };
        }
        return { status: "settled" };
      }
      coordinationBlocked = false;
      if (this.outputTasks === 0 && output.output.some((entry) =>
        !this.deliveredOutput.has(entry.name) || !this.hasExactDurableOutputAcknowledgement(entry.name, entry.metadata)
      )) this.scheduleOutput();
      await delay(this.settlementRetryDelayMs(deadlineAt, wallDeadline));
    }
  }

  private settlementRetryDelayMs(deadlineAt: number, wallDeadline: number): number {
    return Math.min(this.pollIntervalMs, Math.max(0, deadlineAt - this.clock()), Math.max(0, wallDeadline - Date.now()));
  }

  private assertOutputDeadline(): void {
    if (this.outputSettlementDeadlineAt !== undefined && this.clock() >= this.outputSettlementDeadlineAt) {
      throw new PortableOutputSettlementFailure("deadline");
    }
  }

  retainedWindow(): readonly BackpressuredOutputMetadata[] {
    return this.outputFiles().map((entry) => entry.metadata);
  }
  recoveryOutputObservation() {
    // One fenced snapshot validates actual retained payloads and rejects an
    // incomplete retirement before projecting this nonce-free private proof.
    const snapshot = this.requireSnapshot(this.outputSnapshot());
    return {
      retainedWindow: snapshot.output.map((entry) => entry.metadata),
      cleanupBootstrap: {
        version: 1 as const,
        consumed: { stdout: snapshot.checkpoint.stdout, stderr: snapshot.checkpoint.stderr },
        pendingAcknowledgements: snapshot.acknowledgements.length,
      },
    };
  }
  nextWriteSequence(): number { return this.nextWrite; }
  isInputClosed(): boolean { return this.inputClosed; }
  async validateForAttach(): Promise<void> {
    this.reattest(false);
    await this.authority.effect("attach", () => {
      this.readOutputSnapshot();
      if (this.stateNeedsPersist) this.persistInputState();
    });
  }

  private scheduleOutput(): void {
    if (this.outputTasks > 0) return;
    this.outputTasks++;
    this.outputTail = this.outputTail.then(async () => {
      const sink = this.outputSink;
      if (!sink || this.detached) return;
      this.assertOutputDeadline();
      if (this.authority.reattestFence) this.authority.reattestFence();
      else this.reattest(false);
      const snapshot = this.outputSnapshot();
      if (snapshot.status === "unavailable" && snapshot.cause === "coordination") return;
      const entries = this.requireSnapshot(snapshot).output;
      const present = new Set(entries.map((entry) => entry.name));
      for (const name of this.deliveredOutput) if (!present.has(name)) this.deliveredOutput.delete(name);
      const acknowledgeOutput = async (entry: (typeof entries)[number]) => {
        if (this.hasExactDurableOutputAcknowledgement(entry.name, entry.metadata)) return;
        this.assertOutputDeadline();
        try {
          await this.authority.effect("output_ack", () => {
            this.assertOutputDeadline();
            writeAtomic(join(this.ackDirectory, entry.name), JSON.stringify({
              nonce: this.authority.nonce,
              ownerId: this.authority.fence.ownerId,
              fencingToken: this.authority.fence.fencingToken,
              metadata: entry.metadata,
            }));
          });
        } catch (error) {
          if (isRetryablePortableCoordination(error) && this.hasExactDurableOutputAcknowledgement(entry.name, entry.metadata)) return;
          throw error;
        }
      };
      for (const entry of entries) {
        if (sink !== this.outputSink || this.detached) return;
        if (this.deliveredOutput.has(entry.name)) {
          await acknowledgeOutput(entry);
          continue;
        }
        this.assertOutputDeadline();
        let acknowledgement: BackpressuredOutputAcknowledgement;
        try { acknowledgement = await sink(entry.metadata, entry.bytes); }
        catch (error) { throw this.outputSettlementDeadlineAt === undefined ? error : new PortableOutputSettlementFailure("output_unaccounted"); }
        if (JSON.stringify(acknowledgement) !== JSON.stringify(entry.metadata))
          throw new Error("Portable output acknowledgement metadata mismatch.");
        if (this.detached || sink !== this.outputSink) return;
        // The sink has accepted this exact retained chunk. Preserve that fact
        // in-memory before publishing its durable ACK so transient fence
        // contention retries only ACK publication, never sink delivery. A new
        // channel intentionally starts without this set and therefore retains
        // at-least-once replay after detach/restart when no ACK survived.
        this.deliveredOutput.add(entry.name);
        await acknowledgeOutput(entry);
      }
    }).catch((error) => {
      if (isRetryablePortableCoordination(error)) return;
      this.channelFailure = error instanceof Error ? error : new Error("Portable output channel failed.");
      this.cancelTerminalInspection();
      this.deliverTerminal({ state: "outcome_unknown" });
      this.scheduleTerminal();
    }).finally(() => { this.outputTasks--; });
  }

  private hasExactDurableOutputAcknowledgement(name: string, metadata: BackpressuredOutputMetadata): boolean {
    try {
      const value = JSON.parse(readFileSync(join(this.ackDirectory, name), "utf8"));
      return value.nonce === this.authority.nonce &&
        value.ownerId === this.authority.fence.ownerId &&
        value.fencingToken === this.authority.fence.fencingToken &&
        JSON.stringify(value.metadata) === JSON.stringify(metadata);
    } catch { return false; }
  }

  private outputFiles(): Array<{ name: string; metadata: BackpressuredOutputMetadata; bytes: Uint8Array }> {
    return [...this.requireSnapshot(this.outputSnapshot()).output];
  }

  private outputSnapshot(): PortableFenceSnapshotOutcome<PortableOutputSnapshot> {
    return this.authority.snapshot(() => this.readOutputSnapshot());
  }
  private readOutputSnapshot(): PortableOutputSnapshot {
    return readPortableOutputSnapshot({
      channelDirectory: this.channelDirectory,
      nonce: this.authority.nonce,
      supervisorPid: this.authority.supervisorPid,
    });
  }
  private requireSnapshot(snapshot: PortableFenceSnapshotOutcome<PortableOutputSnapshot>): PortableOutputSnapshot {
    if (snapshot.status === "applied") return snapshot.value;
    if (snapshot.status === "stale") throw new Error("Portable output snapshot fence is stale.");
    throw snapshot.error instanceof Error ? snapshot.error : new Error("Portable output snapshot is unavailable.");
  }

  private async command(sequence: number, body: Record<string, unknown>, timeoutMs: number, nextState: { nextCommand: number; nextWrite: number; inputClosed: boolean }): Promise<void> {
    const name = `input-${String(sequence).padStart(12, "0")}.json`;
    await this.authority.effect(body.type === "write" ? "write" : body.type === "close_input" ? "close" : "signal", () => {
      this.persistInputState(nextState);
      writeAtomic(join(this.inputDirectory, name), JSON.stringify({
        nonce: this.authority.nonce,
        ownerId: this.authority.fence.ownerId,
        fencingToken: this.authority.fence.fencingToken,
        sequence,
        ...body,
      }));
    });
    this.nextCommand = nextState.nextCommand;
    this.nextWrite = nextState.nextWrite;
    this.inputClosed = nextState.inputClosed;
    const deadline = Date.now() + timeoutMs;
    const ackPath = join(this.ackDirectory, name);
    const readAcknowledgement = (): "acknowledged" | "failed" | undefined => {
      let ack: Record<string, unknown>;
      try { ack = JSON.parse(readFileSync(ackPath, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Portable channel command acknowledgement is invalid.", { cause: error });
      }
      if (ack.nonce !== this.authority.nonce || ack.ownerId !== this.authority.fence.ownerId ||
          ack.fencingToken !== this.authority.fence.fencingToken || ack.sequence !== sequence ||
          (ack.status !== "acknowledged" && ack.status !== "failed"))
        throw new Error("Portable channel command acknowledgement is invalid.");
      return ack.status;
    };
    const settleAcknowledgement = async (): Promise<boolean> => {
      const status = readAcknowledgement();
      if (status === undefined) return false;
      if (status === "failed") throw new Error("Portable channel command failed.");
      try {
        await this.authority.effect("ack_consume", () => { try { unlinkSync(ackPath); } catch {} });
      } catch (error) {
        // Delivery committed before takeover. If the prior owner can no longer
        // consume its proof, accept only the same still-durable acknowledgement.
        if (readAcknowledgement() !== "acknowledged") throw error;
      }
      return true;
    };
    while (Date.now() < deadline) {
      if (await settleAcknowledgement()) return;
      try { this.reattest(false); }
      catch (error) {
        // A takeover and a supervisor acknowledgement serialize through the
        // same fence transaction. Re-read after observing takeover so the
        // caller never reports rejection for an effect that already committed.
        if (await settleAcknowledgement()) return;
        throw error;
      }
      await delay(this.pollIntervalMs);
    }
    let detail = "state unavailable";
    try { detail = JSON.stringify({ state: JSON.parse(readFileSync(join(this.authority.directory, "state.json"), "utf8")), input: readdirSync(this.inputDirectory), ack: readdirSync(this.ackDirectory).map((name) => [name, readFileSync(join(this.ackDirectory, name), "utf8")]) }); } catch {}
    throw new Error(`Portable channel command acknowledgement timed out. ${detail}`);
  }

  private async terminal(signal: AbortSignal): Promise<unknown | undefined> {
    if (this.channelFailure) return { state: "outcome_unknown", detail: this.channelFailure.message };
    try {
      const birth = await this.reattestObservation(signal);
      let state = JSON.parse(readFileSync(join(this.authority.directory, "state.json"), "utf8"));
      if (state.nonce !== this.authority.nonce) throw new Error("Portable channel identity mismatch.");
      if (!["running", "stopping", "stopped", "outcome_unknown"].includes(state.status)) return { state: "outcome_unknown" };
      if (birth === "exited" && state.status !== "stopped") return { state: "outcome_unknown" };
      if (this.liveStoppedObserved && state.status !== "stopped") return { state: "outcome_unknown" };
      // A live supervisor with durable stopped state may still own output
      // retirement. Inspect that protocol read-only so terminal polling never
      // competes for the writer lock. Once the retained window is fully retired,
      // re-attest identity and the exact durable fence without waiting for the
      // supervisor process itself to disappear.
      if (state.status === "stopped" && birth === "live") {
        this.liveStoppedObserved = true;
        const pending = this.readLiveStoppedOutput();
        if (!pending || this.hasPendingOutput(pending)) return undefined;
        await this.reattestObservation(signal);
        state = JSON.parse(readFileSync(join(this.authority.directory, "state.json"), "utf8"));
        if (state.nonce !== this.authority.nonce || state.status !== "stopped") return { state: "outcome_unknown" };
        const finalOutput = this.readLiveStoppedOutput();
        if (!finalOutput || this.hasPendingOutput(finalOutput)) return undefined;
        if (this.authority.reattestFence) this.authority.reattestFence();
        else {
          const finalFence = this.authority.snapshot(() => true);
          if (finalFence.status === "unavailable" && finalFence.cause === "coordination") return undefined;
          if (finalFence.status !== "applied") throw new Error("Portable terminal fence is unavailable.");
        }
        return { state: "exited", ...(state.exitCode === null ? {} : { exitCode: state.exitCode }), ...(state.signal ? { signal: state.signal } : {}) };
      }
      if (state.status === "stopped") {
        const snapshot = this.outputSnapshot();
        if (snapshot.status === "unavailable" && snapshot.cause === "coordination") return undefined;
        const output = this.requireSnapshot(snapshot);
        if (output.output.length > 0 || output.acknowledgements.some((name) => /^(stdout|stderr)-/.test(name))) return undefined;
        await this.reattestObservation(signal);
        // The asynchronous identity wait cannot preserve an earlier output or
        // terminal snapshot. Read both again under the current exact fence.
        const final = this.authority.snapshot(() => ({
          state: JSON.parse(readFileSync(join(this.authority.directory, "state.json"), "utf8")),
          output: this.readOutputSnapshot(),
        }));
        if (final.status === "unavailable" && final.cause === "coordination") return undefined;
        if (final.status !== "applied") throw new Error("Portable terminal snapshot is unavailable.");
        state = final.value.state;
        if (state.nonce !== this.authority.nonce || state.status !== "stopped") throw new Error("Portable terminal proof changed.");
        if (final.value.output.output.length > 0 || final.value.output.acknowledgements.some((name) => /^(stdout|stderr)-/.test(name))) return undefined;
      }
      return state.status === "stopped"
        ? { state: "exited", ...(state.exitCode === null ? {} : { exitCode: state.exitCode }), ...(state.signal ? { signal: state.signal } : {}) }
        : state.status === "outcome_unknown" ? { state: "outcome_unknown" } : undefined;
    } catch { return { state: "outcome_unknown" }; }
  }

  private readLiveStoppedOutput(): PortableOutputSnapshot | undefined {
    try { return this.readOutputSnapshot(); }
    catch (error) {
      if (error instanceof PortableOutputRetirementBlockedError) return undefined;
      throw error;
    }
  }

  private hasPendingOutput(output: PortableOutputSnapshot): boolean {
    return output.output.length > 0 ||
      output.acknowledgements.some((name) => /^(stdout|stderr)-/.test(name));
  }

  private async reattestObservation(signal: AbortSignal): Promise<"live" | "exited"> {
    const state = this.authority.reattestObservation
      ? await this.authority.reattestObservation(signal)
      : this.authority.reattest();
    if (signal.aborted || this.detached) throw new Error("Portable terminal observation cancelled.");
    return state;
  }

  private reattest(requireLive: boolean): void {
    const state = this.authority.reattest();
    if (requireLive && state !== "live") throw new Error("Portable channel owner is not live.");
  }
  private assertAttached(): void { if (this.detached) throw new Error("Portable channel is detached."); }
  private statePath(): string { return join(this.channelDirectory, "client-state.json"); }
  private restoreInputState(): void {
    try {
      const value = JSON.parse(readFileSync(this.statePath(), "utf8"));
      if (value.nonce !== this.authority.nonce || !Number.isSafeInteger(value.fencingToken) ||
          value.fencingToken > this.authority.fence.fencingToken ||
          (value.fencingToken === this.authority.fence.fencingToken && value.ownerId !== this.authority.fence.ownerId)) throw new Error("Portable channel writer/fence mismatch.");
      this.nextCommand = positive(value.nextCommand);
      this.nextWrite = positive(value.nextWrite);
      this.inputClosed = value.inputClosed === true;
      if (value.fencingToken < this.authority.fence.fencingToken) this.stateNeedsPersist = true;
    } catch (error) {
      if (existsSync(this.statePath())) throw error;
      this.stateNeedsPersist = true;
    }
  }
  private persistInputState(state = { nextCommand: this.nextCommand, nextWrite: this.nextWrite, inputClosed: this.inputClosed }): void {
    writeAtomic(this.statePath(), JSON.stringify({ nonce: this.authority.nonce, ownerId: this.authority.fence.ownerId, fencingToken: this.authority.fence.fencingToken, ...state }));
    this.stateNeedsPersist = false;
  }
}

class PortableOutputSettlementFailure extends Error {
  constructor(readonly reason: "deadline" | "output_unaccounted") { super("Portable output settlement is blocked."); }
}

export function validatePortableAcknowledgementEvidence(
  acknowledgementDirectory: string,
  nonce: string,
  output: ReadonlyArray<{ name: string; metadata: BackpressuredOutputMetadata }>,
): string[] {
  return validatePortableAcknowledgements(acknowledgementDirectory, nonce, output);
}

function writeAtomic(path: string, value: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Portable channel capacity/state is invalid.");
  return value as number;
}
function isRetryablePortableCoordination(error: unknown): boolean {
  return isOwnedFenceLockContention(error);
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
