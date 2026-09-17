import { createHash } from "node:crypto";

import {
  BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
  type BackpressuredOutputAcknowledgement,
  type BackpressuredOutputMetadata,
  type BackpressuredOutputSettlement,
  type InteractiveProcessChannel,
  type InteractiveProcessWrite,
} from "./interactive-process-channel.js";
import type { ProcessBackendBinding, ProcessEffectFence } from "./process-backend.js";
import type { WindowsJobOwnershipKey, WindowsJobProcessHost } from "./windows-job-process-host.js";

type DuplexWindowsJobProcessHost = WindowsJobProcessHost & Required<Pick<WindowsJobProcessHost,
  "attachOwnedChannel" | "writeOwnedInput" | "closeOwnedInput" | "acknowledgeOwnedOutput" | "claimOwnedFence">>;

export interface WindowsJobChannelAuthority {
  readonly processId: string;
  readonly owner: WindowsJobOwnershipKey;
  readonly fence: ProcessEffectFence;
  readonly service: DuplexWindowsJobProcessHost;
  control<T>(effect: () => Promise<T>): Promise<T>;
  reattest(): Promise<"live" | "exited">;
}

export function createWindowsJobProcessChannelProvider(options: {
  readonly replayCapacityChunks: number;
  readonly replayCapacityBytes: number;
  readonly pollIntervalMs: number;
  readonly clock?: () => number;
  authority(binding: ProcessBackendBinding, fence: ProcessEffectFence): WindowsJobChannelAuthority;
}) {
  const acquire = async (binding: ProcessBackendBinding, fence: ProcessEffectFence) => {
    const authority = options.authority(binding, fence);
    await authority.service.claimOwnedFence(authority.processId, authority.owner, fence);
    await authority.reattest();
    const state = await authority.service.attachOwnedChannel(authority.processId, authority.owner, fence);
    return new WindowsJobProcessChannel(authority, state.nextSequence, state.inputClosed, state.outputOffsets, state.outputSequences, options.pollIntervalMs, options.replayCapacityBytes, options.clock ?? Date.now, state.retainedOutput ?? []);
  };
  return Object.freeze({
    version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
    replayCapacityChunks: options.replayCapacityChunks,
    replayCapacityBytes: options.replayCapacityBytes,
    acquire,
    async reattach(binding: ProcessBackendBinding, fence: ProcessEffectFence) {
      const channel = await acquire(binding, fence);
      return { version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION, binding, channel, retainedWindow: channel.retainedWindow(), cleanupBootstrap: channel.cleanupBootstrapObservation(), replayCapacityChunks: options.replayCapacityChunks, replayCapacityBytes: options.replayCapacityBytes, nextSequence: channel.nextWriteSequence(), inputClosed: channel.isInputClosed() };
    },
  });
}

class WindowsJobProcessChannel implements InteractiveProcessChannel {
  private detached = false;
  private timer?: ReturnType<typeof setInterval>;
  private sink?: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>;
  private outputTail = Promise.resolve();
  private outputFailure?: Error;
  private outputSettlement?: Promise<BackpressuredOutputSettlement>;
  private outputSettlementWork?: Promise<BackpressuredOutputSettlement>;
  private outputSettlementDeadlineAt?: number;
  constructor(
    private readonly authority: WindowsJobChannelAuthority,
    private nextSequence: number,
    private inputClosed: boolean,
    private readonly offsets: { stdout: number; stderr: number },
    private readonly acknowledgedSequences: { stdout: number; stderr: number },
    private readonly pollIntervalMs: number,
    private readonly maximumBytes: number,
    private readonly clock: () => number,
    private readonly retainedOutput: readonly BackpressuredOutputMetadata[],
  ) {}

  retainedWindow() { return this.retainedOutput.map((frame) => ({ ...frame })); }
  nextWriteSequence() { return this.nextSequence; }
  isInputClosed() { return this.inputClosed; }

  cleanupBootstrapObservation() {
    this.assertAttached();
    // acquire has completed the real host's fenced attachment and authenticated
    // output-evidence check. No polling/sink has started on this new channel.
    // Job ACKs complete under that same host fence (there is no queued ACK-file
    // protocol). Preserve observed positions: only actual zero consumption may
    // bootstrap a missing runtime checkpoint; nonzero positions remain blockers.
    return {
      version: 1 as const,
      consumed: {
        stdout: { sequence: this.acknowledgedSequences.stdout, endOffset: this.offsets.stdout },
        stderr: { sequence: this.acknowledgedSequences.stderr, endOffset: this.offsets.stderr },
      },
      pendingAcknowledgements: 0,
    };
  }

  async write(input: InteractiveProcessWrite, payload: Uint8Array): Promise<unknown> {
    this.assertAttached(); await this.authority.reattest();
    if (this.inputClosed) throw new Error("Windows Job input is closed.");
    if (input.sequence !== this.nextSequence || input.byteLength !== payload.byteLength || createHash("sha256").update(payload).digest("hex") !== input.digest) throw new Error("Windows Job input metadata is invalid.");
    const result = await this.authority.service.writeOwnedInput(this.authority.processId, this.authority.owner, this.authority.fence, input.sequence, new Uint8Array(payload));
    this.nextSequence += 1; return result;
  }
  async closeInput(): Promise<unknown> {
    this.assertAttached(); await this.authority.reattest();
    if (this.inputClosed) return { acknowledged: true };
    await this.authority.service.closeOwnedInput(this.authority.processId, this.authority.owner, this.authority.fence); this.inputClosed = true;
    return { acknowledged: true };
  }
  subscribePrivateOutput(sink: (bytes: Uint8Array) => void): () => void {
    return this.subscribeBackpressuredOutput(async (metadata, bytes) => { sink(bytes); return metadata; });
  }
  subscribeBackpressuredOutput(sink: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>): () => void {
    this.assertAttached(); this.sink = sink; this.startPolling();
    return () => { if (this.sink === sink) this.sink = undefined; };
  }
  async gracefulStop(): Promise<unknown> {
    this.assertAttached(); await this.authority.reattest();
    return await this.authority.service.signalOwned(this.authority.processId, "SIGTERM", this.authority.owner, this.authority.fence);
  }
  async waitForTerminal(): Promise<unknown> {
    this.assertAttached(); this.startPolling();
    for (;;) {
      this.assertAttached();
      await this.poll();
      this.assertAttached();
      const state = await this.authority.reattest();
      this.assertAttached();
      if (state === "exited") {
        for (;;) {
          this.assertAttached();
          const before = this.offsets.stdout + this.offsets.stderr;
          await this.poll();
          if (this.offsets.stdout + this.offsets.stderr === before) {
            if (this.outputFailure) throw this.outputFailure;
            if (await this.authority.reattest() !== "exited") throw new Error("Windows Job terminal identity changed during output settlement.");
            this.assertAttached();
            const terminal = await this.authority.control(() => this.authority.service.reconcileOwned(
              this.authority.processId, this.authority.owner, this.authority.fence));
            this.assertAttached();
            if (terminal.processId !== this.authority.processId || terminal.status !== "stopped" || !terminal.ownershipReleased ||
                await this.authority.reattest() !== "exited") throw new Error("Windows Job terminal result is not currently authenticated.");
            this.assertAttached();
            return { state: "exited", ...(terminal.exitCode === null ? {} : { exitCode: terminal.exitCode }),
              ...(terminal.signal ? { signal: terminal.signal } : {}) };
          }
        }
      }
      await delay(this.pollIntervalMs);
    }
  }
  async detach(): Promise<unknown> {
    this.detached = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; this.sink = undefined;
    await this.outputTail.catch((error) => this.rememberOutputFailure(error));
    return { detached: true };
  }

  settleBackpressuredOutput(deadlineAt: number): Promise<BackpressuredOutputSettlement> {
    if (this.outputSettlement) return this.outputSettlement;
    if (!Number.isSafeInteger(deadlineAt) || this.detached || !this.sink) return Promise.resolve({ status: "blocked", reason: "outcome_unknown" });
    this.outputSettlementDeadlineAt = deadlineAt;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.outputSettlementWork = this.observeOutputSettlement();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<BackpressuredOutputSettlement>((resolve) => {
      timer = setTimeout(() => {
        this.rememberOutputFailure(new JobOutputDeadlineError());
        resolve({ status: "blocked", reason: "deadline" });
      }, Math.max(0, deadlineAt - this.clock()));
    });
    // The work and outputTail remain owned after the caller's bound wins.
    // A late read/sink/control result cannot issue another ACK after expiry.
    this.outputSettlement = Promise.race([this.outputSettlementWork, expired]).finally(() => clearTimeout(timer));
    return this.outputSettlement;
  }

  private async observeOutputSettlement(): Promise<BackpressuredOutputSettlement> {
    try {
      for (;;) {
        this.assertOutputSettlementCurrent();
        await this.poll();
        this.assertOutputSettlementCurrent();
        const state = await this.authority.reattest();
        this.assertOutputSettlementCurrent();
        if (state === "exited") {
          // Native stopped status requires both pipe-end events and zero
          // retained output; the host also verifies durable ACK/file offsets.
          const before = this.offsets.stdout + this.offsets.stderr;
          await this.poll();
          this.assertOutputSettlementCurrent();
          if (before === this.offsets.stdout + this.offsets.stderr) {
            const confirmed = await this.authority.reattest();
            this.assertOutputSettlementCurrent();
            if (confirmed !== "exited") return { status: "blocked", reason: "outcome_unknown" };
            return { status: "settled" };
          }
        }
        await delay(Math.min(this.pollIntervalMs, Math.max(0, this.outputSettlementDeadlineAt! - this.clock())));
      }
    } catch (error) {
      return { status: "blocked", reason: error instanceof JobOutputDeadlineError ? "deadline" : "outcome_unknown" };
    }
  }

  private assertOutputDeadline() {
    if (this.outputFailure) throw this.outputFailure;
    if (this.outputSettlementDeadlineAt !== undefined && this.clock() >= this.outputSettlementDeadlineAt) throw new JobOutputDeadlineError();
  }
  private assertOutputSettlementCurrent() {
    this.assertOutputDeadline();
    if (this.detached || !this.sink) throw new Error("Windows Job terminal output reader is unavailable.");
  }

  private startPolling() {
    if (this.timer || this.outputSettlementDeadlineAt !== undefined) return;
    this.timer = setInterval(() => { void this.poll().catch((error) => this.rememberOutputFailure(error)); }, this.pollIntervalMs); this.timer.unref?.();
    void this.poll().catch((error) => this.rememberOutputFailure(error));
  }
  private async poll() {
    if (this.outputFailure) throw this.outputFailure;
    if (this.detached || !this.sink) return;
    this.outputTail = this.outputTail.then(async () => {
      this.assertOutputDeadline();
      const sink = this.sink;
      if (!sink || this.detached) return;
      const unread = await this.authority.service.readOwnedOutput(this.authority.processId, this.authority.owner, this.offsets, this.authority.fence, this.maximumBytes);
      this.assertOutputDeadline();
      for (const stream of ["stdout", "stderr"] as const) {
        if (this.detached || this.sink !== sink) return;
        const bytes = unread[stream].subarray(0, this.maximumBytes);
        if (bytes.byteLength === 0) continue;
        const startOffset = this.offsets[stream]; const endOffset = startOffset + bytes.byteLength;
        const metadata: BackpressuredOutputMetadata = { stream, sequence: this.acknowledgedSequences[stream] + 1, startOffset, endOffset, byteLength: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") };
        const acknowledgement = await sink(metadata, new Uint8Array(bytes));
        this.assertOutputDeadline();
        if (JSON.stringify(acknowledgement) !== JSON.stringify(metadata)) throw new Error("Windows Job output acknowledgement is invalid.");
        if (this.detached || this.sink !== sink) return;
        await this.authority.control(async () => {
          this.assertOutputDeadline();
          await this.authority.service.acknowledgeOwnedOutput(this.authority.processId, this.authority.owner, this.authority.fence, stream, endOffset);
        });
        this.assertOutputDeadline();
        this.offsets[stream] = endOffset; this.acknowledgedSequences[stream] += 1;
        if (this.detached || this.sink !== sink) return;
      }
    });
    try { await this.outputTail; }
    catch (error) { this.rememberOutputFailure(error); throw this.outputFailure; }
  }
  private rememberOutputFailure(error: unknown) { this.outputFailure ??= error instanceof Error ? error : new Error(String(error)); }
  private assertAttached() { if (this.detached) throw new Error("Windows Job channel is detached."); }
}

class JobOutputDeadlineError extends Error { constructor() { super("Windows Job terminal output deadline expired."); } }

function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
