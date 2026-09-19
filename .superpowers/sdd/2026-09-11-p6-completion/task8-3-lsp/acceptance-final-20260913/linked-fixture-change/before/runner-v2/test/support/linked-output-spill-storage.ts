import { createNodeOutputSpillStorage, type OutputSpillStorage } from "../../src/bounded-output-spool.js";
/** The original faulty fixture composition, retained temporarily to prove RED. */
export function createLinkedTestOutputSpillStorage(): OutputSpillStorage {
  return { ...createNodeOutputSpillStorage(), attest: async () => ({ currentPrincipalPrivacy: true, identityStableDeletion: true, unlinkedEntries: false }) };
}
