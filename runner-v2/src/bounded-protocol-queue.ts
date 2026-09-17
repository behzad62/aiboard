export type ProtocolQueueErrorCode = "invalid_configuration" | "frame_too_large" | "cancelled";
export class ProtocolQueueError extends Error {
  constructor(readonly code: ProtocolQueueErrorCode, message: string) { super(message); this.name = "ProtocolQueueError"; }
}

export interface BoundedProtocolQueueOptions { readonly maxBytes: number; readonly maxChunks: number; readonly maxFrameBytes: number }
interface ProducerWaiter { bytes: Buffer; resolve(): void; reject(error: Error): void }
interface ConsumerWaiter { resolve(value: Buffer | undefined): void; reject(error: Error): void }

/** Runner-private byte queue. It owns every inserted buffer and applies byte and chunk backpressure. */
export class BoundedProtocolQueue {
  private readonly chunks: Buffer[] = [];
  private readonly producers: ProducerWaiter[] = [];
  private readonly consumers: ConsumerWaiter[] = [];
  private bytes = 0;
  private cancelled?: ProtocolQueueError;
  readonly maxBytes: number;
  readonly maxChunks: number;
  readonly maxFrameBytes: number;

  constructor(options: BoundedProtocolQueueOptions) {
    this.maxBytes = positive(options.maxBytes, "maxBytes");
    this.maxChunks = positive(options.maxChunks, "maxChunks");
    this.maxFrameBytes = positive(options.maxFrameBytes, "maxFrameBytes");
    if (this.maxFrameBytes > this.maxBytes) throw new ProtocolQueueError("invalid_configuration", "maxFrameBytes cannot exceed maxBytes.");
  }

  push(chunk: Uint8Array): Promise<void> {
    if (this.cancelled) return Promise.reject(this.cancelled);
    const bytes = Buffer.from(chunk);
    if (bytes.byteLength < 1) return Promise.reject(new ProtocolQueueError("invalid_configuration", "Protocol chunks must be non-empty."));
    if (bytes.byteLength > this.maxFrameBytes) {
      bytes.fill(0);
      const error = new ProtocolQueueError("frame_too_large", "Protocol frame exceeds the explicit limit.");
      this.fail(error);
      return Promise.reject(error);
    }
    if (this.canAccept(bytes)) { this.enqueue(bytes); return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => this.producers.push({ bytes, resolve, reject }));
  }

  read(): Promise<Buffer | undefined> {
    if (this.cancelled) return Promise.reject(this.cancelled);
    const chunk = this.chunks.shift();
    if (chunk) { this.bytes -= chunk.byteLength; this.pump(); return Promise.resolve(chunk); }
    return new Promise<Buffer | undefined>((resolve, reject) => this.consumers.push({ resolve, reject }));
  }

  cancel(reason: string): void {
    if (this.cancelled) return;
    this.fail(new ProtocolQueueError("cancelled", reason || "Protocol queue cancelled."));
  }

  private fail(error: ProtocolQueueError): void {
    this.cancelled = error;
    this.clearOwned();
    for (const producer of this.producers.splice(0)) { producer.bytes.fill(0); producer.reject(this.cancelled); }
    for (const consumer of this.consumers.splice(0)) consumer.reject(this.cancelled);
  }

  snapshot() { return Object.freeze({ byteCount: this.bytes, chunkCount: this.chunks.length, producerWaiters: this.producers.length, consumerWaiters: this.consumers.length, cancelled: Boolean(this.cancelled) }); }

  private canAccept(chunk: Buffer): boolean { return this.chunks.length < this.maxChunks && this.bytes + chunk.byteLength <= this.maxBytes; }
  private enqueue(chunk: Buffer): void {
    const consumer = this.consumers.shift();
    if (consumer) { consumer.resolve(chunk); return; }
    this.chunks.push(chunk); this.bytes += chunk.byteLength;
  }
  private pump(): void {
    while (this.producers.length && this.canAccept(this.producers[0]!.bytes)) {
      const producer = this.producers.shift()!; this.enqueue(producer.bytes); producer.resolve();
    }
  }
  private clearOwned(): void { for (const chunk of this.chunks.splice(0)) chunk.fill(0); this.bytes = 0; }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new ProtocolQueueError("invalid_configuration", `${name} must be a positive integer.`);
  return value;
}
