import assert from "node:assert/strict";
import test from "node:test";

import {
  FINAL_VERIFICATION_CATEGORIES,
  assertFinalVerificationPlan,
  finalVerificationPlanSchema,
  validateFinalVerificationPlan,
  type FinalVerificationPlan,
} from "../src/final-verification-contracts.js";

const requiredPlan: FinalVerificationPlan = {
  checks: FINAL_VERIFICATION_CATEGORIES.map((category) => ({
    category,
    status: "required",
  })),
};

test("final verification plans require exactly one explicit status for every category", () => {
  assert.doesNotThrow(() => assertFinalVerificationPlan(requiredPlan));
  assert.deepEqual(
    validateFinalVerificationPlan(requiredPlan),
    {
      valid: true,
      issues: [],
      missingCategories: [],
      unknownCategories: [],
      duplicateCategories: [],
      unjustifiedCategories: [],
      detectedNotApplicableCategories: [],
    },
  );

  const missing = {
    checks: requiredPlan.checks.filter((check) => check.category !== "browser"),
  };
  assert.match(
    validateFinalVerificationPlan(missing).issues.join("\n"),
    /missing.*browser/i,
  );

  const duplicate = {
    checks: [...requiredPlan.checks, { category: "build", status: "required" }],
  };
  assert.match(
    validateFinalVerificationPlan(duplicate).issues.join("\n"),
    /duplicate.*build/i,
  );
});

test("unsupported categories and statuses are rejected instead of being ignored", () => {
  const invalid = {
    checks: [
      ...requiredPlan.checks.filter((check) => check.category !== "build"),
      { category: "deploy", status: "required" },
      { category: "build", status: "optional" },
    ],
  };

  const validation = validateFinalVerificationPlan(invalid);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.unknownCategories, ["deploy"]);
  assert.match(validation.issues.join("\n"), /unsupported.*category|unknown.*category/i);
  assert.match(validation.issues.join("\n"), /invalid.*status|unsupported.*status/i);
});

test("not_applicable requires a non-empty rationale and repository inspection", () => {
  const withoutReason = {
    checks: requiredPlan.checks.map((check) =>
      check.category === "runtime_smoke"
        ? { category: check.category, status: "not_applicable" }
        : check,
    ),
  };
  assert.match(
    validateFinalVerificationPlan(withoutReason).issues.join("\n"),
    /runtime_smoke.*rationale/i,
  );

  const withoutInspection = {
    checks: requiredPlan.checks.map((check) =>
      check.category === "runtime_smoke"
        ? {
            category: check.category,
            status: "not_applicable",
            rationale: "This repository has no runnable service.",
          }
        : check,
    ),
  };
  assert.match(
    validateFinalVerificationPlan(withoutInspection).issues.join("\n"),
    /runtime_smoke.*inspection/i,
  );

  const valid = {
    checks: requiredPlan.checks.map((check) =>
      check.category === "runtime_smoke"
        ? {
            category: check.category,
            status: "not_applicable",
            rationale: "This repository has no runnable service.",
            repositoryInspection: {
              paths: ["package.json"],
              summary: "No start script or runtime entry point was found.",
            },
          }
        : check,
    ),
  };
  assert.doesNotThrow(() => assertFinalVerificationPlan(valid));

  const emptyRationale = {
    checks: valid.checks.map((check) =>
      check.category === "runtime_smoke" ? { ...check, rationale: "  " } : check,
    ),
  };
  assert.match(
    validateFinalVerificationPlan(emptyRationale).issues.join("\n"),
    /runtime_smoke.*rationale/i,
  );
});

test("detected verification signals cannot be silently marked not applicable", () => {
  const plan = {
    checks: requiredPlan.checks.map((check) =>
      check.category === "browser"
        ? {
            category: check.category,
            status: "not_applicable",
            rationale: "The repository inspection found no browser surface.",
            repositoryInspection: {
              paths: ["package.json"],
              summary: "The project exposes a browser start script.",
            },
          }
        : check,
    ),
  };

  const validation = validateFinalVerificationPlan(plan, {
    detectedSignals: ["browser"],
  });
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.detectedNotApplicableCategories, ["browser"]);
  assert.match(validation.issues.join("\n"), /browser.*detected.*required/i);

  const inspectionDetected = {
    checks: requiredPlan.checks.map((check) =>
      check.category === "tests"
        ? {
            category: check.category,
            status: "not_applicable",
            rationale: "The repository contains no test surface.",
            repositoryInspection: {
              paths: ["package.json"],
              summary: "The package declares a test script.",
              detectedSignals: [{ category: "tests" }],
            },
          }
        : check,
    ),
  };
  const inspectionValidation = validateFinalVerificationPlan(inspectionDetected);
  assert.equal(inspectionValidation.valid, false);
  assert.deepEqual(inspectionValidation.detectedNotApplicableCategories, ["tests"]);
});

test("the exported input schema exposes all four category and status values", () => {
  const schema = finalVerificationPlanSchema();
  const checks = schema.properties as Record<string, unknown>;
  const item = checks.checks as Record<string, unknown>;
  const itemProperties = item.items as Record<string, unknown>;
  const properties = itemProperties.properties as Record<string, unknown>;
  assert.deepEqual(properties.category, {
    type: "string",
    enum: [...FINAL_VERIFICATION_CATEGORIES],
  });
  assert.deepEqual(properties.status, {
    type: "string",
    enum: ["required", "not_applicable"],
  });
  assert.deepEqual(itemProperties.required, ["category", "status"]);
});
