import type { OutputStream } from "./bounded-output-spool.js";
import type { BoundedProtocolQueue } from "./bounded-protocol-queue.js";

export interface EvidenceSpoolSink { write(stream: OutputStream, bytes: Uint8Array): Promise<void> }
export function createProtocolEvidenceTee(options: { readonly queue: BoundedProtocolQueue; readonly spool: EvidenceSpoolSink }) {
  return Object.freeze({
    async write(stream: OutputStream, input: Uint8Array, protocolBearing: boolean) {
      const protocol = Buffer.from(input);
      const evidence = Buffer.from(input);
      if (protocolBearing) await options.queue.push(protocol);
      try {
        await options.spool.write(stream, evidence);
        return Object.freeze({ evidenceLossy: false as const });
      } catch {
        return Object.freeze({ evidenceLossy: true as const, reason: "evidence_write_failed" as const });
      } finally {
        evidence.fill(0);
      }
    },
  });
}
