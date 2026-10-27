import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

const TICKET_LIFETIME_MS = 120_000;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_TICKETS = 4_096;
const MAX_SESSIONS = 1_024;
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The launcher keeps the code; only its digest is registered with the Runner. */
export function createLocalPairTicket(instanceId: string): { code: string; digest: string } {
  if (!INSTANCE_ID.test(instanceId)) throw new Error("Invalid pairing instance identity.");
  const code = `v1.${instanceId}.${randomBytes(32).toString("base64url")}`;
  return { code, digest: hash(code) };
}

/** In-memory credentials belong to exactly one Runner lifetime. */
export class LocalPairing {
  private readonly tickets = new Map<string, { expiresAt: number; consumed: boolean }>();
  private readonly sessions = new Set<string>();
  private readonly attempts: number[] = [];
  private closed = false;

  constructor(readonly instanceId: string, private readonly clock: () => number = () => performance.now()) {
    if (!INSTANCE_ID.test(instanceId)) throw new Error("Invalid pairing instance identity.");
  }

  register(digest: string): void {
    // Retain retired digests for the lifetime of this instance, so re-registration cannot revive a code.
    if (this.closed || !DIGEST.test(digest) || this.tickets.has(digest) || this.tickets.size >= MAX_TICKETS) {
      throw new Error("Pairing ticket registration refused.");
    }
    this.tickets.set(digest, { expiresAt: this.clock() + TICKET_LIFETIME_MS, consumed: false });
  }

  allowAttempt(): boolean {
    if (this.closed) return false;
    const now = this.clock();
    while (this.attempts.length && this.attempts[0]! <= now - ATTEMPT_WINDOW_MS) this.attempts.shift();
    if (this.attempts.length >= MAX_ATTEMPTS) return false;
    this.attempts.push(now);
    return true;
  }

  consume(code: string): string | undefined {
    if (this.closed || code.length > 512) return undefined;
    const parts = code.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || parts[1] !== this.instanceId || !SECRET.test(parts[2]!)) return undefined;
    const ticket = this.tickets.get(hash(code));
    if (!ticket || ticket.consumed || this.clock() >= ticket.expiresAt) return undefined;
    if (this.sessions.size >= MAX_SESSIONS) return undefined;
    // This synchronous transition makes competing exchanges single-use even if response I/O overlaps.
    ticket.consumed = true;
    const token = `session_${randomBytes(32).toString("base64url")}`;
    this.sessions.add(hash(token));
    return token;
  }

  hasSession(token: string): boolean {
    return !this.closed && /^session_[A-Za-z0-9_-]{43}$/.test(token) && this.sessions.has(hash(token));
  }

  revoke(token: string): boolean {
    return !this.closed && this.sessions.delete(hash(token));
  }

  close(): void {
    this.closed = true;
    this.tickets.clear();
    this.sessions.clear();
    this.attempts.length = 0;
  }
}
