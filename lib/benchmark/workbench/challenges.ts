export type WorkBenchChallengeKind =
  | "large-file-surgical-patch"
  | "multi-file-contract"
  | "parser-edge-case"
  | "react-accessibility"
  | "large-json-config"
  | "no-whole-file-rewrite"
  | "input-validation"
  | "error-handling"
  | "numeric-safety";

export interface WorkBenchAssertion {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  message?: string;
}

/**
 * A snippet assertion. A plain string must appear verbatim; an `anyOf` entry
 * passes when any one of the equally-correct spellings appears. Required and
 * forbidden snippets are checked against comment-stripped content so that
 * pasting a snippet inside a comment can neither satisfy a required check nor
 * trip a forbidden one.
 */
export type WorkBenchSnippet = string | { anyOf: string[] };

/**
 * Executed behavioral checks. `js-call` checks dynamically evaluate the
 * challenge's JavaScript fixture files and assert real input/output pairs;
 * `json-value` / `json-keys` checks parse a JSON fixture and assert values,
 * so formatting-equivalent answers pass and comment/duplicate-key tricks fail.
 */
export type WorkBenchBehavioralCheck =
  | {
      kind: "js-call";
      path: string;
      functionName: string;
      args: unknown[];
      expected: unknown;
      label: string;
    }
  | {
      kind: "json-value";
      path: string;
      keyPath: string[];
      expected: unknown;
      label: string;
    }
  | {
      kind: "json-keys";
      path: string;
      keyPath: string[];
      prefix: string;
      count: number;
      expectedValue: unknown;
      label: string;
    };

export interface WorkBenchChallenge {
  id: string;
  title: string;
  kind: WorkBenchChallengeKind;
  difficulty: "easy" | "medium" | "hard" | "expert";
  prompt: string;
  tags: string[];
  baseFiles: Record<string, string>;
  referenceFiles: Record<string, string>;
  negativeControlFiles: Record<string, string>;
  /**
   * A genuinely different but equally-correct solution. Test harnesses assert
   * it passes the verifier, guarding against snippet checks that only accept
   * the reference implementation's exact spelling.
   */
  alternateSolutionFiles: Record<string, string>;
  verifier: {
    maxChangedLines?: number;
    requiredSnippets: Record<string, WorkBenchSnippet[]>;
    forbiddenSnippets?: Record<string, WorkBenchSnippet[]>;
    requiredUnchangedSnippets?: Record<string, string[]>;
    syntaxChecks?: Array<{ path: string; kind: "json" | "balanced-braces" }>;
    behavioralChecks?: WorkBenchBehavioralCheck[];
  };
}

export interface WorkBenchChallengeResult {
  challengeId: string;
  passed: boolean;
  score: number;
  summary: string;
  assertions: WorkBenchAssertion[];
  changedLines: number;
}

interface LargeNormalizerVariant {
  target: number;
  behaviorSummary: string;
  fixedReturn: string;
  negativeReturn: string;
  alternateReturn: string;
  calls: Array<{ args: unknown[]; expected: unknown }>;
}

const LARGE_NORMALIZER_VARIANTS: LargeNormalizerVariant[] = [
  {
    target: 23,
    behaviorSummary: "trims surrounding whitespace and lowercases the value",
    fixedReturn: "return raw.trim().toLowerCase();",
    negativeReturn: "return raw.toLowerCase();",
    alternateReturn: "return raw.toLowerCase().trim();",
    calls: [
      { args: ["  Mixed CASE  "], expected: "mixed case" },
      { args: ["ALPHA"], expected: "alpha" },
    ],
  },
  {
    target: 117,
    behaviorSummary: "trims the value and collapses internal whitespace runs to single spaces",
    fixedReturn: 'return raw.trim().replace(/\\s+/g, " ");',
    negativeReturn: 'return raw.replace(/\\s+/g, " ");',
    alternateReturn: 'return raw.split(/\\s+/).filter(Boolean).join(" ");',
    calls: [
      { args: ["  alpha   beta "], expected: "alpha beta" },
      { args: ["one\ttwo  three"], expected: "one two three" },
    ],
  },
  {
    target: 181,
    behaviorSummary: 'strips a leading "legacy:" prefix when present and trims the result',
    fixedReturn: 'return raw.replace(/^legacy:/, "").trim();',
    negativeReturn: 'return raw.replace(/^legacy:/, "");',
    alternateReturn: 'return (raw.startsWith("legacy:") ? raw.slice(7) : raw).trim();',
    calls: [
      { args: ["legacy: main "], expected: "main" },
      { args: ["  main  "], expected: "main" },
    ],
  },
  {
    target: 209,
    behaviorSummary: "trims surrounding whitespace and uppercases the value",
    fixedReturn: "return raw.trim().toUpperCase();",
    negativeReturn: "return raw.toUpperCase();",
    alternateReturn: "return raw.toUpperCase().trim();",
    calls: [
      { args: ["  ship it "], expected: "SHIP IT" },
      { args: ["Warn"], expected: "WARN" },
    ],
  },
];

export const WORKBENCH_CHALLENGES: WorkBenchChallenge[] = [
  ...Array.from({ length: 4 }, (_, index) => largeFileSurgicalPatch(index + 1)),
  ...Array.from({ length: 2 }, (_, index) => multiFileContract(index + 1)),
  ...Array.from({ length: 2 }, (_, index) => parserEdgeCase(index + 1)),
  ...Array.from({ length: 2 }, (_, index) => reactAccessibilityCase(index + 1)),
  largeJsonConfigCase(1),
  noWholeFileRewriteCase(1),
  pipelineBehaviorCase(1),
];

export function runWorkBenchChallengeVerifier(input: {
  challenge: WorkBenchChallenge;
  files: Record<string, string>;
}): WorkBenchChallengeResult {
  const assertions: WorkBenchAssertion[] = [];
  const changedLines = totalChangedLines(input.challenge.baseFiles, input.files);
  const strippedCache = new Map<string, string>();
  const stripped = (path: string): string => {
    const cached = strippedCache.get(path);
    if (cached !== undefined) return cached;
    const value = stripComments(path, input.files[path] ?? "");
    strippedCache.set(path, value);
    return value;
  };

  for (const [path, snippets] of Object.entries(input.challenge.verifier.requiredSnippets)) {
    const actual = stripped(path);
    for (const snippet of snippets) {
      const passed = snippetIncluded(actual, snippet);
      assertions.push({
        id: `${path}:required:${stableId(snippetKey(snippet))}`,
        label: `${path} contains required verified behavior`,
        passed,
        weight: 2,
        message: passed
          ? undefined
          : `${path} is missing a required change described in the task.`,
      });
    }
  }

  for (const [path, snippets] of Object.entries(input.challenge.verifier.requiredUnchangedSnippets ?? {})) {
    const actual = input.files[path] ?? "";
    const base = input.challenge.baseFiles[path] ?? "";
    for (const snippet of snippets) {
      const expectedCount = occurrenceCount(base, snippet);
      const actualCount = occurrenceCount(actual, snippet);
      const passed =
        expectedCount > 0 ? actualCount >= expectedCount : actual.includes(snippet);
      assertions.push({
        id: `${path}:unchanged:${stableId(snippet)}`,
        label: `${path} preserves unrelated code`,
        passed,
        weight: 1,
        message: passed
          ? undefined
          : `${path} changed or removed unrelated sentinel ${JSON.stringify(snippet)}; expected at least ${expectedCount || 1}, found ${actualCount}.`,
      });
    }
  }

  for (const [path, snippets] of Object.entries(input.challenge.verifier.forbiddenSnippets ?? {})) {
    const actual = stripped(path);
    for (const snippet of snippets) {
      const passed = !snippetIncluded(actual, snippet);
      assertions.push({
        id: `${path}:forbidden:${stableId(snippetKey(snippet))}`,
        label: `${path} avoids known bad solution`,
        passed,
        weight: 1,
        message: passed
          ? undefined
          : `${path} still contains code the task asked to replace or avoid.`,
      });
    }
  }

  const behavioralChecks = input.challenge.verifier.behavioralChecks ?? [];
  let jsExports: Record<string, unknown> | null = null;
  let jsExportsError = "";
  if (behavioralChecks.some((check) => check.kind === "js-call")) {
    const evaluated = evaluateJsModules(input.files);
    jsExports = evaluated.exports;
    jsExportsError = evaluated.error;
  }
  behavioralChecks.forEach((check, index) => {
    let passed = false;
    let message = "";
    if (check.kind === "js-call") {
      if (!jsExports) {
        message = jsExportsError || "fixture code could not be evaluated";
      } else {
        const fn = jsExports[check.functionName];
        if (typeof fn !== "function") {
          message = `missing export ${check.functionName}`;
        } else {
          try {
            const value = (fn as (...args: unknown[]) => unknown)(
              ...check.args.map((arg) => cloneJson(arg))
            );
            passed = canonicalJson(value) === canonicalJson(check.expected);
            if (!passed) message = `${check.functionName} returned an unexpected value.`;
          } catch (error) {
            message = `${check.functionName} threw: ${errorMessage(error)}`;
          }
        }
      }
    } else if (check.kind === "json-value") {
      try {
        const parsed = JSON.parse(input.files[check.path] ?? "") as unknown;
        const value = getJsonPath(parsed, check.keyPath);
        passed = canonicalJson(value) === canonicalJson(check.expected);
        if (!passed) message = `${check.keyPath.join(".")} has an unexpected value.`;
      } catch (error) {
        message = `${check.path} could not be parsed: ${errorMessage(error)}`;
      }
    } else {
      try {
        const parsed = JSON.parse(input.files[check.path] ?? "") as unknown;
        const scope = getJsonPath(parsed, check.keyPath);
        if (scope && typeof scope === "object" && !Array.isArray(scope)) {
          const entries = Object.entries(scope as Record<string, unknown>).filter(([key]) =>
            key.startsWith(check.prefix)
          );
          passed =
            entries.length === check.count &&
            entries.every(([, value]) => canonicalJson(value) === canonicalJson(check.expectedValue));
          if (!passed) message = `${check.prefix}* keys were changed, removed, or duplicated.`;
        } else {
          message = `${check.keyPath.join(".")} is not an object.`;
        }
      } catch (error) {
        message = `${check.path} could not be parsed: ${errorMessage(error)}`;
      }
    }
    assertions.push({
      id: `behavior:${index}`,
      label: check.label,
      passed,
      weight: 3,
      message: passed ? undefined : message,
    });
  });

  if (input.challenge.verifier.maxChangedLines !== undefined) {
    assertions.push({
      id: "diff:max-changed-lines",
      label: "Diff is surgical",
      passed: changedLines <= input.challenge.verifier.maxChangedLines,
      weight: 2,
      message:
        changedLines <= input.challenge.verifier.maxChangedLines
          ? undefined
          : `Changed ${changedLines} lines, limit is ${input.challenge.verifier.maxChangedLines}.`,
    });
  }

  for (const syntax of input.challenge.verifier.syntaxChecks ?? []) {
    assertions.push(syntaxAssertion(syntax.path, syntax.kind, input.files[syntax.path] ?? ""));
  }

  const scoredAssertions = assertions.filter((item) => item.weight > 0);
  const totalWeight = scoredAssertions.reduce((sum, item) => sum + item.weight, 0);
  const passedWeight = scoredAssertions
    .filter((item) => item.passed)
    .reduce((sum, item) => sum + item.weight, 0);
  const passed =
    scoredAssertions.length > 0 &&
    scoredAssertions.every((item) => item.passed);
  return {
    challengeId: input.challenge.id,
    passed,
    score:
      scoredAssertions.length === 0
        ? 0
        : totalWeight > 0
          ? passedWeight / totalWeight
          : passed
            ? 1
            : 0,
    summary:
      scoredAssertions.length === 0
        ? "verifier produced no assertions"
        : passed
          ? "WorkBench challenge passed."
          : "WorkBench challenge failed.",
    assertions,
    changedLines,
  };
}

function largeFileSurgicalPatch(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const variant = LARGE_NORMALIZER_VARIANTS[number - 1];
  const path = `src/large/normalizer-${id}.mjs`;
  const marker = `WORKBENCH_TARGET_BRANCH_${id}`;
  const targetTag = String(variant.target).padStart(3, "0");
  const base = largeNormalizerFile(marker, variant.target, "return raw;");
  const reference = largeNormalizerFile(marker, variant.target, variant.fixedReturn);
  const negative = largeNormalizerFile(marker, variant.target, variant.negativeReturn);
  const alternate = largeNormalizerFile(marker, variant.target, variant.alternateReturn);
  const sentinelTags = Array.from(
    new Set([
      "001",
      "060",
      "220",
      String(variant.target - 1).padStart(3, "0"),
      String(variant.target + 1).padStart(3, "0"),
    ])
  ).filter((tag) => tag !== targetTag);
  return challenge({
    id: `workbench-large-normalizer-${id}`,
    title: `Large-file string normalizer ${id}`,
    kind: "large-file-surgical-patch",
    difficulty: "hard",
    prompt: `In ${path}, patch only the branch function normalizeBranch_${targetTag} marked ${marker} so it ${variant.behaviorSummary}. Do not modify any other branch; the verifier executes the file and checks both the target branch and untouched branches.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 4,
    requiredSnippets: {},
    requiredUnchangedSnippets: {
      [path]: [
        ...sentinelTags.map((tag) => `return raw; // non-target sentinel ${tag}`),
        `// ${marker}`,
      ],
    },
    behavioralChecks: [
      ...variant.calls.map((call, index) => ({
        kind: "js-call" as const,
        path,
        functionName: `normalizeBranch_${targetTag}`,
        args: call.args,
        expected: call.expected,
        label: `normalizeBranch_${targetTag} ${variant.behaviorSummary} (case ${index + 1})`,
      })),
      {
        kind: "js-call" as const,
        path,
        functionName: "normalizeBranch_010",
        args: ["  Keep Me "],
        expected: "  Keep Me ",
        label: "non-target branch 010 keeps identity behavior",
      },
      {
        kind: "js-call" as const,
        path,
        functionName: "normalizeBranch_150",
        args: ["  Keep Me "],
        expected: "  Keep Me ",
        label: "non-target branch 150 keeps identity behavior",
      },
    ],
  });
}

function multiFileContract(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const typesPath = `src/contracts/invoice-${id}.ts`;
  const servicePath = `src/services/invoice-${id}.ts`;
  const variant =
    number === 1
      ? {
          field: "currency",
          typeLine: `  currency: "USD" | "EUR";`,
          typeVariants: [
            `currency: "USD" | "EUR";`,
            `currency: 'USD' | 'EUR';`,
            `currency: "USD"|"EUR";`,
          ],
          describe: `a required currency field typed "USD" | "EUR"`,
        }
      : {
          field: "dueDate",
          typeLine: "  dueDate: string;",
          typeVariants: ["dueDate: string;", "dueDate: string"],
          describe: "a required dueDate field typed string (an ISO-8601 date)",
        };
  const baseFiles = {
    [typesPath]: `export interface Invoice_${id} {\n  id: string;\n  totalCents: number;\n}\n`,
    [servicePath]: `import type { Invoice_${id} } from "../contracts/invoice-${id}";\nexport function summarize_${id}(invoice: Invoice_${id}) {\n  return { id: invoice.id, total: invoice.totalCents };\n}\n`,
  };
  const referenceFiles = {
    [typesPath]: `export interface Invoice_${id} {\n  id: string;\n  totalCents: number;\n${variant.typeLine}\n}\n`,
    [servicePath]: `import type { Invoice_${id} } from "../contracts/invoice-${id}";\nexport function summarize_${id}(invoice: Invoice_${id}) {\n  return { id: invoice.id, total: invoice.totalCents, ${variant.field}: invoice.${variant.field} };\n}\n`,
  };
  const negativeFiles = {
    [typesPath]: referenceFiles[typesPath],
    [servicePath]: baseFiles[servicePath],
  };
  const alternateFiles = {
    [typesPath]: referenceFiles[typesPath],
    [servicePath]: `import type { Invoice_${id} } from "../contracts/invoice-${id}";\nexport function summarize_${id}(invoice: Invoice_${id}) {\n  return { ${variant.field}: invoice.${variant.field}, id: invoice.id, total: invoice.totalCents };\n}\n`,
  };
  return challenge({
    id: `workbench-contract-${id}`,
    title: `Multi-file invoice contract ${id}`,
    kind: "multi-file-contract",
    difficulty: "medium",
    prompt: `Update the invoice contract and summary service so ${variant.field} is carried through both files: add ${variant.describe} to Invoice_${id} in ${typesPath}, and include ${variant.field}: invoice.${variant.field} in the summarize_${id} result in ${servicePath}.`,
    files: baseFiles,
    referenceFiles,
    negativeFiles,
    alternateFiles,
    maxChangedLines: 6,
    requiredSnippets: {
      [typesPath]: [{ anyOf: variant.typeVariants }],
      [servicePath]: [`${variant.field}: invoice.${variant.field}`],
    },
    forbiddenSnippets: {
      [servicePath]: ["return { id: invoice.id, total: invoice.totalCents };"],
    },
  });
}

function parserEdgeCase(number: number): WorkBenchChallenge {
  return number === 1 ? parserBoolCase(number) : parserLevelCase(number);
}

function parserBoolCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/parser/flags-${id}.py`;
  const base = `def parse_flag_${id}(raw):\n    if raw == "true":\n        return True\n    if raw == "false":\n        return False\n    return None\n`;
  const reference = `def parse_flag_${id}(raw):\n    value = str(raw).strip().lower()\n    if value in ("true", "1", "yes"):\n        return True\n    if value in ("false", "0", "no"):\n        return False\n    return None\n`;
  const alternate = `def parse_flag_${id}(raw):\n    value = str(raw).strip().lower()\n    if value in {'true', '1', 'yes'}:\n        return True\n    if value in {'false', '0', 'no'}:\n        return False\n    return None\n`;
  const negative = `def parse_flag_${id}(raw):\n    if raw:\n        return True\n    return False\n`;
  return challenge({
    id: `workbench-parser-${id}`,
    title: `Boolean parser edge cases ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Make parse_flag_${id} handle surrounding whitespace, upper/lower case, numeric strings, and yes/no: normalize the input with str(raw).strip().lower(), use membership tests so true/1/yes return True and false/0/no return False, and return None for anything else.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 10,
    requiredSnippets: {
      [path]: [
        "strip().lower()",
        {
          anyOf: [
            `("true", "1", "yes")`,
            `('true', '1', 'yes')`,
            `{"true", "1", "yes"}`,
            `{'true', '1', 'yes'}`,
          ],
        },
        {
          anyOf: [
            `("false", "0", "no")`,
            `('false', '0', 'no')`,
            `{"false", "0", "no"}`,
            `{'false', '0', 'no'}`,
          ],
        },
      ],
    },
    forbiddenSnippets: {
      [path]: [`raw == "true"`, "if raw:\n        return True"],
    },
  });
}

function parserLevelCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/parser/levels-${id}.py`;
  const base = `def parse_level_${id}(raw):\n    if raw == "debug":\n        return 10\n    if raw == "info":\n        return 20\n    return 0\n`;
  const reference = `def parse_level_${id}(raw):\n    value = str(raw).strip().lower()\n    levels = {"debug": 10, "info": 20, "warn": 30, "error": 40}\n    return levels.get(value)\n`;
  const alternate = `def parse_level_${id}(raw):\n    value = str(raw).strip().lower()\n    if value == "debug":\n        return 10\n    if value == "info":\n        return 20\n    if value == "warn":\n        return 30\n    if value == "error":\n        return 40\n    return None\n`;
  const negative = `def parse_level_${id}(raw):\n    value = str(raw).strip().lower()\n    if value == "debug":\n        return 10\n    if value == "info":\n        return 20\n    return 0\n`;
  return challenge({
    id: `workbench-parser-${id}`,
    title: `Log level parser edge cases ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `parse_level_${id}(" WARN ") currently returns 0 even though warn is a valid level. Fix it so debug/info/warn/error map to 10/20/30/40, surrounding whitespace and case are ignored (normalize with str(raw).strip().lower()), and unknown values return None instead of 0.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 14,
    requiredSnippets: {
      [path]: [
        "strip().lower()",
        { anyOf: [`"warn"`, `'warn'`] },
        { anyOf: [`"error"`, `'error'`] },
      ],
    },
    forbiddenSnippets: {
      [path]: ["return 0", `raw == "debug"`],
    },
  });
}

function reactAccessibilityCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/components/Toolbar${id}.tsx`;
  const variant =
    number === 1
      ? {
          row: 88,
          primaryTestId: `primary-save-${id}`,
          secondaryTestId: `secondary-save-${id}`,
          label: `Save changes ${id}`,
          icon: "SaveIcon",
          controlName: "primary save icon button",
        }
      : {
          row: 47,
          primaryTestId: `danger-delete-${id}`,
          secondaryTestId: `secondary-delete-${id}`,
          label: `Delete draft ${id}`,
          icon: "TrashIcon",
          controlName: "danger delete icon button",
        };
  const base = longToolbarFile(id, variant, false);
  const reference = longToolbarFile(id, variant, true);
  const negative = base.replace(
    `data-testid="${variant.primaryTestId}"`,
    `title="${variant.label}" data-testid="${variant.primaryTestId}"`
  );
  const alternate = base.replace(
    `data-testid="${variant.primaryTestId}"`,
    `data-testid="${variant.primaryTestId}" aria-label="${variant.label}"`
  );
  return challenge({
    id: `workbench-react-a11y-${id}`,
    title: `Long React toolbar accessibility ${id}`,
    kind: "react-accessibility",
    difficulty: "hard",
    prompt: `Add aria-label="${variant.label}" to the ${variant.controlName} (data-testid "${variant.primaryTestId}") only. Do not add visible text, do not use the title attribute, and do not edit the secondary button.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 4,
    requiredSnippets: { [path]: [`aria-label="${variant.label}"`] },
    requiredUnchangedSnippets: {
      [path]: [`data-testid="${variant.secondaryTestId}"`, "Toolbar sentinel 120"],
    },
    forbiddenSnippets: { [path]: [`title="${variant.label}"`] },
  });
}

function largeJsonConfigCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `config/feature-flags-${id}.json`;
  const base = largeConfigJson(id, false);
  const reference = largeConfigJson(id, true);
  const negative = largeConfigJson(id, false).replace(`"legacyCheckout_${id}": false`, `"legacyCheckout_${id}": true`);
  const alternate = reference.replace(
    `    "legacyCheckout_${id}": false,\n    "betaCheckout_${id}": true,`,
    `    "betaCheckout_${id}": true,\n    "legacyCheckout_${id}": false,`
  );
  return challenge({
    id: `workbench-json-config-${id}`,
    title: `Large JSON feature flag ${id}`,
    kind: "large-json-config",
    difficulty: "hard",
    prompt: `Enable only betaCheckout_${id}; keep legacyCheckout_${id} false and all sentinel config keys unchanged. The verifier parses the JSON and asserts the flag values.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 3,
    requiredSnippets: {},
    requiredUnchangedSnippets: { [path]: [`"legacyCheckout_${id}": false`, `"sentinel_${id}_250": "keep"`] },
    forbiddenSnippets: { [path]: [`"betaCheckout_${id}": false`] },
    syntaxChecks: [{ path, kind: "json" }],
    behavioralChecks: [
      {
        kind: "json-value",
        path,
        keyPath: ["features", `betaCheckout_${id}`],
        expected: true,
        label: `betaCheckout_${id} is enabled`,
      },
      {
        kind: "json-value",
        path,
        keyPath: ["features", `legacyCheckout_${id}`],
        expected: false,
        label: `legacyCheckout_${id} stays disabled`,
      },
      {
        kind: "json-keys",
        path,
        keyPath: ["features"],
        prefix: `sentinel_${id}_`,
        count: 300,
        expectedValue: "keep",
        label: "all 300 sentinel keys stay intact",
      },
    ],
  });
}

function noWholeFileRewriteCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/math/noRewrite${id}.mjs`;
  const base = noRewriteSource(id, "return value;");
  const reference = noRewriteSource(id, `return clamp_${id}(value, 0, 100);`);
  const alternate = noRewriteSource(id, "return Math.max(0, Math.min(100, value));");
  const negative = reference.replace(`NO_REWRITE_SENTINEL_${id}_200`, `BROKEN_SENTINEL_${id}_200`);
  return challenge({
    id: `workbench-no-rewrite-${id}`,
    title: `No whole-file rewrite math helper ${id}`,
    kind: "no-whole-file-rewrite",
    difficulty: "expert",
    prompt: `Fix normalizePercent_${id} in ${path} so its result is clamped into the inclusive range 0..100 (the clamp_${id} helper already exists, or use an equivalent expression). Patch that function only, preserve all sentinels, and keep the diff tiny.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    alternateFiles: { [path]: alternate },
    maxChangedLines: 3,
    requiredSnippets: {},
    requiredUnchangedSnippets: { [path]: [`NO_REWRITE_SENTINEL_${id}_200`, `NO_REWRITE_SENTINEL_${id}_380`] },
    behavioralChecks: [
      {
        kind: "js-call",
        path,
        functionName: `normalizePercent_${id}`,
        args: [150],
        expected: 100,
        label: `normalizePercent_${id} clamps values above 100`,
      },
      {
        kind: "js-call",
        path,
        functionName: `normalizePercent_${id}`,
        args: [-25],
        expected: 0,
        label: `normalizePercent_${id} clamps negative values to 0`,
      },
      {
        kind: "js-call",
        path,
        functionName: `normalizePercent_${id}`,
        args: [42],
        expected: 42,
        label: `normalizePercent_${id} keeps in-range values`,
      },
      {
        kind: "js-call",
        path,
        functionName: `clamp_${id}`,
        args: [150, 0, 100],
        expected: 100,
        label: `clamp_${id} helper behavior is unchanged`,
      },
    ],
  });
}

function pipelineBehaviorCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const validatePath = `src/pipeline/validate_${id}.mjs`;
  const transformPath = `src/pipeline/transform_${id}.mjs`;
  const processPath = `src/pipeline/process_${id}.mjs`;
  const transformSource = `export function normalizeRecord_${id}(record) {\n  return { name: record.name.trim(), qty: record.qty };\n}\n`;
  const processSource = `import { isValidRecord_${id} } from "./validate_${id}.mjs";\nimport { normalizeRecord_${id} } from "./transform_${id}.mjs";\nexport function processRecords_${id}(records) {\n  return records.filter(isValidRecord_${id}).map(normalizeRecord_${id});\n}\n`;
  const validateBase = `export function isValidRecord_${id}(record) {\n  if (!record || typeof record !== "object") return false;\n  return typeof record.name === "string" && record.name.trim().length > 0;\n}\n`;
  const validateReference = `export function isValidRecord_${id}(record) {\n  if (!record || typeof record !== "object") return false;\n  if (typeof record.qty !== "number" || !Number.isFinite(record.qty) || record.qty < 0) return false;\n  return typeof record.name === "string" && record.name.trim().length > 0;\n}\n`;
  const validateNegative = `export function isValidRecord_${id}(record) {\n  if (!record || typeof record !== "object") return false;\n  if (record.qty === undefined) return false;\n  return typeof record.name === "string" && record.name.trim().length > 0;\n}\n`;
  const validateAlternate = `export function isValidRecord_${id}(record) {\n  if (!record || typeof record !== "object") return false;\n  return (\n    typeof record.name === "string" &&\n    record.name.trim().length > 0 &&\n    typeof record.qty === "number" &&\n    Number.isFinite(record.qty) &&\n    record.qty >= 0\n  );\n}\n`;
  const sampleRecords = [
    { name: "  Ada ", qty: 2 },
    { name: "", qty: 1 },
    { name: "Grace", qty: -3 },
    { name: "Lin", qty: "4" },
    { name: "Zero", qty: 0 },
  ];
  return challenge({
    id: `workbench-pipeline-${id}`,
    title: `Record pipeline validation ${id}`,
    kind: "multi-file-contract",
    difficulty: "hard",
    prompt: `The record pipeline admits bad quantities: processRecords_${id} in ${processPath} currently keeps records whose qty is negative or not a number. Given [{ name: "  Ada ", qty: 2 }, { name: "", qty: 1 }, { name: "Grace", qty: -3 }, { name: "Lin", qty: "4" }, { name: "Zero", qty: 0 }] it must return [{ name: "Ada", qty: 2 }, { name: "Zero", qty: 0 }]. Diagnose the pipeline and fix ${validatePath} so isValidRecord_${id} rejects records whose qty is not a non-negative finite number, keeping the existing name rules. Do not change the transform or process files.`,
    files: {
      [validatePath]: validateBase,
      [transformPath]: transformSource,
      [processPath]: processSource,
    },
    referenceFiles: {
      [validatePath]: validateReference,
      [transformPath]: transformSource,
      [processPath]: processSource,
    },
    negativeFiles: {
      [validatePath]: validateNegative,
      [transformPath]: transformSource,
      [processPath]: processSource,
    },
    alternateFiles: {
      [validatePath]: validateAlternate,
      [transformPath]: transformSource,
      [processPath]: processSource,
    },
    maxChangedLines: 10,
    requiredSnippets: {},
    requiredUnchangedSnippets: {
      [transformPath]: ["return { name: record.name.trim(), qty: record.qty };"],
      [processPath]: [`records.filter(isValidRecord_${id}).map(normalizeRecord_${id})`],
    },
    behavioralChecks: [
      {
        kind: "js-call",
        path: processPath,
        functionName: `processRecords_${id}`,
        args: [sampleRecords],
        expected: [
          { name: "Ada", qty: 2 },
          { name: "Zero", qty: 0 },
        ],
        label: `processRecords_${id} filters invalid quantities end to end`,
      },
      {
        kind: "js-call",
        path: validatePath,
        functionName: `isValidRecord_${id}`,
        args: [{ name: "Ada", qty: -1 }],
        expected: false,
        label: `isValidRecord_${id} rejects negative quantities`,
      },
      {
        kind: "js-call",
        path: validatePath,
        functionName: `isValidRecord_${id}`,
        args: [{ name: "Ada", qty: 3 }],
        expected: true,
        label: `isValidRecord_${id} keeps valid records`,
      },
      {
        kind: "js-call",
        path: transformPath,
        functionName: `normalizeRecord_${id}`,
        args: [{ name: " Pad ", qty: 5 }],
        expected: { name: "Pad", qty: 5 },
        label: `normalizeRecord_${id} behavior is unchanged`,
      },
    ],
  });
}

function challenge(input: {
  id: string;
  title: string;
  kind: WorkBenchChallengeKind;
  difficulty: WorkBenchChallenge["difficulty"];
  prompt: string;
  files: Record<string, string>;
  referenceFiles: Record<string, string>;
  negativeFiles: Record<string, string>;
  alternateFiles: Record<string, string>;
  maxChangedLines: number;
  requiredSnippets: Record<string, WorkBenchSnippet[]>;
  requiredUnchangedSnippets?: Record<string, string[]>;
  forbiddenSnippets?: Record<string, WorkBenchSnippet[]>;
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
    baseFiles: input.files,
    referenceFiles: input.referenceFiles,
    negativeControlFiles: input.negativeFiles,
    alternateSolutionFiles: input.alternateFiles,
    verifier: {
      maxChangedLines: input.maxChangedLines,
      requiredSnippets: input.requiredSnippets,
      requiredUnchangedSnippets: input.requiredUnchangedSnippets,
      forbiddenSnippets: input.forbiddenSnippets,
      syntaxChecks: input.syntaxChecks,
      behavioralChecks: input.behavioralChecks,
    },
  };
}

function largeNormalizerFile(marker: string, targetIndex: number, targetReturn: string): string {
  const lines = ["// WorkBench large normalizer fixture"];
  for (let index = 1; index <= 220; index++) {
    const tag = String(index).padStart(3, "0");
    lines.push(`export function normalizeBranch_${tag}(raw) {`);
    lines.push('  if (!raw) return "";');
    if (index === targetIndex) {
      lines.push(`  // ${marker}`);
      lines.push(`  ${targetReturn}`);
    } else {
      lines.push(`  return raw; // non-target sentinel ${tag}`);
    }
    lines.push("}");
  }
  return lines.join("\n");
}

function longToolbarFile(
  id: string,
  variant: {
    row: number;
    primaryTestId: string;
    secondaryTestId: string;
    label: string;
    icon: string;
  },
  patched: boolean
): string {
  const lines = ["import React from \"react\";", `export function Toolbar${id}() {`, "  return <div>"];
  for (let index = 1; index <= 160; index++) {
    lines.push(`    {/* Toolbar sentinel ${String(index).padStart(3, "0")} */}`);
    if (index === variant.row) {
      lines.push(
        patched
          ? `    <button type="button" aria-label="${variant.label}" data-testid="${variant.primaryTestId}"><${variant.icon} /></button>`
          : `    <button type="button" data-testid="${variant.primaryTestId}"><${variant.icon} /></button>`
      );
      lines.push(`    <button type="button" data-testid="${variant.secondaryTestId}"><${variant.icon} /></button>`);
    } else {
      lines.push(`    <span>Toolbar row ${index}</span>`);
    }
  }
  lines.push("  </div>;");
  lines.push("}");
  lines.push(`function ${variant.icon}() { return <svg aria-hidden="true" />; }`);
  return lines.join("\n");
}

function largeConfigJson(id: string, patched: boolean): string {
  const lines = ["{", "  \"features\": {", `    \"legacyCheckout_${id}\": false,`, `    \"betaCheckout_${id}\": ${patched ? "true" : "false"},`];
  for (let index = 1; index <= 300; index++) {
    lines.push(`    \"sentinel_${id}_${String(index).padStart(3, "0")}\": \"keep\"${index === 300 ? "" : ","}`);
  }
  lines.push("  }");
  lines.push("}");
  return lines.join("\n");
}

function noRewriteSource(id: string, normalizeReturn: string): string {
  const lines = [
    `export function clamp_${id}(value, min, max) {`,
    "  return Math.max(min, Math.min(max, value));",
    "}",
  ];
  for (let index = 1; index <= 400; index++) {
    lines.push(`export const NO_REWRITE_SENTINEL_${id}_${String(index).padStart(3, "0")} = true;`);
  }
  lines.push(`export function normalizePercent_${id}(value) {`);
  lines.push(`  ${normalizeReturn}`);
  lines.push("}");
  return lines.join("\n");
}

function syntaxAssertion(path: string, kind: "json" | "balanced-braces", content: string): WorkBenchAssertion {
  if (kind === "json") {
    try {
      JSON.parse(content);
      return { id: `${path}:json`, label: `${path} remains valid JSON`, passed: true, weight: 1 };
    } catch (error) {
      return {
        id: `${path}:json`,
        label: `${path} remains valid JSON`,
        passed: false,
        weight: 1,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  // Coarse heuristic only: counts braces anywhere and does not validate syntax.
  const passed = count(content, "{") === count(content, "}");
  return {
    id: `${path}:balanced-braces`,
    label: `${path} has balanced braces`,
    passed,
    weight: 0,
    message: passed ? undefined : "Brace counts do not match.",
  };
}

function snippetKey(snippet: WorkBenchSnippet): string {
  return typeof snippet === "string" ? snippet : snippet.anyOf.join("|");
}

function snippetIncluded(content: string, snippet: WorkBenchSnippet): boolean {
  if (typeof snippet === "string") return content.includes(snippet);
  return snippet.anyOf.some((variant) => content.includes(variant));
}

/**
 * Strips comments (language-aware, string-literal-aware) so snippet checks
 * cannot be satisfied or tripped by commented-out code. Newlines inside
 * comments are preserved so multi-line snippets keep their shape.
 */
function stripComments(path: string, content: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return content;
  if (lower.endsWith(".py")) return stripPythonComments(content);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) {
    return stripCLikeComments(content, ['"', "'", "`"], false);
  }
  if (lower.endsWith(".go")) return stripCLikeComments(content, ['"', "`"], true);
  if (/\.(rs|cs|cpp|cc|cxx|hpp|hh|c|h)$/.test(lower)) {
    return stripCLikeComments(content, ['"'], true);
  }
  return stripCLikeComments(content, ['"', "'", "`"], false);
}

function stripCLikeComments(content: string, stringDelims: string[], charLiteral: boolean): string {
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

function stripPythonComments(content: string): string {
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
      const triple = content.slice(i, i + 3) === ch.repeat(3);
      const delim = triple ? ch.repeat(3) : ch;
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

/**
 * Evaluates the candidate's JavaScript fixture files (`.mjs`/`.js`) in-memory
 * for test-harness behavioral checks. Import lines are dropped and all files
 * are concatenated (function declarations hoist), mirroring what the sandbox
 * verifier achieves with a real dynamic import. Only used with trusted test
 * fixtures; the runtime verifier executes candidates in a child process.
 */
function evaluateJsModules(files: Record<string, string>): {
  exports: Record<string, unknown> | null;
  error: string;
} {
  const sources = Object.entries(files)
    .filter(([path]) => /\.(mjs|js|cjs)$/i.test(path))
    .map(([, content]) => content);
  if (sources.length === 0) return { exports: null, error: "no JavaScript fixture files" };
  const names = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(
      /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm
    )) {
      names.add(match[1]);
    }
  }
  const rewritten = sources
    .map((source) => source.replace(/^\s*import[^\n]*\n/gm, "").replace(/^(\s*)export\s+/gm, "$1"))
    .join("\n;\n");
  try {
    const factory = new Function(
      `${rewritten}\nreturn { ${Array.from(names).join(", ")} };`
    ) as () => Record<string, unknown>;
    return { exports: factory(), error: "" };
  } catch (error) {
    return { exports: null, error: `fixture evaluation failed: ${errorMessage(error)}` };
  }
}

function getJsonPath(value: unknown, keyPath: string[]): unknown {
  let current: unknown = value;
  for (const key of keyPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value) ?? "null";
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function totalChangedLines(baseFiles: Record<string, string>, files: Record<string, string>): number {
  return Array.from(new Set([...Object.keys(baseFiles), ...Object.keys(files)])).reduce(
    (sum, path) => sum + changedLines(baseFiles[path] ?? "", files[path] ?? ""),
    0
  );
}

/**
 * Alignment-based diff size: added + removed lines relative to the longest
 * common subsequence. Unlike a positional comparison, inserting one line does
 * not count every shifted line below it as changed.
 */
function changedLines(left: string, right: string): number {
  if (left === right) return 0;
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const lcs = lcsLength(leftLines, rightLines);
  return leftLines.length - lcs + (rightLines.length - lcs);
}

function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const curr = new Array<number>(b.length + 1).fill(0);
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], curr[j]);
    }
    prev = curr;
  }
  return prev[b.length];
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function occurrenceCount(value: string, needle: string): number {
  if (needle.length === 0) return 0;
  return value.split(needle).length - 1;
}
