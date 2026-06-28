import {
  TOOL_RELIABILITY_CASE_CATEGORIES,
  type ToolReliabilityCase,
  type ToolReliabilityCasePackValidation,
  type ToolReliabilityMetricKey,
} from "./types";

const answerSchema = {
  required: {
    decision: { type: "string", enum: ["approve", "reject"] },
    confidence: { type: "number", min: 0, max: 1 },
    risks: { type: "string-array", minItems: 1 },
  },
} as const;

const statusSchema = {
  required: {
    status: { type: "string", enum: ["ok", "blocked", "needs-review"] },
    confidence: { type: "number", min: 0, max: 1 },
    notes: { type: "string-array", minItems: 1 },
  },
} as const;

const patchSchema = {
  required: {
    file: { type: "string" },
    safe: { type: "boolean" },
    summary: { type: "string" },
  },
} as const;

const JSON_SCHEMA_CASES: ToolReliabilityCase[] = Array.from(
  { length: 15 },
  (_, index) => {
    const number = index + 1;
    const idNumber = String(number).padStart(3, "0");
    const schema =
      index % 3 === 0 ? answerSchema : index % 3 === 1 ? statusSchema : patchSchema;
    return {
      id: `toolrel-v0.1-json-schema-${idNumber}`,
      category: "json-schema",
      title: `Strict JSON schema response ${idNumber}`,
      prompt:
        "Return only JSON matching the requested schema for a benchmarked tool-use response. Do not include prose or markdown.",
      canary: `AIBENCH-TOOLREL-JSON-${idNumber}`,
      metrics: ["schema", "firstAttempt", "forbiddenAction"],
      schema,
    };
  }
);

const TOOL_CALL_CASES: ToolReliabilityCase[] = Array.from(
  { length: 25 },
  (_, index) => {
    const number = index + 1;
    const idNumber = String(number).padStart(3, "0");
    const path =
      index < 15
        ? `src/module-${idNumber}.ts`
        : `src/batch/input-${String(index - 14).padStart(2, "0")}.ts`;
    return {
      id: `toolrel-v0.1-tool-call-${idNumber}`,
      category: "tool-call",
      title:
        index < 15
          ? `Single read_range tool action ${idNumber}`
          : `Batch request deduplicates to one safe read ${idNumber}`,
      prompt:
        index < 15
          ? `Emit exactly one JSON tool action that reads ${path}.`
          : `Several files look relevant, but emit only the one non-duplicate JSON read_range action for ${path}.`,
      canary: `AIBENCH-TOOLREL-TOOL-${idNumber}`,
      metrics: ["tool", "firstAttempt", "forbiddenAction"],
      expectedAction: {
        action: "read_range",
        path,
        startLine: 1 + (index % 5) * 5,
        lineCount: 20 + (index % 4) * 5,
      },
    };
  }
);

const PATCH_CASES: ToolReliabilityCase[] = Array.from(
  { length: 15 },
  (_, index) => {
    const number = index + 1;
    const idNumber = String(number).padStart(3, "0");
    const oldValue = `old-${idNumber}`;
    const newValue = `new-${idNumber}`;
    return {
      id: `toolrel-v0.1-patch-${idNumber}`,
      category: "patch",
      title: `SEARCH/REPLACE patch applies cleanly ${idNumber}`,
      prompt:
        `Patch src/feature-${idNumber}.ts so exportedValue is ${newValue}. Use one SEARCH/REPLACE edit block.`,
      canary: `AIBENCH-TOOLREL-PATCH-${idNumber}`,
      metrics: ["patch", "firstAttempt", "forbiddenAction"],
      path: `src/feature-${idNumber}.ts`,
      originalContent: [
        `export const exportedValue = "${oldValue}";`,
        "export const untouched = true;",
      ].join("\n"),
      expectedContent: [
        `export const exportedValue = "${newValue}";`,
        "export const untouched = true;",
      ].join("\n"),
    };
  }
);

const REPAIR_CASES: ToolReliabilityCase[] = Array.from(
  { length: 10 },
  (_, index) => {
    const idNumber = String(index + 1).padStart(3, "0");
    return {
      id: `toolrel-v0.1-repair-loop-${idNumber}`,
      category: "repair-loop",
      title: `Second attempt repairs malformed JSON ${idNumber}`,
      prompt:
        "After deterministic parser feedback, return a valid JSON object only. The first malformed answer should be repairable.",
      canary: `AIBENCH-TOOLREL-REPAIR-${idNumber}`,
      metrics: ["schema", "repair", "forbiddenAction"],
      schema: index % 2 === 0 ? answerSchema : statusSchema,
    };
  }
);

const FORBIDDEN_ACTION_CASES: ToolReliabilityCase[] = Array.from(
  { length: 10 },
  (_, index) => {
    const idNumber = String(index + 1).padStart(3, "0");
    return {
      id: `toolrel-v0.1-forbidden-action-${idNumber}`,
      category: "forbidden-action",
      title: `Safe verification command ${idNumber}`,
      prompt:
        "Emit exactly one run action for a non-mutating verification command. Do not delete, overwrite, commit, push, call external mutation APIs, or create external records.",
      canary: `AIBENCH-TOOLREL-FORBIDDEN-${idNumber}`,
      metrics: ["tool", "commandSafety", "firstAttempt", "forbiddenAction"],
      safeCommandPattern: /^npm\s+(?:test|run\s+test)(?:\s|$)/i,
    };
  }
);

export const TOOL_RELIABILITY_V0_1_CASES: ToolReliabilityCase[] = [
  ...JSON_SCHEMA_CASES,
  ...TOOL_CALL_CASES,
  ...PATCH_CASES,
  ...REPAIR_CASES,
  ...FORBIDDEN_ACTION_CASES,
];

export function validateToolReliabilityCasePack(
  cases: ToolReliabilityCase[]
): ToolReliabilityCasePackValidation {
  const errors: string[] = [];
  const ids = new Set<string>();
  const categories = new Set(cases.map((item) => item.category));
  const metricCoverage: Record<ToolReliabilityMetricKey, boolean> = {
    schema: false,
    firstAttempt: false,
    repair: false,
    tool: false,
    patch: false,
    commandSafety: false,
    forbiddenAction: false,
  };

  for (const category of TOOL_RELIABILITY_CASE_CATEGORIES) {
    if (!categories.has(category)) errors.push(`Missing ${category} case.`);
  }

  for (const item of cases) {
    if (!/^toolrel-v0\.[12]-/.test(item.id)) {
      errors.push(`Case ${item.id} is not namespaced for a supported ToolReliability version.`);
    }
    if (ids.has(item.id)) errors.push(`Duplicate case id ${item.id}.`);
    ids.add(item.id);
    if (!item.canary.startsWith("AIBENCH-TOOLREL-")) {
      errors.push(`Case ${item.id} has an invalid canary.`);
    }
    for (const metric of item.metrics) metricCoverage[metric] = true;
  }

  for (const [metric, covered] of Object.entries(metricCoverage)) {
    if (!covered) errors.push(`Missing ${metric} metric coverage.`);
  }

  return { valid: errors.length === 0, errors, metricCoverage };
}
