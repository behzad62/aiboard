// Implement the service described in contract.d.ts and runtime-contract.md.
// This file is the complete editable submission; no imports are available.
globalThis.createService = async function createService(ports, grant) {
  return {
    async run(request) { return { kind: "blocked", blockers: [{ code: "unsupported" }], failures: [] }; },
    subscribe(jobId, listener) { return { id: "00000000000000000000000000000000", unsubscribe() {} }; }
  };
};
