import type { RemoteTransport, RemoteTransportMessage } from "./remote-connector.js";
import { decodeFrame, DEFAULT_REMOTE_FRAME_LIMITS, encodeFrame, type RemoteFrameLimits } from "./remote-frame-codec.js";

/**
 * R4 device transport: one outbound WebSocket to the relay, using Node's
 * built-in client (no runtime dependency). Authentication is in-band
 * (challenge → Ed25519 proof), so the URL never carries a credential: TLS is
 * required off loopback, and credentials, query strings and fragments are
 * refused outright (no query-token fallback). Every frame is bounded by the
 * negotiated maximum in both directions; a refused inbound frame becomes a
 * `frame_rejected` message and the session survives it. Outbound sends wait
 * while the socket's send buffer is above a bound, so a slow relay
 * backpressures artifact streaming instead of growing memory.
 */

export const DEFAULT_RELAY_URL = "wss://mcp.aiboard.me/connect";

export class RemoteRelayUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteRelayUrlError";
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** wss:// anywhere; ws:// only to loopback; never userinfo, query or fragment. */
export function validateRelayUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RemoteRelayUrlError("Relay URL is not a valid URL."); }
  if (url.username || url.password) throw new RemoteRelayUrlError("Relay URL must not carry credentials.");
  if (url.search || url.hash || value.includes("?") || value.includes("#")) {
    throw new RemoteRelayUrlError("Relay URL must not carry a query string or fragment.");
  }
  if (url.protocol === "wss:") return url;
  if (url.protocol === "ws:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new RemoteRelayUrlError("Relay URL must use wss:// (ws:// is allowed only to loopback).");
}

type WebSocketLike = Pick<WebSocket, "send" | "close" | "addEventListener" | "readyState" | "bufferedAmount">;

export interface WebSocketTransportOptions {
  /** Relay device route base, e.g. wss://mcp.aiboard.me/connect. */
  readonly url: string;
  /** Appended as one path segment (`/connect/<deviceId>`); a device id is public, never a credential. */
  readonly deviceId?: string;
  /** Backpressure bound on the socket's send buffer; defaults to 4 MiB. */
  readonly maxBufferedBytes?: number;
  /** Maximum time a send may wait for its turn and buffer space. */
  readonly sendTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  /** Injectable for tests; defaults to the global WebSocket. */
  readonly createSocket?: (url: string) => WebSocketLike;
}

const OPEN = 1;
const MAX_INBOUND_MESSAGES = 64;
const MAX_INBOUND_BYTES = 8 * 1024 * 1024;
const MAX_OUTBOUND_MESSAGES = 64;
const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;

export class WebSocketRemoteTransport implements RemoteTransport {
  private readonly url: string;
  private socket: WebSocketLike | undefined;
  private limits: RemoteFrameLimits = DEFAULT_REMOTE_FRAME_LIMITS;
  private messageHandler: ((message: RemoteTransportMessage) => void | Promise<void>) | undefined;
  private closeHandler: ((info?: { readonly code?: number }) => void) | undefined;
  /** Inbound frames are handled strictly in arrival order. */
  private inbound: Promise<void> = Promise.resolve();
  private inboundMessages = 0;
  private inboundBytes = 0;
  private outbound: Promise<void> = Promise.resolve();
  private outboundMessages = 0;
  private outboundBytes = 0;
  private readonly pendingSends = new Set<(error: Error) => void>();
  private closed = false;

  constructor(private readonly options: WebSocketTransportOptions) {
    const url = validateRelayUrl(options.url);
    if (options.deviceId !== undefined) {
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(options.deviceId)) throw new RemoteRelayUrlError("Device id is not a valid path segment.");
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${encodeURIComponent(options.deviceId)}`;
    }
    this.url = url.toString();
  }

  /** Apply the limits negotiated at the handshake. */
  setFrameLimits(limits: RemoteFrameLimits): void {
    this.limits = limits;
  }

  async connect(): Promise<void> {
    if (this.socket) throw new Error("Remote transport is single-use.");
    const socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { fail(new Error("Relay connection timed out.")); }, this.options.connectTimeoutMs ?? 15_000);
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closing */ }
        reject(error);
      };
      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => fail(new Error("Relay connection failed.")));
      socket.addEventListener("close", (event: CloseEvent) => {
        fail(new Error("Relay connection closed during connect."));
        this.markClosed(event.code);
      });
      socket.addEventListener("message", (event: MessageEvent) => { this.receive(event.data); });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed) { this.markClosed(); return; }
    this.markClosed();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      socket.addEventListener("close", () => { clearTimeout(timer); resolve(); });
      try { socket.close(1000, "client closing"); } catch { clearTimeout(timer); resolve(); }
    });
  }

  async send(message: RemoteTransportMessage, signal?: AbortSignal, beforeSend?: () => boolean): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed || socket.readyState !== OPEN) throw new Error("Remote transport is not open.");
    const frame = encodeFrame(message, this.limits);
    const bound = this.options.maxBufferedBytes ?? 4 * 1024 * 1024;
    const timeout = this.options.sendTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(bound) || bound < 1 || !Number.isSafeInteger(timeout) || timeout < 1) throw new Error("Invalid remote send limits.");
    if (signal?.aborted) throw new Error("Remote send was aborted.");
    if (this.outboundMessages >= MAX_OUTBOUND_MESSAGES || this.outboundBytes + frame.byteLength > MAX_OUTBOUND_BYTES) {
      this.shutdownSocket();
      throw new Error("Remote send queue is full.");
    }
    this.outboundMessages++;
    this.outboundBytes += frame.byteLength;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pendingSends.delete(cancel);
        if (error) reject(error); else resolve();
      };
      const cancel = (error: Error) => finish(error);
      const abort = () => finish(new Error("Remote send was aborted."));
      const timer = setTimeout(() => {
        this.shutdownSocket();
        finish(new Error("Remote send timed out."));
      }, timeout);
      this.pendingSends.add(cancel);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      this.outbound = this.outbound.then(async () => {
        try {
          while (!settled && !this.closed && socket.readyState === OPEN && socket.bufferedAmount + frame.byteLength > bound) {
            await new Promise((accept) => setTimeout(accept, 5));
          }
          if (settled) return;
          if (this.closed || socket.readyState !== OPEN) { finish(new Error("Remote transport closed while sending.")); return; }
          try {
            if (beforeSend && !beforeSend()) { finish(new Error("Remote send authorization changed.")); return; }
          } catch { finish(new Error("Remote send authorization changed.")); return; }
          try { socket.send(frame.toString("utf8")); finish(); }
          catch (error) { finish(error instanceof Error ? error : new Error("Remote send failed.")); this.shutdownSocket(); }
        } finally {
          this.outboundMessages--;
          this.outboundBytes -= frame.byteLength;
        }
      });
    });
  }

  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onClose(handler: (info?: { readonly code?: number }) => void): void {
    this.closeHandler = handler;
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    const size = typeof data === "string" ? Buffer.byteLength(data, "utf8") : 0;
    if (this.inboundMessages >= MAX_INBOUND_MESSAGES || this.inboundBytes + size > MAX_INBOUND_BYTES) {
      this.shutdownSocket();
      return;
    }
    this.inboundMessages++;
    this.inboundBytes += size;
    this.inbound = this.inbound.then(async () => {
      try {
        if (this.closed) return;
        const decoded = typeof data === "string" ? decodeFrame(Buffer.from(data, "utf8"), this.limits) :
          { ok: false as const, code: "malformed_frame" as const };
        const message: RemoteTransportMessage = decoded.ok ? decoded.message as unknown as RemoteTransportMessage :
          { type: "frame_rejected", code: decoded.code };
        await this.messageHandler?.(message);
      } catch { /* the connector owns its own failures */ }
      finally { this.inboundMessages--; this.inboundBytes -= size; }
    });
  }

  private shutdownSocket(): void {
    this.markClosed();
    try { this.socket?.close(1008, "transport limit"); } catch { /* already closing */ }
  }

  private markClosed(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.pendingSends]) cancel(new Error("Remote transport closed while sending."));
    this.closeHandler?.(code === undefined ? undefined : { code });
  }
}
