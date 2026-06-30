import type {
  PatchReliabilityCase,
  ToolCallReliabilityCase,
} from "./types";

export type LargeFileStressKind =
  | "large-file-search-replace"
  | "repeated-block-disambiguation"
  | "multi-hunk-patch"
  | "json-large-object-edit"
  | "react-large-component-edit"
  | "no-whole-file-rewrite";

export interface LargeFilePatchStressPolicy {
  kind: LargeFileStressKind;
  minOriginalLineCount: number;
  maxChangedLines: number;
  maxSearchLines?: number;
  requiredUnchangedSnippets: string[];
  requiredChangedSnippets: string[];
  forbiddenSnippets?: string[];
  disallowWholeFileRewrite: boolean;
}

export interface LargeFilePatchReliabilityCase extends PatchReliabilityCase {
  stress: LargeFilePatchStressPolicy;
}

export type ToolReliabilityStressCase =
  | LargeFilePatchReliabilityCase
  | ToolCallReliabilityCase;

const STRESS_PATCH_CASES: LargeFilePatchReliabilityCase[] = [
  ...Array.from({ length: 10 }, (_, index) => repeatedBlockCase(index + 1)),
  ...Array.from({ length: 10 }, (_, index) => multiHunkCase(index + 1)),
  ...Array.from({ length: 10 }, (_, index) => largeJsonCase(index + 1)),
  ...Array.from({ length: 10 }, (_, index) => longReactCase(index + 1)),
  ...Array.from({ length: 10 }, (_, index) => noWholeFileRewriteCase(index + 1)),
];

const TOOL_STRATEGY_CASES: ToolCallReliabilityCase[] = Array.from(
  { length: 20 },
  (_, index) => {
    const number = index + 1;
    const idNumber = String(number).padStart(3, "0");
    const path =
      number <= 10
        ? `src/large/invoice-${idNumber}.ts`
        : `src/config/catalog-${idNumber}.json`;
    const action = number <= 10 ? "search" : "read_range";
    return {
      id: `toolrel-current-tool-strategy-${idNumber}`,
      category: "tool-call",
      title:
        number <= 10
          ? `Search before patching large TypeScript file ${idNumber}`
          : `Read narrow range in large JSON config ${idNumber}`,
      prompt:
        number <= 10
          ? `The target function is inside a large file. Emit exactly one JSON tool action that searches ${path} for buildInvoiceSummary_${idNumber}. Do not read the entire file.`
          : `The config file is thousands of lines long. Emit exactly one JSON read_range action for the target section in ${path}; do not request the whole file.`,
      canary: `AIBENCH-TOOLREL-CURRENT-TOOL-${idNumber}`,
      metrics: ["tool", "firstAttempt", "forbiddenAction"],
      expectedAction:
        action === "search"
          ? {
              action: "search",
              path,
              query: `buildInvoiceSummary_${idNumber}`,
            }
          : {
              action: "read_range",
              path,
              startLine: 180 + number,
              lineCount: 60,
            },
    };
  }
);

export const TOOL_RELIABILITY_LARGE_FILE_STRESS_CASES: LargeFilePatchReliabilityCase[] =
  STRESS_PATCH_CASES;

export const TOOL_RELIABILITY_TOOL_STRATEGY_CASES: ToolCallReliabilityCase[] =
  TOOL_STRATEGY_CASES;

export const TOOL_RELIABILITY_STRESS_CASES: ToolReliabilityStressCase[] = [
  ...STRESS_PATCH_CASES,
  ...TOOL_STRATEGY_CASES,
];

function repeatedBlockCase(number: number): LargeFilePatchReliabilityCase {
  const idNumber = String(number).padStart(3, "0");
  const path = `src/large/repeated-block-${idNumber}.ts`;
  const marker = `TARGET_NORMALIZER_${idNumber}`;
  const before = largeRepeatedBlockFile({ marker, replacement: "return value;" });
  const after = largeRepeatedBlockFile({
    marker,
    replacement: "return value.trim().toLowerCase();",
  });
  return patchCase({
    id: `toolrel-current-large-repeated-${idNumber}`,
    kind: "repeated-block-disambiguation",
    title: `Repeated block disambiguation ${idNumber}`,
    prompt: `Patch only the branch marked ${marker} in ${path}. There are many similar if (!value) blocks; do not edit the wrong block or rewrite the file.`,
    path,
    before,
    after,
    canary: `AIBENCH-TOOLREL-CURRENT-REPEATED-${idNumber}`,
    maxChangedLines: 6,
    maxSearchLines: 12,
    requiredChangedSnippets: ["return value.trim().toLowerCase();"],
    requiredUnchangedSnippets: [
      "export function unrelatedNormalizer_001(value: string): string {",
      "return value; // keep unrelated normalizers unchanged",
      `// ${marker}`,
    ],
  });
}

function multiHunkCase(number: number): LargeFilePatchReliabilityCase {
  const idNumber = String(number).padStart(3, "0");
  const path = `src/large/multi-hunk-${idNumber}.ts`;
  const before = largeMultiHunkFile(idNumber, false);
  const after = largeMultiHunkFile(idNumber, true);
  return patchCase({
    id: `toolrel-current-large-multihunk-${idNumber}`,
    kind: "multi-hunk-patch",
    title: `Three-hunk large file patch ${idNumber}`,
    prompt: `Patch ${path} using minimal SEARCH/REPLACE hunks: update the import alias, helper return value, and call site. The file is intentionally long; do not rewrite unrelated sections.`,
    path,
    before,
    after,
    canary: `AIBENCH-TOOLREL-CURRENT-MULTIHUNK-${idNumber}`,
    maxChangedLines: 12,
    maxSearchLines: 20,
    requiredChangedSnippets: [
      `import { formatCurrency as formatMoney_${idNumber} } from "./money";`,
      `return formatMoney_${idNumber}(amountCents / 100);`,
      `formatPrice_${idNumber}(line.totalCents)`,
    ],
    requiredUnchangedSnippets: [
      `export function stableHelper_${idNumber}_001(input: string): string {`,
      "return input; // sentinel helper must remain unchanged",
    ],
  });
}

function largeJsonCase(number: number): LargeFilePatchReliabilityCase {
  const idNumber = String(number).padStart(3, "0");
  const path = `config/catalog-${idNumber}.json`;
  const before = largeJsonConfig(idNumber, false);
  const after = largeJsonConfig(idNumber, true);
  return patchCase({
    id: `toolrel-current-large-json-${idNumber}`,
    kind: "json-large-object-edit",
    title: `Large JSON nested feature flag ${idNumber}`,
    prompt: `Patch only the nested betaCheckout flag in ${path}. The JSON must remain valid and unrelated feature flags must not change.`,
    path,
    before,
    after,
    canary: `AIBENCH-TOOLREL-CURRENT-JSON-${idNumber}`,
    maxChangedLines: 8,
    maxSearchLines: 16,
    requiredChangedSnippets: [`"betaCheckout_${idNumber}": true`],
    requiredUnchangedSnippets: [
      `"legacyCheckout_${idNumber}": false`,
      `"sentinel_${idNumber}_199": "keep"`,
    ],
  });
}

function longReactCase(number: number): LargeFilePatchReliabilityCase {
  const idNumber = String(number).padStart(3, "0");
  const path = `src/components/LargeToolbar${idNumber}.tsx`;
  const before = largeReactToolbar(idNumber, false);
  const after = largeReactToolbar(idNumber, true);
  return patchCase({
    id: `toolrel-current-large-react-${idNumber}`,
    kind: "react-large-component-edit",
    title: `Long React component aria patch ${idNumber}`,
    prompt: `Patch the icon-only save button in ${path} so screen readers announce Save changes ${idNumber}. Do not add visible text and do not edit the other icon buttons.`,
    path,
    before,
    after,
    canary: `AIBENCH-TOOLREL-CURRENT-REACT-${idNumber}`,
    maxChangedLines: 6,
    maxSearchLines: 14,
    requiredChangedSnippets: [`aria-label="Save changes ${idNumber}"`],
    requiredUnchangedSnippets: [
      `aria-label="Discard draft ${idNumber}"`,
      `data-testid="secondary-save-${idNumber}"`,
      "{/* sentinel-toolbar-section-120 */}",
    ],
  });
}

function noWholeFileRewriteCase(number: number): LargeFilePatchReliabilityCase {
  const idNumber = String(number).padStart(3, "0");
  const path = `src/large/no-rewrite-${idNumber}.ts`;
  const before = noRewriteFile(idNumber, false);
  const after = noRewriteFile(idNumber, true);
  return patchCase({
    id: `toolrel-current-large-no-rewrite-${idNumber}`,
    kind: "no-whole-file-rewrite",
    title: `Minimal patch required ${idNumber}`,
    prompt: `Patch ${path} with a minimal edit. A whole-file rewrite or giant search block should fail even if the final text is equivalent.`,
    path,
    before,
    after,
    canary: `AIBENCH-TOOLREL-CURRENT-NOREWRITE-${idNumber}`,
    maxChangedLines: 4,
    maxSearchLines: 8,
    requiredChangedSnippets: [`return clamp_${idNumber}(value, 0, 100);`],
    requiredUnchangedSnippets: [
      `export const NO_REWRITE_SENTINEL_${idNumber}_250 = true;`,
      `export function clamp_${idNumber}(value: number, min: number, max: number): number {`,
    ],
  });
}

function patchCase(input: {
  id: string;
  kind: LargeFileStressKind;
  title: string;
  prompt: string;
  path: string;
  before: string;
  after: string;
  canary: string;
  maxChangedLines: number;
  maxSearchLines: number;
  requiredChangedSnippets: string[];
  requiredUnchangedSnippets: string[];
}): LargeFilePatchReliabilityCase {
  return {
    id: input.id,
    category: "patch",
    title: input.title,
    prompt: `${input.prompt}\nUse SEARCH/REPLACE edit blocks only. Keep the patch surgical.`,
    canary: input.canary,
    metrics: ["patch", "firstAttempt", "forbiddenAction"],
    path: input.path,
    originalContent: input.before,
    expectedContent: input.after,
    stress: {
      kind: input.kind,
      minOriginalLineCount: 500,
      maxChangedLines: input.maxChangedLines,
      maxSearchLines: input.maxSearchLines,
      requiredUnchangedSnippets: input.requiredUnchangedSnippets,
      requiredChangedSnippets: input.requiredChangedSnippets,
      disallowWholeFileRewrite: true,
    },
  };
}

function largeRepeatedBlockFile(input: { marker: string; replacement: string }): string {
  const lines = [
    "// Large repeated-block normalizer fixture.",
    "export const fixtureKind = \"repeated-block\";",
  ];
  for (let index = 1; index <= 220; index++) {
    const name = `unrelatedNormalizer_${String(index).padStart(3, "0")}`;
    lines.push(`export function ${name}(value: string): string {`);
    lines.push("  if (!value) {");
    lines.push("    return \"\";");
    lines.push("  }");
    if (index === 117) {
      lines.push(`  // ${input.marker}`);
      lines.push(`  ${input.replacement}`);
    } else {
      lines.push("  return value; // keep unrelated normalizers unchanged");
    }
    lines.push("}");
  }
  return lines.join("\n");
}

function largeMultiHunkFile(id: string, patched: boolean): string {
  const lines = [
    patched
      ? `import { formatCurrency as formatMoney_${id} } from "./money";`
      : `import { formatCurrency } from "./money";`,
    "",
  ];
  for (let index = 1; index <= 180; index++) {
    lines.push(`export function stableHelper_${id}_${String(index).padStart(3, "0")}(input: string): string {`);
    lines.push("  return input; // sentinel helper must remain unchanged");
    lines.push("}");
  }
  lines.push(`export function formatPrice_${id}(amountCents: number): string {`);
  lines.push(
    patched
      ? `  return formatMoney_${id}(amountCents / 100);`
      : "  return formatCurrency(amountCents);"
  );
  lines.push("}");
  lines.push(`export function renderInvoice_${id}(line: { totalCents: number }): string {`);
  lines.push(
    patched
      ? `  return \`Total: \${formatPrice_${id}(line.totalCents)}\`;`
      : "  return `Total: ${formatCurrency(line.totalCents)}`;"
  );
  lines.push("}");
  return lines.join("\n");
}

function largeJsonConfig(id: string, patched: boolean): string {
  const entries: string[] = [];
  for (let index = 1; index <= 520; index++) {
    entries.push(`    "sentinel_${id}_${String(index).padStart(3, "0")}": "keep"`);
  }
  return [
    "{",
    "  \"features\": {",
    `    \"legacyCheckout_${id}\": false,`,
    `    \"betaCheckout_${id}\": ${patched ? "true" : "false"},`,
    ...entries.map((line, index) => `${line}${index === entries.length - 1 ? "" : ","}`),
    "  }",
    "}",
  ].join("\n");
}

function largeReactToolbar(id: string, patched: boolean): string {
  const lines = [
    "import React from \"react\";",
    "",
    `export function LargeToolbar${id}() {`,
    "  return (",
    "    <div>",
  ];
  for (let index = 1; index <= 260; index++) {
    lines.push(`      {/* sentinel-toolbar-section-${String(index).padStart(3, "0")} */}`);
    if (index === 73) {
      lines.push(
        patched
          ? `      <button type="button" aria-label="Save changes ${id}" data-testid="primary-save-${id}"><SaveIcon /></button>`
          : `      <button type="button" data-testid="primary-save-${id}"><SaveIcon /></button>`
      );
      lines.push(`      <button type="button" aria-label="Discard draft ${id}" data-testid="discard-${id}"><TrashIcon /></button>`);
      lines.push(`      <button type="button" data-testid="secondary-save-${id}"><SaveIcon /></button>`);
    } else {
      lines.push(`      <span data-row="${index}">Toolbar row ${index}</span>`);
    }
  }
  lines.push("    </div>");
  lines.push("  );");
  lines.push("}");
  lines.push("function SaveIcon() { return <svg aria-hidden=\"true\" />; }");
  lines.push("function TrashIcon() { return <svg aria-hidden=\"true\" />; }");
  return lines.join("\n");
}

function noRewriteFile(id: string, patched: boolean): string {
  const lines = [
    `export function clamp_${id}(value: number, min: number, max: number): number {`,
    "  return Math.max(min, Math.min(max, value));",
    "}",
    "",
  ];
  for (let index = 1; index <= 500; index++) {
    lines.push(`export const NO_REWRITE_SENTINEL_${id}_${String(index).padStart(3, "0")} = true;`);
  }
  lines.push(`export function normalizePercent_${id}(value: number): number {`);
  lines.push(
    patched
      ? `  return clamp_${id}(value, 0, 100);`
      : "  return value;"
  );
  lines.push("}");
  return lines.join("\n");
}
