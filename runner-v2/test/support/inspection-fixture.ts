import { finalizeCertifiedFixture } from "./certified-fixture-cleanup.js";

/** Test creator escrow: workload/output/release proof precedes helper close and root removal. */
export async function withInspectionFixture(input: Readonly<{
  fixtureName: string;
  root: string;
  registerCleanup(register: (cleanup: (absoluteDeadline: number) => Promise<void>) => void): void;
  body(): Promise<void>;
  cleanupWorkloads(): Promise<void>;
  certifyWorkloads(): Promise<void>;
  removeRoot(): void | Promise<void>;
}>): Promise<void> {
  let inspection: ((absoluteDeadline: number) => Promise<void>) | undefined;
  input.registerCleanup(cleanup => {
    if (inspection) throw new Error("Fixture inspection owner was registered twice.");
    inspection = cleanup;
  });
  let hasPrimaryFailure = false;
  let primaryFailure: unknown;
  try { await input.body(); }
  catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  await finalizeCertifiedFixture({
    fixtureName: input.fixtureName,
    root: input.root,
    hasPrimaryFailure,
    primaryFailure,
    cleanup: async () => {
      await input.cleanupWorkloads();
      await input.certifyWorkloads();
      await inspection?.(Date.now() + 5_000);
    },
    certify: async () => undefined,
    removeRoot: input.removeRoot,
  });
}
