import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
  type BackpressuredOutputAcknowledgement,
  type BackpressuredOutputMetadata,
  type InteractiveProcessChannel,
  type InteractiveProcessWrite,
} from "./interactive-process-channel.js";
import type { ProcessBackendBinding, ProcessEffectFence } from "./process-backend.js";

export interface PortableChannelAuthority {
  readonly directory: string;
  readonly nonce: string;
  readonly fence: ProcessEffectFence;
  reattest(): "live" | "exited";
}

export interface PortableProcessChannelProviderOptions {
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
    const channel = new PortableProcessChannel(options.authority(binding, fence), pollIntervalMs);
    channel.validateForAttach();
    return channel;
  };
  return Object.freeze({
    version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
    replayCapacityChunks,
    replayCapacityBytes,
    acquire,
    async reattach(binding: ProcessBackendBinding, fence: ProcessEffectFence) {
      const channel = await acquire(binding, fence);
      return {
        version: BACKPRESSURED_INTERACTIVE_PROCESS_CHANNEL_VERSION,
        binding,
        channel,
        retainedWindow: channel.retainedWindow(),
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
  private readonly outputDirectory: string;
  private readonly inputDirectory: string;
  private readonly ackDirectory: string;
  private nextCommand = 1;
  private nextWrite = 1;
  private inputClosed = false;
  private detached = false;
  private outputTimer?: ReturnType<typeof setInterval>;
  private terminalTimer?: ReturnType<typeof setInterval>;
  private outputSink?: (metadata: BackpressuredOutputMetadata, bytes: Uint8Array) => Promise<BackpressuredOutputAcknowledgement>;
  private outputTail = Promise.resolve();
  private readonly deliveredOutput = new Set<string>();
  private readonly terminalSinks = new Set<(result: unknown) => void>();
  private channelFailure?: Error;

  constructor(private readonly authority: PortableChannelAuthority, private readonly pollIntervalMs: number) {
    this.channelDirectory = join(authority.directory, "channel");
    this.outputDirectory = join(this.channelDirectory, "output");
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
    const commandSequence = this.nextCommand++;
    this.nextWrite++;
    await this.command(commandSequence, {
      type: "write",
      byteLength: owned.byteLength,
      digest: input.digest,
      bytes: Buffer.from(owned).toString("base64"),
    }, input.timeoutMs);
    return { acknowledged: true, sequence: input.sequence };
  }

  async closeInput(): Promise<unknown> {
    this.assertAttached();
    this.reattest(true);
    if (this.inputClosed) return false;
    const sequence = this.nextCommand++;
    // Reserve closure before the effect. An unknown acknowledgement must never
    // make later writes look replay-safe.
    this.inputClosed = true;
    this.persistInputState();
    await this.command(sequence, { type: "close_input" }, 5_000);
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
    const sequence = this.nextCommand++;
    await this.command(sequence, { type: "graceful_stop" }, 5_000);
    return { acknowledged: true };
  }

  async waitForTerminal(): Promise<unknown> {
    for (;;) {
      const terminal = this.terminal();
      if (terminal) return terminal;
      await delay(this.pollIntervalMs);
    }
  }

  observeTerminal(sink: (result: unknown) => void): () => void {
    this.terminalSinks.add(sink);
    this.terminalTimer ??= setInterval(() => {
      const result = this.terminal();
      if (!result) return;
      for (const listener of this.terminalSinks) listener(result);
      this.terminalSinks.clear();
      if (this.terminalTimer) clearInterval(this.terminalTimer);
      this.terminalTimer = undefined;
    }, this.pollIntervalMs);
    this.terminalTimer.unref?.();
    return () => this.terminalSinks.delete(sink);
  }

  async detach(): Promise<unknown> {
    if (this.detached) return false;
    this.detached = true;
    this.outputSink = undefined;
    if (this.outputTimer) clearInterval(this.outputTimer);
    if (this.terminalTimer) clearInterval(this.terminalTimer);
    this.outputTimer = undefined;
    this.terminalTimer = undefined;
    this.terminalSinks.clear();
    await this.outputTail.catch(() => undefined);
    return true;
  }

  retainedWindow(): readonly BackpressuredOutputMetadata[] {
    return this.outputFiles().map((entry) => entry.metadata);
  }
  nextWriteSequence(): number { return this.nextWrite; }
  isInputClosed(): boolean { return this.inputClosed; }
  validateForAttach(): void {
    this.reattest(false);
    this.outputFiles();
  }

  private scheduleOutput(): void {
    this.outputTail = this.outputTail.then(async () => {
      const sink = this.outputSink;
      if (!sink || this.detached) return;
      this.reattest(false);
      const entries = this.outputFiles();
      const present = new Set(entries.map((entry) => entry.name));
      for (const name of this.deliveredOutput) if (!present.has(name)) this.deliveredOutput.delete(name);
      for (const entry of entries) {
        if (sink !== this.outputSink || this.detached) return;
        if (this.deliveredOutput.has(entry.name)) continue;
        const acknowledgement = await sink(entry.metadata, entry.bytes);
        if (JSON.stringify(acknowledgement) !== JSON.stringify(entry.metadata))
          throw new Error("Portable output acknowledgement metadata mismatch.");
        writeAtomic(join(this.ackDirectory, entry.name), JSON.stringify({ nonce: this.authority.nonce, metadata: entry.metadata }));
        this.deliveredOutput.add(entry.name);
      }
    }).catch((error) => {
      this.channelFailure = error instanceof Error ? error : new Error("Portable output channel failed.");
      for (const listener of this.terminalSinks) listener({ state: "outcome_unknown" });
      this.terminalSinks.clear();
    });
  }

  private outputFiles(): Array<{ name: string; metadata: BackpressuredOutputMetadata; bytes: Uint8Array }> {
    let names: string[];
    try { names = readdirSync(this.outputDirectory).sort(); }
    catch { return []; }
    const entries: Array<{ name: string; metadata: BackpressuredOutputMetadata; bytes: Uint8Array }> = [];
    const checkpoint = this.outputCheckpoint();
    const expected = new Map<"stdout" | "stderr", { sequence: number; offset: number }>([["stdout", { sequence: checkpoint.stdout.sequence + 1, offset: checkpoint.stdout.endOffset }], ["stderr", { sequence: checkpoint.stderr.sequence + 1, offset: checkpoint.stderr.endOffset }]]);
    for (const name of names) {
      const filename = /^(stdout|stderr)-(\d{12})\.json$/.exec(name);
      if (!filename) throw new Error("Portable output filename is invalid.");
      try {
        const value = JSON.parse(readFileSync(join(this.outputDirectory, name), "utf8"));
        if (value.nonce !== this.authority.nonce) throw new Error("Portable output nonce is invalid.");
        const bytes = Buffer.from(value.bytes, "base64");
        if (!validMetadata(value.metadata, bytes)) throw new Error("Portable output metadata or payload is invalid.");
        if (value.metadata.stream !== filename[1] || value.metadata.sequence !== Number(filename[2])) throw new Error("Portable output filename metadata is inconsistent.");
        const cursor = expected.get(value.metadata.stream)!;
        if (value.metadata.sequence !== cursor.sequence || value.metadata.startOffset !== cursor.offset) throw new Error("Portable output retained suffix is not contiguous.");
        cursor.sequence += 1;
        cursor.offset = value.metadata.endOffset;
        entries.push({ name, metadata: value.metadata, bytes: new Uint8Array(bytes) });
      } catch (error) {
        throw new Error("Portable output chunk is invalid.", { cause: error });
      }
    }
    return entries;
  }

  private async command(sequence: number, body: Record<string, unknown>, timeoutMs: number): Promise<void> {
    this.persistInputState();
    const name = `input-${String(sequence).padStart(12, "0")}.json`;
    writeAtomic(join(this.inputDirectory, name), JSON.stringify({
      nonce: this.authority.nonce,
      ownerId: this.authority.fence.ownerId,
      fencingToken: this.authority.fence.fencingToken,
      sequence,
      ...body,
    }));
    const deadline = Date.now() + timeoutMs;
    const ackPath = join(this.ackDirectory, name);
    while (Date.now() < deadline) {
      this.reattest(false);
      try {
        const ack = JSON.parse(readFileSync(ackPath, "utf8"));
        if (ack.nonce === this.authority.nonce && ack.sequence === sequence && ack.status === "acknowledged") {
          try { unlinkSync(ackPath); } catch {}
          return;
        }
        if (ack.status === "failed") throw new Error("Portable channel command failed.");
      } catch (error) {
        if (existsSync(ackPath)) throw error;
      }
      await delay(this.pollIntervalMs);
    }
    let detail = "state unavailable";
    try { detail = JSON.stringify({ state: JSON.parse(readFileSync(join(this.authority.directory, "state.json"), "utf8")), input: readdirSync(this.inputDirectory), ack: readdirSync(this.ackDirectory).map((name) => [name, readFileSync(join(this.ackDirectory, name), "utf8")]) }); } catch {}
    throw new Error(`Portable channel command acknowledgement timed out. ${detail}`);
  }

  private terminal(): unknown | undefined {
    if (this.channelFailure) return { state: "outcome_unknown" };
    try {
      this.reattest(false);
      const state = JSON.parse(readFileSync(join(this.authority.directory, "state.json"), "utf8"));
      if (state.nonce !== this.authority.nonce) throw new Error("Portable channel identity mismatch.");
      return state.status === "stopped"
        ? { state: "exited", ...(state.exitCode === null ? {} : { exitCode: state.exitCode }), ...(state.signal ? { signal: state.signal } : {}) }
        : state.status === "outcome_unknown" ? { state: "outcome_unknown" } : undefined;
    } catch { return undefined; }
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
      if (value.fencingToken < this.authority.fence.fencingToken) this.persistInputState();
    } catch (error) {
      if (existsSync(this.statePath())) throw error;
      this.persistInputState();
    }
  }
  private outputCheckpoint(): { stdout: { sequence: number; endOffset: number }; stderr: { sequence: number; endOffset: number } } {
    const path = join(this.channelDirectory, "output-checkpoint.json");
    if (!existsSync(path)) return { stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } };
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value.nonce !== this.authority.nonce) throw new Error();
      for (const stream of ["stdout", "stderr"] as const) {
        if (!Number.isSafeInteger(value[stream]?.sequence) || value[stream].sequence < 0 ||
            !Number.isSafeInteger(value[stream]?.endOffset) || value[stream].endOffset < 0) throw new Error();
      }
      return value;
    } catch { throw new Error("Portable output checkpoint is invalid."); }
  }
  private persistInputState(): void {
    writeAtomic(this.statePath(), JSON.stringify({ nonce: this.authority.nonce, ownerId: this.authority.fence.ownerId, fencingToken: this.authority.fence.fencingToken, nextCommand: this.nextCommand, nextWrite: this.nextWrite, inputClosed: this.inputClosed }));
  }
}

function validMetadata(value: unknown, bytes: Uint8Array): value is BackpressuredOutputMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as BackpressuredOutputMetadata;
  return (metadata.stream === "stdout" || metadata.stream === "stderr") && Number.isSafeInteger(metadata.sequence) && metadata.sequence > 0 && metadata.byteLength === bytes.byteLength && metadata.endOffset === metadata.startOffset + metadata.byteLength && metadata.digest === createHash("sha256").update(bytes).digest("hex");
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
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
