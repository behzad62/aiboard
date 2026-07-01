import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import { createWorkBenchCaseHash, toBenchmarkCaseV2 } from "./case-loader";
import type { WorkBenchCase } from "./types";
import {
  WORKBENCH_CHALLENGES,
  type WorkBenchChallenge,
  type WorkBenchChallengeKind,
} from "./challenges";

export type WorkBenchFixtureLanguage =
  | "typescript"
  | "python"
  | "go"
  | "rust"
  | "react-ui"
  | "json"
  | "csharp"
  | "cpp";

export interface WorkBenchCaseOption {
  id: string;
  label: string;
  fixtureLanguage: WorkBenchFixtureLanguage;
  challengeKind: WorkBenchChallengeKind;
  caseHash: string;
  referenceSolutionNotes: string;
  negativeControlWrongSolution: string;
  case: WorkBenchCase;
}

export interface WorkBenchCasePackOption {
  id: string;
  label: string;
  description: string;
  caseCount: number;
  caseIds: string[];
  cases: WorkBenchCaseOption[];
}

const EXTRA_LANGUAGE_CHALLENGES: WorkBenchChallenge[] = [
  csharpEmailNormalizer(1),
  csharpRoleClaim(2),
  cppClampScore(1),
  cppParsePort(2),
  goRetryStatus(1),
  goErrorWrapping(2),
  rustSaturatingAdd(1),
];

export function listWorkBenchChallenges(): WorkBenchChallenge[] {
  return [...WORKBENCH_CHALLENGES, ...EXTRA_LANGUAGE_CHALLENGES];
}

export function listWorkBenchCaseOptions(): WorkBenchCaseOption[] {
  return listWorkBenchChallenges().map(
    (challenge) => {
      const fixtureLanguage = languageForChallenge(challenge);
      const workBenchCase = workBenchCaseForChallenge(challenge, fixtureLanguage);
      return {
        id: workBenchCase.id,
        label: `${workBenchCase.title} (${fixtureLanguage})`,
        fixtureLanguage,
        challengeKind: challenge.kind,
        caseHash: createWorkBenchCaseHash(workBenchCase),
        referenceSolutionNotes: referenceNotesForChallenge(challenge),
        negativeControlWrongSolution: negativeNotesForChallenge(challenge),
        case: workBenchCase,
      };
    }
  );
}

export function getWorkBenchCaseOption(
  id: string
): WorkBenchCaseOption | null {
  return listWorkBenchCaseOptions().find((item) => item.id === id) ?? null;
}

export function listWorkBenchCasePacks(): WorkBenchCasePackOption[] {
  const cases = listWorkBenchCaseOptions();
  return [
    createWorkBenchCasePack({
      id: "workbench-current-all",
      label: `All current WorkBench cases (${cases.length})`,
      description: "Runs every current certified WorkBench fixture case.",
      cases,
    }),
    ...groupWorkBenchCasePacks({
      cases,
      idPrefix: "workbench-current-language",
      groupKey: (item) => item.fixtureLanguage,
      labelForGroup: (language, count) =>
        `${workBenchLanguageLabel(language)} cases (${count})`,
      descriptionForGroup: (language) =>
        `Runs current WorkBench cases using ${workBenchLanguageLabel(language)} fixtures.`,
    }),
    ...groupWorkBenchCasePacks({
      cases,
      idPrefix: "workbench-current-kind",
      groupKey: (item) => item.challengeKind,
      labelForGroup: (kind, count) =>
        `${workBenchChallengeKindLabel(kind)} cases (${count})`,
      descriptionForGroup: (kind) =>
        `Runs current WorkBench ${workBenchChallengeKindLabel(kind).toLowerCase()} cases.`,
    }),
  ];
}

export function getWorkBenchCasePack(
  id: string
): WorkBenchCasePackOption | null {
  return listWorkBenchCasePacks().find((pack) => pack.id === id) ?? null;
}

export function workBenchCaseToBenchmarkCaseV2(
  option: WorkBenchCaseOption,
  timestamp?: string
): BenchmarkCaseV2 {
  return toBenchmarkCaseV2(option.case, timestamp);
}

function workBenchCaseForChallenge(
  challenge: WorkBenchChallenge,
  fixtureLanguage: WorkBenchFixtureLanguage
): WorkBenchCase {
  const caseMeta = {
    id: challenge.id,
    baseFiles: challenge.baseFiles,
    referenceFiles: challenge.referenceFiles,
    verifier: challenge.verifier,
  };
  const fixtureFiles: Record<string, string> = {
    ...challenge.baseFiles,
    "case-meta.json": JSON.stringify(caseMeta, null, 2),
    "verifier.mjs": WORKBENCH_VERIFIER,
    "reference-solution.md": referenceNotesForChallenge(challenge),
    "negative-control.json": JSON.stringify(challenge.negativeControlFiles, null, 2),
    "verifier-result.json": JSON.stringify(
      {
        passed: false,
        score: 0,
        summary: "Verifier has not been run yet.",
        assertions: [],
      },
      null,
      2
    ),
  };

  return {
    schemaVersion: 1,
    id: challenge.id,
    title: challenge.title,
    description: `WorkBench ${challenge.kind} challenge with behavioral verifier and fixture-local execution.`,
    difficulty: challenge.difficulty,
    tags: [
      "workbench",
      fixtureLanguage,
      challenge.kind,
      ...challenge.tags.filter((tag) => tag !== fixtureLanguage),
    ],
    caseVersion: "2.0.0",
    prompt: {
      userRequest: challenge.prompt,
      publicContext:
        "This WorkBench case uses inline fixture files, a deterministic behavioral verifier, negative controls, and surgical-diff checks.",
      hiddenNotesHash: `hidden:${challenge.id}`,
    },
    repo: {
      url: "fixture://inline",
      baseCommit: "inline-workbench-current-base",
      shallowClone: true,
      fixtureHash: `inline:${challenge.id}`,
    },
    environment: {
      type: "local-runner",
      timeoutSeconds: 900,
      network: "dependency-only",
    },
    verifier: {
      command: "node verifier.mjs",
      resultFile: "verifier-result.json",
      publicCommand: "node verifier.mjs",
      timeoutSeconds: 90,
    },
    budget: {
      maxUsd: 4,
      maxWallClockSeconds: 900,
      maxModelCalls: 60,
      maxToolCalls: 180,
      maxInputTokens: 350000,
      maxOutputTokens: 100000,
    },
    scoring: {
      scoringVersion: "certified-workbench-current",
      costTargetUsd: 2,
      timeTargetSeconds: 420,
    },
    contamination: {
      originalTask: true,
      canary: `AIBENCH-WORKBENCH-${challenge.id.toUpperCase()}`,
      referenceSolutionPrivate: true,
      publicAfter: "2027-01-01",
    },
    allowedCommands: ["node verifier.mjs"],
    fixtureFiles,
  };
}

function groupWorkBenchCasePacks<T extends string>(input: {
  cases: WorkBenchCaseOption[];
  idPrefix: string;
  groupKey: (item: WorkBenchCaseOption) => T;
  labelForGroup: (group: T, count: number) => string;
  descriptionForGroup: (group: T) => string;
}): WorkBenchCasePackOption[] {
  const grouped = new Map<T, WorkBenchCaseOption[]>();
  for (const item of input.cases) {
    const key = input.groupKey(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.entries()].map(([group, cases]) =>
    createWorkBenchCasePack({
      id: `${input.idPrefix}-${group}`,
      label: input.labelForGroup(group, cases.length),
      description: input.descriptionForGroup(group),
      cases,
    })
  );
}

function createWorkBenchCasePack(input: {
  id: string;
  label: string;
  description: string;
  cases: WorkBenchCaseOption[];
}): WorkBenchCasePackOption {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    caseCount: input.cases.length,
    caseIds: input.cases.map((item) => item.id),
    cases: input.cases,
  };
}

function workBenchLanguageLabel(language: WorkBenchFixtureLanguage): string {
  switch (language) {
    case "typescript":
      return "TypeScript";
    case "python":
      return "Python";
    case "go":
      return "Go";
    case "rust":
      return "Rust";
    case "react-ui":
      return "React UI";
    case "json":
      return "JSON";
    case "csharp":
      return "C#";
    case "cpp":
      return "C++";
    default:
      return language;
  }
}

function workBenchChallengeKindLabel(kind: WorkBenchChallengeKind): string {
  switch (kind) {
    case "large-file-surgical-patch":
      return "Large-file surgical patch";
    case "multi-file-contract":
      return "Multi-file contract";
    case "parser-edge-case":
      return "Parser edge case";
    case "react-accessibility":
      return "React accessibility";
    case "large-json-config":
      return "Large JSON config";
    case "no-whole-file-rewrite":
      return "No whole-file rewrite";
    default:
      return kind;
  }
}

function languageForChallenge(
  challenge: WorkBenchChallenge
): WorkBenchFixtureLanguage {
  const paths = Object.keys(challenge.baseFiles);
  if (paths.some((path) => path.endsWith(".cs"))) return "csharp";
  if (paths.some((path) => path.endsWith(".cpp") || path.endsWith(".hpp"))) return "cpp";
  if (paths.some((path) => path.endsWith(".go"))) return "go";
  if (paths.some((path) => path.endsWith(".rs"))) return "rust";
  if (paths.some((path) => path.endsWith(".py"))) return "python";
  if (paths.some((path) => path.endsWith(".tsx"))) return "react-ui";
  if (paths.some((path) => path.endsWith(".json"))) return "json";
  return "typescript";
}

function referenceNotesForChallenge(challenge: WorkBenchChallenge): string {
  return [
    `Reference solution for ${challenge.id}.`,
    "The reference files represent deterministic behavior expected by the current verifier.",
    "The model should make the smallest safe edit that reaches this behavior while preserving unrelated sentinels.",
  ].join("\n");
}

function negativeNotesForChallenge(challenge: WorkBenchChallenge): string {
  return [
    `Negative control for ${challenge.id}.`,
    "The negative control intentionally misses part of the requested behavior or edits the wrong target.",
  ].join(" ");
}

function csharpEmailNormalizer(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/csharp/EmailNormalizer${id}.cs`;
  const base = `namespace Bench;\npublic static class EmailNormalizer${id}\n{\n    public static string Normalize(string input)\n    {\n        if (input == null) return string.Empty;\n        return input;\n    }\n}\n`;
  const reference = base.replace("return input;", "return input.Trim().ToLowerInvariant();");
  const negative = base.replace("return input;", "return input.ToLowerInvariant();");
  return simpleChallenge({
    id: `workbench-cs-email-${id}`,
    title: `C# email normalizer ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so Normalize trims whitespace and lowercases using invariant culture while preserving null handling.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 3,
    requiredSnippets: { [path]: ["input.Trim().ToLowerInvariant()"] },
    forbiddenSnippets: { [path]: ["return input.ToLowerInvariant();"] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function csharpRoleClaim(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/csharp/RoleClaims${id}.cs`;
  const base = `namespace Bench;\npublic sealed record UserClaim(string Type, string Value);\npublic static class RoleClaims${id}\n{\n    public static bool HasAdminRole(IEnumerable<UserClaim> claims)\n    {\n        return claims.Any(claim => claim.Value == "admin");\n    }\n}\n`;
  const reference = base.replace("claim.Value == \"admin\"", "claim.Type == \"role\" && string.Equals(claim.Value, \"admin\", StringComparison.OrdinalIgnoreCase)");
  const negative = base.replace("claim.Value == \"admin\"", "claim.Value.Contains(\"admin\")");
  return simpleChallenge({
    id: `workbench-cs-role-${id}`,
    title: `C# role claim filter ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so HasAdminRole only accepts role claims and compares admin case-insensitively without substring matching.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 4,
    requiredSnippets: { [path]: ["claim.Type == \"role\"", "StringComparison.OrdinalIgnoreCase"] },
    forbiddenSnippets: { [path]: ["Contains(\"admin\")"] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function cppClampScore(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/cpp/score_${id}.cpp`;
  const base = `#include <algorithm>\nint normalize_score_${id}(int score) {\n  return score;\n}\n`;
  const reference = base.replace("return score;", "return std::clamp(score, 0, 100);");
  const negative = base.replace("return score;", "return std::max(score, 0);");
  return simpleChallenge({
    id: `workbench-cpp-clamp-${id}`,
    title: `C++ score clamp ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so normalize_score_${id} clamps scores to the inclusive range 0..100.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 3,
    requiredSnippets: { [path]: ["std::clamp(score, 0, 100)"] },
    forbiddenSnippets: { [path]: ["std::max(score, 0)"] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function cppParsePort(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/cpp/port_${id}.cpp`;
  const base = `#include <string>\nint parse_port_${id}(const std::string& raw) {\n  return std::stoi(raw);\n}\n`;
  const reference = `#include <string>\n#include <stdexcept>\nint parse_port_${id}(const std::string& raw) {\n  const int port = std::stoi(raw);\n  if (port < 1 || port > 65535) {\n    throw std::out_of_range("port");\n  }\n  return port;\n}\n`;
  const negative = base.replace("return std::stoi(raw);", "return std::abs(std::stoi(raw));");
  return simpleChallenge({
    id: `workbench-cpp-port-${id}`,
    title: `C++ port parser ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so parse_port_${id} rejects ports outside 1..65535 using a clear range check.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 8,
    requiredSnippets: { [path]: ["port < 1 || port > 65535", "std::out_of_range"] },
    forbiddenSnippets: { [path]: ["std::abs"] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function goRetryStatus(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/go/retry_${id}.go`;
  const base = `package bench\nfunc shouldRetry${id}(status int) bool {\n\treturn status == 500\n}\n`;
  const reference = base.replace("status == 500", "status == 500 || status == 502 || status == 503 || status == 504");
  const negative = base.replace("status == 500", "status >= 400");
  return simpleChallenge({
    id: `workbench-go-retry-${id}`,
    title: `Go retry status classifier ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so only transient 5xx gateway/server statuses are retried: 500, 502, 503, and 504.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 4,
    requiredSnippets: { [path]: ["status == 502", "status == 503", "status == 504"] },
    forbiddenSnippets: { [path]: ["status >= 400"] },
  });
}

function goErrorWrapping(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/go/errors_${id}.go`;
  const base = `package bench\nimport "errors"\nfunc wrap${id}(err error) error {\n\tif err == nil { return nil }\n\treturn errors.New("load failed")\n}\n`;
  const reference = `package bench\nimport "fmt"\nfunc wrap${id}(err error) error {\n\tif err == nil { return nil }\n\treturn fmt.Errorf("load failed: %w", err)\n}\n`;
  const negative = base.replace("errors.New(\"load failed\")", "fmt.Errorf(\"load failed: %v\", err)");
  return simpleChallenge({
    id: `workbench-go-error-${id}`,
    title: `Go error wrapping ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so wrap${id} preserves the original error with %w and keeps nil behavior.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 5,
    requiredSnippets: { [path]: ["fmt.Errorf", "%w"] },
    forbiddenSnippets: { [path]: ["%v", "errors.New"] },
  });
}

function rustSaturatingAdd(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/rust/counter_${id}.rs`;
  const base = `pub fn add_count_${id}(left: u32, right: u32) -> u32 {\n    left + right\n}\n`;
  const reference = base.replace("left + right", "left.saturating_add(right)");
  const negative = base.replace("left + right", "left.wrapping_add(right)");
  return simpleChallenge({
    id: `workbench-rs-saturating-${id}`,
    title: `Rust saturating counter ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so add_count_${id} saturates instead of overflowing or wrapping.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 3,
    requiredSnippets: { [path]: ["saturating_add"] },
    forbiddenSnippets: { [path]: ["wrapping_add"] },
  });
}

function simpleChallenge(input: {
  id: string;
  title: string;
  kind: WorkBenchChallenge["kind"];
  difficulty: WorkBenchChallenge["difficulty"];
  prompt: string;
  baseFiles: Record<string, string>;
  referenceFiles: Record<string, string>;
  negativeFiles: Record<string, string>;
  maxChangedLines: number;
  requiredSnippets: Record<string, string[]>;
  forbiddenSnippets?: Record<string, string[]>;
  requiredUnchangedSnippets?: Record<string, string[]>;
  syntaxChecks?: WorkBenchChallenge["verifier"]["syntaxChecks"];
}): WorkBenchChallenge {
  return {
    id: input.id,
    title: input.title,
    kind: input.kind,
    difficulty: input.difficulty,
    prompt: input.prompt,
    tags: ["workbench", input.kind, input.difficulty],
    baseFiles: input.baseFiles,
    referenceFiles: input.referenceFiles,
    negativeControlFiles: input.negativeFiles,
    verifier: {
      maxChangedLines: input.maxChangedLines,
      requiredSnippets: input.requiredSnippets,
      forbiddenSnippets: input.forbiddenSnippets,
      requiredUnchangedSnippets: input.requiredUnchangedSnippets,
      syntaxChecks: input.syntaxChecks,
    },
  };
}

export const WORKBENCH_VERIFIER = String.raw`import { readFileSync, writeFileSync } from "node:fs";

const meta = JSON.parse(readFileSync("case-meta.json", "utf8"));
const files = Object.fromEntries(
  Object.keys(meta.baseFiles).map((path) => {
    try {
      return [path, readFileSync(path, "utf8")];
    } catch {
      return [path, ""];
    }
  })
);
const assertions = [];
const changedLineCount = totalChangedLines(meta.baseFiles, files);

for (const [path, snippets] of Object.entries(meta.verifier.requiredSnippets ?? {})) {
  const actual = files[path] ?? "";
  for (const snippet of snippets) {
    assertions.push({
      id: path + ":required:" + stableId(snippet),
      label: path + " contains required behavior",
      passed: actual.includes(snippet),
      weight: 1,
      message: actual.includes(snippet) ? undefined : "Missing required snippet: " + JSON.stringify(snippet),
    });
  }
}

for (const [path, snippets] of Object.entries(meta.verifier.requiredUnchangedSnippets ?? {})) {
  const actual = files[path] ?? "";
  const base = meta.baseFiles[path] ?? "";
  for (const snippet of snippets) {
    const expectedCount = occurrenceCount(base, snippet);
    const actualCount = occurrenceCount(actual, snippet);
    const passed = expectedCount > 0 ? actualCount >= expectedCount : actual.includes(snippet);
    assertions.push({
      id: path + ":unchanged:" + stableId(snippet),
      label: path + " preserves unrelated code",
      passed,
      weight: 1,
      message: passed ? undefined : "Changed or removed sentinel: " + JSON.stringify(snippet) + "; expected at least " + (expectedCount || 1) + ", found " + actualCount + ".",
    });
  }
}

for (const [path, snippets] of Object.entries(meta.verifier.forbiddenSnippets ?? {})) {
  const actual = files[path] ?? "";
  for (const snippet of snippets) {
    assertions.push({
      id: path + ":forbidden:" + stableId(snippet),
      label: path + " avoids known bad solution",
      passed: !actual.includes(snippet),
      weight: 1,
      message: !actual.includes(snippet) ? undefined : "Contains forbidden snippet: " + JSON.stringify(snippet),
    });
  }
}

if (typeof meta.verifier.maxChangedLines === "number") {
  assertions.push({
    id: "diff:max-changed-lines",
    label: "Diff is surgical",
    passed: changedLineCount <= meta.verifier.maxChangedLines,
    weight: 2,
    message: changedLineCount <= meta.verifier.maxChangedLines ? undefined : "Changed " + changedLineCount + " lines, limit is " + meta.verifier.maxChangedLines + ".",
  });
}

for (const syntax of meta.verifier.syntaxChecks ?? []) {
  assertions.push(syntaxAssertion(syntax.path, syntax.kind, files[syntax.path] ?? ""));
}

const scoredAssertions = assertions.filter((item) => item.weight > 0);
const totalWeight = scoredAssertions.reduce((sum, item) => sum + item.weight, 0);
const passedWeight = scoredAssertions.filter((item) => item.passed).reduce((sum, item) => sum + item.weight, 0);
const passed = scoredAssertions.length > 0 && scoredAssertions.every((item) => item.passed);
const result = {
  passed,
  score: scoredAssertions.length === 0 ? 0 : totalWeight > 0 ? passedWeight / totalWeight : passed ? 1 : 0,
  summary: scoredAssertions.length === 0 ? "verifier produced no assertions" : passed ? "WorkBench challenge passed." : "WorkBench challenge failed.",
  assertions,
  metrics: { changedLines: changedLineCount },
};
writeFileSync("verifier-result.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(passed ? 0 : 1);

function syntaxAssertion(path, kind, content) {
  if (kind === "json") {
    try {
      JSON.parse(content);
      return { id: path + ":json", label: path + " remains valid JSON", passed: true, weight: 1 };
    } catch (error) {
      return { id: path + ":json", label: path + " remains valid JSON", passed: false, weight: 1, message: String(error.message ?? error) };
    }
  }
  // Coarse heuristic only: counts braces anywhere and does not validate syntax.
  const passed = count(content, "{") === count(content, "}");
  return { id: path + ":balanced-braces", label: path + " has balanced braces", passed, weight: 0, message: passed ? undefined : "Brace counts do not match." };
}

function totalChangedLines(baseFiles, currentFiles) {
  const paths = Array.from(new Set([...Object.keys(baseFiles), ...Object.keys(currentFiles)]));
  return paths.reduce((sum, path) => sum + changedLines(baseFiles[path] ?? "", currentFiles[path] ?? ""), 0);
}

function changedLines(left, right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);
  let changed = 0;
  for (let index = 0; index < max; index++) {
    if ((leftLines[index] ?? "") !== (rightLines[index] ?? "")) changed += 1;
  }
  return changed;
}

function stableId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function count(value, needle) {
  return value.split(needle).length - 1;
}

function occurrenceCount(value, needle) {
  if (needle.length === 0) return 0;
  return value.split(needle).length - 1;
}
`;
