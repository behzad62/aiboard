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
  readonly connectTimeoutMs?: number;
  /** Injectable for tests; defaults to the global WebSocket. */
  readonly createSocket?: (url: string) => WebSocketLike;
}

const OPEN = 1;

export class WebSocketRemoteTransport implements RemoteTransport {
  private readonly url: string;
  private socket: WebSocketLike | undefined;
  private limits: RemoteFrameLimits = DEFAULT_REMOTE_FRAME_LIMITS;
  private messageHandler: ((message: RemoteTransportMessage) => void | Promise<void>) | undefined;
  private closeHandler: (() => void) | undefined;
  /** Inbound frames are handled strictly in arrival order. */
  private inbound: Promise<void> = Promise.resolve();
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
      socket.addEventListener("close", () => {
        fail(new Error("Relay connection closed during connect."));
        this.markClosed();
      });
      socket.addEventListener("message", (event: MessageEvent) => { this.receive(event.data); });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed) { this.markClosed(); return; }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      socket.addEventListener("close", () => { clearTimeout(timer); resolve(); });
      try { socket.close(1000, "client closing"); } catch { clearTimeout(timer); resolve(); }
    });
    this.markClosed();
  }

  async send(message: RemoteTransportMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed || socket.readyState !== OPEN) throw new Error("Remote transport is not open.");
    // Throws frame_too_large; the connector never emits such a frame, so this is a backstop.
    const frame = encodeFrame(message, this.limits);
    socket.send(frame.toString("utf8"));
    const bound = this.options.maxBufferedBytes ?? 4 * 1024 * 1024;
    while (socket.bufferedAmount > bound) {
      if (this.closed || socket.readyState !== OPEN) throw new Error("Remote transport closed while sending.");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  private receive(data: unknown): void {
    let message: RemoteTransportMessage;
    if (typeof data !== "string") {
      message = { type: "frame_rejected", code: "malformed_frame" };
    } else {
      const bytes = Buffer.from(data, "utf8");
      const decoded = decodeFrame(bytes, this.limits);
      message = decoded.ok ? decoded.message as unknown as RemoteTransportMessage : { type: "frame_rejected", code: decoded.code };
    }
    this.inbound = this.inbound.then(async () => {
      try { await this.messageHandler?.(message); } catch { /* the connector owns its own failures */ }
    });
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }
}
