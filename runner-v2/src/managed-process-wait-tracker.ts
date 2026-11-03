import { createConnection } from "node:net";
import type { ManagedOutputCompletion, ManagedOutputEvidence, ManagedOutputUntil } from "./managed-process-contracts.js";
import type { ManagedOutputStreamName } from "./managed-process-output.js";
import { evaluateCompletion, renderPlain, timeoutCompletion } from "./managed-process-wait.js";

/** Bytes of each stream's newest retained output rendered for pattern and prompt checks. */
const TRACKED_TAIL_BYTES = 8 * 1024;
const PORT_PROBE_INTERVAL_MS = 250;
const PORT_PROBE_TIMEOUT_MS = 250;
/** How often the transport re-evaluates time-based conditions (idle, port). */
export const MANAGED_WAIT_RECHECK_MS = 200;

export interface ManagedWaitTracker {
  /** The transport's `satisfied` predicate: one evaluation per observation. */
  satisfied(evidence: ManagedOutputEvidence): boolean;
  /** Final labeled completion for the evidence the wait returned with. */
  completion(evidence: ManagedOutputEvidence): ManagedOutputCompletion;
  readonly usage: boolean;
  readonly recheckMs: number | undefined;
  close(): void;
}

export interface ManagedWaitTrackerInput {
  readonly until: ManagedOutputUntil;
  /** Output at or beyond these offsets counts as new for this wait. */
  readonly baseOffsets: Readonly<Record<ManagedOutputStreamName, number>>;
  readonly streams: readonly ManagedOutputStreamName[];
  readonly now?: () => number;
  readonly probePort?: (port: number) => Promise<boolean>;
}

/**
 * Stateful companion of evaluateCompletion for one wait: tracks output silence, the CPU window
 * that silence covers, the newest output tail and (for until.port) a loopback TCP probe.
 * Observation only: it never writes, signals or authorizes anything.
 */
export async function createManagedWaitTracker(input: ManagedWaitTrackerInput): Promise<ManagedWaitTracker> {
  const now = input.now ?? Date.now;
  const probe = input.probePort ?? probeLoopbackPort;
  const { until } = input;
  let preexistingPort = false, portOpen = false, probing = false, closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (until.port !== undefined) {
    const port = until.port;
    preexistingPort = await probe(port).catch(() => false);
    portOpen = preexistingPort;
    timer = setInterval(() => {
      if (probing || closed) return;
      probing = true;
      void probe(port).then(open => { portOpen = open; }, () => { portOpen = false; }).finally(() => { probing = false; });
    }, PORT_PROBE_INTERVAL_MS);
    timer.unref?.();
  }
  let lastTotals: Record<ManagedOutputStreamName, number> | undefined;
  let lastChangeAt = now();
  let lastChanged: ManagedOutputStreamName[] = [];
  let cpuBase: { totalMs: number; at: number } | undefined;
  let decided: ManagedOutputCompletion | undefined;

  const satisfied = (evidence: ManagedOutputEvidence): boolean => {
    if (decided) return true;
    const at = now();
    const totals = { stdout: 0, stderr: 0 } as Record<ManagedOutputStreamName, number>;
    for (const stream of evidence.streams) totals[stream.stream] = stream.totalBytes;
    if (!lastTotals) lastTotals = { ...input.baseOffsets };
    const grew = input.streams.filter(stream => totals[stream] > lastTotals![stream]);
    if (grew.length) { lastChangeAt = at; lastChanged = grew; cpuBase = undefined; }
    lastTotals = totals;
    if (evidence.cpu && !cpuBase) cpuBase = { totalMs: evidence.cpu.totalMs, at };
    // The CPU comparison covers only the window CPU evidence was sampled over.
    const cpuDeltaMs = evidence.cpu && cpuBase ? Math.max(0, evidence.cpu.totalMs - cpuBase.totalMs) : undefined;
    const quietMs = cpuDeltaMs !== undefined && cpuBase ? at - Math.max(lastChangeAt, cpuBase.at) : at - lastChangeAt;
    const tails = input.streams.map(stream => ({ stream, text: newTail(evidence, stream, input.baseOffsets[stream]) }));
    // Arrival order across two pipes is not guaranteed (a REPL's stdout result can spool after its
    // stderr prompt), so every stream with new output this wait counts; the latest-changed is preferred.
    const withNew = tails.filter(entry => entry.text.length);
    const recent = lastChanged.length ? withNew.filter(entry => lastChanged.includes(entry.stream)) : withNew;
    const plainNewTail = withNew.map(entry => entry.text).join("\n");
    const unterminated = (entry: { text: string }) => !entry.text.endsWith("\n");
    const promptLike = recent.find(unterminated) ?? withNew.find(unterminated) ?? recent[recent.length - 1];
    const lastLine = promptLike ? promptLike.text.slice(promptLike.text.lastIndexOf("\n") + 1) : "";
    const newBytes = input.streams.reduce((sum, stream) => sum + Math.max(0, totals[stream] - input.baseOffsets[stream]), 0);
    decided = evaluateCompletion({
      until, running: evidence.snapshot.status === "running", newBytes, quietMs,
      ...(cpuDeltaMs !== undefined ? { cpuDeltaMs } : {}),
      tailEndsWithNewline: withNew.length > 0 && withNew.every(entry => !unterminated(entry)),
      plainNewTail, lastLine,
      ...(until.port !== undefined ? { portOpen, preexistingPort } : {}),
    });
    return decided !== undefined;
  };

  return Object.freeze({
    satisfied,
    completion(evidence: ManagedOutputEvidence): ManagedOutputCompletion {
      if (!decided && evidence.snapshot.status !== "running") return Object.freeze({ source: "exited" as const, confidence: "certain" as const });
      return decided ?? timeoutCompletion();
    },
    usage: until.idleMs !== undefined,
    recheckMs: until.idleMs !== undefined || until.port !== undefined ? MANAGED_WAIT_RECHECK_MS : undefined,
    close() { closed = true; if (timer) clearInterval(timer); },
  });
}

/** Plain text of the bounded newest output of one stream at or after `base`. */
function newTail(evidence: ManagedOutputEvidence, stream: ManagedOutputStreamName, base: number): string {
  const value = evidence.streams.find(entry => entry.stream === stream);
  if (!value || value.totalBytes <= base) return "";
  const tailStart = value.totalBytes - value.tail.byteLength;
  let start = Math.max(base, tailStart, value.totalBytes - TRACKED_TAIL_BYTES) - tailStart;
  while (start < value.tail.byteLength && (value.tail[start]! & 0xc0) === 0x80) start++;
  return renderPlain(Buffer.from(value.tail.subarray(start)).toString("utf8"));
}

/** Something accepts TCP on 127.0.0.1 or ::1. Connect-and-close only; no bytes are sent. */
export async function probeLoopbackPort(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) if (await connects(host, port)) return true;
  return false;
}

function connects(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    const finish = (open: boolean) => { socket.removeAllListeners(); socket.destroy(); resolve(open); };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
