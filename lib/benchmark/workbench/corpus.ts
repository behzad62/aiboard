import type { BenchmarkCaseV2 } from "@/lib/benchmark/types";
import { createWorkBenchCaseHash, toBenchmarkCaseV2 } from "./case-loader";
import type { WorkBenchCase } from "./types";
import {
  WORKBENCH_CHALLENGES,
  type WorkBenchBehavioralCheck,
  type WorkBenchChallenge,
  type WorkBenchChallengeKind,
  type WorkBenchSnippet,
} from "./challenges";

export type WorkBenchFixtureLanguage =
  | "typescript"
  | "javascript"
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
  // The oracle stays out of the model-visible workspace: no reference files,
  // no negative-control listing. case-meta.json carries only what the runtime
  // verifier needs (base files + verifier config), and the bench runner hides
  // it from model-facing read endpoints while `node verifier.mjs` still reads
  // it from disk.
  const caseMeta = {
    id: challenge.id,
    baseFiles: challenge.baseFiles,
    verifier: challenge.verifier,
  };
  const fixtureFiles: Record<string, string> = {
    ...challenge.baseFiles,
    "case-meta.json": JSON.stringify(caseMeta, null, 2),
    "verifier.mjs": WORKBENCH_VERIFIER,
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
    description: `WorkBench ${challenge.kind} challenge with a deterministic verifier: executed behavioral checks for JavaScript/JSON fixtures, comment-aware static checks elsewhere, and surgical-diff limits.`,
    difficulty: challenge.difficulty,
    tags: [
      "workbench",
      fixtureLanguage,
      challenge.kind,
      ...challenge.tags.filter((tag) => tag !== fixtureLanguage),
    ],
    caseVersion: "3.0.0",
    prompt: {
      userRequest: challenge.prompt,
      publicContext:
        "This WorkBench case uses inline fixture files and a deterministic verifier with surgical-diff limits. Run the allowed verifier command to check progress; the grading spec is not part of the readable workspace.",
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
      maxInputTokens: 3500000,
      maxOutputTokens: 1000000,
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
    case "javascript":
      return "JavaScript";
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
    case "input-validation":
      return "Input validation";
    case "error-handling":
      return "Error handling";
    case "numeric-safety":
      return "Numeric safety";
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
  if (paths.some((path) => path.endsWith(".mjs") || path.endsWith(".js"))) return "javascript";
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
  const alternate = base.replace("return input;", "return input.ToLowerInvariant().Trim();");
  const negative = base.replace("return input;", "return input.ToLowerInvariant();");
  return simpleChallenge({
    id: `workbench-cs-email-${id}`,
    title: `C# email normalizer ${id}`,
    kind: "parser-edge-case",
    difficulty: "easy",
    prompt: `Patch ${path} so Normalize trims whitespace and lowercases with the invariant culture (Trim and ToLowerInvariant, in either order) while preserving the null handling.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 3,
    requiredSnippets: {
      [path]: [
        { anyOf: ["input.Trim().ToLowerInvariant()", "input.ToLowerInvariant().Trim()"] },
      ],
    },
    forbiddenSnippets: { [path]: ["return input;", "return input.ToLowerInvariant();"] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function csharpRoleClaim(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/csharp/RoleClaims${id}.cs`;
  const base = `namespace Bench;\npublic sealed record UserClaim(string Type, string Value);\npublic static class RoleClaims${id}\n{\n    public static bool HasAdminRole(IEnumerable<UserClaim> claims)\n    {\n        return claims.Any(claim => claim.Value == "admin");\n    }\n}\n`;
  const reference = base.replace("claim.Value == \"admin\"", "claim.Type == \"role\" && string.Equals(claim.Value, \"admin\", StringComparison.OrdinalIgnoreCase)");
  const alternate = base.replace(
    "claim.Value == \"admin\"",
    "string.Equals(claim.Type, \"role\", StringComparison.Ordinal) && string.Equals(claim.Value, \"admin\", StringComparison.OrdinalIgnoreCase)"
  );
  const negative = base.replace("claim.Value == \"admin\"", "claim.Value.Contains(\"admin\")");
  return simpleChallenge({
    id: `workbench-cs-role-${id}`,
    title: `C# role claim filter ${id}`,
    kind: "input-validation",
    difficulty: "medium",
    prompt: `Patch ${path} so HasAdminRole only accepts claims whose Type is "role" and whose Value equals "admin" case-insensitively via StringComparison.OrdinalIgnoreCase - no substring matching.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 4,
    requiredSnippets: {
      [path]: [
        { anyOf: ["claim.Type == \"role\"", "string.Equals(claim.Type, \"role\""] },
        "StringComparison.OrdinalIgnoreCase",
      ],
    },
    forbiddenSnippets: { [path]: ["Contains(\"admin\")", "claim.Value == \"admin\""] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function cppClampScore(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/cpp/score_${id}.cpp`;
  const base = `#include <algorithm>\nint normalize_score_${id}(int score) {\n  return score;\n}\n`;
  const reference = base.replace("return score;", "return std::clamp(score, 0, 100);");
  const alternate = base.replace("return score;", "return std::min(100, std::max(0, score));");
  const negative = base.replace("return score;", "return std::max(score, 0);");
  return simpleChallenge({
    id: `workbench-cpp-clamp-${id}`,
    title: `C++ score clamp ${id}`,
    kind: "numeric-safety",
    difficulty: "easy",
    prompt: `Patch ${path} so normalize_score_${id} clamps scores to the inclusive range 0..100 using std::clamp(score, 0, 100) or an equivalent std::min/std::max combination.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 3,
    requiredSnippets: {
      [path]: [
        {
          anyOf: [
            "std::clamp(score, 0, 100)",
            "std::min(100, std::max(0, score))",
            "std::max(0, std::min(100, score))",
            "std::min(std::max(score, 0), 100)",
          ],
        },
      ],
    },
    forbiddenSnippets: { [path]: ["return std::max(score, 0);", "return score;"] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function cppParsePort(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/cpp/port_${id}.cpp`;
  const base = `#include <string>\nint parse_port_${id}(const std::string& raw) {\n  return std::stoi(raw);\n}\n`;
  const reference = `#include <string>\n#include <stdexcept>\nint parse_port_${id}(const std::string& raw) {\n  const int port = std::stoi(raw);\n  if (port < 1 || port > 65535) {\n    throw std::out_of_range("port");\n  }\n  return port;\n}\n`;
  const alternate = `#include <stdexcept>\n#include <string>\nint parse_port_${id}(const std::string& raw) {\n  const int port = std::stoi(raw);\n  if (port <= 0 || port > 65535) {\n    throw std::out_of_range("port out of range");\n  }\n  return port;\n}\n`;
  const negative = base.replace("return std::stoi(raw);", "return std::abs(std::stoi(raw));");
  return simpleChallenge({
    id: `workbench-cpp-port-${id}`,
    title: `C++ port parser ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Patch ${path} so parse_port_${id} throws std::out_of_range for ports outside 1..65535 (a range check like port < 1 || port > 65535) and returns the parsed value otherwise.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 12,
    requiredSnippets: {
      [path]: [
        {
          anyOf: [
            "port < 1 || port > 65535",
            "port <= 0 || port > 65535",
            "port > 65535 || port < 1",
            "port > 65535 || port <= 0",
          ],
        },
        "std::out_of_range",
      ],
    },
    forbiddenSnippets: { [path]: ["std::abs", "return std::stoi(raw);"] },
    syntaxChecks: [{ path, kind: "balanced-braces" }],
  });
}

function goRetryStatus(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/go/retry_${id}.go`;
  const base = `package bench\nfunc shouldRetry${id}(status int) bool {\n\treturn status == 500\n}\n`;
  const reference = base.replace("status == 500", "status == 500 || status == 502 || status == 503 || status == 504");
  const alternate = `package bench\nfunc shouldRetry${id}(status int) bool {\n\tswitch status {\n\tcase 500, 502, 503, 504:\n\t\treturn true\n\t}\n\treturn false\n}\n`;
  const negative = base.replace("status == 500", "status >= 400");
  return simpleChallenge({
    id: `workbench-go-retry-${id}`,
    title: `Go retry status classifier ${id}`,
    kind: "error-handling",
    difficulty: "medium",
    prompt: `Patch ${path} so only transient 5xx gateway/server statuses are retried: exactly 500, 502, 503, and 504 (an == comparison chain or a switch statement both work).`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 8,
    requiredSnippets: {
      [path]: [
        { anyOf: ["status == 502", "502,", "502:"] },
        { anyOf: ["status == 503", "503,", "503:"] },
        { anyOf: ["status == 504", "504,", "504:"] },
      ],
    },
    forbiddenSnippets: {
      [path]: ["status >= 400", "status >= 500", "return status == 500\n"],
    },
  });
}

function goErrorWrapping(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/go/errors_${id}.go`;
  const base = `package bench\nimport "errors"\nfunc wrap${id}(err error) error {\n\tif err == nil { return nil }\n\treturn errors.New("load failed")\n}\n`;
  const reference = `package bench\nimport "fmt"\nfunc wrap${id}(err error) error {\n\tif err == nil { return nil }\n\treturn fmt.Errorf("load failed: %w", err)\n}\n`;
  const alternate = `package bench\nimport (\n\t"fmt"\n)\nfunc wrap${id}(err error) error {\n\tif err == nil { return nil }\n\treturn fmt.Errorf("load failed: %w", err)\n}\n`;
  const negative = base.replace("errors.New(\"load failed\")", "fmt.Errorf(\"load failed: %v\", err)");
  return simpleChallenge({
    id: `workbench-go-error-${id}`,
    title: `Go error wrapping ${id}`,
    kind: "error-handling",
    difficulty: "medium",
    prompt: `Patch ${path} so wrap${id} preserves the original error using fmt.Errorf with the %w verb, keeping nil behavior.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 8,
    requiredSnippets: { [path]: ["fmt.Errorf", "%w"] },
    forbiddenSnippets: { [path]: ["%v", "errors.New"] },
  });
}

function rustSaturatingAdd(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/rust/counter_${id}.rs`;
  const base = `pub fn add_count_${id}(left: u32, right: u32) -> u32 {\n    left + right\n}\n`;
  const reference = base.replace("left + right", "left.saturating_add(right)");
  const alternate = base.replace("left + right", "left.checked_add(right).unwrap_or(u32::MAX)");
  const negative = base.replace("left + right", "left.wrapping_add(right)");
  return simpleChallenge({
    id: `workbench-rs-saturating-${id}`,
    title: `Rust saturating counter ${id}`,
    kind: "numeric-safety",
    difficulty: "easy",
    prompt: `Patch ${path} so add_count_${id} saturates at the u32 maximum instead of overflowing or wrapping - use left.saturating_add(right) or an equivalent checked_add fallback to u32::MAX.`,
    baseFiles: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 3,
    requiredSnippets: {
      [path]: [{ anyOf: ["saturating_add", "checked_add(right).unwrap_or(u32::MAX)"] }],
    },
    forbiddenSnippets: { [path]: ["wrapping_add", "left + right"] },
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
  alternateFiles: Record<string, string>;
  maxChangedLines: number;
  requiredSnippets: Record<string, WorkBenchSnippet[]>;
  forbiddenSnippets?: Record<string, WorkBenchSnippet[]>;
  requiredUnchangedSnippets?: Record<string, string[]>;
  syntaxChecks?: WorkBenchChallenge["verifier"]["syntaxChecks"];
  behavioralChecks?: WorkBenchBehavioralCheck[];
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
    alternateSolutionFiles: input.alternateFiles,
    verifier: {
      maxChangedLines: input.maxChangedLines,
      requiredSnippets: input.requiredSnippets,
      forbiddenSnippets: input.forbiddenSnippets,
      requiredUnchangedSnippets: input.requiredUnchangedSnippets,
      syntaxChecks: input.syntaxChecks,
      behavioralChecks: input.behavioralChecks,
    },
  };
}

// Runtime verifier executed as `node verifier.mjs` in the bench-runner
// sandbox. It MUST stay behaviorally in sync with runWorkBenchChallengeVerifier
// in challenges.ts (same assertions, weights, and scoring); the parity checks
// in scripts/test-workbench-current-challenges.mts guard the two copies.
// Kept as String.raw: no backticks and no ${ inside (backtick is injected via
// String.fromCharCode(96)).
export const WORKBENCH_VERIFIER = String.raw`import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const BACKTICK = String.fromCharCode(96);
const rawMeta = readFileSync("case-meta.json", "utf8");
const meta = JSON.parse(rawMeta);
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
const strippedCache = new Map();

function strippedContent(path) {
  if (!strippedCache.has(path)) {
    strippedCache.set(path, stripComments(path, files[path] ?? ""));
  }
  return strippedCache.get(path);
}

for (const [path, snippets] of Object.entries(meta.verifier.requiredSnippets ?? {})) {
  const actual = strippedContent(path);
  for (const snippet of snippets) {
    const passed = snippetIncluded(actual, snippet);
    assertions.push({
      id: path + ":required:" + stableId(snippetKey(snippet)),
      label: path + " contains required verified behavior",
      passed,
      weight: 2,
      message: passed ? undefined : path + " is missing a required change described in the task.",
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
  const actual = strippedContent(path);
  for (const snippet of snippets) {
    const passed = !snippetIncluded(actual, snippet);
    assertions.push({
      id: path + ":forbidden:" + stableId(snippetKey(snippet)),
      label: path + " avoids known bad solution",
      passed,
      weight: 1,
      message: passed ? undefined : path + " still contains code the task asked to replace or avoid.",
    });
  }
}

const behavioralChecks = meta.verifier.behavioralChecks ?? [];
const jsCallChecks = [];
behavioralChecks.forEach((check, index) => {
  if (check.kind === "js-call") jsCallChecks.push({ check, index });
});
const probeResults = new Map();
if (jsCallChecks.length > 0) {
  // Hide the grading spec from candidate code while it executes: candidate
  // modules run in a child process and must not be able to read
  // case-meta.json at execution time.
  let metaRemoved = false;
  try {
    unlinkSync("case-meta.json");
    metaRemoved = true;
  } catch {}
  try {
    const byPath = new Map();
    for (const item of jsCallChecks) {
      const list = byPath.get(item.check.path) ?? [];
      list.push(item);
      byPath.set(item.check.path, list);
    }
    for (const [path, items] of byPath) {
      const outcomes = runJsProbe(
        path,
        items.map((item) => ({ functionName: item.check.functionName, args: item.check.args ?? [] }))
      );
      items.forEach((item, listIndex) => {
        probeResults.set(item.index, outcomes[listIndex] ?? { ok: false, error: "behavior probe returned no result" });
      });
    }
  } finally {
    if (metaRemoved) writeFileSync("case-meta.json", rawMeta);
  }
}
behavioralChecks.forEach((check, index) => {
  let passed = false;
  let message = "";
  if (check.kind === "js-call") {
    const outcome = probeResults.get(index) ?? { ok: false, error: "behavior probe missing" };
    if (!outcome.ok) {
      message = outcome.error || (check.functionName + " could not be executed.");
    } else {
      passed = canonicalJson(outcome.value) === canonicalJson(check.expected);
      if (!passed) message = check.functionName + " returned an unexpected value.";
    }
  } else if (check.kind === "json-value") {
    try {
      const parsed = JSON.parse(files[check.path] ?? "");
      const value = getJsonPath(parsed, check.keyPath);
      passed = canonicalJson(value) === canonicalJson(check.expected);
      if (!passed) message = check.keyPath.join(".") + " has an unexpected value.";
    } catch (error) {
      message = check.path + " could not be parsed: " + String((error && error.message) || error);
    }
  } else if (check.kind === "json-keys") {
    try {
      const parsed = JSON.parse(files[check.path] ?? "");
      const scope = getJsonPath(parsed, check.keyPath);
      if (scope && typeof scope === "object" && !Array.isArray(scope)) {
        const entries = Object.entries(scope).filter(([key]) => key.startsWith(check.prefix));
        passed =
          entries.length === check.count &&
          entries.every(([, value]) => canonicalJson(value) === canonicalJson(check.expectedValue));
        if (!passed) message = check.prefix + "* keys were changed, removed, or duplicated.";
      } else {
        message = check.keyPath.join(".") + " is not an object.";
      }
    } catch (error) {
      message = check.path + " could not be parsed: " + String((error && error.message) || error);
    }
  } else {
    message = "unknown behavioral check kind: " + String(check.kind);
  }
  assertions.push({
    id: "behavior:" + index,
    label: check.label,
    passed,
    weight: 3,
    message: passed ? undefined : message,
  });
});

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

function runJsProbe(path, calls) {
  const probeSource = [
    'const write = process.stdout.write.bind(process.stdout);',
    'const modulePath = process.env.WORKBENCH_PROBE_MODULE;',
    'const calls = JSON.parse(process.env.WORKBENCH_PROBE_CALLS || "[]");',
    'const { pathToFileURL } = await import("node:url");',
    'let mod = null;',
    'let importError = "";',
    'try { mod = await import(pathToFileURL(modulePath).href); } catch (error) { importError = String((error && error.message) || error); }',
    'const results = [];',
    'for (const call of calls) {',
    '  if (!mod) { results.push({ ok: false, error: "import failed: " + importError }); continue; }',
    '  const fn = mod[call.functionName];',
    '  if (typeof fn !== "function") { results.push({ ok: false, error: "missing export " + call.functionName }); continue; }',
    '  try { results.push({ ok: true, value: fn.apply(null, call.args) }); } catch (error) { results.push({ ok: false, error: String((error && error.message) || error) }); }',
    '}',
    'write("WORKBENCH_PROBE_RESULT:" + JSON.stringify(results) + "\\n");',
    'process.exit(0);',
  ].join("\n");
  const spawned = spawnSync(process.execPath, ["--input-type=module", "-e", probeSource], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20000,
    env: Object.assign({}, process.env, {
      WORKBENCH_PROBE_MODULE: resolve(path),
      WORKBENCH_PROBE_CALLS: JSON.stringify(calls),
    }),
  });
  const stdout = String(spawned.stdout ?? "");
  const lines = stdout.split("\n").filter((line) => line.startsWith("WORKBENCH_PROBE_RESULT:"));
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
  if (!lastLine) {
    return calls.map(() => ({ ok: false, error: "behavior probe produced no result" }));
  }
  try {
    const parsed = JSON.parse(lastLine.slice("WORKBENCH_PROBE_RESULT:".length));
    if (!Array.isArray(parsed)) throw new Error("malformed probe result");
    return parsed;
  } catch {
    return calls.map(() => ({ ok: false, error: "behavior probe result was malformed" }));
  }
}

function snippetKey(snippet) {
  return typeof snippet === "string" ? snippet : snippet.anyOf.join("|");
}

function snippetIncluded(content, snippet) {
  if (typeof snippet === "string") return content.includes(snippet);
  return snippet.anyOf.some((variant) => content.includes(variant));
}

function stripComments(path, content) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return content;
  if (lower.endsWith(".py")) return stripPythonComments(content);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) return stripCLikeComments(content, ['"', "'", BACKTICK], false);
  if (lower.endsWith(".go")) return stripCLikeComments(content, ['"', BACKTICK], true);
  if (/\.(rs|cs|cpp|cc|cxx|hpp|hh|c|h)$/.test(lower)) return stripCLikeComments(content, ['"'], true);
  return stripCLikeComments(content, ['"', "'", BACKTICK], false);
}

function stripCLikeComments(content, stringDelims, charLiteral) {
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = i + 1 < n ? content[i + 1] : "";
    if (ch === "/" && next === "/") {
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(content[i] === "*" && content[i + 1] === "/")) {
        if (content[i] === "\n") out += "\n";
        i++;
      }
      i = Math.min(n, i + 2);
      continue;
    }
    if (charLiteral && ch === "'") {
      const slice = content.slice(i, i + 4);
      const match = /^'(?:\\.|[^'\\\n])'/.exec(slice);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (stringDelims.includes(ch)) {
      out += ch;
      i++;
      while (i < n) {
        const sc = content[i];
        out += sc;
        i++;
        if (sc === "\\") {
          if (i < n) {
            out += content[i];
            i++;
          }
          continue;
        }
        if (sc === ch) break;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function stripPythonComments(content) {
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "#") {
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = content.slice(i, i + 3) === ch + ch + ch;
      const delim = triple ? ch + ch + ch : ch;
      out += delim;
      i += delim.length;
      while (i < n) {
        if (content[i] === "\\") {
          out += content.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (content.slice(i, i + delim.length) === delim) {
          out += delim;
          i += delim.length;
          break;
        }
        out += content[i];
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function getJsonPath(value, keyPath) {
  let current = value;
  for (const key of keyPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  if (value === undefined) return "null";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

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
  if (left === right) return 0;
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const lcs = lcsLength(leftLines, rightLines);
  return (leftLines.length - lcs) + (rightLines.length - lcs);
}

function lcsLength(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const curr = new Array(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], curr[j]);
    }
    prev = curr;
  }
  return prev[b.length];
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
