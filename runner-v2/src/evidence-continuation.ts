import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "./artifact-store.js";
import type { BoundedOutputSpoolResult } from "./bounded-output-spool.js";
import type { EvidenceSpoolSink } from "./protocol-evidence-tee.js";
import type { StreamingOutputMetadata } from "./streaming-output-controller.js";
import { getStreamingSessionKernelWriter, type OutputCheckpointRecord, type StreamingSessionStoreKernel } from "./streaming-session-store.js";

// Independent ceilings bound payload retention and tiny-chunk amplification.
// Once exhausted, only the fixed-size checkpoint position/loss fields advance.
export const EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;
export const EVIDENCE_MAX_PAGES = 4096;
const PAGE_MAX_BYTES = 4096;
type Position = Readonly<{ stream: "stdout" | "stderr"; last: StreamingOutputMetadata | null; lostBytes: number }>;
export interface EvidenceContinuation {
  readonly version: 1;
  readonly evidenceId: string;
  readonly head: string | null;
  readonly pages: number;
  readonly retainedBytes: number;
  readonly loss: "none" | "legacy_gap" | "capacity" | "storage" | "legacy_gap_capacity" | "legacy_gap_storage";
  readonly legacyHashes: readonly string[];
  readonly positions: readonly Position[];
  readonly finalized: Readonly<{ manifestHash: string; resultHash: string; legacyHead: string | null; lossy: boolean }> | null;
}
interface Page {
  readonly version: 1;
  readonly evidenceId: string;
  readonly previousHash: string | null;
  readonly segmentHash: string;
  readonly metadata: StreamingOutputMetadata;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fail = (): never => { throw new Error("Authenticated evidence continuation is unavailable."); };
const exact = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) return fail();
  return value as Record<string, unknown>;
}
function metadata(value: unknown): StreamingOutputMetadata {
  const item = object(value, ["stream", "sequence", "startOffset", "endOffset", "byteLength", "digest"]);
  if ((item.stream !== "stdout" && item.stream !== "stderr") || !integer(item.sequence) || item.sequence < 1 || !integer(item.startOffset) ||
      !integer(item.endOffset) || !integer(item.byteLength) || item.byteLength < 1 || item.endOffset - item.startOffset !== item.byteLength || !isHash(item.digest)) return fail();
  return { stream: item.stream, sequence: item.sequence, startOffset: item.startOffset, endOffset: item.endOffset, byteLength: item.byteLength, digest: item.digest };
}
export function parseEvidenceContinuation(value: unknown): EvidenceContinuation {
  const item = object(value, ["version", "evidenceId", "head", "pages", "retainedBytes", "loss", "legacyHashes", "positions", "finalized"]);
  if (item.version !== 1 || typeof item.evidenceId !== "string" || !/^[a-f0-9-]{36}$/.test(item.evidenceId) ||
      (item.head !== null && !isHash(item.head)) || !integer(item.pages) || item.pages > EVIDENCE_MAX_PAGES ||
      !integer(item.retainedBytes) || item.retainedBytes > EVIDENCE_MAX_BYTES || (item.head === null) !== (item.pages === 0) ||
      !["none", "legacy_gap", "capacity", "storage", "legacy_gap_capacity", "legacy_gap_storage"].includes(item.loss as string) || !Array.isArray(item.positions) || item.positions.length !== 2 ||
      !Array.isArray(item.legacyHashes) || item.legacyHashes.length > 12288 || item.legacyHashes.some((value) => !isHash(value)) || new Set(item.legacyHashes).size !== item.legacyHashes.length) return fail();
  const positions = item.positions.map((value, index) => {
    const p = object(value, ["stream", "last", "lostBytes"]);
    if (p.stream !== ["stdout", "stderr"][index] || !integer(p.lostBytes)) return fail();
    const last = p.last === null ? null : metadata(p.last);
    if ((last && last.stream !== p.stream) || p.lostBytes > (last?.endOffset ?? 0)) return fail();
    return { stream: p.stream as Position["stream"], last, lostBytes: p.lostBytes };
  });
  if (positions.reduce((sum, p) => sum + (p.last?.endOffset ?? 0) - p.lostBytes, 0) !== item.retainedBytes ||
      (item.loss === "none") !== positions.every((p) => p.lostBytes === 0)) return fail();
  if (item.finalized !== null) {
    const final = object(item.finalized, ["manifestHash", "resultHash", "legacyHead", "lossy"]);
    if (!isHash(final.manifestHash) || !isHash(final.resultHash) || (final.legacyHead !== null && !isHash(final.legacyHead)) ||
        (final.legacyHead === null) !== (item.legacyHashes.length === 0) || typeof final.lossy !== "boolean" || (item.loss !== "none" && !final.lossy)) return fail();
  }
  return structuredClone({ ...item, positions }) as unknown as EvidenceContinuation;
}
export function initialEvidenceContinuation(checkpoint?: OutputCheckpointRecord): EvidenceContinuation {
  const positions = (["stdout", "stderr"] as const).map((stream) => {
    const last = checkpoint?.streams.find((p) => p.stream === stream)?.lastConsumed ?? null;
    return { stream, last, lostBytes: last?.endOffset ?? 0 };
  });
  return { version: 1, evidenceId: randomUUID(), head: null, pages: 0, retainedBytes: 0,
    // Preserve only hashes already reachable from this authenticated checkpoint;
    // these links do not assert that historical bytes have been recovered.
    legacyHashes: [...new Set(checkpoint?.streams.flatMap((s) => [...s.consumed, ...s.accepted].map((m) => m.digest)) ?? [])],
    loss: positions.some((p) => p.lostBytes > 0) ? "legacy_gap" : "none", positions, finalized: null };
}
const summary = (state: EvidenceContinuation) => ({ loss: state.loss, positions: state.positions, retainedBytes: state.retainedBytes, pages: state.pages });
async function verifiedArtifactBytes(artifacts: ArtifactStore, digest: string, maximum: number) {
  const stat = await artifacts.stat(digest);
  if (stat.byteLength > maximum || stat.byteLength < 0) return fail();
  const bytes = await artifacts.get(digest);
  if (bytes.byteLength !== stat.byteLength || hash(bytes) !== digest) return fail();
  return bytes;
}

async function verifiedSegments(artifacts: ArtifactStore, state: EvidenceContinuation) {
  const pages: Page[] = []; let head = state.head; let bytes = 0;
  while (head !== null) {
    if (pages.length >= state.pages) return fail();
    const item = object(JSON.parse((await verifiedArtifactBytes(artifacts, head, PAGE_MAX_BYTES)).toString()), ["version", "evidenceId", "previousHash", "segmentHash", "metadata"]);
    if (item.version !== 1 || item.evidenceId !== state.evidenceId || !isHash(item.segmentHash) || (item.previousHash !== null && !isHash(item.previousHash))) return fail();
    const chunk = metadata(item.metadata);
    if (chunk.digest !== item.segmentHash) return fail();
    bytes += chunk.byteLength;
    if (bytes > state.retainedBytes) return fail();
    pages.push({ ...item, metadata: chunk } as unknown as Page); head = item.previousHash;
  }
  if (pages.length !== state.pages || bytes !== state.retainedBytes) return fail();
  const last = new Map<string, StreamingOutputMetadata>();
  const verified: Array<{ stream: "stdout" | "stderr"; bytes: Buffer }> = [];
  for (const page of pages.reverse()) {
    const previous = last.get(page.metadata.stream);
    if (previous && (page.metadata.sequence !== previous.sequence + 1 || page.metadata.startOffset !== previous.endOffset)) return fail();
    last.set(page.metadata.stream, page.metadata);
    const segment = await verifiedArtifactBytes(artifacts, page.segmentHash, Math.min(EVIDENCE_MAX_BYTES, page.metadata.byteLength));
    if (segment.byteLength !== page.metadata.byteLength) return fail();
    verified.push({ stream: page.metadata.stream, bytes: segment });
  }
  for (const p of state.positions) {
    const end = last.get(p.stream);
    const retained = verified.filter((segment) => segment.stream === p.stream).reduce((sum, segment) => sum + segment.bytes.byteLength, 0);
    if (retained !== (p.last?.endOffset ?? 0) - p.lostBytes ||
        (end && (end.endOffset > (p.last?.endOffset ?? 0) || end.sequence > (p.last?.sequence ?? 0)))) return fail();
    if (state.loss === "none" && !exact(end ?? null, p.last)) return fail();
  }
  return verified;
}
export async function verifyFinalizedEvidence(artifacts: ArtifactStore, value: EvidenceContinuation): Promise<BoundedOutputSpoolResult> {
  try {
    const state = parseEvidenceContinuation(value);
    if (!state.finalized) return fail();
    await verifiedSegments(artifacts, state);
    const manifest = JSON.parse((await verifiedArtifactBytes(artifacts, state.finalized.manifestHash, PAGE_MAX_BYTES)).toString());
    if (!exact(manifest, { version: 1, evidenceId: state.evidenceId, previousHash: state.head, resultHash: state.finalized.resultHash, legacyHead: state.finalized.legacyHead, summary: summary(state) })) return fail();
    const batches: string[][] = []; let legacyHead = state.finalized.legacyHead;
    while (legacyHead) {
      if (batches.length >= Math.ceil(state.legacyHashes.length / 32)) return fail();
      const page = object(JSON.parse((await verifiedArtifactBytes(artifacts, legacyHead, PAGE_MAX_BYTES)).toString()), ["version", "evidenceId", "previousHash", "artifactHashes"]);
      if (page.version !== 1 || page.evidenceId !== state.evidenceId || (page.previousHash !== null && !isHash(page.previousHash)) || !Array.isArray(page.artifactHashes) || page.artifactHashes.length < 1 || page.artifactHashes.length > 32 || page.artifactHashes.some((h) => !isHash(h))) return fail();
      batches.push(page.artifactHashes as string[]); legacyHead = page.previousHash;
    }
    if (!exact(batches.reverse().flat(), state.legacyHashes)) return fail();
    const result = JSON.parse((await verifiedArtifactBytes(artifacts, state.finalized.resultHash, 2 * 1024 * 1024)).toString()) as BoundedOutputSpoolResult;
    if (!Array.isArray(result.streams) || result.streams.length !== 2 || result.streams.some((stream, index) => {
      const position = state.positions[index]!;
      return stream.stream !== position.stream || stream.totalBytes !== (position.last?.endOffset ?? 0) ||
        !integer(stream.lossyBytes) || stream.lossyBytes < position.lostBytes || stream.lossyBytes > stream.totalBytes ||
        stream.lossyOutput !== (stream.lossyBytes > 0);
    }) || state.finalized.lossy !== (state.loss !== "none" || result.streams.some((stream) => stream.lossyOutput))) return fail();
    return result;
  } catch { return fail(); }
}
export function createEvidenceContinuation(options: {
  kernel: StreamingSessionStoreKernel; sessionId: string; ownerId: string; fencingToken: number;
  artifacts: ArtifactStore; spool: EvidenceSpoolSink;
}) {
  const writer = getStreamingSessionKernelWriter(options.kernel);
  const current = () => {
    const record = options.kernel.store.readOutputCheckpoint(options.sessionId);
    if (!record || record.ownerId !== options.ownerId || record.fencingToken !== options.fencingToken || record.outcome !== "active") return fail();
    return record;
  };
  const commit = (record: OutputCheckpointRecord, continuation: EvidenceContinuation) => writer.applyOutputCheckpoint({
    type: "commit_continuation", sessionId: options.sessionId, ownerId: options.ownerId, fencingToken: options.fencingToken,
    expectedRevision: record.revision, continuation,
  });
  const initial = current();
  if (!initial.continuation) commit(initial, initialEvidenceContinuation(initial));
  let restored = false;
  let spooledHead: string | null = null;
  let restoringSpoolFailed = false;
  let tail = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const call = tail.then(operation); tail = call.then(() => undefined, () => undefined); return call;
  };
  const restore = async () => {
    if (restoringSpoolFailed) return fail();
    if (restored) { if (current().continuation!.head !== spooledHead) return fail(); return; }
    const record = current(); const state = record.continuation!;
    const verified = await verifiedSegments(options.artifacts, state);
    if (current().continuation!.head !== state.head) return fail();
    try { for (const segment of verified) await options.spool.write(segment.stream, segment.bytes); }
    catch (error) { restoringSpoolFailed = true; throw error; }
    if (current().continuation!.head !== state.head) { restoringSpoolFailed = true; return fail(); }
    spooledHead = state.head; restored = true;
  };
  return {
    writeChunk(chunk: StreamingOutputMetadata, input: Uint8Array) {
      return serialized(async () => {
        const parsed = metadata(chunk);
        if (input.byteLength !== parsed.byteLength || hash(input) !== parsed.digest) return fail();
        await restore();
        const record = current(); const state = record.continuation!;
        const position = state.positions.find((p) => p.stream === chunk.stream)!;
        if (chunk.sequence <= (position.last?.sequence ?? 0)) {
          if (exact(position.last, parsed) || record.streams.some((s) => [...s.accepted, ...s.consumed].some((m) => exact(m, parsed)))) return;
          return fail();
        }
        if (state.finalized || parsed.sequence !== (position.last?.sequence ?? 0) + 1 || parsed.startOffset !== (position.last?.endOffset ?? 0)) return fail();
        let head = state.head; let loss = state.loss; let retained = false;
        if ((loss === "none" || loss === "legacy_gap") && state.pages < EVIDENCE_MAX_PAGES && state.retainedBytes + input.byteLength <= EVIDENCE_MAX_BYTES) {
          try {
            const segment = await options.artifacts.put(input, "application/octet-stream");
            await options.artifacts.verify(segment.hash);
            if (segment.hash !== parsed.digest) return fail();
            const page = Buffer.from(JSON.stringify({ version: 1, evidenceId: state.evidenceId, previousHash: head, segmentHash: segment.hash, metadata: parsed } satisfies Page));
            if (page.byteLength > PAGE_MAX_BYTES) return fail();
            const manifest = await options.artifacts.put(page, "application/json");
            await options.artifacts.verify(manifest.hash);
            head = manifest.hash; retained = true;
          } catch { loss = loss === "legacy_gap" ? "legacy_gap_storage" : "storage"; }
        } else if (loss === "none" || loss === "legacy_gap") loss = loss === "legacy_gap" ? "legacy_gap_capacity" : "capacity";
        const next = { ...state, head, loss, pages: state.pages + (retained ? 1 : 0), retainedBytes: state.retainedBytes + (retained ? input.byteLength : 0),
          positions: state.positions.map((p) => p.stream === parsed.stream ? { ...p, last: parsed, lostBytes: p.lostBytes + (retained ? 0 : input.byteLength) } : p) };
        // Original revision is intentional: takeover or concurrent mutation after
        // artifact writes leaves only uncommitted, unreachable orphan artifacts.
        commit(record, next);
        spooledHead = next.head;
        if (retained) try { await options.spool.write(parsed.stream, input); }
        catch (error) { restoringSpoolFailed = true; throw error; }
      });
    },
    finalize() {
      return serialized(async (): Promise<BoundedOutputSpoolResult> => {
        await restore();
        const record = current(); const state = record.continuation!;
        if (state.finalized) {
          return verifyFinalizedEvidence(options.artifacts, state);
        }
        const result = await options.spool.finalize?.() as BoundedOutputSpoolResult | undefined;
        if (!result || !Array.isArray(result.streams)) return fail();
        const streams = result.streams.map((stream) => {
          const lost = state.positions.find((p) => p.stream === stream.stream)!.lostBytes;
          return lost ? { ...stream, totalBytes: stream.totalBytes + lost, lossyBytes: stream.lossyBytes + lost, lossyOutput: true,
            lossReason: stream.lossReason ?? { code: "evidence_continuation_loss" as const, stream: stream.stream, lostBytes: lost },
            lossReasons: [...stream.lossReasons, { code: "evidence_continuation_loss" as const, stream: stream.stream, lostBytes: lost }],
          } : stream;
        });
        const finalResult = { streams };
        const lossy = state.loss !== "none" || streams.some((stream) => stream.lossyOutput);
        const artifact = await options.artifacts.put(Buffer.from(JSON.stringify(finalResult)), "application/json");
        await options.artifacts.verify(artifact.hash);
        let legacyHead: string | null = null;
        for (let index = 0; index < state.legacyHashes.length; index += 32) {
          const page = await options.artifacts.put(Buffer.from(JSON.stringify({ version: 1, evidenceId: state.evidenceId, previousHash: legacyHead, artifactHashes: state.legacyHashes.slice(index, index + 32) })), "application/json");
          await options.artifacts.verify(page.hash); legacyHead = page.hash;
        }
        const manifest = await options.artifacts.put(Buffer.from(JSON.stringify({ version: 1, evidenceId: state.evidenceId, previousHash: state.head, resultHash: artifact.hash, legacyHead, summary: summary(state) })), "application/json");
        await options.artifacts.verify(manifest.hash);
        commit(record, { ...state, finalized: { manifestHash: manifest.hash, resultHash: artifact.hash, legacyHead, lossy } });
        return finalResult;
      });
    },
    cleanup: async () => { await tail; await options.spool.cleanup?.(); },
  };
}
