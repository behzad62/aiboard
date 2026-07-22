/* ToolReliability current-name public API checks (run: npx tsx scripts/test-toolreliability-current-names.mts) */
const toolReliabilityApi = await import("../lib/benchmark/toolreliability");
const suiteOptionsApi = await import("../lib/benchmark/certified/suite-options");

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const publicApi = toolReliabilityApi as Record<string, unknown>;
const suiteApi = suiteOptionsApi as Record<string, unknown>;
const cases = publicApi.TOOL_RELIABILITY_CASES as
  | Array<{ id: string }>
  | undefined;
const listCertifiedSuiteOptions = suiteApi.listCertifiedSuiteOptions as
  | ((track: string) => Array<{ id: string; label: string }>)
  | undefined;

check(
  "current ToolReliability case export exists",
  Array.isArray(cases) && cases.length === 8,
  { length: cases?.length, exportType: typeof publicApi.TOOL_RELIABILITY_CASES }
);
check(
  "current ToolReliability runner export exists",
  typeof publicApi.runToolReliability === "function",
  typeof publicApi.runToolReliability
);
check(
  "retired stress-pack exports are gone (its enforcement value moved into the live pack)",
  !("TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES" in publicApi) &&
    !("TOOL_RELIABILITY_TOOL_STRATEGY_CASES" in publicApi) &&
    !("TOOL_RELIABILITY_STRESS_CASES" in publicApi) &&
    !("runLargeFilePatchStressPack" in publicApi) &&
    !("evaluateLargeFilePatchStressCase" in publicApi),
  Object.keys(publicApi).filter((key) => /STRESS|Stress/.test(key))
);
check(
  "versioned ToolReliability exports are absent",
  !("TOOL_RELIABILITY_V0_1_CASES" in publicApi) &&
    !("TOOL_RELIABILITY_V0_2_CASES" in publicApi) &&
    !("TOOL_RELIABILITY_V0_2_LARGE_FILE_CASES" in publicApi) &&
    !("TOOL_RELIABILITY_V0_2_TOOL_STRESS_CASES" in publicApi) &&
    !("TOOL_RELIABILITY_V0_2_STRESS_CASES" in publicApi) &&
    !("runToolReliabilityV0_1" in publicApi),
  Object.keys(publicApi).filter((key) => /V0_|v0_/.test(key))
);
check(
  "current ToolReliability case ids use current namespace",
  Array.isArray(cases) &&
    cases.every((item) => item.id.startsWith("toolrel-current-")) &&
    cases.every((item) => !/toolrel-v0\.[12]-/.test(item.id)),
  cases?.map((item) => item.id).slice(0, 5)
);
check(
  "listCertifiedSuiteOptions is exported",
  typeof listCertifiedSuiteOptions === "function",
  typeof listCertifiedSuiteOptions
);

const toolReliabilityOptions = listCertifiedSuiteOptions?.("toolreliability") ?? [];
const relevantSuiteOptions = [
  ...toolReliabilityOptions,
  ...(listCertifiedSuiteOptions?.("teamiq") ?? []).filter((option) =>
    option.id.includes("toolreliability")
  ),
];
check(
  "ToolReliability UI option uses current pack id and label",
  toolReliabilityOptions.length === 1 &&
    toolReliabilityOptions[0]?.id === "toolreliability-current-pack" &&
    toolReliabilityOptions[0]?.label === "ToolReliability: Current challenge pack",
  toolReliabilityOptions
);
check(
  "suite option labels avoid legacy version wording",
  relevantSuiteOptions.every((option) => !/(?:v0\.[12]|legacy)/i.test(option.label)),
  relevantSuiteOptions
);
check(
  "suite option ids avoid legacy version wording",
  relevantSuiteOptions.every((option) => !/(?:v0\.[12]|legacy|stale)/i.test(option.id)),
  relevantSuiteOptions
);
check(
  "TeamIQ ToolReliability suite id uses current naming",
  relevantSuiteOptions.some(
    (option) =>
      option.id === "teamiq-toolreliability-current-quick" &&
      option.label === "TeamIQ: ToolReliability quick"
  ),
  relevantSuiteOptions
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
