/** The verification categories owned by the canonical final-verification gate. */
export const FINAL_VERIFICATION_CATEGORIES = [
  "build",
  "tests",
  "runtime_smoke",
  "browser",
] as const;

export type FinalVerificationCategory =
  (typeof FINAL_VERIFICATION_CATEGORIES)[number];

/** A category is either run or explicitly justified as inapplicable. */
export const FINAL_VERIFICATION_STATUSES = [
  "required",
  "not_applicable",
] as const;

export type FinalVerificationStatus =
  (typeof FINAL_VERIFICATION_STATUSES)[number];

/** A repository fact that can make a verification category applicable. */
export interface FinalVerificationDetectedSignal {
  category: FinalVerificationCategory;
  source?: string;
  detail?: string;
}

export type FinalVerificationDetectedSignals =
  | readonly FinalVerificationCategory[]
  | readonly FinalVerificationDetectedSignal[]
  | Partial<Record<FinalVerificationCategory, boolean>>;

/** Repository facts supporting a category being inapplicable. */
export interface FinalVerificationRepositoryInspection {
  paths: string[];
  summary: string;
  detectedSignals?: FinalVerificationDetectedSignal[];
}

export interface FinalVerificationCheck {
  category: FinalVerificationCategory;
  status: FinalVerificationStatus;
  /** Required when status is `not_applicable`; optional otherwise. */
  rationale?: string;
  /** Required when status is `not_applicable`. */
  repositoryInspection?: FinalVerificationRepositoryInspection;
}

/** Alias used by callers that refer to each category entry as a plan item. */
export type FinalVerificationPlanItem = FinalVerificationCheck;
export type FinalVerificationCategoryPlan = FinalVerificationCheck;

export interface FinalVerificationPlan {
  checks: FinalVerificationCheck[];
}

export interface FinalVerificationValidationOptions {
  /** Signals discovered before planning; an applicable category cannot be skipped. */
  detectedSignals?: FinalVerificationDetectedSignals;
}

export interface FinalVerificationContractValidation {
  valid: boolean;
  issues: string[];
  missingCategories: FinalVerificationCategory[];
  unknownCategories: string[];
  duplicateCategories: string[];
  unjustifiedCategories: FinalVerificationCategory[];
  detectedNotApplicableCategories: FinalVerificationCategory[];
}

const CATEGORY_SET = new Set<string>(FINAL_VERIFICATION_CATEGORIES);
const STATUS_SET = new Set<string>(FINAL_VERIFICATION_STATUSES);

/**
 * Validate the Architect's final-verification plan mechanically.
 *
 * This function deliberately validates only the plan contract. It does not
 * execute checks and does not decide whether an executed check is successful.
 */
export function validateFinalVerificationPlan(
  plan: unknown,
  options: FinalVerificationValidationOptions = {},
): FinalVerificationContractValidation {
  const issues: string[] = [];
  const missingCategories: FinalVerificationCategory[] = [];
  const unknownCategories: string[] = [];
  const duplicateCategories: string[] = [];
  const unjustifiedCategories: FinalVerificationCategory[] = [];
  const detectedNotApplicableCategories: FinalVerificationCategory[] = [];
  const seen = new Set<string>();

  if (!isRecord(plan) || !Array.isArray(plan.checks)) {
    issues.push("Final verification plan requires a checks array.");
    return result({
      issues,
      missingCategories: [...FINAL_VERIFICATION_CATEGORIES],
      unknownCategories,
      duplicateCategories,
      unjustifiedCategories,
      detectedNotApplicableCategories,
    });
  }

  const detected = detectedCategories(options.detectedSignals, issues);
  for (const [index, candidate] of plan.checks.entries()) {
    if (!isRecord(candidate)) {
      issues.push(`Final verification check ${index} must be an object.`);
      continue;
    }

    const category = candidate.category;
    if (typeof category !== "string" || category.trim().length === 0) {
      issues.push(`Final verification check ${index} requires a category.`);
      continue;
    }
    if (seen.has(category)) {
      duplicateCategories.push(category);
      issues.push(`Duplicate final verification category ${category}.`);
    }
    seen.add(category);
    if (!CATEGORY_SET.has(category)) {
      unknownCategories.push(category);
      issues.push(`Unsupported final verification category ${category}.`);
      continue;
    }

    const status = candidate.status;
    if (typeof status !== "string" || !STATUS_SET.has(status)) {
      issues.push(
        `Final verification category ${category} has unsupported status ${String(status)}.`,
      );
      continue;
    }

    const rationale = candidate.rationale;
    if (rationale !== undefined && !nonEmpty(rationale)) {
      issues.push(`Final verification category ${category} has an empty rationale.`);
    }

    const inspection = candidate.repositoryInspection;
    if (validRepositoryInspection(inspection)) {
      for (const signal of inspection.detectedSignals ?? []) {
        detected.add(signal.category);
      }
    }

    if (status !== "not_applicable") continue;

    const categoryName = category as FinalVerificationCategory;
    let unjustified = false;
    if (!nonEmpty(rationale)) {
      unjustified = true;
      issues.push(
        `Final verification category ${category} marked not_applicable requires a non-empty rationale.`,
      );
    }
    if (!validRepositoryInspection(candidate.repositoryInspection)) {
      unjustified = true;
      issues.push(
        `Final verification category ${category} marked not_applicable requires supporting repository inspection.`,
      );
    }
    if (detected.has(categoryName)) {
      detectedNotApplicableCategories.push(categoryName);
      issues.push(
        `Final verification category ${category} has a detected signal and must remain required.`,
      );
    }
    if (unjustified) unjustifiedCategories.push(categoryName);
  }

  for (const category of FINAL_VERIFICATION_CATEGORIES) {
    if (!seen.has(category)) {
      missingCategories.push(category);
      issues.push(`Missing final verification category ${category}.`);
    }
  }

  return result({
    issues,
    missingCategories,
    unknownCategories,
    duplicateCategories,
    unjustifiedCategories,
    detectedNotApplicableCategories,
  });
}

export function assertFinalVerificationPlan(
  plan: unknown,
  options: FinalVerificationValidationOptions = {},
): asserts plan is FinalVerificationPlan {
  const validation = validateFinalVerificationPlan(plan, options);
  if (!validation.valid) throw new Error(validation.issues.join(" "));
}

/** Validate and clone a plan at the contract boundary. */
export function planFinalVerification(
  plan: unknown,
  options: FinalVerificationValidationOptions = {},
): FinalVerificationPlan {
  assertFinalVerificationPlan(plan, options);
  return {
    checks: plan.checks.map((check) => ({
      category: check.category,
      status: check.status,
      ...(check.rationale !== undefined ? { rationale: check.rationale } : {}),
      ...(check.repositoryInspection
        ? {
            repositoryInspection: {
              paths: [...check.repositoryInspection.paths],
              summary: check.repositoryInspection.summary,
              ...(check.repositoryInspection.detectedSignals
                ? {
                    detectedSignals: check.repositoryInspection.detectedSignals.map(
                      (signal) => ({ ...signal }),
                    ),
                  }
                : {}),
            },
          }
        : {}),
    })),
  };
}

/** The snake-case name used by the Architect lifecycle tool. */
export const plan_final_verification = planFinalVerification;

/** JSON-schema surface used when exposing the contract as a native tool. */
export function finalVerificationPlanSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      checks: {
        type: "array",
        minItems: FINAL_VERIFICATION_CATEGORIES.length,
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [...FINAL_VERIFICATION_CATEGORIES],
            },
            status: {
              type: "string",
              enum: [...FINAL_VERIFICATION_STATUSES],
            },
            rationale: { type: "string", minLength: 1 },
            repositoryInspection: {
              type: "object",
              properties: {
                paths: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", minLength: 1 },
                },
                summary: { type: "string", minLength: 1 },
                detectedSignals: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      category: {
                        type: "string",
                        enum: [...FINAL_VERIFICATION_CATEGORIES],
                      },
                      source: { type: "string", minLength: 1 },
                      detail: { type: "string", minLength: 1 },
                    },
                    required: ["category"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["paths", "summary"],
              additionalProperties: false,
            },
          },
          required: ["category", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["checks"],
    additionalProperties: false,
  };
}

function validRepositoryInspection(value: unknown): value is FinalVerificationRepositoryInspection {
  if (!isRecord(value) || !nonEmpty(value.summary)) return false;
  if (!Array.isArray(value.paths) || value.paths.length === 0) return false;
  if (value.paths.some((path) => !nonEmpty(path))) return false;
  if (value.detectedSignals !== undefined) {
    if (!Array.isArray(value.detectedSignals)) return false;
    if (value.detectedSignals.some((signal) => !validDetectedSignal(signal))) return false;
  }
  return true;
}

function validDetectedSignal(value: unknown): value is FinalVerificationDetectedSignal {
  return isRecord(value) &&
    typeof value.category === "string" &&
    CATEGORY_SET.has(value.category) &&
    (value.source === undefined || nonEmpty(value.source)) &&
    (value.detail === undefined || nonEmpty(value.detail));
}

function detectedCategories(
  input: FinalVerificationDetectedSignals | undefined,
  issues: string[],
): Set<FinalVerificationCategory> {
  const categories = new Set<FinalVerificationCategory>();
  if (input === undefined) return categories;
  if (Array.isArray(input)) {
    for (const item of input) {
      const category = typeof item === "string"
        ? item
        : isRecord(item)
          ? item.category
          : undefined;
      if (typeof category !== "string" || !CATEGORY_SET.has(category)) {
        issues.push(`Unsupported detected final verification category ${String(category)}.`);
        continue;
      }
      categories.add(category as FinalVerificationCategory);
    }
    return categories;
  }
  if (!isRecord(input)) {
    issues.push("Detected final verification signals must be an array or category map.");
    return categories;
  }
  for (const [category, value] of Object.entries(input)) {
    if (!CATEGORY_SET.has(category)) {
      issues.push(`Unsupported detected final verification category ${category}.`);
      continue;
    }
    if (typeof value !== "boolean") {
      issues.push(`Detected final verification signal ${category} must be boolean.`);
      continue;
    }
    if (value) categories.add(category as FinalVerificationCategory);
  }
  return categories;
}

function result(input: {
  issues: string[];
  missingCategories: FinalVerificationCategory[];
  unknownCategories: string[];
  duplicateCategories: string[];
  unjustifiedCategories: FinalVerificationCategory[];
  detectedNotApplicableCategories: FinalVerificationCategory[];
}): FinalVerificationContractValidation {
  return {
    valid: input.issues.length === 0,
    issues: [...input.issues],
    missingCategories: unique(input.missingCategories),
    unknownCategories: unique(input.unknownCategories),
    duplicateCategories: unique(input.duplicateCategories),
    unjustifiedCategories: unique(input.unjustifiedCategories),
    detectedNotApplicableCategories: unique(input.detectedNotApplicableCategories),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
