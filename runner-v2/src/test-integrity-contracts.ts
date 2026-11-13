import type { DeliveryTestReport } from "./delivery-acceptance.js";
import type { VerificationNotRun } from "./final-verification-contracts.js";
import type { TestIntegrityBinding, TestIntegrityException, TestIntegrityPin } from "./test-integrity.js";

interface TestIntegrityBaselineCommon {
  pin: TestIntegrityPin;
  pinDigest: string;
  evidenceIds: string[];
  sequence: number;
  acceptedTaskId?: string;
}
export type TestIntegrityBaseline = TestIntegrityBaselineCommon & (
  | { kind: "executed_report"; executed: number; report: DeliveryTestReport }
  | { kind: "no_configured_test_suite"; inventory: string; inventoryDigest: string }
  /** VF2: the initial tests could not run because their tool is missing; no counts, no evidence. */
  | { kind: "tool_missing"; notRun: VerificationNotRun }
);

export type TestIntegrityBaselineInput = TestIntegrityBaseline extends infer B ? B extends TestIntegrityBaseline ? Omit<B, "sequence" | "acceptedTaskId"> : never : never;

export interface TestIntegrityBoundary extends TestIntegrityBinding {
  version: 1;
  candidatePin: TestIntegrityPin;
  candidateExecuted?: number;
  exceptionId?: string;
}

export interface TestIntegrityState {
  version: 1;
  initialRevision?: string;
  architectActorId?: string;
  baseline?: TestIntegrityBaseline;
  exceptions: Record<string, TestIntegrityException>;
}

/** Separate from ordinary findings or Architect-written dispositions. */
export interface TestConsolidationDisposition {
  id: string;
  disposition: "obsolete" | "merged";
  affectedTestIds: string[];
  behaviorProof: string;
  reason: string;
  planRevisionId: string;
  planDigest: string;
  baselinePinDigest: string;
  candidatePinDigest: string;
  allowedChanges: Array<"test_command_changed" | "test_config_changed" | "suite_shrank">;
  minimumExecuted: number;
}
