import type { WorkBenchCase } from "../workbench/types";

/**
 * What a ToolBench result may claim about one native capability.
 * - verified: a covering case passed hidden qualification and used one of the capability's tools successfully
 * - exercised: a capability tool ran successfully, but no covering case passed
 * - available: the tools were offered, but no covering attempt used them successfully
 * - not_tested: no selected case measures it (or the harness cannot yet; see `untestedReason`)
 * - unsupported: the Runner did not offer any of the capability's tools
 * - excluded_by_environment: the capability needs a backend this environment lacks (browser, vision)
 */
export type NativeCoverageStatus = "verified" | "exercised" | "available" | "not_tested" | "unsupported" | "excluded_by_environment";

export interface NativeCapability {
  readonly id: string;
  readonly label: string;
  /** Acceptable production tools; any one of them satisfies the capability. */
  readonly tools: readonly string[];
  /** What the hidden checks assert for it (tool-name use alone never verifies a capability). */
  readonly evidence: string;
  /** Case ids that measure it. v5 cases also declare these in `nativeQualification.coverage`. */
  readonly cases: readonly string[];
  readonly requires?: "browser" | "vision";
  /** Why no case measures it yet. */
  readonly untestedReason?: string;
}

const CORE = (id: string) => [`toolbench-native-${id}-v4`, `toolbench-native-${id}-variant-b-v4`];
const V5 = (id: string) => `toolbench-native-${id}-v5`;
const V6 = (id: string) => `toolbench-native-${id}-v6`;

export const NATIVE_TOOL_COVERAGE: readonly NativeCapability[] = [
  { id: "file_read", label: "File reads", tools: ["fs.read"], evidence: "Read output delivered task-relevant text; range limits are qualified separately.", cases: [...CORE("investigate"), ...CORE("bounded-output"), V5("code-navigation"), V6("verify"), V6("revision-recovery"), V6("code-navigation"), V6("artifact-retrieval")] },
  { id: "bounded_file_read", label: "Bounded file reads", tools: ["fs.read"], evidence: "The target appears in the read output from a ≤64-line startLine/endLine range.", cases: [...CORE("bounded-output"), V6("artifact-retrieval")] },
  { id: "repository_search", label: "Repository search", tools: ["fs.search"], evidence: "A successful search preceded the read that delivered the target.", cases: [...CORE("investigate"), V5("code-navigation"), V5("continued-search"), V6("code-navigation"), V6("continued-search")] },
  { id: "search_continuation", label: "Search continuation (cursor pages)", tools: ["fs.search"], evidence: "A search call made with a cursor delivered the late target in its page.", cases: [V5("continued-search"), V6("continued-search")] },
  { id: "code_navigation", label: "Definition and caller navigation", tools: ["fs.search", "code.references", "code.workspace_symbols", "code.definition"], evidence: "Callers listed exactly and the definition (not callers) fixed with executed behavior checks.", cases: [V5("code-navigation"), V6("code-navigation")] },
  { id: "patch_edit", label: "Surgical patch edits", tools: ["fs.patch", "openrouter.apply_patch"], evidence: "Executed behavior checks pass and protected files are unchanged.", cases: [...CORE("verify"), V5("code-navigation"), V6("verify"), V6("revision-recovery"), V6("code-navigation")] },
  { id: "patch_recovery", label: "Stale-patch recovery", tools: ["fs.patch", "openrouter.apply_patch"], evidence: "An ambiguous_patch rejection, then a fresh read, then a successful patch.", cases: [...CORE("revision-recovery"), V6("revision-recovery")] },
  { id: "atomic_multi_edit", label: "Atomic multi-edit", tools: ["fs.patch", "openrouter.apply_patch"], evidence: "One successful call carrying at least two edits.", cases: [...CORE("atomic-edits"), V6("code-navigation")] },
  { id: "file_create", label: "File creation", tools: ["fs.write", "openrouter.apply_patch"], evidence: "The answer file has the exact required content.", cases: [...CORE("investigate"), ...CORE("bounded-output"), ...CORE("command-args"), V5("code-navigation"), V5("continued-search"), V5("artifact-retrieval"), V5("project-skill"), "toolbench-native-skills-v4", V6("code-navigation"), V6("continued-search"), V6("artifact-retrieval"), V6("project-skill")] },
  { id: "evidence_command", label: "Argument-array commands with evidence", tools: ["run_evidence_command"], evidence: "A recorded command fact with the exact argv and exit 0 (and an earlier failure where required).", cases: [...CORE("verify"), ...CORE("command-args"), V5("artifact-retrieval"), V6("verify"), V6("artifact-retrieval")] },
  { id: "command_arguments", label: "Exact command argument arrays", tools: ["run_evidence_command"], evidence: "Successful command evidence records both separate argv entries, including a space within the first.", cases: [...CORE("command-args"), V6("artifact-retrieval")] },
  { id: "artifact_retrieval", label: "Artifact retrieval beyond the inline bound", tools: ["artifact.read"], evidence: "artifact.read delivered the runtime-only value; no byte range was read twice.", cases: [V5("artifact-retrieval"), V6("artifact-retrieval")] },
  { id: "process_interactive_input", label: "Interactive process input", tools: ["process.write_stdin"], evidence: "The program recorded exactly one delivered line equal to its runtime code, then EOF.", cases: [V5("interactive-process"), V6("interactive-process")] },
  { id: "process_incremental_output", label: "Incremental process output", tools: ["process.read_output"], evidence: "Output read before the write and again after it, in order.", cases: [V5("interactive-process"), V6("interactive-process")] },
  { id: "process_cleanup", label: "Owned process lifecycle and cleanup", tools: ["process.start", "process.signal"], evidence: "Session cleanup proves no owned process remains (a cleanup failure fails the session).", cases: ["toolbench-native-browser-v4", V5("interactive-process"), V5("browser-form"), V6("interactive-process")] },
  { id: "project_skills", label: "Project skill discovery and use", tools: ["list_skills", "read_skill"], evidence: "The answer applies a rule that exists only in the skill.", cases: ["toolbench-native-skills-v4", V5("project-skill"), V6("project-skill")] },
  { id: "browser_interaction", label: "Browser interaction", tools: ["browser.open", "browser.snapshot", "browser.click"], evidence: "Ordered open → snapshot → click → new snapshot, and the server persisted the result.", cases: ["toolbench-native-browser-v4", V5("browser-form"), V6("interactive-process")], requires: "browser" },
  { id: "browser_form", label: "Browser form entry", tools: ["browser.fill"], evidence: "The server persisted exactly the typed values.", cases: [V5("browser-form"), V6("interactive-process")], requires: "browser" },
  { id: "git_inspection", label: "Git inspection", tools: ["git.status", "git.diff", "git.log", "git.show"], evidence: "—", cases: [], untestedReason: "Bench preparation commits each fixture as a single revision; a multi-revision fixture is needed before current changes can be distinguished from an earlier revision." },
  { id: "image_inspection", label: "Local image inspection", tools: ["image.inspect"], evidence: "—", cases: [], requires: "vision", untestedReason: "ToolBench fixtures are text-only and solo sessions do not offer image.inspect yet; covered by Runner tests (test/image-inspection.test.ts), not by a model benchmark." },
  { id: "mcp_tools", label: "Managed MCP tools", tools: [], evidence: "—", cases: [], untestedReason: "Managed MCP and plugins are covered by local controlled Runner fixtures (extension-mcp*, extension-plugin tests). ToolBench does not certify arbitrary third-party servers." },
];

export interface NativeCoverageAttempt {
  readonly caseId: string;
  /** Tool names the session offered; undefined from Runners that do not report it. */
  readonly availableTools?: readonly string[];
  /** Tools that completed without error. */
  readonly succeededTools: readonly string[];
  /** Hidden behavior and qualification both passed. */
  readonly passed: boolean;
}

export interface NativeCoverageRow {
  readonly capability: string;
  readonly label: string;
  readonly status: NativeCoverageStatus;
  readonly detail: string;
}

export interface NativeCoverageReport {
  readonly rows: readonly NativeCoverageRow[];
  /** Always false: a pack result is scoped to the capabilities it measured. */
  readonly fullCoverage: false;
  readonly note: string;
}

/** Scopes a set of ToolBench attempts to the capabilities they actually measured. */
export function nativeCoverageReport(input: {
  readonly selectedCaseIds: readonly string[];
  readonly attempts: readonly NativeCoverageAttempt[];
  readonly environment: { readonly browser: boolean; readonly vision: boolean };
}): NativeCoverageReport {
  const selected = new Set(input.selectedCaseIds);
  const rows = NATIVE_TOOL_COVERAGE.map((capability): NativeCoverageRow => {
    const base = { capability: capability.id, label: capability.label };
    if (capability.untestedReason) return { ...base, status: "not_tested", detail: capability.untestedReason };
    if (capability.requires && !input.environment[capability.requires]) return { ...base, status: "excluded_by_environment", detail: `Needs a ${capability.requires} backend, which this environment does not have.` };
    const covering = capability.cases.filter((id) => selected.has(id));
    if (covering.length === 0) return { ...base, status: "not_tested", detail: "No selected case measures this capability." };
    const attempts = input.attempts.filter((attempt) => covering.includes(attempt.caseId));
    if (attempts.length === 0) return { ...base, status: "not_tested", detail: "Covering cases were selected but produced no attempt." };
    const offered = attempts.filter((attempt) => attempt.availableTools !== undefined);
    if (offered.length > 0 && offered.every((attempt) => !attempt.availableTools!.some((tool) => capability.tools.includes(tool)))) {
      return { ...base, status: "unsupported", detail: `The Runner offered none of: ${capability.tools.join(", ")}.` };
    }
    const used = attempts.filter((attempt) => attempt.succeededTools.some((tool) => capability.tools.includes(tool)));
    if (used.some((attempt) => attempt.passed)) return { ...base, status: "verified", detail: `Verified by ${used.filter((attempt) => attempt.passed).map((attempt) => attempt.caseId).join(", ")}.` };
    if (used.length > 0) return { ...base, status: "exercised", detail: "A capability tool ran, but no covering case passed its hidden checks." };
    return { ...base, status: "available", detail: "Offered, but no covering attempt used it successfully." };
  });
  return { rows, fullCoverage: false, note: "Results are scoped to the capabilities listed as verified; a pack pass does not establish full native-tool coverage." };
}

/** The capability ids a case declares (v5) or is mapped to in the manifest (v4). */
export function capabilitiesForCase(benchmarkCase: Pick<WorkBenchCase, "id" | "nativeQualification">): string[] {
  const declared = benchmarkCase.nativeQualification?.coverage;
  if (declared) return [...declared];
  return NATIVE_TOOL_COVERAGE.filter((capability) => capability.cases.includes(benchmarkCase.id)).map((capability) => capability.id);
}
