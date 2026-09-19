/** Test-only finalization policy. Callbacks must use the fixture's retained
 * capability and certify its complete release; a PID is never control authority.
 * This helper itself does not discover, signal, recover, or remove any resource.
 */
export async function finalizeCertifiedFixture(input: Readonly<{
  fixtureName: string;
  root: string;
  hasPrimaryFailure: boolean;
  primaryFailure?: unknown;
  cleanup(): Promise<void>;
  certify(): Promise<void>;
  removeRoot(): Promise<void> | void;
}>): Promise<void> {
  try {
    await input.cleanup();
    await input.certify();
  } catch (cleanupFailure) {
    throw new AggregateError(
      input.hasPrimaryFailure ? [input.primaryFailure, cleanupFailure] : [cleanupFailure],
      `${input.fixtureName} cleanup remains unverified; exact evidence retained at ${input.root}.`,
    );
  }
  if (input.hasPrimaryFailure) throw input.primaryFailure;
  await input.removeRoot();
}
