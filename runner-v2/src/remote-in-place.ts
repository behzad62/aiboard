import { resolve } from "node:path";

import { RemotePairingError } from "./remote-pairing.js";
import type { RemoteService } from "./remote-service.js";

/** An in-place Remote stays on only while the launcher that enabled it keeps polling its events. */
export const REMOTE_IN_PLACE_LEASE_MS = 30_000;
const MAX_QUEUED_EVENTS = 64;
const MAX_EVENTS_PER_POLL = 16;
const MAX_EVENT_BYTES_PER_POLL = 8_192;

/** The relay settings `aiboard remote` would pass to a Runner it spawns. */
export interface RemoteEnableSettings {
  readonly deviceDirectory: string;
  readonly relayUrl?: string;
  readonly relayRootKeys: readonly string[];
}

/** The same payloads a spawned Runner sends to its launcher over process IPC. */
export type RemoteEvent = Readonly<Record<string, string | number | boolean>> & { readonly type: string };

export interface RemoteEventsPage {
  readonly events: readonly RemoteEvent[];
  readonly cursor: number;
  readonly active: boolean;
}

export interface RemoteControllerOptions {
  /** Started with `--remote`: lives for the whole Runner, with no lease. */
  readonly initial?: { readonly service: RemoteService; readonly settings: RemoteEnableSettings };
  /** Validates, protects and constructs (but does not start) an in-place service; throws to refuse. */
  readonly create: (settings: RemoteEnableSettings, emit: (event: RemoteEvent) => void, signal: AbortSignal) => Promise<RemoteService>;
  readonly leaseMs?: number;
}

interface InPlaceRemote {
  readonly service: RemoteService;
  readonly settings: RemoteEnableSettings;
  readonly abort: AbortController;
  live: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * Owns the Runner's Remote service: the one started with `--remote`, or one `aiboard remote` enabled in a
 * running Runner. Enable/disable serialize; a failed enable leaves the Runner without Remote.
 */
export class RemoteController {
  private inPlace: InPlaceRemote | undefined;
  private readonly queue: { readonly sequence: number; readonly event: RemoteEvent }[] = [];
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly leaseMs: number;

  constructor(private readonly options: RemoteControllerOptions) {
    this.leaseMs = options.leaseMs ?? REMOTE_IN_PLACE_LEASE_MS;
  }

  current(): RemoteService | undefined { return this.options.initial?.service ?? this.inPlace?.service; }

  active(): boolean { return !this.closed && this.current() !== undefined; }

  /** Idempotent for the same settings; a different relay is refused rather than switched underneath clients. */
  enable(settings: RemoteEnableSettings): Promise<void> { return this.serialize(() => this.enableNow(settings)); }

  disable(): Promise<void> {
    return this.serialize(async () => {
      if (this.options.initial) {
        throw new Error("remote_disable_refused: Remote started with this Runner; run `aiboard stop` to turn it off.");
      }
      await this.disableNow();
    });
  }

  /** Remote events after `cursor`; polling renews the in-place lease. */
  events(cursor: number): RemoteEventsPage {
    if (this.inPlace?.live && !this.closed) this.renewLease(this.inPlace);
    const events: RemoteEvent[] = [];
    let next = Math.min(cursor, this.sequence);
    let bytes = 0;
    for (const entry of this.queue) {
      if (entry.sequence <= cursor) continue;
      const size = JSON.stringify(entry.event).length;
      if (events.length >= MAX_EVENTS_PER_POLL || (events.length > 0 && bytes + size > MAX_EVENT_BYTES_PER_POLL)) break;
      bytes += size;
      events.push(entry.event);
      next = entry.sequence;
    }
    return { events, cursor: next, active: this.active() };
  }

  /** Runner shutdown: the in-place service first, then the startup one. Retryable. */
  async close(): Promise<void> {
    this.closed = true;
    await this.serialize(() => this.disableNow());
    await this.options.initial?.service.close();
  }

  private async enableNow(settings: RemoteEnableSettings): Promise<void> {
    if (this.closed) throw new Error("remote_unavailable: The Runner is stopping.");
    const existing = this.options.initial ?? this.inPlace;
    if (existing) {
      if (!sameSettings(existing.settings, settings)) {
        throw new Error("remote_settings_mismatch: Remote is already on in this Runner with different relay settings. Run `aiboard stop`, then run `aiboard remote` again.");
      }
      if (this.inPlace) this.renewLease(this.inPlace);
      return;
    }
    // Events belong to one in-place session: a later launcher never replays an earlier session's pairing or error.
    this.queue.length = 0;
    const abort = new AbortController();
    let entry: InPlaceRemote | undefined;
    const emit = (event: RemoteEvent) => { if (!entry || entry.live) this.push(event); };
    const service = await this.options.create(settings, emit, abort.signal);
    // The device owner lock is taken synchronously, before start() first awaits (pairing may then wait minutes).
    const starting = service.start();
    if (!service.holdsOwnerLock()) {
      const failure = await starting.then(() => undefined, (error: unknown) => error);
      abort.abort();
      await service.close();
      throw failure instanceof Error ? failure
        : new Error("remote_already_active: Another AIBoard Runner has Remote on for this device; stop that Runner first.");
    }
    entry = { service, settings, abort, live: true };
    const started = entry;
    this.inPlace = started;
    this.renewLease(started);
    starting.catch((error: unknown) => {
      if (!started.live) return;
      this.push(remoteErrorEvent(error));
      void this.serialize(async () => { if (this.inPlace === started) await this.disableNow(); }).catch(() => undefined);
    });
  }

  private async disableNow(): Promise<void> {
    const entry = this.inPlace;
    if (!entry) return;
    clearTimeout(entry.timer);
    // A deliberate stop is not a failure: the aborted pairing's rejection must not surface as an error event.
    entry.live = false;
    entry.abort.abort();
    // RemoteService.close is retryable: on failure the service stays recorded (still active) and the next disable or shutdown retries.
    await entry.service.close();
    this.inPlace = undefined;
  }

  private renewLease(entry: InPlaceRemote): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void this.serialize(async () => { if (this.inPlace === entry) await this.disableNow(); }).catch(() => undefined);
    }, this.leaseMs);
    entry.timer.unref();
  }

  private push(event: RemoteEvent): void {
    this.sequence += 1;
    this.queue.push({ sequence: this.sequence, event });
    if (this.queue.length > MAX_QUEUED_EVENTS) this.queue.shift();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }
}

function sameSettings(left: RemoteEnableSettings, right: RemoteEnableSettings): boolean {
  const path = (value: string) => process.platform === "win32" || process.platform === "darwin" ? resolve(value).toLowerCase() : resolve(value);
  return path(left.deviceDirectory) === path(right.deviceDirectory) && (left.relayUrl ?? "") === (right.relayUrl ?? "") &&
    left.relayRootKeys.length === right.relayRootKeys.length && left.relayRootKeys.every((key, index) => key === right.relayRootKeys[index]);
}

/** Same shape as the spawn path's `aiboard-remote-pairing-error` IPC message. */
function remoteErrorEvent(error: unknown): RemoteEvent {
  let message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  let code = error instanceof RemotePairingError ? error.code : "remote_enable_failed";
  const prefixed = /^([a-z][a-z0-9_]{0,63}): /.exec(message);
  if (prefixed) { if (!(error instanceof RemotePairingError)) code = prefixed[1]!; message = message.slice(prefixed[0].length); }
  return { type: "aiboard-remote-pairing-error", code, message: message.slice(0, 500) };
}
