import { createHash } from "node:crypto";

import {
  BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
  type BackpressuredOutputAcknowledgement,
  type BackpressuredOutputMetadata,
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
  reattest(): Promise<"live" | "exited">;
}

export function createWindowsJobProcessChannelProvider(options: {
  readonly replayCapacityChunks: number;
  readonly replayCapacityBytes: number;
  readonly pollIntervalMs: number;
  authority(binding: ProcessBackendBinding, fence: ProcessEffectFence): WindowsJobChannelAuthority;
}) {
  const acquire = async (binding: ProcessBackendBinding, fence: ProcessEffectFence) => {
    const authority = options.authority(binding, fence);
    await authority.service.claimOwnedFence(authority.processId, authority.owner, fence);
    await authority.reattest();
    const state = await authority.service.attachOwnedChannel(authority.processId, authority.owner, fence);
    return new WindowsJobProcessChannel(authority, state.nextSequence, state.inputClosed, state.outputOffsets, state.outputSequences, options.pollIntervalMs, options.replayCapacityBytes);
  };
  return Object.freeze({
    version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
    replayCapacityChunks: options.replayCapacityChunks,
    replayCapacityBytes: options.replayCapacityBytes,
    acquire,
    async reattach(binding: ProcessBackendBinding, fence: ProcessEffectFence) {
      const channel = await acquire(binding, fence);
      return { version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION, binding, channel, retainedWindow: [], replayCapacityChunks: options.replayCapacityChunks, replayCapacityBytes: options.replayCapacityBytes, nextSequence: channel.nextWriteSequence(), inputClosed: channel.isInputClosed() };
    },
  });
}

class WindowsJobProcessChannel implements InteractiveProcessChannel {
  private detached = false;
  private timer?: ReturnType<typeof setInterval>;
  private sink?: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>;
  private outputTail = Promise.resolve();
  private outputFailure?: Error;
  constructor(
    private readonly authority: WindowsJobChannelAuthority,
    private nextSequence: number,
    private inputClosed: boolean,
    private readonly offsets: { stdout: number; stderr: number },
    private readonly acknowledgedSequences: { stdout: number; stderr: number },
    private readonly pollIntervalMs: number,
    private readonly maximumBytes: number,
  ) {}

  nextWriteSequence() { return this.nextSequence; }
  isInputClosed() { return this.inputClosed; }

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
      await this.poll();
      const state = await this.authority.reattest();
      if (state === "exited") {
        for (;;) {
          const before = this.offsets.stdout + this.offsets.stderr;
          await this.poll();
          if (this.offsets.stdout + this.offsets.stderr === before) {
            if (this.outputFailure) throw this.outputFailure;
            if (await this.authority.reattest() !== "exited") throw new Error("Windows Job terminal identity changed during output settlement.");
            return { state: "exited" };
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

  private startPolling() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll().catch((error) => this.rememberOutputFailure(error)); }, this.pollIntervalMs); this.timer.unref?.();
    void this.poll().catch((error) => this.rememberOutputFailure(error));
  }
  private async poll() {
    if (this.outputFailure) throw this.outputFailure;
    if (this.detached || !this.sink) return;
    this.outputTail = this.outputTail.then(async () => {
      const sink = this.sink;
      if (!sink || this.detached) return;
      const unread = await this.authority.service.readOwnedOutput(this.authority.processId, this.authority.owner, this.offsets, this.authority.fence);
      for (const stream of ["stdout", "stderr"] as const) {
        if (this.detached || this.sink !== sink) return;
        const bytes = unread[stream].subarray(0, this.maximumBytes);
        if (bytes.byteLength === 0) continue;
        const startOffset = this.offsets[stream]; const endOffset = startOffset + bytes.byteLength;
        const metadata: BackpressuredOutputMetadata = { stream, sequence: this.acknowledgedSequences[stream] + 1, startOffset, endOffset, byteLength: bytes.byteLength, digest: createHash("sha256").update(bytes).digest("hex") };
        const acknowledgement = await sink(metadata, new Uint8Array(bytes));
        if (JSON.stringify(acknowledgement) !== JSON.stringify(metadata)) throw new Error("Windows Job output acknowledgement is invalid.");
        if (this.detached || this.sink !== sink) return;
        await this.authority.service.acknowledgeOwnedOutput(this.authority.processId, this.authority.owner, this.authority.fence, stream, endOffset);
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

function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
