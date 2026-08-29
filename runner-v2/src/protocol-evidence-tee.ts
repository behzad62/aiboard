import type { OutputStream } from "./bounded-output-spool.js";
import type { BoundedOutputSpoolResult } from "./bounded-output-spool.js";
import type { BoundedProtocolQueue } from "./bounded-protocol-queue.js";

export interface EvidenceSpoolSink {
  write(stream: OutputStream, bytes: Uint8Array): Promise<void>;
  finalize?(): Promise<BoundedOutputSpoolResult | unknown>;
  cleanup?(): Promise<void>;
}
export function createProtocolEvidenceTee(options: { readonly queue: BoundedProtocolQueue; readonly spool: EvidenceSpoolSink }) {
  let evidenceLossy = false;
  return Object.freeze({
    async write(stream: OutputStream, input: Uint8Array, protocolBearing: boolean) {
      if (protocolBearing) await options.queue.push(input);
      try {
        await options.spool.write(stream, input);
        return Object.freeze({ evidenceLossy: false as const });
      } catch {
        evidenceLossy = true;
        return Object.freeze({ evidenceLossy: true as const, reason: "evidence_write_failed" as const });
      }
    },
    async writeEvidence(stream: OutputStream, input: Uint8Array) {
      try { await options.spool.write(stream, input); return Object.freeze({ evidenceLossy: false as const }); }
      catch { evidenceLossy = true; return Object.freeze({ evidenceLossy: true as const, reason: "evidence_write_failed" as const }); }
    },
    async finalize() {
      if (!options.spool.finalize) { evidenceLossy = true; return Object.freeze({ evidenceLossy, result: undefined }); }
      try {
        const result = await options.spool.finalize();
        if (result && typeof result === "object" && "streams" in result && Array.isArray(result.streams)) evidenceLossy ||= result.streams.some((stream: unknown) => Boolean(stream && typeof stream === "object" && "lossyOutput" in stream && stream.lossyOutput === true));
        return Object.freeze({ evidenceLossy, result });
      }
      catch (error) { evidenceLossy = true; return Object.freeze({ evidenceLossy, error }); }
    },
    async cleanup() { if (options.spool.cleanup) await options.spool.cleanup(); },
    snapshot() { return Object.freeze({ evidenceLossy }); },
  });
}
