import {
  TOOL_RELIABILITY_CASES,
  type ToolReliabilityCase,
  type ToolReliabilityCaseCategory,
} from "@/lib/benchmark/toolreliability";

export const TEAMIQ_TOOL_RELIABILITY_QUICK_CASES: ToolReliabilityCase[] = [
  requiredCase("json-schema", "JSON schema"),
  requiredCase("tool-call", "tool call"),
  requiredCase(
    "patch",
    "standard patch",
    (benchmarkCase) => benchmarkCase.id.startsWith("toolrel-current-patch-")
  ),
  requiredCase(
    "patch",
    "large patch",
    (benchmarkCase) => benchmarkCase.id.startsWith("toolrel-current-large-patch-")
  ),
  requiredCase("repair-loop", "repair loop"),
  requiredCase("forbidden-action", "forbidden action"),
];

function requiredCase(
  category: ToolReliabilityCaseCategory,
  label: string,
  predicate: (benchmarkCase: ToolReliabilityCase) => boolean = () => true
): ToolReliabilityCase {
  const benchmarkCase = TOOL_RELIABILITY_CASES.find(
    (candidate) => candidate.category === category && predicate(candidate)
  );
  if (!benchmarkCase) {
    throw new Error(`Missing TeamIQ ToolReliability quick case for ${label}.`);
  }
  return benchmarkCase;
}
