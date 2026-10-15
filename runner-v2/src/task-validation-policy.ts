/**
 * IV-2 (CD-23/EP16): validation policy wired into task acceptance, plus the
 * one test-execution scope decision shared by the high-tier depth runner and
 * the integrated-boundary driver so they cannot drift.
 *
 * EP16 rule, enforced mechanically (never by model assertion):
 * - The default full suite belongs to the final candidate. A normal task
 *   reaching boundary acceptance does NOT become packet-required full
 *   merely for reaching acceptance; only an explicit structured mandate
 *   naming the full-suite gate now forces full execution.
 * - Conflicting mandates fail closed (throw, surfacing to the pump); the
 *   runner never silently picks a scope.
 * - Packet-required criteria must pass for acceptance; explicitly
 *   final-gate criteria stay visibly pending without blocking it.
 *
 * Honest mandate sources (2026-10-05): the scheduler carries no durable
 * structured validation-mandate store and no milestone/merge-group
 * validation hook, so none is invented here. BuildRuntime accepts explicit
 * mandates through its options (default: none); the NativeBuildFactory
 * passes none. The broader gates stay full by construction: final
 * verification runs its own full profile through FinalVerificationRuntime
 * (untouched by selection), and the test-integrity baseline capture runs
 * the whole test script. Task-contract validation rationales are prose and
 * are never parsed for mandates.
 */

import {
  FULL_SUITE_GATE,
  partitionPacketVsFinal,
  resolveValidationMandates,
  type MandateResolution,
  type PacketCriterion,
  type PacketReadiness,
  type ValidationMandate,
} from "./validation-policy.js";
import { isSelectableAffectedRung } from "./delivery-acceptance.js";
import type { DeliveryBoundaryScope, DeliveryExecutedScope } from "./delivery-acceptance.js";
import type { SelectedTestsCommandResult } from "./final-verification-profile.js";
import type { SchedulerProjection } from "./scheduler-store.js";

/** Explicit structured mandates (default: none; see the header note). */
export interface TaskValidationMandates {
  readonly sourceMandates: readonly ValidationMandate[];
  readonly projectMandates: readonly ValidationMandate[];
}

export interface ExecutionMandateResolution {
  readonly resolution: MandateResolution;
  /** True only when a required mandate names the full-suite gate now. */
  readonly forceFullSuite: boolean;
}

/**
 * Resolve whether the current acceptance step must run the full suite.
 * Throws on conflicting mandates (fail closed, never a silent pick).
 * With no mandates and no final candidate, the default full suite is NOT
 * required: it belongs to the final candidate.
 */
export function resolveExecutionMandates(input: {
  readonly mandates?: TaskValidationMandates;
  readonly isFinalCandidate: boolean;
}): ExecutionMandateResolution {
  const resolution = resolveValidationMandates({
    sourceMandates: input.mandates?.sourceMandates ?? [],
    projectMandates: input.mandates?.projectMandates ?? [],
    isFinalCandidate: input.isFinalCandidate,
  });
  if (resolution.conflicts.length > 0) {
    const detail = resolution.conflicts
      .map((conflict) => `${conflict.id} at scopes ${conflict.scopes.join("/")}`)
      .join("; ");
    throw new Error(`Validation mandates conflict (${detail}); refusing to pick a scope silently.`);
  }
  return {
    resolution,
    forceFullSuite: resolution.required.some((mandate) => mandate.gate === FULL_SUITE_GATE),
  };
}

/**
 * Whether the run durably holds a green final-verification submission for
 * the current integration revision. Presence of a validated submission
 * means every required final check was mechanically green.
 */
export function finalSuiteVerified(projection: SchedulerProjection): boolean {
  const generations = [
    ...(projection.finalVerification?.current ? [projection.finalVerification.current] : []),
    ...(projection.finalVerification?.history ?? []),
  ];
  return generations.some((generation) =>
    generation.state === "current" &&
    generation.targetRevision === projection.integrationRevision &&
    generation.submissionResult !== undefined,
  );
}

/**
 * Durable packet/final criteria for one task acceptance: every boundary
 * check of the current boundary is packet-required (an unknown outcome is
 * pending proof, never a pass), and the full suite is the explicitly
 * final-gate criterion.
 */
export function packetCriteriaForTask(input: {
  readonly boundary: DeliveryBoundaryScope;
  readonly finalVerified: boolean;
}): PacketCriterion[] {
  const criteria: PacketCriterion[] = input.boundary.checks.map((check) => ({
    id: `boundary:${check.checkId}`,
    gate: "packet" as const,
    status: check.outcome === "passed" ? "passed" as const : check.outcome === "failed" ? "failed" as const : "pending" as const,
  }));
  criteria.push({
    id: "final_full_suite",
    gate: "final",
    status: input.finalVerified ? "passed" : "pending",
  });
  return criteria;
}

/**
 * Partition packet-required vs final-gate criteria. Packet-required
 * failures block acceptance; final-gate pending criteria never do.
 */
export function assessPacketReadiness(criteria: readonly PacketCriterion[]): PacketReadiness {
  return partitionPacketVsFinal(criteria);
}

export interface TestExecutionSelection {
  readonly rung: string;
  readonly widened: boolean;
  readonly tests: readonly string[];
}

export interface TestExecutionScopeDecision {
  readonly scope: DeliveryExecutedScope;
  readonly reason: string;
}

/**
 * The one execution-scope decision. `selected` only when every condition
 * holds: no mandate forces full, the rung is narrowable (the same
 * vocabulary the kernel coherence rule enforces), no widening trigger
 * applies, the selection names tests, and a safe selective command was
 * derived. Every other case runs the existing whole test script (fail
 * safe). `no_tests_required` and empty selections are never fabricated
 * into selected execution.
 */
export function decideTestExecutionScope(input: {
  readonly selection: TestExecutionSelection;
  readonly forceFullSuite: boolean;
  readonly selectiveCommand: SelectedTestsCommandResult;
}): TestExecutionScopeDecision {
  if (input.forceFullSuite) {
    return { scope: "full_test_script", reason: "A validation mandate requires the full suite now." };
  }
  if (!isSelectableAffectedRung(input.selection.rung)) {
    return { scope: "full_test_script", reason: `Selection rung ${JSON.stringify(input.selection.rung)} is not narrowable; the whole test script runs.` };
  }
  if (input.selection.widened) {
    return { scope: "full_test_script", reason: "A widening trigger applies; the whole test script runs." };
  }
  if (input.selection.tests.length === 0) {
    return { scope: "full_test_script", reason: "The selection names no tests; the whole test script runs." };
  }
  if (!input.selectiveCommand.selectable) {
    return { scope: "full_test_script", reason: `No safe selective command: ${input.selectiveCommand.reason}` };
  }
  return {
    scope: "selected",
    reason: `Rung ${input.selection.rung} runs ${input.selection.tests.length} selected test(s) through a safe selective command.`,
  };
}
