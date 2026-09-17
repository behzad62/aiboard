import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

export async function finalizeRealStreamingFixture(input: Readonly<{
  fixtureName: string;
  root: string;
  owner?: Readonly<{
    cleanupOutstandingForTest(): Promise<void>;
    kernel: Readonly<{ store: Readonly<{ close(): void }> }>;
  }>;
  primaryFailure?: unknown;
  hasPrimaryFailure?: boolean;
}>): Promise<void> {
  const hasPrimaryFailure = input.hasPrimaryFailure ?? input.primaryFailure !== undefined;
  const cleanupFailures: unknown[] = [];
  let rootRemovalAttempted = false;
  if (!input.owner) {
    cleanupFailures.push(new Error("Fixture cleanup owner is unavailable."));
  } else {
    try {
      await input.owner.cleanupOutstandingForTest();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      input.owner.kernel.store.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length === 0 && !hasPrimaryFailure && existsSync(input.root)) {
    rootRemovalAttempted = true;
    try {
      await rm(input.root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      hasPrimaryFailure ? [input.primaryFailure, ...cleanupFailures] : cleanupFailures,
      rootRemovalAttempted
        ? `${input.fixtureName} fixture root removal could not be verified: ${input.root}.`
        : `${input.fixtureName} fixture cleanup could not be verified; its exact root was preserved at ${input.root}.`,
    );
  }
  if (hasPrimaryFailure) throw input.primaryFailure;
}
