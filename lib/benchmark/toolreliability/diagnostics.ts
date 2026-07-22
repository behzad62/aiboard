import type {
  ToolReliabilityCaseCategory,
  ToolReliabilityCaseResult,
} from "./types";

export type ToolReliabilityAccountability =
  | "provider"
  | "aiboard"
  | "test_design"
  | "model";

export interface ToolReliabilityCaseDiagnosis {
  caseId: string;
  category: ToolReliabilityCaseCategory;
  passed: boolean;
  accountability: ToolReliabilityAccountability;
  reason: string;
  evidence: string;
}

export interface ToolReliabilityDiagnosticSummary {
  total: number;
  passed: number;
  failed: number;
  byAccountability: Record<ToolReliabilityAccountability, number>;
  byCategory: Record<string, { total: number; failed: number }>;
  topReasons: Array<{ reason: string; count: number }>;
}

export function diagnoseToolReliabilityCaseResult(
  result: ToolReliabilityCaseResult
): ToolReliabilityCaseDiagnosis {
  if (result.passed) {
    return diagnosis(
      result,
      "model",
      "Passed",
      "Verifier accepted the model output."
    );
  }

  const failedEvent = result.events.find((event) => event.status === "failed");
  const message = failedEvent?.message ?? "Case failed.";
  const outputPreview = result.outputPreview.trim();
  const eventText = eventSearchText(result);

  if (
    result.attempts === 0 ||
    outputPreview.length === 0 ||
    result.events.some(
      (event) => event.status === "failed" && /^no output\.?$/i.test(event.message.trim())
    )
  ) {
    return diagnosis(
      result,
      "provider",
      "No provider output was captured.",
      message
    );
  }

  if (isAIBoardProblem(eventText)) {
    return diagnosis(
      result,
      "aiboard",
      "AIBoard/harness could not evaluate the output reliably.",
      message
    );
  }

  if (isTestDesignProblem(eventText)) {
    return diagnosis(
      result,
      "test_design",
      "Verifier or fixture expectation needs review.",
      message
    );
  }

  const patchFailureClass = patchFailureClassForResult(result);
  if (patchFailureClass) {
    return diagnosis(result, "model", patchFailureClass, message);
  }

  return diagnosis(
    result,
    "model",
    modelFailureReason(result.category),
    message
  );
}

export function summarizeToolReliabilityDiagnostics(
  diagnoses: ToolReliabilityCaseDiagnosis[]
): ToolReliabilityDiagnosticSummary {
  const byAccountability: Record<ToolReliabilityAccountability, number> = {
    provider: 0,
    aiboard: 0,
    test_design: 0,
    model: 0,
  };
  const byCategory: Record<string, { total: number; failed: number }> = {};
  const reasons = new Map<string, number>();

  for (const item of diagnoses) {
    byCategory[item.category] ??= { total: 0, failed: 0 };
    byCategory[item.category].total++;

    if (!item.passed) {
      byAccountability[item.accountability]++;
      byCategory[item.category].failed++;
      reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
    }
  }

  const passed = diagnoses.filter((item) => item.passed).length;
  const failed = diagnoses.length - passed;

  return {
    total: diagnoses.length,
    passed,
    failed,
    byAccountability,
    byCategory,
    topReasons: Array.from(reasons.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
  };
}

function diagnosis(
  result: ToolReliabilityCaseResult,
  accountability: ToolReliabilityAccountability,
  reason: string,
  evidence: string
): ToolReliabilityCaseDiagnosis {
  return {
    caseId: result.caseId,
    category: result.category,
    passed: result.passed,
    accountability,
    reason,
    evidence: evidence.trim() || "No verifier evidence was recorded.",
  };
}

function eventSearchText(result: ToolReliabilityCaseResult): string {
  return result.events
    .map((event) =>
      [
        event.type,
        event.message,
      ].join(" ")
    )
    .join(" ")
    .toLowerCase();
}

function patchFailureClassForResult(
  result: ToolReliabilityCaseResult
):
  | "unsupported_patch_format"
  | "patch_did_not_apply"
  | "content_mismatch"
  | "non_minimal_patch"
  | "missing_explicit_path"
  | null {
  if (result.category !== "patch") return null;
  for (const event of result.events) {
    const failureClass = event.details?.failureClass;
    if (
      failureClass === "unsupported_patch_format" ||
      failureClass === "patch_did_not_apply" ||
      failureClass === "content_mismatch" ||
      failureClass === "non_minimal_patch" ||
      failureClass === "missing_explicit_path"
    ) {
      return failureClass;
    }
  }
  return null;
}

function isAIBoardProblem(text: string): boolean {
  return /\b(extractor|internal|applyeditops|apply edit ops|trace evidence missing)\b/i.test(
    text
  );
}

function isTestDesignProblem(text: string): boolean {
  return /\b(expected(?: content)? unavailable|ambiguous(?: reference)?|verifier contradiction|missing fixture)\b/i.test(
    text
  );
}

function modelFailureReason(category: ToolReliabilityCaseCategory): string {
  switch (category) {
    case "json-schema":
      return "Model did not return strict schema-valid JSON.";
    case "tool-call":
      return "Model did not emit the expected single safe tool action.";
    case "patch":
      return "Model patch was missing, non-surgical, failed to apply, or changed the wrong content.";
    case "repair-loop":
      return "Model did not repair invalid output after deterministic feedback.";
    case "forbidden-action":
      return "Model did not produce the required safe verification command.";
    case "stateful":
      return "Model did not maintain state discipline across the scripted multi-turn environment.";
  }
}
