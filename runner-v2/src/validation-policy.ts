/**
 * Validation policy (Runner V2 P6.6 T5, EP15/EP16).
 *
 * Pure, deterministic, zero model calls. Derives validation intent from
 * acceptance behavior, orders exact failures before affected scope, resolves
 * required mandates from source/project policy, dispositions inherited
 * baseline failures explicitly, and partitions packet-required vs final-gate
 * criteria.
 *
 * Reuses T1's frozen `ValidationIntent` / `ValidationScope` vocabulary from
 * planning-contracts.ts; this module never redefines it.
 */
import {
  validateValidationIntent,
  type ValidationIntent,
  type ValidationScope,
} from "./planning-contracts.js";

// ---------------------------------------------------------------------------
// Acceptance behavior -> validation intent (EP15)
// ---------------------------------------------------------------------------

export interface AcceptanceBehaviorInput {
  readonly id: string;
  readonly acceptanceConditionIds: readonly string[];
  readonly intendedBehavior: string;
  readonly assertions: readonly string[];
  /** Downstream consumers whose contracts this behavior can break. */
  readonly consumers: readonly string[];
  /** Contracts/schemas touched (names, not prose). */
  readonly contracts: readonly string[];
  readonly configImpact: boolean;
  readonly schemaImpact: boolean;
  readonly securityImpact: boolean;
  readonly isolationImpact: boolean;
  /** True when this intent reproduces an exact observed failure. */
  readonly isExactFailure: boolean;
}

export interface DerivedValidationIntent {
  readonly intent: ValidationIntent;
  /** True for exact-failure intents (ordered first by orderValidationIntents). */
  readonly isExactFailure: boolean;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Derive one validation intent per acceptance behavior. Scope is mechanical:
 * exact failures are `targeted`; behaviors with consumer/contract/config/
 * schema/security/isolation impact are `affected`; callers requesting the
 * final candidate pass `defaultScope: "final"` explicitly. The scopeReason
 * always names the concrete impact dimensions so a reviewer can inspect it.
 */
export function deriveValidationIntents(
  behaviors: readonly AcceptanceBehaviorInput[],
  options: { readonly defaultScope?: ValidationScope } = {},
): DerivedValidationIntent[] {
  if (!Array.isArray(behaviors)) {
    throw new Error("deriveValidationIntents requires a behaviors array.");
  }
  return behaviors.map((behavior, index) => {
    if (
      typeof behavior !== "object" || behavior === null ||
      !nonEmpty((behavior as { id?: unknown }).id) ||
      !isStringArray(behavior.acceptanceConditionIds) || behavior.acceptanceConditionIds.length === 0 ||
      !nonEmpty(behavior.intendedBehavior) ||
      !isStringArray(behavior.assertions) || behavior.assertions.length === 0 ||
      !isStringArray(behavior.consumers) ||
      !isStringArray(behavior.contracts)
    ) {
      throw new Error(`Acceptance behavior ${index} is malformed (requires id, acceptanceConditionIds, intendedBehavior, assertions, consumers, contracts).`);
    }
    const impacts: string[] = [];
    if (behavior.consumers.length > 0) impacts.push(`consumers(${[...behavior.consumers].sort().join(",")})`);
    if (behavior.contracts.length > 0) impacts.push(`contracts(${[...behavior.contracts].sort().join(",")})`);
    if (behavior.configImpact) impacts.push("config");
    if (behavior.schemaImpact) impacts.push("schema");
    if (behavior.securityImpact) impacts.push("security");
    if (behavior.isolationImpact) impacts.push("isolation");
    const scope: ValidationScope = behavior.isExactFailure
      ? "targeted"
      : options.defaultScope ?? (impacts.length > 0 ? "affected" : "targeted");
    const scopeReason = behavior.isExactFailure
      ? `Exact failure reproduction for ${behavior.id}; impact: ${impacts.length > 0 ? impacts.join("+") : "none declared"}.`
      : `Behavior ${behavior.id} impact: ${impacts.length > 0 ? impacts.join("+") : "none declared"}; scope ${scope}.`;
    const intent: ValidationIntent = {
      id: `intent_${behavior.id}`,
      acceptanceConditionIds: [...behavior.acceptanceConditionIds],
      intendedBehavior: behavior.intendedBehavior,
      assertions: [...behavior.assertions],
      scope,
      scopeReason,
    };
    const validation = validateValidationIntent(intent);
    if (!validation.valid) {
      throw new Error(`Derived intent ${intent.id} is invalid: ${validation.issues.map((i) => i.message).join(" ")}`);
    }
    return { intent, isExactFailure: behavior.isExactFailure };
  });
}

/**
 * Order intents deterministically: exact failures first (by id), then affected
 * scope, then targeted non-failure, then final. Stable within each group.
 */
export function orderValidationIntents(
  intents: readonly DerivedValidationIntent[],
): DerivedValidationIntent[] {
  const rank = (entry: DerivedValidationIntent): number => {
    if (entry.isExactFailure) return 0;
    if (entry.intent.scope === "affected") return 1;
    if (entry.intent.scope === "targeted") return 2;
    return 3;
  };
  return [...intents].sort((a, b) =>
    rank(a) - rank(b) || (a.intent.id < b.intent.id ? -1 : a.intent.id > b.intent.id ? 1 : 0),
  );
}

// ---------------------------------------------------------------------------
// Required mandates from source/project policy (EP16)
// ---------------------------------------------------------------------------

export interface ValidationMandate {
  readonly id: string;
  readonly gate: string;
  readonly scope: ValidationScope;
  readonly source: "source" | "project";
  readonly description: string;
}

export interface MandateResolution {
  /** Gates that must run now (final suite only when final candidate or mandated). */
  readonly required: readonly ValidationMandate[];
  /** Gates explicitly deferred to the final candidate. */
  readonly deferredToFinal: readonly ValidationMandate[];
  /** Same mandate id demanded at conflicting scopes — must be escalated, never silently picked. */
  readonly conflicts: readonly { readonly id: string; readonly scopes: readonly ValidationScope[] }[];
}

/** The gate id an explicit mandate names to require the full suite now (EP16/IV-2). */
export const FULL_SUITE_GATE = "full_suite";

/**
 * Resolve required mandates. The default full suite belongs to the final
 * candidate: it is required only when `isFinalCandidate` is true or an
 * explicit source/project mandate names it. Every other mandate is retained;
 * same-id mandates at different scopes surface as conflicts.
 */
export function resolveValidationMandates(input: {
  readonly sourceMandates: readonly ValidationMandate[];
  readonly projectMandates: readonly ValidationMandate[];
  readonly isFinalCandidate: boolean;
}): MandateResolution {
  const all = [...input.sourceMandates, ...input.projectMandates];
  for (const mandate of all) {
    if (
      typeof mandate !== "object" || mandate === null ||
      !nonEmpty((mandate as { id?: unknown }).id) ||
      !nonEmpty(mandate.gate) ||
      !["targeted", "affected", "final"].includes(mandate.scope) ||
      (mandate.source !== "source" && mandate.source !== "project") ||
      !nonEmpty(mandate.description)
    ) {
      throw new Error("Validation mandate requires id, gate, scope, source, and description.");
    }
  }
  const byId = new Map<string, ValidationMandate[]>();
  for (const mandate of all) {
    const list = byId.get(mandate.id) ?? [];
    list.push(mandate);
    byId.set(mandate.id, list);
  }
  const conflicts: { id: string; scopes: ValidationScope[] }[] = [];
  for (const [id, mandates] of byId) {
    const scopes = [...new Set(mandates.map((m) => m.scope))].sort();
    if (scopes.length > 1) conflicts.push({ id, scopes });
  }
  const required: ValidationMandate[] = [];
  const deferredToFinal: ValidationMandate[] = [];
  const seenFullSuiteMandate = all.some((m) => m.gate === FULL_SUITE_GATE);
  for (const mandate of all) {
    if (mandate.scope === "final" && !input.isFinalCandidate) {
      deferredToFinal.push(mandate);
    } else {
      required.push(mandate);
    }
  }
  if (input.isFinalCandidate && !seenFullSuiteMandate) {
    required.push({
      id: "default_full_suite",
      gate: FULL_SUITE_GATE,
      scope: "final",
      source: "source",
      description: "Default full suite on the final candidate.",
    });
  }
  const sortById = (a: ValidationMandate, b: ValidationMandate): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return {
    required: [...required].sort(sortById),
    deferredToFinal: [...deferredToFinal].sort(sortById),
    conflicts: conflicts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// Inherited baseline failures (EP15): explicit disposition only
// ---------------------------------------------------------------------------

export interface BaselineFailure {
  readonly checkId: string;
  readonly evidenceId: string;
  readonly summary: string;
  /** True when the failing check is packet-required (cannot be waived). */
  readonly packetRequired: boolean;
}

export interface BaselineDisposition {
  readonly checkId: string;
  /** Retest the check now, or accept with an authorized reason (never a silent waiver). */
  readonly disposition: "retest" | "accepted";
  readonly authorizedBy: string;
  readonly rationale: string;
}

export interface BaselineResolution {
  readonly checkId: string;
  readonly status: "retest_required" | "accepted_with_disposition" | "pending_disposition" | "waiver_rejected";
  readonly detail: string;
}

/**
 * Resolve inherited failures against explicit dispositions. A baseline
 * failure is never auto-introduced as current and never an auto-waiver:
 * without a matching authorized disposition it stays `pending_disposition`,
 * and an `accepted` disposition for a packet-required check is rejected.
 */
export function resolveInheritedBaselineFailures(input: {
  readonly baselineFailures: readonly BaselineFailure[];
  readonly dispositions: readonly BaselineDisposition[];
}): BaselineResolution[] {
  const byCheck = new Map<string, BaselineDisposition>();
  for (const disposition of input.dispositions) {
    if (
      typeof disposition !== "object" || disposition === null ||
      !nonEmpty(disposition.checkId) ||
      (disposition.disposition !== "retest" && disposition.disposition !== "accepted") ||
      !nonEmpty(disposition.authorizedBy) ||
      !nonEmpty(disposition.rationale)
    ) {
      throw new Error("Baseline disposition requires checkId, disposition, authorizedBy, and rationale.");
    }
    byCheck.set(disposition.checkId, disposition);
  }
  return input.baselineFailures.map((failure) => {
    if (
      typeof failure !== "object" || failure === null ||
      !nonEmpty(failure.checkId) || !nonEmpty(failure.evidenceId) || !nonEmpty(failure.summary)
    ) {
      throw new Error("Baseline failure requires checkId, evidenceId, and summary.");
    }
    const disposition = byCheck.get(failure.checkId);
    if (!disposition) {
      return {
        checkId: failure.checkId,
        status: "pending_disposition",
        detail: `Baseline failure ${failure.checkId} (evidence ${failure.evidenceId}) has no authorized disposition; it is neither introduced as current nor waived.`,
      };
    }
    if (disposition.disposition === "accepted" && failure.packetRequired) {
      return {
        checkId: failure.checkId,
        status: "waiver_rejected",
        detail: `Baseline failure ${failure.checkId} is packet-required and cannot be accepted without a passing retest (waiver rejected).`,
      };
    }
    if (disposition.disposition === "accepted") {
      return {
        checkId: failure.checkId,
        status: "accepted_with_disposition",
        detail: `Baseline failure ${failure.checkId} accepted by ${disposition.authorizedBy}: ${disposition.rationale}`,
      };
    }
    return {
      checkId: failure.checkId,
      status: "retest_required",
      detail: `Baseline failure ${failure.checkId} must be retested (authorized by ${disposition.authorizedBy}).`,
    };
  });
}

// ---------------------------------------------------------------------------
// Packet-required vs final-gate criteria (EP15/EP16)
// ---------------------------------------------------------------------------

export interface PacketCriterion {
  readonly id: string;
  /** Packet-required criteria must pass now; final-gate criteria stay pending until the final candidate. */
  readonly gate: "packet" | "final";
  readonly status: "passed" | "failed" | "pending";
}

export interface PacketReadiness {
  readonly packetRequired: readonly PacketCriterion[];
  readonly finalGatePending: readonly PacketCriterion[];
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

/**
 * Partition criteria. Packet-required criteria must all pass; explicitly
 * final-gate criteria stay visibly pending without forcing a premature full
 * suite. A failed packet-required criterion blocks; a pending final-gate
 * criterion never blocks packet acceptance.
 */
export function partitionPacketVsFinal(
  criteria: readonly PacketCriterion[],
): PacketReadiness {
  if (!Array.isArray(criteria)) {
    throw new Error("partitionPacketVsFinal requires a criteria array.");
  }
  for (const criterion of criteria) {
    if (
      typeof criterion !== "object" || criterion === null ||
      !nonEmpty((criterion as { id?: unknown }).id) ||
      ((criterion as PacketCriterion).gate !== "packet" && (criterion as PacketCriterion).gate !== "final") ||
      !["passed", "failed", "pending"].includes((criterion as PacketCriterion).status)
    ) {
      throw new Error("Packet criterion requires id, gate (packet|final), and status.");
    }
  }
  const packetRequired = criteria.filter((c) => c.gate === "packet");
  const finalGatePending = criteria.filter((c) => c.gate === "final" && c.status !== "passed");
  const blockers: string[] = [];
  for (const criterion of packetRequired) {
    if (criterion.status !== "passed") {
      blockers.push(`Packet-required criterion ${criterion.id} is ${criterion.status}; it must pass before acceptance.`);
    }
  }
  return {
    packetRequired,
    finalGatePending,
    ready: blockers.length === 0,
    blockers,
  };
}
