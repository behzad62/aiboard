export type WorkBenchChallengeKind =
  | "large-file-surgical-patch"
  | "multi-file-contract"
  | "parser-edge-case"
  | "react-accessibility"
  | "large-json-config"
  | "no-whole-file-rewrite";

export interface WorkBenchAssertion {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  message?: string;
}

export interface WorkBenchChallenge {
  id: string;
  title: string;
  kind: WorkBenchChallengeKind;
  difficulty: "medium" | "hard" | "expert";
  prompt: string;
  tags: string[];
  baseFiles: Record<string, string>;
  referenceFiles: Record<string, string>;
  negativeControlFiles: Record<string, string>;
  verifier: {
    maxChangedLines?: number;
    requiredSnippets: Record<string, string[]>;
    forbiddenSnippets?: Record<string, string[]>;
    requiredUnchangedSnippets?: Record<string, string[]>;
    syntaxChecks?: Array<{ path: string; kind: "json" | "balanced-braces" }>;
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

export const WORKBENCH_CHALLENGES: WorkBenchChallenge[] = [
  ...Array.from({ length: 4 }, (_, index) => largeFileSurgicalPatch(index + 1)),
  ...Array.from({ length: 2 }, (_, index) => multiFileContract(index + 1)),
  ...Array.from({ length: 2 }, (_, index) => parserEdgeCase(index + 1)),
  ...Array.from({ length: 2 }, (_, index) => reactAccessibilityCase(index + 1)),
  largeJsonConfigCase(1),
  noWholeFileRewriteCase(1),
];

export function runWorkBenchChallengeVerifier(input: {
  challenge: WorkBenchChallenge;
  files: Record<string, string>;
}): WorkBenchChallengeResult {
  const assertions: WorkBenchAssertion[] = [];
  const changedLines = totalChangedLines(input.challenge.baseFiles, input.files);

  for (const [path, snippets] of Object.entries(input.challenge.verifier.requiredSnippets)) {
    const actual = input.files[path] ?? "";
    for (const snippet of snippets) {
      assertions.push({
        id: `${path}:required:${stableId(snippet)}`,
        label: `${path} contains required verified behavior`,
        passed: actual.includes(snippet),
        weight: 1,
        message: actual.includes(snippet)
          ? undefined
          : `${path} is missing required snippet ${JSON.stringify(snippet)}.`,
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
    const actual = input.files[path] ?? "";
    for (const snippet of snippets) {
      assertions.push({
        id: `${path}:forbidden:${stableId(snippet)}`,
        label: `${path} avoids known bad solution`,
        passed: !actual.includes(snippet),
        weight: 1,
        message: !actual.includes(snippet)
          ? undefined
          : `${path} contains forbidden snippet ${JSON.stringify(snippet)}.`,
      });
    }
  }

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
  const path = `src/large/normalizer-${id}.ts`;
  const marker = `WORKBENCH_TARGET_BRANCH_${id}`;
  const base = largeNormalizerFile(marker, "return raw; // target branch");
  const reference = largeNormalizerFile(marker, "return raw.trim().toLowerCase(); // target branch");
  const negative = largeNormalizerFile(marker, "return raw.toLowerCase(); // target branch");
  return challenge({
    id: `workbench-large-normalizer-${id}`,
    title: `Large-file string normalizer ${id}`,
    kind: "large-file-surgical-patch",
    difficulty: "hard",
    prompt: `In ${path}, patch only the branch marked ${marker} so it trims and lowercases the value. Do not touch the similar branches.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 3,
    requiredSnippets: { [path]: ["return raw.trim().toLowerCase(); // target branch"] },
    requiredUnchangedSnippets: {
      [path]: [
        "return raw; // non-target sentinel 001",
        "return raw; // non-target sentinel 060",
        "return raw; // non-target sentinel 116",
        "return raw; // non-target sentinel 118",
        "return raw; // non-target sentinel 220",
        `// ${marker}`,
      ],
    },
    forbiddenSnippets: { [path]: ["return raw.toLowerCase(); // target branch"] },
  });
}

function multiFileContract(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const typesPath = `src/contracts/invoice-${id}.ts`;
  const servicePath = `src/services/invoice-${id}.ts`;
  const baseFiles = {
    [typesPath]: `export interface Invoice_${id} {\n  id: string;\n  totalCents: number;\n}\n`,
    [servicePath]: `import type { Invoice_${id} } from "../contracts/invoice-${id}";\nexport function summarize_${id}(invoice: Invoice_${id}) {\n  return { id: invoice.id, total: invoice.totalCents };\n}\n`,
  };
  const referenceFiles = {
    [typesPath]: `export interface Invoice_${id} {\n  id: string;\n  totalCents: number;\n  currency: "USD" | "EUR";\n}\n`,
    [servicePath]: `import type { Invoice_${id} } from "../contracts/invoice-${id}";\nexport function summarize_${id}(invoice: Invoice_${id}) {\n  return { id: invoice.id, total: invoice.totalCents, currency: invoice.currency };\n}\n`,
  };
  const negativeFiles = {
    [typesPath]: referenceFiles[typesPath],
    [servicePath]: baseFiles[servicePath],
  };
  return challenge({
    id: `workbench-contract-${id}`,
    title: `Multi-file invoice contract ${id}`,
    kind: "multi-file-contract",
    difficulty: "medium",
    prompt: `Update the invoice contract and summary service so currency is carried through both files.`,
    files: baseFiles,
    referenceFiles,
    negativeFiles,
    maxChangedLines: 8,
    requiredSnippets: {
      [typesPath]: [`currency: "USD" | "EUR";`],
      [servicePath]: ["currency: invoice.currency"],
    },
  });
}

function parserEdgeCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/parser/flags-${id}.py`;
  const base = `def parse_flag_${id}(raw):\n    if raw == \"true\":\n        return True\n    if raw == \"false\":\n        return False\n    return None\n`;
  const reference = `def parse_flag_${id}(raw):\n    value = str(raw).strip().lower()\n    if value in (\"true\", \"1\", \"yes\"):\n        return True\n    if value in (\"false\", \"0\", \"no\"):\n        return False\n    return None\n`;
  const negative = `def parse_flag_${id}(raw):\n    if raw:\n        return True\n    return False\n`;
  return challenge({
    id: `workbench-parser-${id}`,
    title: `Boolean parser edge cases ${id}`,
    kind: "parser-edge-case",
    difficulty: "medium",
    prompt: `Make parse_flag_${id} handle whitespace, case, numeric strings, and yes/no without treating arbitrary strings as true.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 10,
    requiredSnippets: { [path]: ["strip().lower()", "value in (\"true\", \"1\", \"yes\")"] },
    forbiddenSnippets: { [path]: ["if raw:\n        return True"] },
  });
}

function reactAccessibilityCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/components/Toolbar${id}.tsx`;
  const base = longToolbarFile(id, false);
  const reference = longToolbarFile(id, true);
  const negative = base.replace(`data-testid="primary-save-${id}"`, `title="Save changes ${id}" data-testid="primary-save-${id}"`);
  return challenge({
    id: `workbench-react-a11y-${id}`,
    title: `Long React toolbar accessibility ${id}`,
    kind: "react-accessibility",
    difficulty: "hard",
    prompt: `Add a screen-reader accessible name to the primary save icon button only. Do not add visible text or edit secondary save buttons.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 4,
    requiredSnippets: { [path]: [`aria-label="Save changes ${id}"`] },
    requiredUnchangedSnippets: { [path]: [`data-testid="secondary-save-${id}"`, "Toolbar sentinel 120"] },
    forbiddenSnippets: { [path]: [`title="Save changes ${id}"`] },
  });
}

function largeJsonConfigCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `config/feature-flags-${id}.json`;
  const base = largeConfigJson(id, false);
  const reference = largeConfigJson(id, true);
  const negative = largeConfigJson(id, false).replace(`"legacyCheckout_${id}": false`, `"legacyCheckout_${id}": true`);
  return challenge({
    id: `workbench-json-config-${id}`,
    title: `Large JSON feature flag ${id}`,
    kind: "large-json-config",
    difficulty: "hard",
    prompt: `Enable only betaCheckout_${id}; keep legacyCheckout_${id} and all sentinel config keys unchanged.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 3,
    requiredSnippets: { [path]: [`"betaCheckout_${id}": true`] },
    requiredUnchangedSnippets: { [path]: [`"legacyCheckout_${id}": false`, `"sentinel_${id}_250": "keep"`] },
    syntaxChecks: [{ path, kind: "json" }],
  });
}

function noWholeFileRewriteCase(number: number): WorkBenchChallenge {
  const id = String(number).padStart(4, "0");
  const path = `src/math/noRewrite${id}.ts`;
  const base = noRewriteSource(id, false);
  const reference = noRewriteSource(id, true);
  const negative = reference.replace(`NO_REWRITE_SENTINEL_${id}_200`, `BROKEN_SENTINEL_${id}_200`);
  return challenge({
    id: `workbench-no-rewrite-${id}`,
    title: `No whole-file rewrite math helper ${id}`,
    kind: "no-whole-file-rewrite",
    difficulty: "expert",
    prompt: `Patch normalizePercent_${id} only. Preserve all sentinels and keep the diff tiny.`,
    files: { [path]: base },
    referenceFiles: { [path]: reference },
    negativeFiles: { [path]: negative },
    maxChangedLines: 3,
    requiredSnippets: { [path]: [`return clamp_${id}(value, 0, 100);`] },
    requiredUnchangedSnippets: { [path]: [`NO_REWRITE_SENTINEL_${id}_200`, `NO_REWRITE_SENTINEL_${id}_380`] },
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
  maxChangedLines: number;
  requiredSnippets: Record<string, string[]>;
  requiredUnchangedSnippets?: Record<string, string[]>;
  forbiddenSnippets?: Record<string, string[]>;
  syntaxChecks?: WorkBenchChallenge["verifier"]["syntaxChecks"];
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
    verifier: {
      maxChangedLines: input.maxChangedLines,
      requiredSnippets: input.requiredSnippets,
      requiredUnchangedSnippets: input.requiredUnchangedSnippets,
      forbiddenSnippets: input.forbiddenSnippets,
      syntaxChecks: input.syntaxChecks,
    },
  };
}

function largeNormalizerFile(marker: string, targetReturn: string): string {
  const lines = ["# WorkBench large normalizer fixture"];
  for (let index = 1; index <= 220; index++) {
    const tag = String(index).padStart(3, "0");
    lines.push(`export function normalizeBranch_${tag}(raw: string): string {`);
    lines.push("  if (!raw) return \"\";");
    if (index === 117) {
      lines.push(`  // ${marker}`);
      lines.push(`  ${targetReturn}`);
    } else {
      lines.push(`  return raw; // non-target sentinel ${tag}`);
    }
    lines.push("}");
  }
  return lines.join("\n");
}

function longToolbarFile(id: string, patched: boolean): string {
  const lines = ["import React from \"react\";", `export function Toolbar${id}() {`, "  return <div>"];
  for (let index = 1; index <= 160; index++) {
    lines.push(`    {/* Toolbar sentinel ${String(index).padStart(3, "0")} */}`);
    if (index === 88) {
      lines.push(
        patched
          ? `    <button type="button" aria-label="Save changes ${id}" data-testid="primary-save-${id}"><SaveIcon /></button>`
          : `    <button type="button" data-testid="primary-save-${id}"><SaveIcon /></button>`
      );
      lines.push(`    <button type="button" data-testid="secondary-save-${id}"><SaveIcon /></button>`);
    } else {
      lines.push(`    <span>Toolbar row ${index}</span>`);
    }
  }
  lines.push("  </div>;");
  lines.push("}");
  lines.push("function SaveIcon() { return <svg aria-hidden=\"true\" />; }");
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

function noRewriteSource(id: string, patched: boolean): string {
  const lines = [`export function clamp_${id}(value: number, min: number, max: number): number {`, "  return Math.max(min, Math.min(max, value));", "}"];
  for (let index = 1; index <= 400; index++) {
    lines.push(`export const NO_REWRITE_SENTINEL_${id}_${String(index).padStart(3, "0")} = true;`);
  }
  lines.push(`export function normalizePercent_${id}(value: number): number {`);
  lines.push(patched ? `  return clamp_${id}(value, 0, 100);` : "  return value;");
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

function totalChangedLines(baseFiles: Record<string, string>, files: Record<string, string>): number {
  return Array.from(new Set([...Object.keys(baseFiles), ...Object.keys(files)])).reduce(
    (sum, path) => sum + changedLines(baseFiles[path] ?? "", files[path] ?? ""),
    0
  );
}

function changedLines(left: string, right: string): number {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const max = Math.max(leftLines.length, rightLines.length);
  let changed = 0;
  for (let index = 0; index < max; index++) {
    if ((leftLines[index] ?? "") !== (rightLines[index] ?? "")) changed += 1;
  }
  return changed;
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
